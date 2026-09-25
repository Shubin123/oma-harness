"""Tests for the advanced router engine (10 strategies, circuit breaker, quota, cost, pipeline)."""

import json
import pytest

from oma.core.router import (
    AutoScorer,
    BreakerState,
    BudgetRule,
    CircuitBreaker,
    CostTracker,
    DegradationLevel,
    DegradationManager,
    Modality,
    ModalityBridge,
    PipelineEngine,
    QuotaManager,
    Router,
    RoutingStrategy,
    ScoringWeights,
)

pytestmark = pytest.mark.unit


class TestCircuitBreaker:
    def test_initial_state_closed(self):
        cb = CircuitBreaker(failure_threshold=5)
        assert cb.state == BreakerState.CLOSED
        assert cb.allow_request() is True

    def test_degrades_at_threshold_fraction(self):
        cb = CircuitBreaker(failure_threshold=5, degradation_pct=0.6)
        # degradation_threshold = max(1, int(5 * 0.6)) = 3
        cb.record_failure()
        cb.record_failure()
        assert cb.state == BreakerState.CLOSED
        cb.record_failure()
        assert cb.state == BreakerState.DEGRADED
        assert cb.allow_request() is True

    def test_opens_at_full_failure_threshold(self):
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_failure()
        assert cb.state == BreakerState.OPEN
        assert cb.allow_request() is False

    def test_immediate_open_on_critical_failure(self):
        cb = CircuitBreaker()
        cb.record_failure(immediate_open=True)
        assert cb.state == BreakerState.OPEN
        assert cb.allow_request() is False

    def test_recovery_transition_to_half_open(self):
        cb = CircuitBreaker(recovery_timeout_s=0.01)
        cb.record_failure(immediate_open=True)
        assert cb.state == BreakerState.OPEN
        import time
        time.sleep(0.02)
        # allow_request triggers transition to HALF_OPEN
        assert cb.allow_request() is True
        assert cb.state == BreakerState.HALF_OPEN

    def test_half_open_success_closes_breaker(self):
        cb = CircuitBreaker(recovery_timeout_s=0.01)
        cb.record_failure(immediate_open=True)
        import time
        time.sleep(0.02)
        cb.allow_request()  # becomes HALF_OPEN
        cb.record_success()
        assert cb.state == BreakerState.CLOSED
        assert cb.failure_count == 0

    def test_half_open_failure_increases_backoff(self):
        cb = CircuitBreaker(recovery_timeout_s=0.01, backoff_multiplier=2.0)
        cb.record_failure(immediate_open=True)
        import time
        time.sleep(0.02)
        cb.allow_request()  # becomes HALF_OPEN
        cb.record_failure()
        assert cb.state == BreakerState.OPEN
        assert cb.consecutive_recovery_failures == 1

    def test_serialization(self):
        cb = CircuitBreaker()
        cb.record_success()
        d = cb.to_dict()
        assert d["state"] == "closed"
        assert d["success_count"] == 1


class TestQuotaManager:
    def test_initially_available(self):
        qm = QuotaManager()
        assert qm.is_available("claude") is True
        assert qm.remaining_pct("claude") == 1.0

    def test_exhaustion_and_expiry(self):
        qm = QuotaManager()
        qm.mark_exhausted("claude", retry_after_s=0.02)
        assert qm.is_available("claude") is False
        assert qm.remaining_pct("claude") == 0.0

        import time
        time.sleep(0.03)
        assert qm.is_available("claude") is True

    def test_mark_available_with_counts(self):
        qm = QuotaManager()
        qm.mark_available("gemini", remaining=250, total=1000)
        assert qm.is_available("gemini") is True
        assert qm.remaining_pct("gemini") == 0.25


