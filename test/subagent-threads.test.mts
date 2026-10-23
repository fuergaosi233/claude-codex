import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type {
  ClaudeRuntime,
  RpcPeer,
  RuntimeBackgroundListener,
  RuntimeHandlers,
  RuntimeTurnContext,
} from '../src/types.mjs'

// What a scripted turn can reach besides its handlers.
interface ScriptTools {
  listener(): RuntimeBackgroundListener
  // Resolves once the server stops the task.
  stopped(taskId: string): Promise<void>
  // Resolves once the server interrupts the thread.
  interrupted(): Promise<void>
}

type Script = (
  context: RuntimeTurnContext,
  handlers: RuntimeHandlers,
  tools: ScriptTools,
) => Promise<void>

interface Harness {
  messages: any[]
  request(method: string, params: Record<string, unknown>): Promise<any>
  startThread(): Promise<string>
  // Starts a turn; resolves once turn/start answered.
  startTurn(threadId: string, text: string): Promise<void>
  // Starts a turn and resolves with the messages up to its turn/completed.
  runTurn(threadId: string, text: string): Promise<any[]>
  // The first message from index `from` on that matches.
  waitFor(predicate: (message: any) => boolean, label: string, from?: number): Promise<any>
  listener(): RuntimeBackgroundListener
  // The adapter stops and starts again on the same state.
  restart(): Promise<void>
}

