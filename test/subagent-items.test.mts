import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import { MAX_SUBAGENT_ITEMS } from '../src/subagent-items.mjs'
import type {
  ClaudeRuntime,
  RpcPeer,
  RuntimeBackgroundListener,
  RuntimeHandlers,
  RuntimeTurnContext,
  SubagentOutput,
  SubagentOutputEvent,
} from '../src/types.mjs'

// A subagent's own work (what it says and thinks, its tool calls and their
// results) shows in its child thread as items of the child's turn.

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

interface Client {
  messages: any[]
  request(method: string, params: Record<string, unknown>): Promise<any>
}

interface Harness {
  // The client that starts threads and turns.
  app: Client
  messages: any[]
  // Another client on the same server (a second window, another app).
  connect(id: string): Client
  request(method: string, params: Record<string, unknown>): Promise<any>
  startThread(): Promise<string>
  startTurn(threadId: string, text: string): Promise<void>
  // Starts a turn and resolves with the messages up to its turn/completed.
  runTurn(threadId: string, text: string): Promise<any[]>
  waitFor(
    predicate: (message: any) => boolean,
    label: string,
    from?: number,
    messages?: any[],
  ): Promise<any>
  listener(): RuntimeBackgroundListener
  // The adapter stops and starts again on the same state.
  restart(): Promise<void>
}

interface ServerOptions {
  // CLAUDE_CODEX_SUBAGENT_ITEMS for the run; unset when absent.
  items?: string
  // A runtime of its own instead of the script's.
  runtime?: ClaudeRuntime
  // CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS for the run; unset when absent.
  watchdogMs?: string
  // CLAUDE_CODEX_MCP_SERVERS for the run; unset when absent.
  mcpServers?: string
}

