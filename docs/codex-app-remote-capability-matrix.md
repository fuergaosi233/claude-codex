# Codex App Remote Capability Matrix

This adapter lets Codex App connect to a remote host through the normal Codex Remote SSH app-server flow while routing agent turns to Claude Code. The default runtime is still the Claude Agent SDK sidecar, but runtime selection is now pluggable.

## Current support

| Area | Status | Notes |
| --- | --- | --- |
| Remote transport | Supported | SSH starts codex app-server --listen unix:// and codex app-server proxy; the shim reports a Codex-compatible version/user agent. |
| Thread lifecycle | Supported | thread/start, resume, fork, archive, list/read, and turn listing are backed by the local SQLite store plus Claude session ids. |
| Normal chat | Supported | turn/start streams Claude text/reasoning into Codex agentMessage and reasoning items. |
| Runtime backend selection | Supported | `CLAUDE_CODEX_RUNTIME_TYPE` selects native `codex` passthrough at the shim layer, or adapter runtimes `agent-sdk-sidecar` (default), `agent-sdk-socket`, `agent-http`, `agentapi`, `claude-p`, and `mock`. Codex App's model menu is kept as a model selector; change the active route with `claude-codex-mode` on the remote host and reconnect. Existing `CLAUDE_CODEX_MOCK=1` and `CLAUDE_CODEX_RUNTIME_SOCKET` behavior is preserved. |
| agent-http / Channels backend | Experimental | Consumes the agent-http-compatible HTTP API (`POST /message`, `GET /messages`, `GET /status`, `GET /events`) and streams message-level assistant deltas into Codex. It does not expose Agent SDK semantic tool, permission, or reasoning events. |
| agentapi backend | Experimental | Uses the same HTTP/SSE client against coder/agentapi. Since agentapi derives output from a terminal emulator, Codex sees assistant text but not structured Claude Code tool events. |
| claude-p backend | Experimental | Runs `claude-p --output-format json --input-file ...` per turn and emits the final transcript-derived result. It is not true streaming and does not support turn/steer. |
| Structured title/summary turns | Supported with fallback | Codex internal/OpenAI model ids such as gpt-5.4-mini map to CLAUDE_CODEX_SUMMARY_MODEL, default haiku, when outputSchema is present. The adapter wraps the schema for Claude SDK and falls back to schema-shaped JSON if Claude emits plain text. |
| Model mapping | Supported | Native Claude aliases pass through. Unknown Codex/OpenAI ids use the configured default model, except structured turns use the summary model. The App's `config/batchWrite` model and effort selections are remembered and echoed back through `config/read`. |
| Reasoning effort | Best effort | Codex efforts are normalized and can be mapped through CLAUDE_CODEX_EFFORT_ALIASES. Older Claude SDKs may ignore unsupported effort options. |
| Claude Code tools | Supported | The adapter no longer restricts tools by default. Set CLAUDE_CODEX_ALLOWED_TOOLS to explicitly restrict the tool list. |
| Approval policy / sandbox tier | Supported | The Codex App's selected approvalPolicy (unless-trusted / on-failure / on-request / never) and sandbox (read-only / workspace-write / danger-full-access) are persisted on the thread, surfaced back through the thread envelope, and mapped to Claude permission_mode. "Full access" (never + danger-full-access) drops the can_use_tool callback so tools execute without per-call approval. read-only sandbox restricts the allowed_tools list to read/search tools. |
| Bash approval | Supported | Claude SDK can_use_tool requests become Codex item/commandExecution/requestApproval server requests. Bypassed when Codex App pinned approvalPolicy=never or Full access; defensive auto-accept also kicks in if the SDK still asks. |
| Subagent (Task) | Supported (native) | Claude's Task tool spawns an ephemeral child thread (threadSource=subagent, agentRole=subagent_type ?? "general-purpose", agentNickname=`agent-{12hex}` matching Claude's own internal naming) and emits Codex's full native 3-stage timeline in the parent: `spawnAgent` (begin → end with receiverThreadIds=[childId], collabAgentToolCall.model = the actual SDK model the subagent runs on, agent state running), `wait` (begin → end on the Task tool_result, agent state completed; this is the long phase that gives Codex App its "agent is working" indicator), `closeAgent` (begin → end). Inner text/tool_use/tool_result events are hidden from the parent and the subagent's final result lands as a single agentMessage on the child thread so the user can drill in. |
| Ephemeral / threadSource | Supported | thread/start `ephemeral: true` (used by Codex App's title-generation, memory-consolidation, and the adapter's own subagent children) is persisted and excluded from `thread/list` by default. `includeEphemeral: true` opts back in. `threadSource` (user / subagent / memory_consolidation) round-trips on the thread envelope. |
| Bash output | Supported | Final tool results are forwarded as command output. The Claude Agent SDK does not expose incremental tool-output streaming, so output appears when the command completes rather than line by line. |
| Token usage | Supported | Claude Agent SDK ResultMessage usage is mapped to a TokenUsageBreakdown and pushed as thread/tokenUsage/updated notifications (cumulative total plus last turn). |
| Claude side events | Supported | rate_limit / hook / subagent / compaction stream events are summarized into structured, human-readable notice lines with the right severity instead of truncated raw JSON. |
| File edit approval | Supported | Edit, Write, and MultiEdit become Codex fileChange items with approval and diff updates. |
| Generic Claude tools | Supported | Non-command/file tools become mcpToolCall items under the claude-code pseudo server. |
| MCP config/status/tools | Supported | The adapter reads Claude MCP config, reports server status, can call stdio/HTTP tools directly, and passes MCP servers into Claude SDK turns. |
| Filesystem utility RPCs | Supported | fs/readFile, write, metadata, directory listing, remove, copy, watch, and unwatch use Codex v2-shaped responses. |
| Command/process utility RPCs | Supported | command/exec and process/spawn are implemented for app utility flows. |
| Steering/interrupt | Supported | turn/steer and turn/interrupt route to the active Claude SDK client. |
| Review mode | Supported with Claude text findings | review/start now creates an in-progress review turn, emits enteredReviewMode, and routes the review prompt through Claude. Native Codex guardian finding items are not implemented. |
| Context compaction | Supported with local summary | thread/compact/start now emits contextCompaction started/completed items and a compacted summary message. Native persisted rollout compaction is not implemented. |
| SDK option compatibility | Supported | When an older Claude Agent SDK rejects an option, the sidecar drops it one at a time (least essential first) and emits an info notice instead of collapsing to a bare option set. |
| Realtime audio | Unsupported | Claude Code has no realtime audio channel. Realtime methods ack the call so the App's capability probe does not error, and listVoices returns an empty voice list rather than fabricated voices. |
| Plugins/marketplace/skills/hooks/apps | Not applicable | Claude Code has no Codex plugin marketplace; methods return empty schema-shaped responses so the App's panels render without breaking. |
| Account/rate limits/auth | Not applicable | Claude Code manages its own authentication, so Codex account/OpenAI-auth panels intentionally report null/empty rather than fabricated state. |
| External agent import | Stub | externalAgentConfig/detect and import return empty results. |
| Windows sandbox | Unsupported | The target deployment is Linux; Windows sandbox methods return not configured. |

## Robustness notes

- Unix socket paths are validated against the platform sun_path limit (~104 on macOS, ~108 on Linux); a deep CODEX_HOME falls back to a short hashed path under the system temp dir.
- git diff / file listing failures are written to the debug log (distinguishing "not a git repository" from real errors) instead of being swallowed silently.
- Per-thread in-memory state (session command approvals, token usage, goals, elicitation counts) is released when a thread is archived.

## Good next targets

1. Parse Claude review text into first-class Codex review finding items if the App exposes a stable item shape for them.
2. Persist compaction summaries in a dedicated compacted-history store instead of only emitting contextCompaction UI items.
3. Expand the capability probe to run over SSH against a named host, not only the local app-server process.
4. Flesh out plugin/skill/app surfaces only if Codex App starts relying on those panels for regular remote workflows.
