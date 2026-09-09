"""
OMA Core Loop -- RALPH (Reason, Act, Learn, Plan, Handoff).

Five-phase agent loop with invariant retry, time-horizon awareness,
success tracking, and adaptive strategy.

The loop runs until:
  - task is marked DONE with confidence >= threshold, OR
  - token budget is exhausted (triggers edge handoff), OR
  - max wall-clock time exceeded (triggers edge handoff)

Invariants maintained every iteration:
  1. task_state is always serializable (can be handed to next worker)
  2. cumulative_cost never exceeds budget without triggering summarize_and_park
  3. every provider call is wrapped in fallback chain
  4. output is sanitized before storage

RALPH phases per iteration:
  R - Reason:  analyze state, decompose problem, identify approach
  A - Act:     execute solve attempt with provider fallback
  L - Learn:   evaluate result against criteria, extract lessons
  P - Plan:    adjust strategy based on lessons (reorder providers, refine approach)
  H - Handoff: if done or at edge, create handoff; else loop to Reason
"""

import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class Status(Enum):
    PENDING = "pending"
    RUNNING = "running"
    BLOCKED = "blocked"
    NEAR_OUTAGE = "near_outage"
    DONE = "done"
    PARKED = "parked"


class RalphPhase(Enum):
    IDLE = "idle"
    REASON = "reason"
    ACT = "act"
    LEARN = "learn"
    PLAN = "plan"
    HANDOFF = "handoff"


@dataclass
class PhaseEvent:
    """Emitted at each phase transition for GUI/logging."""
    phase: RalphPhase
    iteration: int
    data: dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)


@dataclass
class Reasoning:
    """Output of the Reason phase."""
    analysis: str = ""
    approach: str = ""
    focus_areas: list = field(default_factory=list)
    provider_preference: str = ""


@dataclass
class Lesson:
    """Output of the Learn phase."""
    iteration: int = 0
    succeeded: bool = False
    confidence_delta: float = 0.0
    what_worked: str = ""
    what_failed: str = ""
    provider_used: str = ""
    tokens_spent: int = 0


@dataclass
class PlanDecision:
    """Output of the Plan phase."""
    action: str = "continue"          # "continue" | "done" | "park"
    reason: str = ""
    reorder_providers: list = field(default_factory=list)
    adjust_temperature: float | None = None
    refine_prompt: str = ""
    escalate: bool = False


@dataclass
class Strategy:
    """Accumulated strategy state, updated each Plan phase."""
    provider_order: list = field(default_factory=list)
    temperature: float = 0.3
    approach_notes: list = field(default_factory=list)
    lessons_summary: str = ""
    consecutive_failures: int = 0
    best_confidence: float = 0.0
    best_result: str = ""
    total_lessons: int = 0

    def to_dict(self) -> dict:
        return {
            "provider_order": self.provider_order,
            "temperature": self.temperature,
            "approach_notes": self.approach_notes[-3:],
            "lessons_summary": self.lessons_summary,
            "consecutive_failures": self.consecutive_failures,
            "best_confidence": self.best_confidence,
            "total_lessons": self.total_lessons,
        }