async function withServer(
  script: Script,
  body: (harness: Harness) => Promise<void>,
  options: ServerOptions = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-subagent-items-'))
  const saved = {
    CLAUDE_CODEX_HOME: process.env.CLAUDE_CODEX_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CODEX_SUBAGENT_ITEMS: process.env.CLAUDE_CODEX_SUBAGENT_ITEMS,
    CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS: process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS,
    CLAUDE_CODEX_MCP_SERVERS: process.env.CLAUDE_CODEX_MCP_SERVERS,
  }
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  setEnv({
    CLAUDE_CODEX_HOME: directory,
    CODEX_HOME: join(directory, 'codex-home'),
    CLAUDE_CODEX_SUBAGENT_ITEMS: options.items,
    CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS: options.watchdogMs,
    CLAUDE_CODEX_MCP_SERVERS: options.mcpServers,
  })
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
  const runtime: ClaudeRuntime = options.runtime ?? {
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
  let server = new CodexClaudeAppServer(new SessionStore(join(directory, 'state.sqlite')), runtime)
  let nextId = 0
  const connect = (id: string): Client => {
    const messages: any[] = []
    const responses = new Map<unknown, any>()
    const peer: RpcPeer = {
      id,
      close: () => {},
      // As over the wire: a copy, which later changes to the item miss.
      send: (message) => {
        const copy = JSON.parse(JSON.stringify(message))
        if ('id' in copy && !('method' in copy)) responses.set(copy.id, copy)
        else messages.push(copy)
      },
    }
    return {
      messages,
      request: async (method, params) => {
        const requestId = ++nextId
        await server.handle(peer, { id: requestId, method, params })
        const response = responses.get(requestId)
        assert.ok(response, `Missing ${method} response`)
        assert.equal(response.error, undefined, `${method} failed`)
        return response.result
      },
    }
  }
  const app = connect('subagent-items-test')
  const waitFor = async (
    predicate: (message: any) => boolean,
    label: string,
    from = 0,
    messages = app.messages,
  ) => {
    // Generous: a busy agent's few hundred items are as many store writes.
    const deadline = Date.now() + 30_000
    for (;;) {
      const found = messages.slice(from).find(predicate)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const startTurn = async (threadId: string, text: string) => {
    await app.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  }
  const harness: Harness = {
    app,
    messages: app.messages,
    connect,
    request: app.request,
    startThread: async () =>
      (await app.request('thread/start', { cwd: directory, persistExtendedHistory: false })).thread
        .id,
    startTurn,
    runTurn: async (threadId, text) => {
      const from = app.messages.length
      await startTurn(threadId, text)
      await waitFor(
        (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
        `${text} to complete`,
        from,
      )
      return app.messages.slice(from)
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
    setEnv(saved)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

const out = (toolUseId: string, output: SubagentOutput, agentId?: string): SubagentOutputEvent => ({
  type: 'subagent_output',
  toolUseId,
  ...(agentId ? { agentId } : {}),
  output,
})

// The main loop calls Agent and the CLI reports the task it runs as.
async function startAgent(
  context: RuntimeTurnContext,
  handlers: RuntimeHandlers,
  tools: ScriptTools,
  toolUseId: string,
  taskId: string,
  prompt: string,
  extra: { agentId?: string; background?: boolean } = {},
): Promise<void> {
  await handlers.onEvent({
    type: 'tool_use',
    toolUseId,
    toolName: 'Agent',
    input: {
      description: prompt,
      prompt,
      ...(extra.background ? { run_in_background: true } : {}),
    },
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
  })
  await tools.listener().onTaskEvent(context.threadId, {
    type: 'task_started',
    taskId,
    toolUseId,
    taskType: 'local_agent',
    description: prompt,
    subagentType: null,
    prompt,
    backgrounded: extra.background === true,
  })
}

const spawnedChild = (messages: any[], prompt: string): string => {
  const spawn = messages.find(
    (message) =>
      message.method === 'item/completed' &&
      message.params.item.type === 'collabAgentToolCall' &&
      message.params.item.tool === 'spawnAgent' &&
      message.params.item.prompt === prompt,
  )
  assert.ok(spawn, `spawnAgent for ${prompt}`)
  return String(spawn.params.item.receiverThreadIds[0])
}

const turnCompleted = (messages: any[], threadId: string) =>
  messages.find(
    (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
  )

// What an item shows, without its ids and timings.
function shape(item: any): unknown[] {
  switch (item.type) {
    case 'userMessage':
      return ['user', item.content[0]?.text]
    case 'agentMessage':
      return ['message', item.phase, item.text]
    case 'reasoning':
      return ['reasoning', [...item.summary, ...item.content].join('')]
    case 'commandExecution':
      return ['command', item.command, item.status, item.aggregatedOutput, item.exitCode]
    case 'fileChange':
      return ['fileChange', item.status, item.changes.map((change: any) => change.path)]
    case 'mcpToolCall':
      return [
        'mcp',
        `${item.server}/${item.tool}`,
        item.status,
        item.result?.content ?? null,
        item.error?.message ?? null,
      ]
    case 'webSearch':
      return ['webSearch', item.query]
    default:
      return [item.type]
  }
}

// The items one thread's notifications completed, in order.
const completedIn = (messages: any[], threadId: string): any[] =>
  messages
    .filter(
      (message) => message.method === 'item/completed' && message.params.threadId === threadId,
    )
    .map((message) => message.params.item)

// Items a thread's notifications started and never completed.
function leftOpen(messages: any[], threadId: string): string[] {
  const open = new Set<string>()
  for (const message of messages) {
    if (message.params?.threadId !== threadId) continue
    if (message.method === 'item/started') open.add(message.params.item.id)
    if (message.method === 'item/completed') open.delete(message.params.item.id)
  }
  return [...open]
}

const threadItems = async (request: Harness['request'], threadId: string): Promise<any[]> =>
  (await request('thread/read', { threadId, includeTurns: true })).thread.turns.flatMap(
    (turn: any) => turn.items,
  )

// What a subagent that surveys the repo does: it thinks, says what it will do,
// reads, runs the tests, edits, searches with an MCP tool, keeps a todo list
// and answers.
const ANSWER = 'The repo is small.'
const SURVEY: SubagentOutput[] = [
  { type: 'reasoning', text: 'Start with the README.' },
  { type: 'text', text: 'Reading the README.' },
  { type: 'tool_use', toolUseId: 'read-1', toolName: 'Read', input: { file_path: 'README.md' } },
  { type: 'tool_result', toolUseId: 'read-1', content: '# Repo', isError: false },
  { type: 'tool_use', toolUseId: 'test-1', toolName: 'Bash', input: { command: 'npm test' } },
  { type: 'tool_result', toolUseId: 'test-1', content: '1 failing', isError: true },
  {
    type: 'tool_use',
    toolUseId: 'edit-1',
    toolName: 'Edit',
    input: { file_path: 'a.txt', old_string: 'a', new_string: 'b' },
  },
  { type: 'tool_result', toolUseId: 'edit-1', content: 'Updated a.txt.', isError: false },
  {
    type: 'tool_use',
    toolUseId: 'mcp-1',
    toolName: 'mcp__github__search',
    input: { q: 'parser' },
  },
  {
    type: 'tool_result',
    toolUseId: 'mcp-1',
    content: [{ type: 'text', text: 'found 2' }],
    isError: false,
  },
  {
    type: 'tool_use',
    toolUseId: 'todo-1',
    toolName: 'TodoWrite',
    input: {
      todos: [{ content: 'Read the README', status: 'completed', activeForm: 'Reading' }],
    },
  },
  { type: 'text', text: ANSWER },
]
const SURVEY_ITEMS = [
  ['reasoning', 'Start with the README.'],
  ['message', 'commentary', 'Reading the README.'],
  ['command', 'Read README.md', 'completed', '# Repo', 0],
  ['command', 'npm test', 'failed', '1 failing', 1],
  ['fileChange', 'completed', ['a.txt']],
  ['mcp', 'github/search', 'completed', [{ type: 'text', text: 'found 2' }], null],
  ['message', null, ANSWER],
]

const surveying: Script = async (context, handlers, tools) => {
  await startAgent(context, handlers, tools, 'agent-1', 'task-1', 'survey the repo')
  for (const output of SURVEY) await handlers.onEvent(out('agent-1', output, 'task-1'))
  await handlers.onEvent({
    type: 'tool_result',
    toolUseId: 'agent-1',
    content: `${ANSWER}\nagentId: a1b2c3d4\n<usage>subagent_tokens: 5\ntool_uses: 4\nduration_ms: 9</usage>`,
  })
  await handlers.onEvent({ type: 'text_delta', delta: 'The agent found a small repo.' })
  await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
}

test("a subagent's work shows in its child turn, read back the same, after a restart too", async () => {
  await withServer(surveying, async ({ startThread, runTurn, restart, connect }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'survey the repo with an agent')
    const child = spawnedChild(live, 'survey the repo')
    const childTurnId = turnCompleted(live, child).params.turn.id

    assert.deepEqual(
      completedIn(live, child)
        .filter((item) => item.type !== 'userMessage')
        .map(shape),
      SURVEY_ITEMS,
      'each piece of work shows as the item the parent would show for it',
    )
    assert.deepEqual(leftOpen(live, child), [], 'every item the child started completed')
    assert.equal(turnCompleted(live, child).params.turn.status, 'completed')
    // The answer is the message it streamed, not a copy of it.
    assert.equal(
      completedIn(live, child).filter(
        (item) => item.type === 'agentMessage' && item.text === ANSWER,
      ).length,
      1,
    )
    const plans = live.filter(
      (message) => message.method === 'turn/plan/updated' && message.params.threadId === child,
    )
    assert.deepEqual(
      plans.map((message) => [message.params.turnId, message.params.plan]),
      [[childTurnId, [{ step: 'Read the README', status: 'completed' }]]],
      'its todo list is its own plan',
    )
    assert.ok(
      live.some(
        (message) =>
          message.method === 'item/commandExecution/outputDelta' &&
          message.params.threadId === child &&
          message.params.delta === '1 failing',
      ),
    )
    // Nothing of it reaches the parent.
    const parentItems = completedIn(live, threadId)
    assert.deepEqual(
      parentItems.filter((item) =>
        ['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type),
      ),
      [],
    )
    assert.equal(
      live.some(
        (message) => message.method === 'turn/plan/updated' && message.params.threadId === threadId,
      ),
      false,
    )

    const expected = [['user', 'survey the repo'], ...SURVEY_ITEMS]
    const history = async (client: Client) => ({
      read: (await threadItems(client.request, child)).map(shape),
      turns: (
        await client.request('thread/turns/list', { threadId: child, itemsView: 'full' })
      ).data.flatMap((turn: any) => turn.items.map(shape)),
      items: (await client.request('thread/items/list', { threadId: child })).data.map(
        (entry: any) => shape(entry.item),
      ),
      resumed: (await client.request('thread/resume', { threadId: child })).thread.turns
        .flatMap((turn: any) => turn.items)
        .map(shape),
    })
    const all = { read: expected, turns: expected, items: expected, resumed: expected }
    assert.deepEqual(await history(connect('reader')), all)
    await restart()
    assert.deepEqual(await history(connect('reopened')), all, 'stored once, kept as it was')
  })
})

// The parent's items with the ids, names and timings that differ from run to
// run left out.
function parentView(items: any[]): unknown {
  const ids = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g
  return JSON.parse(
    JSON.stringify(items, (key, value) => (/At(Ms)?$|^durationMs$/.test(key) ? undefined : value))
      .replace(ids, '<id>')
      .replace(/agent-[0-9a-f]{12}/g, '<nickname>'),
  )
}

test('CLAUDE_CODEX_SUBAGENT_ITEMS=0 leaves the child its prompt and answer; the parent is the same either way', async () => {
  const run = async (items: string | undefined) => {
    let result: { child: unknown[]; parent: unknown; live: unknown } | undefined
    await withServer(
      surveying,
      async ({ startThread, runTurn, request }) => {
        const threadId = await startThread()
        const live = await runTurn(threadId, 'survey the repo with an agent')
        const child = spawnedChild(live, 'survey the repo')
        result = {
          child: (await threadItems(request, child)).map(shape),
          parent: parentView(await threadItems(request, threadId)),
          live: parentView(
            live
              .filter((message) => message.params?.threadId === threadId)
              .map((message) => [message.method, message.params.item ?? null]),
          ),
        }
      },
      items === undefined ? {} : { items },
    )
    assert.ok(result)
    return result
  }
  const on = await run(undefined)
  const off = await run('0')
  assert.deepEqual(on.child, [['user', 'survey the repo'], ...SURVEY_ITEMS])
  assert.deepEqual(
    off.child,
    [
      ['user', 'survey the repo'],
      ['message', null, ANSWER],
    ],
    'without them, the child is as it was',
  )
  assert.deepEqual(on.parent, off.parent, 'the parent thread is the same')
  assert.deepEqual(on.live, off.live, 'and so is what the parent streams')
})

test("a nested agent's work goes to its own thread, by the task id the CLI names", async () => {
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-outer', 'task-outer', 'outer work')
    await handlers.onEvent(
      out('agent-outer', { type: 'text', text: 'I will ask a helper.' }, 'task-outer'),
    )
    // The outer agent launches one of its own.
    await startAgent(context, handlers, tools, 'agent-inner', 'task-inner', 'inner work', {
      agentId: 'task-outer',
    })
    // A CLI forwards the nested agent's frames under its host's call, naming
    // the nested agent, or under the nested agent's own call.
    const bash = { type: 'tool_use', toolUseId: 'inner-bash', toolName: 'Bash' } as const
    await handlers.onEvent(
      out('agent-outer', { ...bash, input: { command: 'ls src' } }, 'task-inner'),
    )
    await handlers.onEvent(
      out(
        'agent-inner',
        { type: 'tool_result', toolUseId: 'inner-bash', content: 'a.ts', isError: false },
        'task-inner',
      ),
    )
    // A frame naming an agent nobody knows, under a call whose agent is
    // known, is not that agent's.
    await handlers.onEvent(out('agent-outer', { type: 'text', text: 'Not mine.' }, 'task-unknown'))
    // An older CLI names no agent: the call says whose it is.
    await handlers.onEvent(out('agent-outer', { type: 'reasoning', text: 'The helper is done.' }))
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-inner', content: 'inner done' })
    await handlers.onEvent(out('agent-outer', { type: 'text', text: 'outer done' }, 'task-outer'))
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-outer', content: 'outer done' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withServer(script, async ({ startThread, runTurn, request }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'nest two agents')
    const outer = spawnedChild(live, 'outer work')
    const inner = spawnedChild(live, 'inner work')
    const read = await request('thread/read', { threadId: inner, includeTurns: true })
    assert.equal(read.thread.parentThreadId, outer, 'the nested agent hangs off its host')

    const work = async (id: string) =>
      (await threadItems(request, id))
        .filter((item) => item.type !== 'collabAgentToolCall' && item.type !== 'subAgentActivity')
        .map(shape)
    assert.deepEqual(await work(outer), [
      ['user', 'outer work'],
      ['message', 'commentary', 'I will ask a helper.'],
      ['reasoning', 'The helper is done.'],
      ['message', null, 'outer done'],
    ])
    assert.deepEqual(await work(inner), [
      ['user', 'inner work'],
      ['command', 'ls src', 'completed', 'a.ts', 0],
      ['message', null, 'inner done'],
    ])
    assert.equal(
      live.some((message) => JSON.stringify(message).includes('Not mine.')),
      false,
      'an unknown agent shows nowhere',
    )
    assert.deepEqual(
      completedIn(live, threadId).filter(
        (item) => !['collabAgentToolCall', 'subAgentActivity', 'userMessage'].includes(item.type),
      ),
      [],
      'none of it in the parent',
    )
    for (const id of [outer, inner]) assert.deepEqual(leftOpen(live, id), [])
  })
})

test('a subagent stopped mid-call closes the call as failed; what it sends later shows nowhere', async () => {
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-slow', 'slow-task', 'run the suite')
    const stopped = tools.stopped('slow-task')
    await handlers.onEvent(out('agent-slow', { type: 'text', text: 'Running the suite.' }))
    await handlers.onEvent(
      out('agent-slow', {
        type: 'tool_use',
        toolUseId: 'suite',
        toolName: 'Bash',
        input: { command: 'npm test' },
      }),
    )
    await handlers.onEvent(
      out('agent-slow', {
        type: 'tool_use',
        toolUseId: 'lookup',
        toolName: 'mcp__docs__fetch',
        input: { page: 'x' },
      }),
    )
    await stopped
    // The CLI ends the agent's call once the stop went through.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await handlers.onEvent(
      out('agent-slow', { type: 'tool_result', toolUseId: 'suite', content: 'ok', isError: false }),
    )
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-slow',
      content: '[Request interrupted by user for tool use]',
      isError: true,
    })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withServer(script, async ({ startThread, startTurn, waitFor, request, messages }) => {
    const threadId = await startThread()
    await startTurn(threadId, 'stop an agent mid-call')
    const running = await waitFor(
      (message) => message.method === 'item/started' && message.params.item.type === 'mcpToolCall',
      'the subagent call',
    )
    const child = running.params.threadId
    assert.notEqual(child, threadId)
    await request('turn/interrupt', { threadId: child, turnId: running.params.turnId })
    await waitFor(
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
      'the parent turn',
    )
    const expected = [
      ['user', 'run the suite'],
      ['message', 'commentary', 'Running the suite.'],
      ['command', 'npm test', 'failed', null, null],
      ['mcp', 'docs/fetch', 'failed', null, 'Stopped by the user.'],
      ['message', null, 'Stopped by the user.'],
    ]
    assert.deepEqual(completedIn(messages, child).map(shape), expected)
    assert.deepEqual(leftOpen(messages, child), [])
    assert.deepEqual((await threadItems(request, child)).map(shape), expected)
    assert.equal(turnCompleted(messages, child).params.turn.status, 'interrupted')
  })
})

test("interrupting the parent closes its running subagent's open calls", async () => {
  const script: Script = async (context, handlers, tools) => {
    const interrupted = tools.interrupted()
    await startAgent(context, handlers, tools, 'agent-busy', 'busy-task', 'work hard')
    await handlers.onEvent(
      out('agent-busy', {
        type: 'tool_use',
        toolUseId: 'write',
        toolName: 'Write',
        input: { file_path: 'out.txt', content: 'x' },
      }),
    )
    await interrupted
  }
  await withServer(script, async ({ startThread, startTurn, waitFor, request, messages }) => {
    const threadId = await startThread()
    await startTurn(threadId, 'interrupt the parent')
    const writing = await waitFor(
      (message) => message.method === 'item/started' && message.params.item.type === 'fileChange',
      'the subagent write',
    )
    await request('turn/interrupt', { threadId })
    await waitFor(
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
      'the parent turn',
    )
    const child = writing.params.threadId
    assert.deepEqual(completedIn(messages, child).map(shape), [
      ['user', 'work hard'],
      ['fileChange', 'failed', ['out.txt']],
      ['message', null, 'Interrupted by the user.'],
    ])
    assert.deepEqual(leftOpen(messages, child), [])
    assert.equal(turnCompleted(messages, child).params.turn.status, 'interrupted')
  })
})

test('an adapter that stops mid-call leaves no call of a subagent running', async () => {
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-long', 'long-task', 'take long')
    await handlers.onEvent(
      out('agent-long', {
        type: 'tool_use',
        toolUseId: 'sleep',
        toolName: 'Bash',
        input: { command: 'sleep 600' },
      }),
    )
    await new Promise(() => {})
  }
  await withServer(script, async ({ startThread, startTurn, waitFor, request, restart }) => {
    const threadId = await startThread()
    await startTurn(threadId, 'stop the adapter')
    const sleeping = await waitFor(
      (message) => message.method === 'item/started' && message.params.item.command === 'sleep 600',
      'the subagent command',
    )
    await restart()
    const items = await threadItems(request, sleeping.params.threadId)
    const command = items.find((item) => item.type === 'commandExecution')
    assert.equal(command?.status, 'failed')
    assert.equal(
      items.some((item) => item.status === 'inProgress'),
      false,
    )
  })
})

test("a background subagent's work between turns shows in its thread until it ends", async () => {
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-bg', 'bg-task', 'survey', {
      background: true,
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-bg',
      content: 'Async agent launched successfully.\nagentId: bg-task',
      structured: { isAsync: true, status: 'async_launched', agentId: 'bg-task', prompt: 'survey' },
    })
    await handlers.onEvent({ type: 'completed', success: true, result: 'launched' })
  }
  await withServer(
    script,
    async ({ startThread, runTurn, listener, waitFor, request, messages }) => {
      const threadId = await startThread()
      const child = spawnedChild(await runTurn(threadId, 'launch in the background'), 'survey')
      const from = messages.length
      const send = (output: SubagentOutput, agentId?: string) =>
        listener().onTaskEvent(threadId, out('agent-bg', output, agentId))
      await send({ type: 'text', text: 'Looking around.' }, 'bg-task')
      await send({
        type: 'tool_use',
        toolUseId: 'grep',
        toolName: 'Grep',
        input: { pattern: 'TODO' },
      })
      await send({ type: 'tool_result', toolUseId: 'grep', content: 'a.ts:1', isError: false })
      await send({
        type: 'tool_use',
        toolUseId: 'fetch',
        toolName: 'WebFetch',
        input: { url: 'u' },
      })
      await listener().onTaskEvent(threadId, {
        type: 'task_notification',
        taskId: 'bg-task',
        toolUseId: 'agent-bg',
        status: 'completed',
        summary: 'Agent "survey" completed',
        result: 'Two TODOs.',
        usage: null,
      })
      await waitFor(
        (message) => message.method === 'turn/completed' && message.params.threadId === child,
        'the background child',
        from,
      )
      // Late output of an agent that ended shows nowhere.
      await send({ type: 'text', text: 'Too late.' }, 'bg-task')
      assert.deepEqual(completedIn(messages.slice(from), child).map(shape), [
        ['message', 'commentary', 'Looking around.'],
        ['command', 'Grep TODO', 'completed', 'a.ts:1', 0],
        ['webSearch', 'u'],
        ['message', null, 'Two TODOs.'],
      ])
      assert.deepEqual(leftOpen(messages, child), [])
      assert.equal(
        (await threadItems(request, child)).some(
          (item) => item.type === 'agentMessage' && item.text === 'Too late.',
        ),
        false,
      )
    },
  )
})

