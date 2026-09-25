#!/usr/bin/env bash
# OMA - Single command that builds and runs everything in the project.
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PYTHON="${PYTHON:-python3}"

# Detect brew python3.11 if available and default python3 is older
if [ -x "/opt/homebrew/opt/python@3.11/bin/python3.11" ]; then
    PYTHON="/opt/homebrew/opt/python@3.11/bin/python3.11"
fi

exec "$PYTHON" "$DIR/tools/run_all.py" "$@"
