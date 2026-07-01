# Contributing

Thanks for helping improve Claude Codex Adapter. This root guide is the GitHub
entry point; the full contributor guide lives in [docs/contributing.md](docs/contributing.md).

## Before you start

- Use Node.js 24 or newer. The adapter relies on stable `node:sqlite`.
- Install dependencies with `npm install`.
- Keep changes small and reviewable. Separate runtime/protocol work, docs work,
  dependency updates, and release planning into different pull requests.
- Do not commit secrets, local Claude Code session files, OAuth data, API keys,
  `.env` files, or acceptance-test transcripts.

## Development checks

Run the checks that match your change:

```bash
npm run typecheck
npm run check
npm test
npm run docs:build
```

For runtime or protocol changes, include focused tests under `test/` and run the
full `npm test` suite. For docs-only changes, run `npm run docs:build` and note
whether any link-checking gap remains.

## Project layout

- `src/adapter.mts` is the CLI and app-server entry point.
- `src/server.mts` implements the Codex app-server protocol surface.
- `src/*-runtime.mts` modules implement selectable Claude/Codex backends.
- `scripts/codex-shim` is the remote `codex` PATH shim.
- `docs/` is the VitePress documentation site.
- `test/` contains `node:test` coverage against compiled `dist/` output.

## Pull request expectations

- Keep each PR focused on one behavior or documentation topic.
- Include a clear test plan in the PR description.
- Add or update tests for code changes.
- Avoid broad formatting churn unless the PR is explicitly a formatting/tooling
  change.

See [docs/contributing.md](docs/contributing.md) for the detailed toolchain and
coding conventions.
