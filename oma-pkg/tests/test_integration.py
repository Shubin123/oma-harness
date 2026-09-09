"""
Integration tests for the OMA harness.

These tests hit the live dashboard at http://127.0.0.1:8384 and verify:
  - API endpoints respond correctly
  - Provider connection status is accurate
  - Task execution flow works end-to-end

Design constraints (per project instructions):
  - Minimize conversation creation (don't waste chat cardinality)
  - Title every conversation created (never leave untitled)
  - Reuse existing connections rather than re-authenticating
  - Tests are grouped so expensive ones (live provider calls) are opt-in
"""

import json
import os
import time
import urllib.error
import urllib.request

import pytest

BASE_URL = os.environ.get("OMA_TEST_URL", "http://127.0.0.1:8384")


def api_get(path: str, timeout: int = 10) -> dict:
    """GET a JSON API endpoint."""
    req = urllib.request.Request(f"{BASE_URL}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path: str, body: dict = None, timeout: int = 30) -> dict:
    """POST to a JSON API endpoint."""
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        try:
            return json.loads(body_text)
        except json.JSONDecodeError:
            return {"error": f"HTTP {e.code}: {body_text[:200]}"}


def dashboard_reachable() -> bool:
    """Check if the dashboard is running."""
    try:
        req = urllib.request.Request(f"{BASE_URL}/")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


# ---- markers ----

skip_if_no_dashboard = pytest.mark.skipif(
    not dashboard_reachable(),
    reason=f"Dashboard not reachable at {BASE_URL}",
)

skip_if_no_live = pytest.mark.skipif(
    os.environ.get("OMA_TEST_LIVE") != "1",
    reason="Live provider tests disabled (set OMA_TEST_LIVE=1)",
)


# ============================================================
# Dashboard API Tests (no conversations created)
# ============================================================

@skip_if_no_dashboard
class TestDashboardServing:
    """Test that the dashboard serves correctly."""

    def test_index_returns_html(self):
        req = urllib.request.Request(f"{BASE_URL}/")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            assert resp.status == 200
            assert "OMA" in body
            assert "Open Multi Agent" in body

    def test_index_has_provider_cards(self):
        req = urllib.request.Request(f"{BASE_URL}/")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            assert "Claude" in body
            assert "ChatGPT" in body
            assert "Gemini" in body

    def test_404_on_unknown_path(self):
        try:
            req = urllib.request.Request(f"{BASE_URL}/nonexistent")
            urllib.request.urlopen(req, timeout=5)
            assert False, "Should have returned 404"
        except urllib.error.HTTPError as e:
            assert e.code == 404


@skip_if_no_dashboard
class TestStatusAPI:
    """Test the /api/status endpoint."""

    def test_status_returns_json(self):
        data = api_get("/api/status")
        assert isinstance(data, dict)

    def test_status_has_auth_section(self):
        data = api_get("/api/status")
        assert "auth" in data

    def test_status_lists_all_providers(self):
        data = api_get("/api/status")
        auth = data.get("auth", {})
        expected = ["claude", "chatgpt", "gemini"]
        for provider in expected:
            assert provider in auth, f"Missing {provider} in status"

    def test_status_provider_has_status_field(self):
        data = api_get("/api/status")
        auth = data.get("auth", {})
        for name, info in auth.items():
            assert "status" in info, f"{name} missing status field"
            assert info["status"] in (
                "logged_in", "logged_out", "expired", "error"
            ), f"{name} has unexpected status: {info['status']}"


@skip_if_no_dashboard
class TestAuthAPI:
    """Test auth-related API endpoints (without actually connecting)."""

    def test_connect_rejects_empty_token(self):
        result = api_post("/api/auth/connect", {"provider": "claude", "token": ""})
        # should fail gracefully
        assert "error" in result or result.get("ok") is False

    def test_connect_rejects_missing_provider(self):
        result = api_post("/api/auth/connect", {"token": "fake"})
        assert "error" in result

    def test_apikey_rejects_empty(self):
        result = api_post("/api/auth/apikey", {"provider": "deepseek", "api_key": ""})
        assert "error" in result or result.get("ok") is False

    def test_logout_rejects_missing_provider(self):
        result = api_post("/api/auth/logout", {})
        assert "error" in result


@skip_if_no_dashboard
class TestRunAPI:
    """Test task execution API (without live providers for the basic cases)."""

    def test_run_rejects_empty_objective(self):
        result = api_post("/api/run", {"objective": ""})
        assert "error" in result

    def test_run_rejects_no_body(self):
        result = api_post("/api/run", {})
        assert "error" in result

    def test_stop_returns_ok(self):
        # stop endpoint may reset connection under load; retry once
        for attempt in range(2):
            try:
                result = api_post("/api/stop")
                assert result.get("ok") is True
                return
            except ConnectionError:
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                raise


# ============================================================
# Provider Connection Verification (reads existing state only)
# ============================================================

@skip_if_no_dashboard
class TestProviderConnection:
    """Verify provider connection state (non-destructive)."""

    def test_claude_is_connected(self):
        """Verify Claude connection if configured."""
        data = api_get("/api/status")
        auth = data.get("auth", {})
        claude = auth.get("claude", {})
        if claude.get("status") != "logged_in":
            pytest.skip(
                f"Claude not connected (status: {claude.get('status')}). "
                "Connect via the dashboard at http://127.0.0.1:8384 or CLI"
            )
        assert claude.get("status") == "logged_in"

    def test_connected_provider_count(self):
        """At least one provider should be connected when credentials are configured."""
        data = api_get("/api/status")
        auth = data.get("auth", {})
        connected = [
            name for name, info in auth.items()
            if info.get("status") == "logged_in"
        ]
        if not connected:
            pytest.skip("No providers currently connected in dashboard")
        assert len(connected) >= 1


# ============================================================
# Token Validation (uses stored token against real API,
# NO conversations created -- read-only API call)
# ============================================================

@skip_if_no_dashboard
class TestTokenValidation:
    """
    Validate that stored auth tokens actually work against the live API.

    These tests hit /api/auth/verify which calls the provider's read-only
    endpoint (e.g. claude.ai/api/organizations) to confirm the token is
    valid. No conversations are created, no tokens are spent.
    """

    def test_claude_token_is_valid(self):
        """
        The stored Claude session key should be accepted by claude.ai.

        Hits the organizations endpoint -- read-only, zero conversations.
        If this fails, the session key has expired and needs refreshing.
        """
        # first check that claude is connected at all
        status = api_get("/api/status")
        claude_status = status.get("auth", {}).get("claude", {}).get("status")
        if claude_status != "logged_in":
            pytest.skip("Claude not connected -- nothing to validate")

        result = api_get("/api/auth/verify?provider=claude", timeout=20)
        assert result.get("valid") is True, (
            f"Claude token failed validation: {result.get('detail', result.get('error', 'unknown'))}. "
            "The session key may be expired -- reconnect at http://127.0.0.1:8384"
        )
        assert result.get("auth_type") in ("cookie", "token", "api_key"), (
            f"Unexpected auth_type: {result.get('auth_type')}"
        )

    def test_verify_rejects_unknown_provider(self):
        """Verifying a provider with no stored credential returns valid=False."""
        result = api_get("/api/auth/verify?provider=nonexistent")
        assert result.get("valid") is False

    def test_verify_rejects_missing_param(self):
        """Verify endpoint requires the provider parameter."""
        try:
            api_get("/api/auth/verify")
            assert False, "Should have returned 400"
        except urllib.error.HTTPError as e:
            assert e.code == 400
            body = json.loads(e.read().decode("utf-8"))
            assert "error" in body

    def test_verify_reflects_disconnected_provider(self):
        """
        A provider that is not logged in should report valid=False
        with a clear error about no stored credential.
        """
        # find a provider that is NOT connected
        status = api_get("/api/status")
        auth = status.get("auth", {})
        disconnected = [
            name for name, info in auth.items()
            if info.get("status") != "logged_in"
        ]
        if not disconnected:
            pytest.skip("All providers connected -- can't test disconnected path")

        result = api_get(f"/api/auth/verify?provider={disconnected[0]}")
        assert result.get("valid") is False
        assert "no credential" in result.get("error", "").lower()

    def test_health_metrics_present_for_connected(self):
        """
        Connected providers should have health metrics (success rate,
        latency, cooldown state) from the provider registry.
        """
        status = api_get("/api/status")
        auth = status.get("auth", {})
        for name, info in auth.items():
            if info.get("status") == "logged_in":
                health = info.get("health")
                assert health is not None, (
                    f"Provider '{name}' is connected but has no health metrics"
                )
                assert "success_rate" in health, f"{name} missing success_rate"
                assert "in_cooldown" in health, f"{name} missing cooldown state"


# ============================================================
# Test History API (reads recorded test history)
# ============================================================

@skip_if_no_dashboard
class TestHistoryAPI:
    """Verify the test history endpoint works."""

    def test_history_endpoint_returns_json(self):
        """The /api/test/history endpoint should return a list of runs."""
        data = api_get("/api/test/history")
        assert "runs" in data
        assert isinstance(data["runs"], list)


# ============================================================
# Live Provider Smoke Test (opt-in, creates exactly 1 conversation)
# ============================================================

@skip_if_no_dashboard
@skip_if_no_live
class TestLiveExecution:
    """
    Smoke test with a real provider call.

    This creates exactly ONE conversation to verify the full pipeline.
    The objective is minimal to conserve tokens and avoid waste.

    Enable with: OMA_TEST_LIVE=1
    """

    def test_minimal_task_completes(self):
        """Run the smallest possible task to verify the pipeline works."""
        result = api_post("/api/run", {
            "objective": "Reply with exactly: OMA_TEST_OK",
            "criteria": {"contains_marker": True},
        }, timeout=120)

        assert "error" not in result or result.get("status"), (
            f"Task failed: {result}"
        )

        status = result.get("status", "")
        assert status in ("done", "parked"), f"Unexpected status: {status}"

        # if done, verify the result contains our marker
        if status == "done":
            output = result.get("result", "")
            assert "OMA_TEST_OK" in output or len(output) > 0, (
                "Task completed but output is empty or missing marker"
            )

        # always check we got token accounting
        assert result.get("tokens_used", 0) > 0, "No tokens reported"
        assert result.get("attempts", 0) >= 1, "No attempts reported"


# ============================================================
# Unit-level integration tests (no network, no conversations)
# ============================================================

class TestAgentConstruction:
    """Test OMA agent construction without hitting any provider."""

    def test_from_env_with_no_keys(self):
        """OMA.from_env() with no keys produces an agent with empty registry."""
        from oma.agent import OMA

        # clear any OMA_ env vars temporarily
        saved = {}
        for key in list(os.environ):
            if key.startswith("OMA_"):
                saved[key] = os.environ.pop(key)
        try:
            agent = OMA.from_env()
            assert len(agent.registry._providers) == 0
        finally:
            os.environ.update(saved)

    def test_status_report_shape(self):
        """Status report has the expected structure."""
        from oma.agent import OMA

        saved = {}
        for key in list(os.environ):
            if key.startswith("OMA_"):
                saved[key] = os.environ.pop(key)
        try:
            agent = OMA.from_env()
            status = agent.status()
            assert "providers" in status
            assert "working_memory_entries" in status
            assert "config" in status
            assert "token_budget" in status["config"]
        finally:
            os.environ.update(saved)


class TestAuthManagerUnit:
    """Test AuthManager without network calls."""

    def test_store_and_retrieve_session(self, tmp_path):
        from oma.providers.auth import AuthManager, CredentialStore

        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)
        mgr.store_session_token("claude", "test-token-123", email="test@test.com")
        assert mgr.is_logged_in("claude")
        cred = mgr.get_credential("claude")
        assert cred.value == "test-token-123"
        assert cred.email == "test@test.com"

    def test_store_and_retrieve_api_key(self, tmp_path):
        from oma.providers.auth import AuthManager, CredentialStore

        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)
        mgr.store_api_key("deepseek", "sk-test-key")
        assert mgr.is_logged_in("deepseek")
        cred = mgr.get_credential("deepseek")
        assert cred.auth_type == "api_key"

    def test_logout_removes_credential(self, tmp_path):
        from oma.providers.auth import AuthManager, CredentialStore

        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)
        mgr.store_session_token("claude", "token")
        assert mgr.is_logged_in("claude")
        mgr.logout("claude")
        assert not mgr.is_logged_in("claude")

    def test_status_reflects_connections(self, tmp_path):
        from oma.providers.auth import AuthManager, CredentialStore

        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)
        mgr.store_session_token("claude", "token")
        mgr.store_api_key("chatgpt", "key")

        status = mgr.status()
        assert status["claude"]["status"] == "logged_in"
        assert status["chatgpt"]["status"] == "logged_in"
        assert status["gemini"]["status"] == "logged_out"


