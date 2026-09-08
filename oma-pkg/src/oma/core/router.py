"""
OMA Router -- Advanced multi-strategy routing engine.

Provides OmniRoute-class capabilities on top of the existing ProviderRegistry:
  - 10 routing strategies (priority, weighted, round-robin, p2c, etc.)
  - 4-state circuit breaker (CLOSED / DEGRADED / OPEN / HALF_OPEN)
  - Multi-factor auto-scoring (10 weighted factors)
  - Cost & budget tracking with daily/monthly limits
  - Quota management with TTL-based refresh
  - Modality bridging (vision/audio -> text fallback)
  - Graceful degradation (feature-level failover)
  - Pipeline orchestration (multi-stage LLM chaining)

Zero external dependencies. Works with any ProviderRegistry instance.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class RoutingStrategy(Enum):
    PRIORITY = "priority"
    WEIGHTED = "weighted"
    ROUND_ROBIN = "round_robin"
    POWER_OF_TWO = "p2c"
    LEAST_USED = "least_used"
    COST_OPTIMIZED = "cost_optimized"
    LKGP = "lkgp"
    AUTO = "auto"
    FUSION = "fusion"
    PIPELINE = "pipeline"


class BreakerState(Enum):
    CLOSED = "closed"
    DEGRADED = "degraded"
    OPEN = "open"
    HALF_OPEN = "half_open"


class Modality(Enum):
    TEXT = "text"
    VISION = "vision"
    AUDIO = "audio"


class DegradationLevel(Enum):
    FULL = "full"
    REDUCED = "reduced"
    MINIMAL = "minimal"
    DEFAULT = "default"


# ---------------------------------------------------------------------------
# Circuit Breaker
# ---------------------------------------------------------------------------

@dataclass
class CircuitBreaker:
    """
    Four-state circuit breaker modelled after OmniRoute's three-layer
    self-healing design.

    CLOSED  -> requests flow normally
    DEGRADED -> warnings raised, requests still pass (60 % of threshold)
    OPEN    -> requests blocked until recovery timeout
    HALF_OPEN -> single probe request allowed
    """

    failure_threshold: int = 8
    degradation_pct: float = 0.6
    recovery_timeout_s: float = 30.0
    backoff_multiplier: float = 2.0
    max_backoff_multiplier: float = 16.0

    state: BreakerState = field(default=BreakerState.CLOSED)
    failure_count: int = 0
    success_count: int = 0
    last_failure_time: float = 0.0
    last_state_change: float = 0.0
    consecutive_recovery_failures: int = 0

    @property
    def degradation_threshold(self) -> int:
        return max(1, int(self.failure_threshold * self.degradation_pct))

    def record_success(self) -> None:
        self.success_count += 1
        if self.state == BreakerState.HALF_OPEN:
            self._transition(BreakerState.CLOSED)
            self.failure_count = 0
            self.consecutive_recovery_failures = 0
        elif self.state in (BreakerState.CLOSED, BreakerState.DEGRADED):
            self.failure_count = max(0, self.failure_count - 1)
            if self.failure_count < self.degradation_threshold:
                if self.state != BreakerState.CLOSED:
                    self._transition(BreakerState.CLOSED)

    def record_failure(self, immediate_open: bool = False) -> None:
        self.failure_count += 1
        self.last_failure_time = time.time()

        if immediate_open or self.failure_count >= self.failure_threshold:
            if self.state == BreakerState.HALF_OPEN:
                self.consecutive_recovery_failures += 1
            self._transition(BreakerState.OPEN)
        elif self.failure_count >= self.degradation_threshold:
            if self.state == BreakerState.CLOSED:
                self._transition(BreakerState.DEGRADED)

    def allow_request(self) -> bool:
        if self.state in (BreakerState.CLOSED, BreakerState.DEGRADED):
            return True
        if self.state == BreakerState.OPEN:
            effective_timeout = self.recovery_timeout_s * min(
                self.backoff_multiplier ** self.consecutive_recovery_failures,
                self.max_backoff_multiplier,
            )
            if time.time() - self.last_state_change >= effective_timeout:
                self._transition(BreakerState.HALF_OPEN)
                return True
            return False
        # HALF_OPEN: allow single probe
        return True

    def _transition(self, new_state: BreakerState) -> None:
        self.state = new_state
        self.last_state_change = time.time()

    def to_dict(self) -> dict:
        return {
            "state": self.state.value,
            "failure_count": self.failure_count,
            "success_count": self.success_count,
            "consecutive_recovery_failures": self.consecutive_recovery_failures,
        }


# ---------------------------------------------------------------------------
# Quota Manager
# ---------------------------------------------------------------------------

@dataclass
class QuotaEntry:
    remaining: int = -1          # -1 = unknown / unlimited
    total: int = -1
    reset_at: float = 0.0
    last_checked: float = 0.0
    exhausted: bool = False
    ttl_s: float = 300.0


class QuotaManager:
    """
    TTL-based quota tracking. Marks providers as exhausted on 429 responses,
    auto-advances window when reset_at lapses.
    """

    def __init__(self) -> None:
        self.entries: Dict[str, QuotaEntry] = {}

    def mark_exhausted(self, provider_id: str, retry_after_s: float = 300.0) -> None:
        entry = self.entries.setdefault(provider_id, QuotaEntry())
        entry.exhausted = True
        entry.reset_at = time.time() + retry_after_s
        entry.last_checked = time.time()

    def mark_available(
        self, provider_id: str, remaining: int = -1, total: int = -1
    ) -> None:
        entry = self.entries.setdefault(provider_id, QuotaEntry())
        entry.exhausted = False
        entry.remaining = remaining
        entry.total = total
        entry.last_checked = time.time()

    def is_available(self, provider_id: str) -> bool:
        entry = self.entries.get(provider_id)
        if not entry:
            return True
        if entry.exhausted:
            if time.time() >= entry.reset_at:
                entry.exhausted = False
                return True
            return False
        return True

    def remaining_pct(self, provider_id: str) -> float:
        entry = self.entries.get(provider_id)
        if not entry or entry.total <= 0:
            return 1.0
        if entry.exhausted:
            return 0.0
        return max(0.0, entry.remaining / entry.total)


# ---------------------------------------------------------------------------
# Cost / Budget Tracker
# ---------------------------------------------------------------------------

# Default pricing per 1M tokens (input, output)
DEFAULT_PRICING: Dict[str, Tuple[float, float]] = {
    "claude": (3.00, 15.00),
    "chatgpt": (2.50, 10.00),
    "gemini": (0.075, 0.30),
    "deepseek": (0.14, 0.28),
    "glm": (0.01, 0.01),
    "kimi": (0.01, 0.01),
}


@dataclass
class CostEntry:
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    total_cost: float = 0.0
    daily_tokens: int = 0
    daily_cost: float = 0.0
    monthly_tokens: int = 0
    monthly_cost: float = 0.0
    day_start: float = 0.0
    month_start: float = 0.0
    request_count: int = 0


@dataclass
class BudgetRule:
    daily_token_limit: int = -1
    daily_cost_limit: float = -1.0
    monthly_token_limit: int = -1
    monthly_cost_limit: float = -1.0
    warning_pct: float = 0.80


class CostTracker:
    """
    Per-provider spend tracking with daily and monthly budgets.
    """

    def __init__(
        self,
        pricing: Dict[str, Tuple[float, float]] = None,
        budgets: Dict[str, BudgetRule] = None,
    ) -> None:
        self.pricing = pricing or dict(DEFAULT_PRICING)
        self.budgets = budgets or {}
        self.entries: Dict[str, CostEntry] = {}

    def record(
        self, provider_id: str, tokens_in: int, tokens_out: int
    ) -> None:
        now = time.time()
        entry = self.entries.setdefault(provider_id, CostEntry())

        # roll daily/monthly windows
        if now - entry.day_start > 86400:
            entry.daily_tokens = 0
            entry.daily_cost = 0.0
            entry.day_start = now
        if now - entry.month_start > 2592000:  # ~30 days
            entry.monthly_tokens = 0
            entry.monthly_cost = 0.0
            entry.month_start = now

        p = self.pricing.get(provider_id, (0.0, 0.0))
        cost = (tokens_in * p[0] + tokens_out * p[1]) / 1_000_000
        total_tok = tokens_in + tokens_out

        entry.total_tokens_in += tokens_in
        entry.total_tokens_out += tokens_out
        entry.total_cost += cost
        entry.daily_tokens += total_tok
        entry.daily_cost += cost
        entry.monthly_tokens += total_tok
        entry.monthly_cost += cost
        entry.request_count += 1

    def check_budget(self, provider_id: str) -> Tuple[bool, float, bool]:
        """Returns (allowed, remaining_pct, warning)."""
        rule = self.budgets.get(provider_id)
        if not rule:
            return (True, 1.0, False)

        entry = self.entries.get(provider_id, CostEntry())

        # daily token limit
        if rule.daily_token_limit > 0:
            ratio = entry.daily_tokens / rule.daily_token_limit
            if ratio >= 1.0:
                return (False, 0.0, True)
            if ratio >= rule.warning_pct:
                return (True, 1.0 - ratio, True)

        # daily cost limit
        if rule.daily_cost_limit > 0:
            ratio = entry.daily_cost / rule.daily_cost_limit
            if ratio >= 1.0:
                return (False, 0.0, True)
            if ratio >= rule.warning_pct:
                return (True, 1.0 - ratio, True)

        # monthly token limit
        if rule.monthly_token_limit > 0:
            ratio = entry.monthly_tokens / rule.monthly_token_limit
            if ratio >= 1.0:
                return (False, 0.0, True)
            if ratio >= rule.warning_pct:
                return (True, 1.0 - ratio, True)

        # monthly cost limit
        if rule.monthly_cost_limit > 0:
            ratio = entry.monthly_cost / rule.monthly_cost_limit
            if ratio >= 1.0:
                return (False, 0.0, True)
            if ratio >= rule.warning_pct:
                return (True, 1.0 - ratio, True)

        return (True, 1.0, False)


# ---------------------------------------------------------------------------
# Auto Scorer (multi-factor)
# ---------------------------------------------------------------------------

@dataclass
class ScoringWeights:
    """10 weighted factors for auto-routing, normalized to sum ~1.0."""
    health: float = 0.18
    quota: float = 0.14
    cost_inv: float = 0.14
    latency_inv: float = 0.12
    task_fit: float = 0.10
    stability: float = 0.06
    tier: float = 0.06
    quality: float = 0.06
    budget_headroom: float = 0.07
    success_rate: float = 0.07


# Task fitness lookup (provider -> task_type -> score)
TASK_FITNESS: Dict[str, Dict[str, float]] = {
    "claude":   {"coding": 0.95, "reasoning": 0.95, "creative": 0.90, "general": 0.90, "rag": 0.90},
    "chatgpt":  {"coding": 0.90, "reasoning": 0.90, "creative": 0.92, "general": 0.90, "rag": 0.88},
    "gemini":   {"coding": 0.80, "reasoning": 0.85, "creative": 0.85, "general": 0.85, "rag": 0.85},
    "deepseek": {"coding": 0.88, "reasoning": 0.82, "creative": 0.75, "general": 0.80, "rag": 0.78},
    "glm":      {"coding": 0.65, "reasoning": 0.65, "creative": 0.70, "general": 0.70, "rag": 0.70},
    "kimi":     {"coding": 0.65, "reasoning": 0.65, "creative": 0.75, "general": 0.70, "rag": 0.72},
}

TIER_SCORES: Dict[str, float] = {
    "claude": 1.0, "chatgpt": 0.90, "gemini": 0.80,
    "deepseek": 0.70, "glm": 0.40, "kimi": 0.40,
}


class AutoScorer:
    """Multi-factor scoring engine inspired by OmniRoute's 16-factor auto-combo."""

    def __init__(self, weights: ScoringWeights = None) -> None:
        self.weights = weights or ScoringWeights()
        self.quality_signals: Dict[str, float] = {}

    def score(
        self,
        provider_id: str,
        breaker: CircuitBreaker,
        quota_mgr: QuotaManager,
        cost_tracker: CostTracker,
        health_stats: Dict[str, Any],
        task_type: str = "general",
    ) -> Tuple[float, Dict[str, float]]:
        w = self.weights
        f: Dict[str, float] = {}

        # 1. Health (circuit breaker state)
        state_map = {
            BreakerState.CLOSED: 1.0,
            BreakerState.DEGRADED: 0.65,
            BreakerState.HALF_OPEN: 0.30,
            BreakerState.OPEN: 0.0,
        }
        f["health"] = state_map.get(breaker.state, 0.0)

        # 2. Quota remaining
        f["quota"] = quota_mgr.remaining_pct(provider_id)

        # 3. Cost (inverse, cheaper = higher score)
        p = cost_tracker.pricing.get(provider_id, (1.0, 1.0))
        avg_price = (p[0] + p[1]) / 2.0
        pool_max = max(
            ((pp[0] + pp[1]) / 2.0 for pp in cost_tracker.pricing.values()),
            default=1.0,
        )
        f["cost_inv"] = 1.0 - (avg_price / max(pool_max, 0.001))

        # 4. Latency (inverse, lower = higher score)
        avg_lat = health_stats.get("avg_latency", 1.0)
        max_lat = health_stats.get("max_pool_latency", 10.0)
        f["latency_inv"] = 1.0 - min(avg_lat / max(max_lat, 0.001), 1.0)

        # 5. Task fitness
        fit_map = TASK_FITNESS.get(provider_id, {})
        f["task_fit"] = fit_map.get(task_type, 0.5)

        # 6. Stability (inverse of error rate)
        f["stability"] = 1.0 - min(health_stats.get("error_rate", 0.0), 1.0)

        # 7. Tier score
        f["tier"] = TIER_SCORES.get(provider_id, 0.5)

        # 8. Quality signal (EMA from feedback)
        f["quality"] = self.quality_signals.get(provider_id, 0.5)

        # 9. Budget headroom
        allowed, remaining, _ = cost_tracker.check_budget(provider_id)
        f["budget_headroom"] = remaining if allowed else 0.0

        # 10. Success rate
        f["success_rate"] = health_stats.get("success_rate", 0.5)

        total = (
            w.health * f["health"]
            + w.quota * f["quota"]
            + w.cost_inv * f["cost_inv"]
            + w.latency_inv * f["latency_inv"]
            + w.task_fit * f["task_fit"]
            + w.stability * f["stability"]
            + w.tier * f["tier"]
            + w.quality * f["quality"]
            + w.budget_headroom * f["budget_headroom"]
            + w.success_rate * f["success_rate"]
        )

        return (max(0.0, min(1.0, total)), f)

    def record_quality(self, provider_id: str, rating: float) -> None:
        alpha = 0.3
        cur = self.quality_signals.get(provider_id, 0.5)
        self.quality_signals[provider_id] = cur * (1 - alpha) + rating * alpha


