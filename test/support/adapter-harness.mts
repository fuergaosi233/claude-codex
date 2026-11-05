// Shared helpers for the adapter-*.test.mts suites. Each suite runs in its own
// node:test process, so the suites run in parallel. This file sits outside the
// dist/test/*.mjs glob, so npm test does not run it as a suite.
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const adapter = resolve('dist/src/adapter.mjs')

// The agent messages a thread's turn published, as their item/completed carried them.
export function completedAgentMessages(messages: any[], threadId: string): any[] {
  return messages
    .filter(
      (m) =>
        m.method === 'item/completed' &&
        m.params.threadId === threadId &&
        m.params.item.type === 'agentMessage',
    )
    .map((m) => m.params.item)
}

export async function readUntil(
  reader: JsonLineReader,
  stop: (message: any) => boolean,
  limit = 800,
): Promise<any[]> {
  const seen: any[] = []
  for (let i = 0; i < limit; i += 1) {
    const message = await reader.next()
    seen.push(message)
    if (stop(message)) return seen
  }
  throw new Error('readUntil: condition not met')
}

export function sendTurn(
  proc: ChildProcessWithoutNullStreams,
  id: number,
  threadId: string,
  text: string,
): void {
  proc.stdin.write(json({ id, method: 'turn/start', params: { threadId, input: textInput(text) } }))
}

// Runs one mock turn on a new thread and returns everything the adapter sent
// until it completed.
export async function mockTurnMessages(
  prompt: string,
  env: NodeJS.ProcessEnv = {},
  answer?: (request: any) => unknown,
): Promise<any[]> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, env)
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), permissions: ':workspace' },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({ id: 2, method: 'turn/start', params: { threadId, input: textInput(prompt) } }),
    )
    const seen: any[] = []
    await awaitMessage(
      reader,
      (message) => {
        if (message.method?.endsWith('/requestApproval') && message.id != null && answer)
          proc.stdin.write(json({ id: message.id, result: answer(message) }))
        return message.method === 'turn/completed'
      },
      seen,
    )
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    seen.push(await reader.nextResponse(3))
    return seen
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

export const completedItems = (seen: any[]): any[] =>
  seen
    .filter((message) => message.method === 'item/completed')
    .map((message) => message.params.item)

export function spawnMockAdapter(
  home: string,
  env: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  })
}

export async function awaitMessage(
  reader: JsonLineReader,
  done: (message: any) => boolean,
  seen: any[] = [],
): Promise<any> {
  for (let i = 0; i < 5000; i += 1) {
    const message = await reader.next()
    seen.push(message)
    if (done(message)) return message
  }
  throw new Error('expected message never arrived')
}

// Collects everything that arrives until the adapter stays quiet for `ms`.
export async function readQuiet(reader: JsonLineReader, ms: number): Promise<any[]> {
  const seen: any[] = []
  for (;;) {
    const message = await reader.nextWithin(ms)
    if (message == null) return seen
    seen.push(message)
  }
}

export async function startMockThread(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
): Promise<string> {
  proc.stdin.write(
    json({
      id: 1,
      method: 'thread/start',
      params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
    }),
  )
  const start = await reader.nextResponse(1)
  return start.result.thread.id
}

export function textInput(text: string): unknown[] {
  return [{ type: 'text', text, text_elements: [] }]
}

export class JsonLineReader {
  private buffer = ''
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(proc: ChildProcess) {
    if (!proc.stdout) throw new Error('test process has no stdout')
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.push(chunk))
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

  // Resolves null when nothing arrives within `ms`.
  nextWithin(ms: number): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const waiter = (value: any): void => {
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter)
        resolve(null)
      }, ms)
      this.waiters.push(waiter)
    })
  }

  private push(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    }
  }
}

export function json(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`
}

export async function nextNotification(
  reader: JsonLineReader,
  method: string,
): Promise<{ params: Record<string, unknown> }> {
  for (let i = 0; i < 50; i += 1) {
    const message = await reader.next()
    if (message.method === method) return { params: asTestRecord(message.params) }
  }
  throw new Error(`missing notification: ${method}`)
}

export function asTestRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode
  return await Promise.race([
    once(proc, 'exit').then(([code]) => code as number | null),
    delay(timeoutMs).then(() => null),
  ])
}

export async function stopProcess(proc: ChildProcess, timeoutMs = 2000): Promise<void> {
  const exited = (): boolean => proc.exitCode !== null || proc.signalCode !== null
  const wait = async (): Promise<boolean> => {
    if (exited()) return true
    return await Promise.race([
      once(proc, 'exit').then(() => true),
      delay(timeoutMs).then(() => false),
    ])
  }
  if (exited()) return
  proc.kill()
  if (await wait()) return
  proc.kill('SIGKILL')
  await wait()
}
