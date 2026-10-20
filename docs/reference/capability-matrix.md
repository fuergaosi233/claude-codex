# Codex App Remote Capability Matrix

Codex App connects to a remote host via the normal Codex Remote SSH app-server
flow, while agent turns are routed to Claude Code. Default runtime is the Claude
Agent SDK sidecar; runtime selection is pluggable. Status legend: **Supported**,
**Experimental**, **Stub**, **Unsupported**, **N/A**.

## Core

| Area | Status | Notes |
| --- | --- | --- |
| Remote transport | Supported | SSH starts `codex app-server --listen unix://` + `proxy`; the shim reports a Codex-compatible version/user agent. |
| Thread lifecycle | Supported | start/resume/fork/archive/list/read/delete + turn listing, backed by SQLite + Claude session ids. New threads, forks and subagents get UUIDv7 ids, as Codex issues them. As in Codex, `thread/list` and `thread/search` leave a thread out until it has a turn or a preview, except in the archive, a chosen section or a subagent query, so a new chat the App started but never used stays hidden. `thread/delete` also removes the thread's subagents, ending its running background agents first; an unknown thread fails with Codex's missing-rollout text so the App's `missingRolloutRecovery` retry succeeds. |
| Rollback / revert | Supported | `thread/rollback` and `thread/revert` drop turns and make Claude forget them: the next turn resumes the newest remaining turn's checkpoint in a forked session (a fork's own start point when none remain). Turns from before checkpoints keep Claude's context. |
| History paging & search | Supported | `thread/turns/list` pages either way from a turn cursor; `thread/items/list` pages items, and `thread/timeline/list` pages turn events from the newest back, as Codex does. `thread/search` matches names, previews and visible message text; `thread/searchOccurrences` serves find-in-conversation. |
| Projects | Supported | `project/*` keeps projects and thread membership in SQLite, with `project/changed` and `thread/project/updated` notifications. |
| Normal chat | Supported | `turn/start` streams Claude text/reasoning into Codex agentMessage/reasoning items. |
| Steering / interrupt | Supported | `turn/steer` and `turn/interrupt` route to the active Claude client. A rejected steer uses Codex's error texts so the App falls back or retries, and a `turn/start` that races a running turn joins it. Input sent while a turn is still starting waits for it, and a turn whose runtime run has returned is ended instead of blocking the thread. |
| Handoffs | Supported | A `turn/start` with `toolOutput` instead of input (a thread handoff, or a message from another thread) prompts Claude with its text and images and is recorded as a `functionCallOutput` item, which the App shows as the user's message. Sent during a turn, it joins that turn. |
| Goals | Supported | `thread/goal/*` keeps the thread working with hidden continuation turns, counts tokens and time, and stops on budget, usage limits or a turn without progress. Claude gets `get_goal` / `create_goal` / `update_goal` through an in-process MCP server. |
| Message queue | Supported | `thread/queue/*` holds follow-ups during a turn and sends them in order when the thread goes idle; after an interrupt they wait for `thread/queue/start`. The App uses it from app-server `0.148.0-alpha.14` (see `CLAUDE_CODEX_COMPAT_VERSION`). |
| Token usage | Supported | SDK ResultMessage usage → TokenUsageBreakdown, pushed as `thread/tokenUsage/updated` (cumulative + last turn). The context gauge follows the main loop's latest API call; subagent and workflow tokens add to the total only. |

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
| Structured title/summary turns | Supported (fallback) | Codex internal model ids (e.g. gpt-5.4-mini) map to `CLAUDE_CODEX_SUMMARY_MODEL` (default haiku) when an outputSchema is present; falls back to schema-shaped JSON if Claude emits plain text. With `CLAUDE_CODEX_DISABLE_CODEX_PROXY=1`, the App's ephemeral title and summary threads, which name a Codex model, run on Claude as well, on `CLAUDE_CODEX_SUMMARY_MODEL` (else `CLAUDE_CODEX_TITLE_MODEL`, else haiku), instead of going to Codex. Its ephemeral description fork stays on the chat's model. |
| SDK option compatibility | Supported | When an older SDK rejects an option, the sidecar drops it one at a time (least essential first) and emits an info notice. |

## Tools, approvals & events

