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
| `config-warnings` | lists `configWarning` notifications under Settings > Agent > Configuration | an unlisted build shows the warning there |
| `bedrock-account` | filters the model picker through its OpenAI allowlist unless `account/read` returns a Bedrock account | the picker lists the Claude models |
| `bedrock-auth-status` | reads its feature flags in the main process only when `getAuthStatus` names the auth method it derives from `account/read`; otherwise a thread it resumes on its own never becomes ready | a message queued during a turn is sent when the turn ends; a new chat gets a title |
| `skills-popup` | fills the "/" popup from `skills/list` and sends a picked skill as a `[$name](path)` link | `/simplify` is listed and runs |
| `optimistic-user-message` | draws its own user message for every `turn/start` it sends | a message shows once; a queued one when it starts |
| `tool-output-turns` | with `turnToolOutput` on, sends a thread handoff or a message from another thread as a `turn/start` with empty input and the text in `toolOutput`, and shows a `functionCallOutput` item as that turn's user message | a chat handed off to a new thread shows the text, and Claude answers it |
| `steer-errors` | matches `turn/steer` error texts to fall back to a new turn or retry another turn id | a message sent as a turn ends still arrives |
| `steer-bubble` | settles the steering bubble when a `userMessage` item carries its `clientUserMessageId` | a steer shows once, in the transcript |
| `subagent-completed-kind` | renders the completed `subAgentActivity` kind from 26.930 without declaring it | a finished subagent shows as done |
| `subagent-close-hides` | removes a child from the panel when `closeAgent` follows its successful wait | a finished subagent stays in the panel |
| `completed-wait` | marks every working agent of the thread done when a wait completes | with two agents, the first to finish does not end the second |
| `agent-states` | shows `interrupted` as done and `errored` as failed | a stopped subagent shows as done |
| `subagent-read` | reads a child with `includeTurns: false` and shows one without turns as loading | a finished subagent opens with its prompt and reply |
| `child-prompt` | creates the child conversation from `thread/started` with an empty turn | a running subagent shows its prompt |
| `rate-limit-banner` | shows a banner for every `account/rateLimits/updated` | no banner after an ordinary reply |
| `projects` | holds project writes until `project/list` answers, and matches the `project not found` and deleted-key error texts | a project and a chat moved into it survive an App restart |
| `delete-missing-rollout` | retries `thread/delete` with `missingRolloutRecovery` after `no rollout found for thread id <id>` | deleting all archived chats empties the list |
| `inline-visualizations` | renders an HTML fragment from a `::codex-inline-vis{path="…"}` line, reading it only for a UUIDv7 thread id, and installs its bundled `visualize` plugin with `plugin/install` each time it starts | in a new chat, a chart Claude is asked for renders inside the reply |
| `visualize-line` | renders an inline visualization from a line holding `visualize` and its JSON wrapped in the private-use marks its visualize skill documents, and shows the same line without the marks as text | a reply that names a visualization as a plain `visualize{…}` line shows it rendered, also after the chat is reopened |

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

Run the upgrade check against the new bundle. It needs the bundled `codex`
binary, which it finds inside the bundle (pass `--codex` to point elsewhere):

```sh
npm run check:app-upgrade -- --app /Applications/Codex.app
# or compare two bundles directly
npm run check:app-upgrade -- --app <new.app> --old <old.app>
```

It compares the build with `scripts/app-baseline.json`, the last verified one,
and prints:

- **Protocol** — client requests, server requests and server notifications the
  bundled `codex` generates, added and removed. A new client request the adapter
  has no `case` for will be answered with `method not implemented`; the report
  lists every such method. A method the adapter sends that the schema dropped is
  a problem.
- **Feature gates** — the App's gate table, each marked on or off for the
  version the adapter reports, with new, changed and removed gates, and the
  minimum app-server version the App accepts. A gate that is on while one of
  its methods in `GATED_METHODS` has no `case` is a problem; a new gate that is
  on gets a note to find its methods and add them there.
- **clientInfo names** — the names the App sends in `initialize`.
- **App rules** — the checklist above, to go through by hand with the App
  connected to the adapter.

It exits 1 when it finds a problem and 2 when it cannot run. Once the report
is clean and the rules hold:

1. Add the build to `VERIFIED_APP_VERSIONS` in `src/app-compat.mts`. If a rule
   changed, update it, the code it tags, and its tests.
2. Rewrite the baseline:
   `npm run check:app-upgrade -- --app <verified.app> --write-baseline`.
   It refuses while there are problems or the build is not yet listed.
3. Commit both with the code changes.

## Feature gates and `CLAUDE_CODEX_COMPAT_VERSION`

The App decides which features to use from the app-server version in the
`initialize` userAgent, which the adapter takes from
`CLAUDE_CODEX_COMPAT_VERSION`. The default, `0.159.0-alpha.12.1`, is the Codex
build of the verified App (`codexVersion` in `scripts/app-baseline.json`), so
every gate in its table is on and the App calls the methods behind them.
`GATED_METHODS` in `src/app-compat.mts` maps each gate to the requests it adds
or changes, and `test/app-compat.test.mts` checks that every one has a `case`.
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
(passkey verification), or `null` for what the adapter does not track (token
counts in `account/usage/read`).

### What the gates change

Most gates change nothing the adapter sees, or turn on features that need a
ChatGPT account or an OpenAI model provider. These are the ones the adapter
answers in a particular way:

| Gate | With it on, the App… | The adapter… |
| --- | --- | --- |
| `turnToolOutput` | sends a thread handoff or a message from another thread as `turn/start` with empty `input` and the text in `toolOutput` | prompts Claude with it and records a `functionCallOutput` item (rule `tool-output-turns`) |
| `turnApprovalsReviewer` | follows a permission change during a turn with `turn/settings/update` carrying the new `approvalsReviewer` | accepts `user`, the only reviewer it has; any other is rejected, which the App only logs |
| `threadTimeline` | can read history with `thread/timeline/list`, newest page first | pages from the newest entry back |
| `mcpServerStatusByName` | passes `serverName` to `mcpServerStatus/list` | lists only that server |
| `mcpResourceReadOriginCallId` | checks `originCallId` on a resource read from a hosted app | answers `null`; Claude's MCP servers are not hosted apps |
| `serviceTierForTurn`, `turnTrigger` | add fields to the heartbeat's `turn/start` | ignores them |
| `threadAttachments` | records a chat's managed worktrees as thread attachments, cleans them up when it is archived, and offers worktree tools | keeps the attachments; see below |

Two of them also depend on a flag the App reads from its server (Statsig),
which the bundle does not show and which can change without an App release:

- **`threadTimeline`** is used only when the App's history-timeline flag is
  on as well. Otherwise the App reads `thread/turns/list`, as before. The
  adapter serves both.
- **`threadAttachments`** adds the worktree tools (`create_worktree`,
  `attach_worktree`, `list_artifacts` and others) to `thread/start` as
  `dynamicTools`. The adapter does not offer dynamic tools to Claude. With one
  more flag on, the App starts a chat in worktree mode in the local checkout
  and leaves creating the worktree to the agent's `create_worktree` call, so
  with Claude the task would run in the local checkout. If that happens, set
  `CLAUDE_CODEX_COMPAT_VERSION` below `0.155.0-alpha.2`. Archiving and the
  worktree cleanup do not need a ChatGPT sign-in: the App takes the owner from
  `account/read`, and `requiresOpenaiAuth: false` there is enough.
