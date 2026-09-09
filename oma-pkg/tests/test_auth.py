"""
Unit tests for OMA Auth and Credential Management.

Covers:
  - Token cleaning / sanitization (quotes, whitespace, cookie prefixes)
  - Automatic detection of sessional keys vs API keys
  - Credential encryption / decryption
  - File permissions (0600 file, 0700 dir) and atomic writes
  - AuthManager credential storage, status tracking, and callbacks
"""

import time

import pytest

from oma import platform_compat
from oma.providers.auth import (
    AuthManager,
    Credential,
    CredentialStore,
    clean_token,
    detect_auth_type,
)
from tests.conftest import assert_owner_only

pytestmark = pytest.mark.unit


class TestCleanToken:
    """Test token cleaning and prefix stripping."""

    def test_empty_token(self):
        assert clean_token("claude", "") == ""
        assert clean_token("claude", None) == ""

    def test_strip_whitespace_and_quotes(self):
        assert clean_token("claude", '  "sk-ant-api03-test"  ') == "sk-ant-api03-test"
        assert clean_token("claude", " 'sk-ant-sid01-test' ") == "sk-ant-sid01-test"

    def test_strip_bearer_prefix(self):
        assert clean_token("chatgpt", "Bearer eyJhbGciOi...") == "eyJhbGciOi..."
        assert clean_token("chatgpt", "bearer token123") == "token123"

    def test_claude_session_cookie_prefix(self):
        raw = "sessionKey=sk-ant-sid01-abc123xyz"
        assert clean_token("claude", raw) == "sk-ant-sid01-abc123xyz"

    def test_claude_cookie_with_attributes(self):
        raw = "sessionKey=sk-ant-sid01-abc123xyz; Domain=.claude.ai; Path=/; Secure"
        assert clean_token("claude", raw) == "sk-ant-sid01-abc123xyz"

    def test_claude_cookie_among_multiple(self):
        raw = "_ga=123; sessionKey=sk-ant-sid01-secret; __cf_bm=456"
        assert clean_token("claude", raw) == "sk-ant-sid01-secret"

    def test_chatgpt_session_cookie(self):
        raw = "__Secure-next-auth.session-token=eyJabc.def.ghi; Path=/"
        assert clean_token("chatgpt", raw) == "eyJabc.def.ghi"

    def test_gemini_session_cookie(self):
        raw = "__Secure-1PSID=sid_google_val_123; Domain=.google.com"
        assert clean_token("gemini", raw) == "sid_google_val_123"


class TestDetectAuthType:
    """Test automatic detection of sessional keys vs API keys."""

    def test_claude_api_key(self):
        assert detect_auth_type("claude", "sk-ant-api03-abcdef1234567890") == "api_key"

    def test_claude_sessional_key(self):
        assert detect_auth_type("claude", "sk-ant-sid01-abcdef1234567890") == "cookie"
        assert detect_auth_type("claude", "sessionKey=sk-ant-sid01-abc") == "cookie"

    def test_claude_oauth_token(self):
        assert detect_auth_type("claude", "sk-ant-oat01-abcdef1234567890") == "token"

    def test_chatgpt_api_key(self):
        assert detect_auth_type("chatgpt", "sk-proj-1234567890abcdef") == "api_key"
        assert detect_auth_type("chatgpt", "sk-1234567890abcdef") == "api_key"

    def test_chatgpt_sessional_token(self):
        jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ikpv"
        assert detect_auth_type("chatgpt", jwt) == "token"
        assert detect_auth_type("chatgpt", "__Secure-next-auth.session-token=abc") == "token"

    def test_gemini_api_key(self):
        assert detect_auth_type("gemini", "AIzaSyD-1234567890abcdef") == "api_key"

    def test_gemini_sessional_cookie(self):
        assert detect_auth_type("gemini", "__Secure-1PSID=google_session_cookie_value") == "cookie"

    def test_deepseek_and_other_providers(self):
        assert detect_auth_type("deepseek", "sk-32edf64d86974c07a609309610c7f225") == "api_key"
        assert detect_auth_type("glm", "any-api-key") == "api_key"
        assert detect_auth_type("kimi", "sk-kimi-key") == "api_key"


class TestCredentialStoreSecurity:
    """Test encryption, decryption, and secure disk permissions."""

    def test_store_creates_owner_only_permissions(self, tmp_path):
        cred_file = tmp_path / "subdir" / "creds.json"
        store = CredentialStore(path=cred_file)
        store.store(Credential(provider="claude", auth_type="cookie", value="test-secret-token"))

        # Neither the directory nor the file may be readable by other accounts
        assert_owner_only(cred_file.parent)
        assert_owner_only(cred_file)

    def test_stored_content_is_encrypted(self, tmp_path):
        cred_file = tmp_path / "creds.json"
        store = CredentialStore(path=cred_file)
        raw_secret = "super-secret-session-token-12345"
        store.store(Credential(provider="claude", auth_type="cookie", value=raw_secret))

        # Direct file read must not contain plaintext
        raw_on_disk = cred_file.read_text()
        assert raw_secret not in raw_on_disk

        # Reading through store decrypts properly
        loaded_store = CredentialStore(path=cred_file)
        cred = loaded_store.get("claude")
        assert cred is not None
        assert cred.value == raw_secret

    def test_expired_credentials_not_returned(self, tmp_path):
        cred_file = tmp_path / "creds.json"
        store = CredentialStore(path=cred_file)
        store.store(Credential(
            provider="claude",
            auth_type="cookie",
            value="token",
            expires_at=time.time() - 100,  # expired in past
        ))
        assert store.get("claude") is None


