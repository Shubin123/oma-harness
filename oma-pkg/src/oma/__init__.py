"""OMA - Open Multi Agent harness."""

__version__ = "0.2.0"

from oma.agent import OMA
from oma.automation.memory import ContextOptimizer, PersistentMemory, WorkingMemory
from oma.core.criteria import CriteriaSet, Criterion, CriterionType
from oma.core.edge import HandoffNote, near_outage_handler, outage_recovery_prompt
from oma.core.loop import CoreLoop, LoopConfig, Status, TaskState
from oma.core.omniroute_bridge import OmniRouteBridge
from oma.core.router import Router
from oma.core.sanitize import Sanitizer, sanitize
from oma.providers.auth import AuthManager, CredentialStore
from oma.providers.registry import ProviderRegistry

__all__ = [
    "OMA",
    "CoreLoop", "LoopConfig", "TaskState", "Status",
    "CriteriaSet", "Criterion", "CriterionType",
    "Sanitizer", "sanitize",
    "HandoffNote", "near_outage_handler", "outage_recovery_prompt",
    "Router",
    "OmniRouteBridge",
    "ProviderRegistry",
    "AuthManager", "CredentialStore",
    "WorkingMemory", "PersistentMemory", "ContextOptimizer",
]