test('a message sent to a running agent goes after what it said so far, and its reply after that', async () => {
  const script: Script = async (context, handlers, tools) => {
    if (context.prompt.includes('ask for more')) {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'send-1',
        toolName: 'SendMessage',
        input: { to: 'bg-task', message: 'Check the docs too.' },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId: 'send-1', content: 'Message sent.' })
    } else {
      await startAgent(context, handlers, tools, 'agent-bg', 'bg-task', 'survey', {
        background: true,
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: 'agent-bg',
        content: 'Async agent launched successfully.\nagentId: bg-task',
        structured: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'bg-task',
          prompt: 'survey',
        },
      })
    }
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withServer(
    script,
    async ({ startThread, runTurn, listener, waitFor, request, messages }) => {
      const threadId = await startThread()
      const child = spawnedChild(await runTurn(threadId, 'launch in the background'), 'survey')
      const send = (text: string) =>
        listener().onTaskEvent(threadId, out('agent-bg', { type: 'text', text }, 'bg-task'))
      await send('Looking around.')
      await runTurn(threadId, 'ask for more')
      await send('The docs are fine.')
      const from = messages.length
      await listener().onTaskEvent(threadId, {
        type: 'task_notification',
        taskId: 'bg-task',
        toolUseId: 'agent-bg',
        status: 'completed',
        summary: 'Agent "survey" completed',
        result: 'The docs are fine.',
        usage: null,
      })
      await waitFor(
        (message) => message.method === 'turn/completed' && message.params.threadId === child,
        'the background child',
        from,
      )
      assert.deepEqual((await threadItems(request, child)).map(shape), [
        ['user', 'survey'],
        ['message', 'commentary', 'Looking around.'],
        ['user', 'Check the docs too.'],
        ['message', null, 'The docs are fine.'],
      ])
      assert.deepEqual(leftOpen(messages, child), [])
    },
  )
})

