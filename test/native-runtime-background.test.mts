import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { readTaskResult } from '../src/task-output.mjs'
import type {
  RuntimeBackgroundListener,
  RuntimeEvent,
  RuntimeHandlers,
  RuntimeTaskEvent,
  RuntimeTurnContext,
} from '../src/types.mjs'

const context: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn-1',
  prompt: 'start a background agent',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  enableFileCheckpointing: false,
  outputFormat: null,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

// A Claude session the test drives by hand: it records what the runtime sends
// and yields whatever the test pushes, until closed.
class FakeQuery implements AsyncIterable<Record<string, unknown>> {
  prompts: Record<string, unknown>[] = []
  interrupts = 0
  stoppedTasks: string[] = []
  closed = false
  private queue: Record<string, unknown>[] = []
  private wake: (() => void) | null = null

  constructor(prompt: AsyncIterable<Record<string, unknown>>) {
    void (async () => {
      for await (const message of prompt) this.prompts.push(message)
    })()
  }

  push(...messages: Record<string, unknown>[]): void {
    this.queue.push(...messages)
    this.notify()
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1
  }

  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId)
  }

  async setModel(): Promise<void> {}

  async setPermissionMode(): Promise<void> {}

  close(): void {
    this.closed = true
    this.notify()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

// A session whose CLI answers get_task_output with what each task in
// `outputs` printed so far.
class ShellQuery extends FakeQuery {
  readonly outputs = new Map<string, string>()

  async getTaskOutput(taskId: string): Promise<unknown> {
    const output = this.outputs.get(taskId)
    if (output === undefined) throw new Error(`No task found with ID: ${taskId}`)
    return { output, total_bytes: Buffer.byteLength(output), truncated: false }
  }
}

interface RecordingListener extends RuntimeBackgroundListener {
  tasks: RuntimeTaskEvent[]
  autonomous: string[]
  released: { threadId: string; liveTaskIds: string[] }[]
}

function fakeRuntime<Q extends FakeQuery = FakeQuery>(
  create: (prompt: AsyncIterable<Record<string, unknown>>) => Q = (prompt) =>
    new FakeQuery(prompt) as Q,
): { runtime: NativeClaudeRuntime; queries: Q[] } {
  const runtime = new NativeClaudeRuntime()
  const queries: Q[] = []
  Reflect.set(runtime, 'sdk', {
    query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
      const query = create(prompt)
      queries.push(query)
      return query
    },
  })
  return { runtime, queries }
}

function recordingListener(): RecordingListener {
  const listener: RecordingListener = {
    tasks: [],
    autonomous: [],
    released: [],
    onTaskEvent: async (_threadId, event) => {
      listener.tasks.push(event)
    },
    onAutonomousTurn: (threadId) => {
      listener.autonomous.push(threadId)
    },
    onSessionReleased: (threadId, liveTaskIds) => {
      listener.released.push({ threadId, liveTaskIds })
    },
  }
  return listener
}

function handlers(events: RuntimeEvent[]): RuntimeHandlers {
  return {
    onEvent: async (event) => {
      events.push(event)
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onUserInputRequest: async () => ({ answers: {} }),
  }
}

async function waitFor<T>(
  probe: () => T,
  label: string,
  timeoutMs = 2_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value as NonNullable<T>
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function withSettleMs<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CODEX_SESSION_SETTLE_MS
  process.env.CLAUDE_CODEX_SESSION_SETTLE_MS = String(ms)
  return run().finally(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_SESSION_SETTLE_MS
    else process.env.CLAUDE_CODEX_SESSION_SETTLE_MS = previous
  })
}

function assistant(id: string, content: Record<string, unknown>[]) {
  return { type: 'assistant', message: { id, content } }
}

function text(value: string) {
  return { type: 'text', text: value }
}

