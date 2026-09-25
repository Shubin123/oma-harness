"""Tests for the OmniRoute bridge connector."""

import json
from unittest.mock import MagicMock, patch
import urllib.error
import pytest

from oma.core.omniroute_bridge import (
    BridgeResponse,
    OmniRouteBridge,
    OmniRouteConfig,
)

pytestmark = pytest.mark.unit


class TestOmniRouteConfig:
    def test_default_config(self):
        cfg = OmniRouteConfig()
        assert cfg.auto_model == "auto"
        assert cfg.timeout_s == 120.0
        assert cfg.temperature == 0.7
        assert cfg.max_tokens == 4096
        assert cfg.stream is False

    def test_env_var_base_url(self, monkeypatch):
        monkeypatch.setenv("OMNIROUTE_URL", "http://gateway.test:8000")
        bridge = OmniRouteBridge()
        assert bridge.config.base_url == "http://gateway.test:8000"


class TestOmniRouteBridgeHealth:
    def test_available_when_models_200(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__.return_value = mock_resp

        with patch("urllib.request.urlopen", return_value=mock_resp):
            assert bridge.available is True

    def test_unavailable_when_connection_fails(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("Connection refused")):
            assert bridge.available is False


class TestOmniRouteBridgeModels:
    def test_list_models_success(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        data = {
            "data": [
                {"id": "auto"},
                {"id": "anthropic/claude-3-5-sonnet"},
                {"id": "openai/gpt-4o"},
            ]
        }
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = json.dumps(data).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp

        with patch("urllib.request.urlopen", return_value=mock_resp):
            models = bridge.list_models()
            assert "auto" in models
            assert "anthropic/claude-3-5-sonnet" in models

            # test caching: urlopen should not be called again
            with patch("urllib.request.urlopen", side_effect=AssertionError("Should use cache")):
                cached = bridge.list_models()
                assert cached == models

    def test_list_models_force_refresh(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        data = {"data": [{"id": "model-v1"}]}
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(data).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp

        with patch("urllib.request.urlopen", return_value=mock_resp):
            bridge.list_models()

        data2 = {"data": [{"id": "model-v2"}]}
        mock_resp2 = MagicMock()
        mock_resp2.read.return_value = json.dumps(data2).encode("utf-8")
        mock_resp2.__enter__.return_value = mock_resp2

        with patch("urllib.request.urlopen", return_value=mock_resp2):
            refreshed = bridge.list_models(force_refresh=True)
            assert refreshed == ["model-v2"]


class TestOmniRouteChatCompletion:
    def test_chat_completion_success(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        response_payload = {
            "id": "chatcmpl-123",
            "model": "auto/coding",
            "_omniroute_provider": "anthropic",
            "_omniroute_cost": 0.0042,
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Hello from OmniRoute!",
                }
            }],
            "usage": {
                "prompt_tokens": 15,
                "completion_tokens": 8,
            },
        }

        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(response_payload).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp

        with patch("urllib.request.urlopen", return_value=mock_resp):
            resp = bridge.chat_completion(
                messages=[{"role": "user", "content": "Hi"}],
                system="Be concise",
                model="auto",
            )
            assert resp.ok is True
            assert resp.text == "Hello from OmniRoute!"
            assert resp.provider == "anthropic"
            assert resp.cost == pytest.approx(0.0042)
            assert resp.tokens_in == 15
            assert resp.tokens_out == 8
            assert resp.tokens_total == 23

    def test_chat_completion_http_error(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        err = urllib.error.HTTPError(
            url="http://test.local/v1/chat/completions",
            code=401,
            msg="Unauthorized",
            hdrs={},
            fp=MagicMock(read=lambda: b'{"error":"invalid token"}'),
        )

        with patch("urllib.request.urlopen", side_effect=err):
            resp = bridge.chat_completion(messages=[{"role": "user", "content": "hi"}])
            assert resp.ok is False
            assert resp.error_code == 401
            assert "invalid token" in resp.error

    def test_chat_completion_network_error(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("Timeout")):
            resp = bridge.chat_completion(messages=[{"role": "user", "content": "hi"}])
            assert resp.ok is False
            assert "Timeout" in resp.error


class TestOmniRouteModelResolutionAndStatus:
    def test_resolve_model_prefer_auto(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        bridge._available = True
        assert bridge.resolve_model("claude", prefer_auto=True) == "auto"

    def test_resolve_model_direct_mapping(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        bridge._available = False
        assert bridge.resolve_model("claude", prefer_auto=False) == "anthropic/claude-sonnet-4-20250514"
        assert bridge.resolve_model("unknown", prefer_auto=False) == "unknown/default"

    def test_status_when_available(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        bridge._available = True
        bridge._models_cache = ["auto", "auto/coding", "deepseek/chat"]
        bridge._models_cache_time = 99999999999.0

        st = bridge.status()
        assert st["available"] is True
        assert st["model_count"] == 3
        assert "auto/coding" in st["auto_variants"]

    def test_analytics_fetch(self):
        bridge = OmniRouteBridge(OmniRouteConfig(base_url="http://test.local"))
        bridge._available = True
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"requests": 42, "total_cost": 1.25}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp

        with patch("urllib.request.urlopen", return_value=mock_resp):
            analytics = bridge.get_analytics()
            assert analytics["requests"] == 42
