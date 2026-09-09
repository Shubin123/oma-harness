#!/usr/bin/env python3
"""
OMA Test Runner -- automated testing for the harness.

Usage:
    python tests/run_tests.py              # unit + integration (no live calls)
    python tests/run_tests.py --live       # include live provider smoke test
    python tests/run_tests.py --coverage   # with coverage report
    python tests/run_tests.py --url URL    # custom dashboard URL
    python tests/run_tests.py --history    # show recent test run history

Design:
  - Unit tests run first (fast, no network)
  - Dashboard API tests run next (hits local server, no conversations)
  - Token validation tests verify credentials against live APIs (no conversations)
  - Live tests are opt-in (creates minimal conversations, titles them)
  - Results are recorded to tests/.history/runs.json automatically
  - Exit code 0 = all passed, 1 = failures
"""

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HISTORY_FILE = Path(__file__).parent / ".history" / "runs.json"


def check_dashboard(url: str) -> dict:
    """Check if the dashboard is reachable and get its status."""
    try:
        req = urllib.request.Request(f"{url}/api/status")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            auth = data.get("auth", {})
            connected = [
                name for name, info in auth.items()
                if info.get("status") == "logged_in"
            ]
            return {
                "reachable": True,
                "connected_providers": connected,
                "auth": auth,
            }
    except Exception as e:
        return {"reachable": False, "error": str(e)}


def validate_tokens(url: str) -> dict:
    """Pre-flight: validate connected provider tokens against live APIs."""
    results = {}
    status = check_dashboard(url)
    if not status["reachable"]:
        return results

    for provider in status.get("connected_providers", []):
        try:
            req = urllib.request.Request(f"{url}/api/auth/verify?provider={provider}")
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                results[provider] = {
                    "valid": data.get("valid", False),
                    "detail": data.get("detail", ""),
                }
        except Exception as e:
            results[provider] = {"valid": False, "detail": str(e)}

    return results


def title_conversations(url: str):
    """
    Check and title any untitled conversations created during testing.

    This is called after live tests to ensure we don't leave clutter.
    Currently informational -- the subscription provider needs a
    rename endpoint to actually title conversations.
    """
    pass


def show_history(limit: int = 20):
    """Display recent test run history from the recorded JSON."""
    if not HISTORY_FILE.exists():
        print("  No test history found. Run tests first to start recording.")
        return

    try:
        with open(HISTORY_FILE) as f:
            runs = json.loads(f.read())
    except (json.JSONDecodeError, OSError) as e:
        print(f"  Error reading history: {e}")
        return

    if not runs:
        print("  History file is empty.")
        return

    recent = runs[-limit:]
    print(f"\n{'=' * 72}")
    print(f"  Test History (last {len(recent)} of {len(runs)} runs)")
    print(f"{'=' * 72}")
    print(f"  {'Timestamp':<20} {'Result':>8} {'Pass':>5} {'Fail':>5} {'Skip':>5} "
          f"{'Time':>7} {'Token':>6} {'Providers'}")
    print(f"  {'-'*20} {'-'*8} {'-'*5} {'-'*5} {'-'*5} {'-'*7} {'-'*6} {'-'*20}")

    for run in recent:
        ts = run.get("timestamp", "?")
        result = "PASS" if run.get("exit_code", 1) == 0 else "FAIL"
        passed = run.get("passed", 0)
        failed = run.get("failed", 0)
        skipped = run.get("skipped", 0)
        duration = run.get("duration_s", 0)
        token_ok = "yes" if run.get("token_validated") else "no"
        providers = ", ".join(run.get("providers_connected", [])) or "none"

        color = "\033[32m" if result == "PASS" else "\033[31m"
        reset = "\033[0m"

        print(f"  {ts:<20} {color}{result:>8}{reset} {passed:>5} {failed:>5} {skipped:>5} "
              f"{duration:>6.1f}s {token_ok:>6} {providers}")

    print(f"{'=' * 72}")

    # trend summary
    if len(runs) >= 2:
        last_5 = runs[-5:]
        pass_rate = sum(1 for r in last_5 if r.get("exit_code", 1) == 0) / len(last_5) * 100
        token_rate = sum(1 for r in last_5 if r.get("token_validated")) / len(last_5) * 100
        print(f"\n  Last {len(last_5)} runs: {pass_rate:.0f}% pass rate, {token_rate:.0f}% token validation rate")

    # check for recurring failures
    if len(runs) >= 3:
        last_3 = runs[-3:]
        all_failed = all(r.get("exit_code", 1) != 0 for r in last_3)
        if all_failed:
            print("\n  WARNING: Last 3 runs all failed -- investigate before continuing")

        # find tests that failed in multiple recent runs
        fail_counts = {}
        for run in last_3:
            for test in run.get("tests", []):
                if test.get("outcome") == "failed":
                    name = test.get("name", "?")
                    fail_counts[name] = fail_counts.get(name, 0) + 1
        repeat_fails = {k: v for k, v in fail_counts.items() if v >= 2}
        if repeat_fails:
            print("\n  Recurring failures:")
            for name, count in sorted(repeat_fails.items(), key=lambda x: -x[1]):
                print(f"    {count}x  {name}")

    print()


def find_pytest_executable() -> str:
    """Find a Python executable that has pytest installed."""
    if importlib.util.find_spec("pytest") is not None:
        return sys.executable
    for c in [
        "/opt/homebrew/opt/python@3.11/bin/python3.11",
        "/opt/homebrew/bin/python3.11",
        "python3.11",
        "python3",
    ]:
        which = shutil.which(c)
        if which:
            res = subprocess.run([which, "-m", "pytest", "--version"], capture_output=True)
            if res.returncode == 0:
                return which
    return sys.executable