function launchBackgroundAgent(taskId: string, toolUseId = 'agent-use') {
  return [
    assistant('launch', [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: { description: 'investigate', prompt: 'investigate', run_in_background: true },
      },
    ]),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      task_type: 'local_agent',
      description: 'investigate',
      is_backgrounded: true,
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Async agent launched successfully.\nagentId: ${taskId}`,
          },
        ],
      },
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: taskId },
    },
    assistant('ack', [text('The agent is running in the background.')]),
    { type: 'result', subtype: 'success', result: 'The agent is running in the background.' },
  ]
}

function textDeltas(events: RuntimeEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : []))
}

test('native session outlives its turn while a background agent runs and hands the report to a continuation turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-codex-bg-'))
  const outputFile = join(dir, 'agent-a1.jsonl')
  writeFileSync(
    outputFile,
    [
      { type: 'user', message: { role: 'user', content: 'investigate' } },
      { type: 'assistant', message: { role: 'assistant', id: 'm1', content: [text('Looking.')] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
      { type: 'assistant', message: { role: 'assistant', id: 'm2', content: [text('Found it')] } },
      {
        type: 'assistant',
        message: { role: 'assistant', id: 'm2', content: [text('in parser.ts')] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n'),
  )
  try {
    await withSettleMs(40, async () => {
      const { runtime, queries } = fakeRuntime()
      const listener = recordingListener()
      runtime.setBackgroundListener(listener)

      const firstEvents: RuntimeEvent[] = []
      const first = runtime.runTurn(context, handlers(firstEvents))
      const query = await waitFor(() => queries[0], 'session')
      query.push(...launchBackgroundAgent('a1'))
      await first

      const launch = firstEvents.find((event) => event.type === 'tool_result')
      assert.equal(launch?.type === 'tool_result' && launch.structured?.status, 'async_launched')
      assert.equal(query.closed, false, 'the session must outlive the turn')
      assert.equal(runtime.hasBackgroundWork(), true)
      assert.equal(runtime.hasPendingContinuation('thread'), false)
      assert.deepEqual(
        listener.tasks.map((event) => event.type),
        ['task_started'],
      )
      const started = listener.tasks[0]
      assert.equal(started?.type === 'task_started' && started.toolUseId, 'agent-use')

      // The agent finishes and Claude answers its notification on its own.
      query.push(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'a1',
          status: 'completed',
          output_file: outputFile,
          summary: 'Agent "investigate" completed',
          usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 5000 },
        },
        {
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'reply' } },
        },
        assistant('reply', [text('The agent found the bug in parser.ts.')]),
        {
          type: 'result',
          subtype: 'success',
          result: 'The agent found the bug in parser.ts.',
          origin: { kind: 'task-notification' },
        },
      )
      await waitFor(() => listener.autonomous.length === 1, 'autonomous turn request')
      const notification = await waitFor(
        () => listener.tasks.find((event) => event.type === 'task_notification'),
        'task notification',
      )
      assert.deepEqual(notification, {
        type: 'task_notification',
        taskId: 'a1',
        toolUseId: 'agent-use',
        status: 'completed',
        summary: 'Agent "investigate" completed',
        result: 'Found it\nin parser.ts',
        usage: { totalTokens: 1234, toolUses: 3, durationMs: 5000 },
      })
      await waitFor(() => runtime.hasPendingContinuation('thread'), 'pending continuation')

      const wakeEvents: RuntimeEvent[] = []
      await runtime.runTurn(
        { ...context, turnId: 'turn-2', prompt: '', continuation: true },
        handlers(wakeEvents),
      )
      assert.deepEqual(textDeltas(wakeEvents), ['The agent found the bug in parser.ts.'])
      const completed = wakeEvents.find((event) => event.type === 'completed')
      assert.equal(completed?.type === 'completed' && completed.success, true)
      assert.equal(query.prompts.length, 1, 'a continuation sends nothing to Claude')

      // Nothing is left running, so the session closes once it settles, even
      // though the continuation consumed the last message Claude sent.
      await waitFor(() => listener.released.length === 1, 'session release')
      assert.deepEqual(listener.released, [{ threadId: 'thread', liveTaskIds: [] }])
      assert.equal(query.closed, true)
      assert.equal(runtime.hasBackgroundWork(), false)
      assert.equal(listener.autonomous.length, 1)
      await runtime.stop()
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native user turn reuses the live session and receives a report that lands mid-turn', async () => {
  await withSettleMs(40, async () => {
    const { runtime, queries } = fakeRuntime()
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)

    const first = runtime.runTurn(context, handlers([]))
    const query = await waitFor(() => queries[0], 'session')
    query.push(...launchBackgroundAgent('a2'))
    await first

    const secondEvents: RuntimeEvent[] = []
    const second = runtime.runTurn(
      { ...context, turnId: 'turn-2', prompt: 'anything new?' },
      handlers(secondEvents),
    )
    await waitFor(() => query.prompts.length === 2, 'second prompt')
    assert.equal(queries.length, 1, 'the second turn must reuse the live session')
    query.push(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'a2',
        status: 'failed',
        summary: 'Agent failed',
      },
      assistant('answer', [text('The agent failed.')]),
      { type: 'result', subtype: 'success', result: 'The agent failed.' },
    )
    await second
    assert.deepEqual(textDeltas(secondEvents), ['The agent failed.'])
    const notification = listener.tasks.find((event) => event.type === 'task_notification')
    assert.equal(notification?.type === 'task_notification' && notification.status, 'failed')
    assert.equal(listener.autonomous.length, 0, 'a report inside a user turn needs no wake-up')
    await waitFor(() => listener.released.length === 1, 'session release')
    await runtime.stop()
  })
})

test('native interrupt with live background work stops only the turn and keeps the session', async () => {
  const { runtime, queries } = fakeRuntime()
  const listener = recordingListener()
  runtime.setBackgroundListener(listener)

  const first = runtime.runTurn(context, handlers([]))
  const query = await waitFor(() => queries[0], 'session')
  query.push(...launchBackgroundAgent('a3'))
  await first

  const secondEvents: RuntimeEvent[] = []
  const second = runtime.runTurn(
    { ...context, turnId: 'turn-2', prompt: 'long task' },
    handlers(secondEvents),
  )
  await waitFor(() => query.prompts.length === 2, 'second prompt')
  query.push(assistant('partial', [text('Working on it')]))
  await waitFor(() => textDeltas(secondEvents).length === 1, 'partial output')
  await runtime.interrupt('thread')
  await second

  assert.equal(query.interrupts, 1)
  assert.equal(query.closed, false, 'interrupting must not kill the background agent')
  assert.equal(runtime.hasBackgroundWork(), true)
  assert.equal(
    secondEvents.some((event) => event.type === 'completed'),
    false,
    'the server settles an interrupted turn itself',
  )

  // The aborted turn's tail is swallowed rather than starting a turn.
  query.push(assistant('tail', [text('...stopped')]), {
    type: 'result',
    subtype: 'error_during_execution',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(listener.autonomous.length, 0)
  assert.equal(runtime.hasPendingContinuation('thread'), false)

  assert.equal(await runtime.stopTask('thread', 'a3'), true)
  assert.deepEqual(query.stoppedTasks, ['a3'])
  await runtime.stop()
})

test('native interrupt stops the workflow the turn launched and leaves background agents running', async () => {
  const { runtime, queries } = fakeRuntime()
  const listener = recordingListener()
  runtime.setBackgroundListener(listener)

  const first = runtime.runTurn(context, handlers([]))
  const query = await waitFor(() => queries[0], 'session')
  query.push(...launchBackgroundAgent('a4'))
  await first

  const second = runtime.runTurn(
    { ...context, turnId: 'turn-2', prompt: 'run a workflow' },
    handlers([]),
  )
  await waitFor(() => query.prompts.length === 2, 'second prompt')
  query.push(
    assistant('launch-workflow', [
      { type: 'tool_use', id: 'workflow-use', name: 'Workflow', input: { name: 'review' } },
    ]),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'w1',
      tool_use_id: 'workflow-use',
      task_type: 'local_workflow',
      workflow_name: 'review',
      description: 'review',
      is_backgrounded: true,
    },
  )
  await waitFor(
    () => listener.tasks.some((event) => event.type === 'task_started' && event.taskId === 'a4'),
    'agent task',
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  await runtime.interrupt('thread')
  await second

  assert.deepEqual(query.stoppedTasks, ['w1'], 'only the workflow is stopped')
  assert.equal(query.closed, false)

  // The CLI reports the stopped workflow and starts a turn to acknowledge it;
  // nothing wakes the thread for a task the user stopped.
  query.push(
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'w1',
      tool_use_id: 'workflow-use',
      task_type: 'local_workflow',
      status: 'stopped',
      summary: 'stopped',
    },
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    assistant('ack', [text('The workflow was stopped.')]),
    { type: 'result', subtype: 'success', result: 'The workflow was stopped.' },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(listener.autonomous, [])
  await runtime.stop()
})

test('native parked agent stops holding the session open', async () => {
  await withSettleMs(40, async () => {
    const { runtime, queries } = fakeRuntime()
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)

    const first = runtime.runTurn(context, handlers([]))
    const query = await waitFor(() => queries[0], 'session')
    query.push(...launchBackgroundAgent('a4'))
    await first
    assert.equal(runtime.hasBackgroundWork(), true)

    query.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'a4',
      patch: { status: 'paused' },
    })
    const updated = await waitFor(
      () => listener.tasks.find((event) => event.type === 'task_updated'),
      'task update',
    )
    assert.equal(updated.type === 'task_updated' && updated.status, 'paused')
    await waitFor(() => listener.released.length === 1, 'session release')
    assert.deepEqual(listener.released, [{ threadId: 'thread', liveTaskIds: [] }])
    await runtime.stop()
  })
})

test('native background level replaces task edges and reports tasks still alive at release', async () => {
  const { runtime, queries } = fakeRuntime()
  const listener = recordingListener()
  runtime.setBackgroundListener(listener)

  const first = runtime.runTurn(context, handlers([]))
  const query = await waitFor(() => queries[0], 'session')
  query.push(
    ...launchBackgroundAgent('a5').slice(0, 3),
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a5' }, { task_id: 'monitor', ambient: true }, { task_id: 'b1' }],
    },
    // An edge must not override the level once a level has been seen.
    { type: 'system', subtype: 'task_updated', task_id: 'a5', patch: { status: 'paused' } },
    ...launchBackgroundAgent('a5').slice(3),
  )
  await first
  assert.equal(runtime.hasBackgroundWork(), true)

  // The CLI process goes away with work still running.
  query.close()
  await waitFor(() => listener.released.length === 1, 'session release')
  assert.deepEqual(listener.released, [{ threadId: 'thread', liveTaskIds: ['a5', 'b1'] }])
  await runtime.stop()
})

test('native runtime without a background listener keeps closing the session per turn', async () => {
  const { runtime, queries } = fakeRuntime()
  const first = runtime.runTurn(context, handlers([]))
  const query = await waitFor(() => queries[0], 'session')
  query.push(...launchBackgroundAgent('a6'))
  await first
  await waitFor(() => query.closed, 'session close')
  assert.equal(runtime.hasBackgroundWork(), false)
  await runtime.stop()
})

// Frames the real CLI brackets every turn and every send with.
const init = { type: 'system', subtype: 'init', session_id: 'session' }

function lifecycle(uuid: unknown, state: 'queued' | 'started' | 'completed') {
  return { type: 'command_lifecycle', command_uuid: uuid, state, uuid: `frame-${state}` }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('native notification turn survives a long model wait after its init', async () => {
  await withSettleMs(30, async () => {
    const { runtime, queries } = fakeRuntime()
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)

    const first = runtime.runTurn(context, handlers([]))
    const query = await waitFor(() => queries[0], 'session')
    query.push(...launchBackgroundAgent('a7'))
    await first

    query.push(
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
      { type: 'system', subtype: 'task_notification', task_id: 'a7', status: 'completed' },
      init,
    )
    await waitFor(() => listener.autonomous.length === 1, 'wake-up on init')
    // The model is unreachable for a while; nothing but retries arrives for
    // far longer than the settle window.
    query.push({ type: 'system', subtype: 'api_retry', attempt: 1 })
    await sleep(120)
    assert.equal(query.closed, false, 'a running CLI turn keeps its session')

    const events: RuntimeEvent[] = []
    const wake = runtime.runTurn(
      { ...context, turnId: 'turn-2', prompt: '', continuation: true },
      handlers(events),
    )
    query.push(assistant('reply', [text('Done.')]), {
      type: 'result',
      subtype: 'success',
      result: 'Done.',
      origin: { kind: 'task-notification' },
    })
    await wake
    assert.deepEqual(textDeltas(events), ['Done.'])
    await waitFor(() => listener.released.length === 1, 'session release')
    await runtime.stop()
  })
})

test('native interrupt cancels a queued prompt the CLI starts later and holds the next one', async () => {
  const { runtime, queries } = fakeRuntime()
  const listener = recordingListener()
  runtime.setBackgroundListener(listener)

  const first = runtime.runTurn(context, handlers([]))
  const query = await waitFor(() => queries[0], 'session')
  query.push(...launchBackgroundAgent('a8'))
  await first

  const second = runtime.runTurn(
    { ...context, turnId: 'turn-2', prompt: 'long task' },
    handlers([]),
  )
  await waitFor(() => query.prompts.length === 2, 'second prompt')
  const cancelled = query.prompts[1]?.uuid
  query.push(lifecycle(cancelled, 'queued'))
  await sleep(10)
  await runtime.interrupt('thread')
  await second
  assert.equal(query.interrupts, 1)

  const thirdEvents: RuntimeEvent[] = []
  const third = runtime.runTurn(
    { ...context, turnId: 'turn-3', prompt: 'next' },
    handlers(thirdEvents),
  )
  await sleep(20)
  assert.equal(query.prompts.length, 2, 'the next prompt waits for the cancelled one')

  // interrupt() does not reach a queued send: the CLI starts it anyway.
  query.push(lifecycle(cancelled, 'started'))
  await waitFor(() => query.interrupts === 2, 'the cancelled prompt interrupted as it starts')
  query.push(
    init,
    assistant('stale', [text('stale')]),
    { type: 'result', subtype: 'error_during_execution', user_message_uuids: [cancelled] },
    lifecycle(cancelled, 'completed'),
  )
  await waitFor(() => query.prompts.length === 3, 'next prompt sent once drained')
  const next = query.prompts[2]?.uuid
  query.push(
    lifecycle(next, 'queued'),
    lifecycle(next, 'started'),
    init,
    assistant('fresh', [text('fresh')]),
    { type: 'result', subtype: 'success', result: 'fresh', user_message_uuids: [next] },
    lifecycle(next, 'completed'),
  )
  await third
  assert.deepEqual(textDeltas(thirdEvents), ['fresh'])
  assert.equal(listener.autonomous.length, 0, 'the cancelled turn must not wake the thread')
  await runtime.stop()
})

test('native steer is accepted once the CLI starts consuming it', async () => {
  const { runtime, queries } = fakeRuntime()
  const first = runtime.runTurn(context, handlers([]))
  const query = await waitFor(() => queries[0], 'session')
  const prompt = query.prompts[0]?.uuid
  query.push(lifecycle(prompt, 'queued'), lifecycle(prompt, 'started'), init)
  query.push(
    assistant('m1', [
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sleep 8' } },
    ]),
  )

  let accepted = 0
  assert.equal(
    await runtime.steer('thread', 'also this', { onAccepted: () => (accepted += 1) }),
    true,
  )
  await waitFor(() => query.prompts.length === 2, 'steer sent')
  const steer = query.prompts[1]?.uuid
  query.push(lifecycle(steer, 'queued'))
  await sleep(10)
  assert.equal(accepted, 0, 'queued behind the running tool is not accepted yet')

  query.push(
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1' }] } },
    lifecycle(steer, 'started'),
  )
  await waitFor(() => accepted === 1, 'accepted at the tool-round boundary')
  query.push(
    assistant('m2', [text('done')]),
    lifecycle(steer, 'completed'),
    { type: 'result', subtype: 'success', result: 'done', user_message_uuids: [prompt, steer] },
    lifecycle(prompt, 'completed'),
  )
  await first
  assert.equal(accepted, 1)
  assert.equal(await runtime.steer('thread', 'late'), false, 'no turn left to steer')
  await runtime.stop()
})

test('native drops the turn Claude starts only to acknowledge a task the user stopped', async () => {
  await withSettleMs(30, async () => {
    const { runtime, queries } = fakeRuntime()
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)

    const first = runtime.runTurn(context, handlers([]))
    const query = await waitFor(() => queries[0], 'session')
    query.push(...launchBackgroundAgent('a9'))
    await first

    assert.equal(await runtime.stopTask('thread', 'a9'), true)
    query.push(
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
      { type: 'system', subtype: 'task_updated', task_id: 'a9', patch: { status: 'killed' } },
      { type: 'system', subtype: 'task_notification', task_id: 'a9', status: 'stopped' },
      init,
    )
    await waitFor(() => query.interrupts === 1, 'acknowledgement interrupted')
    query.push(assistant('ack', [text('The agent was stopped.')]), {
      type: 'result',
      subtype: 'error_during_execution',
      origin: { kind: 'task-notification' },
    })
    await waitFor(() => listener.released.length === 1, 'session release')
    assert.equal(listener.autonomous.length, 0, 'a user stop must not wake the thread')
    await runtime.stop()
  })
})

for (const order of ['before', 'after'] as const) {
  test(`native drops the turn Claude starts only to acknowledge agents an interrupt stopped (notice ${order} the result)`, async () => {
    await withSettleMs(30, async () => {
      const { runtime, queries } = fakeRuntime()
      const listener = recordingListener()
      runtime.setBackgroundListener(listener)

      const first = runtime.runTurn(context, handlers([]))
      const query = await waitFor(() => queries[0], 'session')
      query.push(...launchBackgroundAgent('b0', 'agent-use-0'))
      await first

      // The next turn launches another agent and is still running when the
      // user stops it.
      const second = runtime.runTurn({ ...context, turnId: 'turn-2', prompt: 'more' }, handlers([]))
      await waitFor(() => query.prompts.length === 2, 'second prompt')
      query.push(
        init,
        ...launchBackgroundAgent('b1', 'agent-use-1').slice(0, 3),
        assistant('bash', [
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sleep 30' } },
        ]),
      )
      await sleep(10)
      await runtime.interrupt('thread')
      await second
      assert.equal(query.interrupts, 1)

      // The CLI stops the agent that turn launched along with it, then starts
      // a turn of its own to tell Claude so.
      const notice = [
        { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'killed' } },
        { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'stopped' },
      ]
      const end = { type: 'result', subtype: 'error_during_execution' }
      query.push(...(order === 'before' ? [...notice, end] : [end, ...notice]), init)
      await waitFor(() => query.interrupts === 2, 'acknowledgement interrupted')
      query.push(assistant('ack', [text('The agent was stopped.')]), {
        type: 'result',
        subtype: 'error_during_execution',
        origin: { kind: 'task-notification' },
      })
      await sleep(20)
      assert.equal(listener.autonomous.length, 0, 'stopping the turn must not wake the thread')

      // The agent from before keeps running; its report still wakes the thread.
      query.push(
        { type: 'system', subtype: 'task_notification', task_id: 'b0', status: 'completed' },
        init,
      )
      await waitFor(() => listener.autonomous.length === 1, 'wake-up for the surviving agent')
      await runtime.stop()
    })
  })
}

function failingOn(type: RuntimeEvent['type']): RuntimeHandlers {
  return {
    ...handlers([]),
    onEvent: async (event) => {
      if (event.type === type) throw new Error('database is locked')
    },
  }
}

test('native turn the server fails mid-stream takes a session with nothing else running down with it', async () => {
  await withSettleMs(40, async () => {
    const { runtime, queries } = fakeRuntime()
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)

    const turn = runtime.runTurn(context, failingOn('text_delta'))
    const query = await waitFor(() => queries[0], 'session')
    query.push(init, assistant('m1', [text('Editing the parser')]))
    await assert.rejects(turn, /database is locked/)
    assert.equal(query.closed, true, 'the CLI must not carry on with a failed turn')

    query.push(assistant('m2', [text('Still editing')]), {
      type: 'result',
      subtype: 'success',
      result: 'Still editing',
    })
    await sleep(50)
    assert.deepEqual(listener.autonomous, [], 'the rest of the failed turn is not replayed')
    await runtime.stop()
  })
})

test('native turn the server fails mid-stream stops only that turn while background work runs', async () => {
  await withSettleMs(40, async () => {
    const { runtime, queries } = fakeRuntime()
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)

    const first = runtime.runTurn(context, handlers([]))
    const query = await waitFor(() => queries[0], 'session')
    query.push(...launchBackgroundAgent('a5'))
    await first

    const second = runtime.runTurn(
      { ...context, turnId: 'turn-2', prompt: 'and now this' },
      failingOn('text_delta'),
    )
    await waitFor(() => query.prompts.length === 2, 'second prompt')
    query.push(init, assistant('m2', [text('Working on it')]))
    await assert.rejects(second, /database is locked/)
    assert.equal(query.interrupts, 1, 'the CLI turn is interrupted')
    assert.equal(query.closed, false, 'the background agent keeps its session')

    // What the CLI still sends for that turn is drained, not replayed.
    query.push(assistant('m3', [text('Still working')]), {
      type: 'result',
      subtype: 'error_during_execution',
      result: '',
    })
    await sleep(50)
    assert.deepEqual(listener.autonomous, [])
    assert.equal(runtime.hasBackgroundWork(), true)
    await runtime.stop()
  })
})

test('readTaskResult returns the final response of a subagent transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-codex-task-'))
  try {
    const file = join(dir, 'agent.jsonl')
    writeFileSync(
      file,
      [
        '{"partial line from a truncated tail',
        JSON.stringify({ message: { role: 'assistant', id: 'a', content: [text('Earlier')] } }),
        JSON.stringify({ message: { role: 'user', content: 'tool output' } }),
        JSON.stringify({
          message: {
            role: 'assistant',
            id: 'b',
            content: [{ type: 'thinking', thinking: 'hidden' }, text('Final')],
          },
        }),
        JSON.stringify({ message: { role: 'assistant', id: 'b', content: [text('answer')] } }),
        '',
      ].join('\n'),
    )
    assert.equal(await readTaskResult(file), 'Final\nanswer')

    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '')
    assert.equal(await readTaskResult(empty), null)
    assert.equal(await readTaskResult(join(dir, 'missing.jsonl')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the main loop keeps its own tools and text beside an Agent call; only subagent frames drop', async () => {
  const { runtime, queries } = fakeRuntime()
  const events: RuntimeEvent[] = []
  const turn = runtime.runTurn(context, handlers(events))
  const query = await waitFor(() => queries[0], 'session')
  const main = (id: string, block: Record<string, unknown>, output: number) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id, content: [block], usage: { input_tokens: 100, output_tokens: output } },
  })
  query.push(
    main('m1', { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'look' } }, 5),
    main('m1', { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } }, 30),
    {
      type: 'stream_event',
      parent_tool_use_id: 'agent-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'inner text' },
      },
    },
    {
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: {
        id: 'sub-1',
        content: [{ type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'x' } }],
        usage: { input_tokens: 999, output_tokens: 9 },
      },
    },
    {
      type: 'user',
      parent_tool_use_id: 'agent-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'grep-1', content: 'hit' }] },
    },
    {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'file' }] },
    },
    {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'report' }] },
    },
    assistant('m2', [text('done')]),
    { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 220 } },
  )
  await turn

  assert.equal(runtime.filtersNestedEvents(), true)
  assert.deepEqual(
    events.flatMap((event) => (event.type === 'tool_use' ? [event.toolUseId] : [])),
    ['agent-1', 'bash-1'],
  )
  assert.deepEqual(
    events.flatMap((event) => (event.type === 'tool_result' ? [event.toolUseId] : [])),
    ['bash-1', 'agent-1'],
  )
  assert.deepEqual(textDeltas(events), ['done'])
  assert.deepEqual(
    events.flatMap((event) =>
      event.type === 'usage_progress' ? [`${event.messageId}:${event.usage.output_tokens}`] : [],
    ),
    ['m1:5', 'm1:30'],
    'only main-loop API calls count toward goal progress',
  )
})

test('the result reports the context window of the model behind the main loop', async () => {
  const { runtime, queries } = fakeRuntime()
  const events: RuntimeEvent[] = []
  const turn = runtime.runTurn(context, handlers(events))
  const query = await waitFor(() => queries[0], 'session')
  query.push(
    { type: 'assistant', message: { id: 'm1', model: 'claude-main', content: [text('hi')] } },
    {
      type: 'result',
      subtype: 'success',
      result: 'hi',
      usage: { input_tokens: 10, output_tokens: 2 },
      // A subagent on another model shows up here too.
      modelUsage: {
        'claude-small': { contextWindow: 100_000 },
        'claude-main': { contextWindow: 1_000_000 },
      },
    },
  )
  await turn
  const usage = events.find((event) => event.type === 'usage')
  assert.equal(usage?.type === 'usage' ? usage.contextWindow : undefined, 1_000_000)
})

function createCron(toolUseId: string, jobId: string): Record<string, unknown>[] {
  return [
    assistant(`create-${toolUseId}`, [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'CronCreate',
        input: { cron: '23 */2 * * *', prompt: 'run the check', recurring: true },
      },
    ]),
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Scheduled recurring job ${jobId} (Every 2 hours at :23).`,
          },
        ],
      },
      tool_use_result: {
        id: jobId,
        humanSchedule: 'Every 2 hours at :23',
        recurring: true,
        durable: false,
      },
    },
    assistant(`ack-${toolUseId}`, [text('Scheduled.')]),
    { type: 'result', subtype: 'success', result: 'Scheduled.' },
  ]
}

