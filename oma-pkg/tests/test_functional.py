"""
Functional tests for the OMA harness.

Tests component workflows, multi-provider fallbacks, criteria gating,
memory-driven context optimization, persistent task resumption, and CLI workflows.
"""


import pytest

from oma.agent import OMA
from oma.automation.memory import PersistentMemory
from oma.core.loop import LoopConfig, Status
from oma.providers.auth import CredentialStore
from oma.providers.base import ErrorClass, Provider, ProviderResponse
from oma.providers.registry import ProviderRegistry

pytestmark = pytest.mark.functional


class MockProvider(Provider):
    """Test provider with programmable responses."""

    def __init__(self, name: str, responses: list[ProviderResponse] = None):
        super().__init__()
        self.name = name
        self.responses = list(responses or [])
        self.call_count = 0
        self.recorded_messages = []

    def count_tokens(self, text: str) -> int:
        return len(text) // 4

    def complete(self, messages, system=None, max_tokens=4096, temperature=0.3, **kwargs):
        self.call_count += 1
        self.recorded_messages.append(messages)
        if self.responses:
            resp = self.responses.pop(0)
            if resp.ok:
                self.on_success()
            return resp
        return ProviderResponse(
            text="Mock default response",
            tokens_in=10,
            tokens_out=10,
            model="mock",
            provider=self.name,
            latency_ms=5.0,
        )


class TestAgentWorkflows:
    """Test full agent execution flows with criteria and providers."""

    def test_task_completes_when_criteria_met(self, tmp_path):
        reg = ProviderRegistry()
        long_output = "def add(a, b):\n    # adds a and b\n    return a + b\n" * 15
        reg.register("mock_p", MockProvider("mock_p", [
            ProviderResponse(
                text=long_output,
                tokens_in=50,
                tokens_out=150,
                model="mock",
                provider="mock_p",
                latency_ms=10.0,
            )
        ]))

        config = LoopConfig(
            confidence_threshold=0.6,
            provider_chain=["mock_p"],
        )
        agent = OMA(registry=reg, config=config, memory_dir=str(tmp_path / "memory"))
        criteria = {
            "add": True,
            "return": True,
        }

        result = agent.run(
            objective="Write a python addition function",
            criteria=criteria,
        )

        assert result.status == Status.DONE
        assert result.confidence >= 0.6
        assert result.attempts == 1
        assert "def add" in result.artifacts.get("final", "")

    def test_task_retries_and_completes_on_second_attempt(self, tmp_path):
        responses = [
            ProviderResponse(
                text="short",
                tokens_in=5,
                tokens_out=5,
                model="mock",
                provider="mock_p",
                latency_ms=5.0,
            ),
            ProviderResponse(
                text=("SUCCESS_MARKER: here is the complete solution for the task.\n" * 20),
                tokens_in=50,
                tokens_out=150,
                model="mock",
                provider="mock_p",
                latency_ms=5.0,
            )
        ]
        reg = ProviderRegistry()
        reg.register("mock_p", MockProvider("mock_p", responses))

        config = LoopConfig(
            max_attempts=3,
            confidence_threshold=0.6,
            provider_chain=["mock_p"],
            backoff_base_s=0.01,
            backoff_max_s=0.05,
        )
        agent = OMA(registry=reg, config=config, memory_dir=str(tmp_path / "memory"))

        result = agent.run(
            objective="Generate code with SUCCESS_MARKER",
            criteria={"SUCCESS_MARKER": True},
        )

        assert result.status == Status.DONE
        assert result.attempts == 2
        assert "SUCCESS_MARKER" in result.artifacts.get("final", "")


class TestFallbackChainExecution:
    """Test dynamic fallback when providers fail or enter cooldown."""

    def test_primary_fails_secondary_succeeds(self, tmp_path):
        p1 = MockProvider("p1", [
            ProviderResponse(
                text="", tokens_in=0, tokens_out=0,
                model="p1", provider="p1", latency_ms=10.0,
                error="Rate limit exceeded", error_class=ErrorClass.CAPACITY,
            )
        ])
        long_solution = ("Secondary provider completed the task successfully with high confidence.\n" * 20)
        p2 = MockProvider("p2", [
            ProviderResponse(
                text=long_solution,
                tokens_in=50, tokens_out=150,
                model="p2", provider="p2", latency_ms=8.0,
            )
        ])

        reg = ProviderRegistry()
        reg.register("p1", p1)
        reg.register("p2", p2)

        config = LoopConfig(
            max_attempts=2,
            confidence_threshold=0.6,
            provider_chain=["p1", "p2"],
            backoff_base_s=0.01,
            backoff_max_s=0.05,
        )
        agent = OMA(registry=reg, config=config, memory_dir=str(tmp_path / "memory"))

        result = agent.run(
            objective="Do some work with fallback",
            criteria={"Secondary": True},
        )

        assert result.status == Status.DONE
        assert p1.call_count == 1
        assert p2.call_count == 1
        assert "Secondary provider" in result.artifacts.get("final", "")

        h1 = reg.health("p1")
        h2 = reg.health("p2")
        assert h1.failures == 1
        assert h2.successes == 1


