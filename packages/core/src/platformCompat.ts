/**
 * Cross-platform helpers for machine identity and owner-only file permissions.
 *
 * POSIX gets owner-only storage for free through the file mode. Windows has no
 * mode bits that mean anything -- `fs.chmodSync` there only toggles the
 * read-only attribute -- so "owner-only" has to be spelled out as an ACL
 * through `icacls`. Everything that stores credentials or task memory goes
 * through this module so the guarantee is the same on every platform.
 *
 * Mirrors src/oma/platform_compat.py in the Python implementation.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export const IS_WINDOWS = process.platform === 'win32';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** What describePermissions() reports for a locked-down path on Windows. */
export const OWNER_ONLY_ACL = 'owner-only (ACL)';

/**
 * A POSIX 0600 file is still readable by root, so the Windows equivalent of
 * "owner-only" allows the machine's privileged principals and nobody else.
 */
const SYSTEM_PRINCIPALS = new Set([
  'nt authority\\system',
  'builtin\\administrators',
  'owner rights',
  'creator owner',
]);

function run(cmd: string, args: string[], timeout = 10_000): string | null {
  try {
    return execFileSync(cmd, args, { timeout, encoding: 'utf-8', windowsHide: true });
  } catch {
    return null;
  }
}

/** The account this process runs as, as `DOMAIN\\user` on Windows. */
export function currentUser(): string {
  let user: string;
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USERNAME ?? process.env.USER ?? 'unknown';
  }
  if (IS_WINDOWS) {
    const domain = process.env.USERDOMAIN;
    if (domain && !user.includes('\\')) return `${domain}\\${user}`;
  }
  return user;
}

/**
 * A stable per-machine identifier, used as key material for the credential
 * store. Falls back to hostname + username when no platform source answers.
 */
export function machineId(): string {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fs.readFileSync(p, 'utf-8').trim();
      if (value) return value;
    } catch { /* not this platform */ }
  }

  if (process.platform === 'darwin') {
    const out = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 5000);
    if (out) {
      for (const line of out.split('\n')) {
        if (line.includes('IOPlatformUUID')) {
          const uuid = line.split('"').at(-2);
          if (uuid) return uuid;
        }
      }
    }
  }

  if (IS_WINDOWS) {
    const out = run('reg', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v', 'MachineGuid', '/reg:64',
    ]);
    const match = out?.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    if (match) return match[1];
  }

  return `${os.hostname()}:${currentUser()}`;
}

/** Principals holding an ACE on `target`, or null if icacls is unavailable. */
function icaclsPrincipals(target: string): string[] | null {
  const out = run('icacls', [target]);
  if (out === null) return null;

  const principals: string[] = [];
  for (const rawLine of out.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith('successfully processed')) continue;
    if (line.includes(target)) line = line.replace(target, '').trim();
    if (!line.includes(':')) continue;
    const principal = line.split(':(')[0].trim();
    if (principal) principals.push(principal);
  }
  return principals;
}

function matchesCurrentUser(principal: string): boolean {
  const me = currentUser().toLowerCase();
  const short = me.split('\\').at(-1)!;
  const name = principal.toLowerCase();
  return name === me || name === short || name.split('\\').at(-1) === short;
}

function icaclsRestrict(target: string, isDir: boolean): boolean {
  const rights = isDir ? '(OI)(CI)(F)' : '(F)';
  const granted = run('icacls', [
    target, '/inheritance:r', '/grant:r', `${currentUser()}:${rights}`,
  ]);
  if (granted === null) return false;

  // /inheritance:r only clears inherited entries. A store an older release
  // left open carries explicit ACEs that survive the grant, so strip whatever
  // is left beyond owner and system.
  for (const principal of icaclsPrincipals(target) ?? []) {
    if (matchesCurrentUser(principal)) continue;
    if (SYSTEM_PRINCIPALS.has(principal.toLowerCase())) continue;
    const name = principal.toUpperCase().startsWith('S-1-') ? `*${principal}` : principal;
    run('icacls', [target, '/remove:g', name, '/remove:d', name]);
  }
  return true;
}

/**
 * Make `target` readable and writable by its owner alone. Reports failure
 * rather than throwing: callers treat hardening as best-effort.
 */
export function restrictToOwner(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  const isDir = fs.statSync(target).isDirectory();

  if (IS_WINDOWS) return icaclsRestrict(target, isDir);

  try {
    fs.chmodSync(target, isDir ? DIR_MODE : FILE_MODE);
    return true;
  } catch {
    return false;
  }
}

/** Create a directory (with parents) that only the owner can enter. */
export function makePrivateDir(target: string): string {
  fs.mkdirSync(target, { recursive: true, mode: DIR_MODE });
  restrictToOwner(target);
  return target;
}

/** Verify that nobody but the owner can read `target`. */
export function isOwnerOnly(target: string): boolean {
  if (!fs.existsSync(target)) return false;

  if (IS_WINDOWS) {
    const principals = icaclsPrincipals(target);
    if (!principals || principals.length === 0) return false;
    return principals.every(
      (p) => matchesCurrentUser(p) || SYSTEM_PRINCIPALS.has(p.toLowerCase()),
    );
  }

  const mode = fs.statSync(target).mode & 0o777;
  return (mode & 0o077) === 0;
}

/**
 * A human-readable permission summary for storage info, or null if the path
 * is gone: an octal mode on POSIX, an ACL verdict on Windows.
 */
export function describePermissions(target: string): string | null {
  if (!fs.existsSync(target)) return null;
  if (IS_WINDOWS) return isOwnerOnly(target) ? OWNER_ONLY_ACL : 'shared (ACL)';
  return '0o' + (fs.statSync(target).mode & 0o777).toString(8);
}

/** What describePermissions() reports for a correctly restricted path. */
export function expectedPermissions(isDir: boolean): string {
  if (IS_WINDOWS) return OWNER_ONLY_ACL;
  return '0o' + (isDir ? DIR_MODE : FILE_MODE).toString(8);
}
