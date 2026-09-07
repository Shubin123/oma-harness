"""
OMA Memory-Level Automation -- dynamic analysis and state tracking.

Memory management for multi-agent runs:
  - Conversation history compression
  - Working memory (what's relevant right now)
  - Long-term memory (persisted facts across runs)
  - Context window optimization
  - Handoff state serialization

The memory layer answers: "what does the next worker need to know?"
"""

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional


@dataclass
class MemoryEntry:
    key: str
    value: Any
    created_at: float = field(default_factory=time.time)
    accessed_at: float = field(default_factory=time.time)
    access_count: int = 0
    ttl_s: float = 0.0                  # 0 = no expiry
    tags: list = field(default_factory=list)
    source: str = ""                    # which agent/step produced this

    @property
    def is_expired(self) -> bool:
        if self.ttl_s <= 0:
            return False
        return time.time() - self.created_at > self.ttl_s

    def touch(self):
        self.accessed_at = time.time()
        self.access_count += 1


class WorkingMemory:
    """
    In-session memory with LRU eviction and tag-based retrieval.

    This is what the current agent has in its "head" --
    facts, intermediate results, and decisions.
    """

    def __init__(self, max_entries: int = 200, max_tokens: int = 50_000):
        self._store: dict[str, MemoryEntry] = {}
        self.max_entries = max_entries
        self.max_tokens = max_tokens

    def put(self, key: str, value: Any, tags: list = None,
            ttl_s: float = 0.0, source: str = "") -> None:
        self._store[key] = MemoryEntry(
            key=key, value=value, tags=tags or [],
            ttl_s=ttl_s, source=source,
        )
        self._evict_if_needed()

    def get(self, key: str) -> Optional[Any]:
        entry = self._store.get(key)
        if entry is None:
            return None
        if entry.is_expired:
            del self._store[key]
            return None
        entry.touch()
        return entry.value

    def search(self, tag: str) -> list[MemoryEntry]:
        """Find all non-expired entries with a given tag."""
        results = []
        for entry in self._store.values():
            if entry.is_expired:
                continue
            if tag in entry.tags:
                entry.touch()
                results.append(entry)
        return results

    def summarize(self, max_tokens: int = 5000) -> str:
        """
        Compress working memory into a text summary for handoff.
        Prioritizes by access frequency and recency.
        """
        entries = sorted(
            [e for e in self._store.values() if not e.is_expired],
            key=lambda e: (e.access_count, e.accessed_at),
            reverse=True,
        )

        lines = []
        est_tokens = 0
        for entry in entries:
            line = f"[{entry.key}] ({','.join(entry.tags)}): {json.dumps(entry.value, default=str)}"
            line_tokens = len(line) // 4
            if est_tokens + line_tokens > max_tokens:
                break
            lines.append(line)
            est_tokens += line_tokens

        return "\n".join(lines)

    def _evict_if_needed(self):
        # remove expired
        expired = [k for k, v in self._store.items() if v.is_expired]
        for k in expired:
            del self._store[k]

        # LRU eviction
        while len(self._store) > self.max_entries:
            oldest = min(self._store.values(), key=lambda e: e.accessed_at)
            del self._store[oldest.key]

    def to_dict(self) -> dict:
        return {
            k: {
                "value": v.value,
                "tags": v.tags,
                "access_count": v.access_count,
                "source": v.source,
            }
            for k, v in self._store.items()
            if not v.is_expired
        }


class PersistentMemory:
    """
    Cross-session memory stored as JSON files.

    Each task gets a memory directory. Workers read previous
    state and write their additions.
    """

    def __init__(self, base_dir: str = ".oma_memory"):
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.base, 0o700)
        except OSError:
            pass

    def _path(self, task_id: str) -> Path:
        return self.base / f"{task_id}.json"

    def load(self, task_id: str) -> dict:
        path = self._path(task_id)
        if path.exists():
            return json.loads(path.read_text())
        return {"entries": {}, "handoffs": [], "created_at": time.time()}

    def save(self, task_id: str, data: dict) -> None:
        data["updated_at"] = time.time()
        p = self._path(task_id)
        p.write_text(json.dumps(data, indent=2, default=str))
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass

    def append_handoff(self, task_id: str, handoff_summary: str,
                       worker_id: str = "") -> None:
        """Record a worker handoff."""
        data = self.load(task_id)
        data.setdefault("handoffs", []).append({
            "worker_id": worker_id,
            "summary": handoff_summary,
            "timestamp": time.time(),
        })
        self.save(task_id, data)

    def merge_working(self, task_id: str, working: WorkingMemory) -> None:
        """Merge working memory into persistent store."""
        data = self.load(task_id)
        data["entries"].update(working.to_dict())
        self.save(task_id, data)

    def flush(self, task_id: str | None = None) -> int:
        """
        Flush persistent task memory.
        If task_id is specified, removes only that task's file.
        If task_id is None, wipes all tasks in the persistent store.
        Returns the number of files deleted.
        """
        if task_id:
            p = self._path(task_id)
            if p.exists():
                p.unlink()
                return 1
            return 0

        count = 0
        if self.base.exists():
            for f in self.base.glob("*.json"):
                try:
                    f.unlink()
                    count += 1
                except OSError:
                    pass
        return count

    def list_tasks(self) -> list[str]:
        """List all task IDs currently stored in persistent memory."""
        if not self.base.exists():
            return []
        return [f.stem for f in self.base.glob("*.json")]


class ContextOptimizer:
    """
    Manages the context window budget for a provider call.

    Given a token budget, packs the most important context:
      1. System prompt (always included)
      2. Current task state
      3. Recent working memory
      4. Relevant long-term memory
      5. Conversation history (compressed)
    """

    def __init__(self, token_budget: int = 100_000):
        self.budget = token_budget

    def build_context(
        self,
        system: str,
        task_state: dict,
        working: WorkingMemory,
        persistent: Optional[dict] = None,
        history: Optional[list] = None,
    ) -> tuple[str, list[dict]]:
        """
        Build (system_prompt, messages) that fit within token budget.
        """
        used = len(system) // 4

        # task state always goes in system
        state_text = f"\n\nCurrent task state:\n{json.dumps(task_state, indent=2, default=str)}"
        used += len(state_text) // 4
        system_full = system + state_text

        # working memory summary
        memory_budget = min(self.budget // 4, 10_000)
        memory_text = working.summarize(max_tokens=memory_budget)
        if memory_text:
            system_full += f"\n\nWorking memory:\n{memory_text}"
            used += len(memory_text) // 4

        # persistent memory (previous handoffs)
        if persistent and persistent.get("handoffs"):
            handoffs = persistent["handoffs"][-3:]  # last 3 handoffs
            handoff_text = "\n".join(
                f"[handoff {i+1}] {h['summary'][:500]}"
                for i, h in enumerate(handoffs)
            )
            system_full += f"\n\nPrevious worker handoffs:\n{handoff_text}"
            used += len(handoff_text) // 4

        # conversation history: fit what we can, newest first
        messages = []
        if history:
            for msg in reversed(history):
                msg_tokens = len(json.dumps(msg)) // 4
                if used + msg_tokens > self.budget * 0.8:  # leave 20% for response
                    break
                messages.insert(0, msg)
                used += msg_tokens

        return system_full, messages