# ---------------------------------------------------------------------------
# Modality Bridge
# ---------------------------------------------------------------------------

class ModalityBridge:
    """
    Bridges modality gaps across providers, matching OmniRoute's
    vision/audio/video bridge with describe/reroute modes.
    """

    VISION_CAPABLE = {"claude", "chatgpt", "gemini"}
    AUDIO_CAPABLE = {"chatgpt", "gemini"}

    @staticmethod
    def needs_bridge(provider_id: str, modality: Modality) -> bool:
        if modality == Modality.VISION:
            return provider_id not in ModalityBridge.VISION_CAPABLE
        if modality == Modality.AUDIO:
            return provider_id not in ModalityBridge.AUDIO_CAPABLE
        return False

    @staticmethod
    def describe_image(description: str) -> str:
        return f"[Image content: {description}]"

    @staticmethod
    def find_capable_provider(
        available: List[str], modality: Modality
    ) -> Optional[str]:
        cap_set = (
            ModalityBridge.VISION_CAPABLE
            if modality == Modality.VISION
            else ModalityBridge.AUDIO_CAPABLE
        )
        for p in available:
            if p in cap_set:
                return p
        return None


# ---------------------------------------------------------------------------
# Graceful Degradation
# ---------------------------------------------------------------------------

class DegradationManager:
    """
    Feature-level degradation following OmniRoute's
    withDegradation(feature, primary, fallback, safeDefault) pattern.
    """

    def __init__(self) -> None:
        self.features: Dict[str, DegradationLevel] = {}

    def with_degradation(
        self,
        feature: str,
        primary_fn: Callable,
        fallback_fn: Callable = None,
        default_value: Any = None,
    ) -> Any:
        try:
            result = primary_fn()
            self.features[feature] = DegradationLevel.FULL
            return result
        except Exception:
            if fallback_fn is not None:
                try:
                    result = fallback_fn()
                    self.features[feature] = DegradationLevel.REDUCED
                    return result
                except Exception:
                    pass
            self.features[feature] = DegradationLevel.MINIMAL
            return default_value

    def level(self, feature: str) -> DegradationLevel:
        return self.features.get(feature, DegradationLevel.DEFAULT)

    def status(self) -> Dict[str, str]:
        return {k: v.value for k, v in self.features.items()}


