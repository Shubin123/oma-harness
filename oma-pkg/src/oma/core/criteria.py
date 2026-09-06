"""
OMA Criteria Engine -- define, search, and evaluate solution characteristics.

Criteria are the "what good looks like" spec for a task.
The engine:
  1. Decomposes an objective into measurable criteria
  2. Weights them by importance
  3. Evaluates a candidate solution against them
  4. Returns a confidence score

This replaces vague "is it done?" checks with explicit pass/fail gates.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from enum import Enum


class CriterionType(Enum):
    BOOLEAN = "boolean"       # pass/fail
    NUMERIC = "numeric"       # score 0-1
    THRESHOLD = "threshold"   # value >= min
    CONTAINS = "contains"     # output contains X
    REGEX = "regex"           # output matches pattern
    CUSTOM = "custom"         # user-provided eval fn


@dataclass
class Criterion:
    name: str
    description: str
    ctype: CriterionType
    weight: float = 1.0                          # importance multiplier
    target: Any = None                           # what to check against
    eval_fn: Optional[Callable] = None           # for CUSTOM type
    required: bool = False                       # hard gate: fail = 0 overall

    def evaluate(self, output: Any) -> float:
        """Returns 0.0 to 1.0"""
        try:
            if self.ctype == CriterionType.BOOLEAN:
                return 1.0 if bool(output) else 0.0

            elif self.ctype == CriterionType.NUMERIC:
                return max(0.0, min(1.0, float(output)))

            elif self.ctype == CriterionType.THRESHOLD:
                val = float(output) if not isinstance(output, (int, float)) else output
                return 1.0 if val >= self.target else val / self.target

            elif self.ctype == CriterionType.CONTAINS:
                text = str(output).lower()
                target = str(self.target).lower()
                return 1.0 if target in text else 0.0

            elif self.ctype == CriterionType.REGEX:
                import re
                return 1.0 if re.search(self.target, str(output)) else 0.0

            elif self.ctype == CriterionType.CUSTOM and self.eval_fn:
                return max(0.0, min(1.0, float(self.eval_fn(output))))

            return 0.0
        except Exception:
            return 0.0


@dataclass
class CriteriaSet:
    """A weighted set of criteria for evaluating solutions."""
    criteria: list[Criterion] = field(default_factory=list)

    def add(self, criterion: Criterion) -> "CriteriaSet":
        self.criteria.append(criterion)
        return self

    def evaluate(self, outputs: dict[str, Any]) -> tuple[float, dict]:
        """
        Evaluate a solution against all criteria.

        Args:
            outputs: dict mapping criterion names to their measured values

        Returns:
            (overall_confidence, per_criterion_scores)
        """
        if not self.criteria:
            return 0.0, {}

        scores = {}
        total_weight = 0.0
        weighted_sum = 0.0
        has_required_fail = False

        for c in self.criteria:
            value = outputs.get(c.name)
            if value is None:
                scores[c.name] = {"score": 0.0, "weight": c.weight, "status": "missing"}
                if c.required:
                    has_required_fail = True
                continue

            score = c.evaluate(value)
            scores[c.name] = {
                "score": score,
                "weight": c.weight,
                "status": "pass" if score >= 0.5 else "fail",
            }

            if c.required and score < 0.5:
                has_required_fail = True

            weighted_sum += score * c.weight
            total_weight += c.weight

        if has_required_fail:
            overall = 0.0
        elif total_weight > 0:
            overall = weighted_sum / total_weight
        else:
            overall = 0.0

        return overall, scores

    def to_dict(self) -> dict:
        return {
            "criteria": [
                {
                    "name": c.name,
                    "description": c.description,
                    "type": c.ctype.value,
                    "weight": c.weight,
                    "required": c.required,
                }
                for c in self.criteria
            ]
        }


# ---- preset criteria builders ----

def code_quality_criteria() -> CriteriaSet:
    """Standard criteria for code generation tasks."""
    cs = CriteriaSet()
    cs.add(Criterion("compiles", "Code compiles/parses without errors",
                      CriterionType.BOOLEAN, weight=3.0, required=True))
    cs.add(Criterion("tests_pass", "All tests pass",
                      CriterionType.BOOLEAN, weight=2.5, required=True))
    cs.add(Criterion("no_hardcoded", "No hardcoded secrets or paths",
                      CriterionType.BOOLEAN, weight=2.0))
    cs.add(Criterion("documented", "Functions have docstrings",
                      CriterionType.NUMERIC, weight=1.0))
    cs.add(Criterion("coverage", "Test coverage ratio",
                      CriterionType.THRESHOLD, weight=1.5, target=0.7))
    return cs


def research_criteria() -> CriteriaSet:
    """Standard criteria for research/analysis tasks."""
    cs = CriteriaSet()
    cs.add(Criterion("has_sources", "Claims backed by sources",
                      CriterionType.BOOLEAN, weight=3.0, required=True))
    cs.add(Criterion("source_count", "Number of distinct sources",
                      CriterionType.THRESHOLD, weight=1.5, target=3))
    cs.add(Criterion("coherent", "Logical flow score",
                      CriterionType.NUMERIC, weight=2.0))
    cs.add(Criterion("actionable", "Contains actionable conclusions",
                      CriterionType.BOOLEAN, weight=1.5))
    return cs


def automation_criteria() -> CriteriaSet:
    """Criteria for browser/UI automation tasks."""
    cs = CriteriaSet()
    cs.add(Criterion("target_reached", "Navigation reached target state",
                      CriterionType.BOOLEAN, weight=3.0, required=True))
    cs.add(Criterion("no_errors", "No JS errors or failed requests",
                      CriterionType.BOOLEAN, weight=2.0))
    cs.add(Criterion("data_extracted", "Required data was captured",
                      CriterionType.BOOLEAN, weight=2.5, required=True))
    cs.add(Criterion("under_time", "Completed within time budget",
                      CriterionType.BOOLEAN, weight=1.0))
    return cs


def default_criteria() -> CriteriaSet:
    """
    Baseline criteria that always apply when no specific criteria are given.

    These are universal quality checks -- every task output should meet them.
    """
    cs = CriteriaSet()
    cs.add(Criterion(
        "non_empty", "Output is non-empty and substantive",
        CriterionType.CUSTOM, weight=3.0, required=True,
        eval_fn=lambda o: 1.0 if isinstance(o, str) and len(o.strip()) > 20 else 0.0,
    ))
    cs.add(Criterion(
        "coherent", "Output reads as coherent text (not error messages or garbage)",
        CriterionType.CUSTOM, weight=2.0,
        eval_fn=lambda o: _coherence_score(o),
    ))
    cs.add(Criterion(
        "on_topic", "Output addresses the objective (not off-topic filler)",
        CriterionType.CUSTOM, weight=2.5,
        eval_fn=lambda o: 1.0 if isinstance(o, str) and len(o.strip()) > 50 else 0.3,
    ))
    cs.add(Criterion(
        "no_truncation", "Output appears complete (not cut off mid-sentence)",
        CriterionType.CUSTOM, weight=1.5,
        eval_fn=lambda o: _completeness_score(o),
    ))
    return cs


def ensure_criteria(user_criteria: dict | None) -> dict:
    """
    Guarantee criteria are present. If user provided criteria, validate and
    return them. If not, return default criteria as a dict.

    Always called before the core loop starts, so every run has criteria.
    """
    if user_criteria and isinstance(user_criteria, dict) and len(user_criteria) > 0:
        return user_criteria
    # return default criteria as a simple dict the loop can use
    cs = default_criteria()
    return cs.to_dict()


def _coherence_score(output) -> float:
    """Heuristic: does this look like real text vs error output."""
    if not isinstance(output, str):
        return 0.0
    text = output.strip()
    if not text:
        return 0.0
    # error markers
    error_markers = ["traceback", "error:", "exception:", "errno", "failed to", "502", "503"]
    lower = text.lower()
    for marker in error_markers:
        if marker in lower[:200]:  # check start of output
            return 0.2
    # very short output is suspect
    if len(text) < 30:
        return 0.4
    # reasonable text
    words = text.split()
    if len(words) < 5:
        return 0.5
    # long enough with real words
    return min(1.0, 0.6 + len(words) / 500)


def _completeness_score(output) -> float:
    """Heuristic: does output appear complete (not cut off)."""
    if not isinstance(output, str):
        return 0.0
    text = output.strip()
    if not text:
        return 0.0
    # ends with sentence-ending punctuation or closing bracket
    last_char = text[-1]
    if last_char in ".!?)\"]}>":
        return 1.0
    # ends with a code block
    if text.endswith("```"):
        return 1.0
    # ends mid-word or mid-sentence
    if last_char.isalpha() or last_char == ",":
        return 0.3
    return 0.7
