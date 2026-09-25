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
import sys

from oma import platform_compat


def cmd_run(args):
    from oma.agent import OMA
    from oma.core.router import RoutingStrategy

    agent = OMA.load()

    if getattr(args, "offline", False):
        agent.config.provider_chain = []
    elif getattr(args, "provider", None):
        agent.config.provider_chain = [args.provider.lower()]
    elif getattr(args, "tier", None):
        agent.router.strategy = RoutingStrategy.TIERED
        tier_providers = agent.router.tiers.get(args.tier, [])
        if tier_providers:
            agent.config.provider_chain = list(tier_providers)

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
        print("\n--- Result ---")
        print(result.artifacts["final"])

    if result.context_for_next:
        print("\n--- Handoff ---")
        print(result.context_for_next)


def cmd_status(args):
    from oma.agent import OMA

    agent = OMA.load()
    status = agent.status()
    print(json.dumps(status, indent=2))


def cmd_providers(args):
    from oma.agent import OMA

    agent = OMA.load()
    names = list(agent.registry._providers.keys())
    if not names:
        print("No providers configured. Set environment variables:")
        print("  OMA_CLAUDE_KEY, OMA_GEMINI_KEY, OMA_OPENAI_KEY,")
        print("  OMA_DEEPSEEK_KEY, OMA_GLM_KEY, OMA_KIMI_KEY")
        print("Or add credentials via CLI:")
        print("  oma auth add <provider> <key>")
        return

    print(f"Configured providers ({len(names)}):")
    for name in names:
        print(f"  - {name}")

    chain = agent.registry.fallback_chain()
    print(f"\nFallback chain: {' -> '.join(chain)}")


def cmd_auth(args):
    from oma.providers.auth import AuthManager

    mgr = AuthManager()

    if getattr(args, "auth_command", None) == "add":
        provider = args.provider.lower()
        key = args.key
        auth_type = getattr(args, "type", "auto") or "auto"
        cred = mgr.store_credential(
            provider=provider,
            value=key,
            auth_type=auth_type,
            email=getattr(args, "email", None),
            plan=getattr(args, "plan", None),
        )
        print(f"Stored {provider} credential securely (auth_type: {cred.auth_type}).")

    elif getattr(args, "auth_command", None) == "remove":
        provider = args.provider.lower()
        mgr.logout(provider)
        print(f"Removed credential for {provider}.")

    elif getattr(args, "auth_command", None) in ("status", "list") or getattr(args, "auth_command", None) is None:
        st = mgr.status()
        print("OMA Stored Credentials:")
        for name, info in st.items():
            status_text = info.get("status", "unknown")
            extra = []
            if info.get("email"):
                extra.append(f"email={info['email']}")
            if info.get("plan"):
                extra.append(f"plan={info['plan']}")
            cred = mgr.get_credential(name)
            if cred:
                extra.append(f"type={cred.auth_type}")
            extra_str = f" ({', '.join(extra)})" if extra else ""
            print(f"  - {name}: {status_text}{extra_str}")

    elif getattr(args, "auth_command", None) == "verify":
        provider = args.provider.lower() if getattr(args, "provider", None) else None
        providers_to_test = [provider] if provider else list(mgr.store.all_providers().keys())
        if not providers_to_test:
            print("No stored credentials to verify.")
            return

        from oma.gui.web import DashboardHandler
        handler = DashboardHandler.__new__(DashboardHandler)
        for p in providers_to_test:
            cred = mgr.get_credential(p)
            if not cred:
                print(f"  {p}: No credential stored.")
                continue
            ok, detail = handler._verify_token(p, cred.value)
            icon = "OK" if ok else "FAILED"
            print(f"  {p}: {icon} ({detail})")

    elif getattr(args, "auth_command", None) == "flush":
        provider = getattr(args, "provider", None)
        if provider:
            mgr.logout(provider.lower())
            print(f"Flushed credential for {provider.lower()}.")
        else:
            if not getattr(args, "yes", False):
                try:
                    ans = input("Are you sure you want to securely wipe ALL stored credentials? [y/N]: ")
                    if ans.lower() not in ("y", "yes"):
                        print("Aborted.")
                        return
                except EOFError:
                    pass
            res = mgr.flush(
                include_memory=getattr(args, "include_memory", False),
                memory_dir=getattr(args, "memory_dir", None),
            )
            print(f"Securely flushed {res['flushed_credentials_count']} credentials from {res['credentials_file']}.")
            if res.get("memory_files_removed"):
                print(f"Removed {res['memory_files_removed']} persistent task memory files.")

    elif getattr(args, "auth_command", None) == "info":
        info = mgr.storage_info()
        print("OMA Safe Storage Information:")
        print(f"  Credentials File:    {info['credentials_file']}")
        print(f"  Directory:           {info['credentials_dir']}")
        print(f"  File Exists:         {info['file_exists']}")
        if info['file_exists']:
            print(f"  File Size:           {info['size_bytes']} bytes")
            file_note = "" if platform_compat.IS_WINDOWS else " (owner-only: rw-------)"
            dir_note = "" if platform_compat.IS_WINDOWS else " (owner-only: rwx------)"
            print(f"  File Mode:           {info['file_permissions']}{file_note}")
            print(f"  Directory Mode:      {info['dir_permissions']}{dir_note}")
        print(f"  Encryption:          {info['encryption']}")
        print(f"  Stored Providers:    {info['provider_count']}")
        for p, pinfo in info.get("providers", {}).items():
            exp = " (EXPIRED)" if pinfo["is_expired"] else ""
            email = f" email={pinfo['email']}" if pinfo["email"] else ""
            plan = f" plan={pinfo['plan']}" if pinfo["plan"] else ""
            print(f"    - {p}: type={pinfo['auth_type']}{email}{plan} [{pinfo['masked_value']}]{exp}")
        print("\nHow to delete:")
        print("  - Single provider:   oma auth remove <provider>")
        print("  - All credentials:   oma auth flush --all")
        print("  - All + Task memory: oma auth flush --all --include-memory")
        if platform_compat.IS_WINDOWS:
            print(f"  - Manual purge:      del \"{info['credentials_file']}\" "
                  "&& rmdir /s /q .oma_memory")
        else:
            print("  - Manual purge:      rm -f ~/.oma/credentials.json && rm -rf .oma_memory/")


