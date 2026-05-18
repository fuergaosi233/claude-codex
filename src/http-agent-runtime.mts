import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from './types.mjs'
import { debugLog, sleep } from './util.mjs'

const execFileAsync = promisify(execFile)

export interface HttpAgentRuntimeOptions {
  kind: 'agent-http' | 'agentapi'
  baseUrl: string
  useSse: boolean
  pollIntervalMs: number
  timeoutMs: number
  sendInterruptRaw: boolean
  manageBridge: boolean
  modeCommand: string
}

interface ActiveRun {
  abort: AbortController
  baseUrl: string
}

interface AgentMessage {
  key: string
  role: string
  content: string
}

export class HttpAgentRuntime implements ClaudeRuntime {
  private active = new Map<string, ActiveRun>()
  private turnQueues = new Map<string, Promise<void>>()

  constructor(private options: HttpAgentRuntimeOptions) {}

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    await this.serializedRun(this.queueKeyForContext(context), () => this.runTurnLocked(context, handlers))
  }

  private async serializedRun<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const slot = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.turnQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => slot)
    this.turnQueues.set(key, next)
    await previous.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.turnQueues.get(key) === next) {
        this.turnQueues.delete(key)
      }
    }
  }

  private async runTurnLocked(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const abort = new AbortController()
    this.active.set(context.threadId, { abort, baseUrl: this.options.baseUrl })
    const tracker = new MessageDeltaTracker(this.options.kind)
    const startedAt = Date.now()
    let sseTask: Promise<void> | null = null
    let baseUrl = this.options.baseUrl
    let sessionId = `${this.options.kind}:${baseUrl}`

    try {
      baseUrl = await this.baseUrlForContext(context)
      sessionId = `${this.options.kind}:${baseUrl}`
      const active = this.active.get(context.threadId)
      if (active) active.baseUrl = baseUrl

      if (context.imageInputs.length > 0) {
        await handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message: `${this.options.kind} runtime does not support direct multimodal attachments; sending the text prompt only.`,
        })
      }

      const initialMessages = await this.fetchMessages(baseUrl, abort.signal)
      if (this.options.kind === 'agentapi' && hasAgentapiTrustPrompt(initialMessages)) {
        const message =
          'agentapi is waiting at Claude Code workspace trust prompt; run `claude-codex-mode trust` on the remote host after reviewing the path, then retry.'
        await handlers.onEvent({ type: 'notice', level: 'warning', message })
        throw new Error(message)
      }
      tracker.prime(initialMessages)
      await handlers.onEvent({ type: 'session', claudeSessionId: sessionId })

      const useSse = this.options.useSse && this.options.kind !== 'agentapi'
      if (useSse) {
        sseTask = this.listenEvents(baseUrl, tracker, handlers, abort.signal).catch(async (error) => {
          if (!abort.signal.aborted) {
            debugLog('http.sse.fallback', {
              kind: this.options.kind,
              baseUrl,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })
      }

      try {
        await this.postMessage(baseUrl, context.prompt, 'user', abort.signal)
      } catch (error) {
        if (this.options.kind === 'agentapi') {
          const latestMessages = await this.fetchMessages(baseUrl, abort.signal).catch(() => null)
          if (latestMessages && hasAgentapiTrustPrompt(latestMessages)) {
            throw new Error(
              'agentapi is waiting at Claude Code workspace trust prompt; run `claude-codex-mode trust` on the remote host after reviewing the path, then retry.',
            )
          }
        }
        throw error
      }

      while (Date.now() - startedAt < this.options.timeoutMs) {
        if (abort.signal.aborted) throw new Error('interrupted')
        const status = await this.fetchStatus(baseUrl, abort.signal)
        if (status === 'stable') break
        await this.pollMessages(baseUrl, tracker, handlers, abort.signal)
        await sleep(this.options.pollIntervalMs)
      }

      if (Date.now() - startedAt >= this.options.timeoutMs) {
        throw new Error(`${this.options.kind} turn timed out after ${this.options.timeoutMs}ms`)
      }

      await this.pollMessages(baseUrl, tracker, handlers, abort.signal)
      await handlers.onEvent({ type: 'completed', success: true, claudeSessionId: sessionId })
    } catch (error) {
      if (abort.signal.aborted) {
        await handlers.onEvent({ type: 'completed', success: false, result: 'interrupted', claudeSessionId: sessionId })
        return
      }
      await handlers.onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      abort.abort()
      this.active.delete(context.threadId)
      void sseTask
    }
  }

  async steer(_threadId: string, prompt: string): Promise<void> {
    await this.postMessage(this.active.get(_threadId)?.baseUrl ?? this.options.baseUrl, prompt, 'user')
  }

  async interrupt(threadId: string): Promise<void> {
    const active = this.active.get(threadId)
    if (this.options.sendInterruptRaw) {
      await this.postMessage(active?.baseUrl ?? this.options.baseUrl, '\u0003', 'raw').catch(() => {})
    }
    active?.abort.abort()
  }

  async stop(): Promise<void> {
    for (const active of this.active.values()) active.abort.abort()
    this.active.clear()
  }

  private queueKeyForContext(context: RuntimeTurnContext): string {
    if (!this.options.manageBridge || context.purpose === 'summary') return `${this.options.kind}\0${this.options.baseUrl}`
    return `${this.options.kind}\0${context.cwd}\0${context.model ?? ''}`
  }

  private async baseUrlForContext(context: RuntimeTurnContext): Promise<string> {
    if (!this.options.manageBridge) return this.options.baseUrl
    if (context.purpose === 'summary') return this.options.baseUrl
    const args = ['ensure-bridge', this.options.kind, context.model ?? '', context.cwd]
    debugLog('http.bridge.ensure.start', {
      kind: this.options.kind,
      cwd: context.cwd,
      model: context.model,
      command: this.options.modeCommand,
    })
    try {
      const { stdout, stderr } = await execFileAsync(this.options.modeCommand, args, {
        env: { ...process.env },
        timeout: 45_000,
        maxBuffer: 256 * 1024,
      })
      debugLog('http.bridge.ensure.done', {
        kind: this.options.kind,
        cwd: context.cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        baseUrl: parseBridgeBaseUrl(stdout) ?? this.options.baseUrl,
      })
      return parseBridgeBaseUrl(stdout) ?? this.options.baseUrl
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string; code?: unknown }
      debugLog('http.bridge.ensure.error', {
        kind: this.options.kind,
        cwd: context.cwd,
        error: err.message,
        code: err.code,
        stdout: err.stdout,
        stderr: err.stderr,
      })
      const detail = [err.message, err.stderr, err.stdout].filter(Boolean).join('\n')
      throw new Error(`${this.options.kind} bridge could not be prepared for ${context.cwd}: ${detail}`)
    }
  }

  private async pollMessages(baseUrl: string, tracker: MessageDeltaTracker, handlers: RuntimeHandlers, signal: AbortSignal): Promise<void> {
    const payload = await this.fetchMessages(baseUrl, signal)
    await tracker.emitPayload(payload, handlers)
  }

  private async postMessage(baseUrl: string, content: string, type: 'user' | 'raw', signal?: AbortSignal): Promise<void> {
    const response = await fetch(this.url(baseUrl, '/message'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, type }),
      signal,
    })
    if (!response.ok) {
      throw new Error(`${this.options.kind} POST /message failed ${response.status}: ${await response.text()}`)
    }
  }

  private async fetchMessages(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(this.url(baseUrl, '/messages'), { signal })
    if (!response.ok) {
      throw new Error(`${this.options.kind} GET /messages failed ${response.status}: ${await response.text()}`)
    }
    return response.json()
  }

  private async fetchStatus(baseUrl: string, signal?: AbortSignal): Promise<'running' | 'stable' | null> {
    const response = await fetch(this.url(baseUrl, '/status'), { signal })
    if (!response.ok) {
      throw new Error(`${this.options.kind} GET /status failed ${response.status}: ${await response.text()}`)
    }
    const record = asRecord(await response.json())
    return record.status === 'running' || record.status === 'stable' ? record.status : null
  }

  private async listenEvents(baseUrl: string, tracker: MessageDeltaTracker, handlers: RuntimeHandlers, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.url(baseUrl, '/events'), {
      headers: { accept: 'text/event-stream' },
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`GET /events failed ${response.status}: ${await response.text()}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser(async (eventName, data) => {
      let parsed: unknown = data
      try {
        parsed = JSON.parse(data)
      } catch {}
      if (eventName === 'message' || eventName === 'message_update') {
        await tracker.emitOne(parsed, handlers)
      } else if (eventName === 'agent_error') {
        const record = asRecord(parsed)
        await handlers.onEvent({
          type: 'notice',
          level: record.level === 'warning' ? 'warning' : 'error',
          message: String(record.message ?? 'agent error'),
        })
      }
    })

    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
  }

  private url(baseUrl: string, path: string): string {
    return `${baseUrl}${path}`
  }
}

function parseBridgeBaseUrl(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const explicit = line.match(/^CLAUDE_CODEX_BRIDGE_URL=(\S+)$/)
    if (explicit) return normalizeBaseUrl(explicit[1]!)
    const ready = line.match(/\bready at (https?:\/\/\S+)/)
    if (ready) return normalizeBaseUrl(ready[1]!)
  }
  return null
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

class MessageDeltaTracker {
  private priorText = new Map<string, string>()

  constructor(private kind: 'agent-http' | 'agentapi') {}

  prime(payload: unknown): void {
    for (const message of normalizeMessages(payload)) {
      this.priorText.set(message.key, this.sanitize(message.content))
    }
  }

  async emitPayload(payload: unknown, handlers: RuntimeHandlers): Promise<void> {
    for (const message of normalizeMessages(payload)) {
      await this.emitMessage(message, handlers)
    }
  }

  async emitOne(payload: unknown, handlers: RuntimeHandlers): Promise<void> {
    const message = normalizeMessage(payload, 0)
    if (message) await this.emitMessage(message, handlers)
  }

  private async emitMessage(message: AgentMessage, handlers: RuntimeHandlers): Promise<void> {
    const content = this.sanitize(message.content)
    if (!isAssistantRole(message.role) || !content) {
      this.priorText.set(message.key, content)
      return
    }
    const prior = this.priorText.get(message.key)
    if (prior == null) {
      this.priorText.set(message.key, content)
      await handlers.onEvent({ type: 'text_delta', delta: content })
      return
    }
    if (content === prior) return
    this.priorText.set(message.key, content)
    const delta = content.startsWith(prior) ? content.slice(prior.length) : `\n${content}`
    if (delta) await handlers.onEvent({ type: 'text_delta', delta })
  }

  private sanitize(content: string): string {
    return this.kind === 'agentapi' ? sanitizeAgentapiTerminalContent(content) : content
  }
}

class SseParser {
  private buffer = ''
  private eventName = 'message'
  private dataLines: string[] = []

  constructor(private onEvent: (eventName: string, data: string) => Promise<void>) {}

  push(chunk: string): void {
    this.buffer += chunk
    let lineEnd: number
    while ((lineEnd = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, lineEnd)
      this.buffer = this.buffer.slice(lineEnd + 1)
      void this.handleLine(raw.replace(/\r$/, '')).catch(() => {})
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (line === '') {
      if (this.dataLines.length > 0) {
        await this.onEvent(this.eventName, this.dataLines.join('\n'))
      }
      this.eventName = 'message'
      this.dataLines = []
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon >= 0 ? line.slice(0, colon) : line
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /, '') : ''
    if (field === 'event') this.eventName = value || 'message'
    else if (field === 'data') this.dataLines.push(value)
  }
}

function normalizeMessages(payload: unknown): AgentMessage[] {
  const record = asRecord(payload)
  const messages = Array.isArray(payload) ? payload : Array.isArray(record.messages) ? record.messages : []
  return messages.map((message, index) => normalizeMessage(message, index)).filter((message): message is AgentMessage => message != null)
}

function normalizeMessage(value: unknown, index: number): AgentMessage | null {
  const record = asRecord(value)
  const role = String(record.role ?? '')
  const content =
    typeof record.content === 'string'
      ? record.content
      : typeof record.message === 'string'
        ? record.message
        : typeof record.text === 'string'
          ? record.text
          : ''
  if (!role && !content) return null
  const id = record.id == null ? null : String(record.id)
  const time = typeof record.time === 'string' ? record.time : typeof record.timestamp === 'string' ? record.timestamp : null
  return { key: id ?? time ?? `${index}:${role}`, role, content }
}

function isAssistantRole(role: string): boolean {
  return role === 'assistant' || role === 'agent'
}

export function hasAgentapiTrustPrompt(payload: unknown): boolean {
  return normalizeMessages(payload).some((message) => {
    const content = message.content.toLowerCase()
    return (
      content.includes('quick safety check') ||
      content.includes('yes, i trust this folder') ||
      (content.includes('able to read, edit, and execute') && content.includes('security guide'))
    )
  })
}

export function sanitizeAgentapiTerminalContent(content: string): string {
  const withoutAnsi = content.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  if (/Claude Code v\d/i.test(withoutAnsi) && /Welcome back/i.test(withoutAnsi)) return ''
  if (/[╭╰─│]/.test(withoutAnsi) && /Tips for getting started|What's new|Run \/init/i.test(withoutAnsi)) return ''

  const kept: string[] = []
  let skipWrappedTip = false
  for (const rawLine of withoutAnsi.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/g, '')
    const trimmed = line.trim()
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('')
      skipWrappedTip = false
      continue
    }
    if (/Tip:\s*Run \/install-github-app/i.test(trimmed)) {
      skipWrappedTip = true
      continue
    }
    if (skipWrappedTip && /^and PRs\.?$/i.test(trimmed)) continue
    skipWrappedTip = false
    if (isAgentapiStatusLine(trimmed)) continue
    kept.push(line.replace(/^(\s*)●\s+/, '$1'))
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isAgentapiStatusLine(trimmed: string): boolean {
  const hasStatusMarker = /^[✻✢✶✳✽✼✺✹✸*•·+\-.]\s*/.test(trimmed)
  const text = trimmed.replace(/^[✻✢✶✳✽✼✺✹✸*•·+\-.]\s*/, '')
  if (hasStatusMarker && /(\.\.\.|…|for \d+s\b|[↑↓]\s*\d+\s+tokens|thinking\b)/i.test(text)) return true
  if (/^(Fluttering|Baked|Brewed|Cooked|Crunched|Churned|Sauteed|Sautéed|Worked|Working|Thinking|Pondering|Musing|Deciphering|Processing|Sublimating|Caramelizing|Slithering|Crunching|Churning|Running|Reading|Searching|Exploring|Editing|Waiting)\b/i.test(text)) {
    return /(\.\.\.|…|for \d+s\b)/i.test(text)
  }
  return false
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
