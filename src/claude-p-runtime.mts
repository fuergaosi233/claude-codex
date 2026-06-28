import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from './types.mjs'

export interface ClaudePRuntimeOptions {
  command: string
  extraArgs: string[]
  timeoutMs: number
  skipPermissions: boolean
  resume: boolean
  stopTimeoutRetries?: number
}

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task']

export class ClaudePTranscriptRuntime implements ClaudeRuntime {
  private active = new Map<string, ChildProcess>()
  private readonly options: ClaudePRuntimeOptions

  constructor(options: ClaudePRuntimeOptions) {
    this.options = options
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-'))
    const inputFile = join(tmp, 'prompt.txt')
    await writeFile(inputFile, context.prompt, 'utf8')

    try {
      if (context.imageInputs.length > 0) {
        await handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message:
            'claude-p runtime does not support direct multimodal attachments; sending the text prompt only.',
        })
      }

      const args = this.argsForContext(context, inputFile)
      const result = await this.runProcessWithRetry(context.threadId, args, context.cwd, handlers)
      const parsed = parseClaudePJson(result.stdout)
      const text = parsed?.result ?? result.stdout.trim()
      const sessionId = parsed?.sessionId
        ? `claude-p:${parsed.sessionId}`
        : (context.claudeSessionId ?? `claude-p:${context.threadId}`)

      await handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
      if (parsed?.usage) await handlers.onEvent({ type: 'usage', usage: parsed.usage })
      if (parsed?.metrics) await handlers.onEvent({ type: 'metrics', ...parsed.metrics })
      if (text) await handlers.onEvent({ type: 'text_delta', delta: text })

      const success = result.exitCode === 0 && parsed?.isError !== true
      await handlers.onEvent({
        type: 'completed',
        success,
        result: success
          ? text
          : result.stderr.trim() || text || `claude-p exited ${result.exitCode}`,
        claudeSessionId: sessionId,
      })
      if (!success)
        throw new Error(result.stderr.trim() || text || `claude-p exited ${result.exitCode}`)
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  async steer(): Promise<void> {
    throw new Error('claude-p runtime does not support turn/steer; start a new turn instead')
  }

  async interrupt(threadId: string): Promise<void> {
    const child = this.active.get(threadId)
    if (!child) return
    terminateProcessTree(child, 'SIGINT')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        terminateProcessTree(child, 'SIGTERM')
    }, 1500).unref()
  }

  async stop(): Promise<void> {
    for (const child of this.active.values()) terminateProcessTree(child, 'SIGTERM')
    this.active.clear()
  }

  private argsForContext(context: RuntimeTurnContext, inputFile: string): string[] {
    const args = [
      ...this.options.extraArgs,
      '--output-format',
      'json',
      '--cwd',
      context.cwd,
      '--input-file',
      inputFile,
    ]
    if (context.model) args.push('--model', context.model)
    // claude-p is most reliable as a `claude -p`-style one-shot wrapper.
    // Its current `--resume + --input-file` path can run the new prompt but
    // still emit the previous assistant result in stdout, so keep resume
    // opt-in until that upstream behavior is stable.
    const resume = this.options.resume ? claudePResumeId(context.claudeSessionId) : null
    if (resume && !context.forkSession) args.push('--resume', resume)
    const allowedTools = allowedToolsForContext(context)
    if (allowedTools) args.push('--allowedTools', allowedTools)
    if (
      this.options.skipPermissions ||
      context.approvalPolicy === 'never' ||
      context.sandboxMode === 'danger-full-access'
    ) {
      args.push('--dangerously-skip-permissions')
    }
    args.push('--timeout', String(Math.max(1, Math.ceil(this.options.timeoutMs / 1000))))
    return args
  }

  private runProcess(
    threadId: string,
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const child = spawn(this.options.command, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.active.set(threadId, child)
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    return new Promise((resolve, reject) => {
      let timedOut = false
      let killTimer: NodeJS.Timeout | null = null
      const timeout = setTimeout(() => {
        timedOut = true
        terminateProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            terminateProcessTree(child, 'SIGKILL')
        }, 1500).unref()
      }, this.options.timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        this.active.delete(threadId)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        this.active.delete(threadId)
        if (timedOut) {
          reject(new Error(`claude-p timed out after ${this.options.timeoutMs}ms`))
          return
        }
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })
    })
  }

  private async runProcessWithRetry(
    threadId: string,
    args: string[],
    cwd: string,
    handlers: RuntimeHandlers,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const attempts = 1 + Math.max(0, this.options.stopTimeoutRetries ?? 0)
    let last: { stdout: string; stderr: string; exitCode: number } | null = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let result: { stdout: string; stderr: string; exitCode: number }
      try {
        result = await this.runProcess(threadId, args, cwd)
      } catch (error) {
        if (isClaudePTimeoutError(error) && attempt < attempts) {
          await handlers.onEvent({
            type: 'notice',
            level: 'warning',
            message: `claude-p process timed out; retrying attempt ${attempt + 1}/${attempts}.`,
          })
          continue
        }
        throw error
      }
      if (!isClaudePStopTimeout(result) || attempt >= attempts) return result
      last = result
      await handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: `claude-p did not emit its Stop hook before timing out; retrying attempt ${attempt + 1}/${attempts}.`,
      })
    }
    return last ?? { stdout: '', stderr: 'claude-p retry exhausted', exitCode: 2 }
  }
}

