#!/usr/bin/env bash
set -euo pipefail

PYTHON="${CLAUDE_CODEX_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
    then
      PYTHON="$candidate"
      break
    fi
  done
fi

if [ -z "$PYTHON" ]; then
  echo "No Python 3.10+ found. Set CLAUDE_CODEX_PYTHON." >&2
  exit 1
fi

"$PYTHON" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install claude-agent-sdk
echo "Installed claude-agent-sdk into .venv"
