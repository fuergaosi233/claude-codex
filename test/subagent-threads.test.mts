import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
