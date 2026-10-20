# Changelog

All notable public-facing changes for Claude Codex Adapter are summarized here.
The project is still private in `package.json`; this file tracks release notes
for maintainers preparing the next public release and does not change package
versioning or publishing metadata.

## Unreleased

### `ws://` listener authentication

- **Breaking:** `--listen ws://` on a non-loopback address (`0.0.0.0`, `::`,
  a LAN or public IP) now refuses to start without a capability token, as
  `codex app-server` does. It used to accept any client, which put an agent
  with shell access on the network. Pass `--ws-auth capability-token`
  (`CLAUDE_CODEX_WS_AUTH=capability-token`) to require a token or, when
  something else protects the listener, opt out explicitly with
  `--ws-allow-unauthenticated` (`CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED=1`);
  the adapter then warns at startup. Loopback listeners keep working without
  a token, and the Codex App, which uses stdio or the unix socket, is not
  affected.
- **Breaking:** a `ws://` upgrade that carries an `Origin` header is refused
  (403) unless the origin is in `CLAUDE_CODEX_WS_ALLOWED_ORIGINS` /
  `--ws-allowed-origins`, on loopback too, so web pages (and DNS rebinding)
  cannot reach the listener. App-server clients outside a browser send no
  `Origin`.
- Capability-token auth (`--ws-auth capability-token`, `--ws-token-file`,
  `--ws-token-sha256`, `CLAUDE_CODEX_WS_TOKEN*`) takes the token as
  `Authorization: Bearer`, which `codex --remote-auth-token-env` sends, or as
  a `claude-codex.bearer.<token>` subprotocol from a browser. Without a token
  source the adapter creates a 0600 `ws-token` file in its home and prints
  only the path.
- `ws://[::1]:port` listens on the IPv6 loopback address (the brackets used
  to reach `listen()` and fail), and the `listening on` line shows the bound
  port, so `ws://127.0.0.1:0` is usable.
- A refused listener or another bad listener option ends the adapter with
  exit code 1 and the message alone, without a stack trace.

### App-server and protocol compatibility

- Opt-in Memories: with `CLAUDE_CODEX_MEMORIES=1`, the App's Memories
  settings (Settings > Personalization) and `/memories` decide whether Claude
  threads run with Claude Code's auto-memory, and while Memories is off in the
  App they run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Without the switch
  nothing changes: the App shows no Memories settings and Claude Code's own
  settings decide.
- `memory/reset` is refused instead of reporting success, since Claude Code's
  memory folders are shared with Claude Code outside the App and the adapter
  deletes nothing, and `memory/status` checks `minConsolidatedThreads` against
  Codex's bounds (1 to 4096).
- The model picker reads the Codex model catalog from `CODEX_HOME` instead of
  `~/.codex`, so an App with its own home lists its catalog rather than the
  built-in fallback models.
- Updated the adapter to advertise Codex app-server protocol v2 compatibility at
  the current pinned Codex CLI compatibility version, while keeping a
  `claude-codex` suffix so hosts can distinguish the adapter from upstream
  Codex.
- `plugin/read` returns the plugin's `appTemplates` the protocol requires. The
  Codex App read them unguarded, so a thread with the in-app browser open
  showed an error page instead of the conversation.
- Expanded Codex App Remote coverage across thread lifecycle, turn envelopes,
  item streaming, approvals, MCP status, fuzzy file search sessions, Claude
  skills/hooks, and `thread/turns/list` item views.
- A turn still finishing when the adapter stops (waiting on its final
  `git diff`, an approval or the runtime) no longer writes to the closed
  SQLite store, which crashed the process on the way out.
- When the adapter cannot record the turns it interrupts on shutdown (its
  database was deleted, for example), it still stops Claude and exits with
  status 1 instead of staying alive.
- A turn, review or compaction requested just before the adapter stops no
  longer starts afterwards: it launched Claude after the runtime had stopped,
  and a compaction crashed writing to the closed store.