# ---------------------------------------------------------------------------
# Pipeline Engine
# ---------------------------------------------------------------------------

@dataclass
class PipelineStage:
    name: str
    provider_tier: str   # "best" | "moderate" | "cheapest"
    prompt_template: str = ""


PIPELINE_TEMPLATES: Dict[str, List[PipelineStage]] = {
    "code": [
        PipelineStage(
            "plan", "best",
            "Create a detailed implementation plan for:\n{input}",
        ),
        PipelineStage(
            "execute", "cheapest",
            "Implement the following plan:\n{prev}\n\nOriginal task: {input}",
        ),
        PipelineStage(
            "reflect", "moderate",
            "Review this implementation for correctness:\n{prev}\n\n"
            "Original task: {input}\n\n"
            'Respond with JSON: {{"pass": bool, "feedback": str, "corrected": str_or_null}}',
        ),
        PipelineStage(
            "fix", "cheapest",
            "Fix the following based on review:\n{prev}\n\nFeedback: {feedback}",
        ),
    ],
    "reasoning": [
        PipelineStage("execute", "best", "Solve step by step:\n{input}"),
        PipelineStage(
            "reflect", "moderate",
            "Verify this solution:\n{prev}\n\nProblem: {input}\n\n"
            'Respond with JSON: {{"pass": bool, "feedback": str, "corrected": str_or_null}}',
        ),
    ],
    "creative": [
        PipelineStage("execute", "moderate", "{input}"),
        PipelineStage(
            "reflect", "best",
            "Improve this creative work:\n{prev}\n\nOriginal brief: {input}",
        ),
    ],
    "rag": [
        PipelineStage(
            "retrieve", "cheapest",
            "Extract the key search queries needed to answer:\n{input}",
        ),
        PipelineStage(
            "generate", "best",
            "Using the retrieved context:\n{context}\n\nAnswer: {input}",
        ),
    ],
    "general": [
        PipelineStage("execute", "best", "{input}"),
        PipelineStage(
            "reflect", "moderate",
            "Check this answer for accuracy:\n{prev}\n\nQuestion: {input}",
        ),
    ],
}


