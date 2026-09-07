"""
OMA -- Open Multi Agent harness.

Wires together:
  - RALPH loop (Reason, Act, Learn, Plan, Handoff)
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
from oma.core.loop import (
    RalphLoop,
    LoopConfig,
    TaskState,
    Strategy,
    Reasoning,
    Lesson,
    PlanDecision,
    PhaseEvent,
)
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
        # ralph phase tracking for GUI
        self._current_phase = "idle"
        self._phase_events = []

    @classmethod
    def from_env(cls, **kwargs) -> "OMA":
        """Create OMA from environment variables."""
        registry = ProviderRegistry.from_env()
        return cls(registry=registry, **kwargs)

    @classmethod
    def load(cls, **kwargs) -> "OMA":
        """
        Create OMA using all available configuration sources:
        1. Stored encrypted credentials (~/.oma/credentials.json)
        2. Environment variables (OMA_*_KEY and standard provider keys)
        """
        from oma.providers.auth import AuthManager

        auth = AuthManager()
        registry = ProviderRegistry.from_credentials(auth, include_env=True)
        if not registry._providers:
            registry = ProviderRegistry.from_env(include_standard_env=True)
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
            registry = ProviderRegistry.from_env()
        return cls(registry=registry, **kwargs)

    def run(
        self,
        objective: str,
        criteria: dict = None,
        system: str = "",
        resume_from: str = None,
        on_phase: callable = None,
    ) -> TaskState:
        """
        Run the full RALPH agent loop.

        Args:
            objective: what to accomplish
            criteria: optional pre-defined success criteria
            system: system prompt override
            resume_from: task_id to resume from (loads persistent memory)
            on_phase: optional callback for phase transitions (GUI use)
        """
        self._current_phase = "idle"
        self._phase_events = []

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

            # add the task as user message, enriched with strategy context
            strategy_ctx = ""
            if state.strategy:
                notes = state.strategy.get("approach_notes", [])
                if notes:
                    strategy_ctx = f"\n\nLessons from previous attempts:\n" + "\n".join(
                        f"- {n}" for n in notes[-3:]
                    )

            messages.append({
                "role": "user",
                "content": f"Complete this task: {state.objective}\n\n"
                           f"Criteria: {state.criteria}\n\n"
                           f"Attempt {state.attempts}. "
                           f"Previous confidence: {state.confidence:.2f}"
                           f"{strategy_ctx}",
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

            confidence = self._estimate_confidence(response.text, state.criteria)

            return response.text, response.tokens_total, confidence

        def reason_fn(state: TaskState, strategy: Strategy) -> Reasoning:
            """
            Analyze state and determine approach for this iteration.
            Uses working memory and provider health to inform reasoning.
            """
            reasoning = Reasoning()

            # gather provider health info
            health = self.registry.status_report()
            healthy_providers = [
                name for name, h in health.items()
                if not h.get("in_cooldown", False)
            ]

            if state.attempts == 1:
                reasoning.analysis = f"First attempt: {state.objective}"
                reasoning.approach = "direct"
                # prefer provider with best success rate
                best = self.registry.best_available()
                if best:
                    reasoning.provider_preference = best
            elif strategy.consecutive_failures > 2:
                reasoning.analysis = (
                    f"Consecutive failures: {strategy.consecutive_failures}. "
                    f"Switching strategy."
                )
                reasoning.approach = "alternative"
                # try least-used provider
                if healthy_providers:
                    reasoning.provider_preference = healthy_providers[-1]
            elif strategy.best_confidence > 0.5:
                reasoning.analysis = (
                    f"Making progress (best: {strategy.best_confidence:.2f}). "
                    f"Refining approach."
                )
                reasoning.approach = "refinement"
            else:
                reasoning.analysis = (
                    f"Attempt {state.attempts}, exploring."
                )
                reasoning.approach = "iterative"

            if state.criteria:
                reasoning.focus_areas = list(state.criteria.keys())[:5]

            return reasoning

        def plan_fn(
            state: TaskState, strategy: Strategy, lesson: Lesson
        ) -> PlanDecision:
            """
            Decide next action based on accumulated lessons.
            Uses provider registry health to inform provider ordering.
            """
            decision = PlanDecision()

            # check: threshold met?
            if strategy.best_confidence >= state.confidence_threshold:
                decision.action = "done"
                decision.reason = (
                    f"Confidence {strategy.best_confidence:.2f} >= "
                    f"threshold {state.confidence_threshold}"
                )
                return decision

            # track failures
            if lesson.succeeded:
                strategy.consecutive_failures = 0
            else:
                strategy.consecutive_failures += 1

            # too many failures
            if strategy.consecutive_failures >= 3:
                decision.action = "park"
                decision.reason = "consecutive_failures"
                return decision

            # budget check
            remaining_pct = state.remaining_tokens() / max(state.tokens_budget, 1)
            if remaining_pct < 0.15:
                decision.action = "park"
                decision.reason = "low_budget"
                return decision

            # adaptive reordering using registry health
            new_chain = self.registry.fallback_chain()
            if new_chain and new_chain != strategy.provider_order:
                decision.reorder_providers = new_chain

            # approach notes
            if lesson.what_worked:
                strategy.approach_notes.append(lesson.what_worked)
            elif lesson.what_failed:
                strategy.approach_notes.append(lesson.what_failed)

            decision.action = "continue"
            decision.reason = "iterating"
            return decision

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

        def phase_handler(event: PhaseEvent):
            self._current_phase = event.phase.value
            self._phase_events.append({
                "phase": event.phase.value,
                "iteration": event.iteration,
                "timestamp": event.timestamp,
                "data": event.data,
            })
            if on_phase:
                try:
                    on_phase(event)
                except Exception:
                    pass

        loop = RalphLoop(
            config=self.config,
            solve_fn=solve_fn,
            sanitize_fn=self.sanitizer,
            handoff_fn=handoff_fn,
            reason_fn=reason_fn,
            plan_fn=plan_fn,
            on_phase=phase_handler,
        )

        validated_criteria = ensure_criteria(criteria)

        return loop.run(objective=objective, initial_criteria=validated_criteria)

    def _estimate_confidence(self, output: str, criteria: dict) -> float:
        """
        Heuristic confidence estimation.
        For real use, this should call a judge model or run criteria evaluation.
        """
        if not output:
            return 0.0

        score = 0.2
        if len(output) > 50:
            score += 0.1
        if len(output) > 200:
            score += 0.1
        if len(output) > 500:
            score += 0.1

        if criteria:
            output_lower = output.lower()
            matched = sum(
                1 for key in criteria
                if key.lower() in output_lower
            )
            score += 0.45 * (matched / len(criteria))

        return min(score, 0.95)

    def ralph_status(self) -> dict:
        """Current RALPH phase and recent events (for GUI polling)."""
        return {
            "current_phase": self._current_phase,
            "phase_events": self._phase_events[-20:],
            "total_events": len(self._phase_events),
        }

    def status(self) -> dict:
        """Current state of the agent."""
        return {
            "providers": self.registry.status_report(),
            "working_memory_entries": len(self.working._store),
            "ralph": self.ralph_status(),
            "config": {
                "token_budget": self.config.token_budget,
                "wall_limit_s": self.config.wall_limit_s,
                "confidence_threshold": self.config.confidence_threshold,
                "provider_chain": self.config.provider_chain,
            },
        }