// An adapter whose runtime plays `script` for each turn, talking to a peer
// that never initialized (so it gets the legacy closeAgent too).
async function withScriptedServer(
  script: Script,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-subagent-threads-'))
  const previousHome = process.env.CLAUDE_CODEX_HOME
  const previousCodexHome = process.env.CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = directory
  process.env.CODEX_HOME = join(directory, 'codex-home')
  const messages: any[] = []
  const responses = new Map<unknown, any>()
  let listener: RuntimeBackgroundListener | undefined
  const stops = new Map<string, () => void>()
  const interrupts: Array<() => void> = []
  const tools: ScriptTools = {
    listener: () => {
      assert.ok(listener, 'the server listens for background tasks')
      return listener
    },
    stopped: (taskId) => new Promise<void>((resolve) => stops.set(taskId, resolve)),
    interrupted: () => new Promise<void>((resolve) => interrupts.push(resolve)),
  }
  const runtime: ClaudeRuntime = {
    setBackgroundListener: (value) => {
      listener = value
    },
    runTurn: (context, handlers) => script(context, handlers, tools),
    steer: async () => true,
    interrupt: async () => {
      for (const resolve of interrupts.splice(0)) resolve()
    },
    stop: async () => {},
    stopTask: async (_threadId, taskId) => {
      const resolve = stops.get(taskId)
      if (!resolve) return false
      stops.delete(taskId)
      resolve()
      return true
    },
  }
  const peer: RpcPeer = {
    id: 'subagent-threads-test',
    close: () => {},
    send: (message) => {
      if ('id' in message && !('method' in message)) responses.set(message.id, message)
      else messages.push(message)
    },
  }
  let server = new CodexClaudeAppServer(new SessionStore(join(directory, 'state.sqlite')), runtime)
  let nextId = 0
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId
    await server.handle(peer, { id, method, params })
    const response = responses.get(id)
    assert.ok(response, `Missing ${method} response`)
    assert.equal(response.error, undefined, `${method} failed`)
    return response.result
  }
  const waitFor = async (predicate: (message: any) => boolean, label: string, from = 0) => {
    const deadline = Date.now() + 5_000
    for (;;) {
      const found = messages.slice(from).find(predicate)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const startTurn = async (threadId: string, text: string) => {
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  }
  const harness: Harness = {
    messages,
    request,
    startThread: async () =>
      (await request('thread/start', { cwd: directory, persistExtendedHistory: false })).thread.id,
    startTurn,
    runTurn: async (threadId, text) => {
      const from = messages.length
      await startTurn(threadId, text)
      await waitFor(
        (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
        `${text} to complete`,
        from,
      )
      return messages.slice(from)
    },
    waitFor,
    listener: tools.listener,
    restart: async () => {
      await server.stop()
      server = new CodexClaudeAppServer(new SessionStore(join(directory, 'state.sqlite')), runtime)
    },
  }
  try {
    await body(harness)
  } finally {
    await server.stop()
    if (previousHome == null) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previousHome
    if (previousCodexHome == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

const childStarts = (messages: any[], parentThreadId: string) =>
  messages.filter(
    (message) =>
      message.method === 'thread/started' &&
      message.params.thread.parentThreadId === parentThreadId,
  )

const turnCompleted = (messages: any[], threadId: string) =>
  messages.find(
    (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
  )

const collabItems = (messages: any[], tool: string) =>
  messages
    .filter(
      (message) =>
        message.method === 'item/completed' &&
        message.params.item.type === 'collabAgentToolCall' &&
        message.params.item.tool === tool,
    )
    .map((message) => message.params.item)

const spawnedChild = (messages: any[], prompt: string): string => {
  const spawn = collabItems(messages, 'spawnAgent').find((item) => item.prompt === prompt)
  assert.ok(spawn, `spawnAgent for ${prompt}`)
  return String(spawn.receiverThreadIds[0])
}

const turnError = (message: string) => ({ message, codexErrorInfo: null, additionalDetails: null })

test('a subagent thread is named when it starts, and keeps the name in history and after a restart', async () => {
  const script: Script = async (_context, handlers) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-described',
      toolName: 'Agent',
      input: {
        description: '  Survey \n the   repo ',
        prompt: 'Look around the repository.',
        subagent_type: 'Explore',
      },
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-described',
      content: 'Surveyed.\nagentId: a1b2c3\n<usage>total_tokens: 5</usage>',
    })
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-undescribed',
      toolName: 'Task',
      input: { prompt: '## Check the tests\nRun them all.', subagent_type: 'general-purpose' },
    })
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-undescribed', content: 'ok' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withScriptedServer(script, async ({ startThread, runTurn, request, restart }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'spawn two agents')
    const started = childStarts(live, threadId).map((message) => message.params.thread)
    assert.deepEqual(
      started.map((thread) => thread.name),
      ['Survey the repo', 'general-purpose: Check the tests'],
      'each child is announced with its name, so the App does not title it',
    )
    const described = spawnedChild(live, 'Look around the repository.')
    const undescribed = spawnedChild(live, '## Check the tests\nRun them all.')
    assert.deepEqual(
      started.map((thread) => thread.id),
      [described, undescribed],
    )

    const names = async () => {
      const read = await Promise.all(
        [described, undescribed].map(
          async (id) => (await request('thread/read', { threadId: id, includeTurns: true })).thread,
        ),
      )
      const listed = await request('thread/list', {
        parentThreadId: threadId,
        sourceKinds: ['subAgentThreadSpawn'],
        limit: 200,
      })
      return {
        read: read.map((thread) => thread.name),
        listed: Object.fromEntries(listed.data.map((thread: any) => [thread.id, thread.name])),
      }
    }
    const expected = {
      read: ['Survey the repo', 'general-purpose: Check the tests'],
      listed: {
        [described]: 'Survey the repo',
        [undescribed]: 'general-purpose: Check the tests',
      },
    }
    assert.deepEqual(await names(), expected)
    await restart()
    assert.deepEqual(await names(), expected, 'the name is stored with the child thread')
  })
})

