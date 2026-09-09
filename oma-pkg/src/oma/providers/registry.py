"""
OMA Provider Registry -- plug-and-play multi-subscription connector.

Register providers by name, look them up, chain them for fallback.
The registry also tracks health (success/fail rates) per provider
and reorders the chain dynamically.

Side-channel approach: no single provider's SDK is a hard dependency.
Each provider impl uses raw HTTP or optional SDK, imported lazily.
"""

import os
import time
from dataclasses import dataclass

from .base import ErrorClass, Provider


@dataclass
class ProviderHealth:
    name: str
    successes: int = 0
    failures: int = 0
    total_tokens: int = 0
    total_latency_ms: float = 0.0
    last_error: str | None = None
    last_error_class: ErrorClass | None = None
    last_success_at: float = 0.0
    cooldown_until: float = 0.0

    @property
    def success_rate(self) -> float:
        total = self.successes + self.failures
        return self.successes / total if total > 0 else 0.5  # prior

    @property
    def avg_latency_ms(self) -> float:
        return self.total_latency_ms / self.successes if self.successes > 0 else float("inf")

    @property
    def is_cooled_down(self) -> bool:
        return time.time() >= self.cooldown_until

    def record_success(self, tokens: int, latency_ms: float):
        self.successes += 1
        self.total_tokens += tokens
        self.total_latency_ms += latency_ms
        self.last_success_at = time.time()
        self.last_error = None

    def record_failure(self, error: str, error_class: ErrorClass):
        self.failures += 1
        self.last_error = error
        self.last_error_class = error_class
        # timeouts are retryable -- short cooldown, don't give up
        is_timeout = any(k in error.lower() for k in ["timeout", "timed out", "urlopen"])
        if is_timeout:
            self.cooldown_until = time.time() + 5.0
        elif error_class == ErrorClass.RETRYABLE:
            self.cooldown_until = time.time() + 10.0
        elif error_class == ErrorClass.CAPACITY:
            self.cooldown_until = time.time() + 30.0
        elif error_class == ErrorClass.BUDGET:
            self.cooldown_until = time.time() + 300.0
        elif error_class == ErrorClass.FATAL:
            self.cooldown_until = time.time() + 600.0


