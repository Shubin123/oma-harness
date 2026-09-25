#!/usr/bin/env bash
# ==============================================================================
# OMA - Start the Whole System (One command after building)
#
# Usage:
#   ./start.sh                    # Starts server & dashboard, opens browser
#   ./start.sh --port 9000        # Custom port (default: 8384)
#   ./start.sh --no-browser       # Headless mode
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Detect best python
if [ -x "/opt/homebrew/opt/python@3.11/bin/python3.11" ]; then
    PYTHON_CMD="/opt/homebrew/opt/python@3.11/bin/python3.11"
elif command -v python3.11 &>/dev/null; then
    PYTHON_CMD="python3.11"
else
    PYTHON_CMD="python3"
fi

exec "$PYTHON_CMD" "$DIR/start.py" "$@"
