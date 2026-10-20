# Configuration

All configuration is environment-driven (`CLAUDE_CODEX_*`). Set these in the
remote login shell (e.g. `~/.zshenv`) or in `~/.claude-codex/runtime.env`.

## Runtime backend

```bash
# Default uses the in-process Claude Agent SDK.
export CLAUDE_CODEX_RUNTIME_TYPE="agent-sdk-sidecar"
#   codex      - pass app-server through to the real Codex CLI (shim layer)
#   agent-http - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi   - HTTP/SSE bridge for coder/agentapi
#   claude-p   - one-shot PTY/transcript wrapper via claude-p
#   mock       - local protocol testing
```

See [Backends](/guide/backends) for what each route supports.

## Provider and agent-loop selection

Provider selection is descriptor metadata plus routing to existing runtime
backends. It does not add a new provider runtime, auth flow, subscription model,
gateway, or entitlement.

```bash
# Known provider descriptor ids.
export CLAUDE_CODEX_PROVIDER="claude-code" # or "codex"

# Known agent-loop ids.
export CLAUDE_CODEX_AGENT_LOOP="native-claude-code-sdk" # or "codex-jsonl-proxy"
```

Current mappings:

| Provider / loop | Existing runtime behavior |
| --- | --- |
| `claude-code` / `native-claude-code-sdk` | `agent-sdk-sidecar` |
| `codex` / `codex-jsonl-proxy` | `codex-proxy` |

Backward compatibility rules:

- `CLAUDE_CODEX_RUNTIME_TYPE`, `CLAUDE_CODEX_RUNTIME`, and
  `CLAUDE_CODEX_BACKEND` still override provider selection when set.
- `CLAUDE_CODEX_MOCK=1` still forces the `mock` runtime.
- Saved config can set `provider_loop_provider` and
  `provider_loop_agent_loop` through `config/value/write`.
- Raw saved selection keys are filtered out of public `config/read`; the safe
  projection appears under `config.provider_loop_config.selection`, with
  redacted validation issues when a selection is unknown or mismatched.

Selection must stay within supported credential ownership models. It does not
collect or share credentials, pool personal subscriptions, reuse browser cookies
or session tokens, configure private endpoints, or bypass provider terms.

## Models & effort

```bash
# Defaults for new threads, surfaced through config/read. The effort is one of
# low, medium, high, xhigh, max; a model that does not take it defaults to the
# closest level below.
export CLAUDE_CODEX_DEFAULT_MODEL="sonnet"
export CLAUDE_CODEX_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CLAUDE_CODEX_MODELS="sonnet,opus,fable,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CLAUDE_CODEX_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CLAUDE_CODEX_EFFORT_ALIASES='{"xhigh":"max"}'
```

Each Claude model in the picker offers the reasoning efforts Claude Code reports
for it: `max` only on the models that take it, and none on a model without an
effort setting, such as Haiku. For such a model the App sends the effort
`none`, and its turns run without one. Claude Code reports the efforts when a
session starts. The adapter keeps the last report in
`~/.codex/claude-codex-adapter/claude-models.json`, so the list is right again
after a restart. The App reloads the list when its window regains focus, at
most every five minutes, so the levels can take that long to appear after the
first Claude turn. Before that turn, and with a Claude Code too old to report
efforts, every model offers low to xhigh. A model in
`CLAUDE_CODEX_MODELS` is matched to Claude Code's report by the id it passes to
Claude Code, so an alias for a full model id gets that model's efforts. The
Codex App hides `max` until it is turned on under Settings > Agent > Model
features > Available reasoning efforts.

Without model process profiles, the picker also lists the per-model config
folders a model router keeps under `~/.cache/*/claude-router/`, or in the
folders `CLAUDE_CONFIG_DIRS` (or `CLAUDE_ROUTER_DIR`) lists. When a chat
resumes and the newest copy of its session transcript is in another config
folder, say because it ran on another model, the adapter copies it into the one
folder this turn's Claude Code runs from: `CLAUDE_CONFIG_DIR`, else
`~/.claude`, or, with `CLAUDE_CODEX_CLI` set, the router folder named after the
model when there is one. A copy there that is as new, or longer, is left
alone: a transcript only grows, so a shorter one is never a later state of it,
whatever its modification time says. Since a transcript
holds the whole conversation, the copy keeps the transcript's file mode, and it
is a clone where the file system supports it.