test('native session stays open for a session cron job and hands each fire to a turn of its own', async () => {
  await withSettleMs(40, async () => {
    const { runtime, queries } = fakeRuntime()
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)

    const first = runtime.runTurn(context, handlers([]))
    const query = await waitFor(() => queries[0], 'session')
    query.push(init, ...createCron('cron-use', 'job-1'))
    await first
    await sleep(80)
    assert.equal(query.closed, false, 'the job lives in this process')
    // A schedule alone does not keep the adapter up once the App is gone.
    assert.equal(runtime.hasBackgroundWork(), false)

    // The job fires: Claude starts a turn on its own.
    query.push(init, assistant('fire', [text('Checked.')]), {
      type: 'result',
      subtype: 'success',
      result: 'Checked.',
    })
    await waitFor(() => listener.autonomous.length === 1, 'autonomous turn request')
    const wakeEvents: RuntimeEvent[] = []
    await runtime.runTurn(
      { ...context, turnId: 'turn-2', prompt: '', continuation: true },
      handlers(wakeEvents),
    )
    assert.deepEqual(textDeltas(wakeEvents), ['Checked.'])

    // Deleting the job lets the session go.
    const third = runtime.runTurn(
      { ...context, turnId: 'turn-3', prompt: 'stop the check' },
      handlers([]),
    )
    await waitFor(() => query.prompts.length === 2, 'third prompt')
    assert.equal(queries.length, 1, 'the next turn reuses the session')
    query.push(
      init,
      assistant('delete', [
        { type: 'tool_use', id: 'delete-use', name: 'CronDelete', input: { id: 'job-1' } },
      ]),
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'delete-use', content: 'Cancelled.' }],
        },
      },
      assistant('done', [text('Stopped.')]),
      { type: 'result', subtype: 'success', result: 'Stopped.' },
    )
    await third
    await waitFor(() => query.closed, 'session close')
    await runtime.stop()
  })
})

