"""Tests for edge handlers."""

import pytest
from oma.core.edge import HandoffNote, near_outage_handler, outage_recovery_prompt
from oma.core.loop import TaskState, Status
from oma.automation.memory import WorkingMemory

pytestmark = pytest.mark.unit


class TestHandoffNote:
    def test_to_prompt_format(self):
        note = HandoffNote(
            task_id="abc123",
            objective="build a scraper",
            status="near_outage",
            reason="tokens 9500/10000",
            completed_steps=["step 1: parsed HTML"],
            remaining_steps=["step 2: extract data", "step 3: save output"],
            confidence_so_far=0.65,
            priority_order=["extract data", "save output"],
        )
        prompt = note.to_prompt()
        assert "abc123" in prompt
        assert "build a scraper" in prompt
        assert "near_outage" in prompt
        assert "GRAB THIS FIRST" not in prompt  # no critical context
        assert "COMPLETED" in prompt
        assert "REMAINING" in prompt
        assert "PRIORITY ORDER" in prompt

    def test_to_prompt_with_critical_context(self):
        note = HandoffNote(
            task_id="x",
            objective="o",
            status="outage",
            reason="crash",
            critical_context="the API key is in env var XYZ",
        )
        prompt = note.to_prompt()
        assert "GRAB THIS FIRST" in prompt
        assert "API key" in prompt

    def test_to_dict(self):
        note = HandoffNote(
            task_id="x",
            objective="o",
            status="parked",
            reason="timeout",
        )
        d = note.to_dict()
        assert d["task_id"] == "x"
        assert d["status"] == "parked"


class TestNearOutageHandler:
    def test_produces_handoff(self):
        state = TaskState(
            task_id="test",
            objective="do something",
            tokens_budget=10000,
            tokens_used=9500,
            confidence=0.6,
        )
        state.progress = [
            (1, "partial result", 0.4),
            (2, "better result", 0.6),
        ]
        state.criteria = {"accuracy": 0.8}
        state.artifacts = {"draft": "some draft"}

        wm = WorkingMemory()
        wm.put("context", "important fact", tags=["fact"])

        note = near_outage_handler(
            task_state=state,
            working_memory=wm,
            remaining_features=["feature A", "feature B"],
        )

        assert note.status == "near_outage"
        assert len(note.completed_steps) == 2
        assert len(note.remaining_steps) == 2
        assert note.priority_order == ["feature A", "feature B"]
        assert note.confidence_so_far == 0.6


class TestOutageRecoveryPrompt:
    def test_includes_fork_and_checklist(self):
        note = HandoffNote(
            task_id="x",
            objective="build OMA",
            status="outage",
            reason="crash",
            priority_order=["core loop", "sanitizer", "GUI"],
        )

        prompt = outage_recovery_prompt(
            note,
            fork_repo="https://github.com/user/oma-fork",
            target_platform="macos",
        )

        assert "fork of open-multi-agent" in prompt
        assert "macos" in prompt
        assert "[ ] 1. core loop" in prompt
        assert "[ ] 2. sanitizer" in prompt
        assert "[ ] 3. GUI" in prompt
        assert "oma-fork" in prompt
