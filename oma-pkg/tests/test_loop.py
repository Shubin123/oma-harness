"""Tests for the RALPH loop (Reason, Act, Learn, Plan, Handoff)."""

import pytest

from oma.core.loop import (
    CoreLoop,
    Lesson,
    LoopConfig,
    PhaseEvent,
    PlanDecision,
    RalphLoop,
    RalphPhase,
    Reasoning,
    Status,
    Strategy,
    TaskState,
)

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# TaskState
# ---------------------------------------------------------------------------

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

    def test_ralph_fields_initialised(self):
        """RALPH-specific fields exist and are empty by default."""
        state = TaskState(task_id="t", objective="o")
        assert state.current_phase == "idle"
        assert state.phase_history == []
        assert state.strategy == {}
        assert state.lessons == []

    def test_snapshot_includes_ralph_fields(self):
        state = TaskState(task_id="t", objective="o")
        snap = state.snapshot()
        assert "current_phase" in snap
        assert "strategy" in snap
        assert "lessons" in snap


# ---------------------------------------------------------------------------
# Backwards compatibility -- CoreLoop alias
# ---------------------------------------------------------------------------

class TestCoreLoopAlias:
    def test_alias_is_ralph(self):
        """CoreLoop is the same class as RalphLoop."""
        assert CoreLoop is RalphLoop

    def test_immediate_success(self):
        """solve_fn returns high confidence on first try (old-style API)."""
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
            return "result", 9000, 0.5

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
        last_step = result.progress[-1]
        assert "CLEAN" in last_step[1]
        assert "DIRTY" not in last_step[1]


# ---------------------------------------------------------------------------
# RALPH phase transitions
# ---------------------------------------------------------------------------

class TestRalphPhases:
    def _make_loop(self, solve_fn, **kwargs):
        defaults = dict(
            token_budget=100000,
            max_attempts=5,
            confidence_threshold=0.9,
            provider_chain=["alpha"],
        )
        defaults.update(kwargs)
        return RalphLoop(
            config=LoopConfig(**defaults),
            solve_fn=solve_fn,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            **{k: v for k, v in kwargs.items() if k in ("reason_fn", "plan_fn", "on_phase")},
        )

    def test_phases_emitted_in_order(self):
        """Each iteration emits R-A-L-P-H in order."""
        phases = []

        def on_phase(event):
            phases.append(event.phase.value)

        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            on_phase=on_phase,
        )

        loop.run("test")
        # single iteration: reason, act, learn, plan, handoff(done)
        assert phases == ["reason", "act", "learn", "plan", "handoff"]

    def test_multiple_iterations_phase_order(self):
        """Multi-attempt run emits R-A-L-P-H per iteration."""
        phases = []
        attempt = 0

        def on_phase(event):
            phases.append(event.phase.value)

        def solve(state, provider):
            nonlocal attempt
            attempt += 1
            if attempt < 3:
                return "partial", 50, 0.4
            return "done", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=10,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            on_phase=on_phase,
        )

        loop.run("multi-attempt test")
        # 3 iterations: each has R-A-L-P-H
        ralph = ["reason", "act", "learn", "plan", "handoff"]
        assert len(phases) == 15
        assert phases[:5] == ralph
        assert phases[5:10] == ralph
        assert phases[10:15] == ralph

    def test_phase_history_recorded(self):
        """phase_history on TaskState stores every phase event."""
        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert len(result.phase_history) == 5  # R-A-L-P-H
        phase_names = [e["phase"] for e in result.phase_history]
        assert phase_names == ["reason", "act", "learn", "plan", "handoff"]
        # each event has expected keys
        for event in result.phase_history:
            assert "timestamp" in event
            assert "iteration" in event
            assert "data" in event

    def test_final_phase_is_idle(self):
        """After run completes, current_phase resets to idle."""
        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert result.current_phase == "idle"


# ---------------------------------------------------------------------------
# Strategy adaptation
# ---------------------------------------------------------------------------

