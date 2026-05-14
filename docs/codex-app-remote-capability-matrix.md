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
| Bash output | Supported | Streaming command output is forwarded, and final tool results backfill output when the SDK does not stream deltas. |
| File edit approval | Supported | Edit, Write, and MultiEdit become Codex fileChange items with approval and diff updates. |
| Generic Claude tools | Supported | Non-command/file tools become mcpToolCall items under the claude-code pseudo server. |
| MCP config/status/tools | Supported | The adapter reads Claude MCP config, reports server status, can call stdio/HTTP tools directly, and passes MCP servers into Claude SDK turns. |
| Filesystem utility RPCs | Supported | fs/readFile, write, metadata, directory listing, remove, copy, watch, and unwatch use Codex v2-shaped responses. |
| Command/process utility RPCs | Supported | command/exec and process/spawn are implemented for app utility flows. |
| Steering/interrupt | Supported | turn/steer and turn/interrupt route to the active Claude SDK client. |
| Review mode | Stub | review/start returns a completed placeholder; real Codex-style review orchestration is not implemented yet. |
| Context compaction | Stub | thread/compact/start is a no-op today. |
| Realtime audio | Unsupported | Realtime voice/audio methods are compatibility stubs except listVoices. |
| Plugins/marketplace/skills/hooks/apps | Compatibility stub | Empty schema-shaped responses avoid UI breakage but do not provide native Codex plugin behavior. |
| Account/rate limits/auth | Compatibility stub | Codex account panels return static/null responses; Claude authentication remains managed by Claude Code. |
| External agent import | Stub | externalAgentConfig/detect and import return empty results. |
| Windows sandbox | Unsupported | The target deployment is Linux; Windows sandbox methods return not configured. |

## Good next targets

1. Implement real review/start by launching a Claude review turn and mapping findings into Codex review items instead of returning a placeholder.
2. Implement thread/compact/start by asking Claude Haiku/Sonnet for a structured conversation summary and emitting Codex compaction/context items.
3. Improve structured output fallback beyond simple object schemas, especially arrays and nested objects.
4. Map Claude hook/subagent/rate-limit events into richer Codex items or notifications instead of treating some events as compatibility no-ops.
5. Add a real capability probe command that exercises normal chat, structured title generation, Bash approval, file edit approval, MCP, resume, and interrupt against a remote host.
6. Flesh out plugin/skill/app surfaces only if Codex App starts relying on those panels for regular remote workflows.

