# Claude Codex Adapter

[![CI](https://github.com/fuergaosi233/claude-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/fuergaosi233/claude-codex/actions/workflows/ci.yml)
[![Docs](https://github.com/fuergaosi233/claude-codex/actions/workflows/deploy-docs.yml/badge.svg)](https://fuergaosi233.github.io/claude-codex/)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

Production TypeScript adapter that lets the **Codex desktop app** talk to
**Claude Code** through the native Codex `app-server` protocol in Remote mode.

Codex App still runs its normal SSH version probe, bootstrap, and `app-server
proxy` flow — but `codex app-server` is handled by this adapter instead of the
real Codex runtime, so agent turns run on Claude Code.

📖 **Documentation: <https://fuergaosi233.github.io/claude-codex/>**

## Quick start

```bash
npm install
npm run build        # tsc -> dist/ (production artifact)
npm run dev          # tsx src/adapter.mts — run sources directly, no build
npm run doctor       # environment self-check
```

> **Requires Node.js 24+** for stable `node:sqlite`. Set `CLAUDE_CODEX_NODE` to
> pin a node binary if your default is older.

Then install the `codex` shim on the remote host and add a Remote connection in
the Codex App:

```bash
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex && chmod +x ~/bin/codex
export PATH="$HOME/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$PWD/dist/src/adapter.mjs"
export ANTHROPIC_API_KEY="<your-anthropic-api-key>" # or authenticate with `claude /login`
```

Provide credentials only through your local shell or secret manager. Do not
commit API keys, OAuth/session data, `.env` files, or acceptance-test logs.

Full walkthrough → **[Getting started](https://fuergaosi233.github.io/claude-codex/guide/getting-started)**.

## How it works

```
Codex App ──SSH──▶ login shell ──▶ codex (shim, earlier in PATH)
                                     │
                  app-server calls ──┘──▶ Claude Codex Adapter ──▶ Claude Code
                  everything else  ──────▶ real Codex CLI (CODEX_REAL)
```

Agent text and reasoning stream into the conversation; `Bash` becomes command
approvals; `Edit`/`Write`/`MultiEdit` become file-change approvals with live
diffs. Runtime selection maps only to existing backend paths today: default
in-process Claude Agent SDK, `agent-http`, `agentapi`, `claude-p`, `codex-proxy`,
and `mock`.

### Desktop conversation and visual explanations

The native Claude Agent SDK backend receives presentation guidance modeled on
Claude Desktop's conversational style: natural explanations, enough detail for
complex questions, and formatting chosen for the content instead of a fixed
engineering report. Questions invite discussion; requests for action still use
and verify tools. Progress updates explain meaningful transitions while native
tool events retain execution details.

The guidance describes Codex desktop's Markdown and Mermaid rendering. For
explanations that benefit from a diagram, Claude is encouraged to use a fenced
`mermaid` flowchart or sequence diagram, while keeping simple answers brief and
respecting requested language and formats. This supplements the Claude Code
preset and preserves explicit project/developer/personality preferences. No global
`~/.claude/CLAUDE.md` changes are needed; schema-constrained turns do not receive
this presentation guidance.

Rendering is provided by the Codex app version you use. The adapter preserves the
Markdown in streaming and history; it does not bundle a diagram renderer or a
Claude Desktop Artifacts runtime. Arbitrary HTML/React code fences do not become
interactive apps. Older clients may show Mermaid source instead of a diagram.

### Project instructions

Claude threads follow the same `AGENTS.md` files Codex would: the global one in
`CODEX_HOME` (`AGENTS.override.md` first), then one per folder from the git root
down to the thread's folder, within Codex's 32 KiB project budget. They reach
Claude in the system prompt with Codex's framing, and the App lists them as the
thread's instruction sources. Files Claude Code already reads itself through a
`CLAUDE.md` import are not sent twice.

When the Claude CLI runs with its setting sources turned off, set
`CLAUDE_CODEX_CLAUDE_CONFIG_DIR` (usually `~/.claude`) to bring that Claude Code
configuration along: the user and project `CLAUDE.md` files with their
`@imports`, `CLAUDE.local.md`, `.claude/rules/` (rules scoped by `paths:` are
listed for Claude to read when they apply), and the user and project skills. The
folder's MCP servers, subagents, permission rules and hooks come along only with
their own switches (see below), as the Codex config's servers do.

### Inherited configuration

With `CLAUDE_CODEX_CODEX_MCP_SERVERS=1`, Claude threads start the MCP servers in
the Codex config: `[mcp_servers.<name>]` in `CODEX_HOME/config.toml`, plus the
`.codex/config.toml` files of a project Codex trusts. This is off by default
because the Codex App writes its own desktop servers (such as a computer-use
client and a Node REPL) into `config.toml` for Codex threads, and those would
otherwise land in every Claude thread. Stdio servers keep their `args`, `env`,
`env_vars` and `cwd`; streamable HTTP servers keep their headers and bearer
token. The server configs reach the CLI in a file only the user can read, in the
adapter's home, removed when the CLI session ends, rather than on the CLI's
command line, where any local process can read them. The values `env_vars`,
`env_http_headers` and `bearer_token_env_var` name stay out of that file too: it
refers to them as `${NAME}`, and the CLI fills them in from the environment it
gets from the adapter. So a launcher that rebuilds the CLI's environment from an
allowlist drops them, and like any server config's references they never take
the CLI's own credentials nor, toward a remote server, a credential name on the
CLI's list (such as `VAULT_TOKEN` or `NPM_TOKEN`), which arrives empty: give
such a value another name. Values written into the Codex config are passed on as
written, `${...}` included, as Codex passes them. A server with
`enabled = false` stays off, `disabled_tools` are withheld from Claude, a call
to a tool outside `enabled_tools` is refused, and `tool_timeout_sec` becomes the
server's tool-call timeout. Codex OAuth logins, `startup_timeout_sec`,
`required`, per-tool approval settings and the servers plugins bring are not
carried over.

With `CLAUDE_CODEX_CLAUDE_CONFIG_DIR` set and
`CLAUDE_CODEX_CLAUDE_MCP_SERVERS=1`, Claude threads start the Claude Code
servers: user-scope servers and the project's local-scope servers from the
global config file (`~/.claude.json` for `~/.claude`), and the servers of the
project's `.mcp.json` files (from the repository root down to the thread's
folder) once the project is trusted and the server is approved in the user's own
settings (`enabledMcpjsonServers` or `enableAllProjectMcpServers`). The project
is trusted when Codex trusts it or the user accepted Claude Code's trust dialog
for the project itself, that is the repository's main checkout (a worktree
shares it) or the folder outside a repository; trust accepted for a folder above
does not count. A checkout's `.git` file is the checkout's to write, so it only
leads to a main checkout when git's own records vouch for the link: the
worktree's folder in that repository's `.git/worktrees` points back at it. The
checked-in `.claude/settings.json` cannot approve servers, and neither can a
`.claude/settings.local.json` that is checked in (under any spelling of its
path, since the file system may ignore case where git does not), reached
through a symlink anywhere below the repository root or in a checkout whose
`.git` file git does not vouch for, since that file then comes from the
repository rather than the user. A server's
`${VAR}` references are left for the CLI to fill in from its environment, as it
does for its own config files, and a local-scope server's `headersHelper` runs
only in a trusted project. A Claude Code server wins a name over a Codex one,
and `CLAUDE_CODEX_MCP_SERVERS` wins over both. Only the thread's own turns get
these servers, not summaries or other internal turns; the App's MCP panel lists
those of the thread it asks about.

With `CLAUDE_CODEX_CLAUDE_AGENTS=1`, the bridged Claude Code folder also brings
its subagents: `agents/*.md` in it, then `.claude/agents/*.md` from the git root
down to the thread's folder, a project agent winning a name over a user agent.
Their `name`, `description`, `tools`, `disallowedTools`, `model`, `skills`,
`maxTurns`, `effort`, `memory`, `background`, `initialPrompt` and named
`mcpServers` carry over; `permissionMode`, `hooks` and inline server definitions
do not, since the Codex approval policy decides what runs.

With `CLAUDE_CODEX_CLAUDE_PERMISSIONS=1`, its permission rules apply as well.
`permissions.deny` from the user's `settings.json` and the project's
`.claude/settings.json` and `.claude/settings.local.json` always applies: a
denied tool stays refused whatever the approval policy. So does
`permissions.ask`: the CLI takes no ask rules outside a settings file, so the
adapter registers a `PreToolUse` callback that sends the calls they cover to the
Codex approval prompt, even when an allow rule or a hook would approve them. It
matches them as Claude Code does and errs towards asking: a Bash rule covers
each command of a compound command line and what wrappers such as `timeout`,
`xargs` or `sh -c` run, a command line with command substitution, a heredoc or
a command named by a variable is asked about under any Bash rule, since it could
run anything, and an `Edit` rule covers every tool that edits files, a `Read`
rule `Glob` and `Grep` by the folder they search. Under Full Access the prompt
is approved without asking, as every other one is; in plan mode an asked-for
call is refused. `permissions.allow` lets matching tool calls run without a
Codex approval prompt; the user's rules always count, a project's only once the
project is trusted (those of a `settings.local.json` the repository supplies
never), and none in plan mode or a read-only sandbox, where Codex would not let
those tools run unasked. A user rule's `/path` stays relative to the config
folder, as in Claude Code. `defaultMode` and `additionalDirectories` are not
carried over: the Codex approval policy and sandbox decide the mode and the
folders.

Its command hooks run only when asked for too: they are often status or
notification integrations for terminal sessions, and running them for every App
chat would silently change what they do (a hook that waits for input would even
hold up the turn). `CLAUDE_CODEX_CLAUDE_HOOKS=user` runs the hooks in the
bridged folder's `settings.json`; `CLAUDE_CODEX_CLAUDE_HOOKS=project` also runs
those of a trusted project's `.claude/settings.json` and
`.claude/settings.local.json`, so a repository never runs a command on its own
say; unset, `0` or any other value runs none. They run for `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`,
`SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd` and
`Notification`. The adapter registers each command with the Claude Agent SDK;
the CLI matches it as it would a settings hook and the adapter runs it the way
Claude Code does: with `sh -c` (`bash -c` for `shell: "bash"`, no shell in exec
form with `args`), the hook input as JSON on stdin, `CLAUDE_PROJECT_DIR` set,
its `timeout` (by default 10 minutes, 30 seconds for `UserPromptSubmit`, 1.5
seconds for `SessionEnd`) and `async` honored. A session's `SessionEnd` hooks
also share one budget, the longest of their timeouts from 1.5 seconds up to a
minute, and `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` sets both, as in Claude
Code. A hook's `if`, a permission rule such as `Bash(git *)`, is matched against
the tool call as the adapter matches ask rules (so a command line it cannot take
apart runs the hook); as in Claude Code, a hook with `if` on an event that is
not about a tool never runs, and `once`, which Claude Code honors only for hooks
a skill or agent defines, means nothing in a settings file. A hook is done when
its own process exits; a background process it started keeps running and can
still write to the hook's output, while a hook that times out is killed with
everything it started. Exit 0 passes JSON output on (plain output becomes
context for `UserPromptSubmit` and `SessionStart`), exit 2 blocks with stderr as
the reason (for `SubagentStart`, `SessionStart` and `SessionEnd` it only shows
stderr, for `Notification` it does nothing), other exits are non-blocking
errors, and `disableAllHooks` turns them all off. In plan mode or a read-only
sandbox a hook can still deny or ask but its approval is dropped, leaving the
call to Codex. The CLI runs `SessionStart` hooks for a new, resumed or forked
session before the SDK has registered its callbacks, and `SessionEnd` hooks
after the SDK has let go of them, so the adapter runs those two itself:
`SessionStart` once the session takes its first prompt, with the source
`startup`, `resume` or `fork` matched as the CLI matches it, its context and
`systemMessage` reaching Claude and the user along with that prompt;
`SessionEnd`, with the reason `other`, when the CLI session is over, for a
session that took a prompt. A session still open when the adapter stops ends
with it: the hooks of all such sessions run before the adapter exits and share
one budget, as those of a single CLI would. The CLI itself still runs
`SessionStart` for `compact` and `clear`. Prompt, agent and HTTP hooks, PowerShell hooks,
`asyncRewake`'s wake-up, `CLAUDE_ENV_FILE`, and other events (such as
`PreCompact`, whose output a callback cannot pass back, or `PermissionRequest`,
which the Codex approval flow owns) are not carried over. Point
`CLAUDE_CODEX_CLAUDE_CONFIG_DIR` only at a folder the CLI does not read itself,
or its hooks run twice.

With `CLAUDE_CODEX_CODEX_NOTIFY=1`, the `notify` program of
`CODEX_HOME/config.toml` runs when a Claude thread's turn completes, as Codex
runs it for its own turns: the configured argv plus one JSON argument,
`{"type":"agent-turn-complete", "thread-id", "turn-id", "cwd", "client",
"input-messages", "last-assistant-message"}`. This is off by default because the
Codex App sets `notify` to its own turn-ended program for Codex threads, which
would otherwise be called after every Claude turn. The adapter does not wait for
the program, ends it after 30 seconds and writes its stderr to the debug log.
Summaries and other internal turns, and Codex model threads (whose own Codex
runs it), do not notify; a project's `.codex/config.toml` cannot set it.

### `/workflows` compatibility

With the native Claude Agent SDK backend, `/workflows <task>` is translated to Claude's
`ultracode:` workflow trigger. Workflow task events are exposed as Codex-native reviewable
Subagent threads. While a local workflow runs, the adapter tails its journal and projects each
inner agent through Codex's native `subAgentActivity` lifecycle (with `completed` sent only to
clients that advertise it) plus `spawnAgent`/`wait` tool state; runtimes without journal metadata
fall back to one aggregate workflow agent when the workflow reaches a terminal state.
A bare `/workflows` lists workflow runs
recorded in the current Codex thread.

This compatibility layer is specific to the native Claude Agent SDK backend. Alternate HTTP,
agentapi, and `claude -p` backends receive no workflow event bridge. Interactive workflow
management actions such as pause, resume, stop, and save are not implemented.

When Codex Full Access is selected, the adapter keeps Claude in its standard permission mode and
auto-allows permission requests through the existing Codex bridge. This avoids Relay's refusal of
dangerous permission bypass outside a recognized container sandbox while preserving a zero-prompt
Full Access turn. Operators can still opt into native SDK bypass explicitly with
`CLAUDE_CODEX_PERMISSION_MODE=bypassPermissions` in an appropriately isolated environment.

## Current release boundaries

- **Production path:** the TypeScript app-server adapter remains the shipping
  path for Codex desktop Remote mode and Claude Code.
- **Rust-first work:** RFCs, a workspace scaffold, protocol fixtures, parse /
  reserialize tests, and pinned fixture drift checks are present. Rust does not
  replace the production runtime, transport, store, or launcher yet.
- **Provider and agent-loop work:** descriptors, sanitized `config/read`
  projection, and explicit provider/loop selection are implemented. Selection
  is metadata and routing for known descriptors only; it maps to existing
  runtime backends and does not add a new executable provider loop.
- **Credential model:** use local user-owned API keys, official cloud-provider
  credential chains, local CLI auth on the same host, or organization-managed
  gateways that own billing, policy, audit, and provider compliance.
- **Unsupported:** personal subscription pooling, browser cookie or session-token
  reuse, credential sharing, private endpoint use, provider bypass behavior, and
  claims of unavailable entitlements.
- **Release checks:** CI runs `npm run check`, `npm run typecheck`, `npm test`,
  `cargo test --workspace`, and the pinned Rust fixture drift check. Docs changes
  should run `npm run docs:build`; credentialed smoke and acceptance checks stay
  opt-in with user- or organization-owned credentials.

See the
**[release readiness reference](https://fuergaosi233.github.io/claude-codex/reference/release-readiness)**
for the verification matrix and reviewer checklist.

## Documentation

| Topic | Link |
| --- | --- |
| Getting started | <https://fuergaosi233.github.io/claude-codex/guide/getting-started> |
| Deployment (remote host) | <https://fuergaosi233.github.io/claude-codex/guide/deployment> |
| Using the Codex App | <https://fuergaosi233.github.io/claude-codex/guide/gui> |
| Configuration | <https://fuergaosi233.github.io/claude-codex/guide/configuration> |
| Backends | <https://fuergaosi233.github.io/claude-codex/guide/backends> |
| Capability matrix | <https://fuergaosi233.github.io/claude-codex/reference/capability-matrix> |
| Workflow operations | <https://fuergaosi233.github.io/claude-codex/reference/workflow-operations> |
| Release readiness | <https://fuergaosi233.github.io/claude-codex/reference/release-readiness> |
| Contributing / toolchain | <https://fuergaosi233.github.io/claude-codex/contributing> |
| Security policy | [SECURITY.md](SECURITY.md) |
| Safe examples | [examples/](examples/) |

Docs source lives in [`docs/`](docs/) and is published with VitePress. For
contributors, the repo also ships progressive `AGENTS.md` files (root + `src/` +
`scripts/` + `test/`).

## Development

```bash
npm run dev          # run from TypeScript via tsx
npm run typecheck    # tsc --noEmit
npm run check        # biome format + lint
npm test             # build + node --test
npm run docs:dev     # preview this documentation site
```

See **[Contributing](https://fuergaosi233.github.io/claude-codex/contributing)**
for the full toolchain and conventions.

## Workflow operations

The adapter includes a small workflow control plane for long-running Codex
maintenance loops. It is intentionally file-backed and explicit: the scheduler
tracks tasks in `~/.codex/claude-codex-adapter/workflow-state.json`, and a task
only runs after it has been queued and leased.

```bash
npm run workflow -- status
npm run workflow -- health
npm run workflow -- enqueue --id task-id --prompt "Do one concrete task"
npm run workflow -- schedule --worker codex-heartbeat
npm run workflow -- heartbeat --task task-id --worker codex-heartbeat
npm run workflow -- complete --task task-id
```

Use `health` from recurring heartbeats before doing more work. A healthy loop
has no stale leases, no failed tasks, and either no running task or one running
task with an active lease. If a lease is still active, continue that task or
renew the heartbeat only when more time is needed. Do not enqueue duplicates.

Run events are appended to
`~/.codex/claude-codex-adapter/runs.jsonl` by default. The registry redacts
prompt-like fields, model responses, and secret-like values before writing. Set
`CLAUDE_CODEX_RUN_LOG=0` to disable it, or set `CLAUDE_CODEX_RUN_LOG=/path/log`
to choose a different JSONL file.

Optional per-thread worktree isolation is controlled with
`CLAUDE_CODEX_WORKTREE_ROOT`. Thread ids are mapped to root-confined,
collision-resistant labels, and an existing worktree is reused when present.
If worktree setup fails, the adapter logs the failure and keeps the original
cwd so the app-server session can continue.

GitHub issue or PR automation must go through the trust-boundary queue. Export
only trusted metadata to local JSON, then ingest it:

```bash
gh issue list --json number,title,state,url > /tmp/github-issues.json
npm run workflow -- ingest-github --github-json /tmp/github-issues.json
```

The ingestion step creates explicit workflow tasks from `number`, `title`,
`state`, `url`, and item kind only. Body text, comments, reviews, and other
external instructions are intentionally omitted from generated prompts, so a
later agent must inspect external text through the project trust-boundary
workflow before changing code.

## License

[MIT](LICENSE)
