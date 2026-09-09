#!/usr/bin/env python3
"""
OMA build driver -- one entry point for every platform and both runtimes.

    python tools/build.py                 # build what this machine can build
    python tools/build.py --target python # PyInstaller binary only
    python tools/build.py --target node   # Node SEA binary only
    python tools/build.py --wheel         # also build the wheel and sdist
    python tools/build.py --clean         # ignore the cache, rebuild from scratch
    python tools/build.py --skip-tests    # skip the pre-build test run

Everything lands in dist/ at the repository root:

    dist/oma-<platform>-<arch>[.exe]          the Python binary
    dist/oma-node-<platform>-<arch>[.exe]     the Node binary
    dist/*.tar.gz | *.zip                     one archive per binary
    dist/SHA256SUMS                           checksums for every artifact

This is the same script CI runs, so a release built locally and a release
built by a runner go through identical steps. It is plain Python 3.10+ with
no third-party imports, so it works from cmd.exe, PowerShell, and any shell.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "oma-pkg"
TS = ROOT / "oma-ts"
DIST = ROOT / "dist"
CACHE = ROOT / ".build_cache"

IS_WINDOWS = os.name == "nt"
IS_MACOS = sys.platform == "darwin"
EXE_SUFFIX = ".exe" if IS_WINDOWS else ""

# The fuse postject looks for inside the Node binary. Fixed by Node itself.
SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"


# --- output -----------------------------------------------------------------

def step(message: str) -> None:
    print(f"\n==> {message}", flush=True)


def info(message: str) -> None:
    print(f"    {message}", flush=True)


def fail(message: str) -> None:
    print(f"\nERROR: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


# --- process helpers --------------------------------------------------------

def run(cmd: list[str], cwd: Path, env: dict | None = None) -> None:
    """Run a build command, failing the build if it does."""
    info(" ".join(str(c) for c in cmd))
    result = subprocess.run(cmd, cwd=str(cwd), env=env)
    if result.returncode != 0:
        fail(f"command failed ({result.returncode}): {' '.join(str(c) for c in cmd)}")


def npx(args: list[str]) -> list[str]:
    """npx is a .cmd shim on Windows, which needs the shell-aware name."""
    return [shutil.which("npx.cmd") or "npx.cmd" if IS_WINDOWS else "npx", *args]


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


# --- naming -----------------------------------------------------------------

def platform_tag() -> str:
    if IS_WINDOWS:
        return "windows"
    if IS_MACOS:
        return "macos"
    return sys.platform.replace("linux2", "linux")


def arch_tag() -> str:
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        return "x64"
    if machine in ("arm64", "aarch64"):
        return "arm64"
    return machine or "unknown"


def artifact_name(prefix: str) -> str:
    return f"{prefix}-{platform_tag()}-{arch_tag()}{EXE_SUFFIX}"


# --- caching ----------------------------------------------------------------

def hash_tree(*globs: tuple[Path, str]) -> str:
    """Hash every file matched by (directory, pattern) pairs, order-independent."""
    digest = hashlib.sha256()
    files: list[Path] = []
    for base, pattern in globs:
        if base.exists():
            files.extend(sorted(p for p in base.glob(pattern) if p.is_file()))
    for path in sorted(files):
        digest.update(path.relative_to(ROOT).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def cache_get(key: str) -> str | None:
    path = CACHE / f"{key}.hash"
    return path.read_text().strip() if path.exists() else None


def cache_put(key: str, value: str) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    (CACHE / f"{key}.hash").write_text(value)


# --- packaging --------------------------------------------------------------

def package(binary: Path) -> Path:
    """Archive one binary: zip on Windows, tar.gz elsewhere. Returns the archive."""
    DIST.mkdir(parents=True, exist_ok=True)
    if IS_WINDOWS:
        archive = DIST / f"{binary.stem}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(binary, binary.name)
    else:
        archive = DIST / f"{binary.name}.tar.gz"
        with tarfile.open(archive, "w:gz") as tf:
            # Preserve the executable bit for whoever unpacks it.
            tf.add(binary, arcname=binary.name)
    info(f"packaged {archive.name} ({archive.stat().st_size // 1024} KB)")
    return archive


def write_checksums() -> None:
    """Write SHA256SUMS covering every artifact in dist/."""
    lines = []
    for path in sorted(DIST.iterdir()):
        if not path.is_file() or path.name == "SHA256SUMS":
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.name}")
    (DIST / "SHA256SUMS").write_text("\n".join(lines) + "\n")
    step("Checksums")
    for line in lines:
        info(line)


def verify(binary: Path) -> None:
    """A binary that cannot print its own help is not a release artifact."""
    result = subprocess.run([str(binary), "--help"], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        fail(f"{binary.name} --help exited {result.returncode}: {result.stderr[:400]}")
    info(f"verified {binary.name} responds to --help")


# --- python target ----------------------------------------------------------

def build_python(clean: bool, skip_tests: bool) -> Path:
    step("Python binary (PyInstaller)")
    if not PKG.exists():
        fail(f"missing package directory: {PKG}")

    ensure_pyinstaller()

    if not skip_tests:
        run_python_tests()

    sources = hash_tree((PKG / "src", "**/*.py"), (PKG, "oma.spec"))
    target = DIST / artifact_name("oma")
    if not clean and target.exists() and cache_get("python-binary") == sources:
        info("sources unchanged since the last build, reusing the existing binary")
        return target

    build_dir = PKG / "build"
    if clean and build_dir.exists():
        shutil.rmtree(build_dir, ignore_errors=True)

    run([sys.executable, "-m", "PyInstaller", "oma.spec", "--clean", "--noconfirm"], cwd=PKG)

    built = PKG / "dist" / f"oma{EXE_SUFFIX}"
    if not built.exists():
        fail(f"PyInstaller produced no binary at {built}")

    DIST.mkdir(parents=True, exist_ok=True)
    shutil.copy2(built, target)
    if not IS_WINDOWS:
        target.chmod(0o755)
    info(f"built {target.name} ({target.stat().st_size // 1024} KB)")

    verify(target)
    cache_put("python-binary", sources)
    return target


def ensure_pyinstaller() -> None:
    probe = subprocess.run(
        [sys.executable, "-c", "import PyInstaller"], capture_output=True
    )
    if probe.returncode != 0:
        info("PyInstaller not installed, installing it")
        run([sys.executable, "-m", "pip", "install", "pyinstaller"], cwd=ROOT)


def run_python_tests() -> None:
    sources = hash_tree((PKG / "src", "**/*.py"), (PKG / "tests", "**/*.py"))
    if cache_get("python-tests") == sources:
        info("tests already green for these sources, skipping")
        return
    run([sys.executable, "-m", "pytest", "tests/", "-q", "--tb=short", "-m", "not live"], cwd=PKG)
    cache_put("python-tests", sources)


def build_wheel() -> list[Path]:
    step("Wheel and sdist")
    probe = subprocess.run([sys.executable, "-c", "import build"], capture_output=True)
    if probe.returncode != 0:
        run([sys.executable, "-m", "pip", "install", "build"], cwd=ROOT)
    run([sys.executable, "-m", "build", "--outdir", str(DIST)], cwd=PKG)
    return [p for p in DIST.iterdir() if p.suffix in (".whl",) or p.name.endswith(".tar.gz")]


# --- node target ------------------------------------------------------------

def build_node(clean: bool, skip_tests: bool) -> Path | None:
    step("Node binary (Single Executable Application)")
    if not TS.exists():
        fail(f"missing TypeScript directory: {TS}")
    if not have("node"):
        info("node not found on PATH, skipping the Node binary")
        return None

    major = int(subprocess.run(["node", "-v"], capture_output=True, text=True)
                .stdout.strip().lstrip("v").split(".")[0])
    if major < 20:
        fail(f"Node 20+ is required for Single Executable Applications, found v{major}")
    info(f"node v{major}")

    if clean or not (TS / "node_modules").exists():
        run(["npm.cmd" if IS_WINDOWS else "npm", "install"], cwd=TS)

    sources = hash_tree((TS / "src", "**/*.ts"))
    target = DIST / artifact_name("oma-node")
    if not clean and target.exists() and cache_get("node-binary") == sources:
        info("sources unchanged since the last build, reusing the existing binary")
        return target

    run(npx(["tsc"]), cwd=TS)
    if not skip_tests:
        run(["node", "--test", "dist/"], cwd=TS)

    # SEA only accepts a CommonJS entry point: an ESM bundle fails at blob
    # generation with "Cannot use import statement outside a module".
    bundle = TS / "dist" / "oma-bundle.cjs"
    run(npx([
        "esbuild", "src/cli.ts", "--bundle", "--platform=node",
        "--target=node20", "--format=cjs",
        f"--outfile={bundle.relative_to(TS).as_posix()}",
    ]), cwd=TS)

    bin_dir = TS / "oma-bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    sea_config = bin_dir / "sea-config.json"
    # Paths in a SEA config resolve against the working directory, not the
    # config file, so both are written relative to oma-ts.
    sea_config.write_text(json.dumps({
        "main": "dist/oma-bundle.cjs",
        "output": "oma-bin/sea-prep.blob",
        "disableExperimentalSEAWarning": True,
        "useSnapshot": False,
        "useCodeCache": True,
    }, indent=2))
    run(["node", "--experimental-sea-config",
         sea_config.relative_to(TS).as_posix()], cwd=TS)

    binary = bin_dir / f"oma{EXE_SUFFIX}"
    node_path = Path(shutil.which("node"))
    shutil.copy2(node_path, binary)

    if IS_MACOS:
        # The blob cannot be injected into a signed binary, and the result has
        # to be re-signed or macOS refuses to run it.
        subprocess.run(["codesign", "--remove-signature", str(binary)], capture_output=True)

    postject = ["postject", str(binary), "NODE_SEA_BLOB",
                str(bin_dir / "sea-prep.blob"), "--sentinel-fuse", SEA_FUSE]
    if IS_MACOS:
        postject += ["--macho-segment-name", "NODE_SEA"]
    run(npx(postject), cwd=TS)

    if IS_MACOS:
        subprocess.run(["codesign", "--sign", "-", str(binary)], capture_output=True)
    if not IS_WINDOWS:
        binary.chmod(0o755)

    DIST.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, target)
    if not IS_WINDOWS:
        target.chmod(0o755)
    info(f"built {target.name} ({target.stat().st_size // 1024} KB)")

    verify(target)
    cache_put("node-binary", sources)
    return target


# --- entry point ------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build OMA binaries for the current platform.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--target", choices=["python", "node", "all"], default="all",
                        help="which runtime to build (default: all)")
    parser.add_argument("--wheel", action="store_true",
                        help="also build the Python wheel and sdist")
    parser.add_argument("--clean", action="store_true",
                        help="ignore the build cache and rebuild from scratch")
    parser.add_argument("--skip-tests", action="store_true",
                        help="do not run the test suites before building")
    args = parser.parse_args()

    if args.clean and CACHE.exists():
        shutil.rmtree(CACHE, ignore_errors=True)
    if args.clean and DIST.exists():
        shutil.rmtree(DIST, ignore_errors=True)
    DIST.mkdir(parents=True, exist_ok=True)

    print(f"OMA build -- {platform_tag()}-{arch_tag()}, python {platform.python_version()}")

    binaries: list[Path] = []
    if args.target in ("python", "all"):
        binaries.append(build_python(args.clean, args.skip_tests))
    if args.target in ("node", "all"):
        node_binary = build_node(args.clean, args.skip_tests)
        if node_binary:
            binaries.append(node_binary)

    step("Packaging")
    for binary in binaries:
        package(binary)
    if args.wheel:
        build_wheel()

    write_checksums()

    step("Done")
    for path in sorted(DIST.iterdir()):
        info(f"{path.name}  ({path.stat().st_size // 1024} KB)")
    print(f"\nArtifacts in {DIST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