test("a subagent's MCP calls name the configured server, `__` and all, between turns too", async () => {
  // `my` and `my__server` both run: the longer name wins, as for the parent.
  const servers = JSON.stringify({ my: { command: 'true' }, my__server: { command: 'true' } })
  const call = (toolUseId: string, tool: string, text: string): SubagentOutput[] => [
    { type: 'tool_use', toolUseId, toolName: `mcp__my__server__${tool}`, input: { q: tool } },
    { type: 'tool_result', toolUseId, content: [{ type: 'text', text }], isError: false },
  ]
  const script: Script = async (context, handlers, tools) => {
    if (context.prompt.includes('ask again')) {
      // SendMessage takes over the foreground agent, which then works on in
      // the background.
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'send-1',
        toolName: 'SendMessage',
        input: { to: 'f00dcafe', message: 'Look once more.' },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId: 'send-1', content: 'Message sent.' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'asked' })
      return
    }
    await startAgent(context, handlers, tools, 'agent-fg', 'fg-task', 'look it up')
    for (const output of call('fg-search', 'search', 'hit'))
      await handlers.onEvent(out('agent-fg', output, 'fg-task'))
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-fg',
      content: `Found it.\nagentId: f00dcafe\n<usage>subagent_tokens: 5\ntool_uses: 1\nduration_ms: 9</usage>`,
    })
    await startAgent(context, handlers, tools, 'agent-bg', 'bg-task', 'watch it', {
      background: true,
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-bg',
      content: 'Async agent launched successfully.\nagentId: bg-task',
      structured: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'bg-task',
        prompt: 'watch it',
      },
    })
    await handlers.onEvent({ type: 'completed', success: true, result: 'launched' })
  }
  await withServer(
    script,
    async ({ startThread, runTurn, listener, waitFor, request, messages }) => {
      const threadId = await startThread()
      const live = await runTurn(threadId, 'look it up, then watch it')
      const foreground = spawnedChild(live, 'look it up')
      const background = spawnedChild(live, 'watch it')
      const settle = async (taskId: string, child: string, result: string) => {
        const from = messages.length
        await listener().onTaskEvent(threadId, {
          type: 'task_notification',
          taskId,
          toolUseId: taskId === 'bg-task' ? 'agent-bg' : null,
          status: 'completed',
          summary: 'Agent completed',
          result,
          usage: null,
        })
        await waitFor(
          (message) => message.method === 'turn/completed' && message.params.threadId === child,
          `${taskId} to end`,
          from,
        )
      }
      // Between the parent's turns.
      for (const output of call('bg-fetch', 'fetch', 'page'))
        await listener().onTaskEvent(threadId, out('agent-bg', output, 'bg-task'))
      await settle('bg-task', background, 'Watched.')
      await runTurn(threadId, 'ask again')
      for (const output of call('fg-lookup', 'lookup', 'same'))
        await listener().onTaskEvent(threadId, out('', output, 'f00dcafe'))
      await settle('f00dcafe', foreground, 'Same.')

      const mcp = (tool: string, text: string) => [
        'mcp',
        `my__server/${tool}`,
        'completed',
        [{ type: 'text', text }],
        null,
      ]
      assert.deepEqual((await threadItems(request, background)).map(shape), [
        ['user', 'watch it'],
        mcp('fetch', 'page'),
        ['message', null, 'Watched.'],
      ])
      assert.deepEqual((await threadItems(request, foreground)).map(shape), [
        ['user', 'look it up'],
        mcp('search', 'hit'),
        ['message', null, 'Found it.'],
        ['user', 'Look once more.'],
        mcp('lookup', 'same'),
        ['message', null, 'Same.'],
      ])
    },
    { mcpServers: servers },
  )
})

