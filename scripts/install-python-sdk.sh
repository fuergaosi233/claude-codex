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

# Prefer the configured pip index (corporate mirrors, internal caches), but fall
# back to public PyPI if it cannot serve claude-agent-sdk — without this, an
# unreachable or restricted internal mirror silently leaves the venv empty.
if ! .venv/bin/python -m pip install claude-agent-sdk; then
  echo "default pip index could not provide claude-agent-sdk; retrying via https://pypi.org" >&2
  .venv/bin/python -m pip install --index-url https://pypi.org/simple/ claude-agent-sdk
fi

# Hard-fail the script if the SDK is still not importable, so callers like
# `npm run install:python-sdk` cannot pass while leaving the venv broken.
.venv/bin/python -c "import claude_agent_sdk; print('Installed claude-agent-sdk', claude_agent_sdk.__version__, 'into .venv')"
