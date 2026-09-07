"""Tests for the memory system."""

import pytest
import tempfile
import os
from oma.automation.memory import WorkingMemory, PersistentMemory, ContextOptimizer

pytestmark = pytest.mark.unit


class TestWorkingMemory:
    def test_put_get(self):
        wm = WorkingMemory()
        wm.put("key1", "value1", tags=["test"])
        assert wm.get("key1") == "value1"

    def test_get_missing(self):
        wm = WorkingMemory()
        assert wm.get("nonexistent") is None

    def test_search_by_tag(self):
        wm = WorkingMemory()
        wm.put("a", 1, tags=["math"])
        wm.put("b", 2, tags=["math", "even"])
        wm.put("c", 3, tags=["math", "odd"])
        wm.put("d", "text", tags=["string"])

        results = wm.search("math")
        assert len(results) == 3

        results = wm.search("even")
        assert len(results) == 1

    def test_lru_eviction(self):
        wm = WorkingMemory(max_entries=3)
        wm.put("a", 1)
        wm.put("b", 2)
        wm.put("c", 3)
        wm.put("d", 4)  # should evict "a"
        assert wm.get("a") is None
        assert wm.get("d") == 4

    def test_ttl_expiry(self):
        wm = WorkingMemory()
        wm.put("temp", "data", ttl_s=0.001)
        import time
        time.sleep(0.01)
        assert wm.get("temp") is None

    def test_summarize(self):
        wm = WorkingMemory()
        wm.put("fact1", "the sky is blue", tags=["fact"])
        wm.put("fact2", "water is wet", tags=["fact"])
        summary = wm.summarize(max_tokens=1000)
        assert "fact1" in summary
        assert "fact2" in summary

    def test_to_dict(self):
        wm = WorkingMemory()
        wm.put("key", "val", tags=["t1"], source="test")
        d = wm.to_dict()
        assert "key" in d
        assert d["key"]["value"] == "val"
        assert d["key"]["source"] == "test"


class TestPersistentMemory:
    def test_save_load(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            pm = PersistentMemory(base_dir=tmpdir)
            pm.save("task1", {"entries": {"x": 1}, "handoffs": []})
            loaded = pm.load("task1")
            assert loaded["entries"]["x"] == 1

    def test_load_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            pm = PersistentMemory(base_dir=tmpdir)
            loaded = pm.load("nonexistent")
            assert "entries" in loaded

    def test_append_handoff(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            pm = PersistentMemory(base_dir=tmpdir)
            pm.append_handoff("task1", "worker 1 done", worker_id="w1")
            pm.append_handoff("task1", "worker 2 done", worker_id="w2")
            loaded = pm.load("task1")
            assert len(loaded["handoffs"]) == 2

    def test_merge_working(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            pm = PersistentMemory(base_dir=tmpdir)
            wm = WorkingMemory()
            wm.put("result", 42, tags=["final"])
            pm.merge_working("task1", wm)
            loaded = pm.load("task1")
            assert "result" in loaded["entries"]


class TestContextOptimizer:
    def test_builds_context(self):
        co = ContextOptimizer(token_budget=10000)
        wm = WorkingMemory()
        wm.put("key", "value")

        system, messages = co.build_context(
            system="You are helpful.",
            task_state={"objective": "test"},
            working=wm,
        )

        assert "You are helpful" in system
        assert "test" in system

    def test_respects_budget(self):
        co = ContextOptimizer(token_budget=100)  # very small
        wm = WorkingMemory()
        for i in range(50):
            wm.put(f"key_{i}", "x" * 100)

        system, messages = co.build_context(
            system="sys",
            task_state={},
            working=wm,
            history=[{"role": "user", "content": "x" * 1000}] * 10,
        )

        # should not include all history
        assert len(messages) < 10