test('the work of an agent the turn handed off is no sign of life from a stuck one', async () => {
  const steps = 40
  let sent = 0
  let done = false
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-bg', 'bg-task', 'survey', {
      background: true,
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: 'agent-bg',
      content: 'Async agent launched successfully.\nagentId: bg-task',
      structured: { isAsync: true, status: 'async_launched', agentId: 'bg-task', prompt: 'survey' },
    })
    await startAgent(context, handlers, tools, 'agent-stuck', 'stuck-task', 'never returns')
    // The agent the turn handed off works on, faster than the window; the
    // one the turn waits on says nothing.
    while (!done && sent < steps) {
      await handlers.onEvent(out('agent-bg', { type: 'text', text: `Step ${sent}.` }, 'bg-task'))
      sent += 1
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await withServer(
    script,
    async ({ startThread, runTurn, request }) => {
      const threadId = await startThread()
      const messages = await runTurn(threadId, 'survey in the background, then check')
      done = true
      const completed = turnCompleted(messages, threadId)
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /did not publish a terminal result/)
      assert.ok(sent < steps, `the turn fails while the handed-off agent still works (${sent})`)
      // What that agent did still shows in its own thread.
      const child = spawnedChild(messages, 'survey')
      assert.ok(
        (await threadItems(request, child)).some(
          (item) => item.type === 'agentMessage' && item.text.startsWith('Step 0.'),
        ),
      )
    },
    { watchdogMs: '300' },
  )
})