test('native interrupt keeps a session that has a cron job scheduled', async () => {
  const { runtime, queries } = fakeRuntime()
  runtime.setBackgroundListener(recordingListener())

  const first = runtime.runTurn(context, handlers([]))
  const query = await waitFor(() => queries[0], 'session')
  query.push(init, ...createCron('cron-use', 'job-1'))
  await first

  const secondEvents: RuntimeEvent[] = []
  const second = runtime.runTurn(
    { ...context, turnId: 'turn-2', prompt: 'long task' },
    handlers(secondEvents),
  )
  await waitFor(() => query.prompts.length === 2, 'second prompt')
  query.push(init, assistant('partial', [text('Working on it')]))
  await waitFor(() => textDeltas(secondEvents).length === 1, 'partial output')
  await runtime.interrupt('thread')
  await second
  assert.equal(query.interrupts, 1)
  assert.equal(query.closed, false, 'interrupting must not drop the scheduled job')
  await runtime.stop()
})

test('native session resumed from a transcript stays open for the cron jobs the CLI schedules again', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-codex-cron-'))
  const projects = join(home, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9-]/g, '-'))
  mkdirSync(projects, { recursive: true })
  const transcript = (createdAt: number) =>
    createCron('cron-use', 'job-1')
      .slice(0, 2)
      .map((message, index) =>
        JSON.stringify({
          ...message,
          uuid: `line-${index}`,
          timestamp: new Date(createdAt).toISOString(),
          toolUseResult: message.tool_use_result,
        }),
      )
      .join('\n')
  writeFileSync(join(projects, 'scheduled.jsonl'), transcript(Date.now() - 60 * 60 * 1000))
  // The CLI retires a recurring job after seven days.
  writeFileSync(join(projects, 'expired.jsonl'), transcript(Date.now() - 8 * 24 * 60 * 60 * 1000))
  const saved = { ...process.env }
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIRS
  delete process.env.CLAUDE_ROUTER_DIR
  try {
    await withSettleMs(40, async () => {
      for (const [claudeSessionId, kept] of [
        ['scheduled', true],
        ['expired', false],
      ] as const) {
        const { runtime, queries } = fakeRuntime()
        runtime.setBackgroundListener(recordingListener())
        const turn = runtime.runTurn({ ...context, claudeSessionId }, handlers([]))
        const query = await waitFor(() => queries[0], 'session')
        query.push(init, assistant('reply', [text('Hello.')]), {
          type: 'result',
          subtype: 'success',
          result: 'Hello.',
        })
        await turn
        await sleep(80)
        assert.equal(query.closed, !kept, claudeSessionId)
        await runtime.stop()
      }
    })
  } finally {
    for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CLAUDE_ROUTER_DIR']) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test('native forked session leaves its parent the cron jobs scheduled before the fork', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-codex-cron-'))
  const projects = join(home, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9-]/g, '-'))
  mkdirSync(projects, { recursive: true })
  const scheduledAt = Date.now() - 60 * 60 * 1000
  writeFileSync(
    join(projects, 'parent.jsonl'),
    createCron('cron-use', 'job-1')
      .slice(0, 2)
      .map((message, index) =>
        JSON.stringify({
          ...message,
          uuid: `line-${index}`,
          timestamp: new Date(scheduledAt).toISOString(),
          toolUseResult: message.tool_use_result,
        }),
      )
      .join('\n'),
  )
  const saved = { ...process.env }
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIRS
  delete process.env.CLAUDE_ROUTER_DIR
  try {
    await withSettleMs(40, async () => {
      for (const [label, forkedAt, kept] of [
        ['forked after the job', scheduledAt + 60_000, false],
        ['forked before the job', scheduledAt - 60_000, true],
      ] as const) {
        const { runtime, queries } = fakeRuntime()
        const sdk = Reflect.get(runtime, 'sdk') as { query: (args: unknown) => FakeQuery }
        const options: Record<string, unknown>[] = []
        Reflect.set(runtime, 'sdk', {
          query: (args: { options: Record<string, unknown> }) => {
            options.push(args.options)
            return sdk.query(args)
          },
        })
        runtime.setBackgroundListener(recordingListener())
        const turn = runtime.runTurn(
          { ...context, claudeSessionId: 'parent', forkSession: true, forkedAt },
          handlers([]),
        )
        const query = await waitFor(() => queries[0], 'session')
        assert.equal(
          (options[0]?.env as NodeJS.ProcessEnv | undefined)?.CLAUDE_CODE_RESUME_SOURCE_ALIVE,
          new Date(forkedAt).toISOString(),
          label,
        )
        query.push(init, assistant('reply', [text('Hello.')]), {
          type: 'result',
          subtype: 'success',
          result: 'Hello.',
        })
        await turn
        await sleep(80)
        assert.equal(query.closed, !kept, label)
        await runtime.stop()
      }
    })
  } finally {
    for (const name of ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CLAUDE_ROUTER_DIR']) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test('native turn the session no longer holds as current ends when the session does', async () => {
  const { runtime, queries } = fakeRuntime()
  const listener = recordingListener()
  runtime.setBackgroundListener(listener)

  const events: RuntimeEvent[] = []
  let ended = false
  const settled = () => {
    ended = true
  }
  const turn = runtime.runTurn(context, handlers(events)).then(settled, settled)
  const query = await waitFor(() => queries[0], 'session')
  query.push(init, assistant('m1', [text('Working on it.')]))
  await waitFor(() => textDeltas(events).length > 0, 'the turn to produce output')

  // The session stops holding the turn as its current one, without ending it:
  // what the CLI sends next reaches no turn. Whatever takes it off (an
  // abandoned CLI turn, a session taking over), the turn is still the
  // server's, and still unfinished.
  const sessions = Reflect.get(runtime, 'sessions') as Map<string, { current: unknown }>
  const session = sessions.get('thread')
  assert.ok(session, 'the session must still be registered')
  assert.ok(session.current, 'the session must still hold the turn')
  session.current = null

  // The CLI session goes away, so nothing else can end the turn.
  query.close()
  await waitFor(() => ended, 'the turn to end with its session')
  const terminal = events.filter((event) => event.type === 'completed' || event.type === 'error')
  assert.deepEqual(
    terminal.map((event) => event.type),
    ['completed'],
  )
  await waitFor(() => listener.released.length === 1, 'session release')
  await turn
  await runtime.stop()
})

