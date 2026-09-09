"""
Provider catalog and tier policy.

The catalog is data, so the tests here check the invariants that make the data
safe to route on: every entry is reachable, every free provider tells the user
where to sign up, and the transport table cannot drift from the catalog. The
tier tests pin the behaviour that keeps a run cheap -- free capacity first,
escalation only when the cheap capacity is gone, and a ceiling that actually
refuses to spend.
"""

import pytest

from oma.core.router import Router
from oma.core.tiers import TierLedger, TierMode, TierPolicy, tier_of
from oma.providers import catalog
from oma.providers.catalog import ApiStyle, Tier
from oma.providers.http_providers import PROVIDER_CONFIGS

pytestmark = pytest.mark.unit


class TestCatalogIntegrity:
    def test_every_entry_is_keyed_by_its_own_id(self):
        for key, entry in catalog.CATALOG.items():
            assert key == entry.id

    def test_endpoints_are_absolute_urls(self):
        for entry in catalog.all_entries():
            assert entry.chat_endpoint.startswith("http"), entry.id

    def test_free_providers_say_where_to_sign_up(self):
        for entry in catalog.free_entries():
            assert entry.signup_url.startswith("http"), entry.id
            assert entry.free_tier is not None, entry.id
            assert entry.free_tier.summary, entry.id

    def test_key_providers_declare_an_environment_variable(self):
        for entry in catalog.all_entries():
            if entry.needs_key:
                assert entry.key_env, entry.id
            else:
                # Local runtimes need no credential at all.
                assert entry.tier is Tier.LOCAL, entry.id

    def test_local_providers_stay_on_localhost(self):
        for entry in catalog.by_tier(Tier.LOCAL):
            assert "localhost" in entry.base_url or "127.0.0.1" in entry.base_url

    def test_placeholders_are_declared_as_extra_fields(self):
        """A '{...}' left in a URL must be something we ask the user for."""
        for entry in catalog.all_entries():
            for chunk in entry.base_url.split("{")[1:]:
                name = chunk.split("}")[0]
                assert name in entry.extra_fields, f"{entry.id}: undeclared {name}"

    def test_entries_are_ordered_cheapest_first(self):
        ranks = [e.tier.rank for e in catalog.all_entries()]
        assert ranks == sorted(ranks)

    def test_transport_table_covers_the_whole_catalog(self):
        """PROVIDER_CONFIGS is generated, so the two can never disagree."""
        assert set(PROVIDER_CONFIGS) == set(catalog.CATALOG)
        for name, config in PROVIDER_CONFIGS.items():
            for key in ("endpoint", "default_model", "headers_fn", "body_fn", "parse_fn"):
                assert key in config, f"{name} missing {key}"

    def test_the_original_six_providers_are_still_present(self):
        for name in ("claude", "chatgpt", "gemini", "deepseek", "glm", "kimi"):
            assert name in PROVIDER_CONFIGS

    def test_anthropic_and_gemini_keep_their_own_dialects(self):
        assert catalog.get("claude").api_style is ApiStyle.ANTHROPIC
        assert catalog.get("gemini").api_style is ApiStyle.GEMINI
        assert catalog.get("groq").api_style is ApiStyle.OPENAI


class TestModelResolution:
    def test_a_live_model_is_kept(self, monkeypatch):
        monkeypatch.setattr(catalog, "list_models", lambda *a, **k: ["a", "b"])
        assert catalog.resolve_model("groq", preferred="b") == "b"

    def test_a_retired_model_falls_back_to_a_live_candidate(self, monkeypatch):
        entry = catalog.get("groq")
        live = [entry.model_candidates[-1], "something-else"]
        monkeypatch.setattr(catalog, "list_models", lambda *a, **k: live)
        assert catalog.resolve_model("groq", preferred="retired-model") == entry.model_candidates[-1]

    def test_an_unlisted_provider_catalog_leaves_the_choice_alone(self, monkeypatch):
        monkeypatch.setattr(catalog, "list_models", lambda *a, **k: [])
        assert catalog.resolve_model("groq", preferred="whatever") == "whatever"

    def test_gemini_model_names_are_unprefixed(self):
        payload = {"models": [{"name": "models/gemini-2.0-flash"}]}
        assert catalog._extract_model_ids(payload) == ["gemini-2.0-flash"]

    def test_openai_style_catalogs_parse(self):
        payload = {"data": [{"id": "llama-3.3-70b"}, {"id": "mixtral"}]}
        assert catalog._extract_model_ids(payload) == ["llama-3.3-70b", "mixtral"]

    def test_a_junk_payload_yields_nothing(self):
        assert catalog._extract_model_ids({"unexpected": True}) == []
        assert catalog._extract_model_ids([]) == []