test("every follower of the parent gets the subagent's work live, also one that came in late", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-1', 'task-1', 'survey the repo')
    await gate
    for (const output of SURVEY) await handlers.onEvent(out('agent-1', output, 'task-1'))
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-1', content: ANSWER })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withServer(script, async ({ startThread, startTurn, waitFor, connect, messages }) => {
    const threadId = await startThread()
    const early = connect('early-window')
    await early.request('thread/resume', { threadId })
    await startTurn(threadId, 'survey the repo with an agent')
    const started = await waitFor(
      (message) => message.method === 'turn/started' && message.params.threadId !== threadId,
      'the child turn',
    )
    const child = started.params.threadId
    const late = connect('late-window')
    await late.request('thread/resume', { threadId })
    release()
    for (const client of [{ messages }, early, late])
      await waitFor(
        (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
        'the parent turn',
        0,
        client.messages,
      )
    for (const client of [{ messages }, early, late]) {
      assert.deepEqual(
        completedIn(client.messages, child)
          .filter((item) => item.type !== 'userMessage')
          .map(shape),
        SURVEY_ITEMS,
      )
      assert.deepEqual(leftOpen(client.messages, child), [])
    }
  })
})

test("a subagent's block is written once, and no turn is read whole just for its status", async () => {
  // Many agents may work at once, and every block of theirs is stored.
  const blocks: SubagentOutput[] = [
    { type: 'reasoning', text: 'Look first.' },
    { type: 'text', text: 'Reading.' },
    { type: 'tool_use', toolUseId: 'read-1', toolName: 'Read', input: { file_path: 'a.txt' } },
    { type: 'tool_result', toolUseId: 'read-1', content: 'a', isError: false },
  ]
  const signal = () => {
    let resolve: () => void = () => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  const send = signal()
  const sent = signal()
  const finish = signal()
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-1', 'task-1', 'survey the repo')
    await send.promise
    for (const output of blocks) await handlers.onEvent(out('agent-1', output, 'task-1'))
    sent.resolve()
    await finish.promise
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-1', content: ANSWER })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withServer(script, async ({ startThread, startTurn, waitFor }) => {
    const threadId = await startThread()
    await startTurn(threadId, 'survey the repo with an agent')
    await waitFor(
      (message) => message.method === 'turn/started' && message.params.threadId !== threadId,
      'the child turn',
    )
    const calls = { getTurn: 0, upsertTurn: 0 }
    const { getTurn, upsertTurn } = SessionStore.prototype
    SessionStore.prototype.getTurn = function (this: SessionStore, id: string) {
      calls.getTurn += 1
      return getTurn.call(this, id)
    }
    SessionStore.prototype.upsertTurn = function (this: SessionStore, turn) {
      calls.upsertTurn += 1
      return upsertTurn.call(this, turn)
    }
    try {
      send.resolve()
      await sent.promise
    } finally {
      SessionStore.prototype.getTurn = getTurn
      SessionStore.prototype.upsertTurn = upsertTurn
      finish.resolve()
    }
    // One write per block, and one more for the message the call closes;
    // each write reads the turn it changes, and nothing else does.
    assert.deepEqual(calls, { getTurn: blocks.length + 1, upsertTurn: blocks.length + 1 })
    await waitFor(
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
      'the parent turn',
    )
  })
})