test('a failed subagent tells why in its turn and in its state on the parent', async () => {
  const stall = [
    'Workflow ended before the agent published an individual result.',
    'Dynamic workflow "review" failed: Error: agent stalled on all 6 attempts',
    '    at Bo (file:///cli.js:1:2)',
    '    at async unknown (file:///cli.js:3:4)',
    'agentId: 0123456789abcdef',
    '<usage>total_tokens: 12</usage>',
  ].join('\n')
  const reason =
    'Workflow ended before the agent published an individual result. Dynamic workflow "review" failed: Error: agent stalled on all 6 attempts'
  const script: Script = async (_context, handlers) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-stalled',
      toolName: 'Agent',
      input: { description: 'Review', prompt: 'review it' },
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-stalled',
      content: stall,
      isError: true,
    })
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-silent',
      toolName: 'Agent',
      input: { description: 'Silent', prompt: 'say nothing' },
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-silent',
      content: '',
      isError: true,
    })
    await handlers.onEvent({ type: 'completed', success: true, result: 'went on' })
  }
  await withScriptedServer(script, async ({ startThread, runTurn, request }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'fail an agent')
    const stalled = spawnedChild(live, 'review it')
    const silent = spawnedChild(live, 'say nothing')

    const childTurn = turnCompleted(live, stalled).params.turn
    assert.equal(childTurn.status, 'failed')
    assert.deepEqual(childTurn.error, turnError(reason))
    assert.deepEqual(
      turnCompleted(live, silent).params.turn.error,
      turnError('The subagent failed without saying why.'),
    )

    const waits = collabItems(live, 'wait')
    assert.deepEqual(
      waits.map((item) => [item.status, item.agentsStates]),
      [
        ['failed', { [stalled]: { status: 'errored', message: reason } }],
        [
          'failed',
          { [silent]: { status: 'errored', message: 'The subagent failed without saying why.' } },
        ],
      ],
    )
    assert.deepEqual(
      collabItems(live, 'closeAgent').map((item) => item.agentsStates),
      [
        { [stalled]: { status: 'errored', message: reason } },
        { [silent]: { status: 'errored', message: 'The subagent failed without saying why.' } },
      ],
    )

    // History keeps the reason, and the child's message keeps the full text.
    const child = (await request('thread/read', { threadId: stalled, includeTurns: true })).thread
    assert.deepEqual(child.turns.at(-1).error, turnError(reason))
    const childText = child.turns
      .at(-1)
      .items.filter((item: any) => item.type === 'agentMessage')
      .map((item: any) => item.text)
      .join('\n')
    assert.match(childText, /at Bo \(file:\/\/\/cli\.js:1:2\)/)

    // A parent that carried on did not fail.
    const parent = turnCompleted(live, threadId).params.turn
    assert.equal(parent.status, 'completed')
    assert.equal(parent.error, null)
  })
})

test('a parent turn that fails after its subagents failed says how many and why the first did', async () => {
  const failure = { terminalReason: 'api_error', category: 'overloaded', status: 529 }
  const script: Script = async (context, handlers) => {
    if (context.prompt.includes('with agents')) {
      for (const [id, text] of [
        ['agent-disk', '<tool_use_error>Disk full</tool_use_error>'],
        ['agent-net', 'Network down'],
      ] as const) {
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId: id,
          toolName: 'Agent',
          input: { description: id, prompt: id },
        })
        await handlers.onEvent({ type: 'tool_result', toolUseId: id, content: text, isError: true })
      }
    }
    await handlers.onEvent({
      type: 'completed',
      success: false,
      result: 'API Error: 529 Overloaded',
      failure,
    })
  }
  await withScriptedServer(script, async ({ startThread, runTurn, request }) => {
    const alone = await startThread()
    const plain = turnCompleted(await runTurn(alone, 'fail alone'), alone).params.turn.error
    assert.equal(plain.message, 'API Error: 529 Overloaded')

    const threadId = await startThread()
    const live = await runTurn(threadId, 'fail with agents')
    const expected = {
      ...plain,
      message: 'API Error: 529 Overloaded. 2 subagents failed; the first: Disk full',
    }
    const parent = turnCompleted(live, threadId).params.turn
    assert.equal(parent.status, 'failed')
    assert.deepEqual(parent.error, expected, 'the Codex error code and details stay')
    const errors = live.filter(
      (message) => message.method === 'error' && message.params.threadId === threadId,
    )
    assert.deepEqual(
      errors.map((message) => [message.params.willRetry, message.params.error]),
      [[false, expected]],
    )
    const read = (await request('thread/read', { threadId, includeTurns: true })).thread
    assert.deepEqual(read.turns.at(-1).error, expected)
  })
})

