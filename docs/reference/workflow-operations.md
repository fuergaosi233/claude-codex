# Workflow Operations

This page is the operator runbook for the local workflow control plane used by
recurring Codex maintenance loops. The workflow is deliberately explicit: tasks
are queued in a local state file, leased by a worker, verified, and then marked
complete.

The default state file is:

```text
~/.codex/claude-codex-adapter/workflow-state.json
```

## Core loop

Start each heartbeat by reading the state through the CLI:

```bash
npm run workflow -- status
npm run workflow -- health
```

If `health.status` is `healthy` and a task is running with an active lease,
continue that task. Renew the lease only when the worker needs more time:

```bash
npm run workflow -- heartbeat --task task-id --worker codex-heartbeat
```

If no task is running and there is one clear safe task, queue exactly one task
and claim it:

```bash
npm run workflow -- enqueue --id task-id --prompt "Do one concrete task"
npm run workflow -- schedule --worker codex-heartbeat
```

Finish by running the matching verification commands, then mark the task
complete:

```bash
npm run workflow -- complete --task task-id
```

Use `fail` for a task that should retry or fail closed. Use `block` when the
worker cannot proceed without user input or an external state change:

```bash
npm run workflow -- fail --task task-id --error "Verification failed"
npm run workflow -- block --task task-id --reason "Needs a missing credential"
```

## Health signals

`npm run workflow -- health` reports:

| Field | Meaning |
| --- | --- |
| `counts` | Number of queued, running, blocked, done, and failed tasks. |
| `runningTaskIds` | Tasks currently holding leases. |
| `staleLeaseTaskIds` | Running tasks whose lease expired and can be reclaimed. |
| `nextLeaseExpiresAt` | The next active lease expiry time, or `null`. |
| `runRegistryLagMs` | Time since the run registry was last updated, when available. |

A safe heartbeat has no stale leases, no failed tasks, and no duplicate queued
work. A stale lease can be reclaimed by `schedule`; an active lease should not
be stolen.

## Run registry

Run events are appended to:

```text
~/.codex/claude-codex-adapter/runs.jsonl
```

The registry redacts prompt-like fields, model responses, and secret-like
values before writing. Set `CLAUDE_CODEX_RUN_LOG=0` to disable the registry, or
set `CLAUDE_CODEX_RUN_LOG=/path/to/runs.jsonl` to choose another JSONL file.

The registry is for operational evidence, not transcript storage. Do not depend
on it for raw prompt, response, credential, or user-secret recovery.

## Worktree isolation

Set `CLAUDE_CODEX_WORKTREE_ROOT` to enable optional per-thread git worktrees.
Each thread id is mapped to a root-confined, collision-resistant label. If the
worktree already exists, it is reused. If setup fails, the adapter logs the
failure and keeps the original cwd so the app-server session can continue.

This feature isolates concurrent coding agents without making worktree creation
a hard dependency for normal Codex App operation.

## GitHub trust boundary

GitHub issue and pull request text is external input. Do not wire GitHub issue,
PR, review, or comment bodies directly into execution.

Instead, export trusted metadata to local JSON and ingest it:

```bash
gh issue list --json number,title,state,url > /tmp/github-issues.json
npm run workflow -- ingest-github --github-json /tmp/github-issues.json
```

The ingestion command creates explicit workflow tasks from trusted metadata
only: item number, title, state, URL, and item kind. Body text, comments,
reviews, and other external instructions are intentionally omitted from the
generated task prompt.

Before changing code for a GitHub-sourced task, inspect external text through
the project trust-boundary workflow and keep the execution step explicit in the
local queue.

## Verification checklist

For code changes, run the focused check for the changed surface and then the
default suite:

```bash
npm run typecheck
npm test
```

For docs-only changes, run:

```bash
npm run docs:build
```

When the task changes navigation, links, or shared README examples, include the
docs build even if no TypeScript source changed.
