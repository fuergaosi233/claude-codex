import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runWorkflowCli, type WorkflowCliIo } from '../src/workflow-cli.mjs'
import type { WorkflowState, WorkflowTask } from '../src/workflow-state.mjs'

const cliUrl = new URL('../src/workflow-cli.mjs', import.meta.url)

for (const entryKind of ['direct', 'space', 'directory symlink', 'file symlink'] as const) {
  test(`workflow CLI executes commands through a ${entryKind} path`, async (t) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-codex-workflow-entry-')))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const originalEntry = fileURLToPath(cliUrl)
    let entry = originalEntry
    if (entryKind === 'space') {
      const copiedDir = join(dir, 'with space # é')
      await cp(dirname(originalEntry), copiedDir, { recursive: true })
      entry = join(copiedDir, 'workflow-cli.mjs')
    } else if (entryKind === 'directory symlink') {
      const linkedDir = join(dir, 'linked-src')
      await symlink(dirname(originalEntry), linkedDir, 'dir')
      entry = join(linkedDir, 'workflow-cli.mjs')
    } else if (entryKind === 'file symlink') {
      entry = join(dir, 'linked-cli.mjs')
      await symlink(originalEntry, entry, 'file')
    }
    const statePath = join(dir, 'state.json')
    const result = spawnSync(
      process.execPath,
      [
        entry,
        'enqueue',
        '--id',
        'entry-task',
        '--prompt',
        'Check CLI entry.',
        '--state',
        statePath,
      ],
      { encoding: 'utf8', timeout: 10000 },
    )

    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /"status": "enqueued"/)
    assert.equal(jsonOf<EnqueueOutput>(result.stdout).task.id, 'entry-task')
    const state = jsonOf<WorkflowState>(await readFile(statePath, 'utf8'))
    assert.equal(state.tasks[0]?.id, 'entry-task')
    assert.equal(state.tasks[0]?.status, 'queued')

    const help = spawnSync(process.execPath, [entry, '--help'], {
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /Usage:/)

    const unknown = spawnSync(process.execPath, [entry, 'bogus', '--state', statePath], {
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(unknown.status, 1, unknown.stderr)
    assert.match(unknown.stderr, /unknown workflow command: bogus/)
  })
}

test('workflow CLI stays inert when imported from a script or eval', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-import-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = `await import(${JSON.stringify(cliUrl.href)}); console.log('imported')`
  const wrapper = join(dir, 'importer.mjs')
  await writeFile(wrapper, source)

  for (const args of [
    [wrapper],
    ['--input-type=module', '--eval', source],
    ['--input-type=module', '--eval', source, join(dir, 'missing-entry.mjs')],
  ]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, 'imported\n')
  }
})

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

async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-cli-'))
  return join(dir, 'workflow-state.json')
}

function jsonOf<T>(text: string): T {
  return JSON.parse(text) as T
}
