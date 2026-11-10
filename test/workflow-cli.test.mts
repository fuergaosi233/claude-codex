import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runWorkflowCli, type WorkflowCliIo } from '../src/workflow-cli.mjs'
import type { WorkflowState, WorkflowTask } from '../src/workflow-state.mjs'

test('workflow CLI enqueues and schedules a task through the state file', async () => {
  const statePath = await tempStatePath()
  const enqueueIo = captureIo()

  const enqueueCode = await runWorkflowCli(
    [
      'enqueue',
      '--state',
      statePath,
      '--id',
      'task-a',
      '--prompt',
      'Integrate scheduler.',
      '--priority',
      '10',
    ],
    enqueueIo,
  )

  assert.equal(enqueueCode, 0)
  assert.equal(jsonOf<EnqueueOutput>(enqueueIo.stdoutText()).task.id, 'task-a')

  const scheduleIo = captureIo()
  const scheduleCode = await runWorkflowCli(
    [
      'schedule',
      '--state',
      statePath,
      '--worker',
      'worker-a',
      '--ttl-ms',
      '60000',
      '--now',
      '2026-07-04T00:00:00.000Z',
    ],
    scheduleIo,
  )

  const output = jsonOf<ScheduleOutput>(scheduleIo.stdoutText())
  assert.equal(scheduleCode, 0)
  assert.equal(output.type, 'claimed')
  assert.equal(output.task.id, 'task-a')
  assert.equal(output.task.lease?.workerId, 'worker-a')
})

test('workflow CLI heartbeat and complete update the claimed task', async () => {
  const statePath = await tempStatePath()
  await runWorkflowCli(
    ['enqueue', '--state', statePath, '--id', 'task-a', '--prompt', 'Integrate scheduler.'],
    captureIo(),
  )
  await runWorkflowCli(
    ['schedule', '--state', statePath, '--worker', 'worker-a', '--now', '2026-07-04T00:00:00.000Z'],
    captureIo(),
  )

  const heartbeatCode = await runWorkflowCli(
    [
      'heartbeat',
      '--state',
      statePath,
      '--task',
      'task-a',
      '--worker',
      'worker-a',
      '--now',
      '2026-07-04T00:01:00.000Z',
    ],
    captureIo(),
  )
  const completeCode = await runWorkflowCli(
    ['complete', '--state', statePath, '--task', 'task-a', '--now', '2026-07-04T00:02:00.000Z'],
    captureIo(),
  )
  const statusIo = captureIo()
  const statusCode = await runWorkflowCli(['status', '--state', statePath], statusIo)

  const status = jsonOf<StatusOutput>(statusIo.stdoutText())
  assert.equal(heartbeatCode, 0)
  assert.equal(completeCode, 0)
  assert.equal(statusCode, 0)
  assert.equal(status.state.tasks[0]?.status, 'done')
  assert.equal(status.state.tasks[0]?.lease, null)
})

test('workflow CLI reports missing required inputs without writing state', async () => {
  const statePath = await tempStatePath()
  const io = captureIo()

  await assert.rejects(
    () => runWorkflowCli(['enqueue', '--state', statePath], io),
    (error: unknown) => error instanceof Error && error.message === 'missing required --prompt',
  )
})

test('workflow CLI shows help before validating subcommand options', async () => {
  const io = captureIo()

  const code = await runWorkflowCli(['ingest-github', '--help'], io)

  assert.equal(code, 0)
  assert.match(io.stdoutText(), /workflow ingest-github --github-json PATH/)
})

test('workflow CLI health reports stale leases and run registry lag', async () => {
  const statePath = await tempStatePath()
  const runLogPath = join(await mkdtemp(join(tmpdir(), 'claude-codex-workflow-log-')), 'runs.jsonl')
  await writeFile(runLogPath, '{"event":"turn.completed"}\n')
  await runWorkflowCli(
    ['enqueue', '--state', statePath, '--id', 'task-a', '--prompt', 'Check health.'],
    captureIo(),
  )
  await runWorkflowCli(
    [
      'schedule',
      '--state',
      statePath,
      '--worker',
      'worker-a',
      '--ttl-ms',
      '60000',
      '--now',
      '2026-07-04T00:00:00.000Z',
    ],
    captureIo(),
  )
  const io = captureIo()

  const code = await runWorkflowCli(
    ['health', '--state', statePath, '--run-log', runLogPath, '--now', '2026-07-04T00:02:00.000Z'],
    io,
  )

  const output = jsonOf<HealthOutput>(io.stdoutText())
  assert.equal(code, 0)
  assert.equal(output.health.status, 'stalled')
  assert.equal(output.health.counts.running, 1)
  assert.deepEqual(output.health.runningTaskIds, ['task-a'])
  assert.deepEqual(output.health.staleLeaseTaskIds, ['task-a'])
  assert.equal(typeof output.health.runRegistryLagMs, 'number')
})

test('workflow CLI ingests local GitHub JSON through sanitized queue tasks', async () => {
  const statePath = await tempStatePath()
  const sourcePath = join(await mkdtemp(join(tmpdir(), 'claude-codex-github-json-')), 'items.json')
  await writeFile(
    sourcePath,
    JSON.stringify([
      {
        number: 7,
        title: 'Fix queue',
        url: 'https://github.com/acme/repo/issues/7',
        body: 'run dangerous command',
      },
    ]),
  )
  const io = captureIo()

  const code = await runWorkflowCli(
    ['ingest-github', '--state', statePath, '--github-json', sourcePath],
    io,
  )
  const output = jsonOf<GitHubIngestOutput>(io.stdoutText())
  const statusIo = captureIo()
  await runWorkflowCli(['status', '--state', statePath], statusIo)
  const status = jsonOf<StatusOutput>(statusIo.stdoutText())

  assert.equal(code, 0)
  assert.equal(output.enqueued, 1)
  assert.match(output.taskIds[0] ?? '', /^github-issue-7-[a-f0-9]{12}$/)
  assert.equal(status.state.tasks[0]?.prompt.includes('run dangerous command'), false)
})