class TestTierPolicy:
    def test_unknown_providers_are_assumed_to_cost_money(self):
        """Guessing 'free' for a stranger is the expensive mistake."""
        assert tier_of("not-a-real-provider") is Tier.PAID

    def test_cheapest_tier_wins_when_it_has_capacity(self):
        policy = TierPolicy()
        groups = policy.groups(["claude", "groq", "ollama"])
        assert groups[0][0] is Tier.LOCAL
        assert groups[0][1] == ["ollama"]

    def test_free_only_refuses_to_reach_for_a_paid_provider(self):
        policy = TierPolicy(mode=TierMode.FREE_ONLY)
        assert policy.groups(["claude", "chatgpt"]) == []
        assert not policy.allows("claude")
        assert policy.allows("groq")

    def test_a_ceiling_excludes_everything_above_it(self):
        policy = TierPolicy(max_tier=Tier.FREE)
        assert policy.allows("groq")
        assert not policy.allows("mistral")  # freemium sits above free
        assert not policy.allows("claude")

    def test_blocked_providers_are_never_offered(self):
        policy = TierPolicy(blocked={"groq"})
        groups = policy.groups(["groq", "cerebras"])
        assert groups[0][1] == ["cerebras"]

    def test_prefer_paid_inverts_the_order(self):
        policy = TierPolicy(mode=TierMode.PREFER_PAID)
        groups = policy.groups(["ollama", "claude"])
        assert groups[0][0] is Tier.PAID

    def test_off_leaves_ordering_to_the_router(self):
        policy = TierPolicy(mode=TierMode.OFF)
        groups = policy.groups(["claude", "ollama"])
        assert len(groups) == 1
        assert groups[0][1] == ["claude", "ollama"]


class TestTierLedger:
    def test_an_escalation_is_recorded_when_a_request_costs_more(self):
        ledger = TierLedger()
        assert ledger.record("ollama") is None
        escalation = ledger.record("claude")
        assert escalation is not None
        assert (escalation.from_tier, escalation.to_tier) == ("local", "paid")

    def test_dropping_back_to_free_is_not_an_escalation(self):
        ledger = TierLedger()
        ledger.record("claude")
        assert ledger.record("groq") is None

    def test_free_share_reflects_what_was_never_billed(self):
        ledger = TierLedger()
        ledger.record("groq")
        ledger.record("ollama")
        ledger.record("claude")
        assert ledger.free_share == pytest.approx(2 / 3)

    def test_an_empty_ledger_counts_as_entirely_free(self):
        assert TierLedger().free_share == 1.0


class TestRouterTierIntegration:
    def test_the_router_picks_the_cheapest_available_provider(self):
        router = Router()
        assert router.select(["claude", "groq", "ollama"]) == "ollama"

    def test_the_router_escalates_when_the_free_tier_is_exhausted(self):
        router = Router()
        router.quota_mgr.mark_exhausted("groq")
        router.quota_mgr.mark_exhausted("ollama")
        assert router.select(["claude", "groq", "ollama"]) == "claude"

    def test_a_free_only_router_selects_nothing_rather_than_spending(self):
        router = Router(tier_policy=TierPolicy(mode=TierMode.FREE_ONLY))
        assert router.select(["claude", "chatgpt"]) is None

    def test_tier_status_reports_usage_and_escalations(self):
        router = Router()
        router.selected("ollama")
        router.selected("claude")
        status = router.tier_status()
        assert status["usage_by_tier"] == {"local": 1, "paid": 1}
        assert status["current_tier"] == "paid"
        assert len(status["escalations"]) == 1