class TestCostTracker:
    def test_cost_calculation(self):
        ct = CostTracker(pricing={"custom": (2.0, 10.0)})
        ct.record("custom", tokens_in=500_000, tokens_out=100_000)
        # cost = (500k * 2.0 + 100k * 10.0) / 1M = (1M + 1M) / 1M = 2.0
        entry = ct.entries["custom"]
        assert entry.total_cost == pytest.approx(2.0)
        assert entry.total_tokens_in == 500_000
        assert entry.total_tokens_out == 100_000

    def test_budget_rule_token_limit(self):
        rule = BudgetRule(daily_token_limit=10_000, warning_pct=0.8)
        ct = CostTracker(budgets={"limited": rule})

        # within budget
        ct.record("limited", tokens_in=5_000, tokens_out=1_000)
        allowed, remaining, warning = ct.check_budget("limited")
        assert allowed is True
        assert warning is False

        # warning range
        ct.record("limited", tokens_in=2_500, tokens_out=500)  # total 9,000 / 10,000 (90%)
        allowed, remaining, warning = ct.check_budget("limited")
        assert allowed is True
        assert warning is True

        # exceeded
        ct.record("limited", tokens_in=1_500, tokens_out=500)  # total 11,000
        allowed, remaining, warning = ct.check_budget("limited")
        assert allowed is False
        assert remaining == 0.0
        assert warning is True

    def test_budget_rule_cost_limit(self):
        rule = BudgetRule(daily_cost_limit=1.0)
        ct = CostTracker(pricing={"paid": (10.0, 10.0)}, budgets={"paid": rule})
        ct.record("paid", tokens_in=150_000, tokens_out=0)  # 1.50
        allowed, _, _ = ct.check_budget("paid")
        assert allowed is False


class TestAutoScorer:
    def test_scoring_weights(self):
        scorer = AutoScorer()
        breaker = CircuitBreaker()
        qm = QuotaManager()
        ct = CostTracker()
        health = {"avg_latency": 0.5, "max_pool_latency": 2.0, "error_rate": 0.0, "success_rate": 1.0}

        score, factors = scorer.score("claude", breaker, qm, ct, health, task_type="coding")
        assert 0.0 <= score <= 1.0
        assert factors["health"] == 1.0
        assert factors["quota"] == 1.0
        assert factors["task_fit"] >= 0.9

    def test_quality_feedback_ema(self):
        scorer = AutoScorer()
        scorer.record_quality("claude", 1.0)
        # alpha=0.3: 0.5 * 0.7 + 1.0 * 0.3 = 0.65
        assert scorer.quality_signals["claude"] == pytest.approx(0.65)


class TestModalityBridge:
    def test_needs_bridge(self):
        mb = ModalityBridge()
        assert mb.needs_bridge("deepseek", Modality.VISION) is True
        assert mb.needs_bridge("claude", Modality.VISION) is False
        assert mb.needs_bridge("glm", Modality.AUDIO) is True
        assert mb.needs_bridge("chatgpt", Modality.AUDIO) is False
        assert mb.needs_bridge("deepseek", Modality.TEXT) is False

    def test_find_capable_provider(self):
        mb = ModalityBridge()
        capable = mb.find_capable_provider(["deepseek", "gemini", "glm"], Modality.VISION)
        assert capable == "gemini"


class TestDegradationManager:
    def test_with_degradation_primary_success(self):
        dm = DegradationManager()
        res = dm.with_degradation("test_feat", lambda: "success", lambda: "fallback", "default")
        assert res == "success"
        assert dm.level("test_feat") == DegradationLevel.FULL

    def test_with_degradation_fallback_on_primary_fail(self):
        dm = DegradationManager()
        def fail():
            raise RuntimeError("primary broke")
        res = dm.with_degradation("test_feat", fail, lambda: "fallback", "default")
        assert res == "fallback"
        assert dm.level("test_feat") == DegradationLevel.REDUCED

    def test_with_degradation_default_on_both_fail(self):
        dm = DegradationManager()
        def fail():
            raise RuntimeError("broke")
        res = dm.with_degradation("test_feat", fail, fail, "default")
        assert res == "default"
        assert dm.level("test_feat") == DegradationLevel.MINIMAL


