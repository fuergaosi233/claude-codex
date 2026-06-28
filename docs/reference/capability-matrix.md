# Codex App Remote Capability Matrix

Codex App connects to a remote host via the normal Codex Remote SSH app-server
flow, while agent turns are routed to Claude Code. Default runtime is the Claude
Agent SDK sidecar; runtime selection is pluggable. Status legend: **Supported**,
**Experimental**, **Stub**, **Unsupported**, **N/A**.

## Core

| Area | Status | Notes |
| --- | --- | --- |
| Remote transport | Supported | SSH starts `codex app-server --listen unix://` + `proxy`; the shim reports a Codex-compatible version/user agent. |
| Thread lifecycle | Supported | start/resume/fork/archive/list/read + turn listing, backed by SQLite + Claude session ids. |
| Normal chat | Supported | `turn/start` streams Claude text/reasoning into Codex agentMessage/reasoning items. |
| Steering / interrupt | Supported | `turn/steer` and `turn/interrupt` route to the active Claude client. |
| Token usage | Supported | SDK ResultMessage usage → TokenUsageBreakdown, pushed as `thread/tokenUsage/updated` (cumulative + last turn). |

## Runtime selection

| Backend | Status | Notes |
| --- | --- | --- |
| Selection mechanism | Supported | `CLAUDE_CODEX_RUNTIME_TYPE` picks native `codex` passthrough (shim) or adapter runtimes. Switch with `claude-codex-mode` on the host and reconnect. |
| agent-sdk-sidecar (default) | Supported | In-process Claude Agent SDK; full tool/permission/reasoning events. |
| agent-http / Channels | Experimental | Consumes `POST /message`, `GET /messages|/status|/events`; message-level deltas only, no semantic tool/permission/reasoning events. |
| agentapi | Experimental | Same HTTP/SSE client against coder/agentapi; terminal-derived text only, no structured tool events. |
| claude-p | Experimental | `claude-p --output-format json --input-file ...` per turn; final transcript result only, not streaming, no `turn/steer`. |

## Models & turns

| Area | Status | Notes |
| --- | --- | --- |
| Model mapping | Supported | Native Claude aliases pass through; unknown Codex/OpenAI ids fall back to the default model. App model/effort selections are remembered and echoed via `config/read`. |
| Reasoning effort | Best effort | Codex efforts normalized, mappable via `CLAUDE_CODEX_EFFORT_ALIASES`; older SDKs may ignore unsupported options. |
| Structured title/summary turns | Supported (fallback) | Codex internal model ids (e.g. gpt-5.4-mini) map to `CLAUDE_CODEX_SUMMARY_MODEL` (default haiku) when an outputSchema is present; falls back to schema-shaped JSON if Claude emits plain text. |
| SDK option compatibility | Supported | When an older SDK rejects an option, the sidecar drops it one at a time (least essential first) and emits an info notice. |

## Tools, approvals & events

| Area | Status | Notes |
| --- | --- | --- |
| Claude Code tools | Supported | Not restricted by default; set `CLAUDE_CODEX_ALLOWED_TOOLS` to restrict. |
| Approval policy / sandbox | Supported | App's approvalPolicy + sandbox persist on the thread and map to Claude permission_mode. "Full access" drops the can_use_tool callback; read-only restricts tools to read/search. |
| Bash approval | Supported | can_use_tool → Codex `item/commandExecution/requestApproval`. Bypassed when approvalPolicy=never / Full access. |
| File edit approval | Supported | Edit/Write/MultiEdit → Codex fileChange items with approval + diff updates. |
| Bash output | Supported | Forwarded as command output on completion (SDK has no incremental tool-output streaming). |
| Generic Claude tools | Supported | Non-command/file tools → mcpToolCall items under the `claude-code` pseudo server. |
| Subagent (Task) | Supported | Task spawns an ephemeral child thread and emits Codex's native 3-stage timeline (`spawnAgent` → `wait` → `closeAgent`); inner events are hidden, the final result lands as one agentMessage on the child thread. |
| Ephemeral / threadSource | Supported | `ephemeral: true` threads (title-gen, memory-consolidation, subagents) persist but are excluded from `thread/list` unless `includeEphemeral: true`. `threadSource` round-trips. |
| Claude side events | Supported | rate_limit / hook / subagent / compaction events summarized into structured notice lines. |
| Review mode | Supported (text) | `review/start` creates an in-progress review turn and routes the prompt through Claude. No native guardian finding items. |
| Context compaction | Supported (summary) | `thread/compact/start` routes the summary prompt and emits contextCompaction items. No native persisted rollout compaction. |

## Utilities

