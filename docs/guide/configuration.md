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

## Models & effort

```bash
# Defaults for new threads, surfaced through config/read.
export CLAUDE_CODEX_DEFAULT_MODEL="sonnet"
export CLAUDE_CODEX_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CLAUDE_CODEX_MODELS="sonnet,opus,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CLAUDE_CODEX_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CLAUDE_CODEX_EFFORT_ALIASES='{"xhigh":"max"}'
```

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file).
export CLAUDE_CODEX_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

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

## Reference table

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CODEX_ADAPTER` | Path to `dist/src/adapter.mjs` (used by the shim). |
| `CLAUDE_CODEX_NODE` | Node binary the shim launches. |
| `CLAUDE_CODEX_COMPAT_VERSION` | Codex app-server version advertised (default `0.142.3`). |
| `CLAUDE_CODEX_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `claude-codex`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | Real Codex CLI for non-app-server commands / `codex` passthrough. |
| `CLAUDE_CODEX_RUNTIME_TYPE` | Active backend route. |
| `CLAUDE_CODEX_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. |
| `CLAUDE_CODEX_MODELS` | Codex App model picker list. |
| `CLAUDE_CODEX_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping. |
| `CLAUDE_CODEX_MCP_SERVERS` | MCP server config (JSON or file path). |
| `CLAUDE_CODEX_ALLOWED_TOOLS` | Pre-approved tools. |
| `CLAUDE_CODEX_ADD_DIRS` | Extra directories exposed to Claude. |
| `CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING` | Enable SDK file checkpointing. |
| `CLAUDE_CODEX_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CLAUDE_CODEX_IDLE_EXIT_MS` | Daemon idle shutdown. |
| `CLAUDE_CODEX_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