- Added protocol fixture coverage for `config/read`, including the sanitized
  `config.provider_loop_config` shape, so the Rust fixture drift gate covers
  provider-loop config projection behavior.
- Kept compatibility-only account, plugin, marketplace, realtime, and other
  OpenAI-specific surfaces inert or schema-shaped where Claude Code has no
  equivalent.
- Writes to the state database wait out another connection's lock (5 s,
  `CLAUDE_CODEX_STATE_DB_TIMEOUT_MS`) instead of failing at once, and a turn
  whose final write still fails ends with `turn/completed` instead of staying
  in progress with an unhandled rejection.
- Goals, steer and the message queue follow the Codex App: `thread/goal/*`
  with continuation turns, token and time budgets and goal tools for Claude;
  steer errors in Codex's wording; `thread/queue/*`; and a `turn/start` that
  races a running turn joins it instead of orphaning it.
- The context gauge follows the main loop's latest API call, like Codex's
  `last_token_usage`, and tokens spent by subagents and workflows count toward
  the thread total without moving the gauge or goal progress.
- `thread/compact/start` compacts the thread's own Claude session with
  `/compact`, so the conversation goes on from Claude's summary instead of a
  summary written beside it; a thread with no session yet, or whose
  compaction fails, still gets the summary-model summary. Claude compacting
  on its own within a turn now shows as a `contextCompaction` item, and the
  context gauge drops to the compacted size either way. Only compaction and
  review turns refuse `turn/steer`, with Codex's `activeTurnNotSteerable`
  error, so a turn Claude compacted keeps taking messages.
- A turn that ends early completes the message still streaming and fails the
  tool calls still running before `turn/completed`, instead of leaving them
  in progress in the App.
- The adapter stops Claude CLI processes a previous adapter on the same state
  dir left running, matching pid, start time and command line before
  signalling (`CLAUDE_CODEX_REAP_ORPHANED_CLI=0` turns it off).
- A second adapter started on the same state dir (a startup probe, another
  window) no longer fails the turns a running adapter is still working on.
  Each turn records the process that wrote it, by pid and start time, and
  startup recovery fails only the turns of processes that are gone; turns
  written before this change are recovered as before.
- `app-server --print-startup-config` (codex 0.164) prints its one JSON line
  (`appServerVersion` and `configRequirements`) and exits, and
  `app-server daemon version` reports the unix daemon listening on the control
  socket, or fails when none is. Both answer before the state database opens;
  they used to start a full stdio server, with its startup recovery and
  cleanup, and never print their answer. The `codex` shim answers the plain
  forms itself, without starting node.
- The App's "/" popup offers Claude Code's built-in skills (`/simplify`,
  `/code-review`, …) from the list the CLI reports, and a picked one runs as
  the CLI's slash command.
- Every client request the Codex App can send now has a handler. New real
  ones: `project/*`, `thread/delete` (with its subagents), `thread/rollback`
  and `thread/revert` that also rewind Claude's session, `thread/search` and
  `thread/searchOccurrences`, item and timeline paging, `thread/attachment/*`,
  background shell listing and termination, `turn/settings/update`,
  `account/usage/read` from local history, import history, and server
  diagnostics. Remote control and passkey verification answer disabled and
  unavailable instead of failing.
- Fixed `thread/turns/list` paging and ordering, and `thread/list` /
  `thread/search` pages that skipped threads updated in the same second as the
  last one shown.
- Input sent while a turn is still starting waits up to 10 s for it instead
  of failing with `no active turn to steer`, a turn whose runtime run has
  returned is ended instead of holding the thread until Stop, and a turn the
  server failed also stops the CLI turn behind it.
- An ephemeral `thread/fork`, which the App uses to describe a thread, stays
  out of `thread/list`.
