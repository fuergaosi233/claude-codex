# Claude Codex Adapter

Remote-mode adapter that lets the Codex desktop app talk to Claude Code through
the native Codex `app-server` protocol.

The deployment target is a remote SSH host with a `codex` shim earlier in the
login-shell `PATH`. Codex App still runs its normal SSH version probe, bootstrap,
and `app-server proxy` flow, but `codex app-server` is handled by this adapter
instead of the real Codex runtime.

## Build

```bash
npm install
npm run build       # tsc -> dist/ (production artifact)
npm run dev         # tsx src/adapter.mts — run sources directly, no build step
npm run check       # biome format + lint
npm test            # build + run the test suite
```

**Requires Node.js 24+** for stable `node:sqlite`. Node 22 hides it behind
`--experimental-sqlite` (not passed), so the adapter crashes at runtime on 22.
Set `CLAUDE_CODEX_NODE` to pin a specific node binary. The only runtime
dependency for Claude itself is `@anthropic-ai/claude-agent-sdk`, loaded
in-process (it ships its own `claude-code` native binary per platform).

The toolchain is TypeScript ESM compiled with `tsc`, formatted/linted with
[Biome](https://biomejs.dev), and runnable directly via [tsx](https://tsx.is)
for development. Sources are kept erasable, so `node src/adapter.mts` works on
Node 24 without a build. Production deploys still ship compiled `.mjs`, so a
remote host needs only `node` — no TS toolchain.

## Install the shim

Install `scripts/codex-shim` as `codex` earlier in `PATH` on the remote host:

```bash
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex && chmod +x ~/bin/codex
```

Then have the login shell export the adapter pointers (put these in `~/.zshenv`
so non-interactive SSH sees them too):

```bash
export PATH="$HOME/bin:$PATH"
export ANTHROPIC_API_KEY="..."                    # or sign in with `claude /login`
export CLAUDE_CODEX_ADAPTER="/opt/claude-codex-adapter/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="/absolute/path/to/node" # optional
export CODEX_REAL="/usr/local/bin/codex.real"     # optional native-Codex fallback
# export ANTHROPIC_BASE_URL="https://your-anthropic-reverse-proxy.example"  # if api.anthropic.com is region-blocked
```

Codex App keeps using its native SSH flow: it probes `codex --version`, starts
`codex app-server --listen unix://`, then connects via `codex app-server proxy`.
The shim routes only those app-server calls to the adapter; everything else is
forwarded to the real Codex CLI when one is available.

### Bootstrapping a fresh host (no sudo / Homebrew)

```bash
# 1. Node 24 (stable node:sqlite) — pick your platform tarball from nodejs.org/dist.
curl -fsSL https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.xz | tar -xJ -C ~/.local

# 2. Claude Code CLI under a user prefix.
mkdir -p ~/.local/npm-global
~/.local/node-v24.11.0-darwin-arm64/bin/npm config set prefix ~/.local/npm-global
~/.local/npm-global/bin/npm install -g @anthropic-ai/claude-code
~/.local/npm-global/bin/claude /login        # interactive: claude.ai OAuth

# 3. Adapter checkout + build.
git clone <this repo> ~/claude-codex && cd ~/claude-codex
npm install && npm run build

# 4. Persist PATH + adapter pointers for non-interactive SSH.
cat >>~/.zshenv <<'EOF'
export PATH="$HOME/.local/npm-global/bin:$HOME/.local/node-v24.11.0-darwin-arm64/bin:$HOME/.local/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$HOME/claude-codex/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$HOME/.local/node-v24.11.0-darwin-arm64/bin/node"
EOF
cp scripts/codex-shim ~/.local/bin/codex && chmod +x ~/.local/bin/codex

npm run doctor       # all checks should be ok
npm run smoke:real   # round-trips a real Claude turn
```

Codex App's Remote connection then hits the shim first and is routed into the
adapter. Disconnecting reclaims the daemon so the adapter exits.

## Using the Codex App GUI

1. Install the shim and exports above, and build the adapter.
2. In Codex App, add a Remote connection to the host (or `localhost`). The app
   runs its native SSH probe/bootstrap; the shim routes `codex app-server` here.
3. Start a thread and send a prompt. Claude Code runs the turn: agent text
   streams in, `Bash` calls surface as Codex command approvals, and
   `Edit`/`Write`/`MultiEdit` surface as file-change approvals with a live diff.
4. Disconnecting closes the proxy; once no turn is active, the daemon idles out
   and the in-process Claude runtime is reclaimed.

The daemon owns the Unix socket while a client is connected. When the last
client disconnects it shuts down after an idle grace period (deferred if a turn
is still active; reconnecting during that window reattaches notifications). Tune
with `CLAUDE_CODEX_IDLE_EXIT_MS` (default `15000`; `0` keeps it running).

`npm run acceptance:gui-ssh-localhost` drives this exact path end-to-end (real
daemon + proxy over SSH, real Claude turn, approval bridge, diff events) and is
the closest automated check to the GUI Remote experience.

## Modes

```bash
node dist/src/adapter.mjs app-server --listen unix://
node dist/src/adapter.mjs app-server proxy
node dist/src/adapter.mjs app-server --listen stdio://
node dist/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```

Set `CLAUDE_CODEX_MOCK=1` for local protocol testing without Claude credentials.

## Configuration

All config is environment-driven.

```bash
# Runtime backend. Default uses the in-process Claude Agent SDK.
export CLAUDE_CODEX_RUNTIME_TYPE="agent-sdk-sidecar"
#   codex      - pass app-server through to the real Codex CLI (shim layer)
#   agent-http - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi   - HTTP/SSE bridge for coder/agentapi
#   claude-p   - one-shot PTY/transcript wrapper via claude-p
#   mock       - local protocol testing

# Defaults for new threads, surfaced through config/read.
export CLAUDE_CODEX_DEFAULT_MODEL="sonnet"
export CLAUDE_CODEX_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CLAUDE_CODEX_MODELS="sonnet,opus,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CLAUDE_CODEX_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CLAUDE_CODEX_EFFORT_ALIASES='{"xhigh":"max"}'

# Passed to ClaudeAgentOptions (JSON object or path to a JSON file).
export CLAUDE_CODEX_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Pre-approved tools (others still route through Codex approval) + extra dirs.
export CLAUDE_CODEX_ALLOWED_TOOLS="Read,Glob,Grep"
export CLAUDE_CODEX_ADD_DIRS="/repo/shared,/repo/docs"
export CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING=1

# Per-thread git worktree isolation (off by default — it creates branches).
export CLAUDE_CODEX_AUTO_WORKTREE=1
export CLAUDE_CODEX_WORKTREE_ROOT="$HOME/.claude-codex/worktrees"
```

Codex App's model menu stays a model selector only (`Claude Sonnet`, `Claude
Opus`, …). The active Claude Code *route* is selected outside the App with the
shim mode below.

## Switching backends

The adapter talks to a small `ClaudeRuntime` interface, so non-SDK bridges can
be selected without removing the default Agent SDK route. Install the host
helper next to the shim:

```bash
install -m 0755 scripts/claude-codex-mode ~/.local/bin/claude-codex-mode
```

It rewrites `~/.claude-codex/runtime.env`, prepares the matching bridge daemon
(`agent-http`/`agentapi`), stops the current app-server so Codex App reconnects
into the new route, and provides readback commands:

```bash
claude-codex-mode list                 # selectable modes; current marked *
claude-codex-mode set agent-http opus  # switch route, restart bridge with Opus
claude-codex-mode model opus           # keep route; update default/bridge model
claude-codex-mode status               # mode, bridge health, recent logs
claude-codex-mode logs adapter|agent-http|agentapi
```

Model switching is exact per turn for the SDK runtime and `claude-p` (the
adapter passes `model` directly). For `agent-http`/`agentapi` the bridge talks
to a long-lived Claude Code session, so changing model means restarting that
bridge (`claude-codex-mode model <alias>`).

Native `codex` passthrough is different from the four Claude backends: in that
mode the shim launches the real Codex app-server, so the adapter is not in the
process and cannot switch back from in-App controls — use `claude-codex-mode set
codex` / `set agent-sdk-sidecar` on the host and reconnect.

Backend specifics:

- **agent-http / Channels** — loads the bridge from
  `$CLAUDE_CODEX_AGENT_HTTP_DIR` (or `~/agent-http`) but launches Claude Code
  from the thread cwd. Uses `POST /message`, `GET /messages|/status|/events`;
  streams message-level deltas only (no semantic tool/thinking/permission
  events).
- **agentapi** — runs `agentapi server --type=claude` from the thread cwd and
  maps final agent text into Codex messages. No rich approval/file-change events
  (terminal-derived text only). Run `claude-codex-mode trust` if Claude's
  workspace-trust prompt appears.
- **claude-p** — runs `claude-p --output-format json --input-file ...` per turn
  and emits the final assistant text. Not streaming, no `turn/steer`; defaults
  to one-shot turns (some `claude-p` builds replay results when combining
  `--resume` with `--input-file`).

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="claude-p"
export CLAUDE_CODEX_CLAUDE_P_COMMAND="claude-p"
# export CLAUDE_CODEX_CLAUDE_P_RESUME=1   # only after verifying --resume + --input-file
```

## Protocol coverage

Implemented as real remote/runtime behavior:

- **Transports** — stdio, WebSocket, Unix-socket daemon, `app-server proxy`.
- **Thread lifecycle** — start, resume, fork, list, read, turns list, name,
  archive/unarchive, unsubscribe, interrupt.
- **Claude runtime** — query, session resume/fork, partial text streaming,
  interrupt, MCP config, allowed tools, add dirs, file checkpointing.
- **Approval bridge** — `Bash` → command approval; `Edit`/`Write`/`MultiEdit` →
  file-change approval with diffs.
- **Streaming** — turn start/complete, status changes, agent/reasoning/command
  deltas, file patches, tool item completion, aggregated git diff.
- **Remote utilities** — file read/write/list/metadata/copy/remove/watch,
  command exec with stdin/terminate, process spawn/stdin/kill, fuzzy file
  search, direct MCP stdio/HTTP tool & resource calls.
- **Per-thread git worktree isolation** (optional).

Compatibility-only UI methods (marketplace, OpenAI account login, realtime
audio, Windows sandbox) return stable empty/inert responses since they are not
Claude Code capabilities. See `docs/codex-app-remote-capability-matrix.md` for
the full matrix.

## Validation

```bash
npm test                              # build + unit tests
npm run doctor                        # environment checks
npm run smoke:real                    # real Claude turn (needs Anthropic/Bedrock/Vertex auth)
npm run acceptance:local-remote       # local shim/daemon/proxy + real Claude file edit
npm run acceptance:gui-ssh-localhost  # SSH localhost -> login shell -> shim -> GUI-session runtime
npm run probe:codex-cli-remote        # probes the local codex --remote CLI behavior
```

`acceptance:local-remote` and `acceptance:gui-ssh-localhost` write transcripts
under the git-ignored `.claude-codex/` directory.
