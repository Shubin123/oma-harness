"""
OMA Subscription Providers -- use paid subscriptions instead of API keys.

These providers connect to the web interfaces that paid subscribers
use (Claude Pro, ChatGPT Plus, Gemini Advanced), using session
cookies/tokens captured via browser login.

This is the "side-channel" -- same models, no separate API billing.

Supported:
  - Claude: claude.ai web API (session cookie)
  - ChatGPT: chatgpt.com backend API (access token)
  - Gemini: gemini.google.com API (Google session cookie)
"""

import json
import time
import urllib.error
import urllib.request
import uuid

from .base import ErrorClass, Provider, ProviderResponse, RateLimiter


class SubscriptionProvider(Provider):
    """
    Base class for subscription-based providers.

    Instead of an API key, uses session cookies/tokens from
    the user's paid subscription login.
    """

    def __init__(self, name: str, credential_value: str, auth_type: str = "cookie", **kwargs):
        super().__init__(**kwargs)
        self.name = name
        self._credential = credential_value
        self._auth_type = auth_type
        self.rate_limiter = RateLimiter(
            requests_per_minute=20,  # conservative for web APIs
            tokens_per_minute=50_000,
        )

    def count_tokens(self, text: str) -> int:
        return len(text) // 4


class ClaudeSubscriptionProvider(SubscriptionProvider):
    """
    Claude via claude.ai web API.

    Uses the same endpoint that the claude.ai web app uses.
    Requires a valid session cookie from browser login.
    """

    ENDPOINT = "https://claude.ai/api/organizations/{org_id}/chat_conversations/{conv_id}/completion"
    ORGS_ENDPOINT = "https://claude.ai/api/organizations"

    def __init__(self, session_cookie: str, **kwargs):
        cookie = session_cookie.strip().strip("'\"")
        if cookie.startswith("sessionKey="):
            cookie = cookie.split("=", 1)[1]
        super().__init__(name="claude", credential_value=cookie, auth_type="cookie", **kwargs)
        self._org_id = None
        self._conv_id = None

    def _get_headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "Cookie": f"sessionKey={self._credential}",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/event-stream",
            "Origin": "https://claude.ai",
            "Referer": "https://claude.ai/",
        }

    def _ensure_org(self):
        """Fetch the user's organization ID if not cached."""
        if self._org_id:
            return
        try:
            req = urllib.request.Request(
                self.ORGS_ENDPOINT,
                headers=self._get_headers(),
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                orgs = json.loads(resp.read().decode("utf-8"))
                if orgs:
                    self._org_id = orgs[0].get("uuid", orgs[0].get("id"))
        except Exception:
            self._org_id = None

    def _create_conversation(self, title: str = "") -> str | None:
        """Create a new conversation and return its ID."""
        if not self._org_id:
            return None
        try:
            url = f"https://claude.ai/api/organizations/{self._org_id}/chat_conversations"
            conv_name = title or f"OMA task {time.strftime('%Y-%m-%d %H:%M')}"
            body = json.dumps({"name": conv_name, "uuid": str(uuid.uuid4())}).encode("utf-8")
            headers = self._get_headers()
            headers["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("uuid", data.get("id"))
        except Exception:
            return None

    def complete(
        self,
        messages: list[dict],
        system: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs,
    ) -> ProviderResponse:
        self.rate_limiter.wait_if_needed(estimated_tokens=max_tokens)
        self._ensure_org()

        if not self._org_id:
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="claude-sonnet-4-20250514", provider=self.name,
                latency_ms=0, error="No organization found -- session may be expired",
                error_class=ErrorClass.FATAL,
            )

        conv_id = self._create_conversation()
        if not conv_id:
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="claude-sonnet-4-20250514", provider=self.name,
                latency_ms=0, error="Failed to create conversation",
                error_class=ErrorClass.RETRYABLE,
            )

        # build the prompt from messages
        prompt_text = ""
        if system:
            prompt_text += f"[System: {system}]\n\n"
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role != "assistant":
                prompt_text += content + "\n"

        url = self.ENDPOINT.format(org_id=self._org_id, conv_id=conv_id)
        body = json.dumps({
            "prompt": prompt_text,
            "timezone": "UTC",
            "model": kwargs.get("model", "claude-sonnet-4-20250514"),
        }).encode("utf-8")

        t0 = time.time()
        try:
            req = urllib.request.Request(url, data=body, headers=self._get_headers(), method="POST")
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                # SSE stream -- collect all text events
                full_text = ""
                for line in resp.read().decode("utf-8").split("\n"):
                    if line.startswith("data: "):
                        try:
                            event = json.loads(line[6:])
                            if event.get("type") == "completion":
                                full_text += event.get("completion", "")
                            elif event.get("completion"):
                                full_text += event.get("completion", "")
                        except json.JSONDecodeError:
                            continue

            latency = (time.time() - t0) * 1000
            self.on_success()

            return ProviderResponse(
                text=full_text,
                tokens_in=len(prompt_text) // 4,
                tokens_out=len(full_text) // 4,
                model="claude-sonnet-4-20250514",
                provider=self.name,
                latency_ms=latency,
            )

        except urllib.error.HTTPError as e:
            latency = (time.time() - t0) * 1000
            error_body = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="claude-sonnet-4-20250514", provider=self.name,
                latency_ms=latency,
                error=f"HTTP {e.code}: {error_body[:500]}",
                error_class=self.classify_error(e),
            )
        except Exception as e:
            latency = (time.time() - t0) * 1000
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="claude-sonnet-4-20250514", provider=self.name,
                latency_ms=latency, error=str(e),
                error_class=self.classify_error(e),
            )