- The adapter advertises app-server `0.159.0-alpha.12.1`, the Codex build of
  Codex App 26.930, so every feature gate of that App is on.
  `CLAUDE_CODEX_COMPAT_VERSION` still overrides it, and
  `docs/reference/app-compat.md` lists what the gates change, including the
  two that also depend on the App's server-side flags.
- A `turn/start` carrying `toolOutput` instead of input (a thread handoff, or
  a message from another thread) prompts Claude with its text and images and
  records it as a `functionCallOutput` item, instead of starting a turn with
  an empty prompt.
- `thread/timeline/list` serves the newest page first and pages back, as Codex
  does, instead of starting from the oldest entries.
- `turn/settings/update` switches a running turn's model and effort in place,
  and accepts the `user` reviewer the App sends when permissions change during
  a turn, instead of failing on any change. An unknown model fails instead of
  falling back to the thread's model.
- Claude Code command hooks the adapter runs honour `onFailure: "block"`: a
  hook that cannot start, times out, exits with a code other than 0 or 2, or
  prints JSON that does not parse blocks the tool call or prompt as exit 2
  would, with a reason that names the hook and the failure, instead of letting
  it through. `continue` stays the default; async hooks and `Stop` /
  `SubagentStop` hooks ignore it, as in Claude Code.
- Claude Code's hook runs show as `hook/started` / `hook/completed` in the
  turn's hook summary, with the settings file that configures them and a
  blocked status for a hook that blocks; `hooks/list` also lists `SessionEnd`,
  `SubagentStart` and `SubagentStop` hooks.
- A switch to a fallback model after a refusal shows as `model/rerouted` for a
  cyber-safety refusal and as a warning otherwise, and a refusal with no
  fallback as a warning.
- An MCP server can ask the user for input: its elicitation becomes
  `mcpServer/elicitation/request`, a form or a link in the App, and the answer
  goes back to the server.
- `mcpServerStatus/list` honours `serverName`, and `mcpServer/resource/read`
  answers with the `originCallId` the protocol requires.
- Claude threads can show inline visualizations. New threads, forks and
  subagents get UUIDv7 ids, without which the App refuses to read a thread's
  visualizations; the `visualize` plugin the App installs is remembered, and
  its skill is listed in the desktop prompt with the `::codex-inline-vis{…}`
  line the App renders and the thread's visualization folder, which Claude may
  read without an approval prompt. Chats created before cannot render them.
- A visualization Claude names with a plain `visualize{…}` line, without the
  invisible marks the App's visualize skill puts around it, renders instead of
  showing as text: the adapter adds the marks outside code fences when the
  message completes and in history reads; streamed deltas keep the line as
  written.
- A turn its Claude session no longer holds as the current one ends when that
  session does, instead of staying in progress. The App leaves its running
  state on `turn/completed` only, so such a turn kept the thread spinning for
  the rest of the connection — with the answer already written to Claude's
  transcript — until the user interrupted it by hand.
- Codex App 26.1013 is a verified build. Its GovCloud check for a Bedrock
  account is answered "not GovCloud", so the App no longer shows the GovCloud
  modal; `thread/attachmentOwner/list` lists the threads holding a worktree,
  by thread id and with the `archived` filter; and a request the adapter has
  no case for fails with JSON-RPC `-32601` (method not found), the code the
  App treats as unsupported, instead of the generic `-32000`.
- As in Codex, a fork that is kept holds the thread attachments its parent
  held (the worktree, pull requests), so `thread/attachmentOwner/list` names
  it too and the App keeps a worktree a fork of an archived chat still holds.
- `npm run check:app-upgrade` also takes an `app.asar` or an extracted App,
  reads the protocol from a codex checkout with `--protocol-source` or skips
  it with `--bundle-only`, and lists every request the App's scripts name that
  the adapter would answer with method not found.
