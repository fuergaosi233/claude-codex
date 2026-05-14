# Claude Codex Adapter

Remote-mode adapter that lets the Codex desktop app talk to Claude Code through
the native Codex `app-server` protocol.

The intended deployment is a remote SSH host with a `codex` shim earlier in the
login-shell `PATH`. Codex App still performs its normal SSH version probe,
bootstrap, and `app-server proxy` flow, but `codex app-server` is handled by this
adapter instead of the real Codex runtime.

## Build

```bash
npm install
npm run install:python-sdk
npm run build
python3 -m pip install claude-agent-sdk
```

The adapter expects Node.js with `node:sqlite` support. Use Node 22.5+ on the
remote host, or set `CLAUDE_CODEX_NODE` in the shim environment. The Python
sidecar needs Python 3.10+ for `claude-agent-sdk`; set `CLAUDE_CODEX_PYTHON` if
the remote host's `python3` is older.

## Remote shim

Install `scripts/codex-shim` as `~/bin/codex` on the remote host and make it
executable:

```bash
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex
chmod +x ~/bin/codex
```

Then ensure the remote login shell exports:

```bash
export PATH="$HOME/bin:$PATH"
export ANTHROPIC_API_KEY="..."
export CLAUDE_CODEX_ADAPTER="/opt/claude-codex-adapter/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="/absolute/path/to/node" # optional
export CLAUDE_CODEX_PYTHON="/absolute/path/to/python3.11" # optional
export CODEX_REAL="/usr/local/bin/codex.real"     # optional fallback
```

Codex App Remote should continue to use its native SSH flow. The app probes
`codex --version`, starts `codex app-server --listen unix://`, then connects via
`codex app-server proxy`. The shim routes only those app-server calls to this
adapter.

For localhost GUI testing on macOS, the adapter can be launched by SSH while
Claude Code runs in the logged-in GUI session. Put these lightweight exports in
`~/.zshenv` so both login shells and non-interactive SSH remote commands can see
the shim:

```bash
export PATH="$HOME/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="/Users/Holegots/Project/github/claude-codex/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="/Users/Holegots/.nvm/versions/node/v22.20.0/bin/node"
export CLAUDE_CODEX_PYTHON="/Users/Holegots/Project/github/claude-codex/.venv/bin/python"
export CLAUDE_CODEX_CLI="/Users/Holegots/.nvm/versions/node/v22.20.0/bin/claude"
export CLAUDE_CODEX_RUNTIME_SOCKET="/Users/Holegots/Project/github/claude-codex/.claude-codex/runtime.sock"
export CODEX_REAL="/opt/homebrew/bin/codex"
```

Start the GUI-session Claude runtime daemon manually:

```bash
CLAUDE_CODEX_RUNTIME_SOCKET="$PWD/.claude-codex/runtime.sock" \
CLAUDE_CODEX_PYTHON="$PWD/.venv/bin/python" \
CLAUDE_CODEX_CLI="/Users/Holegots/.nvm/versions/node/v22.20.0/bin/claude" \
node scripts/claude-runtime-daemon.mjs --socket "$PWD/.claude-codex/runtime.sock"
```

Or install it as a user LaunchAgent so Codex App GUI remote can use it without a
terminal process:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.claude-codex.runtime-daemon.plist
launchctl kickstart -k "gui/$(id -u)/com.claude-codex.runtime-daemon"
```

Quick remote probe:

```bash
ssh host 'command -v codex'
ssh host 'codex --version'
ssh host '
  set -e
  tmp=$(mktemp -d)
  export CODEX_HOME="$tmp" CLAUDE_CODEX_MOCK=1
  codex app-server --listen unix:// >"$tmp/daemon.out" 2>"$tmp/daemon.err" &
  pid=$!
  for i in 1 2 3 4 5; do test -S "$tmp/app-server-control/app-server-control.sock" && break; sleep 0.2; done
  test -S "$tmp/app-server-control/app-server-control.sock"
  kill "$pid" 2>/dev/null || true
'
```

The daemon normally keeps running after it owns the Unix socket. In Codex App
this process is managed by the native remote connection flow; the probe kills
its temporary daemon after verifying the socket exists.

## Modes

```bash
node dist/src/adapter.mjs app-server --listen unix://
node dist/src/adapter.mjs app-server proxy
node dist/src/adapter.mjs app-server --listen stdio://
node dist/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```

Set `CLAUDE_CODEX_MOCK=1` for local protocol testing without Claude credentials.

## Claude runtime knobs

```bash
# Defaults surfaced through config/read and used for new threads.
export CLAUDE_CODEX_DEFAULT_MODEL="sonnet"
export CLAUDE_CODEX_DEFAULT_EFFORT="medium"

