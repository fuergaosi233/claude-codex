// What the adapter assumes about the Codex desktop App beyond the app-server
// protocol schema. The schema says which messages exist; these rules say how
// the App reacts to them, as read from its bundle. An App release can change
// any of them without touching the protocol, so each one is tagged
// `App rule: <id>` where the adapter depends on it, and a new App build is
// checked against the list (`npm run check:app-upgrade`) before its version
// joins VERIFIED_APP_VERSIONS. See docs/reference/app-compat.md.

export interface AppRule {
  readonly id: string
  // What the App does.
  readonly app: string
  // What the adapter does because of it.
  readonly adapter: string
  // How to tell it still holds on a new App build.
  readonly verify: string
}

// App builds every rule below was checked against.
export const VERIFIED_APP_VERSIONS: readonly string[] = ['26.930.21537', '26.1013.40934']

// initialize.clientInfo.name of the desktop App. Its other app-server clients
// (the LaTeX preview, for one) use their own names and versions.
export const DESKTOP_CLIENT_NAME = 'codex_desktop'

export const APP_RULES: readonly AppRule[] = [
  {
    id: 'client-info',
    app: `Identifies itself in initialize as clientInfo.name "${DESKTOP_CLIENT_NAME}" with its build as the version.`,
    adapter:
      'Checks that version against VERIFIED_APP_VERSIONS and gates the completed subagent kind on it.',
    verify: 'check:app-upgrade finds the clientInfo name in the bundle.',
  },
  {
    id: 'feature-gates',
    app: 'Turns features on by the app-server version in the initialize userAgent (the server-side message queue needs 0.148.0-alpha.14) and rejects a version below its minimum.',
    adapter:
      'Reports codexCompatVersion() there; CLAUDE_CODEX_COMPAT_VERSION picks which gated features the App uses.',
    verify:
      'check:app-upgrade lists the gate table and the minimum next to the version the adapter reports.',
  },
  {
    id: 'prediction-provider',
    app: 'From 26.1013, with experimentalPredictionForkMode on, predicts the next composer message in a thread/fork with experimentalPredictionMode, only for a thread whose modelProvider is openai.',
    adapter:
      'Reports modelProvider claude-code for every thread, so the App never forks a Claude thread for a prediction.',
    verify:
      'In the bundle, the prediction path still gives up with unsupported_provider before its thread/fork when modelProvider is not openai.',
  },
  {
    id: 'daemon-version',
    app: 'With CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 on a local host, runs `codex app-server daemon version` (2.5 s timeout) before connecting. When it prints JSON whose appServerVersion is at least 0.141.0, the App talks to the server on <CODEX_HOME>/app-server-control/app-server-control.sock instead of starting one over stdio; when it fails, the App starts its own.',
    adapter:
      'Answers the probe without opening the state database: the compat version when a server accepts connections on that socket (the unix daemon listens there by default), a failure otherwise.',
    verify:
      'Find `daemon`,`version` in the network-startup chunk of the bundle and check the socket path and the version check next to it.',
  },
  {
    id: 'config-warnings',
    app: 'Lists configWarning notifications under Settings > Agent > Configuration, keeping the last 20 per host.',
    adapter:
      "Reports an App build missing from VERIFIED_APP_VERSIONS there, and a fork from one of a chat's turns whose Claude context keeps the later turns because they predate checkpoints.",
    verify:
      'Connect an App build that is not listed and look for the warning in that settings page.',
  },
  {
    id: 'bedrock-account',
    app: 'Filters the model picker through its OpenAI model allowlist unless account/read returns a Bedrock-shaped account.',
    adapter: 'Answers account/read with an amazonBedrock account.',
    verify: 'The model picker still lists the Claude models.',
  },
  {
    id: 'model-efforts',
    app: 'Offers each model the model/list efforts that are also enabled under Settings > Agent > Model features > Available reasoning efforts. Max is off there by default and listed once a model offers it. When a model does not list the current effort, its defaultReasoningEffort takes over; a model listing none gets "none".',
    adapter:
      "Lists each Claude model's efforts as Claude Code reports them (max where the model takes it, none on Haiku), and low to xhigh until Claude Code has reported.",
    verify:
      'After a Claude turn, Model features lists Max; with it on, Claude Opus offers Max and Claude Haiku offers no effort levels.',
  },
  {
    id: 'bedrock-govcloud',
    app: 'From 26.1013, checks a Bedrock account with account/bedrock/checkGovCloudRequirements at startup and shows an "AWS GovCloud guidance" modal until the user acknowledges it, unless the answer has isGovCloud false. An error leaves the check unverified, which shows the modal too.',
    adapter: 'Answers isGovCloud false and shouldWarn false.',
    verify:
      'Start an App that never acknowledged the guidance: no "AWS GovCloud guidance" modal appears.',
  },
  {
    id: 'bedrock-auth-status',
    app: 'Publishes its feature flags under the auth method it derives from account/read (amazonBedrock for a Bedrock account), and its main process only reads flags published under the authMethod getAuthStatus returns. Without a match it keeps retrying a thread it resumes on its own, so a message queued while a turn ran is never sent and new chats get no title.',
    adapter:
      'Answers getAuthStatus with authMethod amazonBedrock, which matches the account/read answer.',
    verify:
      'Queue a message while a turn runs: it is sent when the turn ends, and a new chat gets a title.',
  },
  {
    id: 'skills-popup',
    app: 'Fills the Skills group of the "/" popup from skills/list, refetches it on skills/changed, and sends a picked skill as a [$name](path) link inside the prompt text.',
    adapter:
      "Lists the commands Claude Code reports as skills: its built-in skills, and per folder the user's, the project's, plugins' and MCP servers' commands. Turns the first such link back into `/name args`, and sends a message that starts with a command with that text as its last block, after the message's context and images, since Claude Code runs a command only from there.",
    verify:
      'Type "/" in the composer: /simplify is listed, and so is a command from .claude/commands once a chat in that folder has run a turn; picking either runs it, in a side chat and with an image attached too.',
  },
  {
    id: 'optimistic-user-message',
    app: 'Draws its own user message for every turn/start it sends.',
    adapter:
      "Publishes the userMessage item for turns it starts itself (from the server-side queue, or for the leader tools), and to a thread's other followers, which did not send the message.",
    verify:
      'A sent message shows once; a queued one shows when it starts; a second window open on the chat shows it too.',
  },
  {
    id: 'server-started-threads',
    app: "Adds a thread it did not start to the sidebar as soon as thread/started announces it on its connection, and follows that thread's turns live from then on.",
    adapter:
      "Announces a chat the leader tools start with thread/started on the leader's connection before the chat's first turn starts.",
    verify:
      'With CLAUDE_CODEX_LEADER_TOOLS=1, ask Claude to start a chat with thread_start: it shows in the sidebar, and its first message and answer stream in when opened.',
  },
  {
    id: 'added-thread-titles',
    app: "Titles a thread that thread/started adds to the sidebar from the announcement alone: it shows the thread's name if it has one; otherwise it generates a title from the thread's preview, as it does for a chat started in the composer, and saves it with thread/name/set. A thread announced with neither stays untitled. It drops a generated title when the thread's title changed meanwhile.",
    adapter:
      'Announces a chat the leader tools start with its first message as the preview, and the title given to thread_start, if any, as its name.',
    verify:
      'With CLAUDE_CODEX_LEADER_TOOLS=1, ask Claude to start a chat with thread_start without a title: the sidebar shows a generated title for it, not its first words; with a title, the sidebar shows that title.',
  },
  {
    id: 'created-thread-card',
    app: 'Shows a card for a chat from a `::created-thread{threadId="…"}` line of its own in a reply, which its instructions for its own thread tools ask for after create_thread, and refreshes the card\'s status with thread/read (includeTurns false) and thread/turns/list (limit 1). It reads the line from a completed reply.',
    adapter:
      "Ends a successful thread_start result with that line for the new chat; the tool's description asks Claude to put the line in its final response.",
    verify:
      'With CLAUDE_CODEX_LEADER_TOOLS=1, ask Claude to start a chat: its reply shows a card for the new chat, and the card follows that chat while its first turn runs and ends.',
  },
  {
    id: 'tool-output-turns',
    app: "With the turnToolOutput gate on, sends a thread handoff or a message from another thread as turn/start with empty input and the text in toolOutput (also while a turn runs), and shows a functionCallOutput item as that turn's user message.",
    adapter:
      'Prompts Claude with the toolOutput text and images, and records it as a functionCallOutput item.',
    verify: 'Hand a chat off to a new thread: the handoff text shows and Claude answers it.',
  },
  {
    id: 'continue-turns',
    app: 'Offers Continue on a chat whose last turn did not finish, and sends it as turn/start with empty input.',
    adapter:
      "Prompts Claude to pick up where it left off, with the unfinished turn's user message when it has one.",
    verify:
      'Restart the adapter during a turn, press Continue: Claude answers the message sent in it.',
  },
  {
    id: 'steer-errors',
    app: 'Matches turn/steer error texts: "no active turn to steer" makes it send the message as a new turn, and "expected active turn id `X` but found `Y`" makes it retry against Y.',
    adapter: 'Fails turn/steer with exactly these texts.',
    verify: 'Both texts are still in the bundle; a message sent as a turn ends still arrives.',
  },
  {
    id: 'steer-bubble',
    app: 'Settles its pending steering bubble into the transcript when a userMessage item carries the clientUserMessageId of that turn/steer as clientId.',
    adapter: 'Publishes the steered message with that id once Claude takes it in.',
    verify: 'Steer a running turn: the bubble becomes a transcript message, shown once.',
  },
  {
    id: 'subagent-completed-kind',
    app: 'From 26.930 renders the completed subAgentActivity kind without declaring it in initialize; 26.818 rejects it.',
    adapter: 'Sends the completed kind only to clients that declare it or report 26.930 or later.',
    verify: 'A finished subagent shows as done, both in the parent transcript and in the panel.',
  },
  {
    id: 'subagent-close-hides',
    app: 'Removes a child from the subagent panel when closeAgent follows its successful wait.',
    adapter: 'Sends closeAgent only for failed children of clients without the completed kind.',
    verify: 'A finished subagent stays in the panel.',
  },
  {
    id: 'completed-wait',
    app: 'Marks every working agent of the thread done when a wait completes, and never draws the wait itself.',
    adapter:
      "Closes a wait as failed while another agent of the thread still runs, or once Claude backgrounds the agent; the child's own state carries its outcome.",
    verify: 'Run two agents in parallel: the first to finish does not mark the second done.',
  },
  {
    id: 'agent-states',
    app: 'Shows agentState interrupted as done and errored as failed.',
    adapter: 'Marks a stopped agent interrupted and one that ended without a result errored.',
    verify: 'Stop a running subagent; it shows as done, not failed.',
  },
  {
    id: 'subagent-failure-reason',
    app: "Shows a failed turn's error.message as an error row at the end of that turn, unless the turn holds an `error` item that will not be retried; it shows nothing for an interrupted turn's error. A spawnAgent or sendInput row adds the agent's agentsStates message after its status; a wait is never drawn and a closeAgent row shows no state.",
    adapter:
      "Ends a child that failed, was stopped or was ended with its parent with a turn error saying why: the CLI's error text without its tags, usage trailer or stack frames, a JSON error body told by its message, or what ended it. The same reason is the agent's agentsStates message on its wait and closeAgent items. A parent turn that fails after agents of its own failed adds how many and the first one's reason to its error.",
    verify:
      "Have a subagent fail (a workflow agent that stalls, or one whose tool call errors): its thread ends with an error row naming the cause, without stack frames, and the parent's failed turn says a subagent failed and why.",
  },
  {
    id: 'subagent-read',
    app: 'Reads a child for the subagent panel with thread/read includeTurns:false, and shows a child without turns as still loading.',
    adapter: 'Returns the turns of a subagent thread even when they are not asked for.',
    verify: 'Open a finished subagent from the panel: its prompt and response render.',
  },
  {
    id: 'child-prompt',
    app: 'Creates the child conversation from thread/started with an empty turn and takes its history as loaded while the child runs.',
    adapter: "Replays the child's prompt as an item lifecycle.",
    verify: 'Open a running subagent before it answers: its prompt shows.',
  },
  {
    id: 'subagent-titles',
    app: "Titles a subagent thread from its thread/started announcement: it shows the thread's name if it has one; otherwise it generates a title from the spawnAgent prompt of the parent (or the thread's preview) with a model turn of its own and saves it with thread/name/set. The agent's row in the parent is named by agentNickname, not by the title.",
    adapter:
      "Names every subagent thread when it announces it, and keeps the name: the Agent tool's description, a workflow agent's label (or the first line of its task, not the harness header in front of it), else the agent's type and the first line of its prompt, with whitespace collapsed and at most 120 characters.",
    verify:
      'Run a subagent and a workflow: their threads show the description or label at once, and the App sends no title turn for them.',
  },
  {
    id: 'nested-subagent',
    app: "Finds a child through the spawnAgent item of the conversation the child names as its parent (parentThreadId), and nests the child under that conversation's subagents.",
    adapter:
      "Gives an agent another agent launched that agent's child thread as its parent, and puts its spawn, wait and activity items in that child's turn.",
    verify:
      "Have a subagent launch a subagent of its own: the inner one opens from the outer one's conversation and shows at depth 2.",
  },
  {
    id: 'rate-limit-banner',
    app: 'Shows a rate-limit banner for every account/rateLimits/updated notification.',
    adapter: 'Sends none per turn; account/rateLimits/read answers the snapshot.',
    verify: 'No rate-limit banner appears after an ordinary reply.',
  },
  {
    id: 'projects',
    app: 'With the projects gate on, holds every project write until project/list answers, imports its local projects keyed by their ids (ignoring "idempotency key refers to deleted project: <id>"), and treats "project not found: <id>" as a missing project.',
    adapter:
      'Keeps projects and thread membership in its state database and fails with exactly these texts.',
    verify:
      'Create a project in the sidebar, move a chat into it, and restart the App: both persist.',
  },
  {
    id: 'delete-missing-rollout',
    app: 'Deleting archived chats retries thread/delete with missingRolloutRecovery when it fails with "no rollout found for thread id <id>", and stops at any other error.',
    adapter:
      'Fails thread/delete of a thread it does not know with that text and takes the retry as done.',
    verify: 'Delete all archived chats in Settings: the list empties without an error.',
  },
  {
    id: 'inline-visualizations',
    app: 'Renders an HTML fragment inside a reply from a `::codex-inline-vis{path="…"}` line of its own. It takes the date in the thread\'s visualization folder, <CODEX_HOME>/visualizations/<YYYY/MM/DD>/<thread id>, from the thread id and refuses the read for an id that is not a UUIDv7. It reads only a file named like `^[a-z0-9]+(-[a-z0-9]+)*\\.html$`, at an absolute path inside that folder, the thread\'s workspace or writable roots, or /tmp where the sandbox allows it, of at most 5e6 bytes. It installs its bundled plugins, visualize among them, with plugin/install each time it starts.',
    adapter:
      "Issues UUIDv7 ids for new threads, forks and subagents. Remembers the visualize plugin from plugin/install, and lists its skill, the directive and the thread's folder in the desktop prompt of a thread with a UUIDv7 id. Lets Claude read inside the skill's folder and the thread's folder without asking.",
    verify:
      'In a new chat, ask for a small chart: Claude reads the visualize skill without an approval prompt, and the chart renders inside the reply.',
  },
  {
    id: 'visualize-line',
    app: 'Renders an inline visualization from a line holding `visualize` and its JSON wrapped in the private-use marks its visualize skill documents, and shows the same line without the marks as text.',
    adapter:
      "Adds the marks to such an unmarked line outside code fences when an agent message completes and the line's JSON names a path: in its item/completed and the stored item, never in a delta, and in history reads of replies stored before. The App checks the rest of the JSON itself.",
    verify:
      'Have a reply name a visualization as a plain visualize{…} line: it shows rendered once the message completes, and again after the chat is reopened.',
  },
  {
    id: 'code-review-plugin-server',
    app: "Starts a local app-server with -c plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true and CODEX_MCP_NODE_PATH set to its bundled Node, installs the code-review plugin with plugin/install, and drives its Pull Requests panel, PR search, PR view and code-review settings through mcpServer/tool/call (server code-review, pull_requests.* tools, _meta with the thread id), mcpServer/resource/read (ui://pull-requests/*) and mcpServerStatus/list, which counts the server as started when serverInfo is set and finds the panel entry points in the tools' _meta (ui.resourceUri, openai/ui entrypoints).",
    adapter:
      "With CLAUDE_CODEX_APP_PLUGIN_MCP=1, remembers the plugins plugin/install names, reads the -c settings and the Codex config's [plugins] tables, and runs the code-review plugin's .mcp.json server as one long-lived process in the plugin's folder, with Codex's default variables and the ones the entry lists, credentials left out. Lists it with pluginId, serverInfo, runtimeStatus and its tools as the server lists them, _meta included, and sets the thread id in a call's _meta as Codex does. Refuses to start an app-server from inside a plugin server.",
    verify:
      'With the switch on and gh signed in, open the Pull Requests panel: it lists pull requests and a PR opens; mcpServerStatus/list shows code-review connected.',
  },
  {
    id: 'quiet-turn-heartbeat',
    app: "On turn/completed reads the turn's last agentMessage, and when it ends with a <heartbeat> block deciding DONT_NOTIFY neither marks the thread unread nor sends a desktop notification. Shows a completed message without the block, and a streaming one raw.",
    adapter:
      'Appends that block to the last agentMessage of a turn that ends while background agents or workflows of the thread still run, in its item/completed and never in a delta, and strips it from anything that becomes a prompt. Background Bash shells do not count: one can run for the rest of the chat. CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0 turns it off.',
    verify:
      'Ask for a background agent, then switch to another chat: the launching turn ends without an unread dot or heartbeat text, and the turn the agent reports back in lights the dot.',
  },
  {
    id: 'helper-thread-model',
    app: 'Generates chat titles, descriptions and turn summaries in ephemeral helper threads (threadSource thread_title, thread_description, thread_summary) on its own OpenAI model, the ephemeralGenerationModel of its statsig config, and allows the server to fall back to another model. A title starts a thread and a description forks the chat; its turn/start carries model null and an outputSchema its zod schemas declare as JSON Schema draft 2020-12, and the JSON in the last agentMessage counts once turn/completed reports completed within 30 seconds. When title generation fails, the chat keeps its first words as its title.',
    adapter:
      'With CLAUDE_CODEX_DISABLE_CODEX_PROXY=1 and no Codex proxy selected, starts a helper thread that names a Codex model on the Claude summary model (the summary profile when model process profiles are configured) instead of the Codex backend, maps a Codex model on its turns the same way, and keeps an ephemeral fork of a Claude chat on the chat model. A chat on a model process profile keeps that fork, and its summary turns, on its profile whether or not Codex routing is on. Refuses any other thread/start that names a Codex model, since the picker offers none. Drops the draft declaration of an outputSchema, which the Claude CLI refuses.',
    verify:
      'With Codex routing off, send the first message of a new chat: the chat gets a generated title, not its first words.',
  },
  {
    id: 'model-menu-settings',
    app: 'Applies a model picked from the menu of an open chat it has resumed with thread/settings/update (model, effort and multiAgentMode); in a new chat the pick only rides on the first turn/start. When the request fails it shows a “Couldn’t update model settings” toast and puts the menu back; only for code -32600 the toast adds “Check your config.toml.” with the error message and an Open config.toml button. Only code -32601, or a message saying method not found, or unknown method or unknown variant next to the method name, counts as the server lacking the method.',
    adapter:
      "Refuses a model on the other backend from the chat's (a Codex model in a Claude chat, or a Claude model in a Codex chat unless the Codex proxy carries every thread) once the chat has a conversation, with an invalid-request error (-32600) raised before anything changes, so the toast gives the reason, the menu goes back and the chat keeps its model. With model process profiles configured, a Claude chat with a conversation refuses another profile the same way, and a chat its profile can no longer run (the profile changed or went away, or the chat predates profiles) refuses any model. The chat's current model sent along with other settings is no change.",
    verify:
      'With Codex models in the menu, pick one in a Claude chat that has a reply: a toast says the model settings could not be updated, with the reason, and the menu shows the Claude model again; another Claude model still applies.',
  },
  {
    id: 'reasoning-summary',
    app: 'Shows a reasoning item only through its summary parts: one part as it is, several with the first in bold as a title, and an item with an empty summary not at all. Fills the parts from item/reasoning/summaryTextDelta by summaryIndex, and keeps the raw content of item/reasoning/textDelta without rendering it.',
    adapter:
      'Asks the Claude CLI for summarized thinking (--thinking-display summarized) on a chat\'s own turns and streams each thinking run into one summary part; history reads show content-only items stored before as their summary. CLAUDE_CODEX_REASONING_VISIBLE=0 or model_reasoning_summary = "none" keeps the thinking in content only.',
    verify:
      'Ask a question Claude thinks about: its thinking shows above the reply while it streams and after the chat is reopened.',
  },
  {
    id: 'reconnecting-errors',
    app: 'Shows an `error` notification with willRetry as a passing stream-error row in the turn that replaces the one before it, and reads the attempt count only from a message of the form "Reconnecting... n/m"; any other message shows as it is.',
    adapter:
      'Turns each retry the Claude CLI reports for a chat\'s main loop (system/api_retry) into an `error` with willRetry, the message "Reconnecting... n/m" and the HTTP status and wait in additionalDetails, and does not store it, as Codex does not. A retry inside a subagent (one with a parent_tool_use_id) shows the same way in that subagent\'s thread while its turn runs, and never in the parent; retries in a structured-output helper turn show nothing.',
    verify:
      'Point the adapter at an API that answers 529 for a while: the turn shows "Reconnecting 1/10", counting up, and then the reply; a subagent running then shows its own retries in its thread.',
  },
  {
    id: 'error-codes',
    app: 'Reads codexErrorInfo on `error` notifications and failed turns: serverOverloaded shows "Server is busy" and may offer a retry, usageLimitExceeded opens a ChatGPT plan upgrade card, cyberPolicy a safety notice, and unauthorized is only counted.',
    adapter:
      "Gives every error a code from what the Claude CLI reported: contextWindowExceeded, serverOverloaded, rateLimitExceeded, badRequest, internalServerError, httpConnectionFailed, responseStreamDisconnected with the HTTP status for a retry, and other for the rest. It never sends usageLimitExceeded or cyberPolicy, and an authentication failure stays other. A CLI that refused to start is httpConnectionFailed when a retry can fix the reason it gave and other when it cannot, with a message the adapter writes and never the CLI's own output.",
    verify:
      'Let the API stay overloaded until Claude gives up: the failed turn says the server is busy instead of showing a bare error.',
  },
  {
    id: 'thread-git-info',
    app: "Shows a thread's gitInfo.branch in the sidebar and uses originUrl for the repository name and pull request flows. When thread/start answers with gitInfo null it looks the workspace up itself; a thread/list refresh keeps what it knows when a row has none, but thread/resume replaces it with the answer's gitInfo. After creating a branch for a thread it sends thread/metadata/update with gitInfo.branch.",
    adapter:
      "Stores gitInfo on the thread: looked up after thread/start, on a resume of a thread without it, and when a turn ends, so thread/list and thread/read never run git. thread/start answers with null as Codex does, and thread/metadata/update patches gitInfo with Codex's rules.",
    verify:
      'Start a chat in a git repository on a feature branch and send a message: after an App restart the sidebar still shows the branch, and it follows a branch Claude switches to once the turn ends.',
  },
  {
    id: 'context-gauge',
    app: "Fills the composer's context gauge from the thread's latest thread/tokenUsage/updated, as last.totalTokens over modelContextWindow, and hides it when either is null.",
    adapter:
      "Reports each main-loop API call as it streams, with that call as last and on top of the settled total, once a result has reported the window for the thread or its model; the turn's result then settles the total. A subagent's tokens add to the total and leave last alone.",
    verify:
      'Ask for a task with many tool calls in a chat that has finished a turn: the context gauge moves while Claude works instead of jumping when the turn ends.',
  },
  {
    id: 'collaboration-modes',
    app: "Enables /plan and the composer's Plan toggle only when collaborationMode/list returns a preset with mode plan, and keeps only the plan and default presets. Sends the chosen mode as collaborationMode through thread/settings/update and on turn/start, where it sets the top-level model and effort to null and puts the picker's model and effort in collaborationMode.settings. Adopts the collaborationMode of thread/settings/updated and of the thread/resume response as the composer's mode.",
    adapter:
      "Lists a Plan and a Default preset without a model or effort, takes a turn's model and effort from collaborationMode.settings, keeps the mode per thread for turns that name none, also across a restart, and reports the thread's real mode in thread/settings/updated and thread/resume. A fork starts in Default, as a Codex fork does; the App sends the mode it shows for the fork on the fork's turns.",
    verify:
      'In a Claude chat, /plan is enabled; turn the Plan toggle on and send a message: the toggle stays on and the model picker keeps its choice.',
  },
  {
    id: 'plan-implementation',
    app: 'When a turn completes, takes the text of its last plan item and asks "Implement this plan?"; accepting switches the composer to the default mode and sends the plan back as a new turn.',
    adapter:
      'In plan mode turns the plan Claude hands to ExitPlanMode into one plan item (started, one delta, completed) and refuses the tool call without an interrupt, so the turn completes; what Claude writes around it stays agent messages.',
    verify:
      'Ask for a plan in Plan mode: one plan card shows, "Implement this plan?" follows, and accepting runs the plan outside plan mode.',
  },
  {
    id: 'skill-injection',
    app: 'Sends a skill picked in the composer as a [$name](path) link to its SKILL.md inside the prompt text, and a skill picked from a plugin or setup card as a skill input item with name and path.',
    adapter:
      'Renders a skill item as the same link and, for a SKILL.md under a listed skill folder (64 KiB at most), adds a <skill> block with its content to the prompt Claude reads; for any other SKILL.md it asks Claude to read the file. The userMessage item keeps the input as sent.',
    verify:
      'Pick a Claude skill with "$" or "/" and send a message: Claude follows the skill without reading its file first, and the message shows only the chip.',
  },
  {
    id: 'additional-context',
    app: "Attaches additionalContext ({key: {value, kind}}, kind untrusted or application) to turn/start and turn/steer, for the turn that follows connecting a suggested plugin, an edited page or writing block, and quick chat. It does not show the context in the user's message.",
    adapter:
      'Adds each entry to the prompt Claude reads as an <app_context key kind> block, capped at 32 KiB, behind a note that untrusted blocks are data and not instructions; the userMessage item and the chat preview leave it out.',
    verify:
      'Connect a suggested plugin from a Claude chat and continue: the reply uses the attached context, and the message shows no context text.',
  },
  {
    id: 'injected-context',
    app: "Sends thread/inject_items only while no turn runs, right before the turn/start it belongs to: an untrusted_input function call and its output for content an MCP app sends to the chat (the message then says to read that output), the same pair for a change in the state of the chat's inline visualizations, and a user message marking the boundary when it opens a side chat. It expects the items in the model's history and shows none of them.",
    adapter:
      "Keeps the items per thread and adds them to the prompt of the thread's next user message, before the message, as <app_context> blocks: a message by its role as application context, and a function call's output under the function's name as untrusted data, capped at 32 KiB each. A steer, a helper turn and the adapter's own prompts leave them for the next message. It shows no turn or item for them.",
    verify:
      'Interact with an inline visualization in a Claude chat and send a message: the chat shows no extra reply with the state as JSON, and Claude knows the state.',
  },
  {
    id: 'app-tool-availability',
    app: 'Writes developerInstructions for every local thread that describe its own tools (create_thread, read_thread, automation_update, create_worktree, sidebar tools and others) and the ::created-thread directive, and gives Codex threads those tools.',
    adapter:
      'Gives Claude threads none of them, so it appends a short "# Tool availability" section after the developer instructions naming the tools they mention, and asks Claude not to look for them or write their directives and to send the user to the App instead. appToolAvailabilityNote in src/turn-context.mts builds it, and leaves out the tools and the directive advice a thread is given as having.',
    verify:
      "In a Claude chat, ask to start a new thread or a worktree: Claude says to do it in the App instead of searching for the tool. Search the new build's thread-start instructions for tool names missing from the list in src/turn-context.mts.",
  },
  {
    id: 'prewarmed-threads',
    app: "Starts the thread of a new chat with thread/start before the user sends anything, keeps it out of thread/list and holds back its thread/started until it sends turn/start there, and deletes it with thread/delete once the chat goes unused for 10 minutes. It forgets such threads when the app-server connection drops or the App quits. It sends the chat's first message to that thread whatever model was picked meanwhile, comparing only permissions, instructions and feature overrides.",
    adapter:
      'Lists and searches a thread only once it has a turn or a preview, as Codex lists a thread only once it has a user message, so a prewarmed chat the App forgot does not show up empty in the sidebar. The archive, a chosen section and subagent queries still list every thread. A thread with no conversation yet takes the backend (and model process profile) of the model its first turn names, so that message runs on the model picked.',
    verify:
      'Open a new chat without sending anything, restart the adapter and reload the App: no empty chat shows in the sidebar. Open a new chat, pick a model of the other backend and send: the reply comes from that model.',
  },
  {
    id: 'file-change-preview',
    app: 'Replaces the changes of the fileChange item with each item/fileChange/patchUpdated, adding an inProgress fileChange item when it has none of that id, and redraws its card while the item is still in progress. Its approval card shows the changes the item holds when the request comes.',
    adapter:
      "Opens the fileChange card of an Edit, Write or MultiEdit call once Claude's streamed input names the file, sends the change written so far at most every 500 ms as Codex does for apply_patch, and replaces it with the finished call's change before any approval. A card whose call never finished fails at the next model response. CLAUDE_CODEX_LIVE_FILE_CHANGES=0 turns it off.",
    verify:
      'Ask Claude to write a long new file: its card shows up while Claude is still writing and grows, and the approval and the completed card show the whole file.',
  },
  {
    id: 'memories-settings',
    app: 'Shows the Memories settings under Settings > Personalization, and the /memories command, only while experimentalFeature/list lists the memories feature enabled. Sets its defaults for the connection with experimentalFeature/enablement/set (memories off) when it connects. Its switches write features.memories, memories.generate_memories and memories.use_memories with config/batchWrite and read them back from the memories table of config/read. A chat started with its own switches carries them as memories.* config on thread/start; /memories in a chat sends thread/memoryMode/set. Delete calls memory/reset and shows an error toast when it fails.',
    adapter:
      "Only with CLAUDE_CODEX_MEMORIES=1: lists memories as a beta feature, on only when features.memories in the config, or else the connection's enablement, turns it on, serves the memories table in config/read, and keeps each thread's mode. It then runs Claude Code with auto-memory only for threads whose mode is enabled while the feature is on, switching it off with CLAUDE_CODE_DISABLE_AUTO_MEMORY otherwise. Without the switch it lists no features, acknowledges thread/memoryMode/set without effect and leaves auto-memory to Claude Code's own settings. Either way it refuses memory/reset, since Claude Code's memory folders are shared with Claude Code outside the App.",
    verify:
      'With CLAUDE_CODEX_MEMORIES=1, turn Memories on in Settings > Personalization: the switch stays on after a reload, and /memories shows in the composer of a chat. Without it, Settings > Personalization shows no Memories settings.',
  },
  {
    id: 'mcp-settings',
    app: 'Lists the servers of Settings > MCP servers from config/read mcp_servers, and saves to the file of the first user layer, or else of the user, system or project origin of mcp_servers (or of mcp_servers.<name>); with neither it says "MCP server settings are unavailable". Adding, editing or deleting a server sends config/batchWrite with one replace edit of mcp_servers.<name> (null deletes); its switch sends config/value/write of mcp_servers.<name>.enabled with upsert. A server whose origin is a project file cannot be edited, and a server mcpServerStatus/list reports that config/read does not list shows apart from the others. A refused save shows the error message under the form.',
    adapter:
      "Reports the user config file as the origin of mcp_servers. Only with CLAUDE_CODEX_APP_MCP_SERVERS=1: lists the servers the App added with that origin each, keeps them in its own config file, and starts the enabled ones in Claude threads; a write naming no command or URL, a field of the wrong type, or the switch of a server the App never added is refused. Without it, config/read lists no server and every write that would add, change or delete one is refused with a message naming the switch and Claude Code's own MCP config.",
    verify:
      'With CLAUDE_CODEX_APP_MCP_SERVERS=1, add a stdio server under Settings > MCP servers: it stays listed after a reload, mcpServerStatus/list reports it, and a Claude chat can call its tools; switching it off takes the tools away in the next turn. Without it, saving a new server shows the message under the form.',
  },
  {
    id: 'desktop-mcp-servers',
    app: "Writes mcp_servers.node_repl (its desktop REPL, with the App's own environment) and mcp_servers.cua_repl into the user config with config/batchWrite each time it starts, for its own Codex threads, and treats both names as its desktop servers.",
    adapter:
      'Accepts those writes and keeps neither, so Claude threads never start them and the App settings list does not show them.',
    verify:
      'In the bundle, the main process still writes only those two servers, and the MCP settings page still treats them as desktop servers.',
  },
  {
    id: 'settings-write-errors',
    app: 'Writes Settings > Configuration (approval policy, sandbox mode, network access, web search, verbosity, reasoning summaries) with config/value/write, reads the values back from config/read, and shows "Couldn\'t update this setting" next to a setting whose write fails.',
    adapter:
      'Refuses a write of a setting Claude threads have no counterpart for, such as model verbosity, a service tier or network access off, and reports in config/read what Claude threads do for it, except the network access the permission-presets rule keeps unset.',
    verify: 'Picking a verbosity, or turning network access off, shows the error next to it.',
  },
  {
    id: 'permission-presets',
    app: "Takes config/read's approval_policy on-request with sandbox_mode workspace-write for its Default permissions preset only while sandbox_workspace_write is null, or a table with no writable_roots and network_access, exclude_tmpdir_env_var and exclude_slash_tmp all false (app-shared y4e/v4e; $_t/Q_t in 26.930). Otherwise it lists Custom (config.toml) in the composer's permissions menu and preselects it for a new chat with no stored choice. Settings > Configuration shows network access as that table's network_access, off when it is null.",
    adapter:
      'Reports sandbox_workspace_write as null, as Codex does without a [sandbox_workspace_write] table, although Claude threads always have network access; Settings shows network access off for them, and turning it off is refused under settings-write-errors.',
    verify:
      'With no permissions picked before, start a new chat: the composer shows Default permissions and the menu lists no Custom (config.toml).',
  },
  {
    id: 'dynamic-tools',
    app: 'Registers its own tools (the codex_app namespace) as thread/start dynamicTools only on hosts that do not use its desktop MCP server, such as remote hosts, and runs an item/tool/call request only while the turn it names is in progress, answering with contentItems and success.',
    adapter:
      'With CLAUDE_CODEX_DYNAMIC_TOOLS=1, checks and stores the dynamicTools of thread/start, offers each namespace to Claude as an MCP server, and sends each call as item/tool/call with the running turn and a dynamicToolCall item around it. Local hosts get no tools, as the App sends none.',
    verify:
      'On a remote host with the switch on, start a chat and ask Claude to list the chat artifacts: a dynamic tool call card shows the App tool and its result.',
  },
  {
    id: 'command-output-after-completion',
    app: 'Appends item/commandExecution/outputDelta to the commandExecution item with that id in whichever turn of the thread holds it, completed or not, keeping the last 20000 characters behind an `[output truncated]` line, and drops a delta whose item it cannot find.',
    adapter:
      "Streams a background shell's output into the completed item of the Bash call that started it, also after its turn ended, and stores it cut the same way.",
    verify:
      'Ask Claude to start a background command that prints a line every second: after the turn ends, its command item keeps showing new lines.',
  },
  {
    id: 'explored-commands',
    app: 'Folds consecutive commandExecution items whose commandActions are all read, listFiles or search into one "Explored" row counting the files, searches and lists, labelling a search "Searched for <query> in <path>" and a list "Listed files in <path>". An item with no actions, an unknown one, or a declined one shows as its command.',
    adapter:
      "Shows Claude's Read, Grep, Glob and LS calls as commandExecution items with one matching action, and gives a Bash command the actions Codex's own parser would; a command it cannot parse is one unknown action.",
    verify:
      'Ask Claude to look around a repository: its Read, Grep and Glob calls and a `cat` or `rg` it runs fold into one "Explored" row.',
  },
  {
    id: 'command-approval-actions',
    app: "Shows a command approval as the commands of its commandActions joined with ' && ' in place of command when it has any, and offers its own decisions whatever availableDecisions says.",
    adapter:
      'Sends the actions only when a single one spells out the whole command, else one unknown action with the command, so the card never hides part of what runs. Only a Bash command is remembered for the session; an acceptForSession on any other card accepts that call only.',
    verify:
      'With approvals on, have Claude run `cat README.md && touch x`: the card shows the whole command.',
  },
  {
    id: 'turn-notices',
    app: 'Shows an `error` notification with willRetry as a dim row of its own under the turn it names, with its message as written, whether that turn still runs or has ended, without failing or ending the turn; only a "Reconnecting... n/m" message replaces the row before it. It does not keep the row when the chat is reopened, and it ignores `warning` notifications.',
    adapter:
      "Sends what Claude Code reports beside a turn (a compaction it could not do, a model it switched to, an urgent CLI notification, a call it denied or an MCP request it declined while no turn was running) as a `warning`, as Codex does, and as such an `error` with no code: each message once per turn, the first 5 as rows. A notice between turns goes under the thread's running or last turn. A turn that then fails repeats its notices in the error's additionalDetails, stored with the turn, which the App shows only in a diagnostics view it does not always offer. A structured-output helper turn sends warnings only, and CLAUDE_CODEX_NOTICE_ROWS=0 turns the rows off.",
    verify:
      'Have a background task call a tool that needs approval after the turn ended: a row under the last turn says the call was denied and how to run it again, and the turn stays completed.',
  },
  {
    id: 'compaction-marker',
    app: 'Draws a contextCompaction item as "Context compacted" once item/completed arrives or when it is stored in a turn, and an open one as compacting while its turn is in progress and as "Compaction interrupted" once the turn has ended.',
    adapter:
      'Stores a contextCompaction only when the compaction completes, in the place it started, as Codex keeps only finished compactions. A compaction an interrupt or a failed turn cuts short stays open, so it shows as interrupted until the chat is reopened, where it is gone.',
    verify:
      'Interrupt a long /compact: the item shows as interrupted, not compacted; let one finish: it shows as compacted, also after the chat is reopened.',
  },
  {
    id: 'item-completed-replaces',
    app: 'Replaces the item with the same id on item/completed, whatever type it started as.',
    adapter:
      'Completes an image Read that fails or is stopped as its failed Read command in place of the imageView it started as, and a compaction Claude could not do while the turn went on as an empty reasoning item, which the App does not draw, in place of the contextCompaction it started as.',
    verify:
      'Ask Claude to read an image file that does not exist: the turn shows the failed Read, not an empty image.',
  },
  {
    id: 'command-approval-card',
    app: "Draws an item/commandExecution/requestApproval card from its params alone (command, cwd, reason, availableDecisions), but draws an item/fileChange/requestApproval card only for a fileChange item with the request's itemId; without one the request shows nothing and the turn waits.",
    adapter:
      'Asks for an Edit, Write or MultiEdit (a fileChange item) as a file change, and for any other Claude tool as a command: Bash with its command, other tools with their name and what they touch ("WebFetch https://…"). Claude\'s reason for asking is the card\'s reason. "Allow for this session" approves the same command or tool input again, as Codex keys its session approvals; the rules and folders Claude offers for the session go along only with CLAUDE_CODEX_SESSION_SUGGESTIONS=1.',
    verify:
      'In a Claude chat in the default permissions mode, have Claude fetch a web page: the approval card names WebFetch and the URL, and approving runs it.',
  },
  {
    id: 'command-approval-amendment',
    app: 'Offers "Allow similar commands" on a command approval card whenever proposedExecpolicyAmendment is an array whose words, joined with spaces, hold no line break, whatever availableDecisions lists, with a tooltip naming the prefix. It answers {acceptWithExecpolicyAmendment: {execpolicy_amendment}} with that array.',
    adapter:
      'Proposes the prefix of the one Bash rule Claude offers to save for the command (`npm test *` or `npm test:*` giving ["npm", "test"], an exact-command rule all its words) and null for anything else, a call without a session choice included. Only that answer with that prefix saves the rule: Claude Code writes it to the project\'s .claude/settings.local.json.',
    verify:
      'In a Claude chat in the default permissions mode, have Claude run `npm test`: the card offers "Allow similar commands" for `npm test`; after picking it the project\'s .claude/settings.local.json allows Bash(npm test *) and the next `npm test -- --watch` does not ask.',
  },
  {
    id: 'mcp-tool-approval',
    app: 'Draws an mcpServer/elicitation/request whose _meta.codex_approval_kind is mcp_tool_call as a tool approval card: the message as its title, _meta.reason, the tool_params, an "Allow for this session" choice when _meta.persist offers session and an "Always allow" button when it offers always (a string, or an array for both). It answers accept, decline or cancel, with _meta.persist "session" or "always" for those choices.',
    adapter:
      'Asks for an mcp__<server>__<tool> call with that elicitation, as Codex does for its MCP tools, offering session approval unless Claude offers no "always allow" for the call, and "always" as well when Claude offers to save a rule. "Allow for this session" approves that tool for the rest of the thread in this adapter process; "Always allow" has Claude Code save a rule naming that tool of that server, mcp__<server>__<tool>, to the project\'s .claude/settings.local.json.',
    verify:
      'Have Claude call a tool of a configured MCP server: the card asks to allow that server to run the tool, after "Allow for this session" the next call of the tool does not ask, and after "Always allow" the project\'s .claude/settings.local.json allows mcp__<server>__<tool>.',
  },
  {
    id: 'declined-tool-items',
    app: 'Shows a commandExecution or fileChange item with status declined as declined: no output, no exit code, and a declined patch is not counted as changed files.',
    adapter:
      'Ends the item of a call the user declined or cancelled, or Claude refused without asking, as declined, and does not show the refusal text Claude gets as its result. Cancel also ends the turn as interrupted.',
    verify:
      'Decline a command approval in a Claude chat: the command shows as declined, not failed, and Claude goes on; cancel one: the turn stops.',
  },
  {
    id: 'auto-review',
    app: 'Its auto-review permissions preset sends approvalsReviewer guardian_subagent (auto_review in newer builds) on thread/settings/update and turn/start, and on turn/settings/update while a turn runs. Its picker follows the approvalsReviewer of thread responses and thread/settings/updated, and it draws item/autoApprovalReview/completed as a review card on the item named by targetItemId.',
    adapter:
      "Stores the reviewer per thread and runs a Claude thread that asks for auto_review in Claude Code's auto permission mode, when its model supports it. Otherwise approvals stay with the user: it stores and echoes 'user' and sends a configWarning saying why. A call the auto-mode classifier denies ends declined, with a denied review naming the classifier's reason; a call Claude Code says only the user may answer always asks, in every mode.",
    verify:
      'Pick auto-review in a Claude chat on a model with auto mode and have Claude delete a build folder: the picker stays on auto-review, and a blocked call shows as declined with the review reason. On a model without auto mode the picker returns to the default with a config warning, and approval cards show as before.',
  },
]

