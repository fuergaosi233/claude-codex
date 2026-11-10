import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { delimiter, dirname } from 'node:path'
import { RpcError, SERVER_ERROR } from './host-methods.mjs'
import { debugLog, resolveCodexBinary } from './util.mjs'

// One real `codex app-server --listen stdio://` for one Codex model provider.
// The real codex runs a thread's turns on the provider of its own config, so
// a thread on the ChatGPT login (openai) and one on a custom provider need a
// process each: `-c model_provider=<id>` pins it.
//
// Requests go out with the child's own ids; its server requests (approvals,
// questions) and notifications go to the listener. The process starts on the
// first request, and a crash fails what was pending and is reported, so the
// bridge can end the turns it ran; the next request starts a new one.

export interface CodexChildListener {
  notification(provider: string, method: string, params: unknown): void
  serverRequest(provider: string, id: string | number, method: string, params: unknown): void
  exited(provider: string, generation: number, reason: string): void
}

export interface CodexChildOptions {
  // The App's clientInfo, passed on so codex reports the same originator.
  clientInfo: () => Record<string, unknown>
  // Extra `-c` overrides the App sent the adapter on its command line.
  configOverrides?: () => readonly string[]
  binary?: () => string | null
}

interface PendingChildRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class CodexAppServerChild {
  readonly provider: string
  private readonly listener: CodexChildListener
  private readonly options: CodexChildOptions
  private proc: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private pending = new Map<number, PendingChildRequest>()
  private nextId = 1
  private buffer = ''
  private stderrTail = ''
  generation = 0

  constructor(provider: string, listener: CodexChildListener, options: CodexChildOptions) {
    this.provider = provider
    this.listener = listener
    this.options = options
  }

  get running(): boolean {
    return this.proc !== null
  }

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted()
    return this.send(method, params)
  }

  // The answer to one of the child's server requests.
  respond(id: string | number, result: unknown, error?: { code: number; message: string }): void {
    const proc = this.proc
    if (!proc) return
    const message = error ? { id, error } : { id, result: result ?? null }
    proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  stop(): void {
    const proc = this.proc
    if (!proc) return
    this.proc = null
    this.failPending(`codex app-server (${this.provider}) stopped`)
    proc.stdin.end()
    proc.kill('SIGTERM')
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000)
    timer.unref()
    proc.once('exit', () => clearTimeout(timer))
  }

  private ensureStarted(): Promise<void> {
    if (this.proc && !this.starting) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async start(): Promise<void> {
    const binary = (this.options.binary ?? resolveCodexBinary)()
    if (!binary) throw new RpcError('no real codex binary found (set CODEX_REAL)')
    const args = [
      '-c',
      `model_provider=${JSON.stringify(this.provider)}`,
      ...(this.options.configOverrides?.() ?? []).flatMap((override) => ['-c', override]),
      'app-server',
      '--listen',
      'stdio://',
    ]
    const proc = spawn(binary, args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.generation += 1
    const generation = this.generation
    this.proc = proc
    this.buffer = ''
    this.stderrTail = ''
    debugLog('codexChild.spawn', { provider: this.provider, pid: proc.pid, generation })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    proc.on('error', (error) => this.onExit(proc, generation, error.message))
    proc.on('exit', (code, signal) =>
      this.onExit(proc, generation, `exited (${signal ?? code ?? 'unknown'})`),
    )
    // A broken pipe on a dying child shows up as its exit.
    proc.stdin.on('error', () => {})
    await this.send('initialize', {
      clientInfo: this.options.clientInfo(),
      capabilities: { experimentalApi: true },
    })
    proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc
    if (!proc)
      return Promise.reject(new RpcError(`codex app-server (${this.provider}) is not running`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const id = message.id as string | number | undefined
    const method = typeof message.method === 'string' ? message.method : null
    if (id !== undefined && method) {
      this.listener.serverRequest(this.provider, id, method, message.params)
      return
    }
    if (id !== undefined) {
      const pending = this.pending.get(Number(id))
      if (!pending) return
      this.pending.delete(Number(id))
      const error = message.error as { code?: number; message?: string; data?: unknown } | undefined
      if (error) {
        pending.reject(
          new RpcError(
            error.message ?? `${pending.method} failed`,
            error.data,
            error.code ?? SERVER_ERROR,
          ),
        )
      } else pending.resolve(message.result)
      return
    }
    if (method) this.listener.notification(this.provider, method, message.params)
  }

  private onExit(proc: ChildProcessWithoutNullStreams, generation: number, reason: string): void {
    if (this.proc !== proc) return
    this.proc = null
    const detail = this.stderrTail.trim().split('\n').slice(-3).join(' | ')
    debugLog('codexChild.exit', { provider: this.provider, generation, reason, stderr: detail })
    this.failPending(`codex app-server (${this.provider}) ${reason}`)
    this.listener.exited(this.provider, generation, reason)
  }

  private failPending(message: string): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new RpcError(message))
  }
}

// The child must reach the real codex, never this adapter's shim again: drop
// the shim's folder from PATH.
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const shimDir = process.env.CLAUDE_CODEX_SHIM_DIR
  const skip = new Set(
    [shimDir, process.env.HOME ? `${process.env.HOME}/.claude-codex/bin` : ''].filter(Boolean),
  )
  if (env.PATH)
    env.PATH = env.PATH.split(delimiter)
      .filter((entry) => !skip.has(entry) && !skip.has(dirname(`${entry}/x`)))
      .join(delimiter)
  delete env.CLAUDE_CODEX_ROUTE
  return env
}