| Area | Status | Notes |
| --- | --- | --- |
| Claude Code tools | Supported | Not restricted by default; set `CLAUDE_CODEX_ALLOWED_TOOLS` to restrict. |
| Approval policy / sandbox | Supported | App's approvalPolicy + sandbox persist on the thread and map to Claude permission_mode. "Full access" drops the can_use_tool callback; read-only restricts tools to read/search. |
| Bash approval | Supported | can_use_tool → Codex `item/commandExecution/requestApproval`. Bypassed when approvalPolicy=never / Full access. |
| File edit approval | Supported | Edit/Write/MultiEdit → Codex fileChange items with approval + diff updates. |
| Bash output | Supported | Streams into the command item while it runs, read about once a second through the SDK's `get_task_output` request: a foreground command from about two seconds in, once the CLI makes it a task, and a background shell after its call returned, also after the turn ended, followed by how it ended when it did not complete (such as its background time limit). Output that came and went between two reads shows as `[earlier output skipped]`; a call two tasks claim streams nothing. The finished item shows the tool result. Without `get_task_output` (older SDKs) or with `CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS=0`, output arrives with the result. |
| Generic Claude tools | Supported | Non-command/file tools → mcpToolCall items under the `claude-code` pseudo server. |
| Subagent (Task) | Supported | Task spawns an ephemeral child thread and emits native `subAgentActivity` lifecycle events (capability-gated `completed`) plus `spawnAgent`/`wait` tool state; inner events are hidden, and the final result lands as one agentMessage on the child thread. The spawn card shows the model and effort the agent runs on: the Agent call's own `model` and `effort` (Claude's `max` shows as `xhigh`), else the parent's; a fork (`subagent_type: "fork"`) always shows the parent's, as Claude ignores both for it. |
| Background subagents | Supported | `run_in_background` agents keep running across turns: the Claude session stays open while they run, a finished agent's report wakes the parent with a new turn, `SendMessage` resumes an agent, and the child's Stop button ends it. A turn that ends while background agents or workflows still run does not mark the chat unread; the turn the report wakes does. Background Bash shells do not count (`CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0` turns this off). |
| Subagent control | Supported | Interrupting a turn stops the workflows it launched (Claude Code also stops the background agents it launched, and they wake no turn); stopping a foreground child from its own thread ends just that child, as interrupted. `SendMessage` and `TaskStop` on any child agent render as Codex `sendInput` / `closeAgent` calls, and the parent's own tools and text beside an Agent call keep their cards. `/workflows` also lists the workflows Claude ran on its own. |
| Ephemeral / threadSource | Supported | `ephemeral: true` threads (title-gen, memory-consolidation, subagents, and the forks the App describes a thread in) persist but are excluded from `thread/list` unless `includeEphemeral: true`. `threadSource` round-trips. |
| Claude side events | Supported | rate_limit / subagent / compaction events summarized into structured notice lines. A switch to a fallback model after a refusal is reported as `model/rerouted` when Claude names a cyber-safety refusal and as a `warning` otherwise; a refusal with no fallback is a `warning`. Text Claude streamed before a fallback stays in the transcript. |
| Hook runs | Supported | Claude Code's hook runs → `hook/started` / `hook/completed` with the Codex event name, the settings file that configures the event, and its outcome: exit code 2, a `block` decision or `continue: false` is `blocked`, with the reason as an entry. The App folds them into the turn's hook summary. Live only: history does not keep them. |
| MCP elicitation | Supported | An MCP server asking the user for input → `mcpServer/elicitation/request`, as a form from its schema or a link to open; the App's accept, decline or cancel goes back to the server. A request outside a turn (from background work) is declined. |
| Review mode | Supported (text) | `review/start` creates an in-progress review turn and routes the prompt through Claude. No native guardian finding items. |
| Context compaction | Supported (summary) | `thread/compact/start` routes the summary prompt and emits contextCompaction items. No native persisted rollout compaction. |

## Utilities

| Area | Status | Notes |
| --- | --- | --- |
| MCP config/status/tools | Supported | Reads Claude MCP config, passes servers into turns, calls stdio/HTTP tools directly. `mcpServerStatus/list` enumerates real `tools`/`resources`/`resourceTemplates` per server (10s cache, graceful empty fallback on spawn/timeout), or one server's with `serverName`. `mcpServer/resource/read` answers `originCallId: null`: no hosted app scopes the read. |
| Turn-item paging | Supported | `thread/turns/list` honors `itemsView` — `summary` (default: first userMessage + final agentMessage), `full`, and `notLoaded` — instead of always shipping every item. |
| Inline visualizations | Supported | The App's bundled `visualize` skill, remembered from `plugin/install`, is listed in the desktop prompt of threads with a UUIDv7 id, with the `::codex-inline-vis{path="…"}` line the App renders and the thread's visualization folder; Claude reads the skill and that folder without an approval prompt. A plain `visualize{…}` line written without the App's invisible marks gets them when the message completes and in history reads. Threads created before the adapter issued UUIDv7 ids cannot render them. See [Using the Codex App](/guide/gui#inline-visualizations). |
| Skills & hooks | Supported | `skills/list` reads `.claude/skills/*/SKILL.md` (user+repo scope) and offers the CLI's built-in skills (`/simplify`, `/code-review`, …) as system skills that run as slash commands; `hooks/list` reads `settings.json` hooks, mapping Claude events to Codex `HookEventName` (unmappable events dropped). |
| Fuzzy file search | Supported | One-shot `fuzzyFileSearch` plus the stateful session API (`sessionStart/Update/Stop`) that streams `fuzzyFileSearch/sessionUpdated` results and a final `sessionCompleted`. |
| Filesystem RPCs | Supported | `fs/readFile`, write, metadata, list, remove, copy, watch/unwatch (Codex v2-shaped). |
| Command/process RPCs | Supported | `command/exec` and `process/spawn` implemented. |
| Background terminals | Supported | Claude's background Bash shells are listed by `thread/backgroundTerminals/list` and stopped by `terminate`/`clean`, and their output keeps streaming into the item of the Bash call that started them. The CLI runs them, so there is no OS pid or usage. Claude Code 2.1.285+ stops them after 30 minutes in Agent SDK sessions, or after the call's own `timeout` up to 2 hours. |
| Thread attachments | Supported | `thread/attachment/*` keeps the App's per-thread JSON (archived worktree, linked pull requests). |
| Running-turn settings | Supported | `turn/settings/update` switches the running turn's model and effort in place; the next turn runs on its own settings again. A model must be one `model/list` offers for the thread's backend. The reviewer is always the user, so only `approvalsReviewer: "user"` is accepted, and `summary` and `serviceTier` have no Claude counterpart. The verified App sends only the reviewer, when permissions change during a turn. |

