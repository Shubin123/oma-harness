"""
OMA -- Open Multi Agent harness.

Wires together:
  - Core loop (invariant retry with time/token awareness)
  - Provider registry (Claude, Gemini, ChatGPT, DeepSeek, GLM, Kimi)
  - Criteria engine (define what "done" means)
  - Sanitizer (strip provider fingerprints)
  - Automation layers (pixel, page, memory)
  - Edge handlers (near-outage summarize, outage recovery)

Usage:
    from oma import OMA

    agent = OMA.from_env()
    result = agent.run("build a web scraper for HN front page")
    print(result.artifacts.get("final"))
"""

from oma.automation.memory import ContextOptimizer, PersistentMemory, WorkingMemory
from oma.core.criteria import ensure_criteria
from oma.core.edge import near_outage_handler
from oma.core.loop import CoreLoop, LoopConfig, TaskState
from oma.core.sanitize import Sanitizer
from oma.providers.registry import ProviderRegistry


class OMA:
    """
    Top-level agent orchestrator.
    """

    def __init__(
        self,
        registry: ProviderRegistry,
        config: LoopConfig = None,
        sanitizer: Sanitizer = None,
        memory_dir: str = ".oma_memory",
    ):
        self.registry = registry
        self.config = config or LoopConfig(
            provider_chain=registry.fallback_chain(),
        )
        self.sanitizer = sanitizer or Sanitizer()
        self.working = WorkingMemory()
        self.persistent = PersistentMemory(base_dir=memory_dir)
        self.optimizer = ContextOptimizer(token_budget=self.config.token_budget)

    @classmethod
    def from_env(cls, **kwargs) -> "OMA":
        """Create OMA from environment variables."""
        registry = ProviderRegistry.from_env()
        return cls(registry=registry, **kwargs)

    @classmethod
    def from_credentials(cls, auth_manager, **kwargs) -> "OMA":
        """
        Create OMA from stored credentials (subscription or API key).

        This is used by the graphical UI -- providers are registered from
        browser-based login sessions rather than env vars.
        """
        registry = ProviderRegistry.from_credentials(auth_manager)
        if not registry.available() and not registry._providers:
            # fallback to env vars if no credentials stored
            registry = ProviderRegistry.from_env()
        return cls(registry=registry, **kwargs)

    def run(
        self,
        objective: str,
        criteria: dict = None,
        system: str = "",
        resume_from: str = None,
    ) -> TaskState:
        """
        Run the full agent loop.

        Args:
            objective: what to accomplish
            criteria: optional pre-defined success criteria
            system: system prompt override
            resume_from: task_id to resume from (loads persistent memory)
        """
        # load previous state if resuming
        prev_context = None
        if resume_from:
            prev = self.persistent.load(resume_from)
            prev_context = prev
            if prev.get("handoffs"):
                last = prev["handoffs"][-1]
                self.working.put(
                    "handoff_context",
                    last["summary"],
                    tags=["handoff", "context"],
                )

        def solve_fn(state: TaskState, provider_name: str):
            provider = self.registry.get(provider_name)
            if not provider:
                raise RuntimeError(f"provider {provider_name} not registered")

            # build optimized context
            sys_prompt, messages = self.optimizer.build_context(
                system=system or "You are an agent completing a task. Be direct and efficient.",
                task_state=state.snapshot(),
                working=self.working,
                persistent=prev_context,
                history=[],
            )

            # add the task as user message
            messages.append({
                "role": "user",
                "content": f"Complete this task: {state.objective}\n\n"
                           f"Criteria: {state.criteria}\n\n"
                           f"Attempt {state.attempts}. "
                           f"Previous confidence: {state.confidence:.2f}",
            })

            response = provider.complete(
                messages=messages,
                system=sys_prompt,
                temperature=0.3,
            )

            if not response.ok:
                ec = response.error_class
                self.registry.record_failure(provider_name, response.error, ec)
                raise RuntimeError(f"{provider_name}: {response.error}")

            self.registry.record_success(
                provider_name, response.tokens_total, response.latency_ms
            )

            # store in working memory
            self.working.put(
                f"attempt_{state.attempts}",
                response.text[:500],
                tags=["attempt", "result"],
                source=provider_name,
            )

            # estimate confidence from response
            confidence = self._estimate_confidence(response.text, state.criteria)

            return response.text, response.tokens_total, confidence

        def handoff_fn(state: TaskState):
            note = near_outage_handler(
                task_state=state,
                working_memory=self.working,
                remaining_features=list(state.criteria.keys()),
            )
            self.persistent.append_handoff(
                task_id=state.task_id,
                handoff_summary=note.to_prompt(),
            )
            self.persistent.merge_working(state.task_id, self.working)

        loop = CoreLoop(
            config=self.config,
            solve_fn=solve_fn,
            sanitize_fn=self.sanitizer,
            handoff_fn=handoff_fn,
        )

        # always ensure criteria are present -- defaults apply if none given
        validated_criteria = ensure_criteria(criteria)

        return loop.run(objective=objective, initial_criteria=validated_criteria)

    def _estimate_confidence(self, output: str, criteria: dict) -> float:
        """
        Heuristic confidence estimation.
        For real use, this should call a judge model or run criteria evaluation.
        """
        if not output:
            return 0.0

        score = 0.3  # baseline for non-empty output

        # length heuristic: very short answers are usually incomplete
        if len(output) > 200:
            score += 0.1
        if len(output) > 1000:
            score += 0.1

        # check if output addresses criteria keywords
        if criteria:
            output_lower = output.lower()
            matched = sum(
                1 for key in criteria
                if key.lower() in output_lower
            )
            if criteria:
                score += 0.3 * (matched / len(criteria))

        # cap at 0.95 (never auto-confirm at 1.0 without eval)
        return min(score, 0.95)

    def status(self) -> dict:
        """Current state of the agent."""
        return {
            "providers": self.registry.status_report(),
            "working_memory_entries": len(self.working._store),
            "config": {
                "token_budget": self.config.token_budget,
                "wall_limit_s": self.config.wall_limit_s,
                "confidence_threshold": self.config.confidence_threshold,
                "provider_chain": self.config.provider_chain,
            },
        }
