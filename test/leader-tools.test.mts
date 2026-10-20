import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext, WireMessage } from '../src/types.mjs'

// The leader tools end to end: a mock app-server over stdio, with the mock
// runtime calling the tools for each `leader <tool> <json>` line of a prompt.

const adapter = resolve('dist/src/adapter.mjs')

class AppServer {
  readonly home: string
  readonly notifications: Array<{ method: string; params: any }> = []
  // Requests the server sent, such as approvals, until answered.
  readonly serverRequests: Array<{ id: number; method: string; params: any }> = []
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >()
  private nextId = 1
  private buffer = ''

  constructor(home: string, env: Record<string, string> = {}) {
    this.home = home
    const inherited = { ...process.env }
    delete inherited.CLAUDE_CODEX_HOME
    delete inherited.CLAUDE_CODEX_LEADER_TOOLS
    delete inherited.CLAUDE_CODEX_LEADER_MAX_RUNNING
    this.proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...inherited,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        NODE_NO_WARNINGS: '1',
        ...env,
      },
    })
    this.proc.stderr.resume()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.read(chunk))
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  answer(id: number, result: unknown): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  mark(): number {
    return this.notifications.length
  }

  notified(method: string, from: number): any[] {
    return this.notifications
      .slice(from)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params)
  }

  async waitFor(method: string, match: (params: any) => boolean, from: number): Promise<any> {
    for (let waited = 0; waited < 10_000; waited += 20) {
      const found = this.notified(method, from).find(match)
      if (found) return found
      await delay(20)
    }
    throw new Error(`no ${method} notification arrived`)
  }

  async waitForRequest(method: string): Promise<{ id: number; params: any }> {
    for (let waited = 0; waited < 10_000; waited += 20) {
      const found = this.serverRequests.find((entry) => entry.method === method)
      if (found) return found
      await delay(20)
    }
    throw new Error(`no ${method} request arrived`)
  }

  async startThread(params: Record<string, unknown> = {}): Promise<string> {
    const { thread } = await this.request('thread/start', { cwd: this.home, ...params })
    return thread.id
  }

  // Runs a turn to its end and returns the text of its last agent message.
  async ask(threadId: string, text: string): Promise<string> {
    const from = this.mark()
    const { turn } = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    await this.waitFor('turn/completed', (params) => params.turn.id === turn.id, from)
    const { thread } = await this.request('thread/read', { threadId, includeTurns: true })
    const done = thread.turns.find((entry: any) => entry.id === turn.id)
    return done?.items.findLast((item: any) => item.type === 'agentMessage')?.text ?? ''
  }

  // Calls one leader tool from a turn of `leaderId` and returns its result:
  // the parsed JSON, or { error } for an error result. Lines after the JSON
  // (thread_start's ::created-thread line) come back as `lines`.
  async tool(leaderId: string, tool: string, input: Record<string, unknown>): Promise<any> {
    const reply = await this.ask(leaderId, `leader ${tool} ${JSON.stringify(input)}`)
    const prefix = `${tool} => `
    assert.ok(reply.startsWith(prefix), reply)
    const result = reply.slice(prefix.length)
    if (result.startsWith('error: ')) return { error: result.slice(7) }
    const [json = '', ...lines] = result.split('\n')
    return { ...JSON.parse(json), ...(lines.length > 0 ? { lines } : {}) }
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill()
      await once(this.proc, 'exit')
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method != null) {
        if (message.id == null) this.notifications.push(message)
        else this.serverRequests.push(message)
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }
}

const LEADER_ENV = { CLAUDE_CODEX_LEADER_TOOLS: '1' }

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-leader-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

async function withServer(
  env: Record<string, string>,
  run: (server: AppServer) => Promise<void>,
): Promise<void> {
  await withHome(async (home) => {
    const server = new AppServer(home, env)
    try {
      await run(server)
    } finally {
      await server.stop()
    }
  })
}