## Model process profiles

Every Claude thread normally runs the same Claude Code: the one the SDK ships
(or `CLAUDE_CODEX_CLI`), with the adapter's environment. A profiles file gives
each model in the picker a Claude Code process of its own instead: its own
executable, provider environment and Claude config folder
(`CLAUDE_CONFIG_DIR`, where its sessions live). That way one App can offer
models from several Claude-compatible providers or accounts you hold. Without a
profiles file nothing changes.

```bash
export CLAUDE_CODEX_MODEL_PROFILES_FILE="$HOME/.claude-codex/models.json"
# Or the same JSON inline; set only one of the two.
# export CLAUDE_CODEX_MODEL_PROFILES='[{"id":"sonnet"},{"id":"opus"}]'
```

```json
{
  "defaultModel": "main-model",
  "models": [
    {
      "id": "main-model",
      "sdkModel": "sonnet",
      "displayName": "Main model",
      "env": { "CLAUDE_CONFIG_DIR": "${HOME}/.claude-codex/profiles/main-model" }
    },
    {
      "id": "second-model",
      "sdkModel": "vendor/model-1",
      "displayName": "Second model",
      "description": "Served by a second provider",
      "executable": "${HOME}/bin/claude",
      "envFile": "second-model.env",
      "env": {
        "CLAUDE_CONFIG_DIR": "${HOME}/.claude-codex/profiles/second-model",
        "ANTHROPIC_AUTH_TOKEN": "${SECOND_PROVIDER_TOKEN}"
      }
    }
  ]
}
```

The file holds either an object with a `models` array (and optionally
`defaultModel`) or just the array. Each profile has:

| Field | Meaning |
| --- | --- |
| `id` | The model id the picker shows and threads store. Letters, digits, `.`, `_` and `-` (starting with a letter or digit), at most 128 characters, unique. |
| `sdkModel` | The model Claude Code runs; defaults to `id`. |
| `displayName` / `description` | The picker's label and description. |
| `isDefault` | Marks the default model, as the top-level `defaultModel` does. There is one default: without either, the first profile. |
| `executable` | Path of the Claude Code to start. Without it the SDK's own Claude Code runs; `CLAUDE_CODEX_CLI` does not apply to profiles. |
| `envFile` | A file of `KEY=value` lines (`export` and quotes allowed, `#` comments) applied to the process environment. |
| `env` | Variables set on the process after the env file. |
| `inheritEnv` | Adapter variables the process inherits. By default `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, the locale, terminal, color and temp-folder variables, the `XDG_*` folders, `SSH_AUTH_SOCK` and `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`; `["*"]` inherits all of them and cannot be combined with names. |

`${VAR}` in `executable`, `envFile`, the env file and `env` reads the adapter's
environment; a missing variable is an error. `executable` and `envFile` may
also start with `~/`, and a relative path is taken from the profiles file's
folder (the adapter's working folder for inline profiles). A key in `env` that looks like a secret (its name contains `TOKEN`,
`KEY`, `SECRET`, `PASSWORD` or `AUTH`) must be a single `${VAR}` reference, so
the file itself never holds a credential. A token budget such as
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` (`TOKENS` at the end of a word) is no secret.
`${VAR}` in the env file also reads the file's earlier lines, and in `env`
the whole env file.

