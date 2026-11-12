import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionStore } from '../src/store.mjs'
import type { TurnRecord } from '../src/types.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

const fixture = resolve('dist/test/fixtures/cross-process-turn-server.mjs')

interface FixtureClient {
  proc: ChildProcessWithoutNullStreams
  messages: any[]
  stderr: string
  nextId: number
}

test('two adapter processes exclude duplicate turns and recover a crashed owner', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-process-turn-'))
  const a = spawnTurnServer(home, true)
  let b: FixtureClient | null = null
  try {
    const started = await call(a, 'thread/start', {
      cwd: process.cwd(),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    assert.equal(started.error, undefined, started.error?.message)
    const threadId = started.result.thread.id as string

    b = spawnTurnServer(home, false)
    const resumed = await call(b, 'thread/resume', { threadId })
    assert.equal(resumed.error, undefined, resumed.error?.message)

    const first = await call(a, 'turn/start', {
      threadId,
      input: textInput('first process owns the turn'),
    })
    assert.equal(first.error, undefined, first.error?.message)
    const firstTurnId = first.result.turn.id as string
    await waitFor(() => readModelRuns(home).length === 1, 'the first model run')

    const rejected = await call(b, 'turn/start', {
      threadId,
      input: textInput('duplicate from the second process'),
    })
    assert.ok(rejected.error, 'the second process must reject the duplicate turn')
    assert.match(rejected.error.message, /another adapter process/)
    assert.equal(rejected.result, undefined)
    assert.equal(readModelRuns(home).length, 1, 'the second process never ran the model')
    assert.equal(
      b.messages.some((message) => message.method === 'turn/started'),
      false,
      'the rejected request emitted no turn lifecycle',
    )

    let store = new SessionStore(join(home, 'state.sqlite'))
    try {
      const turns = store.listTurns(threadId)
      assert.equal(turns.length, 1, 'the rejected request persisted no second turn')
      assert.equal(store.getThread(threadId)?.status.type, 'active')
      assert.equal(turns[0]?.id, firstTurnId)
      assert.equal(
        turns[0]?.items.filter((item) => item.type === 'userMessage').length,
        1,
        'the user item was persisted exactly once',
      )
    } finally {
      store.close()
    }

    a.proc.kill('SIGKILL')
    await once(a.proc, 'exit')
    assert.equal(a.proc.signalCode, 'SIGKILL')

    const recovered = await call(b, 'turn/start', {
      threadId,
      input: textInput('replacement after the owner crash'),
    })
    assert.equal(recovered.error, undefined, recovered.error?.message)
    const recoveredTurnId = recovered.result.turn.id as string
    assert.notEqual(recoveredTurnId, firstTurnId)
    await waitFor(
      () =>
        b?.messages.find(
          (message) =>
            message.method === 'turn/completed' && message.params.turn.id === recoveredTurnId,
        ),
      'the recovered turn to complete',
    )

    const runs = readModelRuns(home)
    assert.equal(runs.length, 2, 'one crashed run and one recovered run, with no duplicate')
    assert.deepEqual(
      runs.map((run) => run.turnId),
      [firstTurnId, recoveredTurnId],
    )

    store = new SessionStore(join(home, 'state.sqlite'))
    try {
      const turns = store.listTurns(threadId)
      assert.equal(turns.length, 2, 'the rejected request remains absent after recovery')
      assert.equal(turns.find((turn) => turn.id === firstTurnId)?.status, 'interrupted')
      assert.match(
        String((turns.find((turn) => turn.id === firstTurnId)?.error as any)?.message),
        /owner exited/,
      )
      assert.equal(turns.find((turn) => turn.id === recoveredTurnId)?.status, 'completed')
      assert.equal(
        turns.some((turn) => turn.status === 'inProgress'),
        false,
      )
      const userTexts = userMessageTexts(turns)
      assert.deepEqual(
        new Set(userTexts),
        new Set(['first process owns the turn', 'replacement after the owner crash']),
      )
    } finally {
      store.close()
    }
  } finally {
    await writeFile(join(home, 'release-turn'), 'release', { flag: 'w' }).catch(() => {})
    await Promise.all([stopProcess(a), ...(b ? [stopProcess(b)] : [])])
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('pipelined in-process turn starts still join the first turn', async () => {
  let modelRuns = 0
  let release = (): void => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const runtime = scriptedRuntime(
    async (_context, handlers) => {
      modelRuns += 1
      await handlers.onEvent({ type: 'text_delta', delta: 'holding' })
      await released
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    {
      steer: async (_threadId, _prompt, options) => {
        options?.onAccepted?.()
        release()
        return true
      },
    },
  )
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const [first, pipelined] = await Promise.all([
      app.call('turn/start', { threadId, input: textInput('first pipelined input') }),
      app.call('turn/start', { threadId, input: textInput('second pipelined input') }),
    ])
    assert.equal(first.error, undefined, JSON.stringify(first.error))
    assert.equal(pipelined.error, undefined, JSON.stringify(pipelined.error))
    const turnId = first.result.turn.id as string
    assert.equal(pipelined.result.turn.id, turnId)
    await app.turnCompleted(turnId)
    assert.equal(modelRuns, 1)
    const turns = app.store.listTurns(threadId)
    assert.equal(turns.length, 1)
    const userTexts = userMessageTexts(turns)
    assert.deepEqual(userTexts, ['first pipelined input', 'second pipelined input'])
  })
})

function spawnTurnServer(home: string, hold: boolean): FixtureClient {
  const proc = spawn(process.execPath, [fixture], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODEX_HOME: home,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_TEST_HOME: home,
      CLAUDE_CODEX_TEST_HOLD_TURN: hold ? '1' : '0',
      NODE_NO_WARNINGS: '1',
    },
  })
  const client: FixtureClient = { proc, messages: [], stderr: '', nextId: 1 }
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) client.messages.push(JSON.parse(line))
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    client.stderr += chunk
  })
  return client
}

async function call(
  client: FixtureClient,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const id = client.nextId++
  client.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return await waitFor(
    () => client.messages.find((message) => message.id === id && message.method === undefined),
    `${method} response`,
    client,
  )
}

async function waitFor<T>(
  find: () => T | undefined,
  description: string,
  client?: FixtureClient,
): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const value = find()
    if (value !== undefined) return value
    if (client && (client.proc.exitCode !== null || client.proc.signalCode !== null)) {
      throw new Error(`fixture exited while waiting for ${description}: ${client.stderr}`)
    }
    await delay(10)
  }
  throw new Error(`timed out waiting for ${description}${client ? `: ${client.stderr}` : ''}`)
}

function readModelRuns(home: string): Array<{ pid: number; threadId: string; turnId: string }> {
  const path = join(home, 'model-runs.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function userMessageTexts(turns: TurnRecord[]): string[] {
  return turns
    .flatMap((turn) => turn.items)
    .flatMap((item) => {
      if (item.type !== 'userMessage') return []
      const input = item.content[0]
      return input?.type === 'text' ? [input.text] : []
    })
}

function textInput(text: string): unknown[] {
  return [{ type: 'text', text, text_elements: [] }]
}

async function stopProcess(client: FixtureClient): Promise<void> {
  const proc = client.proc
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  proc.kill()
  const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)])
  if (stopped) return
  const killed = once(proc, 'exit')
  proc.kill('SIGKILL')
  await killed
}
