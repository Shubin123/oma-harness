"""Core loop, criteria evaluation, output sanitizing, and edge handling."""

from .criteria import CriteriaSet, Criterion, CriterionType
from .edge import HandoffNote, near_outage_handler, outage_recovery_prompt
from .loop import CoreLoop, LoopConfig, Status, TaskState
from .sanitize import Sanitizer, sanitize

__all__ = [
    "CriteriaSet", "Criterion", "CriterionType",
    "HandoffNote", "near_outage_handler", "outage_recovery_prompt",
    "CoreLoop", "LoopConfig", "Status", "TaskState",
    "Sanitizer", "sanitize",
]
