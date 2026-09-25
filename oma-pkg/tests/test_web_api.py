"""
Tests for OMA Dashboard Web Server (DashboardHandler and run_web).
"""

import io
import json
import threading
from http.server import HTTPServer
from unittest.mock import MagicMock, patch
from urllib.request import Request, urlopen

import pytest

from oma.agent import OMA
from oma.core.loop import Status, TaskState
from oma.gui.web import DashboardHandler, ThreadedHTTPServer
from oma.providers.auth import AuthManager


@pytest.fixture
def mock_auth():
    auth = MagicMock(spec=AuthManager)
    auth.status.return_value = {
        "claude": {"status": "logged_in", "auth_type": "cookie"},
        "gemini": {"status": "logged_in"},
    }
    auth.get_credential.return_value = MagicMock(value="fake-token", auth_type="cookie")
    auth.storage_info.return_value = {
        "file": "~/.oma/credentials.json",
        "exists": True,
        "mode": "0600",
        "providers_stored": ["claude"],
        "encrypted": True,
    }
    auth.store_session_token.return_value = True
    auth.store_api_key.return_value = True
    auth.logout.return_value = True
    auth.flush.return_value = {"credentials_deleted": True}
    return auth


@pytest.fixture
def mock_agent():
    agent = MagicMock(spec=OMA)
    agent.ralph_status.return_value = {
        "current_phase": "idle",
        "phase_events": [],
        "total_events": 0,
    }
    agent.router_status.return_value = {
        "strategy": "auto",
        "providers": {},
        "lkgp": {},
    }
    reg = MagicMock()
    reg.status_report.return_value = {
        "claude": {
            "success_rate": "100.0%",
            "avg_latency_ms": "120",
            "total_tokens": 500,
            "in_cooldown": False,
            "last_error": None,
        }
    }
    agent.registry = reg

    result = TaskState(
        task_id="t123",
        objective="test task",
        status=Status.DONE,
        confidence=0.95,
        attempts=2,
        tokens_used=150,
        artifacts={"final": "Task completed successfully"},
        lessons=[{"iteration": 1, "succeeded": True}],
        phase_history=[{"phase": "done"}],
    )
    result.strategy = {"best_confidence": 0.95}
    agent.run.return_value = result
    return agent


@pytest.fixture
def test_server(mock_auth, mock_agent):
    # Bind to port 0 for an ephemeral free port
    DashboardHandler.auth_manager = mock_auth
    DashboardHandler.agent = mock_agent
    DashboardHandler._workflows = {}
    DashboardHandler._last_result = None

    server = ThreadedHTTPServer(("127.0.0.1", 0), DashboardHandler)
    host, port = server.server_address
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    base_url = f"http://{host}:{port}"
    yield base_url

    server.shutdown()
    server.server_close()
    thread.join(timeout=1.0)


def test_get_root_and_index(test_server):
    # Test GET /
    with urlopen(f"{test_server}/") as resp:
        assert resp.status == 200
        assert "text/html" in resp.headers.get("Content-Type", "")
        html = resp.read().decode("utf-8")
        assert "OMA - Open Multi Agent" in html

    # Test GET /index.html
    with urlopen(f"{test_server}/index.html") as resp:
        assert resp.status == 200
        html = resp.read().decode("utf-8")
        assert "OMA - Open Multi Agent" in html


def test_get_status_endpoint(test_server):
    with urlopen(f"{test_server}/api/status") as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert "auth" in data
        assert "ralph" in data
        assert "router" in data
        assert "claude" in data["auth"]
        assert data["auth"]["claude"]["health"]["success_rate"] == "100.0%"
        # Check fallback health insertion for gemini
        assert "gemini" in data["auth"]
        assert data["auth"]["gemini"]["health"]["avg_latency_ms"] == "0"


def test_get_auth_verify_missing_provider(test_server):
    import urllib.error
    with pytest.raises(urllib.error.HTTPError) as exc_info:
        urlopen(f"{test_server}/api/auth/verify")
    assert exc_info.value.code == 400


