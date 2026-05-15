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

The adapter requires **Node.js 24+** for stable `node:sqlite`. Node 22 ships
`node:sqlite` behind `--experimental-sqlite`, which the adapter does not pass,
so it crashes at runtime on 22 even though it imports cleanly on 24. Set
`CLAUDE_CODEX_NODE` in the shim environment to pin a specific node binary.
The Python sidecar needs Python 3.10+ for `claude-agent-sdk`; set
`CLAUDE_CODEX_PYTHON` if the remote host's `python3` is older.

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
export ANTHROPIC_API_KEY="..."                    # or sign in with `claude /login`
export CLAUDE_CODEX_ADAPTER="/opt/claude-codex-adapter/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="/absolute/path/to/node" # optional
export CLAUDE_CODEX_PYTHON="/absolute/path/to/python3.11" # optional
export CODEX_REAL="/usr/local/bin/codex.real"     # optional fallback

# Optional: route Anthropic API traffic through a reverse proxy. Useful when the
# remote host's egress IP is region-blocked from api.anthropic.com but you still
# want the same `claude` CLI auth (claude.ai OAuth or ANTHROPIC_API_KEY).
# export ANTHROPIC_BASE_URL="https://your-anthropic-reverse-proxy.example"
```

Codex App Remote should continue to use its native SSH flow. The app probes
`codex --version`, starts `codex app-server --listen unix://`, then connects via
`codex app-server proxy`. The shim routes only those app-server calls to this
adapter.

### Bootstrapping a fresh remote host (macOS / Linux)

A clean machine usually only needs four user-space tools. The pattern below
works without `sudo` or Homebrew and is what the project's macOS deployments
use:

```bash
# 1. Node 24 (stable node:sqlite). Pick your platform tarball from
#    https://nodejs.org/dist/v24.11.0/ and extract under ~/.local.
curl -fsSL https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.xz \
  | tar -xJ -C ~/.local

# 2. uv as a single-binary Python manager, then Python 3.11 itself.
curl -LsSf https://astral.sh/uv/install.sh | sh
~/.local/bin/uv python install 3.11

# 3. Claude Code CLI, installed under a user prefix so no sudo is needed.
mkdir -p ~/.local/npm-global
~/.local/node-v24.11.0-darwin-arm64/bin/npm config set prefix ~/.local/npm-global
~/.local/npm-global/bin/npm install -g @anthropic-ai/claude-code
~/.local/npm-global/bin/claude /login   # interactive: claude.ai OAuth

# 4. Adapter checkout, build, and Python sidecar SDK.
git clone <this repo> ~/claude-codex
cd ~/claude-codex
npm install
npm run build
CLAUDE_CODEX_PYTHON="$(uv python find 3.11)" npm run install:python-sdk

# Persist PATH + adapter pointers for non-interactive SSH:
cat >>~/.zshenv <<'EOF'
export PATH="$HOME/.local/npm-global/bin:$HOME/.local/node-v24.11.0-darwin-arm64/bin:$HOME/.local/bin:$PATH"
export CLAUDE_CODEX_PYTHON="$HOME/claude-codex/.venv/bin/python"
export CLAUDE_CODEX_ADAPTER="$HOME/claude-codex/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$HOME/.local/node-v24.11.0-darwin-arm64/bin/node"
# Uncomment if api.anthropic.com is blocked from this host:
# export ANTHROPIC_BASE_URL="https://your-anthropic-reverse-proxy.example"
EOF

cp scripts/codex-shim ~/.local/bin/codex && chmod +x ~/.local/bin/codex

npm run doctor   # 6 checks should all be ok
npm run smoke:real   # round-trips an actual Claude turn
```

After this, Codex App's Remote connection to the host hits `~/.local/bin/codex`
first and is routed into the adapter. Disconnecting reclaims the daemon so the
sidecar exits.

### Localhost GUI testing on macOS

For localhost GUI testing on macOS, the adapter can be launched by SSH while
Claude Code runs in the logged-in GUI session. Put these lightweight exports in
`~/.zshenv` so both login shells and non-interactive SSH remote commands can see
the shim:

```bash
REPO="$HOME/path/to/claude-codex" # adjust to your checkout
export PATH="$HOME/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$REPO/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$(command -v node)"
export CLAUDE_CODEX_PYTHON="$REPO/.venv/bin/python"
export CLAUDE_CODEX_CLI="$(command -v claude)"
export CLAUDE_CODEX_RUNTIME_SOCKET="$REPO/.claude-codex/runtime.sock"
export CODEX_REAL="$(command -v codex)"
```

Start the GUI-session Claude runtime daemon manually:

```bash
CLAUDE_CODEX_RUNTIME_SOCKET="$PWD/.claude-codex/runtime.sock" \
CLAUDE_CODEX_PYTHON="$PWD/.venv/bin/python" \
CLAUDE_CODEX_CLI="$(command -v claude)" \
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

The daemon owns the Unix socket while a Codex client is connected. When the
last client (`app-server proxy`) disconnects, the daemon shuts down after a
short idle grace period so its Claude runtime sidecar is reclaimed instead of
leaking. Codex App re-probes and restarts the daemon on the next remote
connection. Tune or disable this with `CLAUDE_CODEX_IDLE_EXIT_MS` (default
`15000`; set `0` to keep the daemon running indefinitely).

## Using Codex App GUI

1. Install the shim and exports on the remote host as described above
   (`~/bin/codex`, `~/.zshenv` for the localhost-GUI flow), and build the
   adapter (`npm install && npm run build && npm run install:python-sdk`).
2. For the localhost-GUI flow, start the runtime daemon — either manually or as
   the LaunchAgent shown below — so Codex App GUI can reach Claude Code without
   a terminal process.
3. Open Codex App and add a Remote connection to the host (or `localhost`).
   Codex App runs its native SSH version probe and bootstrap; the shim routes
   `codex app-server` to this adapter.
4. Start a new thread and send a prompt. Claude Code runs the turn: agent text
   streams into the conversation, `Bash` calls surface as Codex command
   approvals, and `Edit`/`Write`/`MultiEdit` surface as Codex file-change
   approvals with a live diff. Approve them in the Codex App UI as usual.
5. Disconnecting the remote in Codex App closes the proxy; the adapter daemon
   idles out and the runtime sidecar is reclaimed automatically.

`npm run acceptance:gui-ssh-localhost` drives this exact path end-to-end
(real `codex app-server` daemon + `proxy` over SSH, real Claude Code turn,
approval bridge, and diff events) and is the closest automated check to the
Codex App GUI Remote experience.

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
