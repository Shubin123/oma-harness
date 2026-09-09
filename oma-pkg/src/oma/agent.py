"""
OMA -- Open Multi Agent harness.

Wires together:
  - RALPH loop (Reason, Act, Learn, Plan, Handoff)
  - Provider registry (Claude, Gemini, ChatGPT, DeepSeek, GLM, Kimi)
  - Advanced routing engine (10 strategies, circuit breaker, cost/quota)
  - OmniRoute bridge (352+ providers when gateway is running)
  - Criteria engine (define what "done" means)
  - Sanitizer (strip provider fingerprints)
  - Automation layers (pixel, page, memory)
  - Edge handlers (near-outage summarize, outage recovery)

Usage:
    from oma import OMA

    # standalone mode (embedded router)
    agent = OMA.from_env()
    result = agent.run("build a web scraper for HN front page")

    # with OmniRoute gateway (352+ providers, full routing)
    agent = OMA.from_env(omniroute=True)
    result = agent.run("build a web scraper for HN front page")
"""

from collections.abc import Callable
from typing import Any

from oma.automation.memory import ContextOptimizer, PersistentMemory, WorkingMemory
from oma.core.criteria import ensure_criteria
from oma.core.edge import near_outage_handler
from oma.core.loop import (
    Lesson,
    LoopConfig,
    PhaseEvent,
    PlanDecision,
    RalphLoop,
    Reasoning,
    Strategy,
    TaskState,
)
from oma.core.omniroute_bridge import OmniRouteBridge, OmniRouteConfig
from oma.core.router import (
    BudgetRule,
    Modality,
    Router,
    RoutingStrategy,
    ScoringWeights,
)
from oma.core.sanitize import Sanitizer
from oma.providers.base import ErrorClass
from oma.providers.registry import ProviderRegistry


