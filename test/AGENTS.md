# test/AGENTS.md

Tests run with the built-in `node:test` runner against compiled output. See the
[root AGENTS.md](../AGENTS.md) for project-wide conventions.

## Layout

- `*.test.mts` — sources compiled to `dist/test/*.mjs`.
- `adapter-*.test.mts` — end-to-end suites that spawn the mock adapter, split
  by area (protocol, models-config, daemon, turn-items, subagents, approvals,
  turn-lifecycle, mcp-skills).
- `support/` — shared helpers, such as `support/adapter-harness.mts` for the
  `adapter-*` suites. They compile to `dist/test/support/`, outside the
  `npm test` glob, so they never run as suites.
- `fixtures/` — shared test fixtures.

## Running

```bash
npm test            # builds, then runs node --test dist/test/*.mjs
npm run build       # if you want to compile without running
node --test dist/test/adapter-daemon.test.mjs   # a single suite, after a build
```

## Conventions

- Tests import from `dist/` (compiled `.mjs`), so **always build first** —
  `npm test` does this for you; editing a `.mts` and re-running raw
  `node --test` without a rebuild tests stale output.
- Use `CLAUDE_CODEX_MOCK=1` to exercise protocol behavior without Claude
  credentials. Credentialed end-to-end checks live in `scripts/acceptance-*`,
  not here.
- Add new suites as `<area>.test.mts`; the `npm test` glob picks them up.
- `node --test` runs files in parallel but the tests in one file in order, so
  the slowest file sets the wall time. Add a slow mock-adapter test to the
  `adapter-*` suite of its area, or start a new one, rather than growing a
  single suite.
