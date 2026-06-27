# Protocol coverage

Implemented as real remote/runtime behavior:

- **Transports** — stdio, WebSocket, Unix-socket daemon, and `app-server proxy`
  raw stdio forwarding.
- **Thread lifecycle** — start, resume, fork, list, read, turns list, name,
  archive/unarchive, unsubscribe, interrupt.
- **Claude runtime** — query, session resume/fork, partial text streaming,
  interrupt, MCP config, allowed tools, add dirs, file checkpointing.
- **Approval bridge** — `Bash` → command approval; `Edit` / `Write` /
  `MultiEdit` → file-change approval with diffs.
- **Streaming** — turn started/completed, thread status changes, agent text
  deltas, reasoning deltas, command output deltas, file patches, generic tool
  item completion, and aggregated git diff updates.
- **Remote utilities** — file read/write/list/metadata/copy/remove/watch,
  command exec with stdin/terminate, process spawn/stdin/kill, fuzzy file
  search, direct MCP stdio/HTTP tool and resource calls.
- **Per-thread git worktree isolation** (optional).

## Compatibility-only surfaces

Some app UI methods return stable empty or inert responses because they are
OpenAI-account / plugin-marketplace / realtime-specific rather than Claude Code
runtime capabilities — for example marketplace install/update, OpenAI account
login/logout, realtime audio, and Windows sandbox setup. They ack so the App's
capability probe does not error.

See the **[Capability matrix](/reference/capability-matrix)** for the full
per-area breakdown.
