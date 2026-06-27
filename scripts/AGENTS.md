# scripts/AGENTS.md

Operational scripts. See the [root AGENTS.md](../AGENTS.md) for build/test and
project-wide conventions. These run on Node directly (no build step) and ship as
plain `.mjs` / shell.

## Map

- `codex-shim` — the `PATH` shim Codex App invokes. Routes `codex app-server`
  into the adapter (`CLAUDE_CODEX_ADAPTER`); forwards everything else to the real
  Codex CLI (`CODEX_REAL`). Keep it dependency-free and POSIX-sh portable.
- `claude-codex-mode` — host helper to switch runtime backends, restart bridges,
  and read status/logs. Writes `~/.claude-codex/runtime.env`.
- `hooks/guard.mjs` — Claude Code hook enforcing project conventions (blocks
  build-artifact edits; warns on non-`.mts` src, misplaced runtime code, and
  files > ~1000 lines). Wired in `.claude/settings.json`. Must exit 0 on any
  internal error so it never wedges a session.
- `doctor.mjs` — environment self-check (`npm run doctor`).
- `smoke-real-claude.mjs` — round-trips a real Claude turn (`npm run smoke:real`).
- `acceptance-*.mjs` — end-to-end checks (local-remote, gui-ssh-localhost,
  ssh-runtime-matrix); transcripts land under git-ignored `.claude-codex/`.
- `probe-*.mjs` — capability / codex-cli-remote probes.

## Conventions

- Shell scripts: no Bash-only features in `codex-shim` (it runs under the remote
  login shell). Keep it side-effect free except routing.
- `.mjs` scripts read no build output unless they `npm run build` first (the
  acceptance/smoke scripts do via their npm wrappers).
- When adding a hook, branch on `hook_event_name`, read JSON from stdin, and
  fail open (exit 0) on error.
- `.mjs` scripts are Biome-formatted (`npm run format` covers `scripts/`); the
  shell scripts (`codex-shim`, `claude-codex-mode`) are left untouched.
