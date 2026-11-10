# Backends

The adapter's internal Codex protocol layer talks to a small `ClaudeRuntime`
interface, so non-SDK Claude Code bridges can be selected without removing the
default Agent SDK route.

| Backend | Status | Streaming | Approvals / diffs |
| --- | --- | --- | --- |
| `agent-sdk-sidecar` (default) | Stable | Full (text, reasoning, tools) | Yes |
| `agent-http` / Channels | Experimental | Message-level deltas | No |
| `agentapi` | Experimental | Terminal-derived text | No |
| `claude-p` | Experimental | None (one-shot) | No |
| `codex` (native passthrough) | Stable | Native Codex | Native Codex |

Only the SDK route gets a message's context (injected items, a picked skill's
`SKILL.md`, the App's `additionalContext`) in blocks of its own. `agent-http`,
`agentapi` and `claude-p` get one flat text with the context ahead of the
message, so a Claude Code command (`/name args`) sent with any context does not
run there; see [Skills and the App's tools](/guide/gui#skills-and-the-app-s-tools).

Web search off (Settings > Configuration, or `CLAUDE_CODEX_WEBSEARCH=0` with no
mode saved there) takes Claude Code's WebSearch tool away on the SDK route and
`claude-p`, which gets the tools a thread must not have as `--disallowedTools`.
`agent-http` and `agentapi` run Claude outside the adapter, so Claude keeps
WebSearch there whatever the web search setting says, as Claude Code's own
setting decides [memories](/guide/gui#memories) there.

## Harnesses

With `CLAUDE_CODEX_NATIVE_CODEX=on`, each chat picks one of three harnesses from
the Codex App's model menu:

| Menu label | Model ids | Runs on |
| --- | --- | --- |
| Claude Code · … | Claude (and gateway) ids, as before | Claude Code through the Agent SDK |
| Codex · … | `gpt-*` | a real `codex app-server` on the `openai` provider (ChatGPT login) |
| Codex+AsterGate · … | `codex-ag:<model>` | a real `codex app-server` on `CLAUDE_CODEX_CODEX_AG_PROVIDER` |

Codex threads keep their sidebar record in the adapter and their conversation
in Codex: every request about the conversation is forwarded to the child, and
Codex's approvals, questions and notifications come back to the App as Codex
sends them. The real codex runs a thread's turns on its own config's
provider, so there is one child per provider, started on first use and stopped
after `CLAUDE_CODEX_NATIVE_IDLE_MS` of nothing to do.

A chat keeps its harness once it has a conversation: another model of the
same harness is fine, another harness asks for a new chat. A new chat's thread
exists before the user picks a model, so its first turn's model still picks the
harness. The App's title and summary helper threads run on Claude Code, so
they never spend the ChatGPT login.

## Switching routes

Install the host helper next to the shim:

```bash
install -m 0755 scripts/claude-codex-mode ~/.local/bin/claude-codex-mode
```

It rewrites `~/.claude-codex/runtime.env`, prepares the matching bridge daemon
(`agent-http` / `agentapi`), stops the current app-server so Codex App reconnects
into the new route, and provides readback commands:

```bash
claude-codex-mode list                 # selectable modes; current marked *
claude-codex-mode set agent-http opus  # switch route, restart bridge with Opus
claude-codex-mode model opus           # keep route; update default/bridge model
claude-codex-mode status               # mode, bridge health, recent logs
claude-codex-mode logs adapter|agent-http|agentapi
```

::: warning Model switching
Model switching is exact per turn for the SDK runtime and `claude-p` (the adapter
passes `model` directly). For `agent-http` / `agentapi` the bridge talks to a
long-lived Claude Code session, so changing the model means restarting that
bridge (`claude-codex-mode model <alias>`).
:::

::: warning Native codex passthrough
In `CLAUDE_CODEX_RUNTIME_TYPE=codex` the shim launches the real Codex
app-server, so the adapter is not in the process and cannot switch back from
in-App controls. Use `claude-codex-mode set codex` / `set agent-sdk-sidecar` on
the host and reconnect.
:::

## agent-http / Channels

Loads the bridge from `$CLAUDE_CODEX_AGENT_HTTP_DIR` (or `~/agent-http`) but
launches Claude Code from the thread cwd. Uses `POST /message`, `GET /messages`,
`GET /status`, `GET /events`; streams message-level deltas only (no semantic
tool / thinking / permission events).

```bash
claude-codex-mode set agent-http opus
```

## agentapi

Runs `agentapi server --type=claude` from the thread cwd and maps final agent
text into Codex messages. No rich approval / file-change events (terminal-derived
text only). Run `claude-codex-mode trust` if Claude's workspace-trust prompt
appears.

```bash
claude-codex-mode set agentapi opus
```

## claude-p

Runs `claude-p --output-format json --input-file ...` per turn and emits the
final assistant text. Not streaming, no `turn/steer`; defaults to one-shot turns
(some `claude-p` builds replay results when combining `--resume` with
`--input-file`).

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="claude-p"
export CLAUDE_CODEX_CLAUDE_P_COMMAND="claude-p"
# export CLAUDE_CODEX_CLAUDE_P_RESUME=1   # only after verifying --resume + --input-file
```