class TestPipelineEngine:
    def test_pipeline_execution_general(self):
        engine = PipelineEngine()
        calls = []

        def mock_call(provider, prompt):
            calls.append((provider, prompt))
            if "reflect" in prompt.lower() or "accuracy" in prompt.lower():
                return json.dumps({"pass": True})
            return "Stage output"

        output, log = engine.run(
            task_type="general",
            input_text="Summarize python",
            call_fn=mock_call,
            available=["claude", "chatgpt"],
        )
        assert output == "Stage output"
        assert len(log) == 2

    def test_empty_available_providers(self):
        engine = PipelineEngine()
        output, log = engine.run(
            task_type="general",
            input_text="test",
            call_fn=lambda p, pr: "ok",
            available=[],
        )
        assert output == ""
        assert log == []


class TestRouterSelectionStrategies:
    def test_priority_selects_first(self):
        router = Router(strategy=RoutingStrategy.PRIORITY)
        assert router.select(["claude", "chatgpt", "gemini"]) == "claude"

    def test_round_robin_cycles_starting_at_first(self):
        router = Router(strategy=RoutingStrategy.ROUND_ROBIN)
        candidates = ["a", "b", "c"]
        assert router.select(candidates) == "a"
        assert router.select(candidates) == "b"
        assert router.select(candidates) == "c"
        assert router.select(candidates) == "a"

    def test_least_used_strategy(self):
        router = Router(strategy=RoutingStrategy.LEAST_USED)
        router.record_success("a")
        router.record_success("a")
        router.record_success("b")
        assert router.select(["a", "b", "c"]) == "c"

    def test_cost_optimized_strategy(self):
        router = Router(strategy=RoutingStrategy.COST_OPTIMIZED)
        # default pricing: glm and kimi are cheapest (0.01)
        selected = router.select(["claude", "chatgpt", "glm"])
        assert selected == "glm"

    def test_lkgp_strategy(self):
        router = Router(strategy=RoutingStrategy.LKGP)
        assert router.select(["a", "b"], task_type="coding") == "a"
        router.record_success("b", task_type="coding")
        assert router.select(["a", "b"], task_type="coding") == "b"

    def test_fusion_strategy_returns_all_candidates(self):
        router = Router(strategy=RoutingStrategy.FUSION)
        candidates = ["claude", "gemini"]
        assert router.select(candidates) == candidates

    def test_weighted_strategy(self):
        router = Router(strategy=RoutingStrategy.WEIGHTED)
        router.set_weights("heavy", 100.0)
        router.set_weights("light", 0.0)
        assert router.select(["heavy", "light"]) == "heavy"

    def test_auto_strategy_selects_best_tier(self):
        router = Router(strategy=RoutingStrategy.AUTO)
        health = {
            "claude": {"avg_latency": 0.2, "error_rate": 0.0, "success_rate": 1.0},
            "glm": {"avg_latency": 2.0, "error_rate": 0.5, "success_rate": 0.5},
        }
        selected = router.select(["glm", "claude"], health_stats=health, task_type="coding")
        assert selected == "claude"

    def test_breaker_filters_out_open_providers(self):
        router = Router(strategy=RoutingStrategy.PRIORITY)
        router.record_failure("claude", error_code=401)  # immediately opens breaker
        selected = router.select(["claude", "chatgpt"])
        assert selected == "chatgpt"

    def test_status_and_to_dict_serialization(self):
        router = Router(strategy=RoutingStrategy.AUTO)
        router.record_success("claude", tokens_in=100, tokens_out=200)
        st = router.status()
        assert st["strategy"] == "auto"
        assert "claude" in st["providers"]
        assert st["providers"]["claude"]["total_tokens"] == 300

        full = router.to_dict()
        assert full["strategy"] == "auto"
        assert "breakers" in full
        assert "quota" in full
        assert "costs" in full