- `thread/fork` honours `lastTurnId` (fork through that turn) and
  `beforeTurnId` (fork before it), which the App sends to fork a chat from one
  of its turns. The fork's history stops there, and so does Claude's context:
  its first turn resumes at the newest kept turn's checkpoint, or where the
  chat began when the fork keeps no turn, so the forked chat no longer
  remembers what came after. As in Codex, the two ids together, an unknown
  turn and a `lastTurnId` that is still running are rejected. When the kept
  turns predate checkpoints, the fork keeps Claude's whole session, as before,
  and a `configWarning` says so.
- The adapter advertises app-server `0.163.0-alpha.10.2`, the Codex build of
  Codex App 26.1013, instead of `0.159.0-alpha.12.1`, so every feature gate of
  26.1013 is on as well; App 26.930 turns on the same features as before.
  Codex `0.163.0` has the same app-server protocol. `CLAUDE_CODEX_COMPAT_VERSION`
  still overrides it. The App's composer predictions, which that version turns
  on, fork only a thread whose `modelProvider` is `openai`, so they leave
  Claude threads (`claude-code`) alone.
- Every turn carries `rootTurnId`, new in that protocol: the root a
  `turn/start` names for work it starts on behalf of another turn, else the
  turn's own id. A subagent's turn takes the root of the turn that spawned it,
  and input that joins a running turn keeps that turn's root, as in Codex; a
  queued message or goal turn the adapter starts afterwards is its own root.
- CI checks the Rust protocol fixtures against `@openai/codex@0.163.0`, and
  the `turn/started` and `turn/completed` fixtures must carry exactly the
  fields of the generated `Turn`.
- With `CLAUDE_CODEX_DYNAMIC_TOOLS=1`, Claude gets the dynamic tools a client
  registers on `thread/start` (the Codex App's own tools, which it sends to
  remote hosts), one in-process MCP server per namespace. A call goes back to
  the client as `item/tool/call` and shows as a `dynamicToolCall` item; specs
  Codex refuses fail `thread/start` with its messages, and a chat keeps its
  tools across restarts, resumes and forks. Off by default, since the App's
  tools act on the desktop without an approval prompt.
- The Claude Agent SDK is 0.3.304, which bundles Claude Code 2.1.304. The
  adapter always passes a permission mode, so the CLI's changed default for
  SDK sessions without one does not reach Claude threads.
- Claude's Bash commands stream their output into the App's command item
  while they run, read about once a second through the SDK's
  `get_task_output` request: a foreground command once Claude Code makes it a
  task, about two seconds in, and a background shell after its call returned,
  also after the turn ended, followed by Claude Code's note when it was
  stopped, failed or reached its background time limit (30 minutes in Agent
  SDK sessions since Claude Code 2.1.285, or the call's own `timeout` up to 2
  hours). `CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS=0` shows the output only when
  the command finishes, as before.
- Claude's thinking shows in the Codex App. The CLI is asked for summarized
  thinking (`--thinking-display summarized`), which recent models otherwise
  redact, and it streams as the reasoning summary, the only part of a
  reasoning item the App renders (`item/reasoning/summaryPartAdded`, then
  `summaryTextDelta`). Thinking stored before as raw content reads back as
  the summary. `CLAUDE_CODEX_REASONING_VISIBLE=0` or the App's Reasoning
  summary setting set to None keeps the previous behavior.
- API retries show in the turn as Codex shows a stream retry: each
  `system/api_retry` of the main loop becomes an `error` notification with
  `willRetry` and the message `Reconnecting... n/m`, which the App folds into
  one passing row, and is not stored. Errors and failed turns carry a Codex
  `codexErrorInfo` code from the CLI's terminal reason, error category and
  HTTP status (`serverOverloaded` for a 529, `contextWindowExceeded`,
  `rateLimitExceeded`, ...), never one the App answers with a ChatGPT account
  flow. CLI notifications of high or immediate priority go out as `warning`
  notifications, which the App opts out of, as it does with Codex.
