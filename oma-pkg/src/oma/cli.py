"""
OMA CLI - command-line entry point.

Usage:
    oma run "your objective here"
    oma status
    oma gui
    oma web
    oma providers
"""

import argparse
import json
import os
import sys


def cmd_run(args):
    from oma.agent import OMA

    agent = OMA.from_env()

    criteria = None
    if args.criteria:
        criteria = json.loads(args.criteria)

    result = agent.run(
        objective=args.objective,
        criteria=criteria,
        resume_from=args.resume,
    )

    print(f"\nStatus: {result.status.value}")
    print(f"Confidence: {result.confidence:.0%}")
    print(f"Attempts: {result.attempts}")
    print(f"Tokens used: {result.tokens_used}")

    if result.artifacts.get("final"):
        print(f"\n--- Result ---")
        print(result.artifacts["final"])

    if result.context_for_next:
        print(f"\n--- Handoff ---")
        print(result.context_for_next)


def cmd_status(args):
    from oma.agent import OMA

    agent = OMA.from_env()
    status = agent.status()
    print(json.dumps(status, indent=2))


def cmd_providers(args):
    from oma.providers.registry import ProviderRegistry

    reg = ProviderRegistry.from_env()
    names = list(reg._providers.keys())
    if not names:
        print("No providers configured. Set environment variables:")
        print("  OMA_CLAUDE_KEY, OMA_GEMINI_KEY, OMA_OPENAI_KEY,")
        print("  OMA_DEEPSEEK_KEY, OMA_GLM_KEY, OMA_KIMI_KEY")
        return

    print(f"Configured providers ({len(names)}):")
    for name in names:
        print(f"  - {name}")

    chain = reg.fallback_chain()
    print(f"\nFallback chain: {' -> '.join(chain)}")


def cmd_gui(args):
    try:
        from oma.gui.app import main as gui_main
        gui_main()
    except ImportError as e:
        print(f"GUI dependencies not installed: {e}")
        print("Install with: pip install oma-harness[gui]")
        sys.exit(1)


def cmd_web(args):
    try:
        from oma.gui.web import run_web
        run_web(host=args.host, port=args.port)
    except ImportError as e:
        print(f"Web dependencies not installed: {e}")
        print("Install with: pip install oma-harness[web]")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        prog="oma",
        description="OMA - Open Multi Agent harness",
    )
    sub = parser.add_subparsers(dest="command", help="Available commands")

    # run
    p_run = sub.add_parser("run", help="Run a task")
    p_run.add_argument("objective", help="Task objective")
    p_run.add_argument("--criteria", help="JSON criteria dict", default=None)
    p_run.add_argument("--resume", help="Task ID to resume from", default=None)

    # status
    sub.add_parser("status", help="Show agent status")

    # providers
    sub.add_parser("providers", help="List configured providers")

    # gui
    sub.add_parser("gui", help="Launch graphical interface")

    # web
    p_web = sub.add_parser("web", help="Launch web dashboard")
    p_web.add_argument("--host", default="127.0.0.1")
    p_web.add_argument("--port", type=int, default=8384)

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(0)

    dispatch = {
        "run": cmd_run,
        "status": cmd_status,
        "providers": cmd_providers,
        "gui": cmd_gui,
        "web": cmd_web,
    }

    dispatch[args.command](args)


if __name__ == "__main__":
    main()
