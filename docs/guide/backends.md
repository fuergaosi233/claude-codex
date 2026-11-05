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

### agent-http and agentapi settings

`claude-codex-mode set agent-http|agentapi` writes the ones it needs into
`runtime.env`; set the others there or in the login shell.

```bash
# Bridge address (default http://127.0.0.1:3284). The first one set wins:
# CLAUDE_CODEX_HTTP_BASE_URL, CLAUDE_CODEX_AGENT_HTTP_URL, CLAUDE_CODEX_AGENTAPI_URL.
export CLAUDE_CODEX_HTTP_BASE_URL="http://127.0.0.1:3284"

# Start a bridge per thread cwd and model through `claude-codex-mode
# ensure-bridge` (45 s limit) and use the URL it prints; off by default, and
# set to 1 by `claude-codex-mode set agent-http|agentapi`. Title and summary
# turns still use the base URL. The helper command defaults to claude-codex-mode.
export CLAUDE_CODEX_HTTP_MANAGE_BRIDGE="1"
export CLAUDE_CODEX_MODE_COMMAND="claude-codex-mode"

# agent-http also listens on GET /events (on by default; 0 polls only).
# agentapi always polls.
export CLAUDE_CODEX_HTTP_USE_SSE="1"

# Poll interval in ms (default 500, kept within 100..60000) and how long a turn
# may run before it fails (default 300000, 5 minutes, kept within 1 s..24 h).
export CLAUDE_CODEX_HTTP_POLL_MS="500"
export CLAUDE_CODEX_HTTP_TIMEOUT_MS="300000"

# Also send Ctrl-C to the bridge as a raw message on interrupt (off by default).
export CLAUDE_CODEX_HTTP_INTERRUPT_RAW="1"
```

Flags count as on for `1`, `true`, `yes` or `on`; any other non-empty value is
off. A number that does not parse falls back to the default, one out of range
is clamped.

## claude-p

Runs `claude-p --output-format json --input-file ...` per turn and emits the
final assistant text. Not streaming, no `turn/steer`; defaults to one-shot turns
(some `claude-p` builds replay results when combining `--resume` with
`--input-file`).

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="claude-p"
export CLAUDE_CODEX_CLAUDE_P_COMMAND="claude-p"
# export CLAUDE_CODEX_CLAUDE_P_RESUME=1   # only after verifying --resume + --input-file

# Extra arguments placed before the adapter's own (a JSON array of strings, or
# split on whitespace).
# export CLAUDE_CODEX_CLAUDE_P_ARGS='["--flag","value"]'

# Per-turn limit in ms (default 300000, kept within 1 s..24 h). The adapter
# passes it on as --timeout in seconds and ends the process tree when it runs
# out. A run that hits that limit, or prints nothing but a StopTimeout on
# stderr, is retried this many times (default 1, kept within 0..5).
export CLAUDE_CODEX_CLAUDE_P_TIMEOUT_MS="300000"
export CLAUDE_CODEX_CLAUDE_P_STOP_TIMEOUT_RETRIES="1"

# Always pass --dangerously-skip-permissions (off by default). Without it the
# flag is passed only for turns with approval policy "never" or the
# danger-full-access sandbox.
# export CLAUDE_CODEX_CLAUDE_P_SKIP_PERMISSIONS=1
```