class ChatGPTSubscriptionProvider(SubscriptionProvider):
    """
    ChatGPT via chatgpt.com backend API.

    Uses the ChatGPT web backend with an access token
    captured from browser login.
    """

    ENDPOINT = "https://chatgpt.com/backend-api/conversation"

    def __init__(self, access_token: str, **kwargs):
        token = access_token.strip().strip("'\"")
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        super().__init__(name="chatgpt", credential_value=token, auth_type="token", **kwargs)

    def _get_headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._credential}",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/event-stream",
            "Origin": "https://chatgpt.com",
            "Referer": "https://chatgpt.com/",
        }

    def complete(
        self,
        messages: list[dict],
        system: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs,
    ) -> ProviderResponse:
        self.rate_limiter.wait_if_needed(estimated_tokens=max_tokens)

        # build ChatGPT backend API format
        msg_id = str(uuid.uuid4())
        parent_id = str(uuid.uuid4())

        # combine all messages into a single prompt for the web API
        prompt_parts = []
        if system:
            prompt_parts.append(system)
        for msg in messages:
            prompt_parts.append(msg.get("content", ""))

        body = json.dumps({
            "action": "next",
            "messages": [{
                "id": msg_id,
                "author": {"role": "user"},
                "content": {
                    "content_type": "text",
                    "parts": ["\n\n".join(prompt_parts)],
                },
            }],
            "parent_message_id": parent_id,
            "model": kwargs.get("model", "gpt-4o"),
            "timezone_offset_min": 0,
        }).encode("utf-8")

        t0 = time.time()
        try:
            req = urllib.request.Request(
                self.ENDPOINT, data=body,
                headers=self._get_headers(), method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                full_text = ""
                last_message = None
                for line in resp.read().decode("utf-8").split("\n"):
                    if line.startswith("data: ") and line.strip() != "data: [DONE]":
                        try:
                            event = json.loads(line[6:])
                            msg = event.get("message", {})
                            if msg.get("content", {}).get("parts"):
                                last_message = msg["content"]["parts"][0]
                        except json.JSONDecodeError:
                            continue

                if last_message:
                    full_text = last_message

            latency = (time.time() - t0) * 1000
            prompt = "\n\n".join(prompt_parts)
            self.on_success()

            return ProviderResponse(
                text=full_text,
                tokens_in=len(prompt) // 4,
                tokens_out=len(full_text) // 4,
                model="gpt-4o",
                provider=self.name,
                latency_ms=latency,
            )

        except urllib.error.HTTPError as e:
            latency = (time.time() - t0) * 1000
            error_body = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="gpt-4o", provider=self.name,
                latency_ms=latency,
                error=f"HTTP {e.code}: {error_body[:500]}",
                error_class=self.classify_error(e),
            )
        except Exception as e:
            latency = (time.time() - t0) * 1000
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="gpt-4o", provider=self.name,
                latency_ms=latency, error=str(e),
                error_class=self.classify_error(e),
            )


