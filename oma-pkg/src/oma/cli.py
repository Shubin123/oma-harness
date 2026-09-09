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

    agent = OMA.load()

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
        providers_to_test = [provider] if provider else list(mgr.all_providers().keys())
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

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(0)

    dispatch = {
        "run": cmd_run,
        "status": cmd_status,
        "providers": cmd_providers,
        "auth": cmd_auth,
        "memory": cmd_memory,
        "gui": cmd_gui,
        "web": cmd_web,
    }

    dispatch[args.command](args)


if __name__ == "__main__":
    main()
