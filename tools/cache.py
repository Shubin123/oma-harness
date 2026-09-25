"""
Unified build and test caching for OMA.

Provides cryptographic tree hashing and cache management so that unchanged
sources avoid redundant compilation, bundling, and test suite execution.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".build_cache"


def hash_tree(*globs: tuple[Path, str], extra_files: list[Path] | None = None) -> str:
    """Hash every file matched by (directory, pattern) pairs, order-independent."""
    digest = hashlib.sha256()
    files: list[Path] = []
    for base, pattern in globs:
        if base.exists():
            files.extend(p for p in base.glob(pattern) if p.is_file())
    if extra_files:
        for f in extra_files:
            if f.exists() and f.is_file():
                files.append(f)
    for path in sorted(set(files)):
        try:
            rel = path.relative_to(ROOT).as_posix()
        except ValueError:
            rel = str(path)
        digest.update(rel.encode("utf-8"))
        try:
            digest.update(path.read_bytes())
        except OSError:
            pass
    return digest.hexdigest()


def cache_get(key: str) -> str | None:
    """Read a stored hash for a given cache key."""
    path = CACHE_DIR / f"{key}.hash"
    try:
        return path.read_text().strip() if path.exists() else None
    except OSError:
        return None


def cache_put(key: str, value: str, meta: dict | None = None) -> None:
    """Save a hash and optional metadata for a given cache key."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        (CACHE_DIR / f"{key}.hash").write_text(value)
        if meta:
            (CACHE_DIR / f"{key}.meta.json").write_text(json.dumps(meta, indent=2))
    except OSError:
        pass


def cache_meta(key: str) -> dict | None:
    """Read stored metadata for a given cache key."""
    path = CACHE_DIR / f"{key}.meta.json"
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None
    return None


def cache_invalidate(key: str) -> None:
    """Remove cache files for a given key."""
    for p in [CACHE_DIR / f"{key}.hash", CACHE_DIR / f"{key}.meta.json"]:
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass


def cache_clear() -> None:
    """Clear the entire build cache."""
    if CACHE_DIR.exists():
        shutil.rmtree(CACHE_DIR, ignore_errors=True)