## Not applicable / unsupported

| Area | Status | Notes |
| --- | --- | --- |
| Realtime audio | Unsupported | No Claude audio channel; methods ack so capability probe doesn't error; listVoices returns empty. |
| Plugins/marketplace/apps | N/A | No Codex plugin marketplace; methods return empty schema-shaped responses. `plugin/install` of the App's bundled `visualize` plugin is remembered for inline visualizations, and `plugin/uninstall` forgets it. (Claude skills/hooks are surfaced — see Utilities.) |
| Account/rate limits/auth | N/A | Claude manages its own auth; account/OpenAI-auth panels report null/empty. `account/usage/read` reports the longest turn and day streaks from local history, with token counts `null`. |
| Remote control / passkeys | Unsupported | `remoteControl/*` reports a disabled installation; `userVerification/*` reports the provider unavailable, with the error data the App reads. |
| External agent import | Stub | `externalAgentConfig/detect` and import return empty; the import histories the App records are kept and listed. |
| Windows sandbox | Unsupported | Target deployment is Linux/macOS; methods return not configured. |
| Dynamic tools | Unsupported | `dynamicTools` on `thread/start` (the App's worktree tools, with its `threadAttachments` gate on) are not offered to Claude. See [Codex App compatibility](/reference/app-compat#what-the-gates-change). |
| MCP tool progress | Unsupported | The SDK reports no progress for an MCP call, so `item/mcpToolCall/progress` is never sent; the call's card shows its result when it ends. |
| Plugin skills | Unsupported | `skills/list` lists the user's, the repository's and the CLI's built-in skills, not those of Claude Code plugins. |

## Protocol version

The adapter advertises codex app-server protocol **v2 @ 0.159.0-alpha.12.1**
(via `codex --version` and the `initialize` userAgent; override with
`CLAUDE_CODEX_COMPAT_VERSION`), the Codex build of the verified App. The App
turns its feature gates on by this version, so every gate that build knows is
on; [Codex App compatibility](/reference/app-compat#feature-gates-and-claude-codex-compat-version)
lists what they change. Every client request Codex App 26.930 can send has a
handler; where Claude Code has no equivalent it answers with an empty,
disabled or `unavailable` result rather than an error. Regenerate the
reference schema under `generated/` with `npm run generate:schema` (needs a
matching `codex` on PATH).

Because the adapter reports the same version as a real `codex`, it appends a
distinguishing suffix: `codex --version` prints `codex-cli 0.159.0-alpha.12.1
(claude-codex)` and the `initialize` userAgent carries `claude-codex` in its
originator field. The version number stays first so the App's semver probe still
parses it. Set `CLAUDE_CODEX_VERSION_SUFFIX=""` to behave exactly like upstream
codex.

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
- A turn that ends early (interrupt, failure, subagent watchdog) completes
  what Claude was still streaming as commentary and fails the tool calls still
  running, before `turn/completed`, so no card keeps spinning in a stopped
  turn.

## Robustness notes

- Unix socket paths are validated against the platform `sun_path` limit (~104
  macOS / ~108 Linux); a deep `CODEX_HOME` falls back to a short hashed path
  under the system temp dir.
- git diff / file-listing failures are written to the debug log (distinguishing
  "not a git repository" from real errors) rather than swallowed.
- Per-thread in-memory state (command approvals, token usage, goals, elicitation
  counts) is released when a thread is archived.
- A Claude CLI that outlives its adapter (killed, or slow to exit after
  SIGTERM) is stopped by the next adapter on the same state dir before it
  serves, so it cannot keep appending to a transcript about to be resumed.
  Only processes whose pid, start time and command line match the record are
  signalled.

## Next targets

1. Parse Claude review text into first-class Codex review finding items.
2. Persist compaction summaries in a dedicated store, not just UI items.
3. Run the capability probe over SSH against a named host.
4. Flesh out plugin/skill/app surfaces if Codex App starts relying on them.
