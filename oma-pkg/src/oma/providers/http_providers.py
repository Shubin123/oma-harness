"""
OMA HTTP Providers -- raw HTTP connectors for each subscription.

No SDK dependencies. Each provider is defined as:
  - endpoint URL
  - default model
  - headers builder
  - request body builder
  - response parser

This is the side-channel: we talk to every provider the same way,
using their public HTTP APIs directly.
"""

import json
import time
import urllib.request
import urllib.error
from typing import Any, Callable, Optional
from .base import Provider, ProviderResponse, ErrorClass, RateLimiter


class HTTPProvider(Provider):
    """Generic HTTP-based LLM provider."""

    def __init__(
        self,
        name: str,
        api_key: str,
        endpoint: str,
        model: str,
        headers_fn: Callable,
        body_fn: Callable,
        parse_fn: Callable,
        **kwargs,
    ):
        super().__init__(api_key=api_key, **kwargs)
        self.name = name
        self.endpoint = endpoint
        self.model = model
        self._headers_fn = headers_fn
        self._body_fn = body_fn
        self._parse_fn = parse_fn

    def complete(
        self,
        messages: list[dict],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs,
    ) -> ProviderResponse:
        self.rate_limiter.wait_if_needed(estimated_tokens=max_tokens)

        headers = self._headers_fn(self.api_key)
        body = self._body_fn(
            messages=messages,
            system=system,
            model=kwargs.get("model", self.model),
            max_tokens=max_tokens,
            temperature=temperature,
        )

        t0 = time.time()
        try:
            req = urllib.request.Request(
                self.endpoint,
                data=json.dumps(body).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = json.loads(resp.read().decode("utf-8"))

            latency = (time.time() - t0) * 1000
            result = self._parse_fn(raw)
            self.rate_limiter.record_tokens(result.tokens_total)
            self.on_success()

            return ProviderResponse(
                text=result.text,
                tokens_in=result.tokens_in,
                tokens_out=result.tokens_out,
                model=result.model or self.model,
                provider=self.name,
                latency_ms=latency,
                raw=raw,
            )

        except urllib.error.HTTPError as e:
            latency = (time.time() - t0) * 1000
            error_body = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
            return ProviderResponse(
                text="",
                tokens_in=0,
                tokens_out=0,
                model=self.model,
                provider=self.name,
                latency_ms=latency,
                error=f"HTTP {e.code}: {error_body[:500]}",
                error_class=self.classify_error(e),
            )

        except Exception as e:
            latency = (time.time() - t0) * 1000
            return ProviderResponse(
                text="",
                tokens_in=0,
                tokens_out=0,
                model=self.model,
                provider=self.name,
                latency_ms=latency,
                error=str(e),
                error_class=self.classify_error(e),
            )

    def count_tokens(self, text: str) -> int:
        # rough estimate: 1 token ~ 4 chars for most models
        return len(text) // 4


class _ParsedResponse:
    """Intermediate parsed response."""
    def __init__(self, text="", tokens_in=0, tokens_out=0, model=None):
        self.text = text
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out
        self.model = model
        self.tokens_total = tokens_in + tokens_out


# ---- provider configs ----

def _claude_headers(api_key):
    return {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }

def _claude_body(messages, system, model, max_tokens, temperature):
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    }
    if system:
        body["system"] = system
    return body

def _claude_parse(raw):
    content = raw.get("content", [{}])
    text = content[0].get("text", "") if content else ""
    usage = raw.get("usage", {})
    return _ParsedResponse(
        text=text,
        tokens_in=usage.get("input_tokens", 0),
        tokens_out=usage.get("output_tokens", 0),
        model=raw.get("model"),
    )


def _openai_headers(api_key):
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

def _openai_body(messages, system, model, max_tokens, temperature):
    msgs = list(messages)
    if system:
        msgs.insert(0, {"role": "system", "content": system})
    return {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": msgs,
    }

def _openai_parse(raw):
    choices = raw.get("choices", [{}])
    text = choices[0].get("message", {}).get("content", "") if choices else ""
    usage = raw.get("usage", {})
    return _ParsedResponse(
        text=text,
        tokens_in=usage.get("prompt_tokens", 0),
        tokens_out=usage.get("completion_tokens", 0),
        model=raw.get("model"),
    )


def _gemini_headers(api_key):
    return {"Content-Type": "application/json"}

def _gemini_body(messages, system, model, max_tokens, temperature):
    contents = []
    for m in messages:
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    body = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
        },
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    return body

def _gemini_parse(raw):
    candidates = raw.get("candidates", [{}])
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = parts[0].get("text", "") if parts else ""
    usage = raw.get("usageMetadata", {})
    return _ParsedResponse(
        text=text,
        tokens_in=usage.get("promptTokenCount", 0),
        tokens_out=usage.get("candidatesTokenCount", 0),
    )


def _deepseek_headers(api_key):
    return _openai_headers(api_key)  # openai-compatible

def _deepseek_body(messages, system, model, max_tokens, temperature):
    return _openai_body(messages, system, model, max_tokens, temperature)

def _deepseek_parse(raw):
    return _openai_parse(raw)  # openai-compatible


# GLM (Zhipu) and Kimi (Moonshot) also use OpenAI-compatible APIs

PROVIDER_CONFIGS = {
    "claude": {
        "endpoint": "https://api.anthropic.com/v1/messages",
        "default_model": "claude-sonnet-4-20250514",
        "headers_fn": _claude_headers,
        "body_fn": _claude_body,
        "parse_fn": _claude_parse,
    },
    "chatgpt": {
        "endpoint": "https://api.openai.com/v1/chat/completions",
        "default_model": "gpt-4o",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "gemini": {
        # api key appended as query param at call time
        "endpoint": "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        "default_model": "gemini-2.0-flash",
        "headers_fn": _gemini_headers,
        "body_fn": _gemini_body,
        "parse_fn": _gemini_parse,
    },
    "deepseek": {
        "endpoint": "https://api.deepseek.com/chat/completions",
        "default_model": "deepseek-chat",
        "headers_fn": _deepseek_headers,
        "body_fn": _deepseek_body,
        "parse_fn": _deepseek_parse,
    },
    "glm": {
        "endpoint": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "default_model": "glm-4-flash",
        "headers_fn": _openai_headers,  # openai-compatible
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "kimi": {
        "endpoint": "https://api.moonshot.cn/v1/chat/completions",
        "default_model": "moonshot-v1-8k",
        "headers_fn": _openai_headers,  # openai-compatible
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
}
