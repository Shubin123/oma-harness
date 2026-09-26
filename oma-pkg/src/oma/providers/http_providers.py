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
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any, TypedDict

from .base import Provider, ProviderResponse


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
        system: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs,
    ) -> ProviderResponse:
        self.rate_limiter.wait_if_needed(estimated_tokens=max_tokens)

        headers = self._headers_fn(self.api_key)
        model = kwargs.get("model", self.model)
        body = self._body_fn(
            messages=messages,
            system=system,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
        )

        endpoint = self.endpoint
        if "{model}" in endpoint:
            endpoint = endpoint.replace("{model}", model)
        if self.name == "gemini" and self.api_key and "key=" not in endpoint:
            separator = "&" if "?" in endpoint else "?"
            endpoint = f"{endpoint}{separator}key={self.api_key}"

        t0 = time.time()
        try:
            req = urllib.request.Request(
                endpoint,
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


def _openai_responses_body(messages, system, model, max_tokens, temperature):
    """Build a stateless request for OpenAI's Responses API.

    ``temperature`` is intentionally not sent: current GPT reasoning models
    reject it unless reasoning is disabled.  OMA owns conversation state, so
    provider-side storage is also disabled explicitly.
    """
    body = {
        "model": model,
        "input": list(messages),
        "max_output_tokens": max_tokens,
        "store": False,
    }
    if system:
        body["instructions"] = system
    return body


def _openai_responses_parse(raw):
    """Extract text and usage from a non-streaming Responses API result."""
    text_parts = []
    for item in raw.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                text_parts.append(content["text"])

    usage = raw.get("usage", {})
    return _ParsedResponse(
        text="".join(text_parts),
        tokens_in=usage.get("input_tokens", 0),
        tokens_out=usage.get("output_tokens", 0),
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


def _optional_bearer_headers(api_key):
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


# Jev, Groq, Mistral, Ollama, OpenRouter, Together, Qwen, GLM, and Kimi use OpenAI-compatible APIs

class ProviderConfig(TypedDict):
    """Everything needed to talk to one provider over raw HTTP."""

    endpoint: str
    default_model: str
    headers_fn: Callable[..., Any]
    body_fn: Callable[..., Any]
    parse_fn: Callable[..., Any]


PROVIDER_CONFIGS: dict[str, ProviderConfig] = {
    "claude": {
        "endpoint": "https://api.anthropic.com/v1/messages",
        "default_model": "claude-sonnet-4-20250514",
        "headers_fn": _claude_headers,
        "body_fn": _claude_body,
        "parse_fn": _claude_parse,
    },
    "chatgpt": {
        # OpenAI recommends Responses for new integrations.  The other
        # OpenAI-compatible providers below intentionally retain their Chat
        # Completions protocol.
        "endpoint": "https://api.openai.com/v1/responses",
        "default_model": "gpt-5.4",
        "headers_fn": _openai_headers,
        "body_fn": _openai_responses_body,
        "parse_fn": _openai_responses_parse,
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
    "jev": {
        # TypeSafe AI Jev (System 1 fast decision, judging, and routing model)
        "endpoint": "https://api.typesafe.ai/v1/chat/completions",
        "default_model": "typesafe/jev",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "laya": {
        # Convai Innovations Laya (System 1 fast local decision & classifier model)
        "endpoint": "http://127.0.0.1:8385/v1/chat/completions",
        "default_model": "convaiinnovations/laya",
        "headers_fn": _optional_bearer_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "groq": {
        "endpoint": "https://api.groq.com/openai/v1/chat/completions",
        "default_model": "llama-3.3-70b-versatile",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "mistral": {
        "endpoint": "https://api.mistral.ai/v1/chat/completions",
        "default_model": "mistral-small-latest",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "openrouter": {
        "endpoint": "https://openrouter.ai/api/v1/chat/completions",
        "default_model": "typesafe/jev",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "ollama": {
        "endpoint": "http://localhost:11434/v1/chat/completions",
        "default_model": "llama3",
        "headers_fn": _optional_bearer_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "together": {
        "endpoint": "https://api.together.xyz/v1/chat/completions",
        "default_model": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "qwen": {
        "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "default_model": "qwen-plus",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "glm": {
        "endpoint": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "default_model": "glm-4-flash",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
    "kimi": {
        "endpoint": "https://api.moonshot.cn/v1/chat/completions",
        "default_model": "moonshot-v1-8k",
        "headers_fn": _openai_headers,
        "body_fn": _openai_body,
        "parse_fn": _openai_parse,
    },
}