// The methods the App starts calling, or sends new parameters to, once the
// app-server version turns a feature gate on (the gate table is in its
// bundle; see scripts/app-baseline.json). check:app-upgrade flags a gate the
// adapter's version turns on while one of these has no case. An empty list
// is a gate checked to need no method: most of those only let a Codex feature
// key through in the config the App sends, which Claude threads ignore.
export const GATED_METHODS: Readonly<Record<string, readonly string[]>> = {
  appRead: ['app/read'],
  asyncCompaction: [],
  // For an attached audio file, looks the model up in model/list and adds
  // localAudio input to turn/start or turn/steer only when the model takes
  // audio, which no Claude model does.
  audioInputs: ['model/list', 'turn/start', 'turn/steer'],
  // An access-key option in the Bedrock sign-in form, which signs in with
  // account/login/start; account/read already reports a Bedrock account.
  bedrockAccessKeysLogin: ['account/login/start'],
  diagnostics: ['server/diagnostics'],
  // Composer predictions fork only a thread whose modelProvider is openai;
  // every thread here reports claude-code.
  experimentalPredictionForkMode: [],
  gatewayOAuth: [
    'account/gatewayOAuth/read',
    'account/gatewayOAuth/login',
    'account/gatewayOAuth/cancel',
  ],
  guardianV2DecisionsComparison: [],
  incrementalTools: [],
  instantInterrupt: [],
  // Whether a configured application requirement still lets the App set up
  // its search MCP (see searchMcpClient).
  mcpApplicationNetworkPolicy: [],
  mcpEventStream: ['mcpServer/event/stream/start', 'mcpServer/event/stream/stop'],
  mcpResourceReadOriginCallId: ['mcpServer/resource/read'],
  mcpServerStatusByName: ['mcpServerStatus/list'],
  // Reviews a turn that failed with codexErrorInfo
  // misalignmentPolicyViolation, which no turn here reports.
  misalignmentReviewTarget: [],
  multiAgentWaitToolConfig: [],
  outputTokenReplay: [],
  preserveForkPrefix: [],
  projects: [
    'project/list',
    'project/read',
    'project/create',
    'project/import',
    'project/update',
    'project/delete',
    'project/move',
  ],
  // 26.930 never reads this gate; 26.1013 only lets a Codex feature key
  // through in the config it sends while it is on.
  reasoningEffortUpdates: [],
  rolloutCompression: ['rollout/compress'],
  // Reads config/read, account/read and configRequirements/read as a thread
  // starts. mcpServerStatus/list and the rest of its search MCP setup need a
  // gpt- model and a ChatGPT account, which no thread here has.
  searchMcpClient: [
    'config/read',
    'account/read',
    'configRequirements/read',
    'mcpServerStatus/list',
  ],
  // A serviceTier on the heartbeat's turn/start, which Claude ignores.
  serviceTierForTurn: ['turn/start'],
  // Keeps the worktree of an archived thread while another thread holds it.
  threadAttachmentOwners: ['thread/attachmentOwner/list'],
  threadAttachments: [
    'thread/attachment/add',
    'thread/attachment/list',
    'thread/attachment/remove',
  ],
  // thread/fork with beforeTurnId.
  threadForkBeforeTurn: ['thread/fork'],
  // thread/items/list with an { itemId } cursor.
  threadItemAnchors: ['thread/items/list'],
  threadQueue: [
    'thread/queue/add',
    'thread/queue/list',
    'thread/queue/update',
    'thread/queue/delete',
    'thread/queue/reorder',
    'thread/queue/start',
  ],
  threadRevert: ['thread/revert'],
  threadTimeline: ['thread/timeline/list'],
  turnApprovalsReviewer: ['turn/settings/update'],
  // parentTurnId and rootTurnId on turn/start; the turn reports its
  // rootTurnId back.
  turnLineage: ['turn/start'],
  turnToolOutput: ['turn/start'],
}

// App rule: subagent-completed-kind
export function rendersCompletedSubagentActivity(version: string): boolean {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10))
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return (major as number) > 26 || (major === 26 && (minor as number) >= 930)
}

export interface AppVersionWarning {
  summary: string
  details: string
}

// App rule: client-info
export function unverifiedAppWarning(clientInfo: {
  name?: unknown
  version?: unknown
}): AppVersionWarning | null {
  if (clientInfo.name !== DESKTOP_CLIENT_NAME) return null
  const version = typeof clientInfo.version === 'string' ? clientInfo.version.trim() : ''
  if (VERIFIED_APP_VERSIONS.includes(version)) return null
  return {
    summary: `claude-codex has not been checked against Codex App ${version || '(no version)'}`,
    details: `Checked builds: ${VERIFIED_APP_VERSIONS.join(', ')}. Subagent cards, steering, the message queue and the "/" skills rely on App behavior the protocol does not pin down; run \`npm run check:app-upgrade\` and the checklist in docs/reference/app-compat.md before relying on them.`,
  }
}