test('agents a failed parent leaves running end with its reason, and do not count as failed', async () => {
  const script: Script = async (_context, handlers) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-orphan',
      toolName: 'Agent',
      input: { description: 'Orphan', prompt: 'keep going' },
    })
    await handlers.onEvent({
      type: 'completed',
      success: false,
      result: 'Claude   turn\nfailed hard',
    })
  }
  await withScriptedServer(script, async ({ startThread, runTurn }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'orphan an agent')
    const orphan = spawnedChild(live, 'keep going')
    const reason = 'Ended because the parent turn failed: Claude turn failed hard'
    const child = turnCompleted(live, orphan).params.turn
    assert.equal(child.status, 'failed')
    assert.deepEqual(child.error, turnError(reason))
    assert.deepEqual(collabItems(live, 'wait')[0].agentsStates, {
      [orphan]: { status: 'errored', message: reason },
    })
    assert.equal(
      turnCompleted(live, threadId).params.turn.error.message,
      'Claude   turn\nfailed hard',
    )
  })
})

test('workflow agents the runtime closes as their parent fails end with its reason, and do not count as failed', async () => {
  const failure = { terminalReason: 'api_error', category: 'overloaded', status: 529 }
  const broken = 'a0123456789abcdef'
  const running = 'a1123456789abcdef'
  const agent = (agentId: string) => `workflow-agent:wf-task:${agentId}`
  const script: Script = async (_context, handlers) => {
    for (const agentId of [broken, running]) {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: agent(agentId),
        toolName: 'Agent',
        input: { description: agentId, prompt: `step ${agentId}`, subagent_type: 'workflow' },
      })
    }
    // One agent failed on its own.
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: agent(broken),
      content: `{"error":"Disk full"}\nagentId: ${broken}`,
      isError: true,
    })
    // The turn fails, and the runtime closes the agent still running as it
    // ends.
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: agent(running),
      content: `Workflow monitoring stopped before the agent published an individual result.\nagentId: ${running}`,
      isError: true,
      endedWithTurn: true,
    })
    await handlers.onEvent({
      type: 'completed',
      success: false,
      result: 'API Error: 529 Overloaded',
      failure,
    })
  }
  await withScriptedServer(script, async ({ startThread, runTurn }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'run a workflow')
    assert.equal(
      turnCompleted(live, threadId).params.turn.error.message,
      'API Error: 529 Overloaded. A subagent failed: Disk full',
      'only the agent that failed on its own counts',
    )
    const brokenChild = spawnedChild(live, `step ${broken}`)
    const runningChild = spawnedChild(live, `step ${running}`)
    assert.deepEqual(turnCompleted(live, brokenChild).params.turn.error, turnError('Disk full'))
    const reason = 'Ended because the parent turn failed: API Error: 529 Overloaded'
    const ended = turnCompleted(live, runningChild).params.turn
    assert.equal(ended.status, 'failed')
    assert.deepEqual(ended.error, turnError(reason))
    assert.deepEqual(
      collabItems(live, 'wait').map((item) => item.agentsStates),
      [
        { [brokenChild]: { status: 'errored', message: 'Disk full' } },
        { [runningChild]: { status: 'errored', message: reason } },
      ],
    )
  })
})

