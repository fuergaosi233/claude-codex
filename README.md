# Claude Codex Adapter

[![CI](https://github.com/fuergaosi233/claude-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/fuergaosi233/claude-codex/actions/workflows/ci.yml)
[![Docs](https://github.com/fuergaosi233/claude-codex/actions/workflows/deploy-docs.yml/badge.svg)](https://fuergaosi233.github.io/claude-codex/)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

Production TypeScript adapter that lets the **Codex desktop app** talk to
**Claude Code** through the native Codex `app-server` protocol in Remote mode.

Codex App still runs its normal SSH version probe, bootstrap, and `app-server
proxy` flow — but `codex app-server` is handled by this adapter instead of the
real Codex runtime, so agent turns run on Claude Code.

📖 **Documentation: <https://fuergaosi233.github.io/claude-codex/>**

## Quick start

```bash
npm install
npm run build        # tsc -> dist/ (production artifact)
npm run dev          # tsx src/adapter.mts — run sources directly, no build
npm run doctor       # environment self-check
```

> **Requires Node.js 24+** for stable `node:sqlite`. Set `CLAUDE_CODEX_NODE` to
> pin a node binary if your default is older.

Then install the `codex` shim on the remote host and add a Remote connection in
the Codex App:

```bash
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex && chmod +x ~/bin/codex
export PATH="$HOME/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$PWD/dist/src/adapter.mjs"
export ANTHROPIC_API_KEY="<your-anthropic-api-key>" # or authenticate with `claude /login`
```

Provide credentials only through your local shell or secret manager. Do not
commit API keys, OAuth/session data, `.env` files, or acceptance-test logs.

Full walkthrough → **[Getting started](https://fuergaosi233.github.io/claude-codex/guide/getting-started)**.

## How it works

```
Codex App ──SSH──▶ login shell ──▶ codex (shim, earlier in PATH)
                                     │
                  app-server calls ──┘──▶ Claude Codex Adapter ──▶ Claude Code
                  everything else  ──────▶ real Codex CLI (CODEX_REAL)
```

Agent text and reasoning stream into the conversation; `Bash` becomes command
approvals; `Edit`/`Write`/`MultiEdit` become file-change approvals with live
diffs. Runtime selection maps only to existing backend paths today: default
in-process Claude Agent SDK, `agent-http`, `agentapi`, `claude-p`, `codex-proxy`,
and `mock`.

### Diagrams and rich Markdown

The native Claude Agent SDK backend is told that replies appear in Codex desktop,
with Markdown and Mermaid rendering. For explanations that benefit from a diagram,
Claude is encouraged to use a fenced `mermaid` flowchart or sequence diagram, while
keeping simple answers brief and respecting requested formats. No global
`~/.claude/CLAUDE.md` changes are needed; schema-constrained turns do not receive
this presentation guidance.

Rendering is provided by the Codex app version you use. The adapter preserves the
Markdown in streaming and history; it does not bundle a diagram renderer or a
Claude Desktop Artifacts runtime. Arbitrary HTML/React code fences do not become
interactive apps. Older clients may show Mermaid source instead of a diagram.

### `/workflows` compatibility

With the native Claude Agent SDK backend, `/workflows <task>` is translated to Claude's
`ultracode:` workflow trigger. Workflow task events are exposed as Codex-native reviewable
Subagent threads. While a local workflow runs, the adapter tails its journal and projects each
inner agent through Codex's native `subAgentActivity` lifecycle (with `completed` sent only to
clients that advertise it) plus `spawnAgent`/`wait` tool state; runtimes without journal metadata
fall back to one aggregate workflow agent when the workflow reaches a terminal state.
A bare `/workflows` lists workflow runs
recorded in the current Codex thread.

This compatibility layer is specific to the native Claude Agent SDK backend. Alternate HTTP,
agentapi, and `claude -p` backends receive no workflow event bridge. Interactive workflow
management actions such as pause, resume, stop, and save are not implemented.

When Codex Full Access is selected, the adapter keeps Claude in its standard permission mode and
auto-allows permission requests through the existing Codex bridge. This avoids Relay's refusal of
dangerous permission bypass outside a recognized container sandbox while preserving a zero-prompt
Full Access turn. Operators can still opt into native SDK bypass explicitly with
`CLAUDE_CODEX_PERMISSION_MODE=bypassPermissions` in an appropriately isolated environment.

## Current release boundaries

- **Production path:** the TypeScript app-server adapter remains the shipping
  path for Codex desktop Remote mode and Claude Code.
- **Rust-first work:** RFCs, a workspace scaffold, protocol fixtures, parse /
  reserialize tests, and pinned fixture drift checks are present. Rust does not
  replace the production runtime, transport, store, or launcher yet.
- **Provider and agent-loop work:** descriptors, sanitized `config/read`
  projection, and explicit provider/loop selection are implemented. Selection
  is metadata and routing for known descriptors only; it maps to existing
  runtime backends and does not add a new executable provider loop.
- **Credential model:** use local user-owned API keys, official cloud-provider
  credential chains, local CLI auth on the same host, or organization-managed
  gateways that own billing, policy, audit, and provider compliance.
- **Unsupported:** personal subscription pooling, browser cookie or session-token
  reuse, credential sharing, private endpoint use, provider bypass behavior, and
  claims of unavailable entitlements.
- **Release checks:** CI runs `npm run check`, `npm run typecheck`, `npm test`,
  `cargo test --workspace`, and the pinned Rust fixture drift check. Docs changes
  should run `npm run docs:build`; credentialed smoke and acceptance checks stay
  opt-in with user- or organization-owned credentials.

See the
**[release readiness reference](https://fuergaosi233.github.io/claude-codex/reference/release-readiness)**
for the verification matrix and reviewer checklist.

## Documentation

| Topic | Link |
| --- | --- |
| Getting started | <https://fuergaosi233.github.io/claude-codex/guide/getting-started> |
| Deployment (remote host) | <https://fuergaosi233.github.io/claude-codex/guide/deployment> |
| Using the Codex App | <https://fuergaosi233.github.io/claude-codex/guide/gui> |
| Configuration | <https://fuergaosi233.github.io/claude-codex/guide/configuration> |
| Backends | <https://fuergaosi233.github.io/claude-codex/guide/backends> |
| Capability matrix | <https://fuergaosi233.github.io/claude-codex/reference/capability-matrix> |
| Workflow operations | <https://fuergaosi233.github.io/claude-codex/reference/workflow-operations> |
| Release readiness | <https://fuergaosi233.github.io/claude-codex/reference/release-readiness> |
| Contributing / toolchain | <https://fuergaosi233.github.io/claude-codex/contributing> |
| Security policy | [SECURITY.md](SECURITY.md) |
| Safe examples | [examples/](examples/) |

Docs source lives in [`docs/`](docs/) and is published with VitePress. For
contributors, the repo also ships progressive `AGENTS.md` files (root + `src/` +
`scripts/` + `test/`).

## Development

```bash
npm run dev          # run from TypeScript via tsx
npm run typecheck    # tsc --noEmit
npm run check        # biome format + lint
npm test             # build + node --test
npm run docs:dev     # preview this documentation site
```

See **[Contributing](https://fuergaosi233.github.io/claude-codex/contributing)**
for the full toolchain and conventions.

## Workflow operations

The adapter includes a small workflow control plane for long-running Codex
maintenance loops. It is intentionally file-backed and explicit: the scheduler
tracks tasks in `~/.codex/claude-codex-adapter/workflow-state.json`, and a task
only runs after it has been queued and leased.

```bash
npm run workflow -- status
npm run workflow -- health
npm run workflow -- enqueue --id task-id --prompt "Do one concrete task"
npm run workflow -- schedule --worker codex-heartbeat
npm run workflow -- heartbeat --task task-id --worker codex-heartbeat
npm run workflow -- complete --task task-id
```

Use `health` from recurring heartbeats before doing more work. A healthy loop
has no stale leases, no failed tasks, and either no running task or one running
task with an active lease. If a lease is still active, continue that task or
renew the heartbeat only when more time is needed. Do not enqueue duplicates.

Run events are appended to
`~/.codex/claude-codex-adapter/runs.jsonl` by default. The registry redacts
prompt-like fields, model responses, and secret-like values before writing. Set
`CLAUDE_CODEX_RUN_LOG=0` to disable it, or set `CLAUDE_CODEX_RUN_LOG=/path/log`
to choose a different JSONL file.

Optional per-thread worktree isolation is controlled with
`CLAUDE_CODEX_WORKTREE_ROOT`. Thread ids are mapped to root-confined,
collision-resistant labels, and an existing worktree is reused when present.
If worktree setup fails, the adapter logs the failure and keeps the original
cwd so the app-server session can continue.

GitHub issue or PR automation must go through the trust-boundary queue. Export
only trusted metadata to local JSON, then ingest it:

```bash
gh issue list --json number,title,state,url > /tmp/github-issues.json
npm run workflow -- ingest-github --github-json /tmp/github-issues.json
```

The ingestion step creates explicit workflow tasks from `number`, `title`,
`state`, `url`, and item kind only. Body text, comments, reviews, and other
external instructions are intentionally omitted from generated prompts, so a
later agent must inspect external text through the project trust-boundary
workflow before changing code.

## License

[MIT](LICENSE)
