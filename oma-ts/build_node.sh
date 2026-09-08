#!/usr/bin/env bash
set -euo pipefail

# ---- OMA Node.js binary builder ----
# Produces a standalone executable using Node.js Single Executable Applications (SEA).
#
# Prerequisites:
#   node >= 20.0.0
#   npm install (dev deps including esbuild)
#
# Usage:
#   ./build_node.sh          # build for current platform
#   ./build_node.sh --clean  # clean and rebuild

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

FORCE_CLEAN=false
if [ "${1:-}" = "--clean" ] || [ "${1:-}" = "-c" ]; then
    FORCE_CLEAN=true
    echo "=== Clean build ==="
    rm -rf dist oma-bin
fi

echo "=== OMA Node.js binary builder ==="

# ---- check node version ----
NODE_VER=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
echo "Node.js: v${NODE_VER}"

if [ "$NODE_MAJOR" -lt 20 ]; then
    echo ""
    echo "ERROR: Node.js 20+ required for Single Executable Applications, found v${NODE_VER}"
    echo ""
    echo "Fix: brew install node@20   (macOS)"
    echo " or: nvm install 20         (any platform)"
    exit 1
fi

# ---- install deps if needed ----
if [ ! -d "node_modules" ] || $FORCE_CLEAN; then
    echo "Installing dependencies..."
    npm install
fi

# ---- compile TypeScript ----
echo "Compiling TypeScript..."
npx tsc

# ---- bundle with esbuild ----
echo "Bundling with esbuild..."
npx esbuild src/cli.ts \
    --bundle \
    --platform=node \
    --target=node20 \
    --format=esm \
    --outfile=dist/oma-bundle.mjs \
    --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

# ---- create SEA blob ----
echo "Creating SEA configuration..."
mkdir -p oma-bin

cat > oma-bin/sea-config.json <<'SEAEOF'
{
  "main": "../dist/oma-bundle.mjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
SEAEOF

echo "Generating SEA blob..."
node --experimental-sea-config oma-bin/sea-config.json

# ---- create executable ----
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Darwin)
        PLATFORM="macos"
        BINARY_NAME="oma"
        ;;
    Linux)
        PLATFORM="linux"
        BINARY_NAME="oma"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        PLATFORM="windows"
        BINARY_NAME="oma.exe"
        ;;
    *)
        PLATFORM="$(echo "$OS" | tr '[:upper:]' '[:lower:]')"
        BINARY_NAME="oma"
        ;;
esac

case "$ARCH" in
    x86_64|amd64) ARCH_LABEL="x64" ;;
    arm64|aarch64) ARCH_LABEL="arm64" ;;
    *) ARCH_LABEL="$ARCH" ;;
esac

DIST_NAME="oma-${PLATFORM}-${ARCH_LABEL}"
BINARY_PATH="oma-bin/${BINARY_NAME}"

echo "Creating executable for ${PLATFORM}-${ARCH_LABEL}..."

# copy node binary as base
cp "$(command -v node)" "$BINARY_PATH"

if [ "$OS" = "Darwin" ]; then
    # macOS: remove signature, inject blob, re-sign
    codesign --remove-signature "$BINARY_PATH" 2>/dev/null || true
    npx postject "$BINARY_PATH" NODE_SEA_BLOB oma-bin/sea-prep.blob \
        --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
        --macho-segment-name NODE_SEA
    codesign --sign - "$BINARY_PATH" 2>/dev/null || true
elif [ "$OS" = "Linux" ]; then
    npx postject "$BINARY_PATH" NODE_SEA_BLOB oma-bin/sea-prep.blob \
        --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
else
    # windows or other
    npx postject "$BINARY_PATH" NODE_SEA_BLOB oma-bin/sea-prep.blob \
        --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi

chmod +x "$BINARY_PATH"

# ---- create dist artifacts ----
mkdir -p dist/artifacts

cp "$BINARY_PATH" "dist/artifacts/${DIST_NAME}"
if command -v tar &>/dev/null; then
    (cd dist/artifacts && tar -czf "${DIST_NAME}.tar.gz" "${DIST_NAME}")
fi

# ---- verify ----
echo ""
echo "Verifying binary..."
if [ -f "$BINARY_PATH" ]; then
    SIZE=$(du -h "$BINARY_PATH" | cut -f1)
    echo "Binary: $BINARY_PATH ($SIZE)"
    "$BINARY_PATH" --help && echo "CLI: OK" || echo "CLI: WARNING - help check returned non-zero"
    echo ""
    echo "=== Build complete ==="
    echo "Binary at: $BINARY_PATH"
    echo "Artifact at: dist/artifacts/${DIST_NAME}"
    echo ""
    echo "To install system-wide:"
    echo "  cp $BINARY_PATH /usr/local/bin/oma"
else
    echo "ERROR: Binary not found at $BINARY_PATH"
    exit 1
fi