test('the workflow agents a native turn closes as it ends are marked as ended with it', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const agent = 'workflow-agent:wf-task:a0123456789abcdef'
  const pending = {
    activeSubagents: new Set([agent, 'workflow-task:wf-task']),
    completedWorkflowTasks: new Set<string>(),
    workflowTasks: new Map([
      [
        'wf-task',
        {
          taskId: 'wf-task',
          toolUseId: '',
          workflowName: 'review',
          description: '',
          prompt: '',
          monitor: null,
          aggregateStarted: true,
          terminal: false,
        },
      ],
    ]),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  await Reflect.get(runtime, 'stopWorkflowTasks').call(runtime, pending)
  assert.deepEqual(
    events.map((event) => [event.type, event.toolUseId, event.isError, event.endedWithTurn]),
    [
      ['tool_result', agent, true, true],
      ['tool_result', 'workflow-task:wf-task', true, true],
    ],
  )
})

test('a workflow agent that fails ends its child turn with the reason the workflow gave, and counts as failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-failed-workflow-agent-'))
  const runId = 'wf_failed_agent_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const failed = 'c000000000000001'
  const done = 'c000000000000002'
  const key = (n: number) => `v1:${String(n).repeat(64)}`
  const journal = (...entries: unknown[]) =>
    appendFile(
      join(transcriptDir, 'journal.jsonl'),
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    )
  await mkdir(transcriptDir, { recursive: true })
  for (const agentId of [failed, done]) {
    await writeFile(
      join(transcriptDir, `agent-${agentId}.jsonl`),
      `${JSON.stringify({ message: { role: 'user', content: `step ${agentId}` } })}\n`,
    )
  }
  // The native runtime projects the workflow's journal into the turn.
  const script: Script = async (_context, handlers) => {
    const runtime = new NativeClaudeRuntime()
    const pending = {
      activeSubagents: new Set<string>(),
      completedWorkflowTasks: new Set<string>(),
      workflowToolUseIds: new Set(['wf-launch']),
      workflowTranscriptRoots: [root],
      handlers,
    }
    const handleSystem = Reflect.get(runtime, 'handleSystem')
    try {
      await handleSystem.call(runtime, pending, {
        subtype: 'task_started',
        task_id: 'wf-task',
        tool_use_id: 'wf-launch',
        task_type: 'local_workflow',
        workflow_name: 'review',
      })
      await Reflect.get(runtime, 'handleUser').call(runtime, pending, {
        type: 'user',
        tool_use_result: {
          status: 'async_launched',
          taskId: 'wf-task',
          taskType: 'local_workflow',
          workflowName: 'review',
          runId,
          transcriptDir,
        },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'wf-launch', content: 'Launched.' }],
        },
      })
      await journal(
        { type: 'started', key: key(1), agentId: failed },
        { type: 'started', key: key(2), agentId: done },
      )
      // The workflow reports why the agent failed; the journal only that it
      // did.
      await handleSystem.call(runtime, pending, {
        subtype: 'task_progress',
        task_id: 'wf-task',
        workflow_progress: [
          {
            type: 'workflow_agent',
            index: 1,
            agentId: failed,
            state: 'error',
            error: `stalled \x1b[2m—\x1b[0m no progress\nfor ${'9'.repeat(500)}ms`,
          },
        ],
      })
      await journal(
        { type: 'failed', key: key(1), agentId: failed },
        { type: 'result', key: key(2), agentId: done, result: 'All checks pass' },
      )
      // The workflow itself completes.
      await handleSystem.call(runtime, pending, {
        subtype: 'task_notification',
        task_id: 'wf-task',
        status: 'completed',
        summary: 'Review completed',
      })
    } finally {
      await Reflect.get(runtime, 'stopWorkflowTasks').call(runtime, pending)
    }
    await handlers.onEvent({
      type: 'completed',
      success: false,
      result: 'API Error: 529 Overloaded',
      failure: { terminalReason: 'api_error', category: 'overloaded', status: 529 },
    })
  }
  try {
    await withScriptedServer(script, async ({ startThread, runTurn }) => {
      const threadId = await startThread()
      const live = await runTurn(threadId, 'run a workflow')
      // Cleaned and clipped like any subagent's reason.
      const told = 'stalled — no progress for '
      const reason = `${told}${'9'.repeat(399 - told.length)}…`
      const failedChild = spawnedChild(live, `step ${failed}`)
      const doneChild = spawnedChild(live, `step ${done}`)
      const failedTurn = turnCompleted(live, failedChild).params.turn
      assert.equal(failedTurn.status, 'failed')
      assert.deepEqual(failedTurn.error, turnError(reason))
      const doneTurn = turnCompleted(live, doneChild).params.turn
      assert.equal(doneTurn.status, 'completed')
      assert.equal(doneTurn.error, null)
      assert.deepEqual(
        collabItems(live, 'wait').map((item) => item.agentsStates),
        [
          { [failedChild]: { status: 'errored', message: reason } },
          { [doneChild]: { status: 'completed', message: null } },
        ],
      )
      assert.equal(
        turnCompleted(live, threadId).params.turn.error.message,
        `API Error: 529 Overloaded. A subagent failed: ${Array.from(reason).slice(0, 199).join('')}…`,
      )
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a parent turn the subagent watchdog ends says how many of its subagents failed', async () => {
  const previousTimeout = process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS
  process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '150'
  const script: Script = async (_context, handlers, tools) => {
    const interrupted = tools.interrupted()
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-broken',
      toolName: 'Agent',
      input: { description: 'Broken', prompt: 'break' },
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-broken',
      content: '<tool_use_error>Disk full</tool_use_error>',
      isError: true,
    })
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-stuck',
      toolName: 'Agent',
      input: { description: 'Stuck', prompt: 'hang' },
    })
    // The agent never reports again; the watchdog gives up on the turn.
    await interrupted
  }
  try {
    await withScriptedServer(script, async ({ startThread, runTurn }) => {
      const threadId = await startThread()
      const live = await runTurn(threadId, 'stall an agent')
      const timeout = 'Subagent did not publish a terminal result within 1 second.'
      assert.deepEqual(
        turnCompleted(live, spawnedChild(live, 'hang')).params.turn.error,
        turnError(timeout),
      )
      assert.equal(
        turnCompleted(live, threadId).params.turn.error.message,
        `${timeout} A subagent failed: Disk full`,
      )
    })
  } finally {
    if (previousTimeout == null) delete process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS
    else process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = previousTimeout
  }
})