# Optional Codex++ model selector list. Accepts comma-separated ids or a JSON
# array of ids/objects: [{"id":"sonnet","displayName":"Claude Sonnet"}].
export CLAUDE_CODEX_MODELS="sonnet,opus,haiku,sonnet-1m,opus-plan"

# Map Codex++ UI ids to Claude Code SDK model aliases/full model names.
export CLAUDE_CODEX_MODEL_ALIASES='{"my-sonnet":"sonnet","my-long-context":"sonnet[1m]"}'

# Map Codex-safe effort values to Claude SDK effort values. For example, keep
# the wire protocol at xhigh while asking Claude Code for its max effort.
export CLAUDE_CODEX_EFFORT_ALIASES='{"xhigh":"max"}'

# JSON object or path to a JSON file. Passed to ClaudeAgentOptions.mcp_servers.
export CLAUDE_CODEX_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Pre-approved tools. Other tools still route through Codex approval.
export CLAUDE_CODEX_ALLOWED_TOOLS="Read,Glob,Grep"

# Extra directories exposed to Claude Agent SDK.
export CLAUDE_CODEX_ADD_DIRS="/repo/shared,/repo/docs"

# Ask Claude Agent SDK to enable file checkpointing.
export CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING=1

# Optional per-thread git worktree isolation.
export CLAUDE_CODEX_AUTO_WORKTREE=1
export CLAUDE_CODEX_WORKTREE_ROOT="$HOME/.claude-codex/worktrees"
```

`CLAUDE_CODEX_AUTO_WORKTREE` is off by default because it creates branches and
worktrees in the target repository. When enabled, new Codex threads run in a
dedicated `git worktree`.

## Protocol coverage

Implemented as real remote/runtime behavior:

- Codex app-server v2 transports: stdio, WebSocket, Unix socket daemon, and
  `app-server proxy` raw stdio forwarding.
- Core thread lifecycle: start, resume, fork, list, read, turns list, name,
  archive/unarchive, unsubscribe, interrupt.
- Claude Code runtime: `ClaudeSDKClient.query`, session resume, fork session,
  partial text streaming, interrupt, MCP server config, allowed tools, add dirs,
  and file checkpointing flags.
- Approval bridge: Claude `Bash` maps to Codex command approval, and
  `Edit`/`Write`/`MultiEdit` map to Codex file-change approval.
- Stream bridge: turn started/completed, thread status changes, agent text
  deltas, reasoning deltas, command output deltas, file patches, generic tool
  item completion, and aggregated git diff updates.
- Remote utilities: file read/write/list/metadata/copy/remove/watch, command
  exec with stdin/terminate, process spawn/stdin/kill, fuzzy file search, direct
  MCP stdio/HTTP tool and resource calls.
- Optional per-thread git worktree isolation.

Compatibility-only app UI methods return stable empty or inert responses when
they are OpenAI-account/plugin-marketplace/realtime-specific rather than Claude
Code runtime capabilities. Examples: marketplace install/update, OpenAI account
login/logout, realtime audio, and Windows sandbox setup. Claude VS Code is used
as an interaction reference only; this adapter does not call its private RPC.

## Validation

```bash
npm test
npm run doctor
npm run probe:codex-cli-remote # probes current local codex --remote behavior
npm run smoke:real # requires ANTHROPIC_API_KEY, Bedrock, or Vertex auth
npm run acceptance:local-remote # full local Remote shim/daemon/proxy + real Claude file edit
npm run acceptance:gui-ssh-localhost # SSH localhost -> login shell -> shim -> GUI-session Claude runtime
./scripts/codex-shim --version
CLAUDE_CODEX_ADAPTER="$PWD/dist/src/adapter.mjs" ./scripts/codex-shim app-server --help
python3 -m py_compile python/claude_sidecar.py
```

`acceptance:local-remote` creates an ignored `.claude-codex/local-remote-acceptance-*`
directory, installs the shim into a temporary PATH, starts the Unix socket
daemon, connects through `app-server proxy`, auto-approves Claude Code file
edits, and verifies that Claude creates a file in the temporary workspace.

`probe:codex-cli-remote` starts the adapter in mock WebSocket mode and then
tries the currently installed `codex --remote ws://...` CLI. It keeps a
transcript under `.claude-codex/codex-cli-remote-probe-*` by default. In a
desktop flow the app supplies its own interactive/auth context; the CLI probe
reports `blocked-login`, `blocked-timeout`, or `blocked-no-tty` when the local
CLI cannot complete an automated remote prompt because it stops at those local
gates first.

`acceptance:gui-ssh-localhost` is the closest automated check to Codex App GUI
Remote on the current Mac: it starts `codex app-server --listen unix://` and
`codex app-server proxy` through `ssh localhost 'zsh -lc ...'`, then verifies
Claude Code can edit a git workspace through Codex approval and diff events.