class TestAuthManager:
    """Test AuthManager high-level workflow."""

    def test_store_credential_auto_detects_session(self, tmp_path):
        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)

        cred = mgr.store_credential("claude", "sessionKey=sk-ant-sid01-testval123")
        assert cred.auth_type == "cookie"
        assert cred.value == "sk-ant-sid01-testval123"
        assert mgr.is_logged_in("claude")

    def test_store_credential_auto_detects_api_key(self, tmp_path):
        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)

        cred = mgr.store_credential("deepseek", "sk-32edf64d86974c07a609309610c7f225")
        assert cred.auth_type == "api_key"
        assert cred.value == "sk-32edf64d86974c07a609309610c7f225"
        assert mgr.is_logged_in("deepseek")

    def test_status_reports_all_stored_providers(self, tmp_path):
        store = CredentialStore(path=tmp_path / "creds.json")
        mgr = AuthManager(store=store)

        mgr.store_credential("claude", "sk-ant-sid01-abc", email="user@claude.ai", plan="pro")
        mgr.store_credential("deepseek", "sk-deepseek-key")

        st = mgr.status()
        assert st["claude"]["status"] == "logged_in"
        assert st["claude"]["email"] == "user@claude.ai"
        assert st["claude"]["plan"] == "pro"
        assert st["deepseek"]["status"] == "logged_in"
        assert st["gemini"]["status"] == "logged_out"


class TestStorageInfoAndFlushing:
    """Test transparency inspection and secure deletion capabilities."""

    def test_storage_info_structure(self, tmp_path):
        store_file = tmp_path / "creds.json"
        store = CredentialStore(path=store_file)
        store.store(Credential(provider="deepseek", auth_type="api_key", value="sk-123456789abcdef"))

        info = store.storage_info()
        assert info["credentials_file"] == str(store_file)
        assert info["file_exists"] is True
        assert info["provider_count"] == 1
        assert "deepseek" in info["providers"]
        # Raw secret must be masked
        assert info["providers"]["deepseek"]["masked_value"] == "sk-1...cdef"
        assert "sk-123456789abcdef" not in str(info)
        assert info["file_permissions"] == platform_compat.expected_permissions(is_dir=False)
        assert info["dir_permissions"] == platform_compat.expected_permissions(is_dir=True)

    def test_store_flush_securely_wipes_and_unlinks(self, tmp_path):
        store_file = tmp_path / "creds.json"
        store = CredentialStore(path=store_file)
        store.store(Credential(provider="claude", auth_type="cookie", value="sessionKey=test-val"))
        assert store_file.exists()

        count = store.flush(secure_wipe=True)
        assert count == 1
        assert not store_file.exists()
        assert len(store.all_providers()) == 0

    def test_store_flush_cleans_lingering_tmp_files(self, tmp_path):
        store_file = tmp_path / "creds.json"
        store = CredentialStore(path=store_file)
        tmp_leftover = tmp_path / ".credentials-9999.tmp"
        tmp_leftover.write_text("leftover temp data")

        store.flush(secure_wipe=True)
        assert not tmp_leftover.exists()

    def test_auth_manager_flush_notifies_and_cleans_memory(self, tmp_path):
        store_file = tmp_path / "creds.json"
        store = CredentialStore(path=store_file)
        mgr = AuthManager(store=store)

        notifications = []
        mgr.set_status_callback(lambda p, s, **kw: notifications.append((p, s)))

        mgr.store_credential("claude", "sessionKey=sk-ant-sid01-test")
        mgr.store_credential("deepseek", "sk-deepseek-test")

        # Create persistent memory files
        mem_dir = tmp_path / "memory_store"
        mem_dir.mkdir()
        (mem_dir / "task-1.json").write_text('{"task": 1}')
        (mem_dir / "task-2.json").write_text('{"task": 2}')

        res = mgr.flush(include_memory=True, memory_dir=mem_dir)
        assert res["flushed_credentials_count"] == 2
        assert res["memory_files_removed"] == 2
        assert not store_file.exists()
        assert len(list(mem_dir.glob("*.json"))) == 0

        # Notifications should include logout events
        logged_out = [p for p, s in notifications if s == "logged_out"]
        assert "claude" in logged_out
        assert "deepseek" in logged_out

    def test_persistent_memory_permissions_and_flush(self, tmp_path):
        from oma.automation.memory import PersistentMemory

        mem_dir = tmp_path / "persistent_mem"
        mem = PersistentMemory(base_dir=str(mem_dir))

        assert_owner_only(mem_dir)

        mem.save("task_alpha", {"objective": "test alpha"})
        mem.save("task_beta", {"objective": "test beta"})

        alpha_file = mem_dir / "task_alpha.json"
        assert_owner_only(alpha_file)

        tasks = mem.list_tasks()
        assert set(tasks) == {"task_alpha", "task_beta"}

        # Flush single task
        assert mem.flush("task_alpha") == 1
        assert mem.list_tasks() == ["task_beta"]

        # Flush remaining tasks
        assert mem.flush() == 1
        assert mem.list_tasks() == []

