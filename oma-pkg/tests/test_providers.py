"""Tests for the provider system."""


import pytest

from oma import platform_compat
from oma.providers.base import ErrorClass, Provider, ProviderResponse
from oma.providers.http_providers import PROVIDER_CONFIGS
from oma.providers.registry import ProviderHealth, ProviderRegistry
from tests.conftest import assert_owner_only, loosen_permissions

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
        expected = [
            "claude", "chatgpt", "gemini", "deepseek", "jev", "groq",
            "mistral", "openrouter", "ollama", "together", "qwen", "glm", "kimi"
        ]
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
            model="gpt-5.4",
            max_tokens=100,
            temperature=0.5,
        )
        assert body["model"] == "gpt-5.4"
        assert body["instructions"] == "be helpful"
        assert body["input"][0]["role"] == "user"
        assert body["max_output_tokens"] == 100
        assert body["store"] is False
        assert "temperature" not in body

    def test_openai_responses_parse(self):
        parse_fn = PROVIDER_CONFIGS["chatgpt"]["parse_fn"]
        parsed = parse_fn({
            "model": "gpt-5.4-2026-03-05",
            "output": [
                {"type": "reasoning", "summary": []},
                {"type": "message", "content": [
                    {"type": "output_text", "text": "Hello"},
                    {"type": "output_text", "text": " world"},
                ]},
            ],
            "usage": {"input_tokens": 12, "output_tokens": 7},
        })
        assert parsed.text == "Hello world"
        assert parsed.tokens_in == 12
        assert parsed.tokens_out == 7

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

    def test_jev_config_and_parsing(self):
        cfg = PROVIDER_CONFIGS["jev"]
        assert cfg["default_model"] == "typesafe/jev"
        headers = cfg["headers_fn"]("test-key")
        assert headers["Authorization"] == "Bearer test-key"

        body = cfg["body_fn"](
            messages=[{"role": "user", "content": "evaluate this code"}],
            system="judge accuracy",
            model="typesafe/jev",
            max_tokens=256,
            temperature=0.1,
        )
        assert body["model"] == "typesafe/jev"
        assert body["messages"][0]["role"] == "system"

        # parse Jev fast decision response
        jev_resp = {
            "choices": [{"message": {"content": "PASSED: All criteria met"}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 30},
        }
        parsed = cfg["parse_fn"](jev_resp)
        assert "PASSED" in parsed.text
        assert parsed.tokens_in == 50
        assert parsed.tokens_out == 30

    def test_groq_and_mistral_configs(self):
        groq_cfg = PROVIDER_CONFIGS["groq"]
        assert "groq.com" in groq_cfg["endpoint"]
        assert groq_cfg["default_model"] == "llama-3.3-70b-versatile"

        mistral_cfg = PROVIDER_CONFIGS["mistral"]
        assert "mistral.ai" in mistral_cfg["endpoint"]
        assert mistral_cfg["default_model"] == "mistral-small-latest"

    def test_openrouter_ollama_together_qwen_configs(self):
        for prov in ["openrouter", "ollama", "together", "qwen"]:
            cfg = PROVIDER_CONFIGS[prov]
            assert "endpoint" in cfg
            assert cfg["default_model"]
            headers = cfg["headers_fn"]("my-key")
            assert isinstance(headers, dict)


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
        assert_owner_only(path)
        assert_owner_only(path.parent)

    def test_tightens_a_legacy_world_readable_store(self, tmp_path):
        from oma.providers.auth import CredentialStore

        _, path = self._store(tmp_path)
        loosen_permissions(path.parent)
        loosen_permissions(path)
        assert not platform_compat.is_owner_only(path)

        reopened = CredentialStore(path=path)
        assert_owner_only(path)
        assert_owner_only(path.parent)
        assert reopened.get("claude").value == "tok"

    def test_save_leaves_no_temp_file_behind(self, tmp_path):
        _, path = self._store(tmp_path)
        assert [p.name for p in path.parent.iterdir()] == ["credentials.json"]