class GeminiSubscriptionProvider(SubscriptionProvider):
    """
    Gemini via gemini.google.com web API.

    Uses Google's Batchexecute API with session cookies.
    """

    ENDPOINT = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"

    def __init__(self, session_cookie: str, **kwargs):
        cookie = session_cookie.strip().strip("'\"")
        if "__Secure-1PSID=" in cookie:
            for part in cookie.split(";"):
                if part.strip().startswith("__Secure-1PSID="):
                    cookie = part.strip().split("=", 1)[1]
                    break
        super().__init__(name="gemini", credential_value=cookie, auth_type="cookie", **kwargs)
        self._snlm0e = None

    def _get_headers(self) -> dict:
        return {
            "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
            "Cookie": f"__Secure-1PSID={self._credential}",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Origin": "https://gemini.google.com",
            "Referer": "https://gemini.google.com/",
        }

    def _get_snlm0e(self):
        """Fetch the SNlM0e token needed for requests."""
        if self._snlm0e:
            return
        try:
            req = urllib.request.Request(
                "https://gemini.google.com/",
                headers=self._get_headers(),
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                html = resp.read().decode("utf-8")
                import re
                match = re.search(r'"SNlM0e":"([^"]+)"', html)
                if match:
                    self._snlm0e = match.group(1)
        except Exception:
            pass

    def complete(
        self,
        messages: list[dict],
        system: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        **kwargs,
    ) -> ProviderResponse:
        self.rate_limiter.wait_if_needed(estimated_tokens=max_tokens)
        self._get_snlm0e()

        prompt_parts = []
        if system:
            prompt_parts.append(system)
        for msg in messages:
            if msg.get("role") != "assistant":
                prompt_parts.append(msg.get("content", ""))
        prompt = "\n\n".join(prompt_parts)

        t0 = time.time()

        # use the Google GenerativeLanguage API as fallback
        # (Gemini subscription includes API access)
        try:
            body = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "maxOutputTokens": max_tokens,
                    "temperature": temperature,
                },
            }).encode("utf-8")

            headers = {
                "Content-Type": "application/json",
                "Cookie": f"__Secure-1PSID={self._credential}",
                "User-Agent": "Mozilla/5.0",
            }

            model = kwargs.get("model", "gemini-2.0-flash")
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = json.loads(resp.read().decode("utf-8"))

            latency = (time.time() - t0) * 1000
            candidates = raw.get("candidates", [{}])
            parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
            text = parts[0].get("text", "") if parts else ""
            usage = raw.get("usageMetadata", {})
            self.on_success()

            return ProviderResponse(
                text=text,
                tokens_in=usage.get("promptTokenCount", len(prompt) // 4),
                tokens_out=usage.get("candidatesTokenCount", len(text) // 4),
                model=model,
                provider=self.name,
                latency_ms=latency,
            )

        except urllib.error.HTTPError as e:
            latency = (time.time() - t0) * 1000
            error_body = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="gemini-2.0-flash", provider=self.name,
                latency_ms=latency,
                error=f"HTTP {e.code}: {error_body[:500]}",
                error_class=self.classify_error(e),
            )
        except Exception as e:
            latency = (time.time() - t0) * 1000
            return ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="gemini-2.0-flash", provider=self.name,
                latency_ms=latency, error=str(e),
                error_class=self.classify_error(e),
            )


# ---- factory ----

SUBSCRIPTION_PROVIDERS = {
    "claude": ClaudeSubscriptionProvider,
    "chatgpt": ChatGPTSubscriptionProvider,
    "gemini": GeminiSubscriptionProvider,
}


def make_subscription_provider(name: str, credential_value: str, auth_type: str = "cookie") -> Provider | None:
    """Create a subscription-based provider from stored credentials."""
    cls = SUBSCRIPTION_PROVIDERS.get(name)
    if not cls:
        return None

    if name == "claude":
        return cls(session_cookie=credential_value)
    elif name == "chatgpt":
        return cls(access_token=credential_value)
    elif name == "gemini":
        return cls(session_cookie=credential_value)

    return None
