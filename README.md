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

## License

[MIT](LICENSE)