function withCommandOutputPollMs<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS
  process.env.CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS = String(ms)
  return run().finally(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS
    else process.env.CLAUDE_CODEX_COMMAND_OUTPUT_POLL_MS = previous
  })
}

function bash(id: string, command: string, background = false) {
  return {
    type: 'tool_use',
    id,
    name: 'Bash',
    input: { command, ...(background ? { run_in_background: true } : {}) },
  }
}

// The CLI made the Bash call `toolUseId` a task: at once in the background,
// after about two seconds in the foreground.
function bashTask(taskId: string, toolUseId: string, backgrounded: boolean) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    task_type: 'local_bash',
    description: 'command',
    is_backgrounded: backgrounded,
  }
}

function toolResult(toolUseId: string, content: string, parent: string | null = null) {
  return {
    type: 'user',
    parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  }
}

function outputDeltas(events: RuntimeEvent[], toolUseId: string): string[] {
  return events.flatMap((event) =>
    event.type === 'tool_output_delta' && event.toolUseId === toolUseId ? [event.delta] : [],
  )
}

test('native streams the output of each running Bash command to its own call', async () => {
  await withCommandOutputPollMs(5, async () => {
    const { runtime, queries } = fakeRuntime((prompt) => new ShellQuery(prompt))
    const events: RuntimeEvent[] = []
    const turn = runtime.runTurn(context, handlers(events))
    const query = await waitFor(() => queries[0], 'session')
    query.outputs.set('t1', 'compiling\n')
    query.outputs.set('t2', 'testing\n')
    query.outputs.set('t3', 'inner\n')
    query.push(
      assistant('m1', [
        { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'look' } },
        bash('bash-a', 'make'),
        bash('bash-b', 'npm test'),
      ]),
      {
        type: 'assistant',
        parent_tool_use_id: 'agent-1',
        message: { id: 'sub-1', content: [bash('bash-inner', 'ls')] },
      },
      bashTask('t1', 'bash-a', false),
      bashTask('t2', 'bash-b', false),
      bashTask('t3', 'bash-inner', false),
    )
    await waitFor(
      () => outputDeltas(events, 'bash-a').length === 1 && outputDeltas(events, 'bash-b').length,
      'first output',
    )
    query.outputs.set('t1', 'compiling\nlinking\n')
    await waitFor(() => outputDeltas(events, 'bash-a').length === 2, 'more output')
    query.push(
      toolResult('bash-a', 'compiling\nlinking\n'),
      toolResult('bash-b', 'testing\n'),
      toolResult('bash-inner', 'inner\n', 'agent-1'),
      toolResult('agent-1', 'report'),
      assistant('m2', [text('done')]),
      { type: 'result', subtype: 'success', result: 'done' },
    )
    await turn

    assert.deepEqual(outputDeltas(events, 'bash-a'), ['compiling\n', 'linking\n'])
    assert.deepEqual(outputDeltas(events, 'bash-b'), ['testing\n'])
    // A subagent's own commands stay inside it.
    assert.deepEqual(outputDeltas(events, 'bash-inner'), [])
    const order = events.flatMap((event) =>
      event.type === 'tool_output_delta' || event.type === 'tool_result'
        ? [`${event.type}:${event.toolUseId}`]
        : [],
    )
    assert.ok(
      order.lastIndexOf('tool_output_delta:bash-a') < order.indexOf('tool_result:bash-a'),
      'output streams before the result',
    )
    await runtime.stop()
  })
})

