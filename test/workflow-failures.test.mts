import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import {
  WORKFLOW_AGENT_FAILED,
  WORKFLOW_AGENT_RETRIED,
  WorkflowAgentFailures,
  type WorkflowJournalAgentResult,
  WorkflowJournalMonitor,
} from '../src/workflow-subagents.mjs'

// A workflow run's transcript directory under a fresh config root, with a
// transcript for each agent so the monitor can show it.
async function workflowRun(runId: string, agentIds: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-failures-'))
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  await mkdir(transcriptDir, { recursive: true })
  for (const agentId of agentIds) {
    await writeFile(
      join(transcriptDir, `agent-${agentId}.jsonl`),
      `${JSON.stringify({ message: { role: 'user', content: `Task of ${agentId}` } })}\n`,
    )
  }
  const journal = (...entries: unknown[]) =>
    appendFile(
      join(transcriptDir, 'journal.jsonl'),
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    )
  return { root, transcriptDir, journal }
}

function monitorFor(
  run: { root: string; transcriptDir: string },
  runId: string,
  options: {
    failureReason?: (agentId: string) => string | null | undefined
    failureReasonWaitMs?: number
  } = {},
) {
  const started: string[] = []
  const results: WorkflowJournalAgentResult[] = []
  const monitor = new WorkflowJournalMonitor({
    launch: {
      taskId: `${runId}-task`,
      runId,
      transcriptDir: run.transcriptDir,
      transcriptRoot: run.root,
      workflowName: 'review',
      summary: '',
    },
    onStarted: async (agent) => {
      started.push(agent.agentId)
    },
    onResult: async (result) => {
      results.push(result)
    },
    ...options,
  })
  return { monitor, started, results }
}

const key = (n: number) => `v1:${String(n).repeat(64).slice(0, 64)}`

test('workflow journal monitor ends a failed agent as failed, with the reason the workflow gave', async () => {
  const failed = 'aa00000000000001'
  const done = 'aa00000000000002'
  const run = await workflowRun('wf_failed_run', [failed, done])
  const { monitor, started, results } = monitorFor(run, 'wf_failed_run', {
    failureReason: (agentId) =>
      agentId === failed ? 'stalled — no progress for 600000ms' : undefined,
  })
  try {
    await run.journal(
      { type: 'started', key: key(1), agentId: failed },
      { type: 'started', key: key(2), agentId: done },
      { type: 'failed', key: key(1), agentId: failed },
      { type: 'result', key: key(2), agentId: done, result: 'All checks pass' },
    )
    await monitor.flush()
    assert.deepEqual(started, [failed, done])
    assert.deepEqual(results, [
      {
        agentId: failed,
        content: `stalled — no progress for 600000ms\nagentId: ${failed}`,
        isError: true,
      },
      { agentId: done, content: `All checks pass\nagentId: ${done}`, isError: false },
    ])
    assert.deepEqual(monitor.activeAgentIds(), [])
  } finally {
    await monitor.stop()
    await rm(run.root, { recursive: true, force: true })
  }
})

