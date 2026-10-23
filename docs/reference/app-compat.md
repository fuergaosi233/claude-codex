# Codex App compatibility

The app-server protocol schema says which messages exist. It does not say how
the Codex desktop App reacts to them: which error text makes it retry a steer,
which notification removes a subagent from the panel, which version turns a
feature on. The adapter depends on a number of these behaviors, read from the
App bundle, and an App release can change any of them without touching the
protocol. This page lists them and describes how to check a new App build.

## App rules

Each behavior is an **App rule** in `src/app-compat.mts` (`APP_RULES`), with
what the App does, what the adapter does because of it, and how to tell it
still holds. Every place in `src/` that depends on a rule carries a
`// App rule: <id>` comment; `test/app-compat.test.mts` fails when a rule has no
tag or a tag names no rule, so `rg 'App rule: steer-errors' src` finds every
line a rule touches.

| Rule | The App… | Check on a new build |
| --- | --- | --- |
| `client-info` | identifies itself in `initialize` as `clientInfo.name` `codex_desktop`, with its build as the version | `check:app-upgrade` finds the name |
| `feature-gates` | turns features on by the app-server version in the `initialize` userAgent, and rejects one below its minimum | `check:app-upgrade` lists the gates |
| `prediction-provider` | from 26.1013, predicts the next composer message by forking the thread with `thread/fork` and `experimentalPredictionMode`, only when its `modelProvider` is `openai` | the bundle's prediction path still stops with `unsupported_provider` for another provider |
| `daemon-version` | with `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, runs `codex app-server daemon version` and connects to the server on `<CODEX_HOME>/app-server-control/app-server-control.sock` when it reports a version, or starts its own over stdio when the probe fails | the bundle still runs the probe and reads that socket |
| `config-warnings` | lists `configWarning` notifications under Settings > Agent > Configuration | an unlisted build shows the warning there |
| `bedrock-account` | filters the model picker through its OpenAI allowlist unless `account/read` returns a Bedrock account | the picker lists the Claude models |
| `model-efforts` | offers each model the `model/list` efforts that are also enabled under Settings > Agent > Model features (max is off by default and listed once a model offers it), and falls back to the model's `defaultReasoningEffort` | after a Claude turn, Max is listed there; with it on, Claude Opus offers Max and Claude Haiku no effort levels |
| `bedrock-govcloud` | from 26.1013, checks a Bedrock account with `account/bedrock/checkGovCloudRequirements` at startup and shows an "AWS GovCloud guidance" modal until it is acknowledged, unless the answer has `isGovCloud: false`; an error shows it too | an App that never acknowledged the guidance starts without the modal |
| `bedrock-auth-status` | reads its feature flags in the main process only when `getAuthStatus` names the auth method it derives from `account/read`; otherwise a thread it resumes on its own never becomes ready | a message queued during a turn is sent when the turn ends; a new chat gets a title |
| `skills-popup` | fills the "/" popup from `skills/list`, refetches it on `skills/changed`, and sends a picked skill as a `[$name](path)` link | `/simplify` is listed and runs; so does a `.claude/commands` command once a chat in its folder has run a turn |
| `optimistic-user-message` | draws its own user message for every `turn/start` it sends | a message shows once; a queued one when it starts; a second window on the chat shows it too |
| `server-started-threads` | adds a thread it did not start to the sidebar on `thread/started` and follows its turns live | a chat started with `thread_start` shows in the sidebar and streams its first turn |
| `added-thread-titles` | titles a thread `thread/started` adds from that announcement alone: its `name` if set, otherwise a title it generates from its `preview` and saves with `thread/name/set`; with neither the thread stays untitled | a chat started with `thread_start` and no title gets a generated title, not its first words; one with a title shows that title |
| `created-thread-card` | shows a card for a chat from a `::created-thread{threadId="…"}` line of its own in a completed reply, and refreshes its status with `thread/read` and `thread/turns/list` | a reply after `thread_start` shows a card for the new chat that follows its first turn |
| `tool-output-turns` | with `turnToolOutput` on, sends a thread handoff or a message from another thread as a `turn/start` with empty input and the text in `toolOutput`, and shows a `functionCallOutput` item as that turn's user message | a chat handed off to a new thread shows the text, and Claude answers it |
| `continue-turns` | offers Continue on a chat whose last turn did not finish, and sends it as a `turn/start` with empty input | after a restart mid-turn, Continue gets the message sent in that turn answered |
| `steer-errors` | matches `turn/steer` error texts to fall back to a new turn or retry another turn id | a message sent as a turn ends still arrives |
| `steer-bubble` | settles the steering bubble when a `userMessage` item carries its `clientUserMessageId` | a steer shows once, in the transcript |
| `subagent-completed-kind` | renders the completed `subAgentActivity` kind from 26.930 without declaring it | a finished subagent shows as done |
| `subagent-close-hides` | removes a child from the panel when `closeAgent` follows its successful wait | a finished subagent stays in the panel |
| `completed-wait` | marks every working agent of the thread done when a wait completes | with two agents, the first to finish does not end the second |
| `agent-states` | shows `interrupted` as done and `errored` as failed | a stopped subagent shows as done |
| `subagent-failure-reason` | shows a failed turn's `error.message` as an error row in that turn (not an interrupted one's), and an agent's `agentsStates` message after its status on a `spawnAgent` or `sendInput` row, never on a wait or `closeAgent` | a subagent whose run fails ends its thread with an error row naming the cause, without stack frames; the parent's failed turn says how many subagents failed and why the first did |
| `subagent-read` | reads a child with `includeTurns: false` and shows one without turns as loading | a finished subagent opens with its prompt, its work and its reply |
| `child-prompt` | creates the child conversation from `thread/started` with an empty turn | a running subagent shows its prompt |
| `subagent-titles` | titles a subagent thread with the `name` its `thread/started` carries, and otherwise generates one from the parent's `spawnAgent` prompt with a model turn of its own | a subagent's and a workflow agent's threads show the description or label at once, with no title turn for them |
| `nested-subagent` | finds a child through the `spawnAgent` item of the conversation its `parentThreadId` names | a subagent's own subagent opens from the outer subagent's conversation, at depth 2 |
| `rate-limit-banner` | shows a banner for every `account/rateLimits/updated` | no banner after an ordinary reply |
| `projects` | holds project writes until `project/list` answers, and matches the `project not found` and deleted-key error texts | a project and a chat moved into it survive an App restart |
| `delete-missing-rollout` | retries `thread/delete` with `missingRolloutRecovery` after `no rollout found for thread id <id>` | deleting all archived chats empties the list |
| `inline-visualizations` | renders an HTML fragment from a `::codex-inline-vis{path="…"}` line, reading it only for a UUIDv7 thread id, and installs its bundled `visualize` plugin with `plugin/install` each time it starts | in a new chat, a chart Claude is asked for renders inside the reply |
| `visualize-line` | renders an inline visualization from a line holding `visualize` and its JSON wrapped in the private-use marks its visualize skill documents, and shows the same line without the marks as text | a reply that names a visualization as a plain `visualize{…}` line shows it rendered, also after the chat is reopened |
| `code-review-plugin-server` | turns on its bundled code-review plugin's MCP server with a `-c` setting and drives the Pull Requests panel through `mcpServer/tool/call`, `mcpServer/resource/read` and `mcpServerStatus/list` on server `code-review` | with `CLAUDE_CODEX_APP_PLUGIN_MCP=1` and gh signed in, the Pull Requests panel lists pull requests |
| `quiet-turn-heartbeat` | leaves a thread read and sends no notification when the turn's last agent message ends with a `<heartbeat>` block deciding `DONT_NOTIFY`, and hides the block once the message completes | a turn that leaves a background agent running ends without an unread dot or visible block; the agent's report lights the dot |
| `helper-thread-model` | generates titles, descriptions and turn summaries in ephemeral helper threads on its own OpenAI model, accepting another one, with `model: null` and an `outputSchema` declaring JSON Schema draft 2020-12 on `turn/start`, waiting 30 seconds for the answer; keeps the first words as the title when that fails | with Codex routing off, a new chat gets a generated title |
| `model-menu-settings` | applies a model picked in an open chat with `thread/settings/update`, and on an error shows a "Couldn't update model settings" toast and puts the menu back (for `-32600` it adds "Check your config.toml.", the error message and an Open config.toml button); only code `-32601` or a method-not-found text means the method is missing | in a Claude chat with a reply, picking a Codex model shows the toast with the reason and keeps the Claude model |
| `reasoning-summary` | shows a reasoning item only through its summary parts, bolding the first when there are several, and never renders its raw content | Claude's thinking shows above the reply, live and after the chat is reopened |
| `reconnecting-errors` | shows an `error` with `willRetry` as one passing row per turn, counting attempts only from a `Reconnecting... n/m` message | with the API answering 529 for a while, the turn shows `Reconnecting 1/10` counting up, then the reply; a running subagent shows its own retries in its thread, not in the parent |
| `error-codes` | reads `codexErrorInfo`: `serverOverloaded` shows "Server is busy", `usageLimitExceeded` opens a ChatGPT plan upgrade card, `cyberPolicy` a safety notice | a turn the overloaded API ends says the server is busy |
| `thread-git-info` | shows `gitInfo.branch` in the sidebar, looks the workspace up itself when `thread/start` answers with none, replaces what it knows with the `thread/resume` answer, and sets the branch it creates with `thread/metadata/update` | after an App restart, a Claude chat in a repository still shows its branch in the sidebar |
| `context-gauge` | fills the context gauge from the latest `thread/tokenUsage/updated` as `last.totalTokens` over `modelContextWindow`, and hides it when either is null | in a chat that has finished a turn, the gauge moves during a long turn instead of jumping at its end |
| `collaboration-modes` | enables `/plan` and the Plan toggle only when `collaborationMode/list` has a `plan` preset, sends the mode with the picker's model and effort in `collaborationMode.settings` (top-level `model` and `effort` null on `turn/start`), and adopts the mode `thread/settings/updated` and `thread/resume` report | in a Claude chat `/plan` is enabled, and the Plan toggle stays on after a message |
| `plan-implementation` | asks "Implement this plan?" when a completed turn has a non-empty `plan` item, and sends the plan back as a default-mode turn when accepted | a plan asked for in Plan mode shows as one card, followed by the prompt |
| `skill-injection` | sends a skill picked in the composer as a `[$name](path)` link, and one picked from a plugin or setup card as a `skill` input item | Claude follows a picked skill without reading its file first; the message shows only the chip |
| `additional-context` | attaches `additionalContext` entries (`untrusted` or `application`) to `turn/start` and `turn/steer`, for example after connecting a suggested plugin, and keeps them out of the user's message | the turn after connecting a plugin uses the context; the message shows none of it |
| `injected-context` | sends `thread/inject_items` while no turn runs, before the `turn/start` it belongs to: an MCP app's content or an inline visualization's state as an `untrusted_input` call and output, or the boundary of a side chat as a user message; it expects them in the model's history and shows none of them | after interacting with an inline visualization, the next message gets no extra JSON reply, and Claude knows the state |
| `app-tool-availability` | writes developer instructions describing its own tools (`create_thread`, `automation_update`, `create_worktree`, …) and gives them to Codex threads only | asked for a new thread or worktree, Claude points to the App; tool names new in the build's instructions are added to the list in `src/turn-context.mts` |
| `prewarmed-threads` | starts a new chat's thread before anything is sent, hides it from `thread/list` until its first `turn/start`, and forgets it when the connection drops or the App quits; sends the first message there whatever model was picked meanwhile | after an adapter restart, a new chat left empty does not show in the sidebar; a new chat sent on a model of the other backend runs on it |
| `file-change-preview` | replaces a `fileChange` item's changes with each `item/fileChange/patchUpdated`, adding the item if it has none of that id, and redraws its card while it is in progress; the approval card shows the changes the item holds | a long new file Claude writes shows up and grows while Claude writes it, and the approval shows the whole file |
| `memories-settings` | shows its Memories settings and `/memories` only while `experimentalFeature/list` lists `memories` enabled; sets `memories: false` for the connection with `experimentalFeature/enablement/set`; writes `features.memories` and the `memories.*` switches with `config/batchWrite` and reads them from `config/read`; sends a chat's switch as `memories.*` config on `thread/start` or as `thread/memoryMode/set`; Delete calls `memory/reset` | with `CLAUDE_CODEX_MEMORIES=1` and Memories turned on in Settings > Personalization, the switch survives a reload and `/memories` shows in a chat; without the switch, no Memories settings show |
| `mcp-settings` | lists Settings > MCP servers from `config/read` `mcp_servers` and saves to the file the `mcp_servers` origin names, saying the settings are unavailable without one; adds, edits and deletes a server with a `config/batchWrite` replace edit of `mcp_servers.<name>`, and switches it with `config/value/write` of `mcp_servers.<name>.enabled` | a stdio server added there stays listed after a reload and its tools work in a Claude chat; switched off, they are gone in the next turn |
| `desktop-mcp-servers` | writes `mcp_servers.node_repl` and `mcp_servers.cua_repl`, its desktop servers with its own environment, into the user config with `config/batchWrite` each time it starts | the main process still writes only those two |
| `settings-write-errors` | writes Settings > Configuration with `config/value/write`, reads the values back from `config/read`, and shows "Couldn't update this setting" next to a setting whose write fails | network access shows on; picking a verbosity shows the error |
| `dynamic-tools` | registers its own tools as `thread/start` `dynamicTools` only on hosts that do not use its desktop MCP server, such as remote ones, and runs an `item/tool/call` request only while the turn it names is in progress | on a remote host with `CLAUDE_CODEX_DYNAMIC_TOOLS=1`, a tool call Claude makes to the App shows as a dynamic tool call card with its result |
| `command-output-after-completion` | appends `item/commandExecution/outputDelta` to the command item with that id in any turn, completed or not, keeping its last 20000 characters, and drops a delta for an item it cannot find | a background command's item keeps showing new lines after its turn ends |
| `explored-commands` | folds command items whose `commandActions` are all `read`, `listFiles` or `search` into one "Explored" row, and shows an item with no actions, an `unknown` one or a declined one as its command | Claude's Read, Grep and Glob calls and a `cat` or `rg` it runs fold into one "Explored" row |
| `command-approval-actions` | shows a command approval as the commands of its `commandActions` joined with `&&` in place of `command`, and offers its own decisions whatever `availableDecisions` says | with approvals on, the card for `cat README.md && touch x` shows the whole command |
| `turn-notices` | shows an `error` with `willRetry` as a dim row of its own under the turn it names, running or ended, without failing the turn; does not keep the row on reload, and ignores `warning` | a tool call a background task makes after the turn ended shows a row under that turn saying it was denied |
| `compaction-marker` | draws a `contextCompaction` as "Context compacted" once completed or stored, and an open one as compacting in a running turn and as "Compaction interrupted" after it | an interrupted `/compact` shows as interrupted, a finished one as compacted, also after a reload |
| `item-completed-replaces` | replaces the item with the same id on `item/completed`, whatever type it started as | an image Read of a missing file shows as the failed Read, not an empty image; a compaction Claude could not do leaves no marker |
| `command-approval-card` | draws a command approval from its params alone, but a file change approval only for a `fileChange` item with the request's `itemId` | a WebFetch approval in a Claude chat names the tool and the URL |
| `command-approval-amendment` | offers "Allow similar commands" on a command approval whenever `proposedExecpolicyAmendment` is an array, whatever `availableDecisions` lists, and answers `acceptWithExecpolicyAmendment` with that array | after "Allow similar commands" for `npm test`, the project's `.claude/settings.local.json` allows `Bash(npm test *)` and the next `npm test` does not ask |
| `mcp-tool-approval` | draws an `mcpServer/elicitation/request` with `_meta.codex_approval_kind` `mcp_tool_call` as a tool approval card, offering "Allow for this session" and "Always allow" as `_meta.persist` lists them, and answers with `_meta.persist` `session` or `always` | an MCP tool call asks to allow the server to run the tool; after "Allow for this session" the next call does not ask; after "Always allow" the project's `.claude/settings.local.json` allows `mcp__<server>__<tool>` |
| `declined-tool-items` | shows a `commandExecution` or `fileChange` item with status `declined` as declined, without output or an exit code | a declined command shows as declined and Claude goes on; a cancelled one stops the turn |
| `auto-review` | sends its auto-review preset as `approvalsReviewer` `guardian_subagent` (`auto_review` in newer builds), sets its picker from the `approvalsReviewer` of thread responses and `thread/settings/updated`, and draws `item/autoApprovalReview/completed` as a review card on the item named by `targetItemId` | on a model with auto mode the picker stays on auto-review and a call Claude's classifier blocks shows as declined with its reason; on one without, the picker goes back to the default with a config warning |

The full text of each rule, including the adapter side, is in
`src/app-compat.mts`.

## Unverified App builds

`VERIFIED_APP_VERSIONS` lists the App builds the rules were checked against.
When the desktop App connects with a version not on the list, the adapter still
serves it, and reports the version once per connection:

- as a `configWarning` notification, which the App shows under
  Settings > Agent > Configuration;
- on stderr, and as an `app.unverified` event in the debug log.

Other app-server clients (the App's LaTeX preview, the Codex TUI) are not
checked.

## Checking a new App build

Run the upgrade check against the new build. `--app` takes the App bundle,
its `app.asar`, or a directory `app.asar` was extracted to. The protocol comes
from the bundled `codex` binary, which the check finds inside the bundle (pass
`--codex` to point elsewhere). Where that binary cannot run (another platform,
an extracted directory), `--protocol-source` reads the protocol from a codex
checkout at the release tag of the App's codex instead, and `--bundle-only`
reads no protocol at all and takes the baseline's:

```sh
npm run check:app-upgrade -- --app /Applications/Codex.app
# or compare two bundles directly (each with its own codex)
npm run check:app-upgrade -- --app <new.app> --old <old.app>
# the protocol from codex's source (codex-rs/app-server-protocol)
npm run check:app-upgrade -- --app <new.app> --protocol-source <codex checkout>
# the bundle alone
npm run check:app-upgrade -- --app <new.app> --bundle-only
```

It compares the build with `scripts/app-baseline.json`, the last verified one,
and prints:

- **Protocol** — client requests, server requests and server notifications,
  added and removed. A client request the adapter has no `case` for, or a
  `case` that only throws `methodNotFound`, is answered with the JSON-RPC
  error `-32601` (`method not found: <method>`), which the App takes as "not
  supported here"; the report lists every such method. A method the adapter
  sends that the schema dropped is a problem. `--bundle-only` skips this part.
- **Methods the App names** — the method-shaped strings in the App's scripts:
  the client requests among them, and the names in a protocol namespace that
  the protocol does not have (methods of the App's other hosts, MIME types
  such as `model/obj`). A client request the App names that the adapter
  answers with `-32601` is a problem. With `--bundle-only`, so is a newly
  named method outside the baseline's protocol that the adapter has no `case`
  for, since it may be a new request; otherwise it is a note.
- **Feature gates** — the App's gate table, each marked on or off for the
  version the adapter reports, with new, changed and removed gates, and the
  minimum app-server version the App accepts. A gate that is on while the
  adapter answers one of its methods in `GATED_METHODS` with `-32601` is a
  problem; a new gate that is on and not in `GATED_METHODS` gets a note to
  find its methods and add them there (an empty list for a gate that needs
  none).
- **clientInfo names** — the names the App sends in `initialize`.
- **App rules** — the checklist above, to go through by hand with the App
  connected to the adapter.

It exits 1 when it finds a problem and 2 when it cannot run. Once the report
is clean and the rules hold:

1. Add the build to `VERIFIED_APP_VERSIONS` in `src/app-compat.mts`. If a rule
   changed, update it, the code it tags, and its tests.
2. Rewrite the baseline:
   `npm run check:app-upgrade -- --app <verified.app> --write-baseline`,
   with `--protocol-source` if the App's `codex` cannot run. It refuses while
   there are problems, the build is not yet listed, or with `--bundle-only`.
3. Commit both with the code changes.

## Feature gates and `CLAUDE_CODEX_COMPAT_VERSION`

The App decides which features to use from the app-server version in the
`initialize` userAgent, which the adapter takes from
`CLAUDE_CODEX_COMPAT_VERSION`. The default, `0.163.0-alpha.10.2`, is the Codex
build of the baseline App, 26.1013 (`codexVersion` in
`scripts/app-baseline.json`), so every gate that build knows is on. Codex
`0.163.0` has the same app-server protocol. Every gate App 26.930 knows needs
`0.159.0-alpha.12.1`, its own Codex build, or less, so it turns the same
features on as before. Against the previous default, `0.159.0-alpha.12.1`,
these gates of App 26.1013 are newly on:

- `threadAttachmentOwners`: before removing the worktree of a chat it
  archives, the App asks `thread/attachmentOwner/list` whether another chat
  still holds it. The adapter answers it.
- `turnLineage`: `parentTurnId` and `rootTurnId` on `turn/start`, and
  `rootTurnId` on every turn. The adapter keeps the root a `turn/start`
  names and reports it back (see the table below).
- `experimentalPredictionForkMode` and `misalignmentReviewTarget`, which no
  Claude thread reaches (see their entries in `GATED_METHODS`). Composer
  predictions fork only a thread whose `modelProvider` is `openai`; every
  thread here reports `claude-code`, and a test pins that.
- `asyncCompaction`, `guardianV2DecisionsComparison`, `incrementalTools`,
  `instantInterrupt`, `outputTokenReplay` and `preserveForkPrefix`, which only
  let a Codex feature key through in the config the App sends.

On macOS the App's LaTeX preview, a separate app-server client, needs
`0.149.0-alpha.4` or newer, and `0.162.0-alpha.20` for a project under `/tmp`
or `/var/tmp`; below that it says LaTeX previews need a newer Codex. The
default meets both. Raising the default for a newer App changes
`DEFAULT_CODEX_COMPAT_VERSION` in `src/util.mts` and the matching default in
`scripts/codex-shim`; tests keep the two equal and the default at the
baseline's `codexVersion`, and check:app-upgrade lists what each gate it
turns on needs.

`GATED_METHODS` in `src/app-compat.mts` maps each gate to the requests it adds
or changes, and `test/app-compat.test.mts` checks that the adapter answers
every one.
Gates follow from the version alone; they cannot be turned on or off one by
one. Run the upgrade check with the variable set to see which gates a version
turns on:

```sh
CLAUDE_CODEX_COMPAT_VERSION=0.149.0-alpha.4.1 npm run check:app-upgrade -- --app /Applications/Codex.app
```

A lower version keeps the App on its older paths. Below `0.148.0-alpha.14`, for
one, it keeps queued messages in the window instead of using the server-side
queue (`thread/queue/*`); the upgrade check notes this.

Every client request the verified App can send has a `case`. Where Claude Code
has no counterpart, the answer says so instead of failing: an empty list, a
disabled status (remote control), an `unavailable` error the App knows
(passkey verification), `null` for what the adapter does not track (token
counts in `account/usage/read`), or a GovCloud check that finds nothing to
warn about (rule `bedrock-govcloud`). Three requests of the 26.1013 protocol
that the App itself never sends, `thread/items/read`,
`thread/prediction/request` and `thread/readState/update`, get `-32601`, as
from a Codex without those features.

### What the gates change

Most gates change nothing the adapter sees, or turn on features that need a
ChatGPT account or an OpenAI model provider. These are the ones the adapter
answers in a particular way:

| Gate | With it on, the App… | The adapter… |
| --- | --- | --- |
| `turnToolOutput` | sends a thread handoff or a message from another thread as `turn/start` with empty `input` and the text in `toolOutput` | prompts Claude with it and records a `functionCallOutput` item (rule `tool-output-turns`) |
| `turnApprovalsReviewer` | follows a permission change during a turn with `turn/settings/update` carrying the new `approvalsReviewer` | switches the running session into or out of Claude Code's auto mode, and keeps the reviewer for the thread's later turns (rule `auto-review`) |
| `threadTimeline` | can read history with `thread/timeline/list`, newest page first | pages from the newest entry back |
| `mcpServerStatusByName` | passes `serverName` to `mcpServerStatus/list` | lists only that server |
| `mcpResourceReadOriginCallId` | checks `originCallId` on a resource read from a hosted app | answers `null`; Claude's MCP servers are not hosted apps |
| `serviceTierForTurn`, `turnTrigger` | add fields to the heartbeat's `turn/start` | ignores them |
| `threadAttachments` | records a chat's managed worktrees as thread attachments, cleans them up when it is archived, and offers worktree tools | keeps the attachments; see below |
| `threadAttachmentOwners` | asks `thread/attachmentOwner/list` which chats hold a worktree before it removes the worktree with an archived chat, and in the worktree settings | lists the threads holding the attachment by thread id, filtered by `archived` and paged by `cursor` and `limit` (25 by default). As in Codex, a fork holds the attachments its parent held when it forked (an ephemeral fork holds none), so it is listed too |
| `turnLineage` | passes `rootTurnId` (and `parentTurnId`) on `turn/start` when it starts work for another turn, and reads `rootTurnId` on every turn | reports on every turn payload the `rootTurnId` the `turn/start` named, or the turn's own id; a blank one names nothing, input that joins a running turn keeps that turn's root, a subagent's turn takes the root of the turn that spawned it, and a queued message or goal turn the adapter starts afterwards is its own root. `parentTurnId` is accepted and not kept |
| `threadForkBeforeTurn` | forks a chat from before one of its turns with `thread/fork` and `beforeTurnId`, instead of forking it whole and calling `thread/rollback` | forks the chat up to that turn: the fork's history and Claude's context stop before it (see Thread lifecycle in the capability matrix) |
| `threadItemAnchors` | pages a turn's items with `thread/items/list` from an `{ itemId }` cursor | pages from that item; an unknown item is an error, as in Codex |
| `audioInputs` | sends an attached audio file as `localAudio` input when `model/list` says the model takes audio | lists text and image input for every model, so the App sends no audio |
| `searchMcpClient` | reads `config/read`, `account/read` and `configRequirements/read` as a thread starts, to set up its search MCP for a `gpt-` model on a ChatGPT account | answers them as always; no thread here qualifies |

Two of them also depend on a flag the App reads from its server (Statsig),
which the bundle does not show and which can change without an App release:

- **`threadTimeline`** is used only when the App's history-timeline flag is
  on as well. Otherwise the App reads `thread/turns/list`, as before. The
  adapter serves both.
- **`threadAttachments`** adds the worktree tools (`create_worktree`,
  `attach_worktree`, `get_worktree_creation_status` and others) to the App's
  own tools for `thread/start`. On a local host it names them in `config`
  (`enabled_tools` of the bundled `codex_app` MCP server, which Codex runs);
  only on a remote host does it send them as `dynamicTools`. The adapter offers
  dynamic tools to Claude only with `CLAUDE_CODEX_DYNAMIC_TOOLS=1` (see
  [App tools](/guide/gui#app-tools)). The App's developer instructions, which
  describe these tools, are followed by a note naming the ones Claude lacks
  (rule `app-tool-availability`). With one
  more flag on, the App starts a chat in worktree mode in the local checkout
  and leaves creating the worktree to the agent's `create_worktree` call, so
  with Claude and the switch off the task would run in the local checkout. If
  that happens, turn the switch on or set
  `CLAUDE_CODEX_COMPAT_VERSION` below `0.155.0-alpha.2`. Archiving and the
  worktree cleanup do not need a ChatGPT sign-in: the App takes the owner from
  `account/read`, and `requiresOpenaiAuth: false` there is enough.
