# Using the Codex App

Once the shim and exports are installed and the adapter is built:

1. In **Codex App**, add a Remote connection to the host (or `localhost`). The
   app runs its native SSH probe and bootstrap; the shim routes `codex
   app-server` into the adapter.
2. Start a thread and send a prompt. Claude Code runs the turn:
   - Agent text and reasoning stream into the conversation.
   - `Bash` calls surface as Codex **command approvals**.
   - `Edit` / `Write` / `MultiEdit` surface as **file-change approvals** with a
     live diff that grows while Claude writes it.
   - Files Claude reads, searches and lists fold into **Explored** rows; see
     [How tool calls show](#how-tool-calls-show).
3. Approve actions in the Codex App UI as usual.
4. Disconnecting closes the proxy. Once no turn is active, the daemon idles out
   and the in-process Claude runtime is reclaimed.

## Picking a model

Codex App's model menu stays a **model selector** only — pick `Claude Sonnet`,
`Claude Opus`, `Claude Fable`, `Claude Haiku`, etc. The active Claude Code **route**
(which backend serves the turn) is chosen outside the App with the shim mode; see
[Backends](/guide/backends).

The default picker exposes Claude Code aliases; model availability and the version
an alias selects depend on your account, provider, and Claude Code version. The
list is not an account entitlement check. `CLAUDE_CODEX_MODELS` replaces the
default Claude list when you need to customize it. With
[model process profiles](/guide/configuration#model-process-profiles), the
Claude list is the profiles, each running its own Claude Code; a chat then
keeps its profile once it has a conversation, and picking another one asks for
a new chat. A chat whose profile changed or went away, or one from before
profiles were set up, still opens to be read, but sending it a message asks for
a new chat.

Each Claude model offers the reasoning efforts Claude Code reports for it:
**Max** on the models that take it, and no effort levels on Claude Haiku. Claude
Code reports them on the first Claude turn, and the App picks them up the next
time it reloads the model list, which it does when its window regains focus, at
most every five minutes. Until then every model offers Low to Extra High. The App
shows Max only after you turn it on under Settings > Agent > Model features >
Available reasoning efforts. See [Models & effort](/guide/configuration#models-effort).

**Claude Opus Plan / Sonnet Execute** keeps the `opus-plan` option ID and maps to Claude
Code's `opusplan` hybrid mode: Opus during planning, Sonnet during execution.
Selecting it does not itself enable plan mode, so an ordinary conversation may
correctly run on Sonnet. Choose **Claude Opus** to use Opus throughout. See the
[Claude Code model configuration](https://code.claude.com/docs/en/model-config#opusplan-model-setting).

A new chat runs on whichever model is picked before its first message. After
that it stays on that model's backend, since its conversation lives in a Claude
session or a Codex one and neither carries over. Picking a Codex model in a
Claude chat, or a Claude model in a Codex chat (unless the `codex-proxy` route
carries every chat), is refused: the App reports that it couldn't update the
model settings and the chat keeps its model. Pick another model from the same
family, or start a new chat for the other one. With
`CLAUDE_CODEX_DISABLE_CODEX_PROXY=1` the menu lists no Codex models and a new chat
on one is refused, while the App's own title and summary requests run on the
Claude summary model.

## Thinking and reasoning summaries

With the default native Claude Agent SDK backend, Claude's thinking shows
above its reply the way Codex shows a reasoning summary, while it streams and
after the chat is reopened. The adapter asks the Claude CLI for summarized
thinking (`--thinking-display summarized`), since recent models otherwise
return their thinking redacted, and streams each run of thinking into the
reasoning item's summary, the only part of it the App renders. Title and
compaction turns do not ask for it.

Thinking the adapter stored before it did this, as raw reasoning content,
shows as the summary when history is read.

To keep the thinking out of the conversation, set **Settings > Agent >
Configuration > Reasoning summary** to **None** (`model_reasoning_summary =
"none"`) or start the adapter with `CLAUDE_CODEX_REASONING_VISIBLE=0`. The
setting applies from the next turn. The thinking is then kept as raw reasoning
content, which the App does not show, and the CLI is not passed the flag; use
the variable as well with a Claude CLI pinned through `CLAUDE_CODEX_CLI` that
predates the flag. Whether a model or provider returns summarized thinking at
all is up to them; when it returns none, nothing shows.

## Retries and errors

When the Claude API is overloaded or unreachable, the Claude CLI retries the
request on its own. With the default native backend, each retry shows in the
turn as Codex shows a stream retry: a passing **Reconnecting 1/10** row that
counts up and leaves once Claude answers, with the HTTP status and the wait
under it. Like Codex, the adapter does not store these rows, so they are gone
when the chat is reopened. Retries inside a subagent do not show.

A turn that fails tells the App why, with the error code Codex would send:
the context window is full, the server is busy (HTTP 529), a rate limit, a bad
request, a server error, or a failed connection; anything else is a plain
error. An overloaded API shows as **Server is busy**. The adapter never sends
the codes the App answers with ChatGPT account flows, so a Claude
authentication or billing failure shows its message instead of a ChatGPT plan
upgrade or sign-in prompt.

Notices the Claude CLI would show an interactive user at once, such as a
failed compaction, go out as `warning` notifications, each once a turn. The
Codex App opts out of `warning` notifications in `initialize`, as it does with
Codex, so it does not show them; other clients do get them.

## The context gauge

The composer's context gauge shows how full Claude's context window is: the
size of Claude's latest request against the window of the chat's model. It
moves while a turn runs, after each request Claude makes, as it does for
Codex chats. Claude reports the window only when a turn ends, so in a chat's
first turn after the adapter starts, the gauge appears once that turn ends,
unless another chat on the same model has finished a turn since. Subagents'
tokens count towards the chat's total but leave the gauge alone.

## Branches in the sidebar

A chat whose folder is a git repository shows its branch in the sidebar, as
Codex chats do. The adapter looks up the commit, the branch and the `origin`
remote, without any credentials in its URL, when the chat starts and again
when each turn ends, so the label follows a branch Claude switches to or
creates. Listing chats never runs git; switching branches by hand shows after
the chat's next turn. Chats from before this version get their branch when
they are next opened.

## How tool calls show

Claude's tool calls show as the items Codex uses for its own:

- **Exploring files.** Claude's Read, Grep, Glob and LS calls show as commands
  named after the tool, such as `Read src/app.ts` or `Grep TODO in src`, and
  fold into an **Explored** row with the files read and the searches and
  lists run. A Bash command that only reads, searches or lists files, such as
  `cat`, `sed -n`, `rg`, `find` or `ls`, folds in the same way: the adapter
  parses it as Codex parses its own commands, following `cd` and skipping
  helpers such as `| head -n 20`. Anything else, including redirects,
  variables and globs, shows as the plain command. So does a command that
  can write files or start other programs, such as `find -delete`,
  `| xargs rm` or `| tee out.txt`, even where Codex would fold it. The App
  keeps the first 30,000 characters of a file or search result; Claude gets
  all of it.
- **Images.** A Read of an image file shows the image. If the Read fails, or
  the turn stops before it ends, it shows as the failed Read instead.
- **The web.** WebSearch shows as a web search, and WebFetch as opening the
  page it fetches.
- **MCP tools** show under their server's name. A server whose name contains
  `__` is named right when the turn's MCP configuration lists it.
- **Other Claude Code tools** show as tool calls of a `claude-code` server.

When Claude Code asks before a Read, Grep, Glob or LS call, for a file outside
the workspace for example, the App asks on the command card with the command
the item shows. The card names a command's reads and searches only when one of
them is the whole command, so it always shows everything that runs, and only a
Bash command can be allowed for the rest of the session.

Chats from before this version keep showing their earlier items.

## Inline visualizations

With the default native Claude Agent SDK backend, Claude can answer with a
chart, a diagram or a small interactive explainer that the Codex App renders
inside the conversation, the same way it does for Codex. Ask for one ("show
this as a chart", "draw the flow") or let Claude offer one where it helps.

![A Claude reply in the Codex App with an inline visualization: tiles for total signups, the peak month and quarter-over-quarter growth, a bar chart of six months of signups with the peak month highlighted and a dashed monthly average, a chart of month-over-month change, and a short summary of the trend](/images/inline-visualization.png)

*Asked for six months of signups as a bar chart, with the highest month
highlighted and the trend summed up below. The request was in Chinese, so are
the labels.*

**How Claude finds the skill.** Each time it starts, the App installs its
bundled plugins with `plugin/install`. The adapter remembers the `visualize`
plugin (in `config.json` under its state folder, so it survives restarts) and
lists the plugin's skill in the system prompt of each Claude thread, by name,
description and `SKILL.md` path, together with the line the App renders and the
thread's visualization folder. When a request calls for a visualization, Claude
reads the skill with its Read tool and follows it. Reads inside the skill's
folder and the thread's visualization folder need no approval; writes follow
the thread's approval policy as usual.

**What renders.** Claude writes an HTML fragment to a file and puts a line of
its own in its final reply, outside any code fence:

```text
::codex-inline-vis{path="/absolute/path/to/sales-by-region.html"}
```

The App loads the fragment into its visualization sandbox, styled with its
theme. Claude adds `mode="wide"` to the line where the skill asks for a wide
layout.

The skill also shows a second form of the line, `visualize{"path":"…"}` between
invisible marks. When Claude writes that line without the marks, the App would
show it as text, so the adapter adds them once the message completes and when
history is read: the line renders at the end of the reply and after the chat is
reopened. While the reply streams it shows as written, and a line inside a
code fence is left alone.

**New chats only.** The App finds a thread's visualizations through the
creation date in its id, and reads them only for UUIDv7 ids, which is what
Codex issues. The adapter issues UUIDv7 ids for new threads, forks and
subagents. Chats it created before that keep working but cannot render inline
visualizations, so Claude is not offered the skill there; start a new chat to
use it.

**File rules.** The App reads a fragment only when:

- its file name matches `^[a-z0-9]+(-[a-z0-9]+)*\.html$`, such as
  `sales-by-region.html`;
- its path is absolute and lies inside the thread's visualization folder,
  `<CODEX_HOME>/visualizations/<YYYY>/<MM>/<DD>/<thread id>/` (`CODEX_HOME`
  defaults to `~/.codex`; the date is the thread's creation date in UTC),
  inside the thread's workspace or writable roots, or
  in `/tmp` where the thread's sandbox allows it, with no symlink on the way;
- it is at most 5,000,000 bytes.

The prompt asks Claude to save fragments in the thread's visualization folder,
which meets the location rule. A fragment that breaks a rule does not render.

## File changes while Claude writes them

With the default native Claude Agent SDK backend, a file change shows up before
Claude has finished writing it. The card of an `Edit`, `Write` or `MultiEdit`
call opens as soon as the input Claude streams names the file, and grows about
twice a second while Claude writes the rest, the way the Codex App draws a
patch Codex is still writing. How smoothly it grows depends on how the API in
use streams a tool's input; one that sends the input at once shows the card
when the call is complete.

Once the call is complete, the card holds the finished change, and so does the
approval when the thread asks for one. When a response breaks off in the
middle of a call and Claude asks again, the unfinished card shows as failed and
the new call gets a card of its own. Set `CLAUDE_CODEX_LIVE_FILE_CHANGES=0` to
show a change only once Claude has written the whole call.

## Pull Requests panel

The App's Pull Requests panel is drawn by its bundled `code-review` plugin. The
App turns the plugin's MCP server on with a `-c` setting when it starts the
app-server, then calls it on server `code-review` with `mcpServerStatus/list`,
`mcpServer/tool/call` and `mcpServer/resource/read`, and finds the panel's
entry points in the `_meta` of the tools the server lists. The App does this
only for an app-server it starts on the same machine, not for a remote host. A
Codex app-server runs that server itself; the adapter does so only when asked:

```bash
export CLAUDE_CODEX_APP_PLUGIN_MCP=1
```

With it set, the adapter finds the plugin's servers from the plugins enabled in
`CODEX_HOME/config.toml` (and the ones the App installs with `plugin/install`),
the plugin's `.codex-plugin/plugin.json` and its `.mcp.json`, and runs a server
the App's `-c` settings or `config.toml` turn on:

- with the plugin's folder as its working directory and the command and
  arguments from `.mcp.json`;
- with `CODEX_MCP_NODE_PATH` passed on from the adapter's environment, or set to
  the Node.js binary running the adapter;
- with only `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TERM`,
  `TMPDIR`, `TZ` and the variables the server's `env_vars` lists, leaving out
  any whose name looks like a credential (`*TOKEN*`, `*SECRET*`, `*_KEY` and
  the like);
- as one long-lived process for the adapter, started on first use, restarted
  if it exits, and stopped with the adapter.

The plugin uses the host's GitHub credentials, for example an existing `gh`
login (`gh auth login`); the adapter never reads, logs or passes on a token. The
panel can then list pull requests, open one and show its checks and comments.
Two parts depend on Codex itself:

- **Starting a review** runs `codex exec` through `CODEX_CLI_PATH`, which the
  App points at its own `codex`. With the adapter installed as that binary, the
  review only runs when the real Codex CLI is reachable and signed in;
  otherwise the panel shows the error. It never starts a Claude thread.
- **The ChatGPT-backed GitHub connection** has the plugin start its own
  `codex app-server` for the sign-in. The adapter refuses to start for it (a
  second adapter would take over the first one's chats), so that connection
  is unavailable and the plugin uses `gh`.

`CLAUDE_CODEX_APP_PLUGIN_MCP` also takes a comma-separated list of plugin names
(`code-review,other-plugin`), whose enabled stdio servers run the same way.
The App's own `codex-app-tools` and `browser-use` plugins, and the `codex_app`
server, are never run. The servers are only for the App's calls: Claude
threads do not get them, and the App's MCP panel lists them next to the
thread's own servers.

## Background work and the unread dot

Claude can leave background subagents (`run_in_background` Agent calls) and
workflows running after a turn ends. A turn that ends while any of these still
run does not mark the chat unread or send a desktop notification, because its
answer is usually only "started, I'll report back". When the work finishes,
Claude answers in a new turn, and that turn lights the unread dot as usual
(unless other work is still running then). Backgrounded Bash commands do not
count: a dev server or a watcher can run for hours (see
[Background commands](#background-commands)) and would otherwise keep every
later turn quiet.

To do this the adapter ends the quiet turn's last message with the Codex App's
own `<heartbeat>` block deciding `DONT_NOTIFY`. The App hides the block; Claude
never sees it, not even through a leader's `thread_wait` or `thread_read` (see
[Leader chats](#leader-chats)), which mark such a turn `backgroundWorkRunning`
instead. Other clients, such as the Codex CLI, show it as text. A turn with no
message from Claude still lights the dot. Set
`CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0` to mark every finished turn unread.

## Memories

Codex remembers across chats with memories it distills from earlier ones.
Claude Code has auto-memory instead: notes it keeps for each project in a
memory folder under its config folder (by default
`~/.claude/projects/<project>/memory/`), loads when a session starts and
updates as it works.

By default the adapter leaves auto-memory to Claude Code's own settings: the
App shows no Memories settings and no `/memories` command, and a Claude chat
remembers exactly as Claude Code in a terminal would. Start the adapter with
`CLAUDE_CODEX_MEMORIES=1` to let the App's memories switches decide instead:

- **Off until you turn it on.** As in Codex, Memories is a beta feature that
  starts off. Turn it on under **Settings > Personalization**; `/memories` then
  shows in the composer. While it is off, every Claude chat runs with
  auto-memory switched off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), even where
  Claude Code would otherwise use it. That is why the switch exists: turning it
  on stops auto-memory in every App chat until you turn Memories on.
- **Per chat.** A new chat follows the switches in Settings, or its own when
  you set them before sending; `/memories` turns memories on or off for the
  chat you are in. Claude reads and writes its memory under one switch, so a
  chat remembers only while both generating and using memories are on. A change
  applies from the chat's next turn, or, while background work keeps the chat's
  Claude session open, once that session ends.
- **Shared with Claude Code.** The notes are Claude Code's own, and Claude Code
  in a terminal uses the same folders for the same project. The adapter never
  reads them. **Delete** under Settings > Personalization leaves them alone, and
  the App reports that it could not delete memories; review or delete them with
  Claude Code's `/memory` command.
- **Claude Code's own setting still counts.** A chat with memories on adds
  nothing to Claude's environment, so `autoMemoryEnabled: false` in Claude
  Code's settings, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY` set to turn it off,
  still keeps auto-memory off.

The default backend and `claude-p` follow the switches. The `agent-http` and
`agentapi` backends run Claude outside the adapter, so Claude Code's own
setting decides there.

With or without `CLAUDE_CODEX_MEMORIES`, the adapter refuses `memory/reset`
rather than delete Claude Code's notes.

## App tools

On a remote connection the Codex App registers tools of its own when it starts
a chat, in its `codex_app` namespace (`list_artifacts`, and the worktree tools
when its worktree features are on). Codex calls them by asking the App with
`item/tool/call`. Set `CLAUDE_CODEX_DYNAMIC_TOOLS=1` and Claude gets them too:
each namespace becomes an in-process MCP server of the same name (tools without
a namespace share one named `dynamic_tools`), so Claude sees
`mcp__codex_app__list_artifacts`. A call goes to the App with the running turn,
shows as a dynamic tool call card, and its result goes back to Claude. As in
Codex, the calls run without an approval prompt.

The switch is off by default because these tools act on your desktop through
the App. With it on:

- The tools belong to the chat. They are stored with the thread, so the chat
  keeps them when it is resumed (also after an adapter restart) and a fork
  gets its parent's. Chats started while the switch was off have none.
- The App checks the turn a call names and cancels a call that arrives after
  the turn ended. Interrupting a turn cancels the calls still waiting for the
  App.
- Plan mode does not offer them. A subagent's calls show in the parent chat.
- Claude reads the text of a result and inline PNG, JPEG, GIF and WebP images.
  Audio and other images reach it as a placeholder.
- A tool the App marks `deferLoading` waits for Claude Code's tool search, like
  other deferred MCP tools. A tool whose `mcp__<namespace>__<tool>` name would
  pass Claude's 64-character limit is left out, and so is a namespace named like
  an MCP server Claude already has.

## Leader chats

With `CLAUDE_CODEX_LEADER_TOOLS=1` in the adapter's environment (off by default),
Claude in a chat you started can start other Claude chats and drive them: ask it
to "start three chats, one per service, and tell me when they are done". Each
one is an ordinary chat in the Codex App sidebar, which you can open, approve
requests in and keep talking to. The tools, in the `codex_leader` MCP server,
need the default native Claude Agent SDK backend:

| Tool | What it does |
| --- | --- |
| `thread_start` | Starts a chat with a first prompt; `cwd` and `model` default to the leader's. Returns at once, with a `::created-thread` line for Claude to repeat in its reply. |
| `thread_list` | The chats this one started, each `working`, `blocked` (waiting on you), `done-unread` (finished a turn the leader has not read) or `idle`. `scope: "all"` adds your other recent chats. |
| `thread_wait` | Waits until `any` (default) or `all` of the given chats finish their turn or get blocked, then returns each one's status and last agent message, truncated. |
| `thread_prompt` | Sends a chat a message, as you would: into its running turn while it works (the App's default for follow-ups), otherwise as a new turn. `wait: true` also waits for that turn. |
| `thread_read` | A chat's transcript as structured items in pages of bounded size, with a cursor for reading only what is new. |

When Claude's reply repeats the `::created-thread{threadId="…"}` line, the
Codex App shows a card for the new chat in the reply, as it does for chats Codex
starts with its own thread tools. These tools come from the adapter, not from
the App's thread tools, and are named differently.

Limits that always apply:

- Only chats you start get the tools. Chats a leader starts, their forks,
  subagents and ephemeral chats do not, so no chain of chats fans out on its own.
- A leader has at most `CLAUDE_CODEX_LEADER_MAX_RUNNING` (default 4) of its chats
  working at once; `thread_start` and `thread_prompt` refuse past that.
- A leader never answers approvals or questions. A chat that waits on one shows as
  `blocked`, `thread_prompt` refuses it, and Claude is told to send you there.
- Started chats inherit the leader's approval policy, sandbox and permissions, and
  ask for their own approvals. A leader with no policy set asks before tools run,
  and so do the chats it starts. They are Claude chats only for now, and
  `thread_start` refuses while new chats run on the Codex proxy backend.
- In plan mode a leader can only list, wait for and read its chats.
- Which chat leads which is stored with the threads, so it survives restarts.

For research, review or splitting up one task, Claude's own Agent tool is faster
and cheaper: the tool descriptions steer Claude to use the leader tools only when
you want separate chats.

## Background commands

A Bash command Claude runs in the background, such as a dev server, a watcher
or a long build, keeps showing its output in the command item of the Bash call
that started it, also after the turn has ended. Stopping the App's background
terminals stops these commands too.

Claude Code 2.1.285 and later stops a background command in an Agent SDK
session, which is how the adapter runs Claude, after a time limit: 30 minutes,
or the `timeout` Claude gave the command, up to 2 hours. Commands started from
Claude Code in a terminal have no such limit. A command that was stopped,
failed or reached its time limit ends its item with Claude Code's note on how
it ended, for example
`[Background command "npm run dev" was stopped after reaching its background time limit]`.

## Localhost GUI testing on macOS

For localhost GUI testing, the adapter is launched by SSH and the in-process TS
runtime invokes the Claude Code CLI directly — no external daemon to manage. Put
these lightweight exports in `~/.zshenv`:

```bash
REPO="$HOME/path/to/claude-codex"
export PATH="$HOME/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$REPO/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$(command -v node)"
export CLAUDE_CODEX_CLI="$(command -v claude)"
export CODEX_REAL="$(command -v codex)"
```

`npm run acceptance:gui-ssh-localhost` drives this exact path end-to-end (real
daemon + proxy over SSH, real Claude turn, approval bridge, diff events) and is
the closest automated check to the GUI Remote experience.