class PipelineEngine:
    """Multi-stage LLM orchestration inspired by OmniRoute's pipeline strategy."""

    def __init__(self) -> None:
        self.templates = dict(PIPELINE_TEMPLATES)

    def run(
        self,
        task_type: str,
        input_text: str,
        call_fn: Callable[[str, str], str],
        available: List[str],
        context: str = "",
    ) -> Tuple[str, List[Dict[str, Any]]]:
        """
        Execute a multi-stage pipeline.

        Args:
            task_type: key into PIPELINE_TEMPLATES
            input_text: the user's request
            call_fn: (provider_id, prompt) -> response_text
            available: sorted list of provider IDs (best first)
            context: optional retrieved context for RAG pipelines

        Returns:
            (best_output, stage_log)
        """
        stages = self.templates.get(task_type, self.templates["general"])
        tier_idx = {"best": 0, "moderate": len(available) // 2, "cheapest": -1}

        prev = ""
        feedback = ""
        best_output = ""
        log: List[Dict[str, Any]] = []

        for stage in stages:
            idx = tier_idx.get(stage.provider_tier, 0)
            if idx < 0:
                idx = len(available) - 1
            provider = available[min(idx, len(available) - 1)]

            prompt = stage.prompt_template.format(
                input=input_text,
                prev=prev,
                feedback=feedback,
                context=context or prev,
            )

            t0 = time.time()
            try:
                result = call_fn(provider, prompt)
            except Exception as exc:
                log.append({
                    "stage": stage.name,
                    "provider": provider,
                    "error": str(exc),
                    "elapsed_s": round(time.time() - t0, 3),
                })
                continue
            elapsed = round(time.time() - t0, 3)

            log.append({
                "stage": stage.name,
                "provider": provider,
                "output_len": len(result),
                "elapsed_s": elapsed,
            })

            if stage.name == "reflect":
                try:
                    parsed = json.loads(result)
                    if parsed.get("pass"):
                        best_output = prev
                        break
                    feedback = parsed.get("feedback", "")
                    corrected = parsed.get("corrected")
                    if corrected:
                        prev = corrected
                        best_output = corrected
                except (json.JSONDecodeError, TypeError):
                    best_output = prev
            else:
                prev = result
                best_output = result

        return best_output, log


# ---------------------------------------------------------------------------
# Main Router
# ---------------------------------------------------------------------------

class Router:
    """
    Advanced multi-strategy routing engine that layers on top of
    ProviderRegistry to provide OmniRoute-class capabilities.
    """

    def __init__(
        self,
        strategy: RoutingStrategy = RoutingStrategy.AUTO,
        weights: ScoringWeights = None,
        pricing: Dict[str, Tuple[float, float]] = None,
        budgets: Dict[str, BudgetRule] = None,
    ) -> None:
        self.strategy = strategy
        self.breakers: Dict[str, CircuitBreaker] = {}
        self.quota_mgr = QuotaManager()
        self.cost_tracker = CostTracker(pricing=pricing, budgets=budgets)
        self.scorer = AutoScorer(weights)
        self.degradation = DegradationManager()
        self.modality_bridge = ModalityBridge()
        self.pipeline = PipelineEngine()

        # per-strategy state
        self._rr_counter = 0
        self._lkgp: Dict[str, str] = {}
        self._usage_counts: Dict[str, int] = {}
        self._provider_weights: Dict[str, float] = {}

    def get_breaker(self, provider_id: str) -> CircuitBreaker:
        if provider_id not in self.breakers:
            self.breakers[provider_id] = CircuitBreaker()
        return self.breakers[provider_id]

    def set_weights(self, provider_id: str, weight: float) -> None:
        """Set weight for weighted routing strategy."""
        self._provider_weights[provider_id] = max(0.0, weight)

    def select(
        self,
        available: List[str],
        health_stats: Dict[str, Dict[str, Any]] = None,
        task_type: str = "general",
        modality: Modality = Modality.TEXT,
    ) -> Any:
        """
        Select a provider using the configured strategy.
        Returns a single provider_id for most strategies.
        Returns a list for FUSION (parallel execution).
        """
        if not available:
            return None

        health_stats = health_stats or {}

        # filter by breaker, quota, budget
        candidates = []
        for pid in available:
            breaker = self.get_breaker(pid)
            if not breaker.allow_request():
                continue
            if not self.quota_mgr.is_available(pid):
                continue
            allowed, _, _ = self.cost_tracker.check_budget(pid)
            if not allowed:
                continue
            candidates.append(pid)

        # degraded fallback: accept degraded/half-open providers
        if not candidates:
            for pid in available:
                breaker = self.get_breaker(pid)
                if breaker.state != BreakerState.OPEN:
                    candidates.append(pid)
        if not candidates:
            candidates = list(available)  # absolute last resort

        # modality filtering
        if modality != Modality.TEXT:
            cap = [
                p for p in candidates
                if not self.modality_bridge.needs_bridge(p, modality)
            ]
            if cap:
                candidates = cap

        # dispatch by strategy
        strat = self.strategy
        if strat == RoutingStrategy.PRIORITY:
            return candidates[0]

        elif strat == RoutingStrategy.WEIGHTED:
            return self._weighted(candidates)

        elif strat == RoutingStrategy.ROUND_ROBIN:
            self._rr_counter += 1
            return candidates[self._rr_counter % len(candidates)]

        elif strat == RoutingStrategy.POWER_OF_TWO:
            return self._p2c(candidates, health_stats, task_type)

        elif strat == RoutingStrategy.LEAST_USED:
            return min(candidates, key=lambda p: self._usage_counts.get(p, 0))

        elif strat == RoutingStrategy.COST_OPTIMIZED:
            return min(
                candidates,
                key=lambda p: sum(self.cost_tracker.pricing.get(p, (999, 999))) / 2,
            )

        elif strat == RoutingStrategy.LKGP:
            return self._lkgp_select(candidates, task_type)

        elif strat == RoutingStrategy.AUTO:
            return self._auto(candidates, health_stats, task_type)

        elif strat == RoutingStrategy.FUSION:
            return candidates  # caller executes in parallel, picks best

        elif strat == RoutingStrategy.PIPELINE:
            return candidates[0]  # pipeline engine handles stage selection

        return candidates[0]

    # -- strategy helpers --

    def _weighted(self, candidates: List[str]) -> str:
        weights = [self._provider_weights.get(p, 1.0) for p in candidates]
        total = sum(weights)
        if total <= 0:
            return random.choice(candidates)
        r = random.random() * total
        cumulative = 0.0
        for i, w in enumerate(weights):
            cumulative += w
            if r <= cumulative:
                return candidates[i]
        return candidates[-1]

    def _p2c(
        self,
        candidates: List[str],
        health_stats: Dict[str, Dict[str, Any]],
        task_type: str,
    ) -> str:
        pair = (
            candidates
            if len(candidates) <= 2
            else random.sample(candidates, 2)
        )
        scored = []
        for pid in pair:
            s, _ = self.scorer.score(
                pid, self.get_breaker(pid),
                self.quota_mgr, self.cost_tracker,
                health_stats.get(pid, {}), task_type,
            )
            scored.append((s, pid))
        return max(scored, key=lambda x: x[0])[1]

    def _lkgp_select(self, candidates: List[str], task_type: str) -> str:
        last = self._lkgp.get(task_type)
        if last and last in candidates:
            return last
        return candidates[0]

    def _auto(
        self,
        candidates: List[str],
        health_stats: Dict[str, Dict[str, Any]],
        task_type: str,
    ) -> str:
        scored = []
        for pid in candidates:
            s, _ = self.scorer.score(
                pid, self.get_breaker(pid),
                self.quota_mgr, self.cost_tracker,
                health_stats.get(pid, {}), task_type,
            )
            scored.append((s, pid))
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[0][1]

    # -- recording --

    def record_success(
        self,
        provider_id: str,
        tokens_in: int = 0,
        tokens_out: int = 0,
        latency_s: float = 0.0,
        task_type: str = "general",
    ) -> None:
        self.get_breaker(provider_id).record_success()
        self._usage_counts[provider_id] = self._usage_counts.get(provider_id, 0) + 1
        self._lkgp[task_type] = provider_id
        if tokens_in or tokens_out:
            self.cost_tracker.record(provider_id, tokens_in, tokens_out)

    def record_failure(
        self,
        provider_id: str,
        error_code: int = None,
        retry_after_s: float = None,
    ) -> None:
        # auth/permission failures trip breaker immediately
        immediate = error_code in (401, 403)
        self.get_breaker(provider_id).record_failure(immediate_open=immediate)
        if error_code == 429 and retry_after_s:
            self.quota_mgr.mark_exhausted(provider_id, retry_after_s)
        elif error_code == 429:
            self.quota_mgr.mark_exhausted(provider_id)

    # -- pipeline execution --

    def run_pipeline(
        self,
        task_type: str,
        input_text: str,
        call_fn: Callable[[str, str], str],
        available: List[str],
        context: str = "",
    ) -> Tuple[str, List[Dict[str, Any]]]:
        return self.pipeline.run(task_type, input_text, call_fn, available, context)

    # -- status --

    def status(self) -> Dict[str, Any]:
        report: Dict[str, Any] = {}
        all_ids = set(self.breakers.keys()) | set(self.cost_tracker.entries.keys())
        for pid in sorted(all_ids):
            breaker = self.get_breaker(pid)
            entry = self.cost_tracker.entries.get(pid, CostEntry())
            report[pid] = {
                "breaker": breaker.to_dict(),
                "quota_available": self.quota_mgr.is_available(pid),
                "quota_remaining_pct": round(self.quota_mgr.remaining_pct(pid), 3),
                "total_tokens": entry.total_tokens_in + entry.total_tokens_out,
                "total_cost": round(entry.total_cost, 6),
                "daily_tokens": entry.daily_tokens,
                "daily_cost": round(entry.daily_cost, 6),
                "requests": entry.request_count,
                "usage_count": self._usage_counts.get(pid, 0),
            }
        return {
            "strategy": self.strategy.value,
            "providers": report,
            "lkgp": dict(self._lkgp),
            "degradation": self.degradation.status(),
        }

    def to_dict(self) -> Dict[str, Any]:
        """Full serializable snapshot for persistence or GUI."""
        return {
            "strategy": self.strategy.value,
            "breakers": {
                pid: b.to_dict() for pid, b in self.breakers.items()
            },
            "quota": {
                pid: {
                    "remaining": e.remaining,
                    "total": e.total,
                    "exhausted": e.exhausted,
                    "remaining_pct": round(self.quota_mgr.remaining_pct(pid), 3),
                }
                for pid, e in self.quota_mgr.entries.items()
            },
            "costs": {
                pid: {
                    "total_tokens": e.total_tokens_in + e.total_tokens_out,
                    "total_cost": round(e.total_cost, 6),
                    "daily_tokens": e.daily_tokens,
                    "daily_cost": round(e.daily_cost, 6),
                    "monthly_tokens": e.monthly_tokens,
                    "monthly_cost": round(e.monthly_cost, 6),
                    "requests": e.request_count,
                }
                for pid, e in self.cost_tracker.entries.items()
            },
            "scoring_weights": {
                "health": self.scorer.weights.health,
                "quota": self.scorer.weights.quota,
                "cost_inv": self.scorer.weights.cost_inv,
                "latency_inv": self.scorer.weights.latency_inv,
                "task_fit": self.scorer.weights.task_fit,
                "stability": self.scorer.weights.stability,
                "tier": self.scorer.weights.tier,
                "quality": self.scorer.weights.quality,
                "budget_headroom": self.scorer.weights.budget_headroom,
                "success_rate": self.scorer.weights.success_rate,
            },
            "lkgp": dict(self._lkgp),
            "usage_counts": dict(self._usage_counts),
            "degradation": self.degradation.status(),
        }