def cmd_memory(args):
    from oma.automation.memory import PersistentMemory
    mem_dir = getattr(args, "dir", None) or ".oma_memory"
    mem = PersistentMemory(base_dir=mem_dir)
    cmd = getattr(args, "memory_command", None) or "list"

    if cmd == "list":
        tasks = mem.list_tasks()
        if not tasks:
            print(f"No tasks stored in persistent memory ({mem_dir}).")
        else:
            print(f"Stored tasks in {mem_dir} ({len(tasks)}):")
            for t in sorted(tasks):
                print(f"  - {t}")

    elif cmd == "flush":
        task_id = getattr(args, "task_id", None)
        if not getattr(args, "yes", False):
            target = f"task '{task_id}'" if task_id else f"ALL tasks in {mem_dir}"
            try:
                ans = input(f"Are you sure you want to flush {target}? [y/N]: ")
                if ans.lower() not in ("y", "yes"):
                    print("Aborted.")
                    return
            except EOFError:
                pass
        count = mem.flush(task_id=task_id)
        if task_id:
            print(f"Flushed task '{task_id}' from memory.")
        else:
            print(f"Flushed {count} task memory files from {mem_dir}.")


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


def cmd_start(args):
    """Start the whole OMA system (dashboard, agent server, provider manager)."""
    try:
        from oma.providers.auth import AuthManager
        auth = AuthManager()
        stored = auth.status()
        logged_in = [p for p, s in stored.items() if s.get("status") == "logged_in"]
        info = auth.storage_info()
    except Exception:
        logged_in = []
        info = {}

    print("=" * 70)
    print("           OMA - Open Multi Agent System Running")
    print("=" * 70)
    print(f"  * Web GUI Dashboard:  http://{args.host}:{args.port}")
    print(f"  * REST API Status:    http://{args.host}:{args.port}/api/status")
    print(f"  * Local Vault:        {info.get('file', '~/.oma/credentials.json')} (mode: {info.get('mode', '0600')})")
    if logged_in:
        print(f"  * Active Providers:   {', '.join(logged_in)}")
    else:
        print("  * Active Providers:   None yet (connect in Web Dashboard or via 'oma auth add')")
    print("-" * 70)
    print("Ready to process tasks and workflows. Press Ctrl+C to stop.\n", flush=True)

    try:
        from oma.gui.web import run_web
        run_web(host=args.host, port=args.port, open_browser=not getattr(args, "no_browser", False))
    except ImportError as e:
        print(f"Web dependencies not installed: {e}")
        print("Install with: pip install oma-harness[web]")
        sys.exit(1)


