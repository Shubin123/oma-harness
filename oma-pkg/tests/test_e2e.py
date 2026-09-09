"""
End-to-End (E2E) tests for the OMA harness.

Tests complete workflows from credential ingestion to core loop execution,
criteria evaluation, sanitization, memory handoffs, dashboard client interactions,
and task resumption across worker sessions.
"""

import http.server
import json
import threading

import pytest

from oma.agent import OMA
from oma.automation.memory import PersistentMemory
from oma.core.loop import LoopConfig, Status
from oma.gui.web import DashboardHandler
from oma.providers.auth import AuthManager, CredentialStore
from oma.providers.base import Provider, ProviderResponse
from oma.providers.registry import ProviderRegistry

pytestmark = pytest.mark.e2e


class E2EMockProvider(Provider):
    """Predictable mock provider for E2E testing."""

    def __init__(self, name: str, canned_output: str = ""):
        super().__init__()
        self.name = name
        self.canned_output = canned_output or (
            "Here is the comprehensive implementation for the requested solution:\n\n"
            "```python\ndef solve_problem(x):\n    # Doubles the input value and returns it\n    return x * 2\n```\n\n"
            + ("# Detailed commentary on performance and mathematical soundness.\n" * 10)
            + "\nGenerated with Claude Code. Have a great day!"
        )
        self.calls = []

    def count_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)

    def complete(self, messages, system=None, max_tokens=4096, temperature=0.3, **kwargs):
        self.calls.append({"messages": messages, "system": system})
        # Note the attribution that sanitizer must strip
        return ProviderResponse(
            text=self.canned_output,
            tokens_in=len(str(messages)) // 4,
            tokens_out=len(self.canned_output) // 4,
            model="e2e-model",
            provider=self.name,
            latency_ms=12.0,
        )


class TestFullLifecycleE2E:
    """End-to-end test of the complete harness pipeline."""

    def test_end_to_end_pipeline(self, tmp_path):
        cred_path = tmp_path / "credentials.json"
        mem_dir = tmp_path / ".oma_memory"
        mem_dir.mkdir()

        # Step 1: Securely add and save credential
        store = CredentialStore(path=cred_path)
        mgr = AuthManager(store=store)
        cred = mgr.store_credential("mock_llm", "sessionKey=sk-ant-sid01-samplee2etoken")
        assert cred.auth_type == "cookie"
        assert cred.value == "sk-ant-sid01-samplee2etoken"

        # Step 2: Initialize provider and agent
        mock_provider = E2EMockProvider("mock_llm")
        reg = ProviderRegistry()
        reg.register("mock_llm", mock_provider)

        config = LoopConfig(
            token_budget=5000,
            confidence_threshold=0.5,
            provider_chain=["mock_llm"],
        )
        agent = OMA(registry=reg, config=config, memory_dir=str(mem_dir))

        # Step 3: Run the task with explicit criteria
        criteria = {
            "solve_problem": True,
            "return": True,
        }
        result = agent.run(
            objective="Write a function called solve_problem that doubles its input",
            criteria=criteria,
        )

        # Step 4: Verify task status and results
        assert result.status == Status.DONE
        assert result.attempts >= 1
        assert result.tokens_used > 0
        final_code = result.artifacts.get("final", "")
        assert "def solve_problem" in final_code

        # Step 5: Verify Sanitizer ran in the pipeline and stripped attribution
        assert "Generated with Claude" not in final_code

        # Step 6: Verify Working memory entries were tracked
        assert len(agent.working._store) >= 1
        assert "attempt_1" in agent.working._store


