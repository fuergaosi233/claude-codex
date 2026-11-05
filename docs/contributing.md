# Contributing

## Toolchain

| Tool | Role | Command |
| --- | --- | --- |
| [tsx](https://tsx.is) | Run `.mts` sources directly (dev loop) | `npm run dev` |
| [tsc](https://www.typescriptlang.org) | Type-check + emit `dist/*.mjs` | `npm run build` / `npm run typecheck` |
| [Biome](https://biomejs.dev) | Format + lint | `npm run check` / `npm run check:fix` |
| `node --test` | Unit tests | `npm test` |
| [VitePress](https://vitepress.dev) | This docs site | `npm run docs:dev` |

```bash
npm install
npm run dev          # tsx src/adapter.mts — run sources directly, no build
npm run build        # tsc -> dist/ (production artifact)
npm run typecheck    # tsc --noEmit
npm run check        # biome format + lint (read-only)
npm run check:fix    # biome auto-fix
npm test             # build + node --test dist/test/*.mjs
```

## Conventions

- **ESM only**: `.mts` sources under `src/` compile to `.mjs` under `dist/`.
  Relative imports use the `.mjs` extension (NodeNext).
- **Erasable syntax only** (`erasableSyntaxOnly`): no `enum`, `namespace`, or
  constructor parameter properties. Declare fields explicitly and assign in the
  constructor body. This keeps `tsx` and Node 24 native type stripping working —
  on Node 24 you can run `node src/adapter.mts` directly.
- **Never hand-edit `dist/` or `generated/`** — they are produced by
  `npm run build` and `npm run generate:schema`.
- Formatting: 2-space, single quotes, no semicolons, lineWidth 100 (Biome).
  Run `npm run check:fix` before committing.
- New Claude backends go in a `*-runtime.mts` module wired through
  `runtime-factory.mts` (the `ClaudeRuntime` interface).

## Why `.mts` / `.mjs`?

The adapter is launched directly with `node dist/src/adapter.mjs` on remote
hosts. Compiling `.mts` → `.mjs` makes every file unambiguously ESM at the file
level (Node always treats `.mjs` as ESM, regardless of any `package.json`), so
the deployed artifact needs only `node` — no TS toolchain, no dependence on a
`type: module` lookup in `dist/`.

## Project layout

- `src/adapter.mts` — entry point / CLI mode dispatch.
- `src/server.mts` — Codex app-server protocol layer.
- `src/transports.mts` — stdio / WebSocket / Unix-socket daemon / proxy.
- `src/store.mts` — SQLite thread/turn persistence (`node:sqlite`).
- `src/*-runtime.mts` + `runtime-factory.mts` — pluggable Claude backends.
- `scripts/codex-shim` — the `PATH` shim Codex App invokes.
- `scripts/claude-codex-mode` — host helper to switch backends.
- `test/` — `node:test` suites against `dist/`.

The repo also ships progressive `AGENTS.md` files (root + `src/` + `scripts/` +
`test/`) for AI agents working in the codebase, plus a Claude Code guard hook in
`scripts/hooks/guard.mjs`.

## Docs site

This site is built with VitePress from `docs/`:

```bash
npm run docs:dev       # local preview with hot reload
npm run docs:build     # static build -> docs/.vitepress/dist
npm run docs:preview   # serve the built site
```

It deploys to GitHub Pages automatically on push to `main` via
`.github/workflows/deploy-docs.yml`. CI also runs `npm run docs:build` on
every pull request, and the build fails on a link to a page that does not
exist.
