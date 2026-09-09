"""
Smoke tests for OMA harness.

Fast, critical path sanity checks to verify all components, providers,
CLI entrypoints, secure credential storage, and dashboard endpoints
can spin up and operate without exceptions.
"""

import http.server
import json
import subprocess
import sys
import threading

import pytest

from oma.gui.web import DashboardHandler
from oma.providers.auth import (
    AuthManager,
    Credential,
    CredentialStore,
)
from oma.providers.base import ErrorClass
from oma.providers.registry import (
    ProviderRegistry,
    _make_http_provider,
)
from oma.providers.subscription import (
    ChatGPTSubscriptionProvider,
    ClaudeSubscriptionProvider,
    GeminiSubscriptionProvider,
)
from tests.conftest import assert_owner_only

pytestmark = pytest.mark.smoke


class TestProviderSmoke:
    """Smoke test that all provider implementations instantiate properly."""

    @pytest.mark.parametrize("provider_name", ["claude", "gemini", "chatgpt", "deepseek", "glm", "kimi"])
    def test_http_providers_instantiate(self, provider_name):
        provider = _make_http_provider(provider_name, "dummy-test-key-123")
        assert provider is not None
        assert provider.name == provider_name
        assert provider.count_tokens("hello world") >= 1

    def test_claude_subscription_provider_instantiates(self):
        p = ClaudeSubscriptionProvider(session_cookie="sessionKey=sk-ant-sid01-sample123")
        assert p.name == "claude"
        assert p._credential == "sk-ant-sid01-sample123"
        assert p.count_tokens("test string") >= 1

    def test_chatgpt_subscription_provider_instantiates(self):
        p = ChatGPTSubscriptionProvider(access_token="Bearer eyJsample.jwt.token")
        assert p.name == "chatgpt"
        assert p._credential == "eyJsample.jwt.token"

    def test_gemini_subscription_provider_instantiates(self):
        p = GeminiSubscriptionProvider(session_cookie="__Secure-1PSID=sample-cookie-val")
        assert p.name == "gemini"
        assert p._credential == "sample-cookie-val"


class TestSecuritySmoke:
    """Smoke test for credential encryption and owner-only filesystem permissions."""

    def test_credential_store_encryption_cycle(self, tmp_path):
        cred_path = tmp_path / "smoke_creds.json"
        store = CredentialStore(path=cred_path)

        # Storing both a session key and an API key
        store.store(Credential(provider="claude", auth_type="cookie", value="sk-ant-sid01-smoke"))
        store.store(Credential(provider="deepseek", auth_type="api_key", value="sk-deepseek-smoke"))

        # Verify encryption on disk
        raw_text = cred_path.read_text()
        assert "sk-ant-sid01-smoke" not in raw_text
        assert "sk-deepseek-smoke" not in raw_text

        # Verify permissions
        assert_owner_only(cred_path)
        assert_owner_only(cred_path.parent)

        # Verify decryption
        new_store = CredentialStore(path=cred_path)
        assert new_store.get("claude").value == "sk-ant-sid01-smoke"
        assert new_store.get("deepseek").value == "sk-deepseek-smoke"


class TestDashboardSmoke:
    """Smoke test for the web dashboard server lifecycle and core endpoints."""

    def test_dashboard_server_startup_and_endpoints(self, tmp_path):
        # Bind to port 0 to get an ephemeral free port
        server = http.server.HTTPServer(("127.0.0.1", 0), DashboardHandler)
        port = server.server_address[1]

        DashboardHandler.auth_manager = AuthManager(store=CredentialStore(path=tmp_path / "creds.json"))

        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()

        import urllib.request
        base_url = f"http://127.0.0.1:{port}"

        try:
            # 1. GET /
            with urllib.request.urlopen(f"{base_url}/", timeout=3) as resp:
                assert resp.status == 200
                html = resp.read().decode()
                assert "OMA" in html
                assert "Open Multi Agent" in html

            # 2. GET /api/status
            with urllib.request.urlopen(f"{base_url}/api/status", timeout=3) as resp:
                assert resp.status == 200
                data = json.loads(resp.read().decode())
                assert "auth" in data

            # 3. POST /api/auth/connect missing fields
            req = urllib.request.Request(
                f"{base_url}/api/auth/connect",
                data=json.dumps({}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            try:
                urllib.request.urlopen(req, timeout=3)
            except urllib.error.HTTPError as e:
                assert e.code == 400

            # 4. GET /api/storage/info
            with urllib.request.urlopen(f"{base_url}/api/storage/info", timeout=3) as resp:
                assert resp.status == 200
                sdata = json.loads(resp.read().decode())
                assert "credentials_file" in sdata
                assert "encryption" in sdata

            # 5. POST /api/auth/flush
            req_flush = urllib.request.Request(
                f"{base_url}/api/auth/flush",
                data=json.dumps({"include_memory": False}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req_flush, timeout=3) as resp:
                assert resp.status == 200
                fdata = json.loads(resp.read().decode())
                assert fdata.get("ok") is True

        finally:
            server.shutdown()
            server_thread.join(timeout=2)


class TestCLISmoke:
    """Smoke test CLI subcommands."""

    def test_cli_help_smoke(self):
        res = subprocess.run([sys.executable, "-m", "oma.cli", "--help"], capture_output=True, text=True)
        assert res.returncode == 0
        assert "run" in res.stdout
        assert "status" in res.stdout
        assert "providers" in res.stdout
        assert "auth" in res.stdout

    def test_cli_auth_help_smoke(self):
        res = subprocess.run([sys.executable, "-m", "oma.cli", "auth", "--help"], capture_output=True, text=True)
        assert res.returncode == 0
        assert "add" in res.stdout
        assert "status" in res.stdout
        assert "remove" in res.stdout

    def test_cli_status_smoke(self):
        res = subprocess.run([sys.executable, "-m", "oma.cli", "status"], capture_output=True, text=True)
        assert res.returncode == 0
        data = json.loads(res.stdout)
        assert "providers" in data
        assert "config" in data


class TestHealthTrackingSmoke:
    """Smoke test for provider registry health metrics and cooldown calculation."""

    def test_health_metrics_smoke(self):
        reg = ProviderRegistry()
        dummy = _make_http_provider("deepseek", "sk-test")
        reg.register("deepseek", dummy)

        # Record a success
        reg.record_success("deepseek", tokens=100, latency_ms=250.0)
        h = reg.health("deepseek")
        assert h.successes == 1
        assert h.success_rate == 1.0
        assert h.avg_latency_ms == 250.0

        # Record a failure
        reg.record_failure("deepseek", "Rate limited", ErrorClass.CAPACITY)
        assert h.failures == 1
        assert h.success_rate == 0.5
        assert not h.is_cooled_down

        # Status report
        report = reg.status_report()
        assert "deepseek" in report
        assert report["deepseek"]["in_cooldown"] is True
