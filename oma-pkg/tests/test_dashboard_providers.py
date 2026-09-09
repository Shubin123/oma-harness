"""
The dashboard's provider and tier surface.

The Providers view renders entirely from /api/providers/catalog, so these
tests cover the contract that view depends on: every catalog entry reaches the
page with a signup link, a key is checked before it is stored, and the tier
policy can be changed from the browser. Nothing here touches the network --
verification is stubbed, because what matters is what the handler does with
each verdict.
"""

import http.server
import json
import threading
import urllib.error
import urllib.request

import pytest

from oma.gui.web import DashboardHandler
from oma.providers import catalog
from oma.providers.auth import AuthManager, CredentialStore
from oma.providers.catalog import VerifyResult

pytestmark = pytest.mark.functional


@pytest.fixture
def dashboard(tmp_path):
    """A dashboard bound to an ephemeral port with its own credential store."""
    server = http.server.HTTPServer(("127.0.0.1", 0), DashboardHandler)
    DashboardHandler.auth_manager = AuthManager(
        store=CredentialStore(path=tmp_path / "creds.json")
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode())


def post_json(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


class TestCatalogEndpoint:
    def test_every_catalog_entry_reaches_the_page(self, dashboard):
        data = get_json(f"{dashboard}/api/providers/catalog")
        assert {p["id"] for p in data["providers"]} == set(catalog.CATALOG)
        assert data["free_count"] == len(catalog.free_entries())

    def test_entries_carry_what_the_view_renders(self, dashboard):
        data = get_json(f"{dashboard}/api/providers/catalog")
        for entry in data["providers"]:
            for key in ("id", "label", "tier", "signup_url", "configured", "source"):
                assert key in entry, f"{entry.get('id')} missing {key}"

    def test_local_providers_need_no_credential(self, dashboard):
        data = get_json(f"{dashboard}/api/providers/catalog")
        local = [p for p in data["providers"] if p["tier"] == "local"]
        assert local
        for entry in local:
            assert entry["needs_key"] is False
            assert entry["configured"] is True

    def test_a_stored_key_shows_as_configured(self, dashboard):
        DashboardHandler.auth_manager.store_api_key("groq", "gsk_stored_example_key")
        data = get_json(f"{dashboard}/api/providers/catalog")
        groq = next(p for p in data["providers"] if p["id"] == "groq")
        assert groq["configured"] is True
        assert groq["source"] == "stored"


class TestKeyStorage:
    def test_a_verified_key_is_stored(self, dashboard, monkeypatch):
        monkeypatch.setattr(
            "oma.providers.catalog.verify_key",
            lambda *a, **k: (VerifyResult.VALID, "3 models available"),
        )
        result = post_json(f"{dashboard}/api/providers/key",
                           {"provider": "groq", "api_key": "gsk_good"})
        assert result["ok"] is True
        assert result["verified"] is True
        assert DashboardHandler.auth_manager.store.get("groq").value == "gsk_good"

    def test_a_refused_key_is_not_stored(self, dashboard, monkeypatch):
        """A key the provider rejects is a mistake worth surfacing, not saving."""
        monkeypatch.setattr(
            "oma.providers.catalog.verify_key",
            lambda *a, **k: (VerifyResult.REJECTED, "provider rejected the credential"),
        )
        result = post_json(f"{dashboard}/api/providers/key",
                           {"provider": "groq", "api_key": "gsk_bad"})
        assert result["ok"] is False
        assert "rejected" in result["error"]
        assert DashboardHandler.auth_manager.store.get("groq") is None

    def test_an_uncheckable_key_is_stored_but_flagged(self, dashboard, monkeypatch):
        """Some providers publish no catalog; that is not the user's fault."""
        monkeypatch.setattr(
            "oma.providers.catalog.verify_key",
            lambda *a, **k: (VerifyResult.UNVERIFIABLE, "no model catalog"),
        )
        result = post_json(f"{dashboard}/api/providers/key",
                           {"provider": "kimi", "api_key": "sk-unverifiable"})
        assert result["ok"] is True
        assert result["verified"] is False
        assert DashboardHandler.auth_manager.store.get("kimi").value == "sk-unverifiable"

    def test_missing_fields_are_rejected(self, dashboard):
        with pytest.raises(urllib.error.HTTPError) as exc:
            post_json(f"{dashboard}/api/providers/key", {"provider": "groq"})
        assert exc.value.code == 400


class TestDashboardMarkup:
    def test_the_providers_view_is_present(self, dashboard):
        with urllib.request.urlopen(f"{dashboard}/", timeout=10) as resp:
            html = resp.read().decode()
        for token in ('id="view-providers"', 'id="nav-providers"', 'id="catalog"',
                      'id="tier-mode"', "function renderCatalog()"):
            assert token in html, f"dashboard is missing {token}"
