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
      "Lists Claude Code's built-in commands as skills and turns the first such link back into `/name args`.",
    verify: 'Type "/" in the composer: /simplify is listed, and picking it runs the command.',
  },
  {
    id: 'optimistic-user-message',
    app: 'Draws its own user message for every turn/start it sends.',
    adapter:
      'Publishes the userMessage item only for turns it starts itself: from the server-side queue, or for the leader tools.',
    verify: 'A sent message shows once; a queued one shows when it starts.',
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
      'With CLAUDE_CODEX_DISABLE_CODEX_PROXY=1 and no Codex proxy selected, starts a helper thread that names a Codex model on the Claude summary model instead of the Codex backend, maps a Codex model on its turns the same way, and keeps an ephemeral fork of a Claude chat on the chat model. Other threads that name a Codex model are left on Codex. Drops the draft declaration of an outputSchema, which the Claude CLI refuses.',
    verify:
      'With Codex routing off, send the first message of a new chat: the chat gets a generated title, not its first words.',
  },
  {
    id: 'prewarmed-threads',
    app: 'Starts the thread of a new chat with thread/start before the user sends anything, keeps it out of thread/list and holds back its thread/started until it sends turn/start there, and deletes it with thread/delete once the chat goes unused for 10 minutes. It forgets such threads when the app-server connection drops or the App quits.',
    adapter:
      'Lists and searches a thread only once it has a turn or a preview, as Codex lists a thread only once it has a user message, so a prewarmed chat the App forgot does not show up empty in the sidebar. The archive, a chosen section and subagent queries still list every thread.',
    verify:
      'Open a new chat without sending anything, restart the adapter and reload the App: no empty chat shows in the sidebar.',
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
