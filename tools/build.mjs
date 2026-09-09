#!/usr/bin/env node
/**
 * Node-side entry point for the OMA build.
 *
 * The build itself lives in tools/build.py; this wrapper exists so `npm run
 * build:binary` works from any shell without the caller knowing whether the
 * Python interpreter on this machine is called `python` or `python3`. On
 * Windows, `python3` is usually a Microsoft Store stub that exits without
 * running anything, so candidates are probed rather than assumed.
 *
 *   node tools/build.mjs [--target node] [--clean] ...
 *
 * Arguments are passed through to tools/build.py unchanged.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'build.py');
const candidates = process.platform === 'win32'
  ? ['python', 'py', 'python3']
  : ['python3', 'python'];

// The `py` launcher reads the script's `#!/usr/bin/env python3` shebang and
// re-dispatches to `python3`, which on Windows is the Store stub. `-3` pins it
// to a real interpreter instead.
const prefix = (exe) => (exe === 'py' ? ['-3'] : []);

for (const exe of candidates) {
  // The Store stub can exit 0 on `--version` while being unable to run
  // anything, so the probe asks for output only a real interpreter produces.
  const probe = spawnSync(
    exe,
    [...prefix(exe), '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
    { encoding: 'utf-8' },
  );
  if (probe.error || probe.status !== 0) continue;
  const [major, minor] = probe.stdout.trim().split('.').map(Number);
  if (major !== 3 || minor < 10) continue;

  const result = spawnSync(exe, [...prefix(exe), script, ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

console.error(
  'No working Python interpreter found. OMA builds need Python 3.10 or newer ' +
  `on PATH (tried: ${candidates.join(', ')}).`,
);
process.exit(1);
