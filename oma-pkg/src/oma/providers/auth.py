"""
OMA Auth Manager -- browser-based login and credential storage.

Handles subscription-based authentication for:
  - Claude (claude.ai) via session cookie
  - ChatGPT (chatgpt.com) via access token
  - Gemini (gemini.google.com) via session cookie

Flow:
  1. User clicks "Login" in GUI
  2. Browser opens provider's login page
  3. User authenticates normally
  4. OMA captures session cookie/token from callback
  5. Credentials stored securely on disk (encrypted with machine key)

No API keys needed -- uses the same paid subscriptions
the user already has (Claude Pro, ChatGPT Plus, Gemini Advanced).
"""

import base64
import hashlib
import json
import os
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from enum import Enum
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from ..platform_compat import (
    describe_permissions,
    make_private_dir,
    restrict_to_owner,
)
from ..platform_compat import (
    machine_id as _machine_id,
)


class AuthStatus(Enum):
    LOGGED_OUT = "logged_out"
    LOGGING_IN = "logging_in"
    LOGGED_IN = "logged_in"
    EXPIRED = "expired"
    ERROR = "error"


@dataclass
class Credential:
    """Stored credential for a provider subscription."""
    provider: str
    auth_type: str  # "cookie", "token", "api_key"
    value: str      # the actual credential
    email: str | None = None
    display_name: str | None = None
    plan: str | None = None  # "pro", "plus", "advanced", "free"
    expires_at: float | None = None
    created_at: float = field(default_factory=time.time)

    @property
    def is_expired(self) -> bool:
        if self.expires_at is None:
            return False
        return time.time() > self.expires_at

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Credential":
        return cls(**d)


# ---- provider login configs ----

PROVIDER_AUTH: dict[str, dict[str, str | None]] = {
    "claude": {
        "name": "Claude",
        "login_url": "https://claude.ai/login",
        "check_url": "https://claude.ai/api/auth/session",
        "cookie_domain": ".claude.ai",
        "session_cookie": "sessionKey",
        "token_header": None,
        "plan_field": "account.plan",
    },
    "chatgpt": {
        "name": "ChatGPT",
        "login_url": "https://chatgpt.com/auth/login",
        "check_url": "https://chatgpt.com/api/auth/session",
        "cookie_domain": ".chatgpt.com",
        "session_cookie": "__Secure-next-auth.session-token",
        "token_header": "Authorization",
        "plan_field": "user.subscription.plan",
    },
    "gemini": {
        "name": "Gemini",
        "login_url": "https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/",
        "check_url": "https://gemini.google.com/",
        "cookie_domain": ".google.com",
        "session_cookie": "__Secure-1PSID",
        "token_header": None,
        "plan_field": None,
    },
}


def clean_token(provider: str, raw: str) -> str:
    """
    Sanitize and clean a token or cookie string.
    Removes quotes, whitespace, and cookie name prefixes like 'sessionKey='.
    """
    if not raw:
        return ""
    token = raw.strip().strip("'\"")

    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    if "sessionKey=" in token:
        for part in token.split(";"):
            part = part.strip()
            if part.startswith("sessionKey="):
                token = part.split("=", 1)[1].strip()
                break
    elif token.startswith("sessionKey:"):
        token = token.split(":", 1)[1].strip()

    cookie_name_gpt = "__Secure-next-auth.session-token"
    if f"{cookie_name_gpt}=" in token:
        for part in token.split(";"):
            part = part.strip()
            if part.startswith(f"{cookie_name_gpt}="):
                token = part.split("=", 1)[1].strip()
                break

    cookie_name_gem = "__Secure-1PSID"
    if f"{cookie_name_gem}=" in token:
        for part in token.split(";"):
            part = part.strip()
            if part.startswith(f"{cookie_name_gem}="):
                token = part.split("=", 1)[1].strip()
                break

    if ";" in token:
        token = token.split(";", 1)[0].strip()

    return token.strip()


def detect_auth_type(provider: str, key_or_token: str) -> str:
    """
    Automatically detect whether a supplied key is a sessional key or an API key.

    Returns:
        'cookie', 'token', or 'api_key'
    """
    if not key_or_token:
        return "api_key"

    raw = key_or_token.strip().strip("'\"")

    # Universal session signatures across any provider
    if raw.startswith("sessionKey=") or "sessionKey=" in raw:
        return "cookie"
    if raw.startswith("sk-ant-sid"):
        return "cookie"
    if raw.startswith("sk-ant-oat"):
        return "token"
    if raw.startswith("eyJ"):
        return "token"
    if "__Secure-" in raw:
        return "token" if "token" in raw.lower() else "cookie"

    p = provider.lower()
    if p == "claude":
        if raw.startswith("sk-ant-api"):
            return "api_key"
        if len(raw) > 80 and not raw.startswith("sk-"):
            return "cookie"
        return "api_key"

    elif p == "chatgpt":
        if raw.startswith("sk-proj-") or raw.startswith("sk-"):
            return "api_key"
        return "token" if len(raw) > 100 else "api_key"

    elif p == "gemini":
        if raw.startswith("AIzaSy"):
            return "api_key"
        if len(raw) > 50:
            return "cookie"
        return "cookie"

    return "api_key"