def cmd_demo(args):
    print("=" * 70)
    print("            OMA - Open Multi Agent Onboarding Demo")
    print("=" * 70)
    print("\nWelcome to OMA! This walkthrough demonstrates how OMA coordinates")
    print("multiple AI subscriptions and API keys with autonomous self-healing.\n")

    print("[1/5] Core Architecture:")
    print("  * Zero-markup side-channel: connects to personal subscription sessions")
    print("    (Claude, ChatGPT, Gemini) or standard API keys (DeepSeek, GLM, Kimi).")
    print("  * Encrypted vault: credentials stored locally in ~/.oma/credentials.json")
    print("    with owner-only (0600) file permissions.")

    print("\n[2/5] Initializing Provider Registry & Router:")
    from oma.core.router import CircuitBreaker, Router, RoutingStrategy
    from oma.providers.registry import ProviderRegistry

    reg = ProviderRegistry()
    print("  * Registering simulated providers: claude (session), gemini (key), deepseek (key)...")
    router = Router(strategy=RoutingStrategy.AUTO)
    print(f"  * Active routing strategy: '{router.strategy.value}'")
    candidates = ["claude", "gemini", "deepseek"]
    chosen = router.select(candidates)
    print(f"  * Selected primary provider: {chosen}")

    print("\n[3/5] Testing Resilience & Circuit Breaker:")
    cb = CircuitBreaker(failure_threshold=3, recovery_timeout_s=0.1)
    print("  * Simulating upstream rate-limit error on primary provider...")
    cb.record_failure()
    cb.record_failure()
    cb.record_failure(immediate_open=True)
    print(f"  * CircuitBreaker state: {cb.state.value.upper()} (tripped on errors)")
    fallback = [c for c in candidates if c != chosen][0]
    print(f"  * Router dynamic failover to next provider: {fallback}")
    cb.state = cb.state.__class__.HALF_OPEN
    cb.record_success()
    print(f"  * Self-healing probe succeeded -> Breaker restored: {cb.state.value.upper()}")

    print("\n[4/5] Testing Output Sanitizer:")
    from oma.core.sanitize import Sanitizer
    sanitizer = Sanitizer()
    raw_sample = "Anthropic's Claude generated this solution.\nVerified architecture \u2014 latency reduced: \u2018optimal\u2019."
    clean_sample = sanitizer(raw_sample)
    print(f"  * Raw input:\n    {raw_sample.replace(chr(10), chr(10) + '    ')}")
    print(f"  * Sanitized:\n    {clean_sample.replace(chr(10), chr(10) + '    ')}")
    print("  * Stripped provider fingerprints, straightened curly quotes, normalized em dashes.")

    print("\n[5/5] Autonomous RALPH Execution (Simulated):")
    print("  * Objective: 'Generate resilient multi-provider routing schema'")
    print("  * Criteria: {'throughput': 'high', 'resilience': True}")
    print("  * [REASON] Iteration 1: Decomposing criteria and planning execution...")
    print("  * [ACT]    Attempt 1 via Claude -> candidate draft (confidence: 0.68)")
    print("  * [LEARN]  Confidence 0.68 < threshold 0.85 -> Extracting failure notes...")
    print("  * [PLAN]   Rotating provider preference to Gemini for iteration 2...")
    print("  * [REASON] Iteration 2: Applying lessons learned from iteration 1...")
    print("  * [ACT]    Attempt 2 via Gemini -> refined solution (confidence: 0.94)")
    print("  * [LEARN]  Confidence 0.94 >= threshold 0.85 -> Criteria gates PASSED!")
    print("  * [HANDOFF] Final verified artifact stored in memory.")

    print("\n" + "=" * 70)
    print("Onboarding Demo Complete!")
    print("\nNext steps to get started:")
    print("  * Web Dashboard:  oma web           (graphical UI with workflow studio)")
    print("  * Add Credential: oma auth add <provider> <key_or_session>")
    print("  * Verify Stored:  oma auth verify")
    print("  * Run Task:       oma run \"your objective here\"")
    print("=" * 70)


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
    p_run.add_argument("--provider", help="Force specific provider (e.g. gemini, deepseek, jev)")
    p_run.add_argument("--tier", choices=["t1", "t2", "t3"], help="Use specific tier primary routing (t1, t2, t3)")
    p_run.add_argument("--offline", action="store_true", help="Force offline self-healing simulation mode")

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

    # auth
    p_auth = sub.add_parser("auth", help="Manage provider authentication credentials")
    auth_sub = p_auth.add_subparsers(dest="auth_command", help="Auth subcommands")

    p_auth_add = auth_sub.add_parser("add", help="Add or update a provider credential")
    p_auth_add.add_argument("provider", help="Provider name (claude, chatgpt, gemini, deepseek, etc.)")
    p_auth_add.add_argument("key", help="API key or sessional key (token/cookie)")
    p_auth_add.add_argument("--type", choices=["auto", "cookie", "token", "api_key"], default="auto",
                           help="Credential type (default: auto-detect)")
    p_auth_add.add_argument("--email", help="Optional account email", default=None)
    p_auth_add.add_argument("--plan", help="Optional account plan (pro, plus, advanced, etc.)", default=None)

    p_auth_remove = auth_sub.add_parser("remove", help="Remove a stored credential")
    p_auth_remove.add_argument("provider", help="Provider name to remove")

    auth_sub.add_parser("status", help="List stored credentials and status")
    auth_sub.add_parser("list", help="List stored credentials and status")

    p_auth_verify = auth_sub.add_parser("verify", help="Verify stored credentials against provider APIs")
    p_auth_verify.add_argument("provider", nargs="?", default=None, help="Specific provider to verify")

    p_auth_flush = auth_sub.add_parser("flush", help="Securely wipe and flush credentials from disk")
    p_auth_flush.add_argument("--all", dest="flush_all", action="store_true", help="Flush all stored credentials")
    p_auth_flush.add_argument("--provider", help="Flush a specific provider credential", default=None)
    p_auth_flush.add_argument("--include-memory", action="store_true",
                              help="Also wipe task persistent memory (.oma_memory)")
    p_auth_flush.add_argument("--memory-dir", default=".oma_memory", help="Persistent memory directory")
    p_auth_flush.add_argument("-y", "--yes", action="store_true", help="Skip confirmation prompt")

    auth_sub.add_parser("info", help="Show exact storage locations, file permissions, and encryption status")

    # memory
    p_mem = sub.add_parser("memory", help="Manage persistent task memory")
    mem_sub = p_mem.add_subparsers(dest="memory_command", help="Memory subcommands")
    p_mem_list = mem_sub.add_parser("list", help="List stored tasks in persistent memory")
    p_mem_list.add_argument("--dir", default=".oma_memory", help="Memory directory")

    p_mem_flush = mem_sub.add_parser("flush", help="Flush persistent task memory")
    p_mem_flush.add_argument("--task-id", help="Specific task ID to flush (default: all)")
    p_mem_flush.add_argument("--dir", default=".oma_memory", help="Memory directory")
    p_mem_flush.add_argument("-y", "--yes", action="store_true", help="Skip confirmation prompt")

    # demo
    sub.add_parser("demo", help="Run interactive onboarding demo")

    # start
    p_start = sub.add_parser("start", help="Start the whole OMA system (server + dashboard)")
    p_start.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    p_start.add_argument("--port", type=int, default=8384, help="Port number (default: 8384)")
    p_start.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        print("\nTip: New to OMA? Run 'oma demo' for a guided tour, or 'oma start' to launch the whole system.")
        sys.exit(0)

    dispatch = {
        "run": cmd_run,
        "status": cmd_status,
        "providers": cmd_providers,
        "auth": cmd_auth,
        "memory": cmd_memory,
        "gui": cmd_gui,
        "web": cmd_web,
        "demo": cmd_demo,
        "start": cmd_start,
    }

    dispatch[args.command](args)


if __name__ == "__main__":
    main()