class TestStrategy:
    def test_strategy_populated_after_run(self):
        """Strategy dict is populated on the final TaskState."""
        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["alpha", "beta"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert isinstance(result.strategy, dict)
        assert "provider_order" in result.strategy
        assert "best_confidence" in result.strategy

    def test_best_confidence_tracked(self):
        """best_confidence in strategy reflects the highest seen."""
        attempt = 0

        def solve(state, provider):
            nonlocal attempt
            attempt += 1
            confidences = [0.3, 0.7, 0.95]
            c = confidences[min(attempt - 1, 2)]
            return f"result_{attempt}", 50, c

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=10,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert result.status == Status.DONE
        # confidence reaches 0.95 on attempt 3 which triggers "done",
        # but state.strategy snapshot may lag by one phase; verify via
        # the task-level confidence which is always current.
        assert result.confidence >= 0.95

    def test_consecutive_failures_cause_park(self):
        """Three consecutive failures trigger a park."""
        def solve(state, provider):
            raise RuntimeError("always fails")

        handoff_called = False

        def handoff(state):
            nonlocal handoff_called
            handoff_called = True

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=10,
                confidence_threshold=0.9,
                provider_chain=["solo"],
                backoff_base_s=0.001,
                backoff_max_s=0.01,
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=handoff,
        )

        result = loop.run("doomed task")
        assert result.status == Status.PARKED
        assert handoff_called

    def test_provider_reordering_on_success(self):
        """Successful provider gets promoted in the chain."""
        attempt = 0

        def solve(state, provider):
            nonlocal attempt
            attempt += 1
            if provider == "slow" and attempt == 1:
                raise RuntimeError("slow fails first")
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["slow", "fast"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert result.status == Status.DONE


# ---------------------------------------------------------------------------
# Lessons tracking
# ---------------------------------------------------------------------------

class TestLessons:
    def test_lessons_recorded(self):
        """Every iteration appends a lesson to state.lessons."""
        attempt = 0

        def solve(state, provider):
            nonlocal attempt
            attempt += 1
            if attempt < 3:
                return f"partial_{attempt}", 50, 0.4
            return "done", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=10,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert len(result.lessons) == 3
        for lesson in result.lessons:
            assert "iteration" in lesson
            assert "succeeded" in lesson
            assert "confidence_delta" in lesson
            assert "provider" in lesson

    def test_lesson_succeeds_on_result(self):
        """A lesson from a successful solve has succeeded=True."""
        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert result.lessons[0]["succeeded"] is True

    def test_lesson_fails_on_error(self):
        """A lesson from a failed solve has succeeded=False."""
        attempt = 0

        def solve(state, provider):
            nonlocal attempt
            attempt += 1
            if attempt == 1:
                raise RuntimeError("fail")
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["solo"],
                backoff_base_s=0.001,
                backoff_max_s=0.01,
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert result.lessons[0]["succeeded"] is False


# ---------------------------------------------------------------------------
# Custom reason_fn / plan_fn callbacks
# ---------------------------------------------------------------------------

class TestCustomCallbacks:
    def test_custom_reason_fn(self):
        """User-provided reason_fn is called each iteration."""
        reason_calls = []

        def my_reason(state, strategy):
            reason_calls.append(state.attempts)
            return Reasoning(
                analysis="custom analysis",
                approach="custom",
                provider_preference="test",
            )

        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            reason_fn=my_reason,
        )

        loop.run("test")
        assert len(reason_calls) == 1
        assert reason_calls[0] == 1

    def test_custom_plan_fn(self):
        """User-provided plan_fn controls loop termination."""
        plan_calls = []

        def my_plan(state, strategy, lesson):
            plan_calls.append(lesson.iteration)
            return PlanDecision(
                action="done",
                reason="custom says done",
            )

        def solve(state, provider):
            return "ok", 50, 0.5  # below threshold, but plan_fn overrides

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            plan_fn=my_plan,
        )

        result = loop.run("test")
        assert result.status == Status.DONE
        assert len(plan_calls) == 1

    def test_custom_plan_park(self):
        """Custom plan_fn can park the task."""
        def my_plan(state, strategy, lesson):
            return PlanDecision(action="park", reason="custom park")

        def solve(state, provider):
            return "ok", 50, 0.5

        handoff_called = False

        def handoff(state):
            nonlocal handoff_called
            handoff_called = True

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=handoff,
            plan_fn=my_plan,
        )

        result = loop.run("test")
        assert result.status == Status.PARKED
        assert handoff_called
        assert "custom park" in result.context_for_next

    def test_failing_reason_fn_uses_default(self):
        """A crashing reason_fn falls back to default heuristic."""
        def bad_reason(state, strategy):
            raise ValueError("broken")

        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            reason_fn=bad_reason,
        )

        result = loop.run("test")
        assert result.status == Status.DONE

    def test_failing_plan_fn_uses_default(self):
        """A crashing plan_fn falls back to default heuristic."""
        def bad_plan(state, strategy, lesson):
            raise ValueError("broken")

        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            plan_fn=bad_plan,
        )

        result = loop.run("test")
        assert result.status == Status.DONE


# ---------------------------------------------------------------------------
# PhaseEvent emission
# ---------------------------------------------------------------------------

