"""OMA - Open Multi Agent harness."""

__version__ = "0.1.0"

from oma.core.loop import CoreLoop, LoopConfig, TaskState, Status
from oma.core.criteria import CriteriaSet, Criterion, CriterionType
from oma.core.sanitize import Sanitizer, sanitize
from oma.core.edge import HandoffNote, near_outage_handler, outage_recovery_prompt
from oma.providers.registry import ProviderRegistry
from oma.providers.auth import AuthManager, CredentialStore
from oma.automation.memory import WorkingMemory, PersistentMemory, ContextOptimizer
from oma.agent import OMA

__all__ = [
    "OMA",
    "CoreLoop", "LoopConfig", "TaskState", "Status",
    "CriteriaSet", "Criterion", "CriterionType",
    "Sanitizer", "sanitize",
    "HandoffNote", "near_outage_handler", "outage_recovery_prompt",
    "ProviderRegistry",
    "AuthManager", "CredentialStore",
    "WorkingMemory", "PersistentMemory", "ContextOptimizer",
]