- A Claude CLI that refuses to start fails the turn with an adapter-written
  message for its `startup_failure_reason` and the reason's name as details,
  never the CLI's own output, which can hold proxy credentials. Reasons a
  retry can fix (`org_config_required_unavailable`, organization settings or
  checks that could not be reached) are `httpConnectionFailed`, which the App
  offers to retry; refused sign-ins, `provider_not_allowed`, invalid managed
  settings and local problems are `other`. The adapter sets
  `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` so every startup failure is reported
  this way unless the environment sets it.
- The adapter keeps the Claude Code version each session reports (in the
  initialize reply from 2.1.296, in `system/init` from every CLI) and leaves
  off what an older CLI cannot do: live Bash output needs 2.1.287
  (`get_task_output`), and a spawn card shows an Agent call's own `effort`
  only from 2.1.292. While the version is unknown, both stay on.
- Claude chats show their branch in the App sidebar. Threads carry Codex
  `gitInfo` (commit, branch, and the `origin` remote without credentials),
  looked up after `thread/start`, when a thread without it resumes and when a
  turn ends, and stored, so `thread/list` and `thread/read` run no git.
  `thread/metadata/update` patches it as Codex does, which the App uses after
  creating a branch, and `getConversationSummary` returns it. Threads also
  carry their `model` and `reasoningEffort`.
- The context gauge moves while a turn runs, as it does for Codex: each API
  call of the main loop sends `thread/tokenUsage/updated` as it streams, with
  that call as `last` and on top of the settled total, once a result has
  reported the context window for the thread or its model. The turn's result
  still settles the total, so nothing is counted twice.
- Notifications a client opts out of in `initialize`
  (`capabilities.optOutNotificationMethods`) are no longer sent to it. The App
  opts out of `turn/diff/updated`, so its threads also skip the whole-tree
  `git diff` after every tool call. It also opts out of `warning`,
  `thread/compacted`, `thread/closed`, `project/changed`,
  `thread/project/updated` and `command/exec/outputDelta`, which it no longer
  receives from the adapter, as from Codex.
- `config/read` reports `web_search = "live"` instead of `"disabled"`, matching
  the web search `modelProvider/capabilities/read` advertises;
  `CLAUDE_CODEX_WEBSEARCH=0` turns both off.
- Claude's file exploration folds into the App's "Explored" row, as Codex's
  does. Read, Grep, Glob and LS calls are command items named after the tool
  (`Read src/app.ts`) with Codex `read`, `search` and `listFiles` command
  actions, and a Bash command that only reads, lists or searches files gets
  its actions from a port of Codex's command parser, which unlike Codex's
  never folds a command that can write files or start other programs, such
  as `find -delete` or `| xargs rm`. The App keeps the first
  30,000 characters of their output; Claude still gets all of it. A Read of
  an image is an `imageView`, WebFetch a `webSearch` item opening the page,
  and an MCP tool names its server, split by the turn's configured server
  names. A Read, Grep, Glob or LS call Claude Code asks about asks on the
  command card, and "Allow for this session" covers the same call.
- `mcpServerStatus/list` entries carry every field of Codex's
  `McpServerStatus`: `serverInfo` and `serverCapabilities` from the server's
  `initialize` reply, `toolsError` when the server failed to start or to list
  its tools, `toolListMeta` from the first `tools/list` page, `httpOrigin` for
  HTTP servers and `pluginId` for plugin servers, each `null` when unknown.
  With a `threadId` whose Claude session is open, `runtimeStatus` is the
  state that session reports for each server; otherwise it is `null`, as
  Codex answers without a thread. The App uses these to show server names and
  logos and a tool discovery error, and to retry a plugin's servers. Lists
  asked for at once share one look at the servers; HTTP servers are spoken to
  as streamable HTTP (event-stream replies, sessions) and, like stdio ones,
  given up on after 20 seconds (`CLAUDE_CODEX_MCP_TIMEOUT_MS`). An error
  carries only the end of a server's stderr and never a url's credentials.