def test_get_auth_verify_no_credentials(test_server, mock_auth):
    mock_auth.get_credential.return_value = None
    with urlopen(f"{test_server}/api/auth/verify?provider=claude") as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["valid"] is False
        assert "no credential stored" in data["error"]


def test_get_auth_verify_with_mocked_token(test_server):
    with patch.object(DashboardHandler, "_verify_token", return_value=(True, "Organization: TestOrg")):
        with urlopen(f"{test_server}/api/auth/verify?provider=claude") as resp:
            assert resp.status == 200
            data = json.loads(resp.read().decode("utf-8"))
            assert data["valid"] is True
            assert data["provider"] == "claude"
            assert data["detail"] == "Organization: TestOrg"


def test_get_workflows_and_templates(test_server):
    with urlopen(f"{test_server}/api/workflows") as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert "workflows" in data

    with urlopen(f"{test_server}/api/workflows/templates") as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        templates = data.get("templates", [])
        assert len(templates) > 0
        keys = [t["key"] for t in templates]
        assert "ralph_loop" in keys
        assert "simple_agent" in keys


def test_get_storage_info(test_server):
    with urlopen(f"{test_server}/api/storage/info") as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["exists"] is True
        assert data["mode"] == "0600"


def test_get_test_history_empty_and_populated(test_server, tmp_path):
    with urlopen(f"{test_server}/api/test/history") as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert "runs" in data
        assert isinstance(data["runs"], list)


def test_options_cors(test_server):
    req = Request(f"{test_server}/api/run", method="OPTIONS")
    with urlopen(req) as resp:
        assert resp.status == 200
        assert resp.headers.get("Access-Control-Allow-Origin") == "*"
        assert "POST" in resp.headers.get("Access-Control-Allow-Methods", "")


def test_post_auth_connect(test_server, mock_auth):
    # Missing fields
    payload = json.dumps({"provider": "claude"}).encode()
    req = Request(f"{test_server}/api/auth/connect", data=payload, headers={"Content-Type": "application/json"})
    import urllib.error
    with pytest.raises(urllib.error.HTTPError) as exc_info:
        urlopen(req)
    assert exc_info.value.code == 400

    # Successful verification
    with patch.object(DashboardHandler, "_verify_token", return_value=(True, "Session verified")):
        payload = json.dumps({"provider": "claude", "token": "valid-token"}).encode()
        req = Request(f"{test_server}/api/auth/connect", data=payload, headers={"Content-Type": "application/json"})
        with urlopen(req) as resp:
            assert resp.status == 200
            data = json.loads(resp.read().decode("utf-8"))
            assert data["ok"] is True
            mock_auth.store_session_token.assert_called_with("claude", "valid-token")

    # Failed verification
    with patch.object(DashboardHandler, "_verify_token", return_value=(False, "Expired cookie")):
        payload = json.dumps({"provider": "claude", "token": "expired-token"}).encode()
        req = Request(f"{test_server}/api/auth/connect", data=payload, headers={"Content-Type": "application/json"})
        with urlopen(req) as resp:
            assert resp.status == 200
            data = json.loads(resp.read().decode("utf-8"))
            assert data["ok"] is False
            assert "Expired cookie" in data["error"]