class TestDashboardE2EPipeline:
    """End-to-end test of the Web Dashboard API pipeline."""

    def test_dashboard_api_run_pipeline(self, tmp_path, monkeypatch):
        # Prevent live network calls during dashboard agent rebuild
        monkeypatch.setattr(
            "oma.providers.registry._make_http_provider",
            lambda name, key: E2EMockProvider(name)
        )

        # Setup test server on free port
        server = http.server.HTTPServer(("127.0.0.1", 0), DashboardHandler)
        port = server.server_address[1]

        cred_path = tmp_path / "creds.json"
        store = CredentialStore(path=cred_path)
        auth_mgr = AuthManager(store=store)

        DashboardHandler.auth_manager = auth_mgr

        # Build agent with mock provider
        reg = ProviderRegistry()
        reg.register("e2e_provider", E2EMockProvider("e2e_provider"))
        agent = OMA(
            registry=reg,
            config=LoopConfig(confidence_threshold=0.5, provider_chain=["e2e_provider"]),
            memory_dir=str(tmp_path / "mem"),
        )
        DashboardHandler.agent = agent

        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()

        import urllib.request
        base_url = f"http://127.0.0.1:{port}"

        try:
            # 1. Store API key via /api/auth/apikey
            req_api = urllib.request.Request(
                f"{base_url}/api/auth/apikey",
                data=json.dumps({"provider": "deepseek", "api_key": "sk-test-e2e-key"}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req_api, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                assert data.get("ok") is True

            # 2. Check /api/status shows deepseek logged in
            with urllib.request.urlopen(f"{base_url}/api/status", timeout=5) as resp:
                st = json.loads(resp.read().decode())
                assert st["auth"]["deepseek"]["status"] == "logged_in"

            # 3. Execute task via /api/run
            req_run = urllib.request.Request(
                f"{base_url}/api/run",
                data=json.dumps({
                    "objective": "Build solve_problem function",
                    "criteria": {"solve_problem": True},
                }).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req_run, timeout=10) as resp:
                run_res = json.loads(resp.read().decode())
                assert run_res["status"] == "done"
                assert run_res["tokens_used"] > 0
                assert "solve_problem" in run_res["result"]

            # 4. Check test history endpoint
            with urllib.request.urlopen(f"{base_url}/api/test/history", timeout=5) as resp:
                hist = json.loads(resp.read().decode())
                assert "runs" in hist

        finally:
            server.shutdown()
            server_thread.join(timeout=2)


class TestResumptionE2E:
    """E2E test verifying multi-session task continuity via handoffs."""

    def test_session_handoff_and_resume(self, tmp_path):
        mem_dir = tmp_path / "oma_memory"
        mem_dir.mkdir()

        # Session 1: Task starts, does partial work, and parks
        reg1 = ProviderRegistry()
        reg1.register("p1", E2EMockProvider("p1", canned_output="Part 1: Initial research completed."))
        config1 = LoopConfig(
            token_budget=1000,
            token_reserve_for_handoff=900,  # Forces near_outage immediately
            confidence_threshold=0.99,
            provider_chain=["p1"],
        )
        worker1 = OMA(registry=reg1, config=config1, memory_dir=str(mem_dir))
        res1 = worker1.run(objective="Multi-step compiler pipeline")

        assert res1.status == Status.PARKED
        task_id = res1.task_id
        assert task_id is not None

        # Verify handoff persisted
        loaded = PersistentMemory(base_dir=str(mem_dir)).load(task_id)
        assert len(loaded.get("handoffs", [])) >= 1

        # Session 2: Fresh worker resumes the task
        reg2 = ProviderRegistry()
        reg2.register("p2", E2EMockProvider("p2", canned_output=("Part 2: Compiler pipeline finished.\n" * 20)))
        config2 = LoopConfig(
            token_budget=10_000,
            confidence_threshold=0.6,
            provider_chain=["p2"],
        )
        worker2 = OMA(registry=reg2, config=config2, memory_dir=str(mem_dir))
        res2 = worker2.run(
            objective="Multi-step compiler pipeline",
            criteria={"Compiler": True},
            resume_from=task_id,
        )

        assert res2.status == Status.DONE
        assert "Compiler pipeline finished" in res2.artifacts.get("final", "")
