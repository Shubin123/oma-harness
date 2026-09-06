"""
OMA Test Configuration -- pytest hooks for test history tracking.

Records every test run to tests/.history/runs.json so results
can be reviewed over time. History includes:
  - timestamp, duration, pass/fail/skip counts
  - per-test outcomes
  - provider connection state at run time
  - whether the auth token was validated against the live API
"""

import json
import os
import time
from pathlib import Path

HISTORY_DIR = Path(__file__).parent / ".history"
HISTORY_FILE = HISTORY_DIR / "runs.json"
MAX_HISTORY = 200  # keep last N runs


class HistoryRecorder:
    """Pytest plugin that records results to disk."""

    def __init__(self):
        self.results = []
        self.start_time = None
        self.counts = {"passed": 0, "failed": 0, "skipped": 0, "error": 0}
        self.token_validated = False
        self.providers_connected = []

    def pytest_sessionstart(self, session):
        self.start_time = time.time()

    def pytest_runtest_logreport(self, report):
        if report.when == "call":
            outcome = report.outcome  # "passed", "failed", "skipped"
            self.counts[outcome] = self.counts.get(outcome, 0) + 1
            entry = {
                "name": report.nodeid,
                "outcome": outcome,
                "duration": round(report.duration, 3),
            }
            if outcome == "failed" and report.longreprtext:
                entry["error"] = report.longreprtext[:500]

            # track token validation
            if "token" in report.nodeid.lower() and "valid" in report.nodeid.lower():
                if outcome == "passed":
                    self.token_validated = True

            self.results.append(entry)

        elif report.when == "setup" and report.skipped:
            self.counts["skipped"] += 1
            self.results.append({
                "name": report.nodeid,
                "outcome": "skipped",
                "duration": 0,
            })

    def pytest_sessionfinish(self, session, exitstatus):
        elapsed = round(time.time() - self.start_time, 2) if self.start_time else 0

        # try to get provider status from the dashboard
        base_url = os.environ.get("OMA_TEST_URL", "http://127.0.0.1:8384")
        try:
            import urllib.request
            req = urllib.request.Request(f"{base_url}/api/status")
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                auth = data.get("auth", {})
                self.providers_connected = [
                    name for name, info in auth.items()
                    if info.get("status") == "logged_in"
                ]
        except Exception:
            pass

        run_record = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "epoch": int(time.time()),
            "duration_s": elapsed,
            "exit_code": exitstatus,
            "total": sum(self.counts.values()),
            "passed": self.counts["passed"],
            "failed": self.counts["failed"],
            "skipped": self.counts["skipped"],
            "token_validated": self.token_validated,
            "providers_connected": self.providers_connected,
            "live_test": os.environ.get("OMA_TEST_LIVE") == "1",
            "tests": self.results,
        }

        # persist
        HISTORY_DIR.mkdir(parents=True, exist_ok=True)
        history = []
        if HISTORY_FILE.exists():
            try:
                with open(HISTORY_FILE) as f:
                    history = json.loads(f.read())
            except (json.JSONDecodeError, OSError):
                history = []

        history.append(run_record)
        # trim to last N runs
        if len(history) > MAX_HISTORY:
            history = history[-MAX_HISTORY:]

        with open(HISTORY_FILE, "w") as f:
            json.dump(history, f, indent=2)


def pytest_configure(config):
    """Register the history recorder plugin."""
    config.pluginmanager.register(HistoryRecorder(), "oma_history")
