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
# Defaults for new threads, surfaced through config/read.
export CLAUDE_CODEX_DEFAULT_MODEL="sonnet"
export CLAUDE_CODEX_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CLAUDE_CODEX_MODELS="sonnet,opus,fable,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CLAUDE_CODEX_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CLAUDE_CODEX_EFFORT_ALIASES='{"xhigh":"max"}'
```

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file), on top of
# any servers inherited from the Codex and Claude Code configs (with the
# switches below); it wins a name.
export CLAUDE_CODEX_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Also start the Codex config's [mcp_servers] in Claude threads (off by default).
export CLAUDE_CODEX_CODEX_MCP_SERVERS=1

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
| `CLAUDE_CODEX_COMPAT_VERSION` | Codex app-server version advertised (default `0.159.0-alpha.12.1`, the Codex build of the verified App). The App turns features on by it; see [Codex App compatibility](/reference/app-compat#feature-gates-and-claude-codex-compat-version). |
| `CLAUDE_CODEX_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `claude-codex`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | Real Codex CLI for non-app-server commands / `codex` passthrough. |
| `CLAUDE_CODEX_RUNTIME_TYPE` | Active backend route. |
| `CLAUDE_CODEX_PROVIDER` | Provider descriptor id (`claude-code` or `codex`) mapped only to existing runtime behavior. |
| `CLAUDE_CODEX_AGENT_LOOP` | Agent-loop id (`native-claude-code-sdk` or `codex-jsonl-proxy`) mapped only to existing runtime behavior. |
| `provider_loop_provider` | Saved config key for provider descriptor selection via `config/value/write`. |
| `provider_loop_agent_loop` | Saved config key for agent-loop selection via `config/value/write`. |
| `CLAUDE_CODEX_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. |
| `CLAUDE_CODEX_MODELS` | Codex App model picker list. |
| `CLAUDE_CODEX_CODEX_MODELS` | Codex models the picker offers through the bundled `codex` (comma-separated). Without it the list comes from `model_catalog.json` in `CODEX_HOME`. |
| `CLAUDE_CODEX_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping. |
| `CLAUDE_CODEX_MCP_SERVERS` | MCP server config (JSON or path to a JSON file; a file may wrap the servers in `mcpServers` as `.mcp.json` does). Wins a name over inherited servers. |
| `CLAUDE_CODEX_CODEX_MCP_SERVERS` | `1` starts the Codex config's `[mcp_servers]` (user `config.toml` and trusted project `.codex/config.toml`) in Claude threads; off otherwise, since the Codex App writes its own desktop servers into that file. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_CODEX_NOTIFY` | `1` runs the Codex config's `notify` program when a Claude thread's turn completes; off otherwise, since the Codex App sets `notify` to its own turn-ended program. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_ALLOWED_TOOLS` | Pre-approved tools. |
| `CLAUDE_CODEX_ADD_DIRS` | Extra directories exposed to Claude. |
| `CLAUDE_CODEX_CLAUDE_CONFIG_DIR` | Claude Code config folder (such as `~/.claude`) whose `CLAUDE.md`, rules and skills the adapter passes to Claude itself, together with the project's `CLAUDE.md` files, rules and skills. For a Claude CLI started with its setting sources turned off. `AGENTS.md` files reach Claude either way. Its MCP servers, subagents, permission rules and command hooks come along only with the switches below. |
| `CLAUDE_CODEX_CLAUDE_MCP_SERVERS` | `1` starts the bridged Claude Code config's MCP servers (with approved project `.mcp.json` servers) in Claude threads and lists them in the App's MCP panel; off otherwise. Needs `CLAUDE_CODEX_CLAUDE_CONFIG_DIR`. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_CLAUDE_AGENTS` | `1` gives Claude threads the bridged config's and the project's Claude Code subagents; off otherwise. Needs `CLAUDE_CODEX_CLAUDE_CONFIG_DIR`. |
| `CLAUDE_CODEX_CLAUDE_PERMISSIONS` | `1` applies the bridged config's and the project's Claude Code permission allow, ask and deny rules (ask rules through a `PreToolUse` callback that sends the calls they cover to the Codex approval); off otherwise. Needs `CLAUDE_CODEX_CLAUDE_CONFIG_DIR`. |
| `CLAUDE_CODEX_CLAUDE_HOOKS` | Which Claude Code command hooks run with `CLAUDE_CODEX_CLAUDE_CONFIG_DIR` set: the config folder's `settings.json` with `user`, also a trusted project's `.claude/settings.json` and `.claude/settings.local.json` with `project`, none when unset, `0` or anything else (often terminal status or notification integrations, so they stay off for App chats unless asked for). The Claude CLI must start without its setting sources, or it runs the same hooks too; the adapter warns at startup. See [Inherited configuration](https://github.com/fuergaosi233/claude-codex#inherited-configuration). |
| `CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING` | Enable SDK file checkpointing. |
| `CLAUDE_CODEX_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CLAUDE_CODEX_IDLE_EXIT_MS` | Daemon idle shutdown. |
| `CLAUDE_CODEX_WS_AUTH` | `capability-token` requires a token on the `ws://` listener; `none` (the default on loopback) does not. See [WebSocket listener](#websocket-listener). |
| `CLAUDE_CODEX_WS_TOKEN` / `_TOKEN_FILE` / `_TOKEN_SHA256` | The `ws://` listener token, from the variable, a 0600 file (absolute path), or as its SHA-256 digest. Default: `ws-token` in the adapter home, created on first use. |
| `CLAUDE_CODEX_WS_ALLOWED_ORIGINS` | Comma-separated origins allowed to open a `ws://` connection; requests with any other `Origin` are refused. |
| `CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED` | `1` (or `--ws-allow-unauthenticated`) lets a `ws://` listener on a non-loopback address start without a token, which it otherwise refuses. Not recommended: anyone who can reach the address can run the agent. |
| `CLAUDE_CODEX_BACKGROUND_IDLE_MS` | How long a Claude session keeps background agents alive without any message (default 2 hours). |
| `CLAUDE_CODEX_QUIET_BACKGROUND_TURNS` | `0` marks every finished turn unread in the Codex App again. By default a turn that ends while its background agents or workflows still run leaves the chat read and sends no notification (background Bash shells do not count, since one can run for the rest of the chat); see [Background work and the unread dot](/guide/gui#background-work-and-the-unread-dot). |
| `CLAUDE_CODEX_SESSION_SETTLE_MS` | How long an idle session waits for Claude to answer a task that just ended, when the CLI does not report session state (default `15000`). |
| `CLAUDE_CODEX_GOAL_TOOLS` | `0` keeps the goal tools (the `codex_goal` MCP server) away from Claude. |
| `CLAUDE_CODEX_MEMORIES` | `1` lets the App's Memories settings and `/memories` decide whether Claude threads run with Claude Code's auto-memory; with Memories off in the App, Claude threads then run without it. Off otherwise: the App shows no Memories settings and Claude Code's own settings decide. See [Memories](/guide/gui#memories). |
| `CLAUDE_CODEX_REAP_ORPHANED_CLI` | `0` stops the adapter from ending Claude CLI processes a previous adapter left running (on by default; never on Windows). |
| `CLAUDE_CODEX_MOCK` | Run the protocol without Claude credentials. |
| `CLAUDE_CODEX_STATE_DB_TIMEOUT_MS` | How long a state-database write waits for another connection's lock before it fails (default `5000`). |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
