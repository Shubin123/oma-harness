"""
OMA Core Loop -- invariant retry with time-horizon awareness and success tracking.

The loop runs until:
  - task is marked DONE with confidence >= threshold, OR
  - token budget is exhausted (triggers edge handoff), OR
  - max wall-clock time exceeded (triggers edge handoff)

Invariants maintained every iteration:
  1. task_state is always serializable (can be handed to next worker)
  2. cumulative_cost never exceeds budget without triggering summarize_and_park
  3. every provider call is wrapped in fallback chain
  4. output is sanitized before storage
"""

import time
import json
import hashlib
from dataclasses import dataclass, field, asdict
from typing import Any, Optional, Callable
from enum import Enum


class Status(Enum):
    PENDING = "pending"
    RUNNING = "running"
    BLOCKED = "blocked"
    NEAR_OUTAGE = "near_outage"
    DONE = "done"
    PARKED = "parked"  # handed off to next worker


@dataclass
class TaskState:
    task_id: str
    objective: str
    status: Status = Status.PENDING
    criteria: dict = field(default_factory=dict)
    progress: list = field(default_factory=list)     # [(step, result, confidence)]
    context_for_next: str = ""                        # handoff summary
    tokens_used: int = 0
    tokens_budget: int = 0
    wall_start: float = 0.0
    wall_limit_s: float = 0.0
    attempts: int = 0
    max_attempts: int = 20
    confidence: float = 0.0
    confidence_threshold: float = 0.85
    provider_chain: list = field(default_factory=list)  # ordered fallback
    artifacts: dict = field(default_factory=dict)       # named outputs
    checksum: str = ""

    def snapshot(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
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
    wall_limit_s: float = 300.0       # 5 min default
    max_attempts: int = 20
    confidence_threshold: float = 0.85
    token_reserve_for_handoff: int = 3000
    backoff_base_s: float = 1.0
    backoff_max_s: float = 30.0
    provider_chain: list = field(default_factory=lambda: ["claude", "gemini", "chatgpt"])


class CoreLoop:
    """
    The invariant loop. Plug in:
      - solve_fn(state, provider) -> (result, tokens_used, confidence)
      - sanitize_fn(text) -> text
      - handoff_fn(state) -> None  (persist for next worker)
    """

    def __init__(
        self,
        config: LoopConfig,
        solve_fn: Callable,
        sanitize_fn: Callable,
        handoff_fn: Callable,
        criteria_fn: Optional[Callable] = None,
    ):
        self.config = config
        self.solve = solve_fn
        self.sanitize = sanitize_fn
        self.handoff = handoff_fn
        self.criteria = criteria_fn

    def run(self, objective: str, initial_criteria: Optional[dict] = None) -> TaskState:
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

        # phase 0: solve for criteria if not provided
        if not state.criteria and self.criteria:
            state.criteria = self.criteria(state)

        # core loop -- invariant: state is always consistent and serializable
        while state.attempts < state.max_attempts:
            state.attempts += 1

            # ---- invariant checks ----
            if state.is_timed_out():
                state.status = Status.PARKED
                state.context_for_next = self._summarize_for_handoff(state, "wall_timeout")
                self.handoff(state)
                break

            if state.is_near_outage(self.config.token_reserve_for_handoff):
                state.status = Status.NEAR_OUTAGE
                state.context_for_next = self._summarize_for_handoff(state, "token_near_outage")
                self.handoff(state)
                state.status = Status.PARKED
                break

            # ---- attempt solve with provider fallback ----
            result, tokens, confidence = self._try_providers(state)
            state.tokens_used += tokens

            if result is not None:
                clean = self.sanitize(result)
                state.progress.append((state.attempts, clean, confidence))
                state.confidence = confidence

                if confidence >= state.confidence_threshold:
                    state.status = Status.DONE
                    state.artifacts["final"] = clean
                    break
            else:
                # all providers failed this round -- backoff
                wait = min(
                    self.config.backoff_base_s * (2 ** (state.attempts - 1)),
                    self.config.backoff_max_s,
                )
                time.sleep(wait)

        if state.status == Status.RUNNING:
            # exhausted attempts
            state.status = Status.PARKED
            state.context_for_next = self._summarize_for_handoff(state, "max_attempts")
            self.handoff(state)

        return state

    def _try_providers(self, state: TaskState):
        """Walk the provider chain; return first success."""
        for provider_name in state.provider_chain:
            try:
                result, tokens, confidence = self.solve(state, provider_name)
                return result, tokens, confidence
            except Exception as e:
                state.progress.append((state.attempts, f"[{provider_name}] error: {e}", 0.0))
                continue
        return None, 0, 0.0

    def _summarize_for_handoff(self, state: TaskState, reason: str) -> str:
        """
        Edge handler: compress what the next worker needs to know.
        This runs with the reserved token budget.
        """
        progress_summary = []
        for step, result, conf in state.progress[-5:]:  # last 5 steps
            preview = str(result)[:200]
            progress_summary.append(f"  step {step} (conf={conf:.2f}): {preview}")

        return "\n".join([
            f"=== OMA HANDOFF ({reason}) ===",
            f"objective: {state.objective}",
            f"criteria: {json.dumps(state.criteria, default=str)}",
            f"attempts: {state.attempts}/{state.max_attempts}",
            f"tokens: {state.tokens_used}/{state.tokens_budget}",
            f"best confidence: {state.confidence:.2f} (threshold: {state.confidence_threshold})",
            f"recent progress:",
            *progress_summary,
            f"artifacts keys: {list(state.artifacts.keys())}",
            f"=== NEXT WORKER: pick up from here ===",
        ])