test('native without get_task_output shows Bash output only with the result', async () => {
  await withCommandOutputPollMs(5, async () => {
    const { runtime, queries } = fakeRuntime()
    const events: RuntimeEvent[] = []
    const turn = runtime.runTurn(context, handlers(events))
    const query = await waitFor(() => queries[0], 'session')
    query.push(assistant('m1', [bash('bash-a', 'make')]), bashTask('t1', 'bash-a', false))
    await sleep(30)
    query.push(toolResult('bash-a', 'built\n'), assistant('m2', [text('done')]), {
      type: 'result',
      subtype: 'success',
      result: 'done',
    })
    await turn
    assert.deepEqual(
      events.filter((event) => event.type === 'tool_output_delta'),
      [],
    )
    await runtime.stop()
  })
})

test('native background shell reports its output to the thread after its call returned, and how it ended', async () => {
  await withCommandOutputPollMs(5, async () => {
    const { runtime, queries } = fakeRuntime((prompt) => new ShellQuery(prompt))
    const listener = recordingListener()
    runtime.setBackgroundListener(listener)
    const events: RuntimeEvent[] = []
    const turn = runtime.runTurn(context, handlers(events))
    const query = await waitFor(() => queries[0], 'session')
    query.outputs.set('b1', '')
    query.push(
      assistant('m1', [bash('bash-bg', 'npm run dev', true)]),
      bashTask('b1', 'bash-bg', true),
      toolResult('bash-bg', 'Command running in background with ID: b1'),
      assistant('m2', [text('started')]),
      { type: 'result', subtype: 'success', result: 'started' },
    )
    await turn
    assert.equal(runtime.hasBackgroundWork(), true)

    const shellOutput = () =>
      listener.tasks.flatMap((event) => (event.type === 'task_output' ? [event] : []))
    query.outputs.set('b1', 'ready on :3000\n')
    await waitFor(() => shellOutput().length === 1, 'shell output')
    assert.deepEqual(shellOutput(), [
      { type: 'task_output', taskId: 'b1', toolUseId: 'bash-bg', delta: '\nready on :3000\n' },
    ])

    const limit =
      'Background command "npm run dev" was stopped after reaching its background time limit'
    query.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b1',
      status: 'stopped',
      summary: limit,
    })
    await waitFor(() => shellOutput().length === 2, 'end note')
    assert.equal(shellOutput()[1]?.delta, `[${limit}]\n`)
    // None of it went to the turn, which had ended.
    assert.deepEqual(outputDeltas(events, 'bash-bg'), [])
    await runtime.stop()
  })
})