def start_test_dashboard(host="127.0.0.1", port=8384):
    """Start an ephemeral dashboard server in a background thread if port is free."""
    import http.server
    try:
        from oma.agent import OMA
        from oma.gui.web import DashboardHandler
        from oma.providers.auth import AuthManager

        DashboardHandler.auth_manager = AuthManager()
        try:
            DashboardHandler.agent = OMA.from_credentials(DashboardHandler.auth_manager)
        except Exception:
            DashboardHandler.agent = None

        server = http.server.HTTPServer((host, port), DashboardHandler)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        time.sleep(0.2)
        return server
    except (OSError, ImportError):
        return None


def run_pytest(args: list, env: dict = None) -> subprocess.CompletedProcess:
    """Run pytest with the given arguments."""
    py_exe = find_pytest_executable()
    cmd = [py_exe, "-m", "pytest"] + args
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(cmd, env=full_env, capture_output=False)


def main():
    parser = argparse.ArgumentParser(description="OMA Test Runner")
    parser.add_argument("--unit", action="store_true", help="Run unit tests only")
    parser.add_argument("--functional", action="store_true", help="Run functional tests only")
    parser.add_argument("--smoke", action="store_true", help="Run smoke tests only")
    parser.add_argument("--e2e", action="store_true", help="Run end-to-end tests only")
    parser.add_argument("--all", action="store_true",
                        help="Run all tests (unit, functional, smoke, e2e, integration)")
    parser.add_argument("--live", action="store_true",
                       help="Enable live provider smoke tests (creates 1 conversation)")
    parser.add_argument("--coverage", action="store_true",
                       help="Generate coverage report")
    parser.add_argument("--url", default="http://127.0.0.1:8384",
                       help="Dashboard URL (default: http://127.0.0.1:8384)")
    parser.add_argument("--verbose", "-v", action="store_true",
                       help="Verbose output")
    parser.add_argument("--fast", action="store_true",
                       help="Skip integration tests, run unit tests only")
    parser.add_argument("--history", action="store_true",
                       help="Show recent test run history and exit")
    parser.add_argument("--history-limit", type=int, default=20,
                       help="Number of history entries to show (default: 20)")
    args = parser.parse_args()

    # history-only mode
    if args.history:
        show_history(args.history_limit)
        return 0

    print("=" * 60)
    print("  OMA Test Runner")
    print("=" * 60)

    test_server = None
    url = args.url

    # Check / start dashboard if running integration/dashboard tests
    needs_dashboard = not (args.fast or args.unit or args.functional)
    if needs_dashboard:
        print(f"\nChecking dashboard at {url}...")
        status = check_dashboard(url)
        if not status["reachable"] and ("8384" in url or "127.0.0.1" in url):
            print("  Dashboard not running -- auto-starting test dashboard...")
            test_server = start_test_dashboard()
            if test_server:
                status = check_dashboard(url)

        if status["reachable"]:
            providers = status.get("connected_providers", [])
            print("  Dashboard: UP")
            print(f"  Connected: {', '.join(providers) if providers else 'none'}")

            # Pre-flight token validation
            if providers:
                print("\n  Validating tokens...")
                token_results = validate_tokens(url)
                for provider, result in token_results.items():
                    icon = "OK" if result.get("valid") else "EXPIRED"
                    detail = result.get("detail", "")
                    print(f"    {provider}: {icon}" + (f" ({detail})" if detail else ""))
        else:
            print(f"  Dashboard: DOWN ({status.get('error', 'unknown')})")
            print("  Live dashboard integration tests will be skipped")

    # Build pytest args
    pytest_args = ["tests/", "-v", "--tb=short"]

    if args.unit:
        pytest_args.extend(["-m", "unit"])
    elif args.functional:
        pytest_args.extend(["-m", "functional"])
    elif args.smoke:
        pytest_args.extend(["-m", "smoke"])
    elif args.e2e:
        pytest_args.extend(["-m", "e2e"])
    elif args.fast:
        pytest_args.extend(["-m", "unit"])

    if args.coverage:
        pytest_args.extend(["--cov=oma", "--cov-report=term-missing"])

    env = {"OMA_TEST_URL": url}
    if args.live:
        env["OMA_TEST_LIVE"] = "1"
        print("\n  LIVE TESTS ENABLED")

    print(f"\n{'=' * 60}")
    print("  Running tests...")
    print(f"{'=' * 60}\n")

    t0 = time.time()
    try:
        result = run_pytest(pytest_args, env=env)
    finally:
        if test_server:
            test_server.shutdown()
    elapsed = time.time() - t0

    # 5. Post-test cleanup
    if args.live:
        title_conversations(args.url)

    # 6. Summary
    print(f"\n{'=' * 60}")
    print("  Summary")
    print(f"{'=' * 60}")
    print(f"  Time: {elapsed:.1f}s")
    print(f"  Exit: {'PASS' if result.returncode == 0 else 'FAIL'}")
    if args.live:
        print("  Note: 1 conversation was created for live smoke test")
    print(f"  History: {HISTORY_FILE}")
    print(f"{'=' * 60}")

    # 7. Show brief history trend
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE) as f:
                runs = json.loads(f.read())
            if len(runs) >= 2:
                last_5 = runs[-min(5, len(runs)):]
                pass_rate = sum(1 for r in last_5 if r.get("exit_code", 1) == 0) / len(last_5) * 100
                print(f"\n  Trend (last {len(last_5)} runs): {pass_rate:.0f}% pass rate")
        except Exception:
            pass

    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
