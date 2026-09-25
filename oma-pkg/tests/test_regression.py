"""
Regression tests verifying fixes for latent bugs discovered across OMA.
"""

import json
from unittest.mock import MagicMock, patch
from urllib.request import Request, urlopen

import pytest

from oma.agent import OMA
from oma.core.criteria import Criterion, CriterionType
from oma.core.loop import Lesson, LoopConfig, PlanDecision, RalphLoop, Strategy, TaskState
from oma.core.router import (
    BreakerState,
    CircuitBreaker,
    PipelineEngine,
    PipelineStage,
    QuotaManager,
    Router,
    RoutingStrategy,
)
from oma.core.sanitize import Sanitizer
from oma.gui.web import DashboardHandler
from oma.providers.base import ProviderResponse
from oma.providers.http_providers import HTTPProvider, PROVIDER_CONFIGS
from oma.providers.registry import ProviderRegistry


def test_regression_double_plan_effects():
    """
    Bug 1: plan_fn duplicated consecutive_failures increment and approach notes
    that RalphLoop._apply_plan_effects also applied.
    Verify failure count increments by exactly 1 per failure.
    """
    reg = ProviderRegistry()
    dummy = MagicMock()
    dummy.complete.return_value = ProviderResponse(
        text="", tokens_in=0, tokens_out=0, model="m", provider="p", latency_ms=0, error="err"
    )
    reg.register("p", dummy)

    agent = OMA(
        registry=reg,
        config=LoopConfig(
            provider_chain=["p"],
            max_attempts=5,
            confidence_threshold=0.8,
            backoff_base_s=0.001,
        ),
    )

    # Run agent where all attempts fail
    state = agent.run("Failing task")

    # With max_attempts=5, consecutive_failures reaching 3 causes park at attempt 3
    assert state.attempts == 3
    assert state.status.value == "parked"


def test_regression_gemini_endpoint_formatting():
    """
    Bug 2: GeminiProvider endpoint did not format {model} and append ?key={api_key}.
    """
    cfg = PROVIDER_CONFIGS["gemini"]
    provider = HTTPProvider(
        name="gemini",
        api_key="test_api_key_123",
        endpoint=cfg["endpoint"],
        model=cfg["default_model"],
        headers_fn=cfg["headers_fn"],
        body_fn=cfg["body_fn"],
        parse_fn=cfg["parse_fn"],
    )
    captured_urls = []

    def mock_urlopen(req, timeout=None):
        captured_urls.append(req.full_url)
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "candidates": [{"content": {"parts": [{"text": "Gemini response"}]}}]
        }).encode()
        mock_resp.__enter__.return_value = mock_resp
        return mock_resp

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        resp = provider.complete(
            messages=[{"role": "user", "content": "hi"}],
            model="gemini-2.0-flash",
        )
        assert resp.ok is True
        assert len(captured_urls) == 1
        assert "models/gemini-2.0-flash:generateContent?key=test_api_key_123" in captured_urls[0]


def test_regression_web_test_history_empty_response(tmp_path):
    """
    Bug 3: /api/test/history hung when runs.json did not exist.
    """
    from http.server import HTTPServer
    import threading

    server = HTTPServer(("127.0.0.1", 0), DashboardHandler)
    host, port = server.server_address
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    try:
        with urlopen(f"http://{host}:{port}/api/test/history", timeout=3) as resp:
            assert resp.status == 200
            data = json.loads(resp.read().decode())
            assert "runs" in data
            assert isinstance(data["runs"], list)
    finally:
        server.shutdown()
        server.server_close()


