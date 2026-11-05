# Validation

```bash
npm test                              # build + unit tests (node --test)
npm run doctor                        # environment checks
npm run smoke:real                    # real Claude turn (needs Anthropic/Bedrock/Vertex auth)
npm run acceptance:local-remote       # local shim/daemon/proxy + real Claude file edit
npm run acceptance:gui-ssh-localhost  # SSH localhost -> login shell -> shim -> GUI-session runtime
npm run probe:codex-cli-remote        # probes the local codex --remote CLI behavior
npm run probe:capabilities            # mock stdio app-server: compat version + core requests
npm run acceptance:ssh-runtime-matrix -- <ssh-host> <cwd-a> <cwd-b>  # runtime switch matrix on a host
npm run check:app-upgrade -- --app <Codex.app>  # new Codex App build vs the verified baseline
CODEX_REAL="$(command -v codex)" npm run check:rust-protocol-fixtures  # Rust fixtures vs real codex schema
```

CI runs `npm run check`, `npm run typecheck`, `npm test`,
`check:rust-protocol-fixtures` (against `@openai/codex@0.163.0`), and
`cargo test --workspace`. The other commands are opt-in and run by hand.

## What each check does

- **`acceptance:local-remote`** creates an ignored
  `.claude-codex/local-remote-acceptance-*` directory, installs the shim into a
  temporary `PATH`, starts the Unix-socket daemon, connects through `app-server
  proxy`, auto-approves Claude Code file edits, and verifies that Claude creates
  a file in the temporary workspace.

- **`acceptance:gui-ssh-localhost`** is the closest automated check to the Codex
  App GUI Remote experience on macOS: it starts `codex app-server --listen
  unix://` and `codex app-server proxy` through `ssh localhost 'zsh -lc ...'`,
  then verifies Claude Code can edit a git workspace through Codex approval and
  diff events.

- **`probe:codex-cli-remote`** starts the adapter in mock WebSocket mode and
  tries the currently installed `codex --remote ws://...` CLI. It keeps a
  transcript under `.claude-codex/codex-cli-remote-probe-*`. In a desktop flow
  the app supplies its own interactive/auth context; the CLI probe reports
  `blocked-login`, `blocked-timeout`, or `blocked-no-tty` when the local CLI
  cannot complete an automated remote prompt.

- **`probe:capabilities`** builds, then starts the adapter as a stdio
  app-server in mock mode (`CLAUDE_CODEX_MOCK=1` unless already set) with a
  temporary `CODEX_HOME`. It checks that the `initialize` userAgent carries the
  advertised Codex compat version, then runs `thread/start`, a `turn/start` with
  an `outputSchema`, `process/spawn`, `thread/compact/start`, and an inline
  `review/start`, and prints `capability probe passed`. It needs no Claude
  credentials.

- **`acceptance:ssh-runtime-matrix`** copies itself with `scp` to `/tmp` on
  `<ssh-host>` (or `CLAUDE_CODEX_MATRIX_SSH_HOST`) and runs there after
  sourcing `~/.claude-codex/runtime.env`, which must set `CODEX_REAL` and
  `CLAUDE_CODEX_ADAPTER`. For every `from->to` pair of runtime modes (default
  `codex`, `agent-sdk-sidecar`, `agent-http`, `agentapi`, `claude-p`; override
  with comma-separated `MODE_MATRIX_MODES`) it switches modes with
  `claude-codex-mode set`, writes a token file into `<cwd-a>` and `<cwd-b>`, and
  checks that a real model turn reads the token back. `MODE_MATRIX_MODEL`
  (default `haiku`) and `TURN_TIMEOUT_MS` (default `180000`) tune the turns. It
  restores the host's `runtime.env` afterwards unless
  `MODE_MATRIX_RESTORE_ENV=0`. Results are JSON lines on stdout ending with a
  `matrix-summary` record; the exit code is non-zero if any cell failed. It
  needs working credentials for every selected mode on the host.

- **`check:app-upgrade`** checks a new Codex desktop App build against what the
  adapter assumes about it before the build is marked verified. See
  [App compatibility](/reference/app-compat) for its options and the upgrade
  procedure.

- **`check:rust-protocol-fixtures`** generates the app-server schema with the
  real Codex CLI and checks that the methods the Rust protocol fixtures under
  `crates/claude-codex-protocol/fixtures/` use still exist and that the Turn
  fixtures carry exactly the fields of the generated `Turn`. Set `CODEX_REAL`
  to the real `codex` binary; the check refuses the repository shim and any
  `codex` on `PATH` that looks like an adapter shim.

Acceptance and probe transcripts from `acceptance:local-remote`,
`acceptance:gui-ssh-localhost`, and `probe:codex-cli-remote` are written under
the git-ignored `.claude-codex/` directory.
