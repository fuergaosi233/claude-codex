# AGENTS.md

Guidance for AI agents (Codex, Claude Code) working in this repo. This is the
**root** of a progressive set — each major directory has its own focused
`AGENTS.md` that you should read when you start editing files there:

- [`src/AGENTS.md`](src/AGENTS.md) — adapter internals, runtime interface.
- [`scripts/AGENTS.md`](scripts/AGENTS.md) — shim, mode helper, hooks, checks.
- [`test/AGENTS.md`](test/AGENTS.md) — test layout and how to run them.

## What this is

A remote-mode adapter that lets the **Codex desktop app** talk to **Claude
Code** through the native Codex `app-server` protocol. Codex App runs its normal
SSH probe/bootstrap; a `codex` shim earlier in `PATH` routes `codex app-server`
calls to this adapter instead of the real Codex runtime.

## Build & test

```bash
npm install
npm run dev            # tsx src/adapter.mts — run sources directly, no build
npm run build          # tsc -> dist/ (production artifact)
npm run typecheck      # tsc --noEmit
npm run check          # biome format + lint (read-only)
npm run check:fix      # biome auto-fix (format + safe lint)
npm test               # build + node --test dist/test/*.mjs
npm run doctor         # environment self-check
```

**Build constraint: Node.js 24+ is required.** The store uses `node:sqlite`,
which Node 22 hides behind `--experimental-sqlite` (not passed), so it crashes
at runtime on 22. Pin a binary with `CLAUDE_CODEX_NODE` if the default `node`
is older. `engines.node` enforces `>=24`.

The fast dev loop is `npm run dev` (tsx runs `.mts` directly). The code is kept
**erasable** (see conventions), so on Node 24 you can also run sources with the
built-in stripper: `node src/adapter.mts`. Production still ships compiled `.mjs`
so a remote host needs only `node` — no TS toolchain.

## Project-wide conventions

- TypeScript **ESM only**: `.mts` sources under `src/` compile to `.mjs` under
  `dist/`. `npm run dev` runs sources directly; `npm test` builds first.
- **Erasable syntax only** (`erasableSyntaxOnly` in tsconfig): no `enum`,
  `namespace`, or constructor parameter properties — declare fields explicitly
  and assign in the constructor body. This keeps `tsx` / native type stripping
  working.
- **Never hand-edit `dist/` or `generated/`** — they are produced by
  `npm run build` and `npm run generate:schema`.
- Formatting/linting is **Biome** (`biome.json`): 2-space, single quotes, no
  semicolons, lineWidth 100. Run `npm run check:fix` before committing.
- Config is env-driven (`CLAUDE_CODEX_*`); the full list lives in the README.
- `CLAUDE_CODEX_MOCK=1` runs the protocol without Claude credentials.
- Match the comment density and naming of surrounding code. Keep modules
  focused — see the file-length nudge below.

## Hooks (enforced automatically)

`.claude/settings.json` wires `scripts/hooks/guard.mjs` into Claude Code:

- **PreToolUse** blocks edits to `dist/` and `generated/` (build artifacts).
- **PostToolUse** warns when a source file isn't `.mts` under `src/`, when
  runtime code lands outside a `*-runtime.mts` module, or when a `.mts` file
  grows past ~1000 lines.

These are advisory guardrails for the architecture and length checks; the script
exits 0 on any internal error so it can never wedge a session.
