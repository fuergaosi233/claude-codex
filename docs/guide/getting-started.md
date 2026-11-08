# Getting started

The Claude Codex Adapter lets the **Codex desktop app** talk to **Claude Code**
through the native Codex `app-server` protocol. Codex App still runs its normal
SSH version probe, bootstrap, and `app-server proxy` flow — but `codex
app-server` is handled by this adapter instead of the real Codex runtime.

## How it fits together

```
Codex App  ──SSH──▶  login shell  ──▶  codex (shim, earlier in PATH)
                                          │
                       app-server calls ──┘──▶  Claude Codex Adapter ──▶ Claude Code
                       everything else  ──────▶ real Codex CLI (CODEX_REAL)
```

The SSH shim intercepts every first-argument `codex app-server` call that
reaches it and forwards other commands to the real Codex CLI. On a workstation
shared with Orca or native Codex app-server clients, use the
[isolated launcher](/guide/deployment#alongside-orca-and-native-codex) and connect
only the chosen CLI with `--remote`.

## Prerequisites

- **Node.js 24+** — the thread store uses `node:sqlite`, which Node 22 hides
  behind `--experimental-sqlite`. The adapter does not pass that flag, so it
  crashes at runtime on 22. Pin a binary with `CLAUDE_CODEX_NODE` if needed.
- **Claude Code auth** — provide your own `ANTHROPIC_API_KEY`, supported
  cloud-provider credentials, or a local `claude /login` session. Inject
  credentials through your shell or secret manager; do not commit keys, OAuth
  state, `.env` files, or acceptance-test transcripts.

## Build

```bash
npm install
npm run build        # tsc -> dist/ (production artifact)
```

The only runtime dependency for Claude itself is
`@anthropic-ai/claude-agent-sdk`, loaded in-process (it ships its own
`claude-code` native binary per platform).

## Next steps

1. **[Deployment](/guide/deployment)** — launch alongside Orca/native Codex, or
   install the SSH shim on a dedicated remote host.
2. **[Using the Codex App](/guide/gui)** — connect the GUI and run a turn.
3. **[Configuration](/guide/configuration)** — models, effort, MCP, tools,
   worktrees.
4. **[Backends](/guide/backends)** — switch the active Claude Code route.

## Local protocol testing

Set `CLAUDE_CODEX_MOCK=1` to exercise the protocol without Claude credentials:

```bash
CLAUDE_CODEX_MOCK=1 node dist/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```

## CLI entry points

```bash
# Explicit coexistence entry point; no shim or global configuration changes.
node dist/src/isolated-launch.mjs --state-dir "$PWD/.claude-codex/local" --port 8790
# In another terminal in the same checkout, connect a native Codex CLI:
CLAUDE_CODEX_REMOTE_TOKEN="$(cat "$PWD/.claude-codex/local/adapter/ws-token")" \
  codex --remote ws://127.0.0.1:8790 --remote-auth-token-env CLAUDE_CODEX_REMOTE_TOKEN
```

When installed, the package exposes `claude-codex-isolated` for the launcher and
`claude-codex-adapter` for the existing app-server entry point. The isolated
launcher accepts `--state-dir PATH` (required), `--port PORT` (default `0`, a
free loopback port), and `--ws-auth`, `--ws-token-file`, `--ws-token-sha256`,
`--ws-allowed-origins`. `--help` lists the options. It uses capability-token auth
by default and stops its own adapter child when you press Ctrl-C. See
[Deployment](/guide/deployment#foreground-lifecycle) for state, conflicts and
crash recovery. The direct app-server entry point retains its existing modes:

```bash
node dist/src/adapter.mjs app-server --listen unix://
node dist/src/adapter.mjs app-server proxy
node dist/src/adapter.mjs app-server --listen stdio://
node dist/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```

A `ws://` listener on a non-loopback address (such as `0.0.0.0`) needs a
capability token (`--ws-auth capability-token`), or the explicit opt-out
`--ws-allow-unauthenticated`; without either the adapter refuses to start. See
[WebSocket listener](/guide/configuration#websocket-listener).

Two one-shot probes answer and exit without opening the state database, so
they never disturb a server already running on the same `CODEX_HOME`:

```bash
# One JSON line: {"appServerVersion": ..., "configRequirements": ...}
node dist/src/adapter.mjs app-server --print-startup-config
# The unix daemon on <CODEX_HOME>/app-server-control/app-server-control.sock,
# or exit 1 when none is running there
node dist/src/adapter.mjs app-server daemon version
```

`--startup-sign-out` and `--startup-client-info <json>` are accepted with
`--print-startup-config` and change nothing: Claude threads have no ChatGPT
account to sign out of. `scripts/codex-shim` answers `--print-startup-config`
(without a client info) and a `daemon version` with no socket to check by
itself, without starting node, and passes both to the real `codex` in native
Codex mode.
