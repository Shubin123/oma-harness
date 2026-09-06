#!/usr/bin/env bash
set -euo pipefail

# ---- OMA macOS binary builder (with build caching) ----
# Run this on your Mac to produce dist/oma
#
# Caching: tracks source hashes in .build_cache/
#   - Skips pip install if pyproject.toml unchanged
#   - Skips tests if source + test files unchanged since last green run
#   - Skips PyInstaller build if source + spec unchanged and binary exists
#   - Use --clean to force a full rebuild
#
# Prerequisites:
#   brew install python@3.12   (or any 3.10+)
#   pip install pyinstaller
#
# For universal2 (Intel + Apple Silicon):
#   Install Python universal2 build from python.org
#   Then: pyinstaller --target-arch universal2 oma.spec

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ---- cache setup ----
CACHE_DIR=".build_cache"
mkdir -p "$CACHE_DIR"

FORCE_CLEAN=false
if [ "${1:-}" = "--clean" ] || [ "${1:-}" = "-c" ]; then
    FORCE_CLEAN=true
    rm -rf "$CACHE_DIR"/*
    echo "=== Clean build (cache cleared) ==="
fi

# hash a set of files into a single sha256
_hash_files() {
    # accepts file paths as arguments, outputs a single hash
    # sorts for determinism, skips missing files
    local tmp=""
    for f in "$@"; do
        if [ -f "$f" ]; then
            tmp+="$(shasum -a 256 "$f" 2>/dev/null || sha256sum "$f" 2>/dev/null || echo "nohash $f")"$'\n'
        fi
    done
    echo "$tmp" | sort | shasum -a 256 | cut -d' ' -f1
}

# hash all source files
_hash_sources() {
    local files=()
    while IFS= read -r f; do
        files+=("$f")
    done < <(find src/oma -name '*.py' -type f 2>/dev/null | sort)
    _hash_files "${files[@]}"
}

# hash test files
_hash_tests() {
    local files=()
    while IFS= read -r f; do
        files+=("$f")
    done < <(find tests -name '*.py' -type f 2>/dev/null | sort)
    _hash_files "${files[@]}"
}

# check if a cache key matches
_cache_hit() {
    local key="$1" current_hash="$2"
    local cached="${CACHE_DIR}/${key}.hash"
    if [ -f "$cached" ] && [ "$(cat "$cached")" = "$current_hash" ]; then
        return 0
    fi
    return 1
}

# write a cache key
_cache_set() {
    local key="$1" hash="$2"
    echo "$hash" > "${CACHE_DIR}/${key}.hash"
}

echo "=== OMA macOS binary builder ==="

# ---- find Python ----
if [ -n "${PYTHON:-}" ]; then
    true
elif command -v python3.12 &>/dev/null; then
    PYTHON=python3.12
elif command -v python3.11 &>/dev/null; then
    PYTHON=python3.11
elif command -v python3.10 &>/dev/null; then
    PYTHON=python3.10
else
    PYTHON=python3
fi

PY_VER=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$("$PYTHON" -c "import sys; print(sys.version_info.major)")
PY_MINOR=$("$PYTHON" -c "import sys; print(sys.version_info.minor)")
echo "Python: $PYTHON ($PY_VER)"

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    echo ""
    echo "ERROR: Python 3.10+ required, found $PY_VER"
    echo ""
    echo "Fix: brew install python@3.12"
    echo " or: PYTHON=/path/to/python3.12 ./build_macos.sh"
    exit 1
fi

# ---- remove enum34 if present ----
if "$PYTHON" -m pip show enum34 &>/dev/null; then
    echo "Removing obsolete enum34 (incompatible with PyInstaller)..."
    "$PYTHON" -m pip uninstall enum34 -y
fi

# ---- check pyinstaller ----
if ! "$PYTHON" -m PyInstaller --version &>/dev/null; then
    echo "Installing PyInstaller..."
    "$PYTHON" -m pip install pyinstaller
fi

# ---- pip install (cached on pyproject.toml) ----
PROJ_HASH=$(_hash_files pyproject.toml setup.cfg setup.py 2>/dev/null)

if ! $FORCE_CLEAN && _cache_hit "pip_install" "$PROJ_HASH"; then
    echo "Dependencies: unchanged (cached)"
else
    echo "Installing oma-harness in dev mode..."
    "$PYTHON" -m pip install -e "." --quiet
    "$PYTHON" -m pip install pytest --quiet
    _cache_set "pip_install" "$PROJ_HASH"
fi

# ---- tests (cached on source + test hash) ----
SRC_HASH=$(_hash_sources)
TEST_HASH=$(_hash_tests)
TEST_KEY="${SRC_HASH}:${TEST_HASH}"

if ! $FORCE_CLEAN && _cache_hit "tests_pass" "$TEST_KEY"; then
    echo "Tests: all passed (cached, no source changes)"
else
    echo "Running tests..."
    "$PYTHON" -m pytest tests/ -v --tb=short || {
        echo "Tests failed! Fix before building."
        # clear test cache so next run retries
        rm -f "${CACHE_DIR}/tests_pass.hash"
        exit 1
    }
    _cache_set "tests_pass" "$TEST_KEY"
fi

# ---- build (cached on source + spec hash + binary existence) ----
SPEC_HASH=$(_hash_files oma.spec)
BUILD_KEY="${SRC_HASH}:${SPEC_HASH}"
BINARY="dist/oma"

if ! $FORCE_CLEAN && _cache_hit "build" "$BUILD_KEY" && [ -f "$BINARY" ]; then
    echo "Build: binary up to date (cached, no source changes)"
    BUILT_SIZE=$(du -h "$BINARY" | cut -f1)
    echo "Binary: $BINARY ($BUILT_SIZE)"
else
    echo "Building macOS binary..."
    "$PYTHON" -m PyInstaller oma.spec --noconfirm
    _cache_set "build" "$BUILD_KEY"
fi

# ---- verify ----
echo ""
echo "Verifying binary..."
if [ -f "$BINARY" ]; then
    SIZE=$(du -h "$BINARY" | cut -f1)
    echo "Binary: $BINARY ($SIZE)"

    "$BINARY" --help && echo "CLI: OK" || echo "CLI: FAILED"
    "$BINARY" providers && echo "Providers: OK" || echo "Providers: FAILED"

    file "$BINARY"

    echo ""
    echo "=== Build complete ==="
    echo "Binary at: $BINARY"
    echo ""
    echo "To install system-wide:"
    echo "  cp $BINARY /usr/local/bin/oma"
    echo ""
    echo "To run:"
    echo "  ./dist/oma run 'your task here'"
    echo "  ./dist/oma gui"
    echo "  ./dist/oma web"
else
    echo "ERROR: Binary not found at $BINARY"
    exit 1
fi
