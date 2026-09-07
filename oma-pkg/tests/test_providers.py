"""Tests for the provider system."""

import os
import stat

import pytest
from oma.providers.base import Provider, ProviderResponse, ErrorClass, RateLimiter
from oma.providers.registry import ProviderRegistry, ProviderHealth
from oma.providers.http_providers import PROVIDER_CONFIGS, _ParsedResponse

pytestmark = pytest.mark.unit


class TestProviderResponse:
    def test_ok_when_no_error(self):
        r = ProviderResponse(text="hi", tokens_in=10, tokens_out=5,
                              model="test", provider="test", latency_ms=100)
        assert r.ok
        assert r.tokens_total == 15

    def test_not_ok_with_error(self):
        r = ProviderResponse(text="", tokens_in=0, tokens_out=0,
                              model="test", provider="test", latency_ms=0,
                              error="boom", error_class=ErrorClass.FATAL)
        assert not r.ok


class TestProviderHealth:
    def test_success_rate(self):
        h = ProviderHealth(name="test")
        h.record_success(100, 50.0)
        h.record_success(200, 60.0)
        h.record_failure("err", ErrorClass.RETRYABLE)
        assert h.success_rate == pytest.approx(2/3)

    def test_cooldown_on_capacity(self):
        h = ProviderHealth(name="test")
        h.record_failure("overloaded", ErrorClass.CAPACITY)
        assert not h.is_cooled_down

    def test_avg_latency(self):
        h = ProviderHealth(name="test")
        h.record_success(100, 50.0)
        h.record_success(100, 150.0)
        assert h.avg_latency_ms == pytest.approx(100.0)


class TestProviderRegistry:
    def test_register_and_get(self):
        reg = ProviderRegistry()

        class FakeProvider(Provider):
            name = "fake"
            def complete(self, *a, **kw): pass
            def count_tokens(self, t): return len(t) // 4

        provider = FakeProvider()
        reg.register("fake", provider)
        assert reg.get("fake") is provider
        assert reg.get("nonexistent") is None

    def test_available_excludes_cooldown(self):
        reg = ProviderRegistry()

        class FakeProvider(Provider):
            name = "fake"
            def complete(self, *a, **kw): pass
            def count_tokens(self, t): return 0

        reg.register("p1", FakeProvider())
        reg.register("p2", FakeProvider())

        # put p2 in cooldown
        reg.record_failure("p2", "error", ErrorClass.BUDGET)
        avail = reg.available()
        assert "p1" in avail
        assert "p2" not in avail

    def test_fallback_chain_ordered(self):
        reg = ProviderRegistry()

        class FakeProvider(Provider):
            name = "fake"
            def complete(self, *a, **kw): pass
            def count_tokens(self, t): return 0

        reg.register("slow", FakeProvider())
        reg.register("fast", FakeProvider())

        # fast has better stats
        reg.record_success("fast", 100, 10.0)
        reg.record_success("fast", 100, 10.0)
        reg.record_success("slow", 100, 500.0)

        chain = reg.fallback_chain()
        assert chain[0] == "fast"

    def test_status_report(self):
        reg = ProviderRegistry()

        class FakeProvider(Provider):
            name = "fake"
            def complete(self, *a, **kw): pass
            def count_tokens(self, t): return 0

        reg.register("test", FakeProvider())
        reg.record_success("test", 100, 50.0)

        report = reg.status_report()
        assert "test" in report
        assert "success_rate" in report["test"]


class TestProviderConfigs:
    def test_all_configs_present(self):
        expected = ["claude", "chatgpt", "gemini", "deepseek", "glm", "kimi"]
        for name in expected:
            assert name in PROVIDER_CONFIGS, f"missing config for {name}"

    def test_configs_have_required_keys(self):
        required = ["endpoint", "default_model", "headers_fn", "body_fn", "parse_fn"]
        for name, config in PROVIDER_CONFIGS.items():
            for key in required:
                assert key in config, f"{name} missing {key}"

    def test_claude_body_format(self):
        body_fn = PROVIDER_CONFIGS["claude"]["body_fn"]
        body = body_fn(
            messages=[{"role": "user", "content": "hi"}],
            system="be helpful",
            model="claude-sonnet-4-20250514",
            max_tokens=100,
            temperature=0.5,
        )
        assert body["model"] == "claude-sonnet-4-20250514"
        assert body["system"] == "be helpful"
        assert body["messages"][0]["content"] == "hi"

    def test_openai_body_format(self):
        body_fn = PROVIDER_CONFIGS["chatgpt"]["body_fn"]
        body = body_fn(
            messages=[{"role": "user", "content": "hi"}],
            system="be helpful",
            model="gpt-4o",
            max_tokens=100,
            temperature=0.5,
        )
        assert body["model"] == "gpt-4o"
        # system should be prepended as first message
        assert body["messages"][0]["role"] == "system"

    def test_gemini_body_format(self):
        body_fn = PROVIDER_CONFIGS["gemini"]["body_fn"]
        body = body_fn(
            messages=[{"role": "user", "content": "hi"}],
            system="be helpful",
            model="gemini-2.0-flash",
            max_tokens=100,
            temperature=0.5,
        )
        assert "contents" in body
        assert "systemInstruction" in body


class TestCredentialStorePermissions:
    """The XOR key comes from the machine's hardware UUID, which any local user
    can read, so the on-disk mode is what actually keeps stored tokens private."""

    def _store(self, tmp_path):
        from oma.providers.auth import Credential, CredentialStore

        path = tmp_path / "sub" / "credentials.json"
        store = CredentialStore(path=path)
        store.store(Credential(provider="claude", auth_type="cookie", value="tok"))
        return store, path

    def test_new_store_is_owner_only(self, tmp_path):
        _, path = self._store(tmp_path)
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700

    def test_tightens_a_legacy_world_readable_store(self, tmp_path):
        from oma.providers.auth import CredentialStore

        _, path = self._store(tmp_path)
        os.chmod(path.parent, 0o755)
        os.chmod(path, 0o644)

        reopened = CredentialStore(path=path)
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        assert reopened.get("claude").value == "tok"

    def test_save_leaves_no_temp_file_behind(self, tmp_path):
        _, path = self._store(tmp_path)
        assert [p.name for p in path.parent.iterdir()] == ["credentials.json"]