test('a child turn shows a bounded amount of work; its answer still shows', async () => {
  const extra = 5
  const long = 'x'.repeat(45_000)
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-busy', 'busy-task', 'do a lot')
    await handlers.onEvent(out('agent-busy', { type: 'text', text: long }))
    await handlers.onEvent(
      out('agent-busy', {
        type: 'tool_use',
        toolUseId: 'noisy',
        toolName: 'Bash',
        input: { command: 'yes' },
      }),
    )
    await handlers.onEvent(
      out('agent-busy', {
        type: 'tool_result',
        toolUseId: 'noisy',
        content: 'y\n'.repeat(20_000),
        isError: false,
      }),
    )
    for (let index = 0; index < MAX_SUBAGENT_ITEMS + extra; index += 1) {
      const toolUseId = `ls-${index}`
      await handlers.onEvent(
        out('agent-busy', { type: 'tool_use', toolUseId, toolName: 'LS', input: { path: '.' } }),
      )
      await handlers.onEvent(
        out('agent-busy', { type: 'tool_result', toolUseId, content: 'a', isError: false }),
      )
    }
    await handlers.onEvent(out('agent-busy', { type: 'text', text: 'All listed.' }))
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-busy', content: 'All listed.' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withServer(script, async ({ startThread, runTurn, request }) => {
    const threadId = await startThread()
    const live = await runTurn(threadId, 'a busy agent')
    const child = spawnedChild(live, 'do a lot')
    const items = await threadItems(request, child)
    // Its prompt, the work it may show, and its answer.
    assert.equal(items.length, 1 + MAX_SUBAGENT_ITEMS + 1)
    assert.deepEqual(shape(items.at(-1)), ['message', null, 'All listed.'])
    const message = items[1]
    assert.equal(message.type, 'agentMessage')
    assert.ok(message.text.length < 31_000, 'a long message is capped')
    assert.match(message.text, /15000 more characters not shown$/)
    const noisy = items[2]
    assert.equal(noisy.command, 'yes')
    assert.ok(noisy.aggregatedOutput.length <= 20_100, 'command output is cut as the App cuts it')
    assert.deepEqual(leftOpen(live, child), [])
  })
})

