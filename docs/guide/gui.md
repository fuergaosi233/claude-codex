# Using the Codex App

Once the shim and exports are installed and the adapter is built:

1. In **Codex App**, add a Remote connection to the host (or `localhost`). The
   app runs its native SSH probe and bootstrap; the shim routes `codex
   app-server` into the adapter.
2. Start a thread and send a prompt. Claude Code runs the turn:
   - Agent text and reasoning stream into the conversation.
   - `Bash` calls surface as Codex **command approvals**.
   - `Edit` / `Write` / `MultiEdit` surface as **file-change approvals** with a
     live diff.
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
default Claude list when you need to customize it.

**Claude Opus Plan / Sonnet Execute** keeps the `opus-plan` option ID and maps to Claude
Code's `opusplan` hybrid mode: Opus during planning, Sonnet during execution.
Selecting it does not itself enable plan mode, so an ordinary conversation may
correctly run on Sonnet. Choose **Claude Opus** to use Opus throughout. See the
[Claude Code model configuration](https://code.claude.com/docs/en/model-config#opusplan-model-setting).

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
failed compaction, show as warnings, each once a turn.

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
  variables and globs, shows as the plain command. The App keeps the first
  30,000 characters of a file or search result; Claude gets all of it.
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

## Background work and the unread dot

Claude can leave background subagents (`run_in_background` Agent calls) and
workflows running after a turn ends. A turn that ends while any of these still
run does not mark the chat unread or send a desktop notification, because its
answer is usually only "started, I'll report back". When the work finishes,
Claude answers in a new turn, and that turn lights the unread dot as usual
(unless other work is still running then). Backgrounded Bash commands do not
count: a dev server or a watcher can run for the rest of the chat and would
otherwise keep every later turn quiet.

To do this the adapter ends the quiet turn's last message with the Codex App's
own `<heartbeat>` block deciding `DONT_NOTIFY`. The App hides the block; Claude
never sees it. Other clients, such as the Codex CLI, show it as text. A turn
with no message from Claude still lights the dot. Set
`CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0` to mark every finished turn unread.

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