class CredentialStore:
    """
    Encrypted on-disk credential storage.

    Credentials are stored in ~/.oma/credentials.json, encrypted
    with a machine-derived key. Not bank-vault security, but keeps
    tokens out of plaintext on disk.
    """

    def __init__(self, path: Path | None = None):
        self._path = path or Path.home() / ".oma" / "credentials.json"
        make_private_dir(self._path.parent)
        self._restrict_permissions()
        self._key = self._derive_key()
        self._creds: dict[str, Credential] = {}
        self._load()

    def _derive_key(self) -> bytes:
        """Derive an encryption key from machine-specific data."""
        return hashlib.pbkdf2_hmac(
            "sha256", _machine_id().encode(), b"oma-credential-store", 100_000
        )

    def _encrypt(self, data: str) -> str:
        """Simple XOR encryption with the derived key (not cryptographic, but obfuscates)."""
        raw = data.encode("utf-8")
        key = self._key * (len(raw) // len(self._key) + 1)
        encrypted = bytes(a ^ b for a, b in zip(raw, key))
        return base64.b64encode(encrypted).decode("ascii")

    def _decrypt(self, data: str) -> str:
        """Reverse the XOR encryption."""
        encrypted = base64.b64decode(data)
        key = self._key * (len(encrypted) // len(self._key) + 1)
        decrypted = bytes(a ^ b for a, b in zip(encrypted, key))
        return decrypted.decode("utf-8")

    def _load(self):
        if not self._path.exists():
            return
        try:
            with open(self._path) as f:
                encrypted = json.load(f)
            decrypted = self._decrypt(encrypted["data"])
            raw = json.loads(decrypted)
            self._creds = {k: Credential.from_dict(v) for k, v in raw.items()}
        except Exception:
            self._creds = {}

    def _restrict_permissions(self):
        """Keep the store owner-only, including files an older version left at 0644."""
        restrict_to_owner(self._path.parent)
        restrict_to_owner(self._path)

    def _save(self):
        raw = {k: v.to_dict() for k, v in self._creds.items()}
        encrypted = self._encrypt(json.dumps(raw))
        make_private_dir(self._path.parent)
        # The XOR key is derived from the machine's hardware UUID, which any
        # local user can read, so the file mode is what actually keeps these
        # tokens private. Write through a 0600 temp file and rename, so the
        # credentials are never momentarily world-readable.
        fd, tmp = tempfile.mkstemp(
            dir=str(self._path.parent), prefix=".credentials-", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w") as f:  # takes ownership of fd
                json.dump({"data": encrypted, "v": 1}, f)
            restrict_to_owner(tmp)  # mkstemp is 0600 on POSIX; Windows needs the ACL
            os.replace(tmp, self._path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self._restrict_permissions()

    def store(self, cred: Credential):
        self._creds[cred.provider] = cred
        self._save()

    def get(self, provider: str) -> Credential | None:
        cred = self._creds.get(provider)
        if cred and cred.is_expired:
            return None
        return cred

    @property
    def path(self) -> Path:
        return self._path

    def remove(self, provider: str):
        self._creds.pop(provider, None)
        self._save()

    def flush(self, secure_wipe: bool = True) -> int:
        """
        Securely wipe and flush all stored credentials from disk.
        If secure_wipe is True, overwrites file data before unlinking.
        Returns the number of credentials cleared.
        """
        count = len(self._creds)
        self._creds.clear()

        if self._path.exists():
            try:
                if secure_wipe:
                    size = self._path.stat().st_size
                    with open(self._path, "wb") as f:
                        f.write(os.urandom(size or 128))
                        f.flush()
                        os.fsync(f.fileno())
                self._path.unlink()
            except OSError:
                pass

        # Also clean up any lingering temporary files
        try:
            for tmp in self._path.parent.glob(".credentials-*.tmp"):
                try:
                    tmp.unlink()
                except OSError:
                    pass
        except OSError:
            pass

        return count

    def storage_info(self) -> dict:
        """
        Return transparency details on what is stored and where.
        Masks token values for security.
        """
        exists = self._path.exists()
        size_bytes = self._path.stat().st_size if exists else 0
        file_mode = describe_permissions(self._path)
        dir_mode = describe_permissions(self._path.parent)

        stored = {}
        for name, cred in self._creds.items():
            val = cred.value or ""
            masked = f"{val[:4]}...{val[-4:]}" if len(val) > 8 else "***"
            stored[name] = {
                "auth_type": cred.auth_type,
                "email": cred.email,
                "plan": cred.plan,
                "is_expired": cred.is_expired,
                "created_at": cred.created_at,
                "expires_at": cred.expires_at,
                "masked_value": masked,
            }

        return {
            "credentials_file": str(self._path),
            "credentials_dir": str(self._path.parent),
            "file_exists": exists,
            "size_bytes": size_bytes,
            "file_permissions": file_mode,
            "dir_permissions": dir_mode,
            "encryption": "PBKDF2-HMAC-SHA256 (100k rounds) + Hardware UUID key + XOR stream",
            "provider_count": len(self._creds),
            "providers": stored,
        }

    def all_providers(self) -> dict[str, Credential]:
        return {k: v for k, v in self._creds.items() if not v.is_expired}

    def status(self) -> dict:
        result = {}
        for name in PROVIDER_AUTH:
            cred = self._creds.get(name)
            if cred and not cred.is_expired:
                result[name] = {
                    "status": "logged_in",
                    "email": cred.email,
                    "plan": cred.plan,
                    "display_name": cred.display_name,
                }
            elif cred and cred.is_expired:
                result[name] = {"status": "expired"}
            else:
                result[name] = {"status": "logged_out"}

        for name, cred in self._creds.items():
            if name not in result:
                if not cred.is_expired:
                    result[name] = {
                        "status": "logged_in",
                        "email": cred.email,
                        "plan": cred.plan,
                        "display_name": cred.display_name,
                    }
                else:
                    result[name] = {"status": "expired"}
        return result


class AuthCallbackServer(BaseHTTPRequestHandler):
    """
    Local HTTP server to handle auth callbacks.

    After the user logs in via the browser, the auth flow redirects
    to localhost with the session token/cookie. This server captures it.
    """

    callback_data: dict[str, str] = {}
    callback_event = threading.Event()

    def log_message(self, *args):
        pass

    def do_GET(self):
        """Handle auth callback redirect."""
        from urllib.parse import parse_qs, urlparse
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/callback":
            AuthCallbackServer.callback_data = {
                k: v[0] if len(v) == 1 else v
                for k, v in params.items()
            }
            AuthCallbackServer.callback_event.set()

            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"""<!doctype html>
<html><body style="font-family:system-ui;display:flex;justify-content:center;
align-items:center;height:100vh;background:#0d1117;color:#c9d1d9">
<div style="text-align:center">
<h2 style="color:#3fb950">Login successful</h2>
<p>You can close this tab and return to OMA.</p>
<script>setTimeout(()=>window.close(),2000)</script>
</div></body></html>""")
        else:
            self.send_error(404)

    def do_POST(self):
        """Handle credential submission from login helper page."""
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        AuthCallbackServer.callback_data = body
        AuthCallbackServer.callback_event.set()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


class AuthManager:
    """
    Manages authentication flows for all providers.

    Supports two auth modes:
      1. Subscription login (browser-based, captures session cookies)
      2. API key (direct entry, stored encrypted)

    The GUI calls start_login(provider) which opens the browser.
    The user logs in, and the callback captures credentials.
    """

    def __init__(self, store: CredentialStore | None = None):
        self.store = store or CredentialStore()
        self._callback_port = 18923
        self._login_server: HTTPServer | None = None
        self._on_status_change: Callable | None = None

    def set_status_callback(self, fn: Callable):
        self._on_status_change = fn

    def _notify(self, provider: str, status: str, **extra):
        if self._on_status_change:
            self._on_status_change(provider, status, **extra)

    def get_credential(self, provider: str) -> Credential | None:
        return self.store.get(provider)

    def is_logged_in(self, provider: str) -> bool:
        cred = self.store.get(provider)
        return cred is not None and not cred.is_expired

    def status(self) -> dict:
        return self.store.status()

    def store_credential(
        self,
        provider: str,
        value: str,
        auth_type: str = "auto",
        email: str | None = None,
        plan: str | None = None,
    ) -> Credential:
        """
        Store a credential, securely handling either a sessional key or an API key.
        Automatically cleans/sanitizes the key and detects its type if requested.
        """
        cleaned = clean_token(provider, value)
        if not cleaned:
            raise ValueError("Credential value cannot be empty")

        if auth_type == "auto" or not auth_type:
            resolved_type = detect_auth_type(provider, value)
        else:
            resolved_type = auth_type

        if resolved_type in ("cookie", "token"):
            self.store_session_token(
                provider=provider,
                token=cleaned,
                email=email,
                plan=plan,
                auth_type=resolved_type,
            )
        else:
            self.store_api_key(provider=provider, api_key=cleaned)

        stored = self.store.get(provider)
        if stored is None:  # only if the store was flushed mid-call
            raise RuntimeError(f"credential for {provider} vanished before it could be read")
        return stored

    def store_api_key(self, provider: str, api_key: str):
        """Store an API key directly (fallback for users who prefer API keys)."""
        cred = Credential(
            provider=provider,
            auth_type="api_key",
            value=api_key,
        )
        self.store.store(cred)
        self._notify(provider, "logged_in")

    def store_session_token(
        self, provider: str, token: str,
        email: str | None = None, plan: str | None = None,
        auth_type: str = "cookie",
    ):
        """Store a session token/cookie captured from browser login."""
        cred = Credential(
            provider=provider,
            auth_type=auth_type,
            value=token,
            email=email,
            plan=plan,
            # session cookies typically last 30 days
            expires_at=time.time() + 30 * 86400,
        )
        self.store.store(cred)
        self._notify(provider, "logged_in")

    def start_login(self, provider: str) -> str:
        """
        Start the login flow for a provider.

        Opens the provider's login page in the default browser.
        Returns the login URL for the GUI to display.

        For subscription-based login, the flow is:
        1. Start local callback server
        2. Open browser to provider login page
        3. After login, provider redirects (or user pastes token)
        4. Credential stored and callback fires

        Since we can't intercept cookies from the provider's domain
        directly, we present a helper page where the user can:
        - Paste their session cookie/token (power users)
        - Or use the browser extension flow (future)
        """
        config = PROVIDER_AUTH.get(provider)
        if not config:
            return ""

        self._notify(provider, "logging_in")

        # start the background login flow listener
        threading.Thread(
            target=self._run_login_flow,
            args=(provider,),
            daemon=True,
        ).start()

        return config["login_url"] or ""

    def _run_login_flow(self, provider: str):
        """Background thread: start callback server and wait for credentials."""
        AuthCallbackServer.callback_data = {}
        AuthCallbackServer.callback_event.clear()

        try:
            server = HTTPServer(("127.0.0.1", self._callback_port), AuthCallbackServer)
            server.timeout = 300  # 5 minute timeout
            self._login_server = server

            # serve until callback received or timeout
            while not AuthCallbackServer.callback_event.is_set():
                server.handle_request()

            data = AuthCallbackServer.callback_data
            token = data.get("token") or data.get("cookie") or data.get("api_key")
            if token:
                auth_type = "api_key" if data.get("api_key") else "cookie"
                self.store_session_token(
                    provider=provider,
                    token=token,
                    email=data.get("email"),
                    plan=data.get("plan"),
                    auth_type=auth_type,
                )
            else:
                self._notify(provider, "error")

        except Exception:
            self._notify(provider, "error")
        finally:
            self._login_server = None

    def logout(self, provider: str):
        self.store.remove(provider)
        self._notify(provider, "logged_out")

    def logout_all(self):
        providers = set(PROVIDER_AUTH.keys()) | set(self.store.all_providers().keys())
        for provider in providers:
            self.store.remove(provider)
            self._notify(provider, "logged_out")

    def flush(self, include_memory: bool = False, memory_dir: str | Path | None = None) -> dict:
        """
        Securely wipe and flush all credentials from disk.
        Optionally wipes task persistent memory (.oma_memory).
        """
        providers = set(PROVIDER_AUTH.keys()) | set(self.store.all_providers().keys())
        for p in providers:
            self._notify(p, "logged_out")

        count = self.store.flush(secure_wipe=True)

        memory_flushed = 0
        if include_memory:
            mem_path = Path(memory_dir or ".oma_memory")
            if mem_path.exists():
                for f in mem_path.glob("*.json"):
                    try:
                        f.unlink()
                        memory_flushed += 1
                    except OSError:
                        pass

        return {
            "flushed_credentials_count": count,
            "memory_files_removed": memory_flushed,
            "credentials_file": str(self.store.path),
            "status": "flushed",
        }

    def storage_info(self) -> dict:
        """Return transparency details on safe credential storage."""
        return self.store.storage_info()
