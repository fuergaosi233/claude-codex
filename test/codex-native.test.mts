import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The native Codex harness: Codex threads run in a real `codex app-server`
// child, here a fake one that answers like codex and logs what it hears.

const adapter = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const FAKE_CODEX = `
const fs = require('node:fs')
const provider = (process.argv.find((arg) => arg.startsWith('model_provider=')) || '').slice(15).replace(/"/g, '')
const log = (entry) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ provider, ...entry }) + '\\n')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const models = new Map()
const waiting = new Map()
let next = 0
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
function handle(message) {
  log(message)
  if (message.method === undefined) {
    const resume = waiting.get(message.id)
    if (resume) { waiting.delete(message.id); resume(message.result) }
    return
  }
  const p = message.params || {}
  const reply = (result) => send({ id: message.id, result })
  switch (message.method) {
    case 'initialize': return reply({ userAgent: 'fake' })
    case 'initialized': return
    case 'thread/start': {
      const id = provider + '-thread-' + (++next)
      models.set(id, p.model)
      send({ method: 'thread/started', params: { thread: { id, modelProvider: provider } } })
      return reply({ thread: { id, modelProvider: provider, turns: [] }, model: p.model, modelProvider: provider })
    }
    case 'thread/resume':
      return reply({ thread: { id: p.threadId, modelProvider: provider, turns: [{ id: 'turn-old' }] }, model: models.get(p.threadId) || 'unknown', modelProvider: provider })
    case 'thread/settings/update':
      if (p.model) models.set(p.threadId, p.model)
      return reply({})
    case 'turn/start': {
      const turnId = 'turn-' + (++next)
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } })
      send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } })
      const requestId = 900 + next
      waiting.set(requestId, (result) => {
        send({ method: 'serverRequest/resolved', params: { threadId: p.threadId, requestId } })
        const text = provider + ':' + models.get(p.threadId) + ':' + (result && result.decision)
        send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId, itemId: 'm1', delta: text } })
        send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed', items: [] } } })
      })
      send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, turnId, itemId: 'c1', command: 'ls' } })
      return
    }
    default: return reply({})
  }
}
`

class Reader {
  private buffer = ''
  private readonly queue: any[] = []
  private waiter: ((value: any) => void) | null = null
  constructor(proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.push(JSON.parse(line))
        newline = this.buffer.indexOf('\n')
      }
    })
  }
  private push(message: any): void {
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter(message)
    } else this.queue.push(message)
  }
  next(): Promise<any> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message within 10s')), 10_000)
      this.waiter = (message) => {
        clearTimeout(timer)
        resolve(message)
      }
    })
  }
  // Messages a wait passed over, for later waits: a notification can come
  // before the response of the request that caused it.
  private readonly passed: any[] = []
  async until(done: (message: any) => boolean, seen: any[] = []): Promise<any> {
    const index = this.passed.findIndex(done)
    if (index >= 0) {
      seen.push(...this.passed.slice(0, index + 1))
      return this.passed.splice(index, 1)[0]
    }
    for (let i = 0; i < 500; i += 1) {
      const message = await this.next()
      seen.push(message)
      if (done(message)) return message
      this.passed.push(message)
    }
    throw new Error('expected message never arrived')
  }
}

function startAdapter() {
  const home = mkdtempSync(join(tmpdir(), 'codex-native-'))
  dirs.push(home)
  const script = join(home, 'fake-codex.cjs')
  writeFileSync(script, FAKE_CODEX)
  const binary = join(home, 'codex')
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(binary, 0o755)
  const log = join(home, 'fake.log')
  writeFileSync(log, '')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_NATIVE_CODEX: 'on',
      CLAUDE_CODEX_CODEX_MODELS: 'gpt-6.1-sol',
      CLAUDE_CODEX_CODEX_AG_MODELS: 'claude-opus-5-5',
      CODEX_REAL: binary,
      FAKE_CODEX_LOG: log,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new Reader(proc)
  let id = 0
  const request = async (method: string, params: unknown) => {
    id += 1
    const requestId = id
    proc.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
    return reader.until((message) => message.id === requestId && message.method === undefined)
  }
  const childLog = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { proc, reader, request, childLog, home }
}

async function initialize(app: ReturnType<typeof startAdapter>) {
  await app.request('initialize', {
    clientInfo: { name: 'codex_desktop', version: '26.1013.40934' },
    capabilities: { experimentalApi: true },
  })
}

