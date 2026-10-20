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
Selecting it does not itself enable plan mode (see [Plan mode](#plan-mode)), so
an ordinary conversation may correctly run on Sonnet. Choose **Claude Opus** to
use Opus throughout. See the
[Claude Code model configuration](https://code.claude.com/docs/en/model-config#opusplan-model-setting).

## Plan mode

`/plan` and the composer's **Plan** toggle work in Claude chats as they do in
Codex chats. A turn sent in Plan mode runs in Claude Code's plan mode: Claude
explores read-only, may ask you questions, and hands its finished plan over,
which the App shows as a plan card. When the turn ends the App asks
**Implement this plan?**: accepting switches the chat back to Default and sends
the plan as a new turn, in which Claude carries it out; writing feedback instead
keeps Plan mode on for a revised plan. In Plan mode a tool call that would need
your approval (a command, an edit) is refused rather than asked about.

## Skills and the App's tools

Skills you pick with `$` or `/` in the composer work as they do in Codex chats.
Claude Code's built-in commands (`/simplify`, `/code-review`, …) run as slash
commands. For any other skill, the adapter adds its `SKILL.md` to what Claude
reads for that message, so Claude follows it without first looking for the
file. That covers the skills in your Claude Code and project `.claude/skills`
folders and the App's own skills Claude can run, up to 64 KiB per skill;
Claude reads any other skill file itself. Your message shows only the chip.

Context the App attaches to a message without showing it, such as the follow-up
after you connect a suggested plugin, reaches Claude after the message, marked
as data rather than instructions when the App does not vouch for it.

The App's instructions to the model describe tools only Codex chats have:
starting and messaging other threads, worktrees, automations and the sidebar.
Claude chats are told which of these they lack, so instead of searching for
them Claude asks you to use the App for such steps.

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
