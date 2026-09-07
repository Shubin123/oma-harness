"""Tests for the core loop."""

import pytest
from oma.core.loop import CoreLoop, LoopConfig, TaskState, Status

pytestmark = pytest.mark.unit


class TestTaskState:
    def test_snapshot_is_dict(self):
        state = TaskState(task_id="test", objective="do something")
        snap = state.snapshot()
        assert isinstance(snap, dict)
        assert snap["task_id"] == "test"
        assert "checksum" in snap

    def test_remaining_tokens(self):
        state = TaskState(task_id="t", objective="o", tokens_budget=1000, tokens_used=300)
        assert state.remaining_tokens() == 700

    def test_near_outage(self):
        state = TaskState(task_id="t", objective="o", tokens_budget=1000, tokens_used=950)
        assert state.is_near_outage(token_reserve=100)
        assert not state.is_near_outage(token_reserve=10)


class TestCoreLoop:
    def test_immediate_success(self):
        """solve_fn returns high confidence on first try."""
        def solve(state, provider):
            return "done", 100, 0.95

        loop = CoreLoop(
            config=LoopConfig(
                token_budget=10000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test task")
        assert result.status == Status.DONE
        assert result.confidence >= 0.9
        assert result.attempts == 1

    def test_max_attempts_park(self):
        """solve_fn always returns low confidence."""
        call_count = 0

        def solve(state, provider):
            nonlocal call_count
            call_count += 1
            return "partial", 10, 0.3

        handoff_called = False

        def handoff(state):
            nonlocal handoff_called
            handoff_called = True

        loop = CoreLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=3,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=handoff,
        )

        result = loop.run("test task")
        assert result.status == Status.PARKED
        assert call_count == 3
        assert handoff_called

    def test_token_near_outage(self):
        """Triggers handoff when tokens run low."""
        def solve(state, provider):
            return "result", 9000, 0.5  # uses most of budget

        handoff_note = []

        def handoff(state):
            handoff_note.append(state.context_for_next)

        loop = CoreLoop(
            config=LoopConfig(
                token_budget=10000,
                max_attempts=10,
                confidence_threshold=0.9,
                provider_chain=["test"],
                token_reserve_for_handoff=3000,
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=handoff,
        )

        result = loop.run("test task")
        assert result.status == Status.PARKED
        assert len(handoff_note) > 0

    def test_provider_fallback(self):
        """First provider fails, second succeeds."""
        calls = []

        def solve(state, provider):
            calls.append(provider)
            if provider == "bad":
                raise RuntimeError("provider down")
            return "ok", 100, 0.95

        loop = CoreLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["bad", "good"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test task")
        assert result.status == Status.DONE
        assert "bad" in calls
        assert "good" in calls

    def test_sanitize_applied(self):
        """Sanitize function is applied to results."""
        def solve(state, provider):
            return "DIRTY output", 100, 0.95

        loop = CoreLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x.replace("DIRTY", "CLEAN"),
            handoff_fn=lambda s: None,
        )

        result = loop.run("test task")
        assert result.status == Status.DONE
        # check the progress log has sanitized version
        last_step = result.progress[-1]
        assert "CLEAN" in last_step[1]
        assert "DIRTY" not in last_step[1]