The process starts from the inherited variables without the adapter's provider
settings (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
the `ANTHROPIC_DEFAULT_*_MODEL` variables, the Bedrock, Vertex and Foundry
switches, endpoints and keys (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` /
`_FOUNDRY`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`,
`ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_FOUNDRY_*`, `AWS_BEARER_TOKEN_BEDROCK`),
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_SUBAGENT_MODEL`,
`CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CONFIG_DIR`), even with `["*"]`, and
without the secret variables the profile reads from (with `["*"]`, those any
profile's `env` reads); then the env file and `env` apply. So each profile
sets its own provider and config folder, and the adapter's own credentials
never reach it. A profile without `CLAUDE_CONFIG_DIR` uses Claude Code's
default folder. Profiles need the native runtime: with another
`CLAUDE_CODEX_RUNTIME_TYPE`, a profile turn fails rather than run on the
adapter's own provider.

The profiles file must be a regular file owned by the user running the adapter,
neither a symbolic link nor writable by group or others. An env file must be a
regular file owned by that user with mode `0600`, not a symbolic link; the
adapter opens it without following links and rejects it if it changes while
being read. A profiles file that breaks these rules, or that cannot be parsed,
fails the requests that need it with the reason rather than falling back to
another Claude Code.

### Fingerprints

A Claude thread pins the fingerprint of its profile when it starts: a SHA-256
over the profile's `id`, `sdkModel`, `executable` and `envFile` paths, sorted
`inheritEnv`, and the env file and `env` assignments with `${VAR}` expanded.
The value of a secret-looking key, and any secret-looking variable a value
reads, counts as a placeholder: rotating a credential keeps the fingerprint, while
changing the model, endpoint, executable, config folder or any other setting
changes it. The fingerprint is kept with the thread in the adapter's state
database.

- Once a thread has a conversation (a turn ran, or it is a fork), its Claude
  session lives in that profile's process and config folder. If the profile's
  fingerprint changed, the profile or the profiles file is gone, or the thread
  started before profiles were set up, the chat still opens (`thread/resume`,
  `thread/read`) so it can be read, but nothing starts Claude for it: a turn,
  fork, compaction, review or model change fails, saying what happened and to
  start a new chat, instead of resuming the session somewhere else. A queued
  message or an active goal reports the same error and does not run; the
  queued message stays queued.
- A thread with nothing said yet, such as the one the App opens for a new chat
  before its first message, takes the profile's current configuration and can
  still move to any profile.
- A thread with a conversation stays on its profile: the model menu
  (`thread/settings/update`, `thread/metadata/update`), `turn/start` and
  `turn/settings/update` refuse another profile, `thread/resume` ignores one, and
  a fork stays on its parent's profile, the App's ephemeral description fork
  included. Subagents run in their parent's process and carry its profile.
  Its sessions resume only from its profile's config folder, and the workflows
  it starts are looked up there too.
- Codex model threads have no profile.

### Profiles and the other model settings

The profiles are the whole Claude part of the picker. `CLAUDE_CODEX_MODELS`,
`CLAUDE_CODEX_MODEL_ALIASES` and discovered router models are not used, and a
Claude model id that names no profile is an error rather than a fallback. Codex
models are listed and routed as before. `CLAUDE_CODEX_DEFAULT_MODEL` still picks
the model of new threads when it names a profile; the `default` alias is the
default profile. Each profile offers the reasoning efforts Claude Code reports
for its `sdkModel`.

A chat's title and summary turns run on its own profile. The App's helper
threads that name a Codex model, with `CLAUDE_CODEX_DISABLE_CODEX_PROXY=1`, run
on the profile `CLAUDE_CODEX_SUMMARY_MODEL` names (else
`CLAUDE_CODEX_TITLE_MODEL`, else the default profile); with profiles set, those
two variables take a profile id.

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file), on top of
# any servers inherited from the Codex and Claude Code configs (with the
# switches below); it wins a name.
export CLAUDE_CODEX_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Also start the Codex config's [mcp_servers] in Claude threads (off by default).
export CLAUDE_CODEX_CODEX_MCP_SERVERS=1

# Run the App's bundled code-review plugin server for its Pull Requests panel
# (off by default; uses the host's GitHub credentials, such as a gh login).
export CLAUDE_CODEX_APP_PLUGIN_MCP=1

# With CLAUDE_CODEX_CLAUDE_CONFIG_DIR set, also bring that Claude Code config's
# MCP servers, subagents and permission rules (each off by default).
export CLAUDE_CODEX_CLAUDE_MCP_SERVERS=1
export CLAUDE_CODEX_CLAUDE_AGENTS=1
export CLAUDE_CODEX_CLAUDE_PERMISSIONS=1

# Pre-approved tools (others still route through Codex approval) + extra dirs.
export CLAUDE_CODEX_ALLOWED_TOOLS="Read,Glob,Grep"
export CLAUDE_CODEX_ADD_DIRS="/repo/shared,/repo/docs"
export CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING=1
```

## Worktree isolation

```bash
# Per-thread git worktree isolation (off by default — it creates branches).
export CLAUDE_CODEX_AUTO_WORKTREE=1
export CLAUDE_CODEX_WORKTREE_ROOT="$HOME/.claude-codex/worktrees"
```

When enabled, each new Codex thread runs in a dedicated `git worktree`.

## Daemon

```bash
# Idle shutdown grace period in ms (default 15000; 0 = never exit).
export CLAUDE_CODEX_IDLE_EXIT_MS="15000"

# Unix socket of `app-server --listen unix://` and `app-server proxy`
# (default $CODEX_HOME/app-server-control/app-server-control.sock). Set it
# where both commands run, such as the login shell profile or runtime.env,
# and give it a folder of its own: the daemon makes that folder private.
export CLAUDE_CODEX_SOCKET_PATH="$HOME/.claude-codex/run/app-server.sock"

# Start Claude Code processes one at a time (off by default): each waits for
# the previous one's first message, or at most the timeout in ms (default 30000).
export CLAUDE_CODEX_SDK_LAUNCH_GATE="1"
export CLAUDE_CODEX_SDK_LAUNCH_GATE_TIMEOUT_MS="30000"

# Pin a node binary for the shim (e.g. when default node is < 24).
export CLAUDE_CODEX_NODE="/absolute/path/to/node"
```

## WebSocket listener

`--listen ws://host:port` serves the protocol over TCP for clients such as
`codex --remote`. The Codex App does not use it (it runs the adapter over stdio,
or over the unix socket behind `app-server proxy`, which file permissions
protect), so these settings only matter for other clients.

```bash
# Require a capability token on every connection. Without a token source
# the adapter creates one in ws-token under the adapter home
# ($CODEX_HOME/claude-codex-adapter unless CLAUDE_CODEX_HOME is set), mode
# 0600, and prints the file path, never the token.
export CLAUDE_CODEX_WS_AUTH="capability-token"

# Token sources (set at most one; any of them turns the token on):
export CLAUDE_CODEX_WS_TOKEN="<at-least-16-printable-characters>"
export CLAUDE_CODEX_WS_TOKEN_FILE="/absolute/path/to/token"   # mode 0600
export CLAUDE_CODEX_WS_TOKEN_SHA256="<hex sha-256 of the token>"

# Origins allowed to connect. Requests with any other Origin header are
# refused, which keeps web pages away from a loopback listener.
export CLAUDE_CODEX_WS_ALLOWED_ORIGINS="https://example.com"

# Not recommended: let a listener on a non-loopback address start without a
# token. Anyone who can reach the address can then run the agent as this user.
export CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED=1
```

The same settings exist as flags: `--ws-auth capability-token|none`,
`--ws-token-file`, `--ws-token-sha256`, `--ws-allowed-origins` and
`--ws-allow-unauthenticated`.

- A client sends the token as `Authorization: Bearer <token>`, which is what
  `codex --remote ws://… --remote-auth-token-env VAR` does. A browser, which
  cannot set headers on a WebSocket, offers the subprotocols
  `claude-codex.v1` and `claude-codex.bearer.<token>`; the adapter answers with
  `claude-codex.v1` only.
- On a loopback address (`127.0.0.1`, `::1`, `localhost`) the token is
  optional unless one of the settings above turns it on, so existing local
  clients keep working. On any other address (`0.0.0.0`, `::`, a LAN or public
  IP) the adapter refuses to start without it, as `codex app-server` does:

  ```text
  refusing to start non-loopback websocket listener ws://0.0.0.0:8788 without auth. Pass --ws-auth capability-token (CLAUDE_CODEX_WS_AUTH=capability-token) to require a token, or --ws-allow-unauthenticated (CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED=1) to accept any client that can reach this address.
  ```

  `--ws-allow-unauthenticated` is the explicit opt-out for a listener that
  something else protects (a private network, a firewall, an authenticating
  reverse proxy). The adapter then prints a warning at startup, and the
  `Origin` check below still applies. It cannot be combined with a token.
- Any request with an `Origin` header is refused (403) unless the origin is in
  `CLAUDE_CODEX_WS_ALLOWED_ORIGINS`. App-server clients outside a browser send
  no Origin.
- Tokens are compared as SHA-256 digests in constant time and never logged.
- `ws://` is plain text. Off the local machine, put it behind TLS (a reverse
  proxy) or reach it through an SSH tunnel to a loopback listener. The Codex
  CLI sends a `--remote-auth-token-env` token only to a `wss://` or a loopback
  `ws://` URL.
- `ws://[::1]:8788` listens on the IPv6 loopback address, and port `0` picks a
  free port; the `listening on ws://…` line shows the port actually bound.

## Reference table

| Setting | Purpose |
| --- | --- |
| `CLAUDE_CODEX_ADAPTER` | Path to `dist/src/adapter.mjs` (used by the shim). |
| `CLAUDE_CODEX_NODE` | Node binary the shim launches. |
| `CLAUDE_CODEX_COMPAT_VERSION` | Codex app-server version advertised (default `0.163.0-alpha.10.2`, the Codex build of App 26.1013). The App turns features on by it; see [Codex App compatibility](/reference/app-compat#feature-gates-and-claude-codex-compat-version). |
| `CLAUDE_CODEX_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `claude-codex`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | Real Codex CLI for non-app-server commands / `codex` passthrough. |
| `CLAUDE_CODEX_RUNTIME_TYPE` | Active backend route. |
| `CLAUDE_CODEX_PROVIDER` | Provider descriptor id (`claude-code` or `codex`) mapped only to existing runtime behavior. |
| `CLAUDE_CODEX_AGENT_LOOP` | Agent-loop id (`native-claude-code-sdk` or `codex-jsonl-proxy`) mapped only to existing runtime behavior. |
| `provider_loop_provider` | Saved config key for provider descriptor selection via `config/value/write`. |
| `provider_loop_agent_loop` | Saved config key for agent-loop selection via `config/value/write`. |
| `CLAUDE_CODEX_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. |
| `CLAUDE_CODEX_MODELS` | Codex App model picker list. Unused with model process profiles. |
| `CLAUDE_CODEX_MODEL_PROFILES_FILE` | JSON file of model process profiles: each Claude model in the picker runs its own Claude Code executable, provider environment and config folder, and a thread stays on the profile it started with. Must be owned by the user and not writable by others. See [Model process profiles](#model-process-profiles). |
| `CLAUDE_CODEX_MODEL_PROFILES` | The same profiles as inline JSON; set only one of the two. |
| `CLAUDE_CODEX_CODEX_MODELS` | Codex models the picker offers through the bundled `codex` (comma-separated). Without it the list comes from `model_catalog.json` in `CODEX_HOME`. |
| `CLAUDE_CODEX_DISABLE_CODEX_PROXY` | `1` turns Codex model routing off, unless the Codex proxy is the selected loop: the picker offers only Claude models, a new thread on a Codex model is refused, and the App's title and summary threads run on `CLAUDE_CODEX_SUMMARY_MODEL` (else `CLAUDE_CODEX_TITLE_MODEL`, else haiku; with model process profiles, the profile they name, else the default profile). |
| `CLAUDE_CODEX_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping (model aliases are unused with model process profiles). |
| `CLAUDE_CODEX_MCP_SERVERS` | MCP server config (JSON or path to a JSON file; a file may wrap the servers in `mcpServers` as `.mcp.json` does). Wins a name over inherited servers. |
| `CLAUDE_CODEX_CODEX_MCP_SERVERS` | `1` starts the Codex config's `[mcp_servers]` (user `config.toml` and trusted project `.codex/config.toml`) in Claude threads; off otherwise, since the Codex App writes its own desktop servers into that file. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_CODEX_NOTIFY` | `1` runs the Codex config's `notify` program when a Claude thread's turn completes; off otherwise, since the Codex App sets `notify` to its own turn-ended program. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_APP_PLUGIN_MCP` | `1` runs the MCP server of the Codex App's bundled `code-review` plugin for the App's Pull Requests panel calls, from the plugin's folder with a short environment allowlist; a comma-separated list names other plugins instead (`codex-app-tools` and `browser-use` never run). Off otherwise; Claude threads never get these servers. The plugin uses the host's GitHub credentials, such as an existing `gh` login; the adapter passes it no token. See [Pull Requests panel](/guide/gui#pull-requests-panel). |
| `CLAUDE_CODEX_ALLOWED_TOOLS` | Pre-approved tools. |
| `CLAUDE_CODEX_ADD_DIRS` | Extra directories exposed to Claude. |
| `CLAUDE_CODEX_CLAUDE_CONFIG_DIR` | Claude Code config folder (such as `~/.claude`) whose `CLAUDE.md`, rules and skills the adapter passes to Claude itself, together with the project's `CLAUDE.md` files, rules and skills. For a Claude CLI started with its setting sources turned off. `AGENTS.md` files reach Claude either way. Its MCP servers, subagents, permission rules and command hooks come along only with the switches below. |
| `CLAUDE_CODEX_CLAUDE_MCP_SERVERS` | `1` starts the bridged Claude Code config's MCP servers (with approved project `.mcp.json` servers) in Claude threads and lists them in the App's MCP panel; off otherwise. Needs `CLAUDE_CODEX_CLAUDE_CONFIG_DIR`. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_CLAUDE_AGENTS` | `1` gives Claude threads the bridged config's and the project's Claude Code subagents; off otherwise. Needs `CLAUDE_CODEX_CLAUDE_CONFIG_DIR`. |
| `CLAUDE_CODEX_CLAUDE_PERMISSIONS` | `1` applies the bridged config's and the project's Claude Code permission allow, ask and deny rules (ask rules through a `PreToolUse` callback that sends the calls they cover to the Codex approval); off otherwise. Needs `CLAUDE_CODEX_CLAUDE_CONFIG_DIR`. |
| `CLAUDE_CODEX_CLAUDE_HOOKS` | Which Claude Code command hooks run with `CLAUDE_CODEX_CLAUDE_CONFIG_DIR` set: the config folder's `settings.json` with `user`, also a trusted project's `.claude/settings.json` and `.claude/settings.local.json` with `project`, none when unset, `0` or anything else (often terminal status or notification integrations, so they stay off for App chats unless asked for). The Claude CLI must start without its setting sources, or it runs the same hooks too; the adapter warns at startup. A hook's `onFailure: "block"` is honored: one that cannot start, times out, exits with a code other than 0 or 2 or prints JSON that does not parse blocks as exit 2 would. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING` | Enable SDK file checkpointing. |
| `CLAUDE_CODEX_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CLAUDE_CODEX_IDLE_EXIT_MS` | Daemon idle shutdown. |
| `CLAUDE_CODEX_WS_AUTH` | `capability-token` requires a token on the `ws://` listener; `none` (the default on loopback) does not. See [WebSocket listener](#websocket-listener). |
| `CLAUDE_CODEX_WS_TOKEN` / `_TOKEN_FILE` / `_TOKEN_SHA256` | The `ws://` listener token, from the variable, a 0600 file (absolute path), or as its SHA-256 digest. Default: `ws-token` in the adapter home, created on first use. |
| `CLAUDE_CODEX_WS_ALLOWED_ORIGINS` | Comma-separated origins allowed to open a `ws://` connection; requests with any other `Origin` are refused. |
| `CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED` | `1` (or `--ws-allow-unauthenticated`) lets a `ws://` listener on a non-loopback address start without a token, which it otherwise refuses. Not recommended: anyone who can reach the address can run the agent. |
| `CLAUDE_CODEX_SOCKET_PATH` | Unix socket that `app-server --listen unix://` listens on and `app-server proxy` connects to when neither names one (`app-server proxy --sock <path>` still wins). Default `app-server-control/app-server-control.sock` under `CODEX_HOME`, or a short path in the temp directory when that is too long for a socket. Both commands read it, so set it where both run, as an absolute path (a relative one resolves against each command's working directory) within the socket path limit (about 104 bytes on macOS, 108 on Linux). The daemon creates the socket's folder if needed and makes it private to the user (mode 700), with a `.pid` file next to the socket, so give the socket a folder of its own. |
| `CLAUDE_CODEX_BACKGROUND_IDLE_MS` | How long a Claude session keeps background agents alive without any message (default 2 hours). Every message, a background agent's progress included, starts the wait over. |
| `CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS` | How long a turn waits on a subagent or workflow that shows no sign of life before it fails the turn (default `1800000`, 30 minutes; `0` never gives up; at least `100`). Any progress (the agent's output or tool heartbeats, task progress, a workflow agent starting or finishing) starts the wait over. On expiry the turn is stopped as an interrupt would stop it, which keeps background work earlier turns left running; while background agents the turn itself handed off still run, only its own stuck agents and workflows stop and those agents keep going. |
| `CLAUDE_CODEX_QUIET_BACKGROUND_TURNS` | `0` marks every finished turn unread in the Codex App again. By default a turn that ends while its background agents or workflows still run leaves the chat read and sends no notification (background Bash shells do not count, since one can run for hours); see [Background work and the unread dot](/guide/gui#background-work-and-the-unread-dot). |
| `CLAUDE_CODEX_LIVE_FILE_CHANGES` | `0` shows a file change only once Claude has written the whole call. By default the card of an Edit, Write or MultiEdit call opens as soon as Claude's streamed input names the file and grows while Claude writes the rest, as the Codex App draws a patch Codex is still writing; see [File changes while Claude writes them](/guide/gui#file-changes-while-claude-writes-them). |
| `CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS` | How often a running Bash command's output is read for its command item in the App (default `1000`); `0` shows the output only once the command finishes. |
| `CLAUDE_CODEX_SESSION_SETTLE_MS` | How long an idle session waits for Claude to answer a task that just ended, when the CLI does not report session state (default `15000`). |
| `CLAUDE_CODEX_SDK_LAUNCH_GATE` | `1` starts the Claude Code processes of Claude threads one at a time: each waits until the one before has sent its first message. Several starting at the same moment, such as the chats that all resume their Claude sessions right after a restart, write the user's `~/.claude.json` at once and can corrupt it ([anthropics/claude-code#28847](https://github.com/anthropics/claude-code/issues/28847)). Prompts and steers sent meanwhile wait for their process. Off by default. |
| `CLAUDE_CODEX_SDK_LAUNCH_GATE_TIMEOUT_MS` | With `CLAUDE_CODEX_SDK_LAUNCH_GATE=1`, how long a launch that has said nothing yet holds the next one back (default `30000`). A SessionStart hook that Claude Code runs as it starts does not count: Claude Code reports the hook when it begins, which lets the next launch go ahead. |
| `CLAUDE_CODEX_GOAL_TOOLS` | `0` keeps the goal tools (the `codex_goal` MCP server) away from Claude. |
| `CLAUDE_CODEX_MEMORIES` | `1` lets the App's Memories settings and `/memories` decide whether Claude threads run with Claude Code's auto-memory; with Memories off in the App, Claude threads then run without it. Off otherwise: the App shows no Memories settings and Claude Code's own settings decide. See [Memories](/guide/gui#memories). |
| `CLAUDE_CODEX_DYNAMIC_TOOLS` | `1` offers Claude the dynamic tools a client registers on `thread/start`, such as the Codex App's own tools on a remote connection, each namespace as an MCP server; Claude's calls go back to the client as `item/tool/call` without an approval prompt. Off by default, because the App's tools act on your desktop. Applies to chats started while it is on. See [App tools](/guide/gui#app-tools). |
| `CLAUDE_CODEX_LEADER_TOOLS` | `1` gives Claude in chats you start the leader tools (the `codex_leader` MCP server), to start and drive other chats; off by default. See [Leader chats](/guide/gui#leader-chats). |
| `CLAUDE_CODEX_LEADER_MAX_RUNNING` | How many chats one leader may have working at once (default `4`). |
| `CLAUDE_CODEX_REASONING_VISIBLE` | `0` keeps Claude's thinking out of the Codex App: the CLI is not passed `--thinking-display summarized`, and what thinking arrives stays raw reasoning content, which the App does not show. The App's Reasoning summary setting set to None (`model_reasoning_summary = "none"`) does the same. Use it too with a Claude CLI pinned through `CLAUDE_CODEX_CLI` that predates the flag. See [Thinking and reasoning summaries](/guide/gui#thinking-and-reasoning-summaries). |
| `CLAUDE_CODEX_WEBSEARCH` | `0` tells the Codex App that Claude threads do not search the web: `modelProvider/capabilities/read` reports no web search and `config/read` reports `web_search = "disabled"`. Otherwise both report live search, the way Claude's WebSearch tool works. Claude Code's WebSearch tool itself stays available; deny it in Claude Code's permission rules to take it away. |
| `CLAUDE_CODEX_REAP_ORPHANED_CLI` | `0` stops the adapter from ending Claude CLI processes a previous adapter left running (on by default; never on Windows). |
| `CLAUDE_CODEX_MOCK` | Run the protocol without Claude credentials. |
| `CLAUDE_CODEX_STATE_DB_TIMEOUT_MS` | How long a state-database write waits for another connection's lock before it fails (default `5000`). |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