- Codex's `model_auto_compact_token_limit` now sets the compaction window of
  Claude threads: from the config a thread starts, resumes or forks with, or
  `config/value/write`, it reaches the Claude CLI as
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (kept within 100,000 to 1,000,000
  tokens), and `config/read` reports it instead of `null`. The user's and
  trusted projects' `config.toml` count only with
  `CLAUDE_CODEX_CODEX_AUTO_COMPACT=1`, since users set the key there for Codex
  models. Without the key nothing changes. Bridged Claude Code subagents keep
  their `autoCompactWindow` frontmatter, which used to be dropped.

### Provider and multi-agent boundaries

- `/workflows` runs turn workflows on with the CLI's `CLAUDE_CODE_WORKFLOWS`
  switch instead of `--settings`, which pinned launchers reject, and respect a
  user's `enableWorkflows: false`.
- Added the provider and multi-agent loop boundaries RFC to separate runtime
  backends, provider metadata, agent-loop fidelity, credential ownership, and
  subscription/entitlement boundaries.
- Added static provider/agent-loop descriptors with validation for allowed and
  unsupported credential source labels.
- Added sanitized provider-loop projection helpers and exposed the read-only
  `config.provider_loop_config` field through `config/read`.
- Added explicit provider/agent-loop selection for known descriptor ids and loop
  ids. Selection maps only to existing runtime backends, preserves legacy
  runtime environment overrides and `CLAUDE_CODEX_MOCK=1` precedence, filters
  raw saved selection keys from public `config/read`, and exposes sanitized
  selection metadata through `config.provider_loop_config.selection`.
- Added tests proving built-in descriptors validate cleanly, unsupported
  credential labels are not projected as allowed, and secret-like descriptor
  text is redacted from public projection results.
- Background subagents (`run_in_background` Agent calls) keep running across
  turns, as Codex App 26.930 shows them: the Claude session stays open while
  they run, a finished agent's report wakes the parent with a new turn,
  `SendMessage` resumes an agent, and the child's Stop button ends it.
- Subagents behave the way the Codex App draws them: the parent's own tools
  beside an Agent call keep their cards, interrupts stop workflows and single
  children as Codex does, `SendMessage` / `TaskStop` map to agent calls, the
  CLI 2.1.283 hand-back report and usage trailer are parsed, and a finishing
  child no longer clears its still-running siblings from the roster.
