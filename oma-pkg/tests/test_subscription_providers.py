"""
Tests for OMA Subscription Providers (Claude, ChatGPT, Gemini).
"""

import io
import json
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

from oma.providers.base import ErrorClass
from oma.providers.subscription import (
    ChatGPTSubscriptionProvider,
    ClaudeSubscriptionProvider,
    GeminiSubscriptionProvider,
    SubscriptionProvider,
    make_subscription_provider,
)


def test_subscription_base_provider():
    class DummySubProvider(SubscriptionProvider):
        def complete(self, messages, **kwargs):
            return None

    p = DummySubProvider(name="test_sub", credential_value="secret_val", auth_type="cookie")
    assert p.name == "test_sub"
    assert p._credential == "secret_val"
    assert p._auth_type == "cookie"
    assert p.count_tokens("12345678") == 2
    assert p.rate_limiter.requests_per_minute == 20


def test_claude_provider_credential_cleaning():
    p1 = ClaudeSubscriptionProvider(session_cookie="sessionKey=sk-ant-sid01-12345")
    assert p1._credential == "sk-ant-sid01-12345"

    p2 = ClaudeSubscriptionProvider(session_cookie=" 'sessionKey=sk-ant-sid01-abcdef' ")
    assert p2._credential == "sk-ant-sid01-abcdef"


def test_claude_provider_ensure_org_and_create_conv():
    p = ClaudeSubscriptionProvider(session_cookie="my-cookie")
    assert p._org_id is None

    # Test _ensure_org
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps([{"uuid": "org-uuid-123", "name": "My Org"}]).encode()
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        p._ensure_org()
        assert p._org_id == "org-uuid-123"

    # Test _create_conversation
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"uuid": "conv-uuid-456"}).encode()
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        conv_id = p._create_conversation("My Task")
        assert conv_id == "conv-uuid-456"


def test_claude_provider_complete_success():
    p = ClaudeSubscriptionProvider(session_cookie="my-cookie")
    p._org_id = "org-1"

    sse_data = (
        'data: {"type": "completion", "completion": "Hello"}\n'
        'data: {"type": "completion", "completion": " world!"}\n'
        'data: {"type": "ping"}\n'
    ).encode()

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = sse_data
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        with patch.object(p, "_create_conversation", return_value="conv-1"):
            resp = p.complete(
                messages=[{"role": "user", "content": "Hi"}],
                system="You are an assistant.",
            )
            assert resp.ok is True
            assert resp.text == "Hello world!"
            assert resp.provider == "claude"
            assert resp.tokens_out > 0


def test_claude_provider_no_org_error():
    p = ClaudeSubscriptionProvider(session_cookie="invalid-cookie")
    with patch.object(p, "_ensure_org"):  # leaves _org_id None
        resp = p.complete(messages=[{"role": "user", "content": "Hi"}])
        assert resp.ok is False
        assert "No organization found" in resp.error
        assert resp.error_class == ErrorClass.FATAL


def test_claude_provider_http_error():
    p = ClaudeSubscriptionProvider(session_cookie="my-cookie")
    p._org_id = "org-1"

    with patch.object(p, "_create_conversation", return_value="conv-1"):
        err = urllib.error.HTTPError(
            url="https://claude.ai",
            code=401,
            msg="Unauthorized",
            hdrs={},
            fp=io.BytesIO(b"Session expired"),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            resp = p.complete(messages=[{"role": "user", "content": "Hi"}])
            assert resp.ok is False
            assert "HTTP 401" in resp.error


def test_chatgpt_provider_credential_cleaning():
    p1 = ChatGPTSubscriptionProvider(access_token="Bearer my-secret-token")
    assert p1._credential == "my-secret-token"

    p2 = ChatGPTSubscriptionProvider(access_token=' "bearer token123" ')
    assert p2._credential == "token123"


def test_chatgpt_provider_complete_success():
    p = ChatGPTSubscriptionProvider(access_token="my-token")

    sse_data = (
        'data: {"message": {"content": {"parts": ["First part "]}}}\n'
        'data: {"message": {"content": {"parts": ["Complete response"]}}}\n'
        'data: [DONE]\n'
    ).encode()

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = sse_data
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        resp = p.complete(
            messages=[{"role": "user", "content": "Solve this"}],
            system="Be fast",
        )
        assert resp.ok is True
        assert resp.text == "Complete response"
        assert resp.provider == "chatgpt"


def test_chatgpt_provider_http_error():
    p = ChatGPTSubscriptionProvider(access_token="my-token")
    err = urllib.error.HTTPError(
        url="https://chatgpt.com",
        code=429,
        msg="Too Many Requests",
        hdrs={},
        fp=io.BytesIO(b"Rate limit exceeded"),
    )
    with patch("urllib.request.urlopen", side_effect=err):
        resp = p.complete(messages=[{"role": "user", "content": "Hi"}])
        assert resp.ok is False
        assert "HTTP 429" in resp.error
        assert resp.error_class == ErrorClass.RETRYABLE


def test_gemini_provider_credential_cleaning_and_snlm0e():
    p = GeminiSubscriptionProvider(session_cookie="__Secure-1PSID=cookie_value_123; other=abc")
    assert p._credential == "cookie_value_123"

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'<html>"SNlM0e":"snlm0e_secret_token"</html>'
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        p._get_snlm0e()
        assert p._snlm0e == "snlm0e_secret_token"


def test_gemini_provider_complete_success():
    p = GeminiSubscriptionProvider(session_cookie="gemini-cookie")
    p._snlm0e = "token"

    api_response = json.dumps({
        "candidates": [{
            "content": {
                "parts": [{"text": "Gemini generated answer"}]
            }
        }],
        "usageMetadata": {
            "promptTokenCount": 10,
            "candidatesTokenCount": 5,
        }
    }).encode()

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = api_response
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        resp = p.complete(messages=[{"role": "user", "content": "Hello"}])
        assert resp.ok is True
        assert resp.text == "Gemini generated answer"
        assert resp.tokens_in == 10
        assert resp.tokens_out == 5
        assert resp.provider == "gemini"


def test_gemini_provider_http_error():
    p = GeminiSubscriptionProvider(session_cookie="gemini-cookie")
    err = urllib.error.HTTPError(
        url="https://generativelanguage.googleapis.com",
        code=500,
        msg="Internal Server Error",
        hdrs={},
        fp=io.BytesIO(b"Backend fail"),
    )
    with patch("urllib.request.urlopen", side_effect=err):
        resp = p.complete(messages=[{"role": "user", "content": "Hi"}])
        assert resp.ok is False
        assert "HTTP 500" in resp.error


def test_make_subscription_provider_factory():
    claude = make_subscription_provider("claude", "sessionKey=123")
    assert isinstance(claude, ClaudeSubscriptionProvider)

    chatgpt = make_subscription_provider("chatgpt", "token123")
    assert isinstance(chatgpt, ChatGPTSubscriptionProvider)

    gemini = make_subscription_provider("gemini", "__Secure-1PSID=123")
    assert isinstance(gemini, GeminiSubscriptionProvider)

    unknown = make_subscription_provider("nonexistent", "key")
    assert unknown is None