test('a capped last message is still the answer, kept whole and not shown twice', async () => {
  const answer = `${'word '.repeat(8_000)}end`
  const script: Script = async (context, handlers, tools) => {
    await startAgent(context, handlers, tools, 'agent-long', 'long-task', 'write a lot')
    await handlers.onEvent(out('agent-long', { type: 'text', text: answer }))
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'agent-long', content: answer })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  }
  await withServer(script, async ({ startThread, runTurn, request }) => {
    const threadId = await startThread()
    const child = spawnedChild(await runTurn(threadId, 'a long answer'), 'write a lot')
    assert.deepEqual((await threadItems(request, child)).map(shape), [
      ['user', 'write a lot'],
      ['message', null, answer],
    ])
  })
})

test('the mock runtime shows its subagent items check, unless they are off', async () => {
  for (const items of [undefined, '0']) {
    await withServer(
      async () => {},
      async ({ startThread, runTurn, connect }) => {
        const threadId = await startThread()
        const follower = connect('follower')
        await follower.request('thread/resume', { threadId })
        const live = await runTurn(threadId, 'subagent items check')
        const child = spawnedChild(live, 'look at the repo')
        const expected =
          items === '0'
            ? [['message', null, 'The repo has a README.']]
            : [
                ['reasoning', 'The README says what the repo is.'],
                ['message', 'commentary', 'I will read the README.'],
                ['command', 'Read README.md', 'completed', '# Mock repo', 0],
                ['command', 'git status --short', 'completed', ' M README.md', 0],
                ['message', null, 'The repo has a README.'],
              ]
        for (const messages of [live, follower.messages])
          assert.deepEqual(
            completedIn(messages, child)
              .filter((item) => item.type !== 'userMessage')
              .map(shape),
            expected,
          )
      },
      { runtime: new MockRuntime(), ...(items === undefined ? {} : { items }) },
    )
  }
})
