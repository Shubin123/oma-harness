"""
Cross-platform helpers for machine identity and owner-only file permissions.

POSIX gets owner-only storage for free through the file mode. Windows has no
mode bits that mean anything -- `os.chmod` there only toggles the read-only
attribute -- so "owner-only" has to be spelled out as an ACL through `icacls`.
Everything that stores credentials or task memory goes through this module so
the guarantee is the same on every platform.
"""

import getpass
import os
import platform
import stat
import subprocess
import sys
from pathlib import Path

IS_WINDOWS = os.name == "nt"
IS_MACOS = sys.platform == "darwin"

DIR_MODE = 0o700
FILE_MODE = 0o600

# What storage_info() reports for a locked-down path on each platform.
OWNER_ONLY_ACL = "owner-only (ACL)"

# A POSIX 0600 file is still readable by root, so the Windows equivalent of
# "owner-only" allows the machine's privileged principals and nobody else.
# Anything outside this set -- Users, Everyone, Authenticated Users, another
# account -- means the path is shared.
_SYSTEM_PRINCIPALS = {
    "nt authority\\system",
    "builtin\\administrators",
    "owner rights",
    "creator owner",
}


def _run(cmd: list[str], timeout: int = 10) -> subprocess.CompletedProcess | None:
    """Run a helper command, returning None if it is missing or misbehaves."""
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None


def current_user() -> str:
    r"""The account this process runs as, as `DOMAIN\user` on Windows."""
    try:
        user = getpass.getuser()
    except Exception:  # pragma: no cover - getuser can fail with no env at all
        user = os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"
    if IS_WINDOWS:
        domain = os.environ.get("USERDOMAIN")
        if domain and "\\" not in user:
            return f"{domain}\\{user}"
    return user


def machine_id() -> str:
    """
    A stable per-machine identifier, used as key material for the credential
    store. Falls back to hostname + username when no platform source answers.
    """
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            with open(path) as f:
                value = f.read().strip()
            if value:
                return value
        except OSError:
            continue

    if IS_MACOS:
        result = _run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], timeout=5)
        if result:
            for line in result.stdout.split("\n"):
                if "IOPlatformUUID" in line:
                    try:
                        return str(line.split('"')[-2])
                    except IndexError:
                        break

    if IS_WINDOWS:
        try:
            import winreg

            # winreg exists only on Windows, so a type-checker running on
            # Linux or macOS cannot see any of its members.
            with winreg.OpenKey(  # type: ignore[attr-defined]
                winreg.HKEY_LOCAL_MACHINE,  # type: ignore[attr-defined]
                r"SOFTWARE\Microsoft\Cryptography",
                0,
                winreg.KEY_READ | winreg.KEY_WOW64_64KEY,  # type: ignore[attr-defined]
            ) as key:
                guid, _ = winreg.QueryValueEx(key, "MachineGuid")  # type: ignore[attr-defined]
            if guid:
                return str(guid)
        except (ImportError, OSError):
            pass

    return f"{platform.node()}:{current_user()}"


def _icacls_restrict(path: Path, is_dir: bool) -> bool:
    """Drop inherited ACEs and grant the current user sole full control."""
    rights = "(OI)(CI)(F)" if is_dir else "(F)"
    result = _run([
        "icacls", str(path),
        "/inheritance:r",
        "/grant:r", f"{current_user()}:{rights}",
    ])
    if not result or result.returncode != 0:
        return False

    # /inheritance:r only clears inherited entries. A store an older release
    # left open -- or one someone shared deliberately -- carries explicit ACEs
    # that survive the grant, so strip whatever is left beyond owner and system.
    me = current_user().lower()
    me_short = me.rsplit("\\", 1)[-1]
    for principal in _icacls_principals(path) or []:
        name = principal.lower()
        if name in (me, me_short) or name.rsplit("\\", 1)[-1] == me_short:
            continue
        if name in _SYSTEM_PRINCIPALS:
            continue
        target = f"*{principal}" if principal.upper().startswith("S-1-") else principal
        _run(["icacls", str(path), "/remove:g", target, "/remove:d", target])

    return True


def restrict_to_owner(path: Path | str) -> bool:
    """
    Make `path` readable and writable by its owner alone.

    Returns True when the platform-appropriate restriction was applied.
    Missing paths and permission failures are reported as False rather than
    raised: callers treat hardening as best-effort, the same way the POSIX
    code always has.
    """
    p = Path(path)
    if not p.exists():
        return False

    if IS_WINDOWS:
        return _icacls_restrict(p, p.is_dir())

    try:
        os.chmod(p, DIR_MODE if p.is_dir() else FILE_MODE)
        return True
    except OSError:
        return False


def make_private_dir(path: Path | str) -> Path:
    """Create a directory (with parents) that only the owner can enter."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    restrict_to_owner(p)
    return p


def _icacls_principals(path: Path) -> list[str] | None:
    """Principals holding an ACE on `path`, or None if icacls is unavailable."""
    result = _run(["icacls", str(path)])
    if not result or result.returncode != 0:
        return None

    principals = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("successfully processed"):
            continue
        # Lines read '<path> DOMAIN\\user:(F)' then 'DOMAIN\\user:(F)' per ACE.
        if str(path) in line:
            line = line.replace(str(path), "", 1).strip()
        if ":" not in line:
            continue
        principal = line.rsplit(":(", 1)[0].strip()
        if principal:
            principals.append(principal)
    return principals


def is_owner_only(path: Path | str) -> bool:
    """
    Verify that nobody but the owner can read `path`.

    On POSIX this is the mode; on Windows it is an ACL naming the current user
    and, at most, the machine's privileged principals -- the same access root
    keeps to a 0600 file.
    """
    p = Path(path)
    if not p.exists():
        return False

    if IS_WINDOWS:
        principals = _icacls_principals(p)
        if not principals:
            return False
        me = current_user().lower()
        me_short = me.rsplit("\\", 1)[-1]
        for principal in principals:
            name = principal.lower()
            if name in (me, me_short) or name.rsplit("\\", 1)[-1] == me_short:
                continue
            if name in _SYSTEM_PRINCIPALS:
                continue
            return False
        return True

    mode = stat.S_IMODE(p.stat().st_mode)
    return not mode & (stat.S_IRWXG | stat.S_IRWXO)


def describe_permissions(path: Path | str) -> str | None:
    """
    A human-readable permission summary for storage_info(), or None if the
    path is gone: an octal mode on POSIX, an ACL verdict on Windows.
    """
    p = Path(path)
    if not p.exists():
        return None
    if IS_WINDOWS:
        return OWNER_ONLY_ACL if is_owner_only(p) else "shared (ACL)"
    return oct(stat.S_IMODE(p.stat().st_mode))


def expected_permissions(is_dir: bool) -> str:
    """What describe_permissions() reports for a correctly restricted path."""
    if IS_WINDOWS:
        return OWNER_ONLY_ACL
    return oct(DIR_MODE if is_dir else FILE_MODE)
