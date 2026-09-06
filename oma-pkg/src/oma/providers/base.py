"""
OMA Provider Layer -- unified interface for multiple LLM subscriptions.

Each provider wraps a subscription (Claude, Gemini, ChatGPT, DeepSeek, GLM, Kimi)
behind a common interface. The connector layer handles:
  - auth (api key or session cookie)
  - rate limiting per provider
  - token counting (provider-native or estimated)
  - response normalization
  - error classification (retryable vs fatal)

No provider gets special treatment. The loop picks them by availability and cost.
"""

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional
from enum import Enum


class ErrorClass(Enum):
    RETRYABLE = "retryable"       # rate limit, timeout, transient
    FATAL = "fatal"               # bad request, auth failure
    CAPACITY = "capacity"         # model overloaded, try another
    BUDGET = "budget"             # billing limit hit


@dataclass
class ProviderResponse:
    text: str
    tokens_in: int
    tokens_out: int
    model: str
    provider: str
    latency_ms: float
    raw: Any = None               # provider-specific payload
    error: Optional[str] = None
    error_class: Optional[ErrorClass] = None

    @property
    def tokens_total(self) -> int:
        return self.tokens_in + self.tokens_out

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass
class RateLimiter:
    requests_per_minute: int = 60
    tokens_per_minute: int = 100_000
    _request_times: list = field(default_factory=list)
    _token_counts: list = field(default_factory=list)

    def wait_if_needed(self, estimated_tokens: int = 0):
        now = time.time()
        cutoff = now - 60.0

        self._request_times = [t for t in self._request_times if t > cutoff]
        self._token_counts = [(t, c) for t, c in self._token_counts if t > cutoff]

        if len(self._request_times) >= self.requests_per_minute:
            wait = self._request_times[0] - cutoff
            if wait > 0:
                time.sleep(wait)

        token_sum = sum(c for _, c in self._token_counts)
        if token_sum + estimated_tokens > self.tokens_per_minute:
            wait = self._token_counts[0][0] - cutoff if self._token_counts else 1.0
            if wait > 0:
                time.sleep(max(wait, 0.5))

        self._request_times.append(time.time())

    def record_tokens(self, count: int):
        self._token_counts.append((time.time(), count))


class Provider(ABC):
    """Base class for all LLM providers."""

    name: str = "base"
    rate_limiter: RateLimiter

    # adaptive timeout: starts at base, increases on timeout errors, resets on success
    TIMEOUT_BASE: float = 180.0      # 3 min default (was 120)
    TIMEOUT_MAX: float = 600.0       # 10 min ceiling
    TIMEOUT_BACKOFF: float = 1.5     # multiply on timeout

    def __init__(self, api_key: Optional[str] = None, **kwargs):
        self.api_key = api_key
        self.rate_limiter = RateLimiter()
        self.config = kwargs
        self._current_timeout = self.TIMEOUT_BASE

    @property
    def timeout(self) -> float:
        """Current adaptive timeout in seconds."""
        return self._current_timeout

    def on_timeout(self):
        """Called after a timeout -- increase for next attempt."""
        self._current_timeout = min(
            self._current_timeout * self.TIMEOUT_BACKOFF,
            self.TIMEOUT_MAX,
        )

    def on_success(self):
        """Called after a success -- reset timeout to base."""
        self._current_timeout = self.TIMEOUT_BASE

    @abstractmethod
    def complete(
        self,
        messages: list[dict],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs,
    ) -> ProviderResponse:
        """Send a completion request. Returns normalized response."""
        ...

    @abstractmethod
    def count_tokens(self, text: str) -> int:
        """Estimate token count for text."""
        ...

    def classify_error(self, error: Exception) -> ErrorClass:
        """Classify an exception for retry logic."""
        msg = str(error).lower()
        # timeouts are retryable but we also bump the adaptive timeout
        if any(k in msg for k in ["timed out", "timeout", "deadline", "urlopen"]):
            self.on_timeout()
            return ErrorClass.RETRYABLE
        if any(k in msg for k in ["rate limit", "429", "too many"]):
            return ErrorClass.RETRYABLE
        if any(k in msg for k in ["overloaded", "503", "capacity"]):
            return ErrorClass.CAPACITY
        if any(k in msg for k in ["billing", "quota", "insufficient"]):
            return ErrorClass.BUDGET
        if any(k in msg for k in ["401", "403", "invalid key", "unauthorized"]):
            return ErrorClass.FATAL
        return ErrorClass.RETRYABLE  # default optimistic
