"""
Unit & Functional tests for Laya Classifier and Task Encapsulation.

Covers:
  - Task classification across domains (coding, research, math, automation, general)
  - Complexity calibration (simple, moderate, complex)
  - Agent and sub-agent task encapsulation
  - State serializability (Invariant 1: to_dict / from_dict)
  - System 1 Quality Gate / Decision Judge evaluation
  - OMA top-level orchestrator integration
"""

import pytest

from oma import OMA
from oma.core.laya_classifier import (
    GateResult,
    LayaClassifier,
    RoutingDecision,
    SubTaskSpec,
    TaskCategory,
    TaskComplexity,
    TaskEncapsulation,
)
from oma.providers.registry import ProviderRegistry

pytestmark = pytest.mark.unit


class TestTaskEncapsulationSerialization:
    """Test OMA Invariant 1: State is always serializable and resumable."""

    def test_subtask_spec_serialization(self):
        spec = SubTaskSpec(
            id="task_123_impl",
            role="Core Implementer",
            sub_agent_type="sub_agent",
            objective="Write Python parser",
            expected_output="parser.py code",
            priority=2,
        )
        d = spec.to_dict()
        assert d["role"] == "Core Implementer"
        assert d["priority"] == 2

        restored = SubTaskSpec.from_dict(d)
        assert restored.id == spec.id
        assert restored.role == spec.role
        assert restored.objective == spec.objective
        assert restored.priority == spec.priority

    def test_task_encapsulation_roundtrip(self):
        encap = TaskEncapsulation(
            task_id="task_001",
            objective="Build a robust CSV parsing engine in Python with error recovery",
            category=TaskCategory.CODING,
            complexity=TaskComplexity.COMPLEX,
            assigned_agent="coding_agent",
            sub_agents=[
                SubTaskSpec(
                    id="sub_1",
                    role="Architect",
                    sub_agent_type="sub_agent",
                    objective="Design interfaces",
                    expected_output="specs",
                    priority=1,
                )
            ],
            routing_decision=RoutingDecision.DECOMPOSE_SUBAGENTS,
            confidence=0.96,
            recommended_provider="claude",
            criteria={"compiles": True, "tests_pass": True},
            context="initial context",
            metadata={"source": "test"},
        )

        serialized = encap.to_dict()
        assert isinstance(serialized, dict)
        assert serialized["category"] == "coding"
        assert serialized["complexity"] == "complex"
        assert serialized["routing_decision"] == "decompose_subagents"
        assert len(serialized["sub_agents"]) == 1

        deserialized = TaskEncapsulation.from_dict(serialized)
        assert deserialized.task_id == "task_001"
        assert deserialized.category == TaskCategory.CODING
        assert deserialized.complexity == TaskComplexity.COMPLEX
        assert deserialized.routing_decision == RoutingDecision.DECOMPOSE_SUBAGENTS
        assert deserialized.confidence == 0.96
        assert len(deserialized.sub_agents) == 1
        assert deserialized.sub_agents[0].role == "Architect"


class TestLayaClassifierEncapsulation:
    """Test task domain classification and agent/sub-agent encapsulation."""

    @pytest.fixture
    def classifier(self):
        return LayaClassifier(prefer_local_engine=True)

    def test_classify_coding_task(self, classifier):
        task = "Write a Python parser for JSON with unit tests and bug fixes"
        encap = classifier.encapsulate(task)

        assert encap.category == TaskCategory.CODING
        assert encap.assigned_agent == "coding_agent"
        assert encap.recommended_provider == "claude"
        assert encap.confidence >= 0.75
        assert len(encap.sub_agents) > 0
        roles = [s.role for s in encap.sub_agents]
        assert any("Implement" in r or "Architect" in r for r in roles)

    def test_classify_research_task(self, classifier):
        task = "Research and summarize the literature on transformers and deep learning benchmarks"
        encap = classifier.encapsulate(task)

        assert encap.category == TaskCategory.RESEARCH
        assert encap.assigned_agent == "research_agent"
        assert encap.recommended_provider == "gemini"
        assert encap.confidence >= 0.75
        assert len(encap.sub_agents) > 0
        roles = [s.role for s in encap.sub_agents]
        assert any("Harvester" in r or "Synthesis" in r for r in roles)

    def test_classify_automation_task(self, classifier):
        task = "Automate browser login, navigate to settings page and scrape profile details"
        encap = classifier.encapsulate(task)

        assert encap.category == TaskCategory.AUTOMATION
        assert encap.assigned_agent == "automation_agent"
        assert encap.confidence >= 0.75
        assert len(encap.sub_agents) > 0

    def test_classify_math_task(self, classifier):
        task = "Solve the differential equation and calculate matrix eigenvalues"
        encap = classifier.encapsulate(task)

        assert encap.category == TaskCategory.MATH_LOGIC
        assert encap.assigned_agent == "math_agent"
        assert encap.recommended_provider == "deepseek"

    def test_classify_simple_general_task(self, classifier):
        task = "Hello, how are you today?"
        encap = classifier.encapsulate(task)

        assert encap.category == TaskCategory.GENERAL
        assert encap.complexity == TaskComplexity.SIMPLE
        assert encap.routing_decision == RoutingDecision.EXECUTE_DIRECT
        assert len(encap.sub_agents) == 0


class TestLayaQualityGate:
    """Test System 1 Decision Gate (Laya quality judge)."""

    @pytest.fixture
    def classifier(self):
        return LayaClassifier(prefer_local_engine=True)

    def test_quality_gate_passes_healthy_output(self, classifier):
        good_output = "The CSV parser implementation is complete and all unit tests pass successfully with 100% coverage."
        result = classifier.evaluate_quality(good_output, criteria={"unit tests": True})

        assert isinstance(result, GateResult)
        assert result.passed is True
        assert result.decision == "PASSED"
        assert result.confidence >= 0.90
        assert result.score >= 0.90
        assert "verified by Laya" in result.notes

    def test_quality_gate_rejects_failure_output(self, classifier):
        fail_output = "Traceback (most recent call last): Error: parser failed to compile token"
        result = classifier.evaluate_quality(fail_output)

        assert result.passed is False
        assert result.decision == "FAILOVER"
        assert result.score < 0.50

    def test_quality_gate_rejects_empty_output(self, classifier):
        result = classifier.evaluate_quality("short")
        assert result.passed is False
        assert result.decision == "FAILOVER"


class TestOMAIntegrationWithLaya:
    """Test top-level OMA integration with LayaClassifier."""

    def test_oma_has_classifier_instance(self):
        reg = ProviderRegistry()
        agent = OMA(registry=reg)

        assert hasattr(agent, "classifier")
        assert isinstance(agent.classifier, LayaClassifier)

    def test_oma_classify_task_method(self):
        reg = ProviderRegistry()
        agent = OMA(registry=reg)

        encap = agent.classify_task(
            objective="Develop a high-performance HTTP client in Python",
            criteria={"async_support": True},
        )
        assert isinstance(encap, TaskEncapsulation)
        assert encap.category == TaskCategory.CODING
        assert encap.assigned_agent == "coding_agent"
        assert encap.criteria == {"async_support": True}
