# Codex App Remote Capability Matrix

This adapter lets Codex App connect to a remote host through the normal Codex Remote SSH app-server flow while routing agent turns to Claude Code through the Claude Agent SDK.

## Current support

| Area | Status | Notes |
| --- | --- | --- |
| Remote transport | Supported | SSH starts codex app-server --listen unix:// and codex app-server proxy; the shim reports a Codex-compatible version/user agent. |
| Thread lifecycle | Supported | thread/start, resume, fork, archive, list/read, and turn listing are backed by the local SQLite store plus Claude session ids. |
| Normal chat | Supported | turn/start streams Claude text/reasoning into Codex agentMessage and reasoning items. |
| Structured title/summary turns | Supported with fallback | Codex internal/OpenAI model ids such as gpt-5.4-mini map to CLAUDE_CODEX_SUMMARY_MODEL, default haiku, when outputSchema is present. The adapter wraps the schema for Claude SDK and falls back to schema-shaped JSON if Claude emits plain text. |
| Model mapping | Supported | Native Claude aliases pass through. Unknown Codex/OpenAI ids use the configured default model, except structured turns use the summary model. |
| Reasoning effort | Best effort | Codex efforts are normalized and can be mapped through CLAUDE_CODEX_EFFORT_ALIASES. Older Claude SDKs may ignore unsupported effort options. |
| Claude Code tools | Supported | The adapter no longer restricts tools by default. Set CLAUDE_CODEX_ALLOWED_TOOLS to explicitly restrict the tool list. |
| Bash approval | Supported | Claude SDK can_use_tool requests become Codex item/commandExecution/requestApproval server requests. |
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