test('a subagent the user stops says so in its turn and its state, and does not count as failed', async () => {
  const script: Script = async (context, handlers, tools) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-slow',
      toolName: 'Agent',
      input: { description: 'Slow', prompt: 'take your time' },
    })
    const stopped = tools.stopped('slow-task')
    await tools.listener().onTaskEvent(context.threadId, {
      type: 'task_started',
      taskId: 'slow-task',
      toolUseId: 'agent-slow',
      taskType: 'local_agent',
      description: 'Slow',
      subagentType: null,
      prompt: 'take your time',
      backgrounded: false,
    })
    await stopped
    // The CLI returns the stopped agent's call before it confirms the stop,
    // or after.
    if (context.prompt.includes('after')) await new Promise((resolve) => setTimeout(resolve, 20))
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-slow',
      content: '[Request interrupted by user for tool use]',
      isError: true,
    })
    await handlers.onEvent({ type: 'completed', success: false, result: 'Claude turn failed' })
  }
  for (const order of ['before', 'after']) {
    await withScriptedServer(
      script,
      async ({ startThread, startTurn, waitFor, request, messages }) => {
        const threadId = await startThread()
        await startTurn(threadId, `stop an agent, its result ${order} the stop`)
        const childStarted = await waitFor(
          (message) => message.method === 'turn/started' && message.params.threadId !== threadId,
          'the child turn',
        )
        const childThreadId = childStarted.params.threadId
        await waitFor(
          (message) => message.method === 'item/started' && message.params.item?.tool === 'wait',
          'the wait',
        )
        await request('turn/interrupt', {
          threadId: childThreadId,
          turnId: childStarted.params.turn.id,
        })
        await waitFor(
          (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
          'the parent turn',
        )
        const childDone = messages.filter(
          (message) =>
            message.method === 'turn/completed' && message.params.threadId === childThreadId,
        )
        assert.deepEqual(
          childDone.map((message) => [message.params.turn.status, message.params.turn.error]),
          [['interrupted', turnError('Stopped by the user.')]],
          `the child ends once, as interrupted (result ${order} the stop)`,
        )
        const wait = collabItems(messages, 'wait')
        assert.deepEqual(
          wait.map((item) => item.agentsStates),
          [{ [childThreadId]: { status: 'interrupted', message: 'Stopped by the user.' } }],
        )
        const child = (
          await request('thread/read', { threadId: childThreadId, includeTurns: true })
        ).thread
        assert.deepEqual(child.turns.at(-1).error, turnError('Stopped by the user.'))
        assert.equal(
          turnCompleted(messages, threadId).params.turn.error.message,
          'Claude turn failed',
          'an agent the user stopped did not fail',
        )
      },
    )
  }
})