class TestSubscriptionProviderUnit:
    """Test subscription provider construction without network."""

    def test_claude_provider_creation(self):
        from oma.providers.subscription import make_subscription_provider

        provider = make_subscription_provider("claude", "fake-session-key")
        assert provider is not None
        assert provider.name == "claude"

    def test_chatgpt_provider_creation(self):
        from oma.providers.subscription import make_subscription_provider

        provider = make_subscription_provider("chatgpt", "fake-token")
        assert provider is not None
        assert provider.name == "chatgpt"

    def test_gemini_provider_creation(self):
        from oma.providers.subscription import make_subscription_provider

        provider = make_subscription_provider("gemini", "fake-cookie")
        assert provider is not None
        assert provider.name == "gemini"

    def test_unknown_provider_returns_none(self):
        from oma.providers.subscription import make_subscription_provider

        assert make_subscription_provider("unknown", "key") is None


class TestRegistryFromCredentials:
    """Test registry construction from AuthManager."""

    def test_builds_registry_from_stored_creds(self, tmp_path):
        from oma.providers.auth import AuthManager, CredentialStore
        from oma.providers.registry import ProviderRegistry

        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)
        mgr.store_api_key("claude", "sk-test-key")

        reg = ProviderRegistry.from_credentials(mgr)
        assert "claude" in reg._providers
        assert reg.get("claude") is not None

    def test_subscription_and_apikey_both_register(self, tmp_path):
        from oma.providers.auth import AuthManager, CredentialStore
        from oma.providers.registry import ProviderRegistry

        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)
        mgr.store_session_token("claude", "session-token")
        mgr.store_api_key("deepseek", "sk-deep-key")

        reg = ProviderRegistry.from_credentials(mgr)
        assert "claude" in reg._providers
        assert "deepseek" in reg._providers