class ProviderRegistry:
    """
    Central registry for all providers.

    Usage:
        reg = ProviderRegistry()
        reg.register("claude", ClaudeProvider(api_key=...))
        reg.register("gemini", GeminiProvider(api_key=...))
        reg.register("chatgpt", ChatGPTProvider(api_key=...))

        # get best available provider
        provider = reg.best_available()

        # or get the fallback chain
        chain = reg.fallback_chain()
    """

    def __init__(self):
        self._providers: dict[str, Provider] = {}
        self._health: dict[str, ProviderHealth] = {}

    def register(self, name: str, provider: Provider) -> "ProviderRegistry":
        self._providers[name] = provider
        self._health[name] = ProviderHealth(name=name)
        return self

    def get(self, name: str) -> Provider | None:
        return self._providers.get(name)

    def health(self, name: str) -> ProviderHealth | None:
        return self._health.get(name)

    def available(self) -> list[str]:
        """Providers not in cooldown."""
        return [
            name for name, h in self._health.items()
            if h.is_cooled_down
        ]

    def best_available(self) -> str | None:
        """Pick the provider with best success rate * inverse latency, among available."""
        avail = self.available()
        if not avail:
            return None

        def score(name):
            h = self._health[name]
            # balance success rate and speed
            rate = h.success_rate
            speed = 1.0 / (h.avg_latency_ms + 1.0)
            return rate * 0.7 + speed * 0.3

        return max(avail, key=score)

    def fallback_chain(self) -> list[str]:
        """All available providers, ordered by score descending."""
        avail = self.available()

        def score(name):
            h = self._health[name]
            return h.success_rate * 0.7 + (1.0 / (h.avg_latency_ms + 1.0)) * 0.3

        return sorted(avail, key=score, reverse=True)

    def record_success(self, name: str, tokens: int, latency_ms: float):
        if name in self._health:
            self._health[name].record_success(tokens, latency_ms)

    def record_failure(self, name: str, error: str, error_class: ErrorClass):
        if name in self._health:
            self._health[name].record_failure(error, error_class)

    def status_report(self) -> dict:
        return {
            name: {
                "success_rate": f"{h.success_rate:.1%}",
                "avg_latency_ms": f"{h.avg_latency_ms:.0f}",
                "total_tokens": h.total_tokens,
                "in_cooldown": not h.is_cooled_down,
                "last_error": h.last_error,
            }
            for name, h in self._health.items()
        }

    @staticmethod
    def from_env(include_standard_env: bool = False) -> "ProviderRegistry":
        """
        Auto-discover providers from environment variables.
        Supports both API keys and sessional keys (cookies/tokens).
        Expects OMA_*_KEY variables, and optionally checks standard env vars.
        """
        from .auth import clean_token, detect_auth_type
        from .catalog import CATALOG

        reg = ProviderRegistry()
        # Every catalog entry declares its own OMA_*_KEY, so a new provider
        # becomes discoverable by being added to the catalog.
        oma_map = {
            entry.id: entry.key_env for entry in CATALOG.values() if entry.key_env
        }
        # Providers that predate OMA have a conventional variable of their own,
        # which is worth honouring when the caller opts in.
        std_map = {
            "claude":   ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
            "gemini":   ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            "chatgpt":  ["OPENAI_API_KEY"],
            "deepseek": ["DEEPSEEK_API_KEY"],
            "glm":      ["GLM_API_KEY", "ZHIPU_API_KEY"],
            "kimi":     ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
            "groq":     ["GROQ_API_KEY"],
            "cerebras": ["CEREBRAS_API_KEY"],
            "mistral":  ["MISTRAL_API_KEY"],
            "cohere":   ["COHERE_API_KEY"],
            "together": ["TOGETHER_API_KEY"],
            "openrouter": ["OPENROUTER_API_KEY"],
            "github":   ["GITHUB_TOKEN", "GITHUB_MODELS_TOKEN"],
            "huggingface": ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
            "nvidia":   ["NVIDIA_API_KEY"],
            "sambanova": ["SAMBANOVA_API_KEY"],
            "hyperbolic": ["HYPERBOLIC_API_KEY"],
            "deepinfra": ["DEEPINFRA_API_KEY"],
            "nebius":   ["NEBIUS_API_KEY"],
            "cloudflare": ["CLOUDFLARE_API_TOKEN"],
        }

        for name, env_var in oma_map.items():
            key = os.environ.get(env_var)
            if not key and include_standard_env:
                for alt in std_map.get(name, []):
                    val = os.environ.get(alt)
                    if val:
                        key = val
                        break

            if key:
                auth_type = detect_auth_type(name, key)
                cleaned = clean_token(name, key)
                if auth_type in ("cookie", "token"):
                    provider = _make_subscription_provider(name, cleaned, auth_type)
                else:
                    provider = _make_http_provider(name, cleaned)

                if provider:
                    reg.register(name, provider)

        return reg

    @staticmethod
    def from_credentials(auth_manager, include_env: bool = True) -> "ProviderRegistry":
        """
        Build registry from stored credentials (subscription login or API key).
        Optionally merges with environment variables for any missing providers.
        """
        reg = ProviderRegistry()
        creds = auth_manager.store.all_providers()

        for name, cred in creds.items():
            if cred.auth_type == "api_key":
                provider = _make_http_provider(name, cred.value)
            else:
                provider = _make_subscription_provider(name, cred.value, cred.auth_type)

            if provider:
                reg.register(name, provider)

        if include_env:
            env_reg = ProviderRegistry.from_env()
            for name, provider in env_reg._providers.items():
                if name not in reg._providers:
                    reg.register(name, provider)

        return reg


def _make_http_provider(name: str, api_key: str) -> Provider | None:
    """
    Factory: create a provider using raw HTTP (no SDK dependency).
    Each provider is just an endpoint + auth + response mapping.
    """
    from .http_providers import PROVIDER_CONFIGS, HTTPProvider

    config = PROVIDER_CONFIGS.get(name)
    if not config:
        return None

    return HTTPProvider(
        name=name,
        api_key=api_key,
        endpoint=config["endpoint"],
        model=config["default_model"],
        headers_fn=config["headers_fn"],
        body_fn=config["body_fn"],
        parse_fn=config["parse_fn"],
    )


def _make_subscription_provider(name: str, credential_value: str, auth_type: str) -> Provider | None:
    """
    Factory: create a subscription-based provider from stored credentials.
    Uses session cookies/tokens from browser login.
    """
    from .subscription import make_subscription_provider
    return make_subscription_provider(name, credential_value, auth_type)
