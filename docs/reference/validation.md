# Validation

```bash
npm test                              # build + unit tests (node --test)
npm run doctor                        # environment checks
npm run smoke:real                    # real Claude turn (needs Anthropic/Bedrock/Vertex auth)
npm run acceptance:local-remote       # local shim/daemon/proxy + real Claude file edit
npm run acceptance:gui-ssh-localhost  # SSH localhost -> login shell -> shim -> GUI-session runtime
npm run probe:codex-cli-remote        # probes the local codex --remote CLI behavior
```

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

Acceptance and probe transcripts are written under the git-ignored
`.claude-codex/` directory.
