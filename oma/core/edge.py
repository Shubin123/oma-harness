"""
OMA Edge Handlers -- graceful degradation at the limits.

Two edge cases, two strategies:

1. NEAR OUTAGE (completion almost done, tokens running low):
   Summarize with remaining tokens. Pack the handoff note with
   everything the next worker needs to immediately pick up.

2. OUTAGE BEFORE COMPLETION (unexpected cutoff):
   The handoff was already being maintained incrementally,
   so the last checkpoint is the recovery point. The next worker
   gets a note pointing to the fork and patches to apply.
"""

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class HandoffNote:
    """
    Everything the next worker needs to resume.
    This is what gets written to disk/memory before outage.
    """
    task_id: str
    objective: str
    status: str                              # near_outage | outage | parked
    reason: str
    timestamp: float = field(default_factory=time.time)

    # what was accomplished
    completed_steps: list = field(default_factory=list)
    artifacts_produced: dict = field(default_factory=dict)
    confidence_so_far: float = 0.0

    # what remains
    remaining_steps: list = field(default_factory=list)
    blockers: list = field(default_factory=list)

    # context the next worker needs immediately
    critical_context: str = ""               # the "grab this first" brief
    criteria: dict = field(default_factory=dict)
    provider_status: dict = field(default_factory=dict)

    # recovery instructions
    patches_to_apply: list = field(default_factory=list)
    binary_target: str = ""                  # e.g., "macos arm64"
    priority_order: list = field(default_factory=list)  # features by importance

    def to_prompt(self) -> str:
        """
        Render as a prompt the next worker can consume directly.
        This is the handoff document.
        """
        sections = []

        sections.append(f"=== OMA HANDOFF NOTE ===")
        sections.append(f"task: {self.task_id}")
        sections.append(f"objective: {self.objective}")
        sections.append(f"status: {self.status} ({self.reason})")
        sections.append(f"confidence: {self.confidence_so_far:.0%}")
        sections.append(f"time: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(self.timestamp))}")

        if self.critical_context:
            sections.append(f"\n--- GRAB THIS FIRST ---")
            sections.append(self.critical_context)

        if self.completed_steps:
            sections.append(f"\n--- COMPLETED ---")
            for i, step in enumerate(self.completed_steps, 1):
                sections.append(f"  {i}. {step}")

        if self.remaining_steps:
            sections.append(f"\n--- REMAINING (do these) ---")
            for i, step in enumerate(self.remaining_steps, 1):
                sections.append(f"  {i}. {step}")

        if self.priority_order:
            sections.append(f"\n--- PRIORITY ORDER (most important first) ---")
            for i, feat in enumerate(self.priority_order, 1):
                sections.append(f"  {i}. {feat}")

        if self.patches_to_apply:
            sections.append(f"\n--- PATCHES TO APPLY ---")
            for patch in self.patches_to_apply:
                sections.append(f"  - {patch}")

        if self.binary_target:
            sections.append(f"\n--- BUILD TARGET ---")
            sections.append(f"  {self.binary_target}")

        if self.blockers:
            sections.append(f"\n--- BLOCKERS ---")
            for b in self.blockers:
                sections.append(f"  ! {b}")

        if self.artifacts_produced:
            sections.append(f"\n--- ARTIFACTS ---")
            for name, path in self.artifacts_produced.items():
                sections.append(f"  {name}: {path}")

        if self.criteria:
            sections.append(f"\n--- SUCCESS CRITERIA ---")
            sections.append(f"  {json.dumps(self.criteria, indent=2, default=str)}")

        if self.provider_status:
            sections.append(f"\n--- PROVIDER STATUS ---")
            for name, status in self.provider_status.items():
                sections.append(f"  {name}: {status}")

        sections.append(f"\n=== END HANDOFF ===")
        return "\n".join(sections)

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "objective": self.objective,
            "status": self.status,
            "reason": self.reason,
            "timestamp": self.timestamp,
            "completed_steps": self.completed_steps,
            "remaining_steps": self.remaining_steps,
            "priority_order": self.priority_order,
            "confidence": self.confidence_so_far,
            "artifacts": self.artifacts_produced,
            "criteria": self.criteria,
            "patches": self.patches_to_apply,
            "binary_target": self.binary_target,
            "critical_context": self.critical_context,
        }


def near_outage_handler(
    task_state,
    working_memory,
    remaining_features: list,
    patches: list = None,
) -> HandoffNote:
    """
    Called when tokens are running low but we can still write.
    Produces the most useful handoff possible with remaining budget.
    """
    completed = [
        f"{step}: conf={conf:.2f}"
        for step, result, conf in task_state.progress
        if conf > 0.3
    ]

    remaining = [
        f"{feat}" for feat in remaining_features
    ]

    return HandoffNote(
        task_id=task_state.task_id,
        objective=task_state.objective,
        status="near_outage",
        reason=f"tokens {task_state.tokens_used}/{task_state.tokens_budget}",
        completed_steps=completed,
        remaining_steps=remaining,
        confidence_so_far=task_state.confidence,
        artifacts_produced=dict(task_state.artifacts),
        criteria=task_state.criteria,
        patches_to_apply=patches or [],
        priority_order=remaining_features,
        critical_context=working_memory.summarize(max_tokens=2000),
    )


def outage_recovery_prompt(
    handoff_note: HandoffNote,
    fork_repo: str = "",
    target_platform: str = "macos",
) -> str:
    """
    Generate the prompt for the next worker after an outage.

    This is the "note to next worker" that includes everything
    needed to resume, including fork references and build targets.
    """
    base = handoff_note.to_prompt()

    recovery = [
        f"\n=== RECOVERY INSTRUCTIONS ===",
        f"From a fork of open-multi-agent, consider these patches",
        f"and create a working binary for {target_platform} on this computer",
        f"in order to complete the functionalities listed from most",
        f"important to least, checking off as many as possible.",
    ]

    if fork_repo:
        recovery.append(f"\nFork: {fork_repo}")

    recovery.append(f"\nFunctionalities (priority order):")
    for i, feat in enumerate(handoff_note.priority_order, 1):
        recovery.append(f"  [ ] {i}. {feat}")

    return base + "\n".join(recovery)
