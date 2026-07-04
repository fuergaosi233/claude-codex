#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseGitHubQueueJson } from './github-queue.mjs'
import { runRegistryPath } from './run-registry.mjs'
import { adapterHome, newId } from './util.mjs'
import { workflowHealth } from './workflow-health.mjs'
import {
  blockWorkflowTask,
  completeWorkflowTask,
  failWorkflowTask,
  renewWorkflowLease,
  scheduleNextWorkflowTask,
} from './workflow-scheduler.mjs'
import {
  WORKFLOW_STATE_VERSION,
  type WorkflowState,
  WorkflowStateStore,
  type WorkflowTask,
} from './workflow-state.mjs'

export interface WorkflowCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>
}

export async function runWorkflowCli(
  args: readonly string[] = process.argv.slice(2),
  io: WorkflowCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const command = args[0] ?? 'status'
  const parsed = parseArgs(args.slice(1))
  if (command === 'help' || command === '--help' || command === '-h' || hasFlag(parsed, 'help')) {
    writeHelp(io.stdout)
    return 0
  }
  const store = new WorkflowStateStore(statePath(parsed))
  const state = (await store.read()) ?? emptyState()
  const now = new Date(stringOption(parsed, 'now') ?? Date.now())

  switch (command) {
    case 'enqueue': {
      const task = taskFromArgs(parsed, now)
      const nextState = upsertTask(state, task)
      await store.write(nextState)
      writeJson(io.stdout, { status: 'enqueued', statePath: store.path, task })
      return 0
    }
    case 'schedule': {
      const decision = scheduleNextWorkflowTask(state, {
        now,
        workerId: stringOption(parsed, 'worker') ?? `worker-${process.pid}`,
        leaseTtlMs: numberOption(parsed, 'ttl-ms') ?? 30 * 60 * 1000,
      })
      await store.write(decision.state)
      writeJson(io.stdout, { ...decision, statePath: store.path })
      return 0
    }
    case 'heartbeat': {
      const taskId = requiredOption(parsed, 'task')
      const nextState = renewWorkflowLease(state, taskId, {
        now,
        workerId: requiredOption(parsed, 'worker'),
        leaseTtlMs: numberOption(parsed, 'ttl-ms') ?? 30 * 60 * 1000,
      })
      await store.write(nextState)
      writeJson(io.stdout, { status: 'heartbeat', statePath: store.path, taskId })
      return 0
    }
    case 'complete': {
      const taskId = requiredOption(parsed, 'task')
      const nextState = completeWorkflowTask(state, taskId, now)
      await store.write(nextState)
      writeJson(io.stdout, { status: 'completed', statePath: store.path, taskId })
      return 0
    }
    case 'fail': {
      const taskId = requiredOption(parsed, 'task')
      const nextState = failWorkflowTask(state, taskId, requiredOption(parsed, 'error'), now)
      await store.write(nextState)
      writeJson(io.stdout, { status: 'failed-or-requeued', statePath: store.path, taskId })
      return 0
    }
    case 'block': {
      const taskId = requiredOption(parsed, 'task')
      const nextState = blockWorkflowTask(state, taskId, requiredOption(parsed, 'reason'), now)
      await store.write(nextState)
      writeJson(io.stdout, { status: 'blocked', statePath: store.path, taskId })
      return 0
    }
    case 'status': {
      writeJson(io.stdout, { status: 'ok', statePath: store.path, state })
      return 0
    }
    case 'health': {
      const runLog = stringOption(parsed, 'run-log') ?? runRegistryPath()
      const runLogUpdatedAt = runLog ? await fileUpdatedAt(runLog) : null
      writeJson(io.stdout, {
        status: 'ok',
        statePath: store.path,
        runLog,
        health: workflowHealth({ state, now, runLogUpdatedAt }),
      })
      return 0
    }
    case 'ingest-github': {
      const source = requiredOption(parsed, 'github-json')
      const result = parseGitHubQueueJson(await readFile(source, 'utf8'), now)
      const nextState = result.tasks.reduce((current, task) => upsertTask(current, task), state)
      await store.write(nextState)
      writeJson(io.stdout, {
        status: 'ingested',
        statePath: store.path,
        source,
        enqueued: result.tasks.length,
        skipped: result.skipped,
        taskIds: result.tasks.map((task) => task.id),
      })
      return 0
    }
    default:
      io.stderr.write(`unknown workflow command: ${command}\n`)
      writeHelp(io.stderr)
      return 1
  }
}

function taskFromArgs(args: ParsedArgs, now: Date): WorkflowTask {
  return {
    id: stringOption(args, 'id') ?? newId(),
    status: 'queued',
    updatedAt: now.toISOString(),
    prompt: requiredOption(args, 'prompt'),
    priority: numberOption(args, 'priority') ?? 0,
    attempts: 0,
    maxAttempts: numberOption(args, 'max-attempts') ?? 3,
    lease: null,
    blockedReason: null,
    lastError: null,
  }
}

function upsertTask(state: WorkflowState, task: WorkflowTask): WorkflowState {
  if (!state.tasks.some((candidate) => candidate.id === task.id)) {
    return { ...state, tasks: [...state.tasks, task] }
  }
  return {
    ...state,
    tasks: state.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
  }
}

function emptyState(): WorkflowState {
  return { version: WORKFLOW_STATE_VERSION, tasks: [] }
}

interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? ''
    if (!raw.startsWith('--')) continue
    const inline = raw.indexOf('=')
    if (inline >= 0) {
      values.set(raw.slice(2, inline), raw.slice(inline + 1))
      continue
    }
    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      values.set(raw.slice(2), next)
      index += 1
    } else {
      values.set(raw.slice(2), 'true')
    }
  }
  return { values }
}

function statePath(args: ParsedArgs): string {
  return resolve(stringOption(args, 'state') ?? join(adapterHome(), 'workflow-state.json'))
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = stringOption(args, name)
  if (value) return value
  throw new WorkflowCliInputError(`missing required --${name}`)
}

function stringOption(args: ParsedArgs, name: string): string | null {
  const value = args.values.get(name)
  return value?.trim() ? value : null
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.values.get(name) === 'true'
}

function numberOption(args: ParsedArgs, name: string): number | null {
  const value = stringOption(args, name)
  if (!value) return null
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return parsed
  throw new WorkflowCliInputError(`--${name} must be a number`)
}

function writeJson(output: Pick<NodeJS.WriteStream, 'write'>, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`)
}

function writeHelp(output: Pick<NodeJS.WriteStream, 'write'>): void {
  output.write(`Usage:
  workflow status [--state PATH]
  workflow enqueue --prompt TEXT [--id ID] [--priority N] [--max-attempts N] [--state PATH]
  workflow schedule [--worker ID] [--ttl-ms N] [--state PATH]
  workflow heartbeat --task ID --worker ID [--ttl-ms N] [--state PATH]
  workflow health [--state PATH] [--run-log PATH]
  workflow ingest-github --github-json PATH [--state PATH]
  workflow complete --task ID [--state PATH]
  workflow fail --task ID --error TEXT [--state PATH]
  workflow block --task ID --reason TEXT [--state PATH]
`)
}

class WorkflowCliInputError extends Error {
  override readonly name = 'WorkflowCliInputError'
}

async function fileUpdatedAt(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkflowCli().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(
        `[claude-codex-workflow] ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    },
  )
}
