---
layout: home

hero:
  name: Claude Codex Adapter
  text: Claude Code inside the Codex app
  tagline: A production TypeScript adapter that speaks the native Codex app-server protocol, so the Codex desktop app drives Claude Code over your normal SSH Remote flow.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Configuration
      link: /guide/configuration
    - theme: alt
      text: View on GitHub
      link: https://github.com/fuergaosi233/claude-codex

features:
  - icon: 🔌
    title: Native protocol, no fork
    details: Codex App runs its usual SSH probe, bootstrap, and app-server proxy. A codex shim earlier in PATH routes only app-server calls into the adapter.
  - icon: 🧠
    title: Claude Code turns
    details: Agent text and reasoning stream into the conversation; Bash becomes command approvals; Edit/Write/MultiEdit become file-change approvals with live diffs.
  - icon: 🔁
    title: Explicit existing backends
    details: >-
      Provider and loop selection is sanitized metadata that maps known
      descriptors to existing runtime paths: Agent SDK, agent-http, agentapi,
      claude-p, codex-proxy, and mock.
  - icon: 📦
    title: Zero-toolchain deploy
    details: Ships compiled ESM .mjs, so a remote host needs only Node 24. Dev runs straight from TypeScript with tsx.
---

## What it does

The adapter implements the Codex `app-server` v2 protocol (stdio, WebSocket,
Unix-socket daemon, and `app-server proxy`) and bridges each Codex request to a
Claude Code runtime. Thread lifecycle, streaming, approvals, MCP, and remote
filesystem/command utilities are all backed by real runtime behavior.

The current release path is intentionally narrow. TypeScript remains the
production runtime. Rust-first work is present as RFCs, an experimental protocol
crate, fixtures, parse/reserialize tests, and a pinned fixture drift gate, but it
does not replace the runtime, transport, store, or launcher. Provider and
agent-loop work exposes descriptors, sanitized config projection, and explicit
selection for known descriptors only; it does not add a new provider runtime,
auth system, gateway, subscription model, or multi-agent orchestrator.

Credentials should be supplied by the local user or organization through API
keys, official cloud-provider credential chains, same-host local CLI auth, or an
approved organization gateway. The project does not support personal
subscription pooling, browser cookie/session-token reuse, credential sharing,
private endpoints, provider bypasses, or claims of unavailable entitlements.
Release checks include CI `check`, `cargo-test`, TypeScript tests, the pinned
Rust fixture drift gate, docs build for docs changes, and opt-in credentialed
smoke or acceptance checks.

```bash
npm install
npm run build        # tsc -> dist/ (production artifact)
npm run dev          # tsx src/adapter.mts — run sources directly
npm run doctor       # environment self-check
```

Then install the [`codex` shim](/guide/deployment) on the remote host and add a
Remote connection in the Codex App. See **[Getting started](/guide/getting-started)**.

For release gates and reviewer expectations, see
**[Release readiness](/reference/release-readiness)**.

::: tip Requires Node.js 24+
The thread store uses `node:sqlite`, which is only stable (unflagged) on Node 24.
:::
