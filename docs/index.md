---
layout: home

hero:
  name: Claude Codex Adapter
  text: Claude Code inside the Codex app
  tagline: A remote-mode adapter that speaks the native Codex app-server protocol, so the Codex desktop app drives Claude Code over your normal SSH Remote flow.
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
    title: Pluggable backends
    details: Default in-process Agent SDK, plus agent-http (Channels), agentapi, claude-p, and native codex passthrough — switched per host with claude-codex-mode.
  - icon: 📦
    title: Zero-toolchain deploy
    details: Ships compiled ESM .mjs, so a remote host needs only Node 24. Dev runs straight from TypeScript with tsx.
---

## What it does

The adapter implements the Codex `app-server` v2 protocol (stdio, WebSocket,
Unix-socket daemon, and `app-server proxy`) and bridges each Codex request to a
Claude Code runtime. Thread lifecycle, streaming, approvals, MCP, and remote
filesystem/command utilities are all backed by real runtime behavior.

```bash
npm install
npm run build        # tsc -> dist/ (production artifact)
npm run dev          # tsx src/adapter.mts — run sources directly
npm run doctor       # environment self-check
```

Then install the [`codex` shim](/guide/deployment) on the remote host and add a
Remote connection in the Codex App. See **[Getting started](/guide/getting-started)**.

::: tip Requires Node.js 24+
The thread store uses `node:sqlite`, which is only stable (unflagged) on Node 24.
:::