test('leader tools are off unless enabled, and chats a leader starts get none', async () => {
  await withServer({}, async (server) => {
    const threadId = await server.startThread()
    assert.equal(await server.ask(threadId, 'leader tools check'), 'leader tools: off')
  })
  await withServer(LEADER_ENV, async (server) => {
    const leader = await server.startThread()
    assert.equal(await server.ask(leader, 'leader tools check'), 'leader tools: on')
    const started = await server.tool(leader, 'thread_start', { prompt: 'leader tools check' })
    const waited = await server.tool(leader, 'thread_wait', { threadIds: [started.threadId] })
    assert.equal(waited.threads[0].lastAgentMessage, 'leader tools: off')
    // Not even when the user prompts it later.
    assert.equal(await server.ask(started.threadId, 'leader tools check'), 'leader tools: off')
    // Nor in a fork of it, which would otherwise lift the one-level limit.
    const { thread: fork } = await server.request('thread/fork', { threadId: started.threadId })
    assert.equal(await server.ask(fork.id, 'leader tools check'), 'leader tools: off')
    assert.equal(await server.ask(leader, 'leader tools check'), 'leader tools: on')
  })
})

test('thread_start announces a chat the App lists and runs its first turn', async () => {
  await withServer(LEADER_ENV, async (server) => {
    const leader = await server.startThread()
    const from = server.mark()
    const started = await server.tool(leader, 'thread_start', {
      prompt: 'count to three',
      title: 'Counter',
    })
    const childId = started.threadId
    assert.notEqual(childId, leader)
    assert.equal(started.status, 'working')
    assert.equal(started.title, 'Counter')
    assert.equal(started.cwd, server.home)
    // The line Claude repeats in its reply for the App's created-thread card,
    // naming a UUIDv7 id like the threads Codex creates. The mock repeats the
    // result, and the stored reply keeps the line intact.
    assert.deepEqual(started.lines, [`::created-thread{threadId="${childId}"}`])
    assert.match(childId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    // What the App needs to show the chat: thread/started, its title, and the
    // turn with the user message it did not draw itself.
    const announced = await server.waitFor(
      'thread/started',
      (params) => params.thread.id === childId,
      from,
    )
    assert.equal(announced.thread.ephemeral, false)
    await server.waitFor('thread/name/updated', (params) => params.threadId === childId, from)
    const turnStarted = await server.waitFor(
      'turn/started',
      (params) => params.threadId === childId,
      from,
    )
    assert.equal(turnStarted.turn.id, started.turnId)
    const userItem = await server.waitFor(
      'item/completed',
      (params) => params.threadId === childId && params.item.type === 'userMessage',
      from,
    )
    assert.equal(userItem.item.content[0].text, 'count to three')
    await server.waitFor('turn/completed', (params) => params.threadId === childId, from)
    const listed = await server.request('thread/list', {})
    assert.ok(listed.data.some((thread: any) => thread.id === childId))

    // Done and unread until a wait returns it; then idle.
    const listedBefore = await server.tool(leader, 'thread_list', {})
    assert.equal(listedBefore.threads[0].status, 'done-unread')
    const waited = await server.tool(leader, 'thread_wait', { threadIds: [childId] })
    assert.equal(waited.timedOut, false)
    assert.equal(waited.threads[0].status, 'done-unread')
    assert.equal(waited.threads[0].turnStatus, 'completed')
    assert.equal(
      waited.threads[0].lastAgentMessage,
      'Claude Code adapter mock response for: count to three',
    )
    const listedAfter = await server.tool(leader, 'thread_list', {})
    assert.deepEqual(
      listedAfter.threads.map((thread: any) => [thread.threadId, thread.status]),
      [[childId, 'idle']],
    )
    assert.equal(listedAfter.running, 0)

    // thread_read pages the transcript; its cursor skips what was read.
    const read = await server.tool(leader, 'thread_read', { threadId: childId })
    assert.equal(read.hasMore, false)
    assert.deepEqual(read.turns[0].items, [
      { type: 'user', text: 'count to three' },
      { type: 'agent', text: 'Claude Code adapter mock response for: count to three' },
    ])
    const again = await server.tool(leader, 'thread_read', {
      threadId: childId,
      sinceCursor: read.cursor,
    })
    assert.deepEqual(again.turns, [])
    const reset = await server.tool(leader, 'thread_read', {
      threadId: childId,
      sinceCursor: 'gone:0',
    })
    assert.equal(reset.cursorReset, true)
    assert.equal(reset.turns.length, 1)
  })
})

test('thread_wait returns when a chat blocks on an approval, and thread_prompt refuses it', async () => {
  await withServer(LEADER_ENV, async (server) => {
    const leader = await server.startThread({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    const started = await server.tool(leader, 'thread_start', { prompt: 'run bash please' })
    const childId = started.threadId
    // The approval goes to the App, in the started chat.
    const approval = await server.waitForRequest('item/commandExecution/requestApproval')
    assert.equal(approval.params.threadId, childId)

    const waited = await server.tool(leader, 'thread_wait', { threadIds: [childId] })
    assert.equal(waited.timedOut, false)
    assert.equal(waited.threads[0].status, 'blocked')
    assert.equal(waited.threads[0].blockedOn, 'approval')
    const refused = await server.tool(leader, 'thread_prompt', {
      threadId: childId,
      text: 'just approve it',
    })
    assert.match(refused.error, /waiting for the user to approve a request/)

    // Once the user answers, the chat finishes and the wait reports it.
    server.answer(approval.id, { decision: 'accept' })
    const done = await server.tool(leader, 'thread_wait', { threadIds: [childId] })
    assert.equal(done.threads[0].status, 'done-unread')
    assert.equal(done.threads[0].turnStatus, 'completed')
  })
})

test('a chat a leader starts gets its permissions and never more', async () => {
  await withServer(LEADER_ENV, async (server) => {
    const leader = await server.startThread({ approvalPolicy: 'untrusted', sandbox: 'read-only' })
    const policyOf = async (): Promise<string> => {
      const started = await server.tool(leader, 'thread_start', { prompt: 'policy check' })
      const waited = await server.tool(leader, 'thread_wait', { threadIds: [started.threadId] })
      return waited.threads[0].lastAgentMessage
    }
    assert.equal(await policyOf(), 'approvalPolicy=untrusted sandboxMode=read-only')

    // Values the adapter does not know leave the leader with no policy, which
    // asks before tools run. The chat it starts asks too: thread/start would
    // read a missing policy as never and full access.
    await server.request('thread/resume', {
      threadId: leader,
      approvalPolicy: 'bogus',
      sandbox: 'bogus',
    })
    assert.equal(await server.ask(leader, 'policy check'), 'approvalPolicy=null sandboxMode=null')
    assert.equal(await policyOf(), 'approvalPolicy=on-request sandboxMode=workspace-write')
  })
})

test('thread_prompt steers a working chat or starts a turn, and can wait for it', async () => {
  await withServer(LEADER_ENV, async (server) => {
    const leader = await server.startThread()
    const started = await server.tool(leader, 'thread_start', {
      prompt: 'hold this turn until released',
    })
    const childId = started.threadId
    const listed = await server.tool(leader, 'thread_list', {})
    assert.equal(listed.threads[0].status, 'working')
    const pending = await server.tool(leader, 'thread_wait', {
      threadIds: [childId],
      until: 'all',
      timeoutSec: 0.2,
    })
    assert.equal(pending.timedOut, true)
    assert.equal(pending.threads[0].status, 'working')

    // Mid-turn the message joins the running turn, like the App's steer.
    const steered = await server.tool(leader, 'thread_prompt', {
      threadId: childId,
      text: 'release now',
      wait: true,
      timeoutSec: 20,
    })
    assert.equal(steered.delivered, 'steered')
    assert.equal(steered.turnId, started.turnId)
    assert.equal(steered.timedOut, false)
    assert.equal(steered.turnStatus, 'completed')
    assert.equal(steered.lastAgentMessage, 'holding released')
    assert.equal(steered.status, 'idle')

    const next = await server.tool(leader, 'thread_prompt', {
      threadId: childId,
      text: 'count to four',
      wait: true,
    })
    assert.equal(next.delivered, 'newTurn')
    assert.notEqual(next.turnId, started.turnId)
    assert.equal(next.lastAgentMessage, 'Claude Code adapter mock response for: count to four')

    // Only the leader that started a chat may drive it.
    const other = await server.startThread()
    const foreign = await server.tool(other, 'thread_prompt', { threadId: childId, text: 'hi' })
    assert.match(foreign.error, /not a chat you started/)
    const self = await server.tool(leader, 'thread_wait', { threadIds: [leader] })
    assert.match(self.error, /that is this chat/)
  })
})

test('a leader sees no quiet-turn heartbeat, only that background work still runs', async () => {
  await withServer(LEADER_ENV, async (server) => {
    const leader = await server.startThread()
    const from = server.mark()
    const started = await server.tool(leader, 'thread_start', {
      prompt: 'background subagent check delay=1500',
    })
    const childId = started.threadId
    // The App gets the heartbeat that keeps its unread dot off.
    const quiet = await server.waitFor(
      'item/completed',
      (params) => params.threadId === childId && params.item.type === 'agentMessage',
      from,
    )
    assert.match(quiet.item.text, /<heartbeat>/)

    const waited = await server.tool(leader, 'thread_wait', { threadIds: [childId] })
    assert.equal(waited.threads[0].lastAgentMessage, 'agent launched in background')
    assert.equal(waited.threads[0].backgroundWorkRunning, true)
    const read = await server.tool(leader, 'thread_read', { threadId: childId })
    const agentTexts = read.turns[0].items
      .filter((item: any) => item.type === 'agent')
      .map((item: any) => item.text)
    assert.deepEqual(agentTexts, ['agent launched in background'])

    // The agent reports back in a turn of its own, which carries no heartbeat.
    await server.waitFor(
      'turn/completed',
      (params) => params.threadId === childId && params.turn.id !== started.turnId,
      from,
    )
    const reported = await server.tool(leader, 'thread_wait', { threadIds: [childId] })
    assert.notEqual(reported.threads[0].turnId, started.turnId)
    assert.doesNotMatch(reported.threads[0].lastAgentMessage, /heartbeat/)
    assert.equal(reported.threads[0].backgroundWorkRunning, undefined)
  })
})

test('a leader runs a limited number of chats, and its links survive a restart', async () => {
  await withHome(async (home) => {
    const env = { ...LEADER_ENV, CLAUDE_CODEX_LEADER_MAX_RUNNING: '1' }
    let server = new AppServer(home, env)
    let leader: string
    let childId: string
    try {
      leader = await server.startThread()
      const started = await server.tool(leader, 'thread_start', {
        prompt: 'hold this turn until released',
      })
      childId = started.threadId
      const capped = await server.tool(leader, 'thread_start', { prompt: 'count to three' })
      assert.match(capped.error, /still working \(the limit is 1\)/)
      const unknownCwd = await server.tool(leader, 'thread_start', {
        prompt: 'count to three',
        cwd: 'relative/dir',
      })
      assert.match(unknownCwd.error, /cwd must be an existing directory|still working/)
      const gpt = await server.tool(leader, 'thread_start', { prompt: 'x', model: 'gpt-5' })
      assert.match(gpt.error, /still working|Claude chats only/)

      // The user releases the chat in the App; then there is room again.
      const from = server.mark()
      await server.request('turn/steer', {
        threadId: childId,
        expectedTurnId: started.turnId,
        input: [{ type: 'text', text: 'release', text_elements: [] }],
      })
      await server.waitFor('turn/completed', (params) => params.threadId === childId, from)
      const gptNow = await server.tool(leader, 'thread_start', { prompt: 'x', model: 'gpt-5' })
      assert.match(gptNow.error, /Claude chats only/)
    } finally {
      await server.stop()
    }

    server = new AppServer(home, env)
    try {
      const listed = await server.tool(leader, 'thread_list', {})
      assert.deepEqual(
        listed.threads.map((thread: any) => [thread.threadId, thread.status]),
        [[childId, 'done-unread']],
      )
      // A chat nothing was sent to stays out, as in the sidebar.
      const empty = await server.startThread()
      const all = await server.tool(leader, 'thread_list', { scope: 'all' })
      assert.ok(
        all.threads.some((thread: any) => thread.threadId === childId && thread.startedByYou),
      )
      assert.ok(!all.threads.some((thread: any) => thread.threadId === empty))
      assert.equal(await server.ask(childId, 'leader tools check'), 'leader tools: off')
    } finally {
      await server.stop()
    }
  })
})

// In process, with a runtime that keeps every turn open: for what the mock
// adapter cannot reach, which picks its own runtime and passes no signal.
const PROCESS_ENV = [
  'CLAUDE_CODEX_HOME',
  'CODEX_HOME',
  'CLAUDE_CODEX_MOCK',
  'CLAUDE_CODEX_PROVIDER',
  'CLAUDE_CODEX_AGENT_LOOP',
  'CLAUDE_CODEX_RUNTIME_TYPE',
  'CLAUDE_CODEX_RUNTIME',
  'CLAUDE_CODEX_BACKEND',
  'CLAUDE_CODEX_LEADER_TOOLS',
  'CLAUDE_CODEX_LEADER_MAX_RUNNING',
]

interface InProcess {
  home: string
  store: SessionStore
  request(method: string, params: Record<string, unknown>): Promise<any>
  notified(method: string): any[]
  // The context of the thread's latest turn, once the runtime has it.
  turnOf(threadId: string): Promise<RuntimeTurnContext>
}

async function withInProcessServer(run: (server: InProcess) => Promise<void>): Promise<void> {
  const saved = PROCESS_ENV.map((key) => [key, process.env[key]] as const)
  await withHome(async (home) => {
    for (const key of PROCESS_ENV) delete process.env[key]
    Object.assign(process.env, {
      CLAUDE_CODEX_HOME: home,
      CODEX_HOME: home,
      CLAUDE_CODEX_LEADER_TOOLS: '1',
    })
    const store = new SessionStore(join(home, 'state.sqlite'))
    const turns = new Map<string, RuntimeTurnContext>()
    const runtime: ClaudeRuntime = {
      // Never settles: an interrupt or the server's stop ends the turn.
      runTurn: (context) => {
        turns.set(context.threadId, context)
        return new Promise<void>(() => {})
      },
      steer: async () => false,
      interrupt: async () => {},
      stop: async () => {},
    }
    const server = new CodexClaudeAppServer(store, runtime)
    const messages: any[] = []
    const peer: RpcPeer = {
      id: 'leader-test',
      close: () => {},
      send: (message: WireMessage) => messages.push(structuredClone(message)),
    }
    let nextId = 1
    try {
      await run({
        home,
        store,
        request: async (method, params) => {
          const id = nextId++
          await server.handle(peer, { id, method, params })
          const reply = messages.find((message) => message.id === id && message.method == null)
          if (reply?.error) throw new Error(reply.error.message)
          return reply?.result
        },
        notified: (method) =>
          messages.filter((message) => message.method === method).map((message) => message.params),
        turnOf: async (threadId) => {
          for (let waited = 0; waited < 5_000; waited += 20) {
            const context = turns.get(threadId)
            if (context) return context
            await delay(20)
          }
          throw new Error(`no turn ran on ${threadId}`)
        },
      })
    } finally {
      await server.stop()
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

async function startLeader(server: InProcess) {
  const { thread } = await server.request('thread/start', { cwd: server.home, model: 'sonnet' })
  await server.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'start some chats', text_elements: [] }],
  })
  const { leaderTools } = await server.turnOf(thread.id)
  assert.ok(leaderTools)
  return { leaderId: thread.id as string, tools: leaderTools }
}

// What thread_start returns, without its ::created-thread line.
function startResult(result: string): any {
  const [json = ''] = result.split('\n')
  return JSON.parse(json)
}

test('thread_start starts no chat while new chats run on the Codex proxy', async () => {
  await withInProcessServer(async (server) => {
    const { leaderId, tools } = await startLeader(server)
    process.env.CLAUDE_CODEX_PROVIDER = 'codex'
    await assert.rejects(tools.start({ prompt: 'count to three' }), /Codex proxy/)
    assert.deepEqual(
      server.notified('thread/started').map((params) => params.thread.id),
      [leaderId],
    )
    assert.deepEqual(server.store.listLeaderThreads(leaderId), [])

    // Back on Claude, the same call starts a Claude chat, which gets no tools.
    delete process.env.CLAUDE_CODEX_PROVIDER
    const started = startResult(await tools.start({ prompt: 'count to three' }))
    const child = await server.turnOf(started.threadId)
    assert.match(child.prompt, /count to three/)
    assert.equal(child.leaderTools ?? null, null)
    assert.equal(server.store.getThread(started.threadId)?.runtimeBackend, 'claude')
  })
})

test('a pending wait ends when its call is aborted or the leader turn is interrupted', async () => {
  await withInProcessServer(async (server) => {
    const { leaderId, tools } = await startLeader(server)
    const { threadId } = startResult(await tools.start({ prompt: 'keep working' }))
    await server.turnOf(threadId)

    // The SDK aborts a tool call when the leader's turn stops.
    const controller = new AbortController()
    const aborted = tools.wait({ threadIds: [threadId], timeoutSec: 30 }, controller.signal)
    controller.abort()
    const afterAbort = JSON.parse(await aborted)
    assert.equal(afterAbort.timedOut, true)
    assert.equal(afterAbort.threads[0].status, 'working')

    // Without a signal, the leader's turn ending is enough.
    const since = Date.now()
    const waiting = tools.wait({ threadIds: [threadId], timeoutSec: 30 })
    await server.request('turn/interrupt', { threadId: leaderId })
    const afterInterrupt = JSON.parse(await waiting)
    assert.equal(afterInterrupt.timedOut, true)
    assert.equal(afterInterrupt.threads[0].status, 'working')
    assert.ok(Date.now() - since < 5_000)
  })
})