function isClaudePStopTimeout(result: {
  stdout: string
  stderr: string
  exitCode: number
}): boolean {
  return result.stdout.trim() === '' && /(?:^|\b)StopTimeout(?:\b|$)/i.test(result.stderr)
}

function isClaudePTimeoutError(error: unknown): boolean {
  return error instanceof Error && /^claude-p timed out after \d+ms$/.test(error.message)
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const childPids = child.pid ? descendantPids(child.pid) : []
  for (const pid of childPids.reverse()) {
    killPid(pid, signal)
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  killPid(child.pid, signal)
}

function killPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(pid, signal)
  } catch {}
}

function descendantPids(rootPid: number): number[] {
  if (process.platform === 'win32') return []
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 })
    const children = new Map<number, number[]>()
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const pid = Number(parts[0])
      const ppid = Number(parts[1])
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      const siblings = children.get(ppid) ?? []
      siblings.push(pid)
      children.set(ppid, siblings)
    }
    const result: number[] = []
    const stack = [...(children.get(rootPid) ?? [])]
    while (stack.length > 0) {
      const pid = stack.pop()!
      result.push(pid)
      stack.push(...(children.get(pid) ?? []))
    }
    return result
  } catch {
    return []
  }
}

interface ParsedClaudePResult {
  result: string
  sessionId: string | null
  isError: boolean
  usage: Record<string, unknown> | null
  metrics: {
    durationMs: number | null
    apiDurationMs: number | null
    numTurns: number | null
    costUsd: number | null
  } | null
}

function parseClaudePJson(stdout: string): ParsedClaudePResult | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    const record = asRecord(parsed)
    return {
      result: typeof record.result === 'string' ? record.result : '',
      sessionId: typeof record.session_id === 'string' ? record.session_id : null,
      isError: record.is_error === true || record.subtype === 'error',
      usage: asOptionalRecord(record.usage),
      metrics: {
        durationMs: numberOrNull(record.duration_ms),
        apiDurationMs: numberOrNull(record.duration_api_ms),
        numTurns: numberOrNull(record.num_turns),
        costUsd: numberOrNull(record.total_cost_usd),
      },
    }
  } catch {
    return null
  }
}

function allowedToolsForContext(context: RuntimeTurnContext): string | null {
  if (context.sandboxMode === 'read-only') return READ_ONLY_TOOLS.join(',')
  return context.allowedTools && context.allowedTools.length > 0
    ? context.allowedTools.join(',')
    : null
}

function claudePResumeId(value: string | null): string | null {
  if (!value) return null
  if (value.startsWith('claude-p:')) return value.slice('claude-p:'.length)
  return value.includes(':') ? null : value
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
