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
export const VERIFIED_APP_VERSIONS: readonly string[] = ['26.930.21537']

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
    id: 'config-warnings',
    app: 'Lists configWarning notifications under Settings > Agent > Configuration, keeping the last 20 per host.',
    adapter: 'Reports an App build missing from VERIFIED_APP_VERSIONS there.',
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
    adapter: 'Publishes the userMessage item only for turns it starts from the server-side queue.',
    verify: 'A sent message shows once; a queued one shows when it starts.',
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
]

// The methods the App starts calling, or sends new parameters to, once the
// app-server version turns a feature gate on (the gate table is in its
// bundle; see scripts/app-baseline.json). check:app-upgrade flags a gate the
// adapter's version turns on while one of these has no case.
export const GATED_METHODS: Readonly<Record<string, readonly string[]>> = {
  appRead: ['app/read'],
  diagnostics: ['server/diagnostics'],
  gatewayOAuth: [
    'account/gatewayOAuth/read',
    'account/gatewayOAuth/login',
    'account/gatewayOAuth/cancel',
  ],
  mcpEventStream: ['mcpServer/event/stream/start', 'mcpServer/event/stream/stop'],
  mcpResourceReadOriginCallId: ['mcpServer/resource/read'],
  mcpServerStatusByName: ['mcpServerStatus/list'],
  projects: [
    'project/list',
    'project/read',
    'project/create',
    'project/import',
    'project/update',
    'project/delete',
    'project/move',
  ],
  // The verified App never reads this gate.
  reasoningEffortUpdates: [],
  rolloutCompression: ['rollout/compress'],
  // A serviceTier on the heartbeat's turn/start, which Claude ignores.
  serviceTierForTurn: ['turn/start'],
  threadAttachments: [
    'thread/attachment/add',
    'thread/attachment/list',
    'thread/attachment/remove',
  ],
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