test('interrupting the parent ends its running agents as interrupted, saying so', async () => {
  const script: Script = async (_context, handlers, tools) => {
    const interrupted = tools.interrupted()
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-busy',
      toolName: 'Agent',
      input: { description: 'Busy', prompt: 'work hard' },
    })
    await interrupted
  }
  await withScriptedServer(
    script,
    async ({ startThread, startTurn, waitFor, request, messages }) => {
      const threadId = await startThread()
      await startTurn(threadId, 'interrupt the parent')
      await waitFor(
        (message) => message.method === 'item/started' && message.params.item?.tool === 'wait',
        'the wait',
      )
      await request('turn/interrupt', { threadId })
      await waitFor(
        (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
        'the parent turn',
      )
      const child = spawnedChild(messages, 'work hard')
      const childTurn = turnCompleted(messages, child).params.turn
      assert.equal(childTurn.status, 'interrupted')
      assert.deepEqual(childTurn.error, turnError('Interrupted by the user.'))
      assert.deepEqual(collabItems(messages, 'wait')[0].agentsStates, {
        [child]: { status: 'interrupted', message: 'Interrupted by the user.' },
      })
    },
  )
})

// A turn that launches one background agent (task bg-task) and ends; `then`
// runs in it once the agent is launched.
const backgroundAgent =
  (then: (handlers: RuntimeHandlers) => Promise<void> | void = () => {}): Script =>
  async (context, handlers, tools) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-bg',
      toolName: 'Agent',
      input: { description: 'Background', prompt: 'survey', run_in_background: true },
    })
    await tools.listener().onTaskEvent(context.threadId, {
      type: 'task_started',
      taskId: 'bg-task',
      toolUseId: 'agent-bg',
      taskType: 'local_agent',
      description: 'Background',
      subagentType: null,
      prompt: 'survey',
      backgrounded: true,
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-bg',
      content: 'Async agent launched successfully.\nagentId: bg-task',
      structured: { isAsync: true, status: 'async_launched', agentId: 'bg-task', prompt: 'survey' },
    })
    await then(handlers)
    await handlers.onEvent({ type: 'completed', success: true, result: 'launched' })
  }

for (const { summary, result, reason } of [
  // The CLI puts the error that ended a local agent in the summary; the
  // result is the last thing the agent said.
  {
    summary: 'Agent stalled: no progress for 600s (stream watchdog did not recover)',
    result: 'Reading the config files next.',
    reason: 'Agent stalled: no progress for 600s (stream watchdog did not recover)',
  },
  // A summary that is only the agent's description says nothing.
  {
    summary: 'Background',
    result: 'Error: the tool crashed\n    at run (file:///cli.js:9:9)\nagentId: bg-task',
    reason: 'Error: the tool crashed',
  },
]) {
  test(`a background subagent that fails tells why: ${reason}`, async () => {
    await withScriptedServer(
      backgroundAgent(),
      async ({ startThread, runTurn, waitFor, listener, messages }) => {
        const threadId = await startThread()
        const child = spawnedChild(await runTurn(threadId, 'background agent'), 'survey')
        // The agent fails after the turn that launched it ended.
        const from = messages.length
        await listener().onTaskEvent(threadId, {
          type: 'task_notification',
          taskId: 'bg-task',
          toolUseId: 'agent-bg',
          status: 'failed',
          summary,
          result,
          usage: null,
        })
        const done = await waitFor(
          (message) => message.method === 'turn/completed' && message.params.threadId === child,
          'the background child turn',
          from,
        )
        assert.equal(done.params.turn.status, 'failed')
        assert.deepEqual(done.params.turn.error, turnError(reason))
        const said = messages
          .slice(from)
          .filter(
            (message) =>
              message.method === 'item/completed' &&
              message.params.threadId === child &&
              message.params.item.type === 'agentMessage',
          )
          .map((message) => message.params.item.text)
        assert.deepEqual(said, [result], 'its full text stays its last message')
      },
    )
  })
}

