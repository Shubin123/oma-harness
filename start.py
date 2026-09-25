#!/usr/bin/env python3
"""
OMA - Start the whole system after building.

Usage:
    ./start.sh                       # Recommended one-command runner
    python3 start.py                 # Direct Python runner
    make start                       # Via Makefile
    npm start                        # Via npm scripts
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PKG = ROOT / "oma-pkg"
TS = ROOT / "oma-ts"
DIST = ROOT / "dist"


def find_best_python() -> str:
    """Find a Python interpreter that has oma and its dependencies installed."""
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
            res = subprocess.run([cand, "-c", "import oma"], capture_output=True, text=True)
            if res.returncode == 0:
                return cand
        except Exception:
            continue
    return sys.executable


# Re-exec with best Python if current interpreter cannot import oma
best_py = find_best_python()
if os.path.realpath(sys.executable) != os.path.realpath(best_py):
    os.execv(best_py, [best_py, str(Path(__file__).resolve())] + sys.argv[1:])

# Ensure oma-pkg/src and tools are in sys.path
sys.path.insert(0, str(PKG / "src"))
sys.path.insert(0, str(ROOT / "tools"))

from cache import hash_tree, cache_get, cache_put
from oma.gui.web import run_web
from oma.providers.auth import AuthManager


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="start",
        description="One command after building that lets the whole OMA system run.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  ./start.sh                    Start with default settings (http://127.0.0.1:8384)
  python3 start.py --port 9000  Run on port 9000
  make start                    Run via Makefile target
        """,
    )
    parser.add_argument("--host", default="127.0.0.1", help="Dashboard host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8384, help="Dashboard port (default: 8384)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")
    args = parser.parse_args()

    # If TypeScript bundle missing or stale, ensure build is present
    bundle_file = TS / "dist" / "oma-bundle.cjs"
    ts_sources = hash_tree((TS / "src", "**/*.ts"), extra_files=[TS / "package.json", TS / "tsconfig.json"])
    if (not bundle_file.exists() or cache_get("ts-build") != ts_sources) and (TS / "node_modules").exists():
        npm = "npm.cmd" if os.name == "nt" else "npm"
        subprocess.run([npm, "run", "build"], cwd=str(TS), capture_output=True)
        subprocess.run([npm, "run", "bundle"], cwd=str(TS), capture_output=True)
        cache_put("ts-build", ts_sources)

    auth = AuthManager()
    stored = auth.status()
    logged_in = [p for p, s in stored.items() if s.get("status") == "logged_in"]
    storage_info = auth.storage_info()

    border = "=" * 70
    print(f"\n{border}")
    print("           OMA - Open Multi Agent System Running")
    print(f"{border}")
    print(f"  * Web GUI Dashboard:  http://{args.host}:{args.port}")
    print(f"  * REST API Status:    http://{args.host}:{args.port}/api/status")
    print(f"  * Local Vault:        {storage_info.get('file')} (mode: {storage_info.get('mode', '0600')})")
    if logged_in:
        print(f"  * Active Providers:   {', '.join(logged_in)}")
    else:
        print("  * Active Providers:   None configured yet (connect in Dashboard or 'oma auth add')")
    print("-" * 70)
    print("Features Running & Ready:")
    print("  [✓] Autonomous RALPH Loop (Reason, Act, Learn, Plan, Handoff)")
    print("  [✓] Multi-Provider OmniRoute with dynamic circuit breaker failover")
    print("  [✓] Visual Workflow Studio for multi-agent DAG pipelines")
    print("  [✓] Output Sanitization & Privacy Leak Guards")
    print("  [✓] Interactive Onboarding Demo & Live Simulation (no API keys needed)")
    print("-" * 70)
    print("Quick Controls:")
    print(f"  * Web Studio UI:      http://{args.host}:{args.port}")
    print("  * Run Task in CLI:    oma run \"your task here\"")
    print("  * Stop System:        Press Ctrl+C")
    print(f"{border}\n", flush=True)

    try:
        run_web(host=args.host, port=args.port, open_browser=not args.no_browser)
    except KeyboardInterrupt:
        print("\nStopping OMA system... Goodbye!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