@dataclass
class TaskState:
    task_id: str
    objective: str
    status: Status = Status.PENDING
    criteria: dict = field(default_factory=dict)
    progress: list = field(default_factory=list)     # [(step, result, confidence)]
    context_for_next: str = ""
    tokens_used: int = 0
    tokens_budget: int = 0
    wall_start: float = 0.0
    wall_limit_s: float = 0.0
    attempts: int = 0
    max_attempts: int = 20
    confidence: float = 0.0
    confidence_threshold: float = 0.85
    provider_chain: list = field(default_factory=list)
    artifacts: dict = field(default_factory=dict)
    checksum: str = ""
    # ralph-specific state
    current_phase: str = "idle"
    phase_history: list = field(default_factory=list)  # [PhaseEvent data]
    strategy: dict = field(default_factory=dict)
    lessons: list = field(default_factory=list)

    def snapshot(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        # strip non-serializable fields for checksum
        raw = json.dumps(d, sort_keys=True, default=str)
        d["checksum"] = hashlib.sha256(raw.encode()).hexdigest()[:16]
        return d

    def remaining_tokens(self) -> int:
        return max(0, self.tokens_budget - self.tokens_used)

    def remaining_time(self) -> float:
        if self.wall_limit_s <= 0:
            return float("inf")
        return max(0.0, self.wall_limit_s - (time.time() - self.wall_start))

    def is_near_outage(self, token_reserve: int = 2000) -> bool:
        return self.remaining_tokens() < token_reserve

    def is_timed_out(self) -> bool:
        return self.remaining_time() <= 0


@dataclass
class LoopConfig:
    token_budget: int = 100_000
    wall_limit_s: float = 600.0
    max_attempts: int = 20
    confidence_threshold: float = 0.85
    token_reserve_for_handoff: int = 3000
    backoff_base_s: float = 2.0
    backoff_max_s: float = 30.0
    provider_chain: list = field(default_factory=lambda: ["claude", "gemini", "chatgpt"])


# ---- type aliases for callbacks ----
# solve_fn(state, provider) -> (result, tokens_used, confidence)
# sanitize_fn(text) -> text
# handoff_fn(state) -> None
# reason_fn(state, strategy) -> Reasoning
# plan_fn(state, strategy, lesson) -> PlanDecision
# on_phase(event) -> None


class RalphLoop:
    """
    The RALPH loop. Five-phase agent loop with adaptive strategy.

    Plug in:
      - solve_fn(state, provider) -> (result, tokens_used, confidence)
      - sanitize_fn(text) -> text
      - handoff_fn(state) -> None
      - reason_fn(state, strategy) -> Reasoning (optional)
      - plan_fn(state, strategy, lesson) -> PlanDecision (optional)
      - on_phase(event) -> None (optional, for GUI updates)
      - criteria_fn(state) -> dict (optional)
    """

    def __init__(
        self,
        config: LoopConfig,
        solve_fn: Callable,
        sanitize_fn: Callable,
        handoff_fn: Callable,
        reason_fn: Callable | None = None,
        plan_fn: Callable | None = None,
        on_phase: Callable | None = None,
        criteria_fn: Callable | None = None,
    ):
        self.config = config
        self.solve = solve_fn
        self.sanitize = sanitize_fn
        self.handoff = handoff_fn
        self.reason_fn = reason_fn
        self.plan_fn = plan_fn
        self.on_phase = on_phase
        self.criteria = criteria_fn

    def _emit(self, state: TaskState, phase: RalphPhase, data: dict | None = None):
        """Emit a phase event and update state tracking."""
        event = PhaseEvent(
            phase=phase,
            iteration=state.attempts,
            data=data or {},
        )
        state.current_phase = phase.value
        state.phase_history.append({
            "phase": phase.value,
            "iteration": state.attempts,
            "timestamp": event.timestamp,
            "data": event.data,
        })
        if self.on_phase:
            try:
                self.on_phase(event)
            except Exception:
                pass  # observer failures must not break the loop

    def run(self, objective: str, initial_criteria: dict | None = None) -> TaskState:
        state = TaskState(
            task_id=hashlib.sha256(f"{objective}{time.time()}".encode()).hexdigest()[:12],
            objective=objective,
            status=Status.RUNNING,
            tokens_budget=self.config.token_budget,
            wall_start=time.time(),
            wall_limit_s=self.config.wall_limit_s,
            max_attempts=self.config.max_attempts,
            confidence_threshold=self.config.confidence_threshold,
            provider_chain=list(self.config.provider_chain),
            criteria=initial_criteria or {},
        )

        # initialize strategy
        strategy = Strategy(
            provider_order=list(self.config.provider_chain),
        )
        state.strategy = strategy.to_dict()

        # phase 0: solve for criteria if not provided
        if not state.criteria and self.criteria:
            state.criteria = self.criteria(state)

        # ---- RALPH loop ----
        while state.attempts < state.max_attempts:
            state.attempts += 1

            # ---- invariant checks (before any phase) ----
            if state.is_timed_out():
                self._emit(state, RalphPhase.HANDOFF, {"trigger": "wall_timeout"})
                state.status = Status.PARKED
                state.context_for_next = self._summarize_for_handoff(state, "wall_timeout")
                self.handoff(state)
                break

            if state.is_near_outage(self.config.token_reserve_for_handoff):
                self._emit(state, RalphPhase.HANDOFF, {"trigger": "token_near_outage"})
                state.status = Status.NEAR_OUTAGE
                state.context_for_next = self._summarize_for_handoff(state, "token_near_outage")
                self.handoff(state)
                state.status = Status.PARKED
                break

            # ---- R: REASON ----
            reasoning = self._phase_reason(state, strategy)

            # ---- A: ACT ----
            result, tokens, confidence, provider_used = self._phase_act(
                state, strategy, reasoning
            )
            state.tokens_used += tokens

            # ---- L: LEARN ----
            lesson = self._phase_learn(
                state, strategy, result, tokens, confidence, provider_used
            )

            # ---- P: PLAN ----
            decision = self._phase_plan(state, strategy, lesson)

            # ---- H: HANDOFF ----
            if decision.action == "done":
                self._emit(state, RalphPhase.HANDOFF, {"trigger": "done"})
                state.status = Status.DONE
                if strategy.best_result:
                    state.artifacts["final"] = strategy.best_result
                break
            elif decision.action == "park":
                self._emit(state, RalphPhase.HANDOFF, {"trigger": decision.reason})
                state.status = Status.PARKED
                state.context_for_next = self._summarize_for_handoff(
                    state, decision.reason
                )
                self.handoff(state)
                break
            else:
                # "continue" - apply strategy adjustments
                if decision.reorder_providers:
                    state.provider_chain = decision.reorder_providers
                    strategy.provider_order = decision.reorder_providers

                state.strategy = strategy.to_dict()
                self._emit(state, RalphPhase.HANDOFF, {"trigger": "continue"})

        # if we exhausted attempts without a decision
        if state.status == Status.RUNNING:
            self._emit(state, RalphPhase.HANDOFF, {"trigger": "max_attempts"})
            state.status = Status.PARKED
            state.context_for_next = self._summarize_for_handoff(state, "max_attempts")
            self.handoff(state)

        state.current_phase = RalphPhase.IDLE.value
        return state

    # ---- RALPH phase implementations ----

    def _phase_reason(self, state: TaskState, strategy: Strategy) -> Reasoning:
        """R: Analyze state, identify approach for this iteration."""
        self._emit(state, RalphPhase.REASON, {
            "iteration": state.attempts,
            "confidence_so_far": state.confidence,
            "consecutive_failures": strategy.consecutive_failures,
        })

        if self.reason_fn:
            try:
                reasoning: Reasoning = self.reason_fn(state, strategy)
                return reasoning
            except Exception:
                pass

        # default reasoning: heuristic analysis
        reasoning = Reasoning()

        if state.attempts == 1:
            reasoning.analysis = f"First attempt at: {state.objective}"
            reasoning.approach = "direct"
        elif strategy.consecutive_failures > 2:
            reasoning.analysis = (
                f"Multiple failures ({strategy.consecutive_failures}). "
                f"Changing approach."
            )
            reasoning.approach = "alternative"
            # try different provider
            if len(strategy.provider_order) > 1:
                reasoning.provider_preference = strategy.provider_order[-1]
        else:
            reasoning.analysis = (
                f"Attempt {state.attempts}, "
                f"best confidence so far: {strategy.best_confidence:.2f}"
            )
            reasoning.approach = "iterative"

        if state.criteria:
            reasoning.focus_areas = list(state.criteria.keys())[:5]

        return reasoning

    def _phase_act(
        self,
        state: TaskState,
        strategy: Strategy,
        reasoning: Reasoning,
    ) -> tuple:
        """A: Execute solve attempt with provider fallback."""
        self._emit(state, RalphPhase.ACT, {
            "approach": reasoning.approach,
            "provider_preference": reasoning.provider_preference,
        })

        # determine provider order for this attempt
        providers = list(strategy.provider_order)
        if reasoning.provider_preference and reasoning.provider_preference in providers:
            # move preferred provider to front
            providers.remove(reasoning.provider_preference)
            providers.insert(0, reasoning.provider_preference)

        provider_used = ""
        for provider_name in providers:
            try:
                result, tokens, confidence = self.solve(state, provider_name)
                provider_used = provider_name
                return result, tokens, confidence, provider_used
            except Exception as e:
                state.progress.append(
                    (state.attempts, f"[{provider_name}] error: {e}", 0.0)
                )
                continue

        # all providers failed - backoff
        wait = min(
            self.config.backoff_base_s * (2 ** (state.attempts - 1)),
            self.config.backoff_max_s,
        )
        time.sleep(wait)
        return None, 0, 0.0, ""

    def _phase_learn(
        self,
        state: TaskState,
        strategy: Strategy,
        result: Any,
        tokens: int,
        confidence: float,
        provider_used: str,
    ) -> Lesson:
        """L: Evaluate result, extract lessons, update memory."""
        self._emit(state, RalphPhase.LEARN, {
            "has_result": result is not None,
            "confidence": confidence,
            "provider": provider_used,
        })

        lesson = Lesson(
            iteration=state.attempts,
            provider_used=provider_used,
            tokens_spent=tokens,
        )

        if result is not None:
            clean = self.sanitize(result)
            state.progress.append((state.attempts, clean, confidence))
            state.confidence = confidence

            lesson.succeeded = True
            lesson.confidence_delta = confidence - strategy.best_confidence

            if confidence > strategy.best_confidence:
                strategy.best_confidence = confidence
                strategy.best_result = clean
                lesson.what_worked = (
                    f"Provider {provider_used} achieved new best "
                    f"confidence {confidence:.2f}"
                )
            else:
                lesson.what_worked = (
                    f"Got result but below best ({confidence:.2f} < "
                    f"{strategy.best_confidence:.2f})"
                )

            # track in artifacts if this meets threshold
            if confidence >= state.confidence_threshold:
                state.artifacts["final"] = clean
        else:
            lesson.succeeded = False
            lesson.what_failed = "All providers failed this round"

        strategy.total_lessons += 1
        state.lessons.append({
            "iteration": lesson.iteration,
            "succeeded": lesson.succeeded,
            "confidence_delta": lesson.confidence_delta,
            "provider": lesson.provider_used,
        })

        return lesson

    def _phase_plan(
        self,
        state: TaskState,
        strategy: Strategy,
        lesson: Lesson,
    ) -> PlanDecision:
        """P: Adjust strategy based on lessons, decide next action."""
        self._emit(state, RalphPhase.PLAN, {
            "lesson_succeeded": lesson.succeeded,
            "best_confidence": strategy.best_confidence,
            "threshold": state.confidence_threshold,
        })

        if self.plan_fn:
            try:
                decision: PlanDecision = self.plan_fn(state, strategy, lesson)
                # apply the decision's strategy effects
                self._apply_plan_effects(strategy, lesson, decision)
                return decision
            except Exception:
                pass

        # default planning logic
        decision = PlanDecision()

        # check: did we hit the confidence threshold?
        if strategy.best_confidence >= state.confidence_threshold:
            decision.action = "done"
            decision.reason = (
                f"Confidence {strategy.best_confidence:.2f} >= "
                f"threshold {state.confidence_threshold:.2f}"
            )
            return decision

        # track consecutive failures
        if lesson.succeeded:
            strategy.consecutive_failures = 0
        else:
            strategy.consecutive_failures += 1

        # too many consecutive failures - park
        if strategy.consecutive_failures >= 3:
            decision.action = "park"
            decision.reason = f"consecutive_failures ({strategy.consecutive_failures})"
            return decision

        # approaching budget limits - park
        remaining_pct = state.remaining_tokens() / max(state.tokens_budget, 1)
        if remaining_pct < 0.15:
            decision.action = "park"
            decision.reason = "low_budget"
            return decision

        # adaptive provider reordering
        if lesson.succeeded and lesson.provider_used:
            # promote successful provider
            new_order = list(strategy.provider_order)
            if lesson.provider_used in new_order:
                new_order.remove(lesson.provider_used)
                new_order.insert(0, lesson.provider_used)
                decision.reorder_providers = new_order
        elif not lesson.succeeded and strategy.provider_order:
            # rotate: move first provider to end
            new_order = list(strategy.provider_order)
            if len(new_order) > 1:
                new_order.append(new_order.pop(0))
                decision.reorder_providers = new_order

        # add approach note
        if lesson.what_worked:
            strategy.approach_notes.append(lesson.what_worked)
        elif lesson.what_failed:
            strategy.approach_notes.append(lesson.what_failed)

        decision.action = "continue"
        decision.reason = "iterating"

        return decision

    def _apply_plan_effects(
        self, strategy: Strategy, lesson: Lesson, decision: PlanDecision
    ):
        """Apply side effects from a plan decision onto strategy."""
        if lesson.succeeded:
            strategy.consecutive_failures = 0
        else:
            strategy.consecutive_failures += 1

        if lesson.what_worked:
            strategy.approach_notes.append(lesson.what_worked)
        elif lesson.what_failed:
            strategy.approach_notes.append(lesson.what_failed)

    # ---- handoff support ----

    def _summarize_for_handoff(self, state: TaskState, reason: str) -> str:
        """Compress what the next worker needs to know."""
        progress_summary = []
        for step, result, conf in state.progress[-5:]:
            preview = str(result)[:200]
            progress_summary.append(f"  step {step} (conf={conf:.2f}): {preview}")

        strategy_info = state.strategy or {}

        return "\n".join([
            f"=== OMA HANDOFF ({reason}) ===",
            f"objective: {state.objective}",
            f"criteria: {json.dumps(state.criteria, default=str)}",
            f"attempts: {state.attempts}/{state.max_attempts}",
            f"tokens: {state.tokens_used}/{state.tokens_budget}",
            f"best confidence: {state.confidence:.2f} (threshold: {state.confidence_threshold})",
            f"strategy: {json.dumps(strategy_info, default=str)}",
            f"lessons learned: {len(state.lessons)}",
            "recent progress:",
            *progress_summary,
            f"artifacts keys: {list(state.artifacts.keys())}",
            "=== NEXT WORKER: pick up from here ===",
        ])


# ---- backwards compatibility ----
# CoreLoop is now an alias for RalphLoop with no reason/plan overrides
# (the default heuristic reason/plan kicks in)
CoreLoop = RalphLoop
