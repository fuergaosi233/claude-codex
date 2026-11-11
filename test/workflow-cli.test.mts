import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runWorkflowCli, type WorkflowCliIo } from '../src/workflow-cli.mjs'
import {
  type WorkflowState,
  WorkflowStateStore,
  type WorkflowTask,
} from '../src/workflow-state.mjs'

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

test('workflow CLI allows only one schedule claim after concurrent stale reads', {
  timeout: 10_000,
}, async () => {
  const statePath = await tempStatePath()
  await runWorkflowCli(
    ['enqueue', '--state', statePath, '--id', 'task-a', '--prompt', 'Integrate scheduler.'],
    captureIo(),
  )

  const outputs = await runGatedWorkflows([
    ['schedule', '--state', statePath, '--worker', 'worker-a', '--now', '2026-07-04T00:00:00.000Z'],
    ['schedule', '--state', statePath, '--worker', 'worker-b', '--now', '2026-07-04T00:00:00.000Z'],
  ])
  const decisions = outputs.map((output) => jsonOf<ScheduleOutput>(output))

  assert.deepEqual(decisions.map((decision) => decision.type).sort(), ['claimed', 'idle'])
  const state = await new WorkflowStateStore(statePath).read()
  assert.equal(state?.tasks.length, 1)
  assert.equal(state?.tasks[0]?.status, 'running')
  const claim = decisions.find((decision) => decision.type === 'claimed')
  assert.equal(state?.tasks[0]?.lease?.workerId, claim?.task.lease?.workerId)
})

test('workflow CLI preserves concurrent enqueues after concurrent stale reads', {
  timeout: 10_000,
}, async () => {
  const statePath = await tempStatePath()
  const outputs = await runGatedWorkflows([
    ['enqueue', '--state', statePath, '--id', 'task-a', '--prompt', 'First task.'],
    ['enqueue', '--state', statePath, '--id', 'task-b', '--prompt', 'Second task.'],
  ])

  for (const output of outputs) {
    assert.equal(jsonOf<EnqueueOutput>(output).task.status, 'queued')
  }
  const state = await new WorkflowStateStore(statePath).read()
  assert.deepEqual(state?.tasks.map((task) => task.id).sort(), ['task-a', 'task-b'])
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

const gatedWorkflowScript = `
import { runWorkflowCli } from ${JSON.stringify(new URL('../src/workflow-cli.mjs', import.meta.url).href)}
import { WorkflowStateStore } from ${JSON.stringify(new URL('../src/workflow-state.mjs', import.meta.url).href)}

const release = new Promise((resolve) => process.once('message', resolve))
const originalRead = WorkflowStateStore.prototype.read
let initialRead = true
WorkflowStateStore.prototype.read = async function () {
  const state = await originalRead.call(this)
  if (initialRead) {
    initialRead = false
    process.send('state-read')
    await release
  }
  return state
}
process.exitCode = await runWorkflowCli(JSON.parse(process.env.WORKFLOW_CLI_ARGS ?? '[]'))
`

async function runGatedWorkflows(commands: readonly (readonly string[])[]): Promise<string[]> {
  const workers = commands.map((args) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', gatedWorkflowScript], {
      env: { ...process.env, WORKFLOW_CLI_ARGS: JSON.stringify(args) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    return { child, stdout: () => stdout, stderr: () => stderr }
  })

  try {
    await Promise.all(
      workers.map(async ({ child, stderr }) => {
        const [message] = await Promise.race([
          once(child, 'message'),
          once(child, 'close').then(([code]) => {
            throw new Error(`workflow exited before its read gate (${code}): ${stderr()}`)
          }),
        ])
        assert.equal(message, 'state-read')
      }),
    )
    for (const { child } of workers) child.send('release')

    return await Promise.all(
      workers.map(async ({ child, stdout, stderr }) => {
        const [code] = (await once(child, 'close')) as [number | null]
        assert.equal(code, 0, stderr())
        return stdout()
      }),
    )
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  }
}

async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-cli-'))
  return join(dir, 'workflow-state.json')
}

function jsonOf<T>(text: string): T {
  return JSON.parse(text) as T
}