test('workflow journal monitor waits a while for the reason of a failure, then ends the agent without one', async () => {
  const late = 'ab00000000000001'
  const silent = 'ab00000000000002'
  const reasons = new Map<string, string>()
  const run = await workflowRun('wf_late_reason_run', [late, silent])
  const { monitor, results } = monitorFor(run, 'wf_late_reason_run', {
    failureReason: (agentId) => reasons.get(agentId),
    failureReasonWaitMs: 300,
  })
  try {
    await run.journal(
      { type: 'started', key: key(1), agentId: late },
      { type: 'started', key: key(2), agentId: silent },
      { type: 'failed', key: key(1), agentId: late },
      { type: 'failed', key: key(2), agentId: silent },
    )
    await monitor.flush()
    assert.deepEqual(results, [], 'the reason may still come')
    // The progress report with the reason arrives after the journal line.
    reasons.set(late, 'API Error: 500 Internal server error')
    await monitor.flush()
    assert.deepEqual(results, [
      {
        agentId: late,
        content: `API Error: 500 Internal server error\nagentId: ${late}`,
        isError: true,
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 400))
    await monitor.flush()
    assert.deepEqual(results.slice(1), [
      { agentId: silent, content: `${WORKFLOW_AGENT_FAILED}\nagentId: ${silent}`, isError: true },
    ])
  } finally {
    await monitor.stop()
    await rm(run.root, { recursive: true, force: true })
  }
})

test('workflow journal monitor stops waiting for failure reasons once the workflow is over', async () => {
  const failed = 'ac00000000000001'
  const run = await workflowRun('wf_settled_failure_run', [failed])
  const { monitor, results } = monitorFor(run, 'wf_settled_failure_run', {
    failureReason: () => null,
    failureReasonWaitMs: 60_000,
  })
  try {
    await run.journal(
      { type: 'started', key: key(1), agentId: failed },
      { type: 'failed', key: key(1), agentId: failed },
    )
    await monitor.flush()
    assert.deepEqual(results, [])
    const begun = Date.now()
    await monitor.drain(5_000)
    assert.ok(Date.now() - begun < 3_000, 'drain does not wait out the reason')
    assert.deepEqual(results, [
      { agentId: failed, content: `${WORKFLOW_AGENT_FAILED}\nagentId: ${failed}`, isError: true },
    ])
  } finally {
    await monitor.stop()
    await rm(run.root, { recursive: true, force: true })
  }
})

test('workflow journal monitor ends an attempt the workflow ran again as failed, without waiting for a reason', async () => {
  const first = 'ad00000000000001'
  const second = 'ad00000000000002'
  const third = 'ad00000000000003'
  const run = await workflowRun('wf_retried_run', [first, second, third])
  const failures = new WorkflowAgentFailures()
  const { monitor, results } = monitorFor(run, 'wf_retried_run', {
    failureReason: (agentId) => failures.reason(agentId),
    failureReasonWaitMs: 60_000,
  })
  const progress = (agentId: string) => [
    { type: 'workflow_agent', index: 1, label: 'review', agentId, state: 'start' },
  ]
  try {
    await run.journal({ type: 'started', key: key(1), agentId: first })
    failures.note(progress(first))
    await monitor.flush()
    assert.deepEqual(results, [], 'the only attempt so far is still running')
    // The first two attempts stall. Claude Code reports each stall's error
    // together with the next attempt's start, keeping only the start.
    await run.journal(
      { type: 'started', key: key(1), agentId: second },
      { type: 'started', key: key(1), agentId: third },
    )
    failures.note(progress(second))
    failures.note(progress(third))
    await monitor.flush()
    assert.deepEqual(results, [
      { agentId: first, content: `${WORKFLOW_AGENT_RETRIED}\nagentId: ${first}`, isError: true },
      { agentId: second, content: `${WORKFLOW_AGENT_RETRIED}\nagentId: ${second}`, isError: true },
    ])
    assert.deepEqual(monitor.activeAgentIds(), [third])
    await run.journal({ type: 'result', key: key(1), agentId: third, result: 'done' })
    await monitor.flush()
    assert.deepEqual(results.slice(2), [
      { agentId: third, content: `done\nagentId: ${third}`, isError: false },
    ])
  } finally {
    await monitor.stop()
    await rm(run.root, { recursive: true, force: true })
  }
})

test('workflow journal monitor skips a failure of a call whose agent never started', async () => {
  const running = 'ae00000000000001'
  const run = await workflowRun('wf_unstarted_failure_run', [running])
  const { monitor, started, results } = monitorFor(run, 'wf_unstarted_failure_run', {
    failureReasonWaitMs: 0,
  })
  try {
    await run.journal(
      { type: 'failed', key: key(1), agentId: '' },
      // Without a key, no started line is taken for an earlier attempt.
      { type: 'started', agentId: running },
    )
    await monitor.flush()
    assert.deepEqual(started, [running])
    assert.deepEqual(results, [])
    assert.deepEqual(monitor.activeAgentIds(), [running])
  } finally {
    await monitor.stop()
    await rm(run.root, { recursive: true, force: true })
  }
})

test('workflow agent failures take the reason of each attempt from the progress reports', () => {
  const failures = new WorkflowAgentFailures()
  const agent = (index: number, agentId: string | undefined, state: string, error?: string) => ({
    type: 'workflow_agent',
    index,
    label: `step ${index}`,
    ...(agentId ? { agentId } : {}),
    state,
    ...(error === undefined ? {} : { error }),
  })
  failures.note([
    { type: 'workflow_phase', index: 1, title: 'Review' },
    agent(1, 'af01', 'start'),
    agent(2, 'af02', 'start'),
  ])
  assert.equal(failures.reason('af01'), null)
  assert.equal(failures.reason('af02'), null)

  // Call 1's agent stalls and the call runs it again. Claude Code reports the
  // stall's error and the new attempt's start together, keeping only the
  // latest state of each call: the stall never shows.
  failures.note([agent(1, 'af03', 'start'), agent(2, 'af02', 'progress')])
  assert.equal(failures.reason('af01'), null)
  assert.equal(failures.reason('af03'), null)

  // The call throws once its attempts are over: that error has no agentId
  // and belongs to the last attempt only.
  failures.note([agent(1, undefined, 'error', 'agent stalled \x1b[31mon all\x1b[0m 2\nattempts')])
  assert.equal(failures.reason('af03'), 'agent stalled on all 2 attempts')
  assert.equal(failures.reason('af01'), null)
  assert.equal(failures.reason('af02'), null)

  // A withheld script still says that its agent failed.
  failures.note([agent(2, 'af02', 'error', 'error details withheld for this workflow')])
  assert.equal(failures.reason('af02'), 'error details withheld for this workflow')

  failures.note(null)
  failures.note([null, 'x', { type: 'workflow_agent', index: 'x', agentId: 7, state: 'error' }])
  assert.equal(failures.reason('unknown'), null)
})

test('native SDK runtime ends a failed workflow agent as failed, and the workflow completing does not revive it', async () => {
  const runId = 'wf_runtime_failed_run'
  const failed = 'b000000000000001'
  const done = 'b000000000000002'
  const run = await workflowRun(runId, [failed, done])
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['wf-launch']),
    workflowTranscriptRoots: [run.root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const agentResults = () =>
    events.filter(
      (event) =>
        event.type === 'tool_result' && String(event.toolUseId).startsWith('workflow-agent:'),
    )
  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'wf-task',
      tool_use_id: 'wf-launch',
      task_type: 'local_workflow',
      workflow_name: 'review',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'wf-task',
        taskType: 'local_workflow',
        workflowName: 'review',
        runId,
        transcriptDir: run.transcriptDir,
      },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'wf-launch', content: 'Workflow launched.' }],
      },
    })
    await run.journal(
      { type: 'started', key: key(1), agentId: failed },
      { type: 'started', key: key(2), agentId: done },
    )
    await handleSystem.call(runtime, pending, {
      subtype: 'task_progress',
      task_id: 'wf-task',
      workflow_progress: [
        {
          type: 'workflow_agent',
          index: 1,
          agentId: failed,
          state: 'error',
          error: 'stalled — no progress for 600000ms',
        },
        { type: 'workflow_agent', index: 2, agentId: done, state: 'progress' },
      ],
    })
    await run.journal({ type: 'failed', key: key(1), agentId: failed })
    const deadline = Date.now() + 3_000
    while (agentResults().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // It fails while the workflow still runs.
    assert.deepEqual(
      agentResults().map((event) => [event.toolUseId, event.content, event.isError]),
      [
        [
          `workflow-agent:wf-task:${failed}`,
          `stalled — no progress for 600000ms\nagentId: ${failed}`,
          true,
        ],
      ],
    )
    await run.journal({ type: 'result', key: key(2), agentId: done, result: 'All checks pass' })
    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'wf-task',
      status: 'completed',
      summary: 'Review completed',
    })
    assert.deepEqual(
      agentResults().map((event) => [event.toolUseId, event.isError]),
      [
        [`workflow-agent:wf-task:${failed}`, true],
        [`workflow-agent:wf-task:${done}`, false],
      ],
    )
    assert.equal(agentResults()[1].content, `All checks pass\nagentId: ${done}`)
    assert.equal(pending.activeSubagents.size, 0)
  } finally {
    await Reflect.get(runtime, 'stopWorkflowTasks').call(runtime, pending)
    await rm(run.root, { recursive: true, force: true })
  }
})