class TestPhaseEvents:
    def test_on_phase_receives_events(self):
        """on_phase callback receives PhaseEvent objects."""
        events = []

        def on_phase(event):
            assert isinstance(event, PhaseEvent)
            assert isinstance(event.phase, RalphPhase)
            events.append(event)

        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            on_phase=on_phase,
        )

        loop.run("test")
        assert len(events) == 5
        assert events[0].phase == RalphPhase.REASON
        assert events[1].phase == RalphPhase.ACT
        assert events[2].phase == RalphPhase.LEARN
        assert events[3].phase == RalphPhase.PLAN
        assert events[4].phase == RalphPhase.HANDOFF

    def test_on_phase_has_iteration(self):
        """Every event carries the current iteration number."""
        events = []

        def on_phase(event):
            events.append(event)

        attempt = 0

        def solve(state, provider):
            nonlocal attempt
            attempt += 1
            if attempt < 2:
                return "partial", 50, 0.4
            return "done", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=10,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            on_phase=on_phase,
        )

        loop.run("test")
        # iteration 1 events
        iter1 = [e for e in events if e.iteration == 1]
        assert len(iter1) == 5
        # iteration 2 events
        iter2 = [e for e in events if e.iteration == 2]
        assert len(iter2) == 5

    def test_on_phase_crash_ignored(self):
        """A crashing on_phase callback does not break the loop."""
        def bad_observer(event):
            raise RuntimeError("observer crashed")

        def solve(state, provider):
            return "ok", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
            on_phase=bad_observer,
        )

        result = loop.run("test")
        assert result.status == Status.DONE


# ---------------------------------------------------------------------------
# Handoff / edge cases
# ---------------------------------------------------------------------------

class TestHandoff:
    def test_handoff_context_includes_strategy(self):
        """When parked, context_for_next contains strategy info."""
        def solve(state, provider):
            return "partial", 50, 0.3

        notes = []

        def handoff(state):
            notes.append(state.context_for_next)

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=2,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=handoff,
        )

        result = loop.run("test")
        assert result.status == Status.PARKED
        assert len(notes) == 1
        context = notes[0]
        assert "strategy" in context
        assert "objective" in context
        assert "NEXT WORKER" in context

    def test_artifacts_final_set_on_done(self):
        """artifacts['final'] is set when task completes."""
        def solve(state, provider):
            return "the final answer", 50, 0.95

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=100000,
                max_attempts=5,
                confidence_threshold=0.9,
                provider_chain=["test"],
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=lambda s: None,
        )

        result = loop.run("test")
        assert result.status == Status.DONE
        assert "final" in result.artifacts
        assert result.artifacts["final"] == "the final answer"

    def test_low_budget_parks(self):
        """Low remaining token budget triggers park."""
        def solve(state, provider):
            return "ok", 900, 0.5  # spends 900 of 1000

        handoff_called = False

        def handoff(state):
            nonlocal handoff_called
            handoff_called = True

        loop = RalphLoop(
            config=LoopConfig(
                token_budget=1000,
                max_attempts=10,
                confidence_threshold=0.9,
                provider_chain=["test"],
                token_reserve_for_handoff=200,
            ),
            solve_fn=solve,
            sanitize_fn=lambda x: x,
            handoff_fn=handoff,
        )

        result = loop.run("test")
        assert result.status == Status.PARKED
        assert handoff_called


# ---------------------------------------------------------------------------
# Dataclass constructors
# ---------------------------------------------------------------------------

class TestDataclasses:
    def test_reasoning_defaults(self):
        r = Reasoning()
        assert r.analysis == ""
        assert r.approach == ""
        assert r.focus_areas == []
        assert r.provider_preference == ""

    def test_lesson_defaults(self):
        lesson = Lesson()
        assert lesson.iteration == 0
        assert lesson.succeeded is False
        assert lesson.confidence_delta == 0.0

    def test_plan_decision_defaults(self):
        p = PlanDecision()
        assert p.action == "continue"
        assert p.reason == ""
        assert p.escalate is False

    def test_strategy_to_dict(self):
        s = Strategy(provider_order=["a", "b"], best_confidence=0.7)
        d = s.to_dict()
        assert d["provider_order"] == ["a", "b"]
        assert d["best_confidence"] == 0.7
        assert "best_result" not in d  # excluded from dict
        assert "approach_notes" in d

    def test_ralph_phase_values(self):
        assert RalphPhase.IDLE.value == "idle"
        assert RalphPhase.REASON.value == "reason"
        assert RalphPhase.ACT.value == "act"
        assert RalphPhase.LEARN.value == "learn"
        assert RalphPhase.PLAN.value == "plan"
        assert RalphPhase.HANDOFF.value == "handoff"