class OMA:
    """
    Top-level agent orchestrator.

    Supports two routing modes:
      1. Embedded router (default) -- 10 strategies, circuit breaker,
         cost/quota tracking. Works standalone with no external services.
      2. OmniRoute gateway -- routes through a running OmniRoute instance
         for 352+ providers, advanced compression, modality bridging.
         Falls back to embedded router if gateway is unreachable.
    """

    def __init__(
        self,
        registry: ProviderRegistry,
        config: LoopConfig | None = None,
        sanitizer: Sanitizer | None = None,
        memory_dir: str = ".oma_memory",
        routing_strategy: RoutingStrategy = RoutingStrategy.AUTO,
        scoring_weights: ScoringWeights | None = None,
        budgets: dict | None = None,
        omniroute: bool = False,
        omniroute_config: OmniRouteConfig | None = None,
    ):
        self.registry = registry
        self.config = config or LoopConfig(
            provider_chain=registry.fallback_chain(),
        )
        self.sanitizer = sanitizer or Sanitizer()
        self.working = WorkingMemory()
        self.persistent = PersistentMemory(base_dir=memory_dir)
        self.optimizer = ContextOptimizer(token_budget=self.config.token_budget)

        # embedded router
        budget_rules = None
        if budgets:
            budget_rules = {
                k: BudgetRule(**v) if isinstance(v, dict) else v
                for k, v in budgets.items()
            }
        self.router = Router(
            strategy=routing_strategy,
            weights=scoring_weights,
            budgets=budget_rules,
        )

        # OmniRoute bridge (optional)
        self.omniroute_bridge = None
        self._omniroute_enabled = omniroute
        if omniroute:
            cfg = omniroute_config or OmniRouteConfig()
            self.omniroute_bridge = OmniRouteBridge(cfg)

        # ralph phase tracking for GUI
        self._current_phase = "idle"
        self._phase_events: list[dict] = []

    @classmethod
    def from_env(
        cls,
        omniroute: bool = False,
        routing_strategy: RoutingStrategy = RoutingStrategy.AUTO,
        **kwargs,
    ) -> "OMA":
        """Create OMA from environment variables."""
        registry = ProviderRegistry.from_env()
        return cls(
            registry=registry,
            omniroute=omniroute,
            routing_strategy=routing_strategy,
            **kwargs,
        )

    @classmethod
    def load(cls, omniroute: bool = False, **kwargs) -> "OMA":
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
        return cls(registry=registry, omniroute=omniroute, **kwargs)

    @classmethod
    def from_credentials(cls, auth_manager, omniroute: bool = False, **kwargs) -> "OMA":
        """
        Create OMA from stored credentials (subscription or API key).

        This is used by the graphical UI -- providers are registered from
        browser-based login sessions rather than env vars.
        """
        registry = ProviderRegistry.from_credentials(auth_manager)
        if not registry.available() and not registry._providers:
            registry = ProviderRegistry.from_env()
        return cls(registry=registry, omniroute=omniroute, **kwargs)

    def run(
        self,
        objective: str,
        criteria: dict | None = None,
        system: str = "",
        resume_from: str | None = None,
        on_phase: Callable[[Any], None] | None = None,
        task_type: str = "general",
        modality: Modality = Modality.TEXT,
    ) -> TaskState:
        """
        Run the full RALPH agent loop.

        Args:
            objective: what to accomplish
            criteria: optional pre-defined success criteria
            system: system prompt override
            resume_from: task_id to resume from (loads persistent memory)
            on_phase: optional callback for phase transitions (GUI use)
            task_type: hint for router scoring (general/coding/creative/rag)
            modality: input modality (text/vision/audio)
        """
        self._current_phase = "idle"
        self._phase_events = []

        # probe OmniRoute availability if enabled -- reading the property
        # runs the health check once and caches the verdict
        if self.omniroute_bridge:
            _ = self.omniroute_bridge.available

        # load previous state if resuming
        prev_context: dict = {}
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
            # dual-mode dispatch: OmniRoute gateway vs embedded
            if self.omniroute_bridge and self.omniroute_bridge.available:
                return self._solve_via_omniroute(
                    state, provider_name, system, prev_context
                )
            return self._solve_direct(
                state, provider_name, system, prev_context, task_type
            )

        def reason_fn(state: TaskState, strategy: Strategy) -> Reasoning:
            """
            Analyze state and determine approach for this iteration.
            Uses router scoring and provider health to inform reasoning.
            """
            reasoning = Reasoning()

            # gather provider health info
            health = self.registry.status_report()
            healthy_providers = [
                name for name, h in health.items()
                if not h.get("in_cooldown", False)
            ]

            # use router to pick best provider
            available = self.registry.available()
            if available:
                selected = self.router.select(
                    available=available,
                    health_stats=health,
                    task_type=task_type,
                    modality=modality,
                )
                if isinstance(selected, list):
                    # fusion mode: prefer first
                    reasoning.provider_preference = selected[0] if selected else ""
                elif selected:
                    reasoning.provider_preference = selected

            if state.attempts == 1:
                reasoning.analysis = f"First attempt: {state.objective}"
                reasoning.approach = "direct"
            elif strategy.consecutive_failures > 2:
                reasoning.analysis = (
                    f"Consecutive failures: {strategy.consecutive_failures}. "
                    f"Switching strategy."
                )
                reasoning.approach = "alternative"
                # router already accounts for breaker state, but try tail
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
            Uses router status to inform provider ordering.
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

    def _solve_direct(
        self,
        state: TaskState,
        provider_name: str,
        system: str,
        prev_context: dict,
        task_type: str,
    ):
        """Execute via embedded provider registry with router tracking."""
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
                strategy_ctx = "\n\nLessons from previous attempts:\n" + "\n".join(
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
            # A provider that fails without classifying the error is treated
            # as transient, so one odd response does not retire the chain.
            ec = response.error_class or ErrorClass.RETRYABLE
            self.registry.record_failure(provider_name, response.error or "", ec)
            # record failure in router too
            error_code = getattr(response, "error_code", None) or 0
            self.router.record_failure(
                provider_name,
                error_code=error_code,
            )
            raise RuntimeError(f"{provider_name}: {response.error}")

        self.registry.record_success(
            provider_name, response.tokens_total, response.latency_ms
        )

        # track in router
        tokens_in = getattr(response, "tokens_in", 0) or 0
        tokens_out = getattr(response, "tokens_out", 0) or 0
        self.router.record_success(
            provider_name,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            latency_s=(response.latency_ms or 0) / 1000.0,
            task_type=task_type,
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

    def _solve_via_omniroute(
        self,
        state: TaskState,
        provider_name: str,
        system: str,
        prev_context: dict,
    ):
        """Execute via OmniRoute gateway for full 352+ provider routing."""
        bridge = self.omniroute_bridge
        if bridge is None:  # only reachable if the bridge was torn down mid-run
            return self._solve_direct(state, provider_name, system, prev_context, "general")

        # build messages
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})

        strategy_ctx = ""
        if state.strategy:
            notes = state.strategy.get("approach_notes", [])
            if notes:
                strategy_ctx = "\n\nLessons from previous attempts:\n" + "\n".join(
                    f"- {n}" for n in notes[-3:]
                )

        msgs.append({
            "role": "user",
            "content": f"Complete this task: {state.objective}\n\n"
                       f"Criteria: {state.criteria}\n\n"
                       f"Attempt {state.attempts}. "
                       f"Previous confidence: {state.confidence:.2f}"
                       f"{strategy_ctx}",
        })

        # resolve model: prefer auto-routing
        model = bridge.resolve_model(provider_name, prefer_auto=True)

        resp = bridge.chat_completion(
            messages=msgs,
            model=model,
            temperature=0.3,
        )

        if not resp.ok:
            error_code = resp.error_code or 0
            self.router.record_failure(provider_name, error_code=error_code)
            # fallback to direct if OmniRoute fails
            if self.registry.get(provider_name):
                return self._solve_direct(
                    state, provider_name, system, prev_context, "general"
                )
            raise RuntimeError(f"OmniRoute: {resp.error}")

        # record in router
        self.router.record_success(
            resp.provider or provider_name,
            tokens_in=resp.tokens_in,
            tokens_out=resp.tokens_out,
            latency_s=resp.latency_ms / 1000.0,
        )

        # store in working memory
        self.working.put(
            f"attempt_{state.attempts}",
            resp.text[:500],
            tags=["attempt", "result", "omniroute"],
            source=resp.provider or provider_name,
        )

        confidence = self._estimate_confidence(resp.text, state.criteria)
        tokens_total = resp.tokens_total

        return resp.text, tokens_total, confidence

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

    def router_status(self) -> dict:
        """Router, circuit breaker, and cost status for GUI dashboard."""
        result = self.router.status()
        if self.omniroute_bridge:
            result["omniroute"] = self.omniroute_bridge.status()
        return result

    def status(self) -> dict:
        """Current state of the agent."""
        st = {
            "providers": self.registry.status_report(),
            "working_memory_entries": len(self.working._store),
            "ralph": self.ralph_status(),
            "router": self.router_status(),
            "config": {
                "token_budget": self.config.token_budget,
                "wall_limit_s": self.config.wall_limit_s,
                "confidence_threshold": self.config.confidence_threshold,
                "provider_chain": self.config.provider_chain,
                "routing_strategy": self.router.strategy.value,
                "omniroute_enabled": self._omniroute_enabled,
            },
        }
        if self.omniroute_bridge:
            st["omniroute_available"] = self.omniroute_bridge.available
        return st
