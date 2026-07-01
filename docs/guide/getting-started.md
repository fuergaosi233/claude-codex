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

The shim is the only integration point: it intercepts `codex app-server` and
forwards everything else to the real Codex CLI, so it coexists with normal
command-line Codex usage.

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

1. **[Deployment](/guide/deployment)** — install the shim on the remote host and
   bootstrap a fresh machine without sudo.
2. **[Using the Codex App](/guide/gui)** — connect the GUI and run a turn.
3. **[Configuration](/guide/configuration)** — models, effort, MCP, tools,
   worktrees.
4. **[Backends](/guide/backends)** — switch the active Claude Code route.

## Local protocol testing

Set `CLAUDE_CODEX_MOCK=1` to exercise the protocol without Claude credentials:

```bash
CLAUDE_CODEX_MOCK=1 node dist/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```

## Transports / modes

```bash
node dist/src/adapter.mjs app-server --listen unix://
node dist/src/adapter.mjs app-server proxy
node dist/src/adapter.mjs app-server --listen stdio://
node dist/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```
