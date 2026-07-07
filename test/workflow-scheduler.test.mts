import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  blockWorkflowTask,
  completeWorkflowTask,
  failWorkflowTask,
  renewWorkflowLease,
  scheduleNextWorkflowTask,
  type WorkflowSchedulerOptions,
  WorkflowTransitionError,
} from '../src/workflow-scheduler.mjs'
import {
  parseWorkflowStateJson,
  type WorkflowState,
  WorkflowStateParseError,
  WorkflowStateStore,
  type WorkflowTask,
} from '../src/workflow-state.mjs'

const now = new Date('2026-07-04T00:00:00.000Z')

test('workflow state parser accepts the versioned scheduler state shape', () => {
  const parsed = parseWorkflowStateJson(JSON.stringify(sampleState()))

  assert.deepEqual(parsed, sampleState())
})

test('workflow state parser rejects unknown task statuses', () => {
  const invalid = {
    version: 1,
    tasks: [
      {
        ...task({ id: 'bad-status' }),
        status: 'paused',
      },
    ],
  }

  assert.throws(
    () => parseWorkflowStateJson(JSON.stringify(invalid)),
    (error: unknown) =>
      error instanceof WorkflowStateParseError &&
      error.message.includes('queued, running, blocked, done, failed'),
  )
})

test('workflow state store writes through an atomic JSON file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-state-'))
  const statePath = join(dir, 'nested', 'workflow-state.json')
  const store = new WorkflowStateStore(statePath)
  const nextState: WorkflowState = {
    version: 1,
    tasks: [task({ id: 'done-task', status: 'done' })],
  }

  assert.equal(await store.read(), null)

  await store.write(sampleState())
  await store.write(nextState)

  assert.deepEqual(await store.read(), nextState)
  assert.deepEqual(await readdir(join(dir, 'nested')), ['workflow-state.json'])
})

test('workflow scheduler claims highest priority runnable task with a lease', () => {
  const state: WorkflowState = {
    version: 1,
    tasks: [
      task({ id: 'older-low', priority: 1, updatedAt: '2026-07-03T00:00:00.000Z' }),
      task({ id: 'newer-high', priority: 10, updatedAt: '2026-07-04T00:00:00.000Z' }),
    ],
  }

  const decision = scheduleNextWorkflowTask(state, options())

  assert.equal(decision.type, 'claimed')
  assert.equal(decision.task.id, 'newer-high')
  assert.equal(decision.task.status, 'running')
  assert.equal(decision.task.attempts, 1)
  assert.deepEqual(decision.task.lease, {
    workerId: 'worker-a',
    renewedAt: '2026-07-04T00:00:00.000Z',
    expiresAt: '2026-07-04T00:05:00.000Z',
  })
})

test('workflow scheduler reclaims stale running tasks but ignores active leases', () => {
  const state: WorkflowState = {
    version: 1,
    tasks: [
      task({
        id: 'active-running',
        status: 'running',
        lease: {
          workerId: 'worker-b',
          renewedAt: '2026-07-04T00:00:00.000Z',
          expiresAt: '2026-07-04T00:10:00.000Z',
        },
      }),
      task({
        id: 'stale-running',
        status: 'running',
        priority: 5,
        lease: {
          workerId: 'worker-b',
          renewedAt: '2026-07-03T23:50:00.000Z',
          expiresAt: '2026-07-03T23:55:00.000Z',
        },
      }),
    ],
  }

  const decision = scheduleNextWorkflowTask(state, options())

  assert.equal(decision.type, 'claimed')
  assert.equal(decision.task.id, 'stale-running')
  assert.equal(decision.task.lease?.workerId, 'worker-a')
})

test('workflow scheduler renews only the owning worker lease', () => {
  const state: WorkflowState = {
    version: 1,
    tasks: [
      task({
        id: 'running',
        status: 'running',
        lease: {
          workerId: 'worker-a',
          renewedAt: '2026-07-03T23:59:00.000Z',
          expiresAt: '2026-07-04T00:01:00.000Z',
        },
      }),
    ],
  }

  const renewed = renewWorkflowLease(state, 'running', options())
  const ignored = renewWorkflowLease(state, 'running', options({ workerId: 'worker-b' }))

  assert.equal(renewed.tasks[0]?.lease?.expiresAt, '2026-07-04T00:05:00.000Z')
  assert.deepEqual(ignored, state)
})

test('workflow scheduler retries failures until max attempts then fails closed', () => {
  const claimed = scheduleNextWorkflowTask(
    { version: 1, tasks: [task({ maxAttempts: 2 })] },
    options(),
  )
  assert.equal(claimed.type, 'claimed')

  const retried = failWorkflowTask(claimed.state, claimed.task.id, 'first failure', now)
  const claimedAgain = scheduleNextWorkflowTask(
    retried,
    options({ now: new Date('2026-07-04T00:01:00.000Z') }),
  )
  assert.equal(claimedAgain.type, 'claimed')

  const failed = failWorkflowTask(claimedAgain.state, claimedAgain.task.id, 'second failure', now)

  assert.equal(failed.tasks[0]?.status, 'failed')
  assert.equal(failed.tasks[0]?.lastError, 'second failure')
})

test('workflow scheduler blocks invalid terminal transitions', () => {
  const state: WorkflowState = {
    version: 1,
    tasks: [task({ id: 'done', status: 'done' })],
  }

  assert.throws(
    () => completeWorkflowTask(state, 'done', now),
    (error: unknown) =>
      error instanceof WorkflowTransitionError &&
      error.message === 'workflow task done cannot transition from done to done',
  )
})

test('workflow scheduler exposes block and complete transitions', () => {
  const state: WorkflowState = {
    version: 1,
    tasks: [task({ id: 'needs-human' }), task({ id: 'ready' })],
  }

  const blocked = blockWorkflowTask(state, 'needs-human', 'waiting on Pro critique', now)
  const completed = completeWorkflowTask(blocked, 'ready', now)

  assert.equal(completed.tasks[0]?.status, 'blocked')
  assert.equal(completed.tasks[0]?.blockedReason, 'waiting on Pro critique')
  assert.equal(completed.tasks[1]?.status, 'done')
})

function sampleState(): WorkflowState {
  return {
    version: 1,
    tasks: [
      task({
        id: 'scheduler',
        prompt: 'Build the scheduler control plane.',
        priority: 20,
      }),
    ],
  }
}

function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: 'task-1',
    status: 'queued',
    updatedAt: '2026-07-04T00:00:00.000Z',
    prompt: 'Review the workflow.',
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    lease: null,
    blockedReason: null,
    lastError: null,
    ...overrides,
  }
}

function options(overrides: Partial<WorkflowSchedulerOptions> = {}): WorkflowSchedulerOptions {
  return {
    now,
    workerId: 'worker-a',
    leaseTtlMs: 5 * 60 * 1000,
    ...overrides,
  }
}
