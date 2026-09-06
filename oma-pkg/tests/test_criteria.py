"""Tests for the criteria engine."""

import pytest
from oma.core.criteria import (
    Criterion,
    CriterionType,
    CriteriaSet,
    code_quality_criteria,
    research_criteria,
    automation_criteria,
)


class TestCriterion:
    def test_boolean_true(self):
        c = Criterion("test", "desc", CriterionType.BOOLEAN)
        assert c.evaluate(True) == 1.0

    def test_boolean_false(self):
        c = Criterion("test", "desc", CriterionType.BOOLEAN)
        assert c.evaluate(False) == 0.0

    def test_numeric_clamp(self):
        c = Criterion("test", "desc", CriterionType.NUMERIC)
        assert c.evaluate(0.5) == 0.5
        assert c.evaluate(1.5) == 1.0
        assert c.evaluate(-0.5) == 0.0

    def test_threshold_met(self):
        c = Criterion("test", "desc", CriterionType.THRESHOLD, target=0.7)
        assert c.evaluate(0.8) == 1.0

    def test_threshold_partial(self):
        c = Criterion("test", "desc", CriterionType.THRESHOLD, target=1.0)
        score = c.evaluate(0.5)
        assert score == pytest.approx(0.5)

    def test_contains_found(self):
        c = Criterion("test", "desc", CriterionType.CONTAINS, target="hello")
        assert c.evaluate("hello world") == 1.0

    def test_contains_missing(self):
        c = Criterion("test", "desc", CriterionType.CONTAINS, target="xyz")
        assert c.evaluate("hello world") == 0.0

    def test_regex_match(self):
        c = Criterion("test", "desc", CriterionType.REGEX, target=r"\d{3}-\d{4}")
        assert c.evaluate("call 555-1234") == 1.0

    def test_regex_no_match(self):
        c = Criterion("test", "desc", CriterionType.REGEX, target=r"\d{3}-\d{4}")
        assert c.evaluate("no numbers") == 0.0

    def test_custom(self):
        c = Criterion("test", "desc", CriterionType.CUSTOM,
                       eval_fn=lambda x: len(x) / 100)
        assert c.evaluate("hello") == pytest.approx(0.05)

    def test_error_returns_zero(self):
        c = Criterion("test", "desc", CriterionType.THRESHOLD, target=0.5)
        assert c.evaluate("not a number") == 0.0


class TestCriteriaSet:
    def test_weighted_evaluation(self):
        cs = CriteriaSet()
        cs.add(Criterion("a", "desc", CriterionType.BOOLEAN, weight=2.0))
        cs.add(Criterion("b", "desc", CriterionType.BOOLEAN, weight=1.0))

        overall, scores = cs.evaluate({"a": True, "b": False})
        # weighted: (1.0*2 + 0.0*1) / 3 = 0.667
        assert overall == pytest.approx(2.0 / 3.0)

    def test_required_failure_zeros_overall(self):
        cs = CriteriaSet()
        cs.add(Criterion("required", "desc", CriterionType.BOOLEAN,
                          weight=1.0, required=True))
        cs.add(Criterion("optional", "desc", CriterionType.BOOLEAN, weight=1.0))

        overall, scores = cs.evaluate({"required": False, "optional": True})
        assert overall == 0.0

    def test_missing_values(self):
        cs = CriteriaSet()
        cs.add(Criterion("present", "desc", CriterionType.BOOLEAN, weight=1.0))
        cs.add(Criterion("missing", "desc", CriterionType.BOOLEAN, weight=1.0))

        overall, scores = cs.evaluate({"present": True})
        assert scores["missing"]["status"] == "missing"

    def test_empty_criteria(self):
        cs = CriteriaSet()
        overall, scores = cs.evaluate({})
        assert overall == 0.0

    def test_to_dict(self):
        cs = CriteriaSet()
        cs.add(Criterion("test", "a test", CriterionType.BOOLEAN, weight=2.0))
        d = cs.to_dict()
        assert len(d["criteria"]) == 1
        assert d["criteria"][0]["name"] == "test"


class TestPresets:
    def test_code_quality_has_required(self):
        cs = code_quality_criteria()
        required = [c for c in cs.criteria if c.required]
        assert len(required) >= 2

    def test_research_has_sources(self):
        cs = research_criteria()
        names = [c.name for c in cs.criteria]
        assert "has_sources" in names

    def test_automation_has_target(self):
        cs = automation_criteria()
        names = [c.name for c in cs.criteria]
        assert "target_reached" in names