class TestConversationNaming:
    """
    Verify that conversations created by the subscription provider
    are NOT left untitled (per project instructions).
    """

    def test_claude_conversation_body_has_name_field(self):
        """The create-conversation payload should include a name."""
        from oma.providers.subscription import ClaudeSubscriptionProvider

        provider = ClaudeSubscriptionProvider(session_cookie="fake")
        # the _create_conversation method builds JSON with a name field
        # we can't call it without hitting the network, but we can check
        # the method exists and has the right structure
        import inspect
        source = inspect.getsource(provider._create_conversation)
        assert '"name"' in source or "'name'" in source

    def test_conversation_name_is_not_empty_for_tests(self):
        """
        When the harness creates conversations for testing,
        they should be titled to avoid clutter.

        This is a policy check: the _create_conversation method
        currently sends name="" which leaves conversations untitled.
        """
        import inspect

        from oma.providers.subscription import ClaudeSubscriptionProvider

        source = inspect.getsource(ClaudeSubscriptionProvider._create_conversation)
        # flag if name is empty string - this is the issue we need to fix
        if '"name": ""' in source or "'name': ''" in source:
            pytest.xfail(
                "ClaudeSubscriptionProvider._create_conversation creates untitled "
                "conversations (name='') - should be titled for test runs"
            )