// Runs a turn on the thread, answering the child's approval with `decision`.
async function runTurn(
  app: ReturnType<typeof startAdapter>,
  threadId: string,
  decision: string,
  extra: Record<string, unknown> = {},
) {
  const started = await app.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'hello' }],
    ...extra,
  })
  assert.equal(started.error, undefined, JSON.stringify(started.error))
  const seen: any[] = []
  const approval = await app.reader.until(
    (message) => message.method?.endsWith('requestApproval'),
    seen,
  )
  app.proc.stdin.write(`${JSON.stringify({ id: approval.id, result: { decision } })}\n`)
  await app.reader.until((message) => message.method === 'turn/completed', seen)
  return { approval, seen }
}

test('model/list offers the three harnesses', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const list = await app.request('model/list', {})
    const entries = list.result.data as Array<{ id: string; displayName: string }>
    assert.ok(entries.some((entry) => entry.displayName.startsWith('Claude Code · ')))
    assert.ok(
      entries.some(
        (entry) => entry.id === 'gpt-6.1-sol' && entry.displayName.startsWith('Codex · '),
      ),
    )
    assert.ok(
      entries.some(
        (entry) =>
          entry.id === 'codex-ag:claude-opus-5-5' &&
          entry.displayName.startsWith('Codex+AsterGate · '),
      ),
    )
  } finally {
    app.proc.kill()
  }
})

test('a Codex+AsterGate chat runs in the child on its provider, approvals round-trip', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', {
      model: 'codex-ag:claude-opus-5-5',
      cwd: app.home,
    })
    const threadId = started.result.thread.id as string
    const { approval, seen } = await runTurn(app, threadId, 'accept')
    assert.match(String(approval.id), /^cx:astergate_claude:\d+:\d+$/)
    assert.equal(approval.params.threadId, threadId)
    const delta = seen.find((message) => message.method === 'item/agentMessage/delta')
    assert.equal(delta.params.threadId, threadId)
    assert.equal(delta.params.delta, 'astergate_claude:claude-opus-5-5:accept')
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'serverRequest/resolved' && message.params.requestId === approval.id,
      ),
    )

    const childStart = app.childLog().find((entry) => entry.method === 'thread/start')
    assert.equal(childStart.provider, 'astergate_claude')
    assert.equal(childStart.params.model, 'claude-opus-5-5')

    const resumed = await app.request('thread/resume', { threadId })
    assert.equal(resumed.result.thread.id, threadId)
    assert.equal(resumed.result.model, 'codex-ag:claude-opus-5-5')
    assert.equal(resumed.result.modelProvider, 'claude-code')
  } finally {
    app.proc.kill()
  }
})

test('a GPT chat runs in the ChatGPT child', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', { model: 'gpt-6.1-sol', cwd: app.home })
    const threadId = started.result.thread.id as string
    const { seen } = await runTurn(app, threadId, 'decline')
    const delta = seen.find((message) => message.method === 'item/agentMessage/delta')
    assert.equal(delta.params.delta, 'openai:gpt-6.1-sol:decline')
  } finally {
    app.proc.kill()
  }
})

test('a chat keeps its harness once it has a conversation; a new one can still move', async () => {
  const app = startAdapter()
  try {
    await initialize(app)
    const started = await app.request('thread/start', {
      model: 'codex-ag:claude-opus-5-5',
      cwd: app.home,
    })
    const threadId = started.result.thread.id as string
    await runTurn(app, threadId, 'accept')
    const toGpt = await app.request('thread/settings/update', { threadId, model: 'gpt-6.1-sol' })
    assert.equal(toGpt.error?.code, -32600)
    const toClaude = await app.request('thread/settings/update', {
      threadId,
      model: 'sonnet',
    })
    assert.equal(toClaude.error?.code, -32600)

    // A new chat's thread exists before its first message: the first turn's
    // model picks its harness.
    const fresh = await app.request('thread/start', { model: 'sonnet', cwd: app.home })
    const freshId = fresh.result.thread.id as string
    const { seen } = await runTurn(app, freshId, 'accept', { model: 'gpt-6.1-sol' })
    const delta = seen.find((message) => message.method === 'item/agentMessage/delta')
    assert.equal(delta.params.threadId, freshId)
    assert.equal(delta.params.delta, 'openai:gpt-6.1-sol:accept')
  } finally {
    app.proc.kill()
  }
})
