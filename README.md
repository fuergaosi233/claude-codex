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
npm run build
```

The adapter requires **Node.js 24+** for stable `node:sqlite`. Node 22 ships
`node:sqlite` behind `--experimental-sqlite`, which the adapter does not pass,
so it crashes at runtime on 22 even though it imports cleanly on 24. Set
`CLAUDE_CODEX_NODE` in the shim environment to pin a specific node binary.
`@anthropic-ai/claude-agent-sdk` is the only runtime dependency for Claude
itself — the prior Python sidecar (`python/claude_sidecar.py`) is gone; the
TS SDK is loaded in-process and ships its own `claude-code` native binary via
npm `optionalDependencies` for the host platform.

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

# 2. Claude Code CLI, installed under a user prefix so no sudo is needed.
mkdir -p ~/.local/npm-global
~/.local/node-v24.11.0-darwin-arm64/bin/npm config set prefix ~/.local/npm-global
~/.local/npm-global/bin/npm install -g @anthropic-ai/claude-code
~/.local/npm-global/bin/claude /login   # interactive: claude.ai OAuth

# 3. Adapter checkout + build (also installs @anthropic-ai/claude-agent-sdk).
git clone <this repo> ~/claude-codex
cd ~/claude-codex
npm install
npm run build

# Persist PATH + adapter pointers for non-interactive SSH:
cat >>~/.zshenv <<'EOF'
export PATH="$HOME/.local/npm-global/bin:$HOME/.local/node-v24.11.0-darwin-arm64/bin:$HOME/.local/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$HOME/claude-codex/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$HOME/.local/node-v24.11.0-darwin-arm64/bin/node"
# Uncomment if api.anthropic.com is blocked from this host:
# export ANTHROPIC_BASE_URL="https://your-anthropic-reverse-proxy.example"
EOF

cp scripts/codex-shim ~/.local/bin/codex && chmod +x ~/.local/bin/codex

npm run doctor   # 4 checks should all be ok
npm run smoke:real   # round-trips an actual Claude turn
```

After this, Codex App's Remote connection to the host hits `~/.local/bin/codex`
first and is routed into the adapter. Disconnecting reclaims the daemon so the
adapter exits.

### Localhost GUI testing on macOS

For localhost GUI testing on macOS, the adapter can be launched by SSH and
the in-process TS runtime invokes the Claude Code CLI directly — no external
daemon to manage. Put these lightweight exports in `~/.zshenv` so both login
shells and non-interactive SSH remote commands can see the shim:

```bash
REPO="$HOME/path/to/claude-codex" # adjust to your checkout
export PATH="$HOME/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$REPO/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$(command -v node)"
export CLAUDE_CODEX_CLI="$(command -v claude)"
export CODEX_REAL="$(command -v codex)"
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
short idle grace period so its in-process Claude SDK runtime is reclaimed instead of
leaking. If a turn is still active, idle shutdown is deferred until that turn
completes; reconnecting/resuming the thread during that window reattaches
notifications to the new client peer. Codex App re-probes and restarts the
daemon on the next remote connection. Tune or disable this with
`CLAUDE_CODEX_IDLE_EXIT_MS` (default `15000`; set `0` to keep the daemon
running indefinitely).

## Using Codex App GUI

1. Install the shim and exports on the remote host as described above
   (`~/bin/codex`, `~/.zshenv` for the localhost-GUI flow), and build the
   adapter (`npm install && npm run build`).
2. Open Codex App and add a Remote connection to the host (or `localhost`).
   Codex App runs its native SSH version probe and bootstrap; the shim routes
   `codex app-server` to this adapter.
3. Start a new thread and send a prompt. Claude Code runs the turn: agent text
   streams into the conversation, `Bash` calls surface as Codex command
   approvals, and `Edit`/`Write`/`MultiEdit` surface as Codex file-change
   approvals with a live diff. Approve them in the Codex App UI as usual.
4. Disconnecting the remote in Codex App closes the proxy; once no turn is
   active, the adapter daemon idles out and the in-process Claude SDK runtime is reclaimed
   automatically.

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
# Runtime backend selection. The default uses the in-process Claude Agent SDK
# runtime and preserves the existing Claude Code behavior.
export CLAUDE_CODEX_RUNTIME_TYPE="agent-sdk-sidecar"

# Also supported:
#   codex             - pass app-server through to the real Codex CLI
#   agent-http        - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi          - HTTP/SSE bridge for coder/agentapi
#   claude-p          - one-shot PTY/transcript wrapper via claude-p
#   mock              - local protocol testing

# Defaults surfaced through config/read and used for new threads.
export CLAUDE_CODEX_DEFAULT_MODEL="sonnet"
export CLAUDE_CODEX_DEFAULT_EFFORT="medium"

# Optional Codex App model selector list. Accepts comma-separated ids or a JSON
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

### Alternative Claude Code backends

The adapter's internal Codex protocol layer talks to a small `ClaudeRuntime`
interface, so non-SDK Claude Code bridges can be selected without removing the
existing Agent SDK route.

Codex App's model menu remains a model selector only. Pick `Claude Sonnet`,
`Claude Opus`, `Claude Haiku`, etc. there; the active Claude Code connection
route is selected outside the App with the remote shim mode.

If you install `scripts/codex-shim` earlier in `PATH`, it acts as a router. Set
`CODEX_REAL` to the real Codex CLI path and put per-host routing in
`~/.claude-codex/runtime.env`:

```bash
# Keep native Codex behavior for Codex App Remote.
export CLAUDE_CODEX_RUNTIME_TYPE="codex"
export CODEX_REAL="/absolute/path/to/real/codex"
```

Non-`app-server` commands are always forwarded to the real Codex CLI when one is
available, so the shim can coexist with normal command-line Codex usage.

Native Codex passthrough is different from the four Claude backends: in
`CLAUDE_CODEX_RUNTIME_TYPE=codex` the shim launches the real Codex app-server,
so the adapter is not in the process and cannot dynamically switch back from any
in-App control. Switch that mode with the host helper (for example
`claude-codex-mode set codex` or `claude-codex-mode set agent-sdk-sidecar`) and
reconnect the Remote session.

Install the helper next to the shim:

```bash
install -m 0755 scripts/claude-codex-mode ~/.local/bin/claude-codex-mode
```

It rewrites `~/.claude-codex/runtime.env`, prepares the matching bridge daemon
for `agent-http` or `agentapi`, stops the current app-server so Codex App will
reconnect into the new route, and provides readback commands:

```bash
claude-codex-mode list         # all selectable modes; current one is marked *
claude-codex-mode set agent-http
claude-codex-mode set agent-http opus  # switch route and restart bridge with Opus
claude-codex-mode set agent-http opus /repo/app  # optional explicit bridge cwd
claude-codex-mode model opus           # keep current route; update default/bridge model
claude-codex-mode ensure-bridge agent-http opus /repo/app # bridge only; no adapter restart
claude-codex-mode trust                # accept Claude Code trust prompt for agentapi
claude-codex-mode help         # also -h / --help
claude-codex-mode status       # current mode, bridge health, last runtime logs
claude-codex-mode read         # alias for status
claude-codex-mode last-turn    # last runtime.turn.select JSON line
claude-codex-mode last-user-turn # last user-visible turn; skips title/summary turns
claude-codex-mode logs adapter
claude-codex-mode logs agent-http
claude-codex-mode logs agentapi
```

Model switching is exact per turn for the SDK runtime and `claude-p`, because
the adapter can pass `model` to those backends. For `agent-http` and `agentapi`,
the HTTP bridge talks to a long-lived interactive Claude Code session; the safe
way to change the model is to restart that bridge with `claude --model <alias>`
via `claude-codex-mode model <alias>` or `claude-codex-mode set <mode> <alias>`.
The adapter also prepares managed HTTP bridges per turn with the thread cwd, so
the long-lived Claude Code process is relaunched in the current Codex App
workspace when needed. `claude-codex-mode read` shows the configured bridge cwd
and every running pooled bridge's cwd/model/port.
When using `agentapi`, the helper also detects Claude Code's workspace trust
prompt and tells you to run `claude-codex-mode trust` after reviewing the path.

#### agent-http / Channels

Set the mode through the helper. It loads the Channels bridge implementation
from `$CLAUDE_CODEX_AGENT_HTTP_DIR` or `~/agent-http`, but launches Claude Code
from the Codex App thread cwd. The helper writes an absolute MCP config under
the matching bridge pool directory, so the channel server can be loaded even
when Claude Code's process cwd is your project rather than the bridge checkout:

```bash
claude-codex-mode set agent-http opus
```

The backend uses `POST /message`, `GET /messages`, `GET /status`, and
`GET /events` when available. It streams message-level deltas into Codex; it
does not expose Agent SDK-level tool-use, thinking, or permission events.

#### agentapi

Set the mode through the helper. It starts `agentapi server --type=claude` from
the Codex App thread cwd and points the adapter at its HTTP API:

```bash
claude-codex-mode set agentapi opus
```

This is useful for quickly reusing an existing terminal-backed Claude Code
session. The adapter consumes agentapi's HTTP/SSE message stream and maps final
agent text into Codex messages. Rich Codex approval/file-change events are not
available because agentapi exposes terminal-derived text, not semantic tool
events.

#### claude-p

Install `claude-p` somewhere on the remote host and select the one-shot
transcript backend:

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="claude-p"
export CLAUDE_CODEX_CLAUDE_P_COMMAND="claude-p"
# For npx-style launch:
# export CLAUDE_CODEX_CLAUDE_P_COMMAND="npx"
# export CLAUDE_CODEX_CLAUDE_P_ARGS='["claude-p"]'
# Keep claude-p one-shot by default. Set to 1 only after verifying your
# claude-p build handles --resume + --input-file correctly.
# export CLAUDE_CODEX_CLAUDE_P_RESUME=0
```

This backend runs `claude-p --output-format json --input-file ...` for each
turn, emits the final assistant text, and stores `claude-p:<session_id>` for
diagnostics when the wrapper reports one. It is not a true streaming backend,
does not support `turn/steer`, and defaults to one-shot turns instead of resume
because current `claude-p` builds can replay the previous result when combining
`--resume` with `--input-file`.

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
