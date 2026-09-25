#!/usr/bin/env python3
"""
OMA - Single entry point that builds and runs everything in the project.

Usage:
    python run.py             # Build and run everything (tests, demos, verification)
    python run.py --serve     # Build, test, and launch the web dashboard
    python run.py --skip-tests # Build and run demos only
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path


def find_best_python() -> str:
    """Find a Python interpreter that has required test dependencies installed."""
    candidates = [
        "/opt/homebrew/opt/python@3.11/bin/python3.11",
        shutil.which("python3.11"),
        shutil.which("python3.12"),
        shutil.which("python3"),
        sys.executable,
    ]
    for cand in candidates:
        if not cand:
            continue
        try:
            res = subprocess.run([cand, "-c", "import pytest"], capture_output=True, text=True)
            if res.returncode == 0:
                return cand
        except Exception:
            continue
    return sys.executable


# Re-exec with best Python if current interpreter lacks dependencies
best_py = find_best_python()
if os.path.realpath(sys.executable) != os.path.realpath(best_py):
    os.execv(best_py, [best_py, str(Path(__file__).resolve())] + sys.argv[1:])

# Ensure paths
root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / "oma-pkg" / "src"))
sys.path.insert(0, str(root / "tools"))

from run_all import main

if __name__ == "__main__":
    sys.exit(main())
