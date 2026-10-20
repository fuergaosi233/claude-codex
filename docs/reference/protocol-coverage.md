# Protocol coverage

Implemented as real remote/runtime behavior:

- **Transports** — stdio, WebSocket, Unix-socket daemon, and `app-server proxy`
  raw stdio forwarding.
- **Thread lifecycle** — start, resume, fork, list, read, turns list, name,
  archive/unarchive, unsubscribe, interrupt, delete, and rollback/revert that
  rewind Claude's session to the kept turns.
- **History and search** — turn, item and timeline paging; thread search over
  names, previews and messages; find-in-conversation occurrences.
- **Projects and attachments** — `project/*` and `thread/attachment/*`, kept in
  the adapter's SQLite store.
- **Claude runtime** — query, session resume/fork, partial text streaming,
  interrupt, model and effort switches within a running turn, MCP config,
  allowed tools, add dirs, file checkpointing.
- **Turn input** — user input, and the `toolOutput` of a thread handoff as a
  `functionCallOutput` item.
- **Approval bridge** — `Bash` and other tools → command approval; `Edit` /
  `Write` / `MultiEdit` → file-change approval with diffs; MCP tool calls → the
  App's MCP tool approval card; declined calls end `declined`, and cancel
  interrupts the turn; MCP elicitation → the App's form or link prompt. The
  auto-review reviewer (`approvalsReviewer`, kept per thread) → Claude Code's
  auto mode, with `item/autoApprovalReview/completed` for a call its
  classifier denies, or a `configWarning` and `user` echoed back where auto
  mode is unavailable.
- **Streaming** — turn started/completed, thread status changes, agent text
  deltas, reasoning deltas, command output deltas, file patches, generic tool
  item completion, hook runs, model reroutes, and aggregated git diff updates.
- **Remote utilities** — file read/write/list/metadata/copy/remove/watch,
  command exec with stdin/terminate, process spawn/stdin/kill, fuzzy file
  search, direct MCP stdio/HTTP tool and resource calls.
- **Per-thread git worktree isolation** (optional).

## Compatibility-only surfaces

Some app UI methods return stable empty or inert responses because they are
OpenAI-account / plugin-marketplace / realtime-specific rather than Claude Code
runtime capabilities — for example marketplace install/update, OpenAI account
login/logout, realtime audio, remote control, passkey verification and Windows
sandbox setup. They answer truthfully (empty, disabled or unavailable) instead
of failing, so the App hides or disables the feature.

See the **[Capability matrix](/reference/capability-matrix)** for the full
per-area breakdown.