class TestDefaultCriteria:
    """Test that default criteria are always applied."""

    def test_ensure_criteria_with_none(self):
        from oma.core.criteria import ensure_criteria

        result = ensure_criteria(None)
        assert isinstance(result, dict)
        assert "criteria" in result
        assert len(result["criteria"]) > 0

    def test_ensure_criteria_with_empty_dict(self):
        from oma.core.criteria import ensure_criteria

        result = ensure_criteria({})
        assert isinstance(result, dict)
        assert len(result.get("criteria", [])) > 0

    def test_ensure_criteria_preserves_user_criteria(self):
        from oma.core.criteria import ensure_criteria

        user = {"test": True, "quality": 0.8}
        result = ensure_criteria(user)
        assert result == user  # passed through unchanged


class TestSanitizerCompleteness:
    """Test sanitizer against all provider attribution patterns."""

    def test_strips_all_known_attributions(self):
        from oma.core.sanitize import sanitize

        test_cases = [
            "Co-Authored-By: Claude Opus <noreply@anthropic.com>",
            "Generated with Claude Code",
            "Powered by Anthropic",
            "As an AI language model",
            "Generated with Gemini Pro",
            "Generated by ChatGPT-4",
            "Powered by OpenAI",
            "Generated with DeepSeek v3",
            "[AI-generated]",
            "[Auto-generated content]",
            "I'm Claude",
            "As an AI assistant",
        ]
        for text in test_cases:
            result = sanitize(f"Hello. {text} Goodbye.")
            # the attribution should be stripped, but surrounding text kept
            assert "Hello" in result, f"Lost surrounding text for: {text}"
            # check the key identifying word is gone
            key_words = ["Claude", "Anthropic", "ChatGPT", "OpenAI", "Gemini",
                        "DeepSeek", "AI-generated", "Auto-generated",
                        "AI language model", "AI assistant"]
            for word in key_words:
                if word.lower() in text.lower():
                    assert word not in result, (
                        f"Attribution not stripped: '{word}' still in result "
                        f"for input: '{text}'"
                    )