def test_post_auth_apikey(test_server, mock_auth):
    # Missing field
    payload = json.dumps({"provider": "claude"}).encode()
    req = Request(f"{test_server}/api/auth/apikey", data=payload, headers={"Content-Type": "application/json"})
    import urllib.error
    with pytest.raises(urllib.error.HTTPError) as exc_info:
        urlopen(req)
    assert exc_info.value.code == 400

    # Valid
    payload = json.dumps({"provider": "claude", "api_key": "sk-12345"}).encode()
    req = Request(f"{test_server}/api/auth/apikey", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["ok"] is True
        mock_auth.store_api_key.assert_called_with("claude", "sk-12345")


def test_post_auth_logout_and_flush(test_server, mock_auth):
    # Logout
    payload = json.dumps({"provider": "claude"}).encode()
    req = Request(f"{test_server}/api/auth/logout", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["ok"] is True
        mock_auth.logout.assert_called_with("claude")

    # Flush
    payload = json.dumps({"include_memory": True}).encode()
    req = Request(f"{test_server}/api/auth/flush", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["ok"] is True
        mock_auth.flush.assert_called_with(include_memory=True)


def test_post_run_and_stop(test_server, mock_agent):
    # Missing objective
    payload = json.dumps({}).encode()
    req = Request(f"{test_server}/api/run", data=payload, headers={"Content-Type": "application/json"})
    import urllib.error
    with pytest.raises(urllib.error.HTTPError) as exc_info:
        urlopen(req)
    assert exc_info.value.code == 400

    # Valid run
    payload = json.dumps({"objective": "Write a snake game", "criteria": {"playable": True}}).encode()
    req = Request(f"{test_server}/api/run", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["status"] == "done"
        assert data["confidence"] == 0.95
        assert "Task completed" in data["result"]
        mock_agent.run.assert_called_once_with(objective="Write a snake game", criteria={"playable": True})

    # Stop endpoint
    req = Request(f"{test_server}/api/stop", data=b"{}", headers={"Content-Type": "application/json"})
    with urlopen(req) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["ok"] is True


def test_post_workflows_create_and_run(test_server, mock_agent):
    # Create workflow
    nodes = [
        {"id": "n1", "type": "start", "name": "Start"},
        {"id": "n2", "type": "agent", "name": "Worker", "system": "Do work"},
        {"id": "n3", "type": "end", "name": "End"},
    ]
    edges = [
        {"from": "n1", "to": "n2"},
        {"from": "n2", "to": "n3"},
    ]
    payload = json.dumps({"name": "Test WF", "nodes": nodes, "edges": edges}).encode()
    req = Request(f"{test_server}/api/workflows", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req) as resp:
        assert resp.status == 200
        data = json.loads(resp.read().decode("utf-8"))
        assert data["ok"] is True
        assert "id" in data
        wf_id = data["id"]

    # Verify workflow listed in GET /api/workflows
    with urlopen(f"{test_server}/api/workflows") as resp:
        wfs = json.loads(resp.read().decode("utf-8"))["workflows"]
        assert any(w["id"] == wf_id for w in wfs)

    # Run workflow
    payload = json.dumps({"nodes": nodes, "edges": edges}).encode()
    req = Request(f"{test_server}/api/workflows/run", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req) as resp:
        assert resp.status == 200
        res = json.loads(resp.read().decode("utf-8"))
        assert res["status"] == "done"
        assert "node_results" in res
        assert res["node_results"]["n1"]["status"] == "pass-through"
        assert res["node_results"]["n2"]["status"] == "done"
        assert res["node_results"]["n3"]["status"] == "pass-through"


def test_verify_token_direct():
    handler = DashboardHandler.__new__(DashboardHandler)

    # Empty token
    ok, err = handler._verify_token("claude", "")
    assert ok is False
    assert "Empty token" in err

    # Claude verify mock
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps([{"name": "Anthropic Workspace"}]).encode()
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        ok, detail = handler._verify_token("claude", "test-session-key")
        assert ok is True
        assert "Anthropic Workspace" in detail

    # ChatGPT verify mock
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"user": {"email": "user@example.com"}}).encode()
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        ok, detail = handler._verify_token("chatgpt", "test-access-token")
        assert ok is True
        assert "user@example.com" in detail

    # Gemini verify mock
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'<html><script>window.WIZ_global_data = {"SNlM0e":"test_token"};</script></html>'
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        ok, detail = handler._verify_token("gemini", "gemini-cookie")
        assert ok is True
        assert "Google session valid" in detail

    # Unknown provider
    ok, detail = handler._verify_token("unknown_provider", "my-key")
    assert ok is True
    assert "Token stored" in detail
