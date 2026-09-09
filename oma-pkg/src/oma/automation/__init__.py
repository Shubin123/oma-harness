"""Automation layers: pixel, page, and memory."""

from .memory import ContextOptimizer, PersistentMemory, WorkingMemory
from .page import PageAutomator, PageConfig, PageState, ScrollStrategy
from .pixel import ClickTarget, PixelAutomator, ScreenRegion, TypeAction

__all__ = [
    "ContextOptimizer", "PersistentMemory", "WorkingMemory",
    "PageAutomator", "PageConfig", "PageState", "ScrollStrategy",
    "ClickTarget", "PixelAutomator", "ScreenRegion", "TypeAction",
]
