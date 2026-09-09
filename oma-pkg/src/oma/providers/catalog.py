"""
The provider catalog -- every provider OMA can talk to, and what it costs.

One table describes each provider: where to sign up, which environment
variable carries the key, the endpoint, the API dialect, and -- the part the
router cares about -- which *tier* it belongs to. Tiers are what let a task
run on free capacity until the free capacity runs out, then step up.

Model identifiers drift faster than anything else here (providers retire model
names on their own schedule), so an entry carries a list of candidates rather
than a single pinned name. `resolve_model` asks the provider which models it
actually serves and picks the first candidate that is still live, falling back
to the pinned default when a provider does not publish a catalog.

Nothing in this module makes a network call at import time.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from enum import Enum


class Tier(Enum):
    """
    What a provider costs to use, cheapest first.

    The order matters: the router walks tiers in this sequence, so a task
    exhausts local and free capacity before it spends anything.
    """

    LOCAL = "local"              # runs on this machine, costs nothing
    FREE = "free"                # free forever within published rate limits
    FREEMIUM = "freemium"        # free allowance, then billed
    SUBSCRIPTION = "subscription"  # covered by a flat monthly plan
    PAID = "paid"                # billed per token

    @property
    def rank(self) -> int:
        return _TIER_ORDER.index(self)


_TIER_ORDER = [Tier.LOCAL, Tier.FREE, Tier.FREEMIUM, Tier.SUBSCRIPTION, Tier.PAID]


class ApiStyle(Enum):
    """The request/response dialect a provider speaks."""

    OPENAI = "openai"        # /chat/completions, the de-facto standard
    ANTHROPIC = "anthropic"  # /v1/messages
    GEMINI = "gemini"        # :generateContent


@dataclass
class FreeTier:
    """What a provider gives away, in the provider's own units."""

    summary: str
    requests_per_day: int | None = None
    requests_per_minute: int | None = None
    tokens_per_minute: int | None = None
    credit_usd: float | None = None
    expires: str | None = None  # e.g. "30 days" for trial credit

    def to_dict(self) -> dict:
        return {
            "summary": self.summary,
            "requests_per_day": self.requests_per_day,
            "requests_per_minute": self.requests_per_minute,
            "tokens_per_minute": self.tokens_per_minute,
            "credit_usd": self.credit_usd,
            "expires": self.expires,
        }


@dataclass
class ProviderEntry:
    """Everything OMA needs to know about one provider."""

    id: str
    label: str
    tier: Tier
    api_style: ApiStyle
    base_url: str
    default_model: str
    signup_url: str = ""
    docs_url: str = ""
    key_env: str = ""
    models_path: str = "/models"
    model_candidates: list[str] = field(default_factory=list)
    free_tier: FreeTier | None = None
    # Placeholders in base_url that the user has to supply, beyond the API key
    # (Cloudflare, for one, puts an account id in the path).
    extra_fields: list[str] = field(default_factory=list)
    needs_key: bool = True
    notes: str = ""

    @property
    def chat_endpoint(self) -> str:
        if self.api_style is ApiStyle.ANTHROPIC:
            return f"{self.base_url}/messages"
        if self.api_style is ApiStyle.GEMINI:
            return f"{self.base_url}/models/{{model}}:generateContent"
        return f"{self.base_url}/chat/completions"

    @property
    def models_endpoint(self) -> str:
        return f"{self.base_url}{self.models_path}"

    @property
    def is_free(self) -> bool:
        return self.tier in (Tier.LOCAL, Tier.FREE, Tier.FREEMIUM)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "tier": self.tier.value,
            "api_style": self.api_style.value,
            "endpoint": self.chat_endpoint,
            "default_model": self.default_model,
            "signup_url": self.signup_url,
            "docs_url": self.docs_url,
            "key_env": self.key_env,
            "free_tier": self.free_tier.to_dict() if self.free_tier else None,
            "extra_fields": list(self.extra_fields),
            "needs_key": self.needs_key,
            "notes": self.notes,
        }


def _entry(**kwargs) -> ProviderEntry:
    entry = ProviderEntry(**kwargs)
    if not entry.key_env and entry.needs_key:
        entry.key_env = f"OMA_{entry.id.upper()}_KEY"
    return entry