const retry = (attempt: number, toolUseId?: string) => ({
  type: 'retrying' as const,
  attempt,
  maxRetries: 10,
  status: 529,
  category: 'overloaded',
  delayMs: 2_000,
  ...(toolUseId ? { toolUseId } : {}),
})

test("a subagent's API retries show in its own thread while it runs, never in the parent", async () => {
  const script: Script = async (_context, handlers) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'agent-retrying',
      toolName: 'Agent',
      input: { description: 'Retrying', prompt: 'call the API' },
    })
    await handlers.onEvent(retry(1, 'agent-retrying'))
    // An agent the turn does not know shows its retry nowhere.
    await handlers.onEvent(retry(2, 'agent-unknown'))
    // The main loop's own retry shows in the parent, as before.
    await handlers.onEvent(retry(3))
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-retrying', content: 'done' })
    // A late retry of an agent that already finished shows nowhere.
    await handlers.onEvent(retry(4, 'agent-retrying'))
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withScriptedServer(script, async ({ startThread, runTurn, request }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'retry inside an agent')
    const child = spawnedChild(live, 'call the API')
    const childTurnId = live.find(
      (message) => message.method === 'turn/started' && message.params.threadId === child,
    ).params.turn.id
    const parentTurnId = live.find(
      (message) => message.method === 'turn/started' && message.params.threadId === threadId,
    ).params.turn.id
    const errors = live.filter((message) => message.method === 'error')
    assert.deepEqual(
      errors.map((message) => [
        message.params.threadId,
        message.params.turnId,
        message.params.willRetry,
        message.params.error.message,
      ]),
      [
        [child, childTurnId, true, 'Reconnecting... 1/10'],
        [threadId, parentTurnId, true, 'Reconnecting... 3/10'],
      ],
    )
    assert.deepEqual(errors[0].params.error.codexErrorInfo, errors[1].params.error.codexErrorInfo)
    // Like Codex, a retry is not kept: both turns end without an error.
    assert.equal(turnCompleted(live, child).params.turn.error, null)
    assert.equal(turnCompleted(live, threadId).params.turn.error, null)
    const read = (await request('thread/read', { threadId: child, includeTurns: true })).thread
    assert.equal(read.turns.at(-1).error, null)
  })
})

test("a background subagent's API retries show in its own thread", async () => {
  await withScriptedServer(
    backgroundAgent((handlers) => handlers.onEvent(retry(3, 'agent-bg'))),
    async ({ startThread, runTurn }) => {
      const threadId = await startThread()
      const live = await runTurn(threadId, 'background agent')
      const child = spawnedChild(live, 'survey')
      const childTurnId = live.find(
        (message) => message.method === 'turn/started' && message.params.threadId === child,
      ).params.turn.id
      assert.deepEqual(
        live
          .filter((message) => message.method === 'error')
          .map((message) => [
            message.params.threadId,
            message.params.turnId,
            message.params.willRetry,
            message.params.error.message,
          ]),
        [[child, childTurnId, true, 'Reconnecting... 3/10']],
      )
    },
  )
})
