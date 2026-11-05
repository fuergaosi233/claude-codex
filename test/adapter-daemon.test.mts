import assert from 'node:assert/strict'
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Duplex } from 'node:stream'
import test from 'node:test'
import WebSocket from 'ws'
import { SessionStore } from '../src/store.mjs'
import {
  adapter,
  awaitMessage,
  delay,
  JsonLineReader,
  json,
  nextNotification,
  spawnMockAdapter,
  startMockThread,
  stopProcess,
  textInput,
  waitForExit,
} from './support/adapter-harness.mjs'

const shim = resolve('scripts/codex-shim')

test('unix websocket app-server accepts initialize', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(proc, /listening on/)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    await stopProcess(proc)
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix daemon removes its socket when it stops, unless another has taken the path', {
  timeout: 30_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const env = {
    ...process.env,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  }
  const start = async (): Promise<ChildProcess> => {
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    })
    await waitForStderr(proc, /listening on/)
    return proc
  }
  const daemons: ChildProcess[] = []
  let ws: WebSocket | null = null
  const other = net.createServer()
  try {
    // A connected client does not keep the socket around.
    const first = await start()
    daemons.push(first)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    ws.on('error', () => {})
    await once(ws, 'open')
    first.kill('SIGTERM')
    assert.equal(await waitForExit(first, 10_000), 0)
    assert.equal(existsSync(sock), false, 'the socket goes with the daemon')
    assert.equal(existsSync(`${sock}.pid`), false)

    // Another process has bound the path since: its socket stays.
    const second = await start()
    daemons.push(second)
    await rm(sock)
    await new Promise<void>((resolve) => other.listen(sock, resolve))
    second.kill('SIGINT')
    assert.equal(await waitForExit(second, 10_000), 0)
    assert.equal(existsSync(sock), true, 'a socket the daemon did not bind stays')
    const probe = net.createConnection(sock)
    await once(probe, 'connect')
    probe.destroy()
    assert.equal(existsSync(`${sock}.pid`), false)
  } finally {
    terminateWebSocket(ws)
    await Promise.all(daemons.map((proc) => stopProcess(proc)))
    if (other.listening) await new Promise<void>((resolve) => other.close(() => resolve()))
    await rm(sock, { force: true })
    await rm(`${sock}.pid`, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix daemon keeps active turns alive across peer reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_IDLE_EXIT_MS: '40',
      NODE_NO_WARNINGS: '1',
    },
  })
  try {
    await waitForStderr(proc, /listening on/)
    const ws1 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader1 = new WebSocketJsonReader(ws1)
    await once(ws1, 'open')
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    const slowPrompt = `active reconnect check ${'x'.repeat(400)}`
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: slowPrompt, text_elements: [] }] },
      }),
    )
    await reader1.nextResponse(2)

    ws1.close()
    await once(ws1, 'close')
    await delay(120)
    assert.equal(proc.exitCode, null)

    const ws2 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader2 = new WebSocketJsonReader(ws2)
    await once(ws2, 'open')
    ws2.send(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'thread/resume', params: { threadId } }),
    )
    await reader2.nextResponse(3)

    // How much of the reply streamed while no peer was connected depends on
    // timing, so the deltas only show the stream went on; the finished item
    // carries the whole reply.
    let streamed = ''
    let text = ''
    let completed = false
    for (let i = 0; i < 1000; i += 1) {
      const message = await reader2.next()
      if (message.method === 'item/agentMessage/delta') streamed += message.params.delta
      if (message.method === 'item/completed' && message.params.item.type === 'agentMessage')
        text = message.params.item.text
      if (message.method === 'turn/completed') {
        completed = true
        break
      }
    }
    assert.equal(completed, true)
    assert.match(streamed, /x{20}/)
    assert.match(text, /active reconnect check/)

    ws2.close()
    await once(ws2, 'close')
    assert.equal(await waitForExit(proc, 2000), 0)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix daemon recovers stale in-progress turns after process restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  let proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    await waitForStderr(proc, /listening on/)
    const ws1 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader1 = new WebSocketJsonReader(ws1)
    await once(ws1, 'open')
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: `stale restart check ${'x'.repeat(20_000)}`, text_elements: [] },
          ],
        },
      }),
    )
    const turnStart = await reader1.nextResponse(2)
    const turnId = turnStart.result.turn.id

    proc.kill('SIGKILL')
    await Promise.race([
      once(proc, 'exit'),
      delay(2000).then(() => {
        throw new Error('timed out waiting for killed daemon to exit')
      }),
    ])
    ws1.terminate()

    proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    await waitForStderr(proc, /listening on/)

    const ws2 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader2 = new WebSocketJsonReader(ws2)
    await once(ws2, 'open')
    ws2.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'thread/read',
        params: { threadId, includeTurns: true },
      }),
    )
    const read = await reader2.nextResponse(3)
    assert.equal(read.result.thread.status.type, 'idle')
    const recoveredTurn = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    assert.equal(recoveredTurn.status, 'interrupted')
    assert.match(recoveredTurn.error.message, /server restarted before completing turn/)
    ws2.close()
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stdio app-server recovers stale in-progress turns after process restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  let proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    const reader1 = new JsonLineReader(proc)
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            {
              type: 'text',
              text: `stdio stale restart check ${'x'.repeat(20_000)}`,
              text_elements: [],
            },
          ],
        },
      }),
    )
    const turnStart = await reader1.nextResponse(2)
    const turnId = turnStart.result.turn.id

    proc.kill('SIGKILL')
    await Promise.race([
      once(proc, 'exit'),
      delay(2000).then(() => {
        throw new Error('timed out waiting for killed stdio adapter to exit')
      }),
    ])

    proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    const reader2 = new JsonLineReader(proc)
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader2.nextResponse(3)
    assert.equal(read.result.thread.status.type, 'idle')
    const recoveredTurn = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    assert.equal(recoveredTurn.status, 'interrupted')
    assert.match(recoveredTurn.error.message, /server restarted before completing turn/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a second stdio app-server on the same CODEX_HOME leaves a running turn of the first alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const first = spawnMockAdapter(home)
  let second: ChildProcessWithoutNullStreams | null = null
  try {
    const reader1 = new JsonLineReader(first)
    const threadId = await startMockThread(reader1, first)
    first.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('hold this turn until released') },
      }),
    )
    const turnId = (await reader1.nextResponse(2)).result.turn.id

    // A probe or another window starts a server on the same state dir while
    // the first one is mid-turn.
    second = spawnMockAdapter(home)
    const reader2 = new JsonLineReader(second)
    second.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader2.nextResponse(3)
    assert.equal(
      read.result.thread.turns.find((turn: any) => turn.id === turnId)?.status,
      'inProgress',
    )
    await stopProcess(second)

    first.stdin.write(
      json({
        id: 4,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: turnId, input: textInput('release') },
      }),
    )
    const completed = await awaitMessage(
      reader1,
      (message) => message.method === 'turn/completed' && message.params.turn.id === turnId,
    )
    assert.equal(completed.params.turn.status, 'completed')
  } finally {
    await stopProcess(first)
    if (second) await stopProcess(second)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the adapter warns once as it starts that bridged hooks need a CLI without settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
    CLAUDE_CODEX_CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CLAUDE_CODEX_CLAUDE_HOOKS: 'user',
  }
  delete env.CLAUDE_CODEX_CLI
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  try {
    const reader = new JsonLineReader(proc)
    for (const id of [1, 2]) {
      proc.stdin.write(
        json({
          id,
          method: 'initialize',
          params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
        }),
      )
      await reader.nextResponse(id)
    }
    // stderr is a pipe of its own, read apart from the responses.
    for (const until = Date.now() + 5000; !stderr.includes('runs twice') && Date.now() < until; )
      await delay(25)
    await delay(200)
    const lines = stderr.split('\n').filter((line) => line.includes('CLAUDE_CODEX_CLAUDE_HOOKS'))
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /^\[claude-codex-adapter\] .*runs twice/)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a turn waits out a reader briefly holding the state database', {
  timeout: 20_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_HOME: join(home, 'adapter'),
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  // A hung turn must not keep the test runner alive past the timeout; the
  // adapter defers a plain SIGTERM while it still has an active turn.
  t.signal.addEventListener('abort', () => proc.kill('SIGKILL'))
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startLockTestThread(proc, reader)
    const turnId = await startLockTestTurn(proc, reader, threadId, 2, 'state lock wait check')
    await nextNotification(reader, 'item/agentMessage/delta')
    const release = holdStateDatabase(join(home, 'adapter', 'state.sqlite'))
    await delay(300)
    release()

    const seen = await nextTurnCompleted(reader, turnId)
    assert.equal(seen.completed.status, 'completed')
    assert.equal(seen.methods.includes('error'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a turn the state database refuses still ends and frees the thread', {
  timeout: 30_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLogPath = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_HOME: join(home, 'adapter'),
      CLAUDE_CODEX_DEBUG_LOG: debugLogPath,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_STATE_DB_TIMEOUT_MS: '50',
      NODE_NO_WARNINGS: '1',
    },
  })
  // A hung turn must not keep the test runner alive past the timeout; the
  // adapter defers a plain SIGTERM while it still has an active turn.
  t.signal.addEventListener('abort', () => proc.kill('SIGKILL'))
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startLockTestThread(proc, reader)
    const turnId = await startLockTestTurn(proc, reader, threadId, 2, 'state lock refusal check')
    await nextNotification(reader, 'item/agentMessage/delta')
    // Held past the adapter's busy timeout: its next write fails, and so does
    // the write that would record the failure.
    const release = holdStateDatabase(join(home, 'adapter', 'state.sqlite'))
    let seen: Awaited<ReturnType<typeof nextTurnCompleted>>
    let status: { params: Record<string, unknown> }
    try {
      seen = await nextTurnCompleted(reader, turnId)
      status = await nextNotification(reader, 'thread/status/changed')
    } finally {
      release()
    }
    assert.equal(seen.completed.status, 'failed')
    assert.match(seen.completed.error.message, /database is locked/)
    assert.equal(seen.methods.includes('error'), true)
    assert.deepEqual(status.params.status, { type: 'idle' })

    const nextTurnId = await startLockTestTurn(proc, reader, threadId, 3, 'after the lock')
    const next = await nextTurnCompleted(reader, nextTurnId)
    assert.equal(next.completed.status, 'completed')

    // The refused write is retried, so the stored turn ends too.
    let stored: any = null
    for (let attempt = 0; attempt < 40 && stored?.status !== 'failed'; attempt += 1) {
      await delay(250)
      const id = 100 + attempt
      proc.stdin?.write(
        json({ id, method: 'thread/read', params: { threadId, includeTurns: true } }),
      )
      const read = await reader.nextResponse(id)
      stored = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    }
    assert.equal(stored?.status, 'failed')

    const events = (await readFile(debugLogPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).event)
    assert.equal(events.includes('turn.persist_failed'), true)
    assert.equal(events.includes('turn.persist_recovered'), true)
    assert.equal(events.includes('adapter.unhandledRejection'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery terminalizes persisted in-progress item liveness', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const childThreadId = randomUUID()
  const turnId = randomUUID()
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: 'stale item recovery',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: Math.floor(Date.now() / 1000) - 2,
      updatedAt: Math.floor(Date.now() / 1000) - 2,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: Math.floor(Date.now() / 1000) - 2,
      completedAt: null,
      durationMs: null,
      items: [
        {
          type: 'userMessage',
          id: randomUUID(),
          content: [{ type: 'text', text: 'stale item recovery', text_elements: [] }],
        },
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'started',
          agentThreadId: childThreadId,
          agentPath: '/root/agent-stale',
        },
        {
          type: 'collabAgentToolCall',
          id: randomUUID(),
          tool: 'wait',
          status: 'inProgress',
          senderThreadId: threadId,
          receiverThreadIds: [childThreadId],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { [childThreadId]: { status: 'running', message: null } },
        },
        {
          type: 'commandExecution',
          id: randomUUID(),
          command: 'echo stale',
          cwd: process.cwd(),
          processId: null,
          source: 'shell',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
      diff: '',
      error: null,
    })

    assert.equal(store.recoverStaleInProgressTurns(), 1)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(store.getThread(threadId)?.status.type, 'idle')
    const activity = recovered.items.find((item) => item.type === 'subAgentActivity')
    assert.equal(activity?.type === 'subAgentActivity' ? activity.kind : null, 'interrupted')
    const wait = recovered.items.find(
      (item) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(wait?.type === 'collabAgentToolCall' ? wait.status : null, 'failed')
    assert.equal(
      wait?.type === 'collabAgentToolCall' ? wait.agentsStates[childThreadId]?.status : null,
      'errored',
    )
    const command = recovered.items.find((item) => item.type === 'commandExecution')
    assert.equal(command?.type === 'commandExecution' ? command.status : null, 'failed')
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test("a thread's memory mode survives a stale save and a restart", async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const path = join(home, 'state.sqlite')
  const store = new SessionStore(path)
  const now = Math.floor(Date.now() / 1000)
  const record = (id: string, memoryMode?: 'enabled' | 'disabled') => ({
    id,
    sessionId: id,
    forkedFromId: null,
    preview: 'memory mode',
    name: null,
    archived: false,
    cwd: process.cwd(),
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    claudeSessionId: null,
    source: 'appServer',
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' as const },
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    runtimeBackend: 'claude' as const,
    codexSessionId: null,
    ...(memoryMode ? { memoryMode } : {}),
  })
  const threadId = randomUUID()
  const olderId = randomUUID()
  let open: SessionStore | null = store
  try {
    store.upsertThread(record(threadId, 'enabled'))
    store.upsertThread(record(olderId))
    assert.equal(store.getThread(threadId)?.memoryMode, 'enabled')
    // A thread saved without a mode follows the global config.
    assert.equal(store.getThread(olderId)?.memoryMode, null)

    store.setThreadMemoryMode(threadId, 'disabled')
    // A turn saving the record it read before the switch keeps the switch.
    store.upsertThread(record(threadId, 'enabled'))
    assert.equal(store.getThread(threadId)?.memoryMode, 'disabled')
    store.close()
    open = null

    const reopened = new SessionStore(path)
    open = reopened
    assert.equal(reopened.getThread(threadId)?.memoryMode, 'disabled')
    assert.equal(reopened.getThread(olderId)?.memoryMode, null)
  } finally {
    open?.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery repairs stale items on already-terminal turns and is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const turnId = randomUUID()
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: 'terminal item recovery',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: Math.floor(Date.now() / 1000) - 2,
      updatedAt: Math.floor(Date.now() / 1000) - 2,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'interrupted',
      startedAt: Math.floor(Date.now() / 1000) - 2,
      completedAt: Math.floor(Date.now() / 1000) - 1,
      durationMs: 1000,
      items: [
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'started',
          agentThreadId: randomUUID(),
          agentPath: '/root/stale',
        },
        {
          type: 'commandExecution',
          id: randomUUID(),
          command: 'echo stale',
          cwd: process.cwd(),
          processId: null,
          source: 'shell',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
      diff: '',
      error: { message: 'already interrupted' },
    })

    assert.equal(store.recoverStaleInProgressTurns(), 1)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    assert.equal(
      recovered.items.find((item) => item.type === 'subAgentActivity')?.kind,
      'interrupted',
    )
    assert.equal(recovered.items.find((item) => item.type === 'commandExecution')?.status, 'failed')
    assert.equal(store.recoverStaleInProgressTurns(), 0)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery keeps markers of finished agents and ends the ones it cut off', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const turnId = randomUUID()
  const finished = randomUUID()
  const cutOff = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const thread = (id: string, preview: string) =>
    store.upsertThread({
      id,
      sessionId: id,
      forkedFromId: id === threadId ? null : threadId,
      preview,
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: now - 5,
      updatedAt: now - 5,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: id !== threadId,
      threadSource: id === threadId ? 'user' : 'subagent',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
  const childTurn = (id: string, status: 'completed' | 'inProgress') =>
    store.upsertTurn({
      id: randomUUID(),
      threadId: id,
      status,
      startedAt: now - 4,
      completedAt: status === 'completed' ? now - 1 : null,
      durationMs: status === 'completed' ? 3000 : null,
      items: [],
      diff: '',
      error: null,
    })
  const spawn = (id: string) => ({
    type: 'collabAgentToolCall' as const,
    id: randomUUID(),
    tool: 'spawnAgent' as const,
    status: 'completed' as const,
    senderThreadId: threadId,
    receiverThreadIds: [id],
    prompt: 'work',
    model: null,
    reasoningEffort: null,
    agentsStates: { [id]: { status: 'running' as const, message: null } },
  })
  const activity = (id: string, kind: 'started' | 'completed') => ({
    type: 'subAgentActivity' as const,
    id: randomUUID(),
    kind,
    agentThreadId: id,
    agentPath: `/root/${id.slice(0, 8)}`,
  })
  try {
    thread(threadId, 'background agents across a restart')
    thread(finished, 'finished')
    thread(cutOff, 'cut off')
    childTurn(finished, 'completed')
    childTurn(cutOff, 'inProgress')
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'completed',
      startedAt: now - 5,
      completedAt: now - 4,
      durationMs: 1000,
      items: [
        spawn(finished),
        activity(finished, 'started'),
        spawn(cutOff),
        activity(cutOff, 'started'),
        {
          type: 'collabAgentToolCall',
          id: randomUUID(),
          tool: 'wait',
          status: 'failed',
          senderThreadId: threadId,
          receiverThreadIds: [cutOff],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { [cutOff]: { status: 'running', message: null } },
        },
        activity(finished, 'completed'),
      ],
      diff: '',
      error: null,
    })

    assert.ok(store.recoverStaleInProgressTurns() >= 2)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    const marks = recovered.items.map((item) =>
      item.type === 'subAgentActivity'
        ? `${item.agentThreadId === finished ? 'finished' : 'cutOff'}:${item.kind}`
        : item.type === 'collabAgentToolCall'
          ? `${item.tool}:${item.status}:${Object.entries(item.agentsStates)
              .map(([id, state]) => `${id === finished ? 'finished' : 'cutOff'}=${state?.status}`)
              .join(',')}`
          : item.type,
    )
    assert.deepEqual(marks, [
      'spawnAgent:completed:finished=running',
      'finished:started',
      'spawnAgent:completed:cutOff=errored',
      'cutOff:interrupted',
      'wait:failed:cutOff=errored',
      'finished:completed',
    ])
    assert.equal(store.getThread(threadId)?.status.type, 'idle')
    assert.equal(store.recoverStaleInProgressTurns(), 0)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery fails only the turns of servers that are gone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const path = join(home, 'state.sqlite')
  const store = new SessionStore(path)
  const now = Math.floor(Date.now() / 1000)
  // live: another server still runs it. reused: its server's pid now names a
  // process that started later. legacy: written before turns named a server.
  const threads = { live: randomUUID(), reused: randomUUID(), legacy: randomUUID() }
  const turns = { live: randomUUID(), reused: randomUUID(), legacy: randomUUID() }
  let server: ChildProcessWithoutNullStreams | null = null
  try {
    for (const threadId of Object.values(threads)) {
      store.upsertThread({
        id: threadId,
        sessionId: threadId,
        forkedFromId: null,
        preview: 'owner recovery',
        name: null,
        archived: false,
        cwd: process.cwd(),
        model: 'sonnet',
        reasoningEffort: null,
        modelProvider: 'claude-code',
        claudeSessionId: null,
        source: 'appServer',
        createdAt: now,
        updatedAt: now,
        status: { type: 'active', activeFlags: [] },
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        ephemeral: false,
        threadSource: 'user',
        agentRole: null,
        agentNickname: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        runtimeBackend: 'claude',
        codexSessionId: null,
      })
    }
    // The other server writes its turns, then keeps running.
    const pairs = (['live', 'reused', 'legacy'] as const).map((key) => [threads[key], turns[key]])
    server = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { SessionStore } from './dist/src/store.mjs'

      const store = new SessionStore(${JSON.stringify(path)})
      for (const [threadId, id] of ${JSON.stringify(pairs)}) {
        store.upsertTurn({
          id,
          threadId,
          status: 'inProgress',
          startedAt: ${now},
          completedAt: null,
          durationMs: null,
          items: [],
          diff: '',
          error: null,
        })
      }
      process.stdout.write('ready\\n')
      setInterval(() => {}, 60_000)
      `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let stderr = ''
    server.stderr.setEncoding('utf8')
    server.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    await Promise.race([
      once(server.stdout, 'data'),
      once(server, 'exit').then(() => {
        throw new Error(`the other server exited early: ${stderr}`)
      }),
    ])

    const db = new DatabaseSync(path)
    try {
      const owner = db
        .prepare('SELECT owner_pid, owner_started FROM turns WHERE id = ?')
        .get(turns.live) as { owner_pid: number; owner_started: string }
      assert.equal(owner.owner_pid, server.pid)
      assert.ok(owner.owner_started)
      db.prepare('UPDATE turns SET owner_started = ? WHERE id = ?').run(
        'Thu Jan  1 00:00:00 1970',
        turns.reused,
      )
      db.prepare('UPDATE turns SET owner_pid = NULL, owner_started = NULL WHERE id = ?').run(
        turns.legacy,
      )
    } finally {
      db.close()
    }

    const second = new SessionStore(path)
    try {
      assert.equal(second.recoverStaleInProgressTurns(), 2)
      assert.equal(second.getTurn(turns.live)?.status, 'inProgress')
      assert.equal(second.getThread(threads.live)?.status.type, 'active')
      for (const key of ['reused', 'legacy'] as const) {
        assert.equal(second.getTurn(turns[key])?.status, 'interrupted')
        assert.equal(second.getThread(threads[key])?.status.type, 'idle')
      }

      server.kill('SIGKILL')
      await waitForExit(server, 2000)
      assert.equal(server.signalCode, 'SIGKILL')
      assert.equal(second.recoverStaleInProgressTurns(), 1)
      assert.equal(second.getTurn(turns.live)?.status, 'interrupted')
      assert.equal(second.getThread(threads.live)?.status.type, 'idle')
    } finally {
      second.close()
    }
  } finally {
    if (server) await stopProcess(server)
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server proxy forwards websocket handshake bytes to unix daemon', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const proxy = spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    await waitForStderr(daemon, /listening on/)
    const stdout = new TextCollector(proxy)
    proxy.stdin?.write(
      [
        'GET / HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )
    await stdout.waitFor(/101 Switching Protocols/)
  } finally {
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the daemon and the proxy meet at CLAUDE_CODEX_SOCKET_PATH without a path argument', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  // Started as the App starts them: `--listen unix://` and `proxy`, no path.
  const env = {
    ...process.env,
    CODEX_HOME: home,
    CLAUDE_CODEX_SOCKET_PATH: sock,
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  }
  const daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', 'unix://'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  let proxy: ChildProcess | null = null
  try {
    await waitForStderr(daemon, /listening on/)
    assert.equal(existsSync(sock), true)
    assert.equal(existsSync(join(home, 'app-server-control')), false)
    proxy = spawn(process.execPath, [adapter, 'app-server', 'proxy'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    const stdout = new TextCollector(proxy)
    proxy.stdin?.write(
      [
        'GET / HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )
    await stdout.waitFor(/101 Switching Protocols/)
  } finally {
    proxy?.stdin?.end()
    await Promise.all([proxy ? stopProcess(proxy) : null, stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(`${sock}.pid`, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server proxy carries websocket JSON-RPC traffic over stdio', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const proxy = spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'proxy-test', title: 'Proxy Test', version: '0' },
          capabilities: null,
        },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('remote shim launches daemon and proxy with Codex-compatible commands', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      // The shim sources a runtime env; keep the developer's own out of it.
      CLAUDE_CODEX_RUNTIME_ENV: join(home, 'runtime.env'),
      CLAUDE_CODEX_ADAPTER: adapter,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const proxy = spawn(shim, ['app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      // The shim sources a runtime env; keep the developer's own out of it.
      CLAUDE_CODEX_RUNTIME_ENV: join(home, 'runtime.env'),
      CLAUDE_CODEX_ADAPTER: adapter,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'shim-test', title: 'Shim Test', version: '0' },
          capabilities: null,
        },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response?.result?.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server --print-startup-config prints one JSON line without opening the state database', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CODEX_COMPAT_VERSION: '0.164.0-alpha.6',
    NODE_NO_WARNINGS: '1',
  }
  delete env.CODEX_HOME
  delete env.CLAUDE_CODEX_HOME
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [adapter, 'app-server', ...args], {
      env,
      encoding: 'utf8',
      timeout: 15_000,
    })
  let proc: ChildProcessWithoutNullStreams | null = null
  try {
    const clientInfo = JSON.stringify({ name: 'codex_desktop', title: null, version: '26.1013.0' })
    for (const args of [
      ['--print-startup-config'],
      ['--print-startup-config', '--startup-sign-out', '--startup-client-info', clientInfo],
      [`--startup-client-info=${clientInfo}`, '--print-startup-config'],
    ]) {
      const result = run(...args)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /^[^\n]+\n$/)
      assert.deepEqual(JSON.parse(result.stdout), {
        appServerVersion: '0.164.0-alpha.6',
        configRequirements: { requirements: null },
      })
    }
    // Usage errors, as codex reports them: stderr only.
    for (const [args, status] of [
      [['--print-startup-config', '--listen', 'stdio://'], 2],
      [['--startup-sign-out'], 2],
      [['--print-startup-config', '--startup-client-info', '{"name":"codex_desktop"}'], 2],
      [['--print-startup-config', 'daemon', 'version'], 1],
    ] as const) {
      const result = run(...args)
      assert.equal(result.status, status, args.join(' '))
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /^error: /)
    }
    // Nothing under HOME: no Codex home, state database or debug log.
    assert.deepEqual(await readdir(home), [])

    // configRequirements/read on a running server answers the same.
    proc = spawnMockAdapter(join(home, 'server'))
    const reader = new JsonLineReader(proc)
    proc.stdin.write(json({ id: 1, method: 'configRequirements/read', params: {} }))
    assert.deepEqual((await reader.nextResponse(1)).result, { requirements: null })
  } finally {
    if (proc) await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server daemon version reports the unix daemon on the control socket, and fails without one', {
  timeout: 30_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    CLAUDE_CODEX_COMPAT_VERSION: '0.163.0',
    NODE_NO_WARNINGS: '1',
  }
  delete env.CLAUDE_CODEX_HOME
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [adapter, 'app-server', 'daemon', ...args], {
      env,
      encoding: 'utf8',
      timeout: 15_000,
    })
  let daemon: ChildProcess | null = null
  try {
    // No daemon: fail at once, as codex does, so the App starts its own
    // server, and leave the state dir alone.
    const missing = run('version')
    assert.equal(missing.status, 1)
    assert.equal(missing.stdout, '')
    assert.match(missing.stderr, /no app-server daemon is running/)
    const unsupported = run('start')
    assert.equal(unsupported.status, 1)
    assert.equal(unsupported.stdout, '')
    assert.deepEqual(await readdir(home), [])

    const socketPath = join(home, 'app-server-control', 'app-server-control.sock')
    // The daemon moves its socket elsewhere when this path is too long for
    // one, as under a deep temp dir; the App would not find it there either.
    if (socketPath.length > 100) {
      t.skip('the temp dir is too deep for a unix socket at the control path')
      return
    }
    daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', 'unix://'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    })
    await waitForStderr(daemon, /listening on/)
    const running = run('version')
    assert.equal(running.status, 0, running.stderr)
    assert.match(running.stdout, /^[^\n]+\n$/)
    assert.deepEqual(JSON.parse(running.stdout), {
      status: 'running',
      socketPath,
      appServerVersion: '0.163.0',
    })
    // The shim leaves a socket that exists to the adapter to check.
    const shimmed = spawnSync(shim, ['app-server', 'daemon', 'version'], {
      env: {
        ...env,
        CLAUDE_CODEX_RUNTIME_ENV: join(home, 'runtime.env'),
        CLAUDE_CODEX_ADAPTER: adapter,
      },
      encoding: 'utf8',
      timeout: 15_000,
    })
    assert.equal(shimmed.status, 0, shimmed.stderr)
    assert.equal(shimmed.stdout, running.stdout)
    assert.equal(daemon.exitCode, null)
  } finally {
    if (daemon) await stopProcess(daemon)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the shim answers one-shot probes without node, and leaves them to a native codex', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-'))
  const realCodex = join(home, 'real-codex')
  await writeFile(realCodex, '#!/bin/sh\nprintf "real codex: %s\\n" "$*"\n')
  await chmod(realCodex, 0o755)
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: join(home, 'codex'),
    // The shim sources a runtime env; keep the developer's own out of it.
    CLAUDE_CODEX_RUNTIME_ENV: join(home, 'runtime.env'),
    // No adapter: what the shim answers, it answers without starting node.
    CLAUDE_CODEX_ADAPTER: join(home, 'missing-adapter.mjs'),
    CLAUDE_CODEX_COMPAT_VERSION: '0.164.0-alpha.6',
    NODE_NO_WARNINGS: '1',
  }
  for (const key of ['CLAUDE_CODEX_ROUTE', 'CLAUDE_CODEX_RUNTIME_TYPE', 'CODEX_REAL'])
    delete base[key]
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(shim, ['app-server', ...args], {
      env: { ...base, ...env },
      encoding: 'utf8',
      timeout: 15_000,
    })
  const line = '{"appServerVersion":"0.164.0-alpha.6","configRequirements":{"requirements":null}}\n'
  try {
    for (const args of [
      ['--print-startup-config'],
      ['--startup-sign-out', '--print-startup-config'],
    ]) {
      const result = run(args)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, line)
      assert.equal(result.stderr, '')
    }
    const missing = run(['daemon', 'version'])
    assert.equal(missing.status, 1)
    assert.equal(missing.stdout, '')
    assert.equal(
      missing.stderr,
      `Error: no app-server daemon is running at ${join(home, 'codex', 'app-server-control', 'app-server-control.sock')}\n`,
    )
    assert.equal(existsSync(join(home, 'codex')), false)

    // The adapter answers what the shim does not settle.
    const clientInfo = JSON.stringify({ name: 'codex_desktop', version: '26.1013.0' })
    const withAdapter = { CLAUDE_CODEX_ADAPTER: adapter }
    const described = run(
      ['--print-startup-config', '--startup-client-info', clientInfo],
      withAdapter,
    )
    assert.equal(described.status, 0, described.stderr)
    assert.equal(described.stdout, line)
    const quoted = run(['--print-startup-config'], {
      ...withAdapter,
      CLAUDE_CODEX_COMPAT_VERSION: '0.164.0 "x"',
    })
    assert.equal(quoted.status, 0, quoted.stderr)
    assert.equal(JSON.parse(quoted.stdout).appServerVersion, '0.164.0 "x"')
    const conflict = run(['--print-startup-config', '--listen', 'stdio://'], withAdapter)
    assert.equal(conflict.status, 2)
    assert.equal(conflict.stdout, '')
    assert.equal(existsSync(join(home, 'codex')), false)

    // A native codex gets them unchanged.
    const native = { CLAUDE_CODEX_ROUTE: 'codex', CODEX_REAL: realCodex }
    for (const args of [
      ['--print-startup-config', '--startup-sign-out'],
      ['daemon', 'version'],
    ]) {
      const result = run(args, native)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, `real codex: app-server ${args.join(' ')}\n`)
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

class WebSocketJsonReader {
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
  }

  next(): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async nextResponse(id: number): Promise<any> {
    for (;;) {
      const msg = await this.next()
      if (msg.id === id && msg.method == null) return msg
    }
  }
}

class TextCollector {
  private text = ''
  private waiters: Array<() => void> = []

  constructor(proc: ChildProcess) {
    if (!proc.stdout) throw new Error('test process has no stdout')
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.text += chunk
      for (const waiter of this.waiters.splice(0)) waiter()
    })
  }

  async waitFor(pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 5000
    while (!pattern.test(this.text)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${pattern}; saw: ${this.text}`)
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error(`timed out waiting for ${pattern}; saw: ${this.text}`))
        }, remaining)
        this.waiters.push(waiter)
      })
    }
  }
}

class ChildProcessDuplex extends Duplex {
  private readonly proc: ChildProcess

  constructor(proc: ChildProcess) {
    super()
    this.proc = proc
    if (!proc.stdin || !proc.stdout) throw new Error('proxy process needs stdin/stdout')
    proc.stdout.on('data', (chunk) => this.push(chunk))
    proc.stdout.on('end', () => this.push(null))
    proc.on('exit', () => this.push(null))
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.proc.stdin?.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.proc.stdin?.end()
    callback()
  }
}

// Opens a read transaction on the adapter's state database, the way a backup
// or a sqlite3 shell would. Until the returned release runs, the adapter
// cannot commit a write.
function holdStateDatabase(path: string): () => void {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 2_000 })
  db.exec('BEGIN')
  db.prepare('SELECT count(*) FROM turns').get()
  return () => {
    db.exec('COMMIT')
    db.close()
  }
}

async function startLockTestThread(proc: ChildProcess, reader: JsonLineReader): Promise<string> {
  proc.stdin?.write(
    json({
      id: 1,
      method: 'thread/start',
      params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
    }),
  )
  const start = await reader.nextResponse(1)
  return start.result.thread.id
}

// The mock streams the echoed prompt one character at a time, so a long
// prompt keeps the turn writing for a while.
async function startLockTestTurn(
  proc: ChildProcess,
  reader: JsonLineReader,
  threadId: string,
  id: number,
  text: string,
): Promise<string> {
  proc.stdin?.write(
    json({
      id,
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: `${text} ${'x'.repeat(300)}`, text_elements: [] }],
      },
    }),
  )
  const started = await reader.nextResponse(id)
  assert.equal(started.error, undefined)
  return started.result.turn.id
}

async function nextTurnCompleted(
  reader: JsonLineReader,
  turnId: string,
): Promise<{ completed: any; methods: string[] }> {
  const methods: string[] = []
  for (let i = 0; i < 5_000; i += 1) {
    const message = await reader.next()
    if (message.method == null) continue
    methods.push(message.method)
    if (message.method === 'turn/completed' && message.params.turn.id === turnId)
      return { completed: message.params.turn, methods }
  }
  throw new Error(`turn/completed never arrived for ${turnId}`)
}

function terminateWebSocket(ws: WebSocket | null): void {
  if (!ws || ws.readyState === WebSocket.CLOSED) return
  ws.on('error', () => {})
  ws.terminate()
}

async function waitForStderr(proc: ChildProcess, pattern: RegExp): Promise<void> {
  if (!proc.stderr) throw new Error('test process has no stderr')
  proc.stderr.setEncoding('utf8')
  let acc = ''
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
    }
    const onData = (chunk: string) => {
      acc += String(chunk)
      if (pattern.test(acc)) {
        cleanup()
        resolve()
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`process exited before stderr matched ${pattern}; saw: ${acc}`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      proc.kill()
      reject(new Error(`timed out waiting for stderr ${pattern}; saw: ${acc}`))
    }, 5000)
    proc.stderr?.on('data', onData)
    proc.once('exit', onExit)
  })
}