# --- the catalog ------------------------------------------------------------
#
# Ordered roughly by how much a first-time user gets for nothing. Endpoints are
# stable; model names are candidates, resolved against each provider's live
# catalog at call time.

CATALOG: dict[str, ProviderEntry] = {entry.id: entry for entry in [
    # -- local: no account, no key, no network --
    _entry(
        id="ollama", label="Ollama (local)", tier=Tier.LOCAL,
        api_style=ApiStyle.OPENAI, base_url="http://localhost:11434/v1",
        default_model="llama3.2", needs_key=False,
        signup_url="https://ollama.com/download",
        docs_url="https://github.com/ollama/ollama/blob/main/docs/openai.md",
        model_candidates=["llama3.2", "llama3.1", "qwen2.5", "mistral", "phi3"],
        free_tier=FreeTier(summary="Unlimited, runs on your own hardware"),
        notes="Start it with `ollama serve`, then pull a model.",
    ),
    _entry(
        id="lmstudio", label="LM Studio (local)", tier=Tier.LOCAL,
        api_style=ApiStyle.OPENAI, base_url="http://localhost:1234/v1",
        default_model="local-model", needs_key=False,
        signup_url="https://lmstudio.ai/",
        docs_url="https://lmstudio.ai/docs/api/openai-api",
        free_tier=FreeTier(summary="Unlimited, runs on your own hardware"),
        notes="Enable the local server from the Developer tab.",
    ),

    # -- free tiers: an account, a key, no card --
    _entry(
        id="groq", label="Groq", tier=Tier.FREE,
        api_style=ApiStyle.OPENAI, base_url="https://api.groq.com/openai/v1",
        default_model="llama-3.3-70b-versatile",
        signup_url="https://console.groq.com/keys",
        docs_url="https://console.groq.com/docs/openai",
        model_candidates=[
            "llama-3.3-70b-versatile", "llama-3.1-8b-instant",
            "openai/gpt-oss-120b", "qwen/qwen3-32b",
        ],
        free_tier=FreeTier(
            summary="Free tier with per-model daily request and token limits",
            requests_per_minute=30, requests_per_day=14400,
        ),
    ),
    _entry(
        id="cerebras", label="Cerebras", tier=Tier.FREE,
        api_style=ApiStyle.OPENAI, base_url="https://api.cerebras.ai/v1",
        default_model="llama-3.3-70b",
        signup_url="https://cloud.cerebras.ai/",
        docs_url="https://inference-docs.cerebras.ai/api-reference/chat-completions",
        model_candidates=[
            "llama-3.3-70b", "llama3.1-8b", "qwen-3-32b", "gpt-oss-120b",
        ],
        free_tier=FreeTier(
            summary="Free tier, roughly a million tokens a day",
            requests_per_minute=30, tokens_per_minute=60000,
        ),
    ),
    _entry(
        id="gemini", label="Google AI Studio (Gemini)", tier=Tier.FREE,
        api_style=ApiStyle.GEMINI,
        base_url="https://generativelanguage.googleapis.com/v1beta",
        default_model="gemini-2.0-flash",
        signup_url="https://aistudio.google.com/apikey",
        docs_url="https://ai.google.dev/gemini-api/docs",
        model_candidates=[
            "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash",
        ],
        free_tier=FreeTier(
            summary="Free tier on Flash models",
            requests_per_minute=15, requests_per_day=1500,
        ),
    ),
    _entry(
        id="openrouter", label="OpenRouter", tier=Tier.FREE,
        api_style=ApiStyle.OPENAI, base_url="https://openrouter.ai/api/v1",
        default_model="meta-llama/llama-3.3-70b-instruct:free",
        signup_url="https://openrouter.ai/keys",
        docs_url="https://openrouter.ai/docs/quickstart",
        model_candidates=[
            "meta-llama/llama-3.3-70b-instruct:free",
            "google/gemma-2-9b-it:free",
            "mistralai/mistral-7b-instruct:free",
        ],
        free_tier=FreeTier(
            summary="Models tagged :free, shared daily quota",
            requests_per_day=50,
        ),
        notes="One key reaches hundreds of models; the :free variants cost nothing.",
    ),
    _entry(
        id="github", label="GitHub Models", tier=Tier.FREE,
        api_style=ApiStyle.OPENAI, base_url="https://models.github.ai/inference",
        default_model="openai/gpt-4o-mini",
        signup_url="https://github.com/settings/tokens",
        docs_url="https://docs.github.com/en/github-models",
        model_candidates=["openai/gpt-4o-mini", "openai/gpt-4o", "meta/Llama-3.3-70B-Instruct"],
        free_tier=FreeTier(
            summary="Free for GitHub accounts, rate limited by tier",
            requests_per_day=150,
        ),
        notes="Authenticate with a fine-grained PAT that has the models:read scope.",
    ),
    _entry(
        id="cloudflare", label="Cloudflare Workers AI", tier=Tier.FREE,
        api_style=ApiStyle.OPENAI,
        base_url="https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
        default_model="@cf/meta/llama-3.1-8b-instruct",
        signup_url="https://dash.cloudflare.com/profile/api-tokens",
        docs_url="https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/",
        extra_fields=["account_id"],
        model_candidates=[
            "@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        ],
        free_tier=FreeTier(summary="10,000 neurons a day at no cost"),
    ),

    # -- freemium: free allowance, then billed --
    _entry(
        id="mistral", label="Mistral", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://api.mistral.ai/v1",
        default_model="mistral-small-latest",
        signup_url="https://console.mistral.ai/api-keys",
        docs_url="https://docs.mistral.ai/api/",
        model_candidates=[
            "mistral-small-latest", "open-mistral-nemo", "mistral-large-latest",
        ],
        free_tier=FreeTier(summary="Free experiment tier after phone verification",
                           requests_per_minute=60),
    ),
    _entry(
        id="cohere", label="Cohere", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI,
        base_url="https://api.cohere.ai/compatibility/v1",
        default_model="command-r-08-2024",
        signup_url="https://dashboard.cohere.com/api-keys",
        docs_url="https://docs.cohere.com/docs/compatibility-api",
        model_candidates=["command-r-08-2024", "command-r-plus-08-2024", "command-a-03-2025"],
        free_tier=FreeTier(summary="Trial keys are free and rate limited",
                           requests_per_minute=20, requests_per_day=1000),
    ),
    _entry(
        id="nvidia", label="NVIDIA NIM", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://integrate.api.nvidia.com/v1",
        default_model="meta/llama-3.3-70b-instruct",
        signup_url="https://build.nvidia.com/explore/discover",
        docs_url="https://docs.api.nvidia.com/nim/reference/llm-apis",
        model_candidates=[
            "meta/llama-3.3-70b-instruct", "meta/llama-3.1-8b-instruct",
            "nvidia/llama-3.1-nemotron-70b-instruct",
        ],
        free_tier=FreeTier(summary="Free API credits on signup", credit_usd=0.0),
    ),
    _entry(
        id="sambanova", label="SambaNova", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://api.sambanova.ai/v1",
        default_model="Meta-Llama-3.3-70B-Instruct",
        signup_url="https://cloud.sambanova.ai/apis",
        docs_url="https://docs.sambanova.ai/cloud/docs/get-started/overview",
        model_candidates=["Meta-Llama-3.3-70B-Instruct", "Meta-Llama-3.1-8B-Instruct"],
        free_tier=FreeTier(summary="Free tier with per-minute limits",
                           requests_per_minute=20),
    ),
    _entry(
        id="huggingface", label="Hugging Face Inference", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://router.huggingface.co/v1",
        default_model="meta-llama/Llama-3.3-70B-Instruct",
        signup_url="https://huggingface.co/settings/tokens",
        docs_url="https://huggingface.co/docs/inference-providers/index",
        model_candidates=[
            "meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-7B-Instruct",
        ],
        free_tier=FreeTier(summary="Monthly inference credits on a free account"),
    ),
    _entry(
        id="together", label="Together AI", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://api.together.xyz/v1",
        default_model="meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
        signup_url="https://api.together.ai/settings/api-keys",
        docs_url="https://docs.together.ai/docs/openai-api-compatibility",
        model_candidates=[
            "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
            "meta-llama/Llama-Vision-Free",
        ],
        free_tier=FreeTier(summary="Signup credit, plus models suffixed -Free",
                           credit_usd=1.0),
    ),
    _entry(
        id="hyperbolic", label="Hyperbolic", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://api.hyperbolic.xyz/v1",
        default_model="meta-llama/Meta-Llama-3.1-8B-Instruct",
        signup_url="https://app.hyperbolic.xyz/settings",
        docs_url="https://docs.hyperbolic.xyz/docs/rest-api",
        model_candidates=[
            "meta-llama/Meta-Llama-3.1-8B-Instruct",
            "meta-llama/Meta-Llama-3.1-70B-Instruct",
        ],
        free_tier=FreeTier(summary="Free credit on signup", credit_usd=1.0),
    ),
    _entry(
        id="deepinfra", label="DeepInfra", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://api.deepinfra.com/v1/openai",
        default_model="meta-llama/Meta-Llama-3.1-8B-Instruct",
        signup_url="https://deepinfra.com/dash/api_keys",
        docs_url="https://deepinfra.com/docs/openai_api",
        model_candidates=[
            "meta-llama/Meta-Llama-3.1-8B-Instruct",
            "meta-llama/Llama-3.3-70B-Instruct",
        ],
        free_tier=FreeTier(summary="Free credit on signup", credit_usd=1.0),
    ),
    _entry(
        id="nebius", label="Nebius AI Studio", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI, base_url="https://api.studio.nebius.ai/v1",
        default_model="meta-llama/Meta-Llama-3.1-8B-Instruct",
        signup_url="https://studio.nebius.ai/settings/api-keys",
        docs_url="https://docs.nebius.com/studio/inference/quickstart",
        model_candidates=[
            "meta-llama/Meta-Llama-3.1-8B-Instruct",
            "meta-llama/Meta-Llama-3.1-70B-Instruct",
        ],
        free_tier=FreeTier(summary="Free trial credit on signup", credit_usd=1.0),
    ),
    _entry(
        id="glm", label="GLM (Zhipu)", tier=Tier.FREEMIUM,
        api_style=ApiStyle.OPENAI,
        base_url="https://open.bigmodel.cn/api/paas/v4",
        default_model="glm-4-flash",
        signup_url="https://open.bigmodel.cn/usercenter/apikeys",
        docs_url="https://open.bigmodel.cn/dev/api",
        model_candidates=["glm-4-flash", "glm-4-air", "glm-4-plus"],
        free_tier=FreeTier(summary="glm-4-flash is free to call"),
    ),

    # -- paid: billed per token from the first call --
    _entry(
        id="claude", label="Claude (Anthropic)", tier=Tier.PAID,
        api_style=ApiStyle.ANTHROPIC, base_url="https://api.anthropic.com/v1",
        default_model="claude-opus-5", key_env="OMA_CLAUDE_KEY",
        signup_url="https://console.anthropic.com/settings/keys",
        docs_url="https://docs.anthropic.com/en/api/messages",
        model_candidates=["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    ),
    _entry(
        id="chatgpt", label="OpenAI", tier=Tier.PAID,
        api_style=ApiStyle.OPENAI, base_url="https://api.openai.com/v1",
        default_model="gpt-4o", key_env="OMA_OPENAI_KEY",
        signup_url="https://platform.openai.com/api-keys",
        docs_url="https://platform.openai.com/docs/api-reference/chat",
        model_candidates=["gpt-4o", "gpt-4o-mini"],
    ),
    _entry(
        id="deepseek", label="DeepSeek", tier=Tier.PAID,
        api_style=ApiStyle.OPENAI, base_url="https://api.deepseek.com",
        default_model="deepseek-chat",
        signup_url="https://platform.deepseek.com/api_keys",
        docs_url="https://api-docs.deepseek.com/",
        model_candidates=["deepseek-chat", "deepseek-reasoner"],
    ),
    _entry(
        id="kimi", label="Kimi (Moonshot)", tier=Tier.PAID,
        api_style=ApiStyle.OPENAI, base_url="https://api.moonshot.cn/v1",
        default_model="moonshot-v1-8k",
        signup_url="https://platform.moonshot.cn/console/api-keys",
        docs_url="https://platform.moonshot.cn/docs/api-reference",
        model_candidates=["moonshot-v1-8k", "moonshot-v1-32k"],
    ),
]}

# Providers reachable with a browser session instead of an API key. These are
# covered by a subscription the user already pays for, so they sit in their own
# tier rather than with metered APIs.
SUBSCRIPTION_PROVIDER_IDS = ("claude", "chatgpt", "gemini")


def get(provider_id: str) -> ProviderEntry | None:
    return CATALOG.get(provider_id)


def all_entries() -> list[ProviderEntry]:
    """Every catalog entry, cheapest tier first, stable within a tier."""
    return sorted(CATALOG.values(), key=lambda e: (e.tier.rank, e.id))


def by_tier(tier: Tier) -> list[ProviderEntry]:
    return [e for e in all_entries() if e.tier is tier]


def free_entries() -> list[ProviderEntry]:
    """Providers usable without paying: local, free, and freemium."""
    return [e for e in all_entries() if e.is_free]


# --- live model resolution --------------------------------------------------

_MODEL_CACHE: dict[str, tuple[float, list[str]]] = {}
_MODEL_CACHE_TTL_S = 900.0


def list_models(
    provider_id: str,
    api_key: str = "",
    timeout: float = 10.0,
    force_refresh: bool = False,
    extra: dict | None = None,
) -> list[str]:
    """
    Ask a provider which models it serves right now.

    Returns an empty list when the provider publishes no catalog or the call
    fails -- callers fall back to the pinned default rather than erroring, so a
    provider that is merely unreachable does not take the harness down.
    """
    entry = CATALOG.get(provider_id)
    if entry is None:
        return []

    cached = _MODEL_CACHE.get(provider_id)
    if cached and not force_refresh and (time.time() - cached[0]) < _MODEL_CACHE_TTL_S:
        return cached[1]

    url = entry.models_endpoint
    for field_name, value in (extra or {}).items():
        url = url.replace("{" + field_name + "}", str(value))
    if "{" in url:  # an unfilled placeholder means we cannot build a request
        return []

    headers = {"Content-Type": "application/json"}
    if entry.api_style is ApiStyle.ANTHROPIC:
        headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
    elif entry.api_style is ApiStyle.GEMINI:
        url = f"{url}?key={api_key}"
    elif api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return []

    models = _extract_model_ids(payload)
    _MODEL_CACHE[provider_id] = (time.time(), models)
    return models


def _extract_model_ids(payload: dict) -> list[str]:
    """Pull model identifiers out of whichever shape the provider returned."""
    if not isinstance(payload, dict):
        return []

    # OpenAI and Anthropic: {"data": [{"id": ...}]}
    entries = payload.get("data")
    # Gemini: {"models": [{"name": "models/gemini-..."}]}
    if entries is None:
        entries = payload.get("models")
    if not isinstance(entries, list):
        return []

    models = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        name = item.get("id") or item.get("name") or ""
        if name.startswith("models/"):  # Gemini prefixes its identifiers
            name = name[len("models/"):]
        if name:
            models.append(name)
    return models


def resolve_model(
    provider_id: str,
    preferred: str = "",
    api_key: str = "",
    extra: dict | None = None,
) -> str:
    """
    Pick a model this provider actually serves.

    Providers retire model names on their own schedule, which otherwise turns
    into a 404 on the first call of a task. The preferred name wins if it is
    still listed; otherwise the entry's candidates are tried in order; if the
    provider publishes no catalog, the preferred or default name is returned
    unchanged and the call is allowed to fail on its own terms.
    """
    entry = CATALOG.get(provider_id)
    if entry is None:
        return preferred

    wanted = preferred or entry.default_model
    live = list_models(provider_id, api_key=api_key, extra=extra)
    if not live:
        return wanted
    if wanted in live:
        return wanted

    for candidate in entry.model_candidates:
        if candidate in live:
            return candidate

    # Nothing we know about is served; take whatever the provider offers first
    # rather than failing outright.
    return live[0] if live else wanted