- A subagent's spawn card and thread show the effort Claude Code 2.1.292+
  runs it at when the Agent call sets one (`max` shows as `xhigh`, the top of
  the App's scale). A fork subagent, on by default in Agent SDK sessions since
  Claude Code 2.1.302, shows its parent's model and effort, since Claude
  ignores the Agent call's `model` and `effort` for it. Claude Code reads
  `CLAUDE_CODE_FORK_SUBAGENT` from the adapter's environment, so `0` there
  turns forks off; a model process profile passes it on only when its
  `inheritEnv` names it or its `env` sets it.
- An agent another agent launches hangs off that agent's child thread, one
  level deeper, with its spawn and wait cards in that agent's conversation,
  when Claude Code names the agent behind each frame (`agent_id`, newer
  Claude Code versions); without the ids every agent still hangs off the
  parent thread. An agent `SendMessage` resumes keeps its child
  thread, and the agents it launches hang off it. Task frames still arriving
  from the run a resume replaced (`run_id`) are dropped instead of being
  counted against the new run.
- Deleting a thread ends its running background agents first, so each child
  turn completes as interrupted; stopping a turn no longer wakes the thread to
  acknowledge the background agents Claude Code stopped with it; and
  `/workflows` lists the workflows Claude ran on its own.
- A turn that ends while its background agents or workflows still run no
  longer marks the chat unread in the Codex App or sends a desktop
  notification; the turn the work reports back in does. Background Bash shells
  do not count, since a dev server or watcher can run for the rest of the chat.
  `CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0` marks every finished turn unread
  again.
- The subagent watchdog (`CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS`, default 30
  minutes, now documented) waits for inactivity instead of a fixed deadline:
  a subagent's output and tool heartbeats, task progress and workflow agents
  starting or finishing all start it over. It used to fail every workflow
  that ran past 30 minutes, however busy, and interrupt the whole Claude
  session, which ended every workflow agent and unrelated background agent
  with it. When it does give up, the turn is stopped as an interrupt would
  stop it, which keeps background work earlier turns left running; while
  background agents the turn itself handed off still run, only its own stuck
  agents and workflows stop and those agents keep going.
- An interrupt while a session idles no longer leaves its earlier idle timer
  running, which could close the session (and its background agents) on the
  old deadline although they kept reporting progress.

### Rust-first protocol groundwork

- Added the Rust-first runtime boundaries RFC, keeping the TypeScript
  app-server adapter as the shipping runtime path while defining incremental
  Rust protocol, transport, store, and launcher boundaries.
- Added an experimental Rust workspace scaffold and protocol crate with
  representative Codex app-server JSON fixtures.
- Added Rust parse/reserialize tests for the covered fixtures.
- Added a pinned fixture drift check against the configured Codex CLI version
  and made it part of CI alongside `cargo test --workspace`.
- Extended fixture coverage to include config projection data without claiming a
  Rust production runtime, transport, store, or provider execution path.

### Release readiness and compliance docs

- Added open-source compliance documentation and release-readiness reference
  material for maintainers and reviewers.
- Clarified the README and documentation homepage around the TypeScript
  production path, Rust-first experimental boundaries, provider/agent-loop
  descriptor and selection boundaries, supported credential ownership models,
  unsupported subscription/session/private endpoint/bypass behavior, and release
  verification expectations.
- Documented provider selection configuration for `CLAUDE_CODEX_PROVIDER`,
  `CLAUDE_CODEX_AGENT_LOOP`, saved provider-loop config keys, precedence rules,
  and sanitized `config.provider_loop_config.selection` projection.
- Documented the current shippable baseline: TypeScript remains the production
  path; Rust pieces are opt-in protocol boundary work; provider/loop descriptors
  are read-only metadata, not runtime dispatch.
- Documented supported credential ownership models: local user-provided API
  keys, official cloud-provider credential chains, organization-managed
  gateways, and local CLI auth for same-host user-directed execution.
- Documented unsupported credential models, including personal subscription
  sharing, browser cookie/session-token reuse, private provider endpoints,
  bypass guidance, and credential redistribution.

### Validation and release gates

- Default CI runs Biome checks, TypeScript typechecking, the Node test suite,
  Rust workspace tests, and the pinned Rust protocol fixture drift gate.
- Documentation changes should run `npm run docs:build`.
- Credentialed smoke and acceptance checks remain opt-in and must use
  credentials already owned by the local user or organization on the host.
- `npm run check:app-upgrade -- --app <bundle>` checks a new Codex App build
  against `scripts/app-baseline.json`: the protocol its bundled `codex`
  generates, the feature gates on at the reported version and whether every
  method behind them has a handler, and the clientInfo names. The App
  behaviors the adapter relies on are App rules in `src/app-compat.mts`, tagged
  in the code and kept in sync by `test/app-compat.test.mts`; an App build not
  yet checked gets a config warning. See `docs/reference/app-compat.md`.

### Still experimental or not yet included

- No Rust production runtime, transport, store, provider execution path, or
  default-on Rust launcher is included.
- No executable new provider loop is included beyond the existing runtime
  backends.
- No broad runtime dispatch rewrite is included.
- No new credential collection model is included.
- No support is included for personal subscription sharing, credential pooling,
  browser cookie/session-token reuse, private provider endpoints, or provider
  bypass behavior.
- The App's dynamic tools (the worktree tools of its `threadAttachments`
  gate), MCP tool-call progress, and Claude Code plugin skills in the "/"
  popup are not included. Hook runs are shown live but not kept in history.