def test_regression_criteria_extraction_in_confidence():
    """
    Bug 4: Criteria matching looked only at top-level keys, missing criterion names
    when criteria dict was serialized from default_criteria().to_dict().
    """
    reg = ProviderRegistry()
    agent = OMA(registry=reg)

    criteria_dict = {
        "criteria": [
            {"name": "latency_check", "type": "threshold", "target": 100},
            {"name": "correctness", "type": "binary", "target": True},
        ]
    }

    # Output containing the criteria names should get a confidence boost
    conf_with_matches = agent._estimate_confidence("The latency_check is good and correctness is verified.", criteria_dict)
    conf_without_matches = agent._estimate_confidence("Unrelated output here with nothing relevant.", criteria_dict)

    assert conf_with_matches > conf_without_matches
    assert conf_with_matches >= 0.65


def test_regression_round_robin_index_zero():
    """
    Bug 5: Round-robin incremented counter before selecting, skipping index 0 on first call.
    """
    router = Router(strategy=RoutingStrategy.ROUND_ROBIN)
    candidates = ["alpha", "beta", "gamma"]

    c1 = router.select(candidates)
    c2 = router.select(candidates)
    c3 = router.select(candidates)
    c4 = router.select(candidates)

    assert c1 == "alpha"
    assert c2 == "beta"
    assert c3 == "gamma"
    assert c4 == "alpha"


def test_regression_pipeline_empty_available():
    """
    Bug 6: PipelineEngine.run crashed when available list was empty.
    """
    engine = PipelineEngine()
    res, stages = engine.run(
        task_type="general",
        input_text="Do something",
        call_fn=lambda p, t: "output",
        available=[],
    )
    assert res == ""
    assert stages == []


def test_regression_threshold_criterion_bounds_and_zero_target():
    """
    Bug 7: Threshold criterion negative actual and zero target handled cleanly, clamped [0.0, 1.0].
    """
    c_zero = Criterion(name="zero_target", description="zero target", ctype=CriterionType.THRESHOLD, target=0.0)
    score_zero = c_zero.evaluate(0)
    assert score_zero == 1.0

    score_neg_zero = c_zero.evaluate(-10)
    assert score_neg_zero == 0.0

    c_norm = Criterion(name="norm", description="norm 100", ctype=CriterionType.THRESHOLD, target=100.0)
    score_neg = c_norm.evaluate(-50.0)
    assert score_neg == 0.0

    score_excess = c_norm.evaluate(200.0)
    assert score_excess == 1.0


def test_regression_circuit_breaker_half_open_failure():
    """
    Bug 9: Circuit breaker in HALF_OPEN did not immediately reopen on failure.
    """
    cb = CircuitBreaker(failure_threshold=5, recovery_timeout_s=0.01)
    cb.state = BreakerState.HALF_OPEN
    cb.failure_count = 0

    # Probe failed in HALF_OPEN
    cb.record_failure()

    # Must immediately transition back to OPEN
    assert cb.state == BreakerState.OPEN


def test_regression_quota_remaining_pct_exhausted():
    """
    Bug 10: QuotaManager returned 1.0 (100%) for exhausted provider with total=0.
    """
    qm = QuotaManager()
    qm.mark_exhausted("test_prov")

    pct = qm.remaining_pct("test_prov")
    assert pct == 0.0


def test_regression_sanitizer_curly_quotes():
    """
    Bug 8: Verify sanitizer strips Anthropic headers with both curly and straight quotes.
    """
    s = Sanitizer()
    text1 = "Anthropic's Claude generated this solution.\nHere is your solution."
    text2 = "Anthropic’s Claude generated this solution.\nHere is your solution."
    text3 = "I'm Claude, here to assist.\nHere is your solution."
    text4 = "I’m Claude, here to assist.\nHere is your solution."

    clean1 = s(text1)
    clean2 = s(text2)
    clean3 = s(text3)
    clean4 = s(text4)

    assert "Claude" not in clean1
    assert "Claude" not in clean2
    assert "Claude" not in clean3
    assert "Claude" not in clean4
    assert "Here is your solution." in clean1
    assert "Here is your solution." in clean2
    assert "Here is your solution." in clean3
    assert "Here is your solution." in clean4