class TestTaskParkingAndResumption:
    """Test task parking near outage and resuming from persistent memory."""

    def test_park_and_resume_flow(self, tmp_path):
        mem_dir = tmp_path / "oma_mem"
        mem_dir.mkdir()

        # Step 1: Force parking via near_outage token limit
        p1 = MockProvider("p1", [
            ProviderResponse(
                text="Partial work done before budget runs out",
                tokens_in=850, tokens_out=850,
                model="p1", provider="p1", latency_ms=5.0,
            )
        ])
        reg1 = ProviderRegistry()
        reg1.register("p1", p1)

        config1 = LoopConfig(
            token_budget=2000,
            token_reserve_for_handoff=500,  # 1700 used leaves 300 < 500 -> near outage
            provider_chain=["p1"],
            confidence_threshold=0.99,
        )
        agent1 = OMA(registry=reg1, config=config1, memory_dir=str(mem_dir))
        result1 = agent1.run(objective="Large multi-phase build")

        assert result1.status == Status.PARKED
        assert result1.task_id is not None
        handoff_file = mem_dir / f"{result1.task_id}.json"
        assert handoff_file.exists()

        # Step 2: Resume task from persistent memory
        long_solution = ("Completed the remaining work successfully with final artifacts.\n" * 20)
        p2 = MockProvider("p2", [
            ProviderResponse(
                text=long_solution,
                tokens_in=50, tokens_out=150,
                model="p2", provider="p2", latency_ms=5.0,
            )
        ])
        reg2 = ProviderRegistry()
        reg2.register("p2", p2)

        config2 = LoopConfig(
            token_budget=10_000,
            confidence_threshold=0.6,
            provider_chain=["p2"],
        )
        agent2 = OMA(registry=reg2, config=config2, memory_dir=str(mem_dir))
        result2 = agent2.run(
            objective="Large multi-phase build",
            criteria={"Completed": True},
            resume_from=result1.task_id,
        )

        assert result2.status == Status.DONE
        assert "Completed the remaining work" in result2.artifacts.get("final", "")


class TestCLIFunctional:
    """Test CLI commands end-to-end via cli module dispatch."""

    def test_cli_auth_lifecycle(self, tmp_path, monkeypatch):
        cred_path = tmp_path / "creds.json"
        orig_init = CredentialStore.__init__
        monkeypatch.setattr(
            CredentialStore,
            "__init__",
            lambda self, path=None: orig_init(self, path=cred_path)
        )

        import sys

        from oma.cli import main

        # 1. Add sessional key for claude
        monkeypatch.setattr(sys, "argv", ["oma", "auth", "add", "claude",
                                          "sessionKey=sk-ant-sid01-mykey", "--plan", "pro"])
        main()

        # 2. Add API key for deepseek
        monkeypatch.setattr(sys, "argv", ["oma", "auth", "add", "deepseek", "sk-deepseek-key-123"])
        main()

        # 3. Check status
        monkeypatch.setattr(sys, "argv", ["oma", "auth", "status"])
        main()

        store = CredentialStore(path=cred_path)
        claude_cred = store.get("claude")
        deepseek_cred = store.get("deepseek")

        assert claude_cred is not None
        assert claude_cred.auth_type == "cookie"
        assert claude_cred.value == "sk-ant-sid01-mykey"
        assert claude_cred.plan == "pro"

        assert deepseek_cred is not None
        assert deepseek_cred.auth_type == "api_key"
        assert deepseek_cred.value == "sk-deepseek-key-123"

        # 4. Remove claude
        monkeypatch.setattr(sys, "argv", ["oma", "auth", "remove", "claude"])
        main()

        store_after = CredentialStore(path=cred_path)
        assert store_after.get("claude") is None
        assert store_after.get("deepseek") is not None

    def test_cli_auth_info_and_flush_flow(self, tmp_path, monkeypatch):
        cred_path = tmp_path / "creds.json"
        mem_path = tmp_path / "mem"
        mem_path.mkdir()
        (mem_path / "test-task.json").write_text('{"task": "data"}')

        orig_init = CredentialStore.__init__
        monkeypatch.setattr(
            CredentialStore,
            "__init__",
            lambda self, path=None: orig_init(self, path=cred_path)
        )

        import sys

        from oma.cli import main

        # Add credentials
        monkeypatch.setattr(sys, "argv", ["oma", "auth", "add", "deepseek", "sk-deepseek-12345678"])
        main()
        assert cred_path.exists()

        # Run info command
        monkeypatch.setattr(sys, "argv", ["oma", "auth", "info"])
        main()

        # Flush all with memory
        monkeypatch.setattr(sys, "argv", [
            "oma", "auth", "flush", "--all", "-y",
            "--include-memory", "--memory-dir", str(mem_path)
        ])
        main()

        assert not cred_path.exists()
        assert len(list(mem_path.glob("*.json"))) == 0

    def test_cli_memory_list_and_flush(self, tmp_path, monkeypatch):
        mem_path = tmp_path / "mem_dir"
        pm = PersistentMemory(base_dir=str(mem_path))
        pm.save("t1", {"val": 1})
        pm.save("t2", {"val": 2})

        import sys

        from oma.cli import main

        # List memory
        monkeypatch.setattr(sys, "argv", ["oma", "memory", "list", "--dir", str(mem_path)])
        main()

        # Flush t1
        monkeypatch.setattr(sys, "argv", ["oma", "memory", "flush", "--dir", str(mem_path), "--task-id", "t1", "-y"])
        main()
        assert pm.list_tasks() == ["t2"]

        # Flush all
        monkeypatch.setattr(sys, "argv", ["oma", "memory", "flush", "--dir", str(mem_path), "-y"])
        main()
        assert pm.list_tasks() == []