| Area | Status | Notes |
| --- | --- | --- |
| MCP config/status/tools | Supported | Reads Claude MCP config, passes servers into turns, calls stdio/HTTP tools directly. `mcpServerStatus/list` enumerates real `tools`/`resources`/`resourceTemplates` per server (10s cache, graceful empty fallback on spawn/timeout). |
| Turn-item paging | Supported | `thread/turns/list` honors `itemsView` — `summary` (default: first userMessage + final agentMessage), `full`, and `notLoaded` — instead of always shipping every item. |
| Skills & hooks | Supported | `skills/list` reads `.claude/skills/*/SKILL.md` (user+repo scope); `hooks/list` reads `settings.json` hooks, mapping Claude events to Codex `HookEventName` (unmappable events dropped). |
| Fuzzy file search | Supported | One-shot `fuzzyFileSearch` plus the stateful session API (`sessionStart/Update/Stop`) that streams `fuzzyFileSearch/sessionUpdated` results and a final `sessionCompleted`. |
| Filesystem RPCs | Supported | `fs/readFile`, write, metadata, list, remove, copy, watch/unwatch (Codex v2-shaped). |
| Command/process RPCs | Supported | `command/exec` and `process/spawn` implemented. |

## Not applicable / unsupported

| Area | Status | Notes |
| --- | --- | --- |
| Realtime audio | Unsupported | No Claude audio channel; methods ack so capability probe doesn't error; listVoices returns empty. |
| Plugins/marketplace/apps | N/A | No Codex plugin marketplace; methods return empty schema-shaped responses. (Claude skills/hooks are surfaced — see Utilities.) |
| Account/rate limits/auth | N/A | Claude manages its own auth; account/OpenAI-auth panels report null/empty. |
| External agent import | Stub | `externalAgentConfig/detect` and import return empty. |
| Windows sandbox | Unsupported | Target deployment is Linux/macOS; methods return not configured. |

## Protocol version

The adapter advertises codex app-server protocol **v2 @ 0.142.3** (via
`codex --version` and the `initialize` userAgent; override with
`CLAUDE_CODEX_COMPAT_VERSION`). The 0.130 → 0.142 delta is additive and
backward-compatible: new optional request methods (`thread/search`,
`thread/delete`, `account/usage/read`, `plugin/*`, `remoteControl/*`,
`environment/add`, …) plus widened enums (`ReasoningEffort` → free-form string,
new `AuthMode` / `WebSearchMode` variants). The new methods are
OpenAI-account / plugin / remote-control surfaces with no Claude Code
equivalent; unimplemented methods return a JSON-RPC error, which Codex App
treats as "unsupported" for these optional features. Regenerate the reference
schema under `generated/` with `npm run generate:schema` (needs a matching
`codex` on PATH).

## Wire conformance

- `turn/start` response and the `turn/started` / `turn/completed` notifications
  ship `items: []` with `itemsView: "notLoaded"`, matching the real app-server
  (`bespoke_event_handling.rs` clears items; `turn_processor.rs` returns an empty
  turn). The timeline is driven by the `item/*` event stream; loaded items are
  only returned by history reads (`thread/read`, `thread/turns/list`).
- The user message is recorded in turn history but, like the real app-server, is
  not surfaced as a `userMessage` `item/*` event during a turn (including
  `turn/steer`). `review/start`'s response carries the synthesized `userMessage`
  (itemsView `notLoaded`); `enteredReviewMode` arrives via `item/started`.
  Uploaded images are surfaced live as `imageView` `item/*` events.
- MCP boot status uses `mcpServer/startupStatus/updated` with a valid
  `McpServerStartupState`; `mcpServerStatus/list` returns conformant
  `McpServerStatus` objects (`{ name, tools, resources, resourceTemplates,
  authStatus }`).
- Lifecycle turn envelopes carry only schema fields — internal api/cost/turn
  metrics are not serialized onto the wire (token metrics flow through
  `thread/tokenUsage/updated`).
- `turn/plan/updated` is reserved for the `update_plan`/TodoWrite checklist tool
  and ships the spec shape `{ explanation, plan: [{ step, status }] }` (status
  ∈ pending/inProgress/completed); the checklist tool is not also surfaced as a
  timeline item. Plan-mode prose stays on the separate `plan` ThreadItem +
  `item/plan/delta` channel.

## Robustness notes

- Unix socket paths are validated against the platform `sun_path` limit (~104
  macOS / ~108 Linux); a deep `CODEX_HOME` falls back to a short hashed path
  under the system temp dir.
- git diff / file-listing failures are written to the debug log (distinguishing
  "not a git repository" from real errors) rather than swallowed.
- Per-thread in-memory state (command approvals, token usage, goals, elicitation
  counts) is released when a thread is archived.

## Next targets

1. Parse Claude review text into first-class Codex review finding items.
2. Persist compaction summaries in a dedicated store, not just UI items.
3. Run the capability probe over SSH against a named host.
4. Flesh out plugin/skill/app surfaces if Codex App starts relying on them.
