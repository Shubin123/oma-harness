"""
OmniRoute Bridge -- Connects OMA harness to a running OmniRoute gateway.

When OmniRoute is running locally (default: http://localhost:20128), this
bridge routes all OMA provider calls through it, inheriting OmniRoute's
full feature set:

  - 19+ routing strategies with auto-combo scoring
  - Three-layer circuit breaker with adaptive backoff
  - RTK + Caveman compression (15-95% token savings)
  - Quota-aware scheduling and budget enforcement
  - Vision/audio/video modality bridging
  - 352+ provider support with free-tier pooling
  - MCP server and A2A protocol support

Usage:
    from oma.core.omniroute_bridge import OmniRouteBridge

    bridge = OmniRouteBridge()  # auto-detects running instance
    if bridge.available:
        response = bridge.chat_completion(messages, model="auto")

    # Or configure OMA agent to route through OmniRoute:
    from oma import OMA
    agent = OMA.from_env(omniroute=True)

Zero external dependencies beyond stdlib.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

DEFAULT_BASE_URL = "http://localhost:20128"
OPENAI_V1 = "/v1"

# OmniRoute auto-routing model aliases
AUTO_MODELS = {
    "auto":         "auto",          # balanced LKGP
    "auto/coding":  "auto/coding",   # quality-first for dev
    "auto/fast":    "auto/fast",     # lowest latency
    "auto/cheap":   "auto/cheap",    # cost-first
    "auto/offline": "auto/offline",  # max quota headroom
    "auto/smart":   "auto/smart",    # quality + 10% exploration
}

# Maps OMA provider names to OmniRoute-compatible model prefixes
PROVIDER_MODEL_MAP = {
    "claude":   "anthropic/claude-sonnet-4-20250514",
    "chatgpt":  "openai/gpt-4o",
    "gemini":   "google/gemini-2.0-flash",
    "deepseek": "deepseek/deepseek-chat",
    "glm":      "zhipu/glm-4-flash",
    "kimi":     "moonshot/moonshot-v1-auto",
}


@dataclass
class OmniRouteConfig:
    """Configuration for OmniRoute bridge."""
    base_url: str = ""
    timeout_s: float = 120.0
    auto_model: str = "auto"
    stream: bool = False
    temperature: float = 0.7
    max_tokens: int = 4096
    # Pass-through headers for OmniRoute features
    extra_headers: dict[str, str] = field(default_factory=dict)


@dataclass
class BridgeResponse:
    """Normalized response from OmniRoute."""
    ok: bool = False
    text: str = ""
    model: str = ""
    provider: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    tokens_total: int = 0
    latency_ms: int = 0
    cost: float = 0.0
    error: str = ""
    error_code: int = 0
    raw: dict[str, Any] = field(default_factory=dict)


class OmniRouteBridge:
    """
    Thin HTTP bridge to a running OmniRoute instance.

    OmniRoute serves an OpenAI-compatible API at /v1/chat/completions.
    This bridge translates OMA's internal message format into that API
    and extracts routing metadata from the response headers.
    """

    def __init__(self, config: OmniRouteConfig | None = None) -> None:
        self.config = config or OmniRouteConfig()
        if not self.config.base_url:
            self.config.base_url = os.environ.get(
                "OMNIROUTE_URL", DEFAULT_BASE_URL
            )
        self._available: bool | None = None
        self._models_cache: list[str] | None = None
        self._models_cache_time: float = 0.0

    @property
    def available(self) -> bool:
        """Check if OmniRoute is running and reachable."""
        if self._available is not None:
            return self._available
        try:
            self._available = self._health_check()
        except Exception:
            self._available = False
        return self._available

    def _health_check(self) -> bool:
        """Ping OmniRoute to check availability."""
        try:
            url = f"{self.config.base_url}/v1/models"
            req = urllib.request.Request(url, method="GET")
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=5) as resp:
                return bool(resp.status == 200)
        except Exception:
            return False

    def list_models(self, force_refresh: bool = False) -> list[str]:
        """Fetch available models from OmniRoute's catalog."""
        now = time.time()
        if (
            not force_refresh
            and self._models_cache is not None
            and now - self._models_cache_time < 300
        ):
            return self._models_cache

        try:
            url = f"{self.config.base_url}/v1/models"
            req = urllib.request.Request(url, method="GET")
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                models = [m.get("id", "") for m in data.get("data", [])]
                self._models_cache = models
                self._models_cache_time = now
                return models
        except Exception:
            return []

    def chat_completion(
        self,
        messages: list[dict[str, str]],
        model: str | None = None,
        system: str = "",
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> BridgeResponse:
        """
        Send a chat completion request through OmniRoute.

        OmniRoute handles routing, fallback, compression, and all
        provider-specific translation internally.
        """
        url = f"{self.config.base_url}/v1/chat/completions"

        # build messages with system prompt
        full_messages = []
        if system:
            full_messages.append({"role": "system", "content": system})
        full_messages.extend(messages)

        payload = {
            "model": model or self.config.auto_model,
            "messages": full_messages,
            "temperature": temperature if temperature is not None else self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
            "stream": self.config.stream,
        }

        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")

        # add any extra headers (API keys, routing hints, etc.)
        for key, val in self.config.extra_headers.items():
            req.add_header(key, val)

        t0 = time.time()
        try:
            with urllib.request.urlopen(
                req, timeout=self.config.timeout_s
            ) as resp:
                raw_data = json.loads(resp.read().decode("utf-8"))
                latency = int((time.time() - t0) * 1000)

                # extract response
                choices = raw_data.get("choices", [])
                text = ""
                if choices:
                    msg = choices[0].get("message", {})
                    text = msg.get("content", "")

                usage = raw_data.get("usage", {})
                tokens_in = usage.get("prompt_tokens", 0)
                tokens_out = usage.get("completion_tokens", 0)

                # OmniRoute may include routing metadata in headers or body
                provider = raw_data.get("_omniroute_provider", "")
                cost = raw_data.get("_omniroute_cost", 0.0)

                return BridgeResponse(
                    ok=True,
                    text=text,
                    model=raw_data.get("model", model or ""),
                    provider=provider,
                    tokens_in=tokens_in,
                    tokens_out=tokens_out,
                    tokens_total=tokens_in + tokens_out,
                    latency_ms=latency,
                    cost=cost,
                    raw=raw_data,
                )

        except urllib.error.HTTPError as e:
            error_body = ""
            try:
                error_body = e.read().decode("utf-8")
            except Exception:
                pass
            return BridgeResponse(
                ok=False,
                error=error_body or str(e),
                error_code=e.code,
                latency_ms=int((time.time() - t0) * 1000),
            )
        except Exception as e:
            return BridgeResponse(
                ok=False,
                error=str(e),
                latency_ms=int((time.time() - t0) * 1000),
            )

    def resolve_model(self, oma_provider: str, prefer_auto: bool = True) -> str:
        """
        Map an OMA provider name to an OmniRoute model identifier.

        If prefer_auto is True and OmniRoute is available, returns the
        auto-routing model (lets OmniRoute pick the best provider).
        """
        if prefer_auto and self.available:
            return self.config.auto_model
        return PROVIDER_MODEL_MAP.get(oma_provider, f"{oma_provider}/default")

    def status(self) -> dict[str, Any]:
        """Get OmniRoute gateway status."""
        result = {
            "available": self.available,
            "base_url": self.config.base_url,
            "auto_model": self.config.auto_model,
        }

        if self.available:
            models = self.list_models()
            result["model_count"] = len(models)
            # count auto variants
            result["auto_variants"] = [
                m for m in models if m.startswith("auto")
            ]

        return result

    def get_analytics(self) -> dict[str, Any]:
        """
        Fetch analytics/telemetry from OmniRoute's dashboard API.
        Returns usage stats, cost breakdown, and provider health.
        """
        if not self.available:
            return {"error": "OmniRoute not available"}

        try:
            url = f"{self.config.base_url}/api/analytics"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                analytics: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
            return analytics
        except Exception as e:
            return {"error": str(e)}