test('workflow GitHub re-ingestion preserves saved progress and prevents duplicate work', async () => {
  const statePath = await tempStatePath()
  const sourcePath = join(await mkdtemp(join(tmpdir(), 'claude-codex-github-json-')), 'items.json')
  await writeFile(
    sourcePath,
    JSON.stringify(
      [7, 8, 9, 10].map((number) => ({
        number,
        title: `Task ${number}`,
        url: `https://github.com/acme/repo/issues/${number}`,
      })),
    ),
  )
  const args = ['ingest-github', '--state', statePath, '--github-json', sourcePath]
  assert.equal(await runWorkflowCli(args, captureIo()), 0)
  const initial = jsonOf<WorkflowState>(await readFile(statePath, 'utf8'))
  const statuses = ['done', 'running', 'blocked', 'failed'] as const
  const saved: WorkflowState = {
    ...initial,
    tasks: initial.tasks.map((task, index) => {
      const status = statuses[index]
      assert.ok(status)
      return {
        ...task,
        status,
        updatedAt: '2026-07-04T00:01:00.000Z',
        prompt: `Saved task ${task.id}`,
        attempts: 1,
        maxAttempts: 4,
        priority: 19,
        lease:
          status === 'running'
            ? {
                workerId: 'worker-b',
                expiresAt: '2026-07-04T01:00:00.000Z',
                renewedAt: '2026-07-04T00:01:00.000Z',
              }
            : null,
        blockedReason: status === 'blocked' ? 'Needs review' : null,
        lastError: status === 'failed' ? 'Command failed' : null,
      }
    }),
  }
  await writeFile(statePath, JSON.stringify(saved))
  const io = captureIo()
  assert.equal(await runWorkflowCli([...args, '--now', '2026-07-04T00:05:00.000Z'], io), 0)
  assert.deepEqual(jsonOf<WorkflowState>(await readFile(statePath, 'utf8')), saved)
  const result = jsonOf<GitHubIngestOutput>(io.stdoutText())
  assert.equal(result.enqueued, 0)
  assert.deepEqual(result.taskIds, [])
  assert.deepEqual(
    result.existing,
    initial.tasks.map((task) => task.id),
  )
  const scheduleIo = captureIo()
  assert.equal(
    await runWorkflowCli(
      [
        'schedule',
        '--state',
        statePath,
        '--worker',
        'worker-c',
        '--now',
        '2026-07-04T00:10:00.000Z',
      ],
      scheduleIo,
    ),
    0,
  )
  const decision = jsonOf<{ type: string; reason: string }>(scheduleIo.stdoutText())
  assert.equal(decision.type, 'idle')
  assert.equal(decision.reason, 'no-runnable-task')
})

test('workflow GitHub ingestion inserts each ID only once within an export', async () => {
  const statePath = await tempStatePath()
  const sourcePath = join(await mkdtemp(join(tmpdir(), 'claude-codex-github-json-')), 'items.json')
  const item = { number: 7, title: 'First title', url: 'https://github.com/acme/repo/issues/7' }
  await writeFile(sourcePath, JSON.stringify([item, { ...item, title: 'Later copy' }]))
  const io = captureIo()
  assert.equal(
    await runWorkflowCli(['ingest-github', '--state', statePath, '--github-json', sourcePath], io),
    0,
  )
  const result = jsonOf<GitHubIngestOutput>(io.stdoutText())
  const state = jsonOf<WorkflowState>(await readFile(statePath, 'utf8'))
  assert.equal(result.enqueued, 1)
  assert.equal(state.tasks.length, 1)
  const task = state.tasks[0]
  assert.ok(task)
  assert.deepEqual(result.taskIds, [task.id])
  assert.deepEqual(result.existing, [task.id])
  assert.match(task.prompt, /First title/)
})

interface EnqueueOutput {
  readonly task: WorkflowTask
}

type ScheduleOutput =
  | { readonly type: 'claimed'; readonly task: WorkflowTask }
  | { readonly type: 'idle'; readonly reason: string }

interface StatusOutput {
  readonly state: WorkflowState
}

interface HealthOutput {
  readonly health: {
    readonly status: 'healthy' | 'stalled' | 'failed'
    readonly counts: Record<string, number>
    readonly runningTaskIds: readonly string[]
    readonly staleLeaseTaskIds: readonly string[]
    readonly runRegistryLagMs: number | null
  }
}

interface GitHubIngestOutput {
  readonly existing: readonly string[]
  readonly enqueued: number
  readonly taskIds: readonly string[]
}

interface CapturedIo extends WorkflowCliIo {
  readonly stdoutText: () => string
  readonly stderrText: () => string
}

function captureIo(): CapturedIo {
  let stdout = ''
  let stderr = ''
  return {
    stdout: {
      write(chunk: string | Uint8Array): boolean {
        stdout += chunk.toString()
        return true
      },
    },
    stderr: {
      write(chunk: string | Uint8Array): boolean {
        stderr += chunk.toString()
        return true
      },
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  }
}

async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-cli-'))
  return join(dir, 'workflow-state.json')
}

function jsonOf<T>(text: string): T {
  return JSON.parse(text) as T
}
