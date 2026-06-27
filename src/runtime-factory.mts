import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from './types.mjs'
import { MockRuntime } from './mock-runtime.mjs'
import { NativeClaudeRuntime } from './native-runtime.mjs'
import { HttpAgentRuntime } from './http-agent-runtime.mjs'
import { ClaudePTranscriptRuntime } from './claude-p-runtime.mjs'
import { CodexProxyRuntime } from './codex-proxy-runtime.mjs'
import {
  resolveRuntimeConfig,
  type RuntimeBackendType,
  type RuntimeConfig,
} from './runtime-config.mjs'
import { debugLog } from './util.mjs'

export function createRuntime(): ClaudeRuntime {
  const config = resolveRuntimeConfig()
  debugLog('runtime.create', {
    type: config.type,
    httpBaseUrl: config.http.baseUrl,
    claudePCommand: config.claudeP.command,
  })
  return new SelectableRuntime(config)
}

class SelectableRuntime implements ClaudeRuntime {
  private runtimes = new Map<RuntimeBackendType, ClaudeRuntime>()
  private activeRuntimeByThread = new Map<string, ClaudeRuntime>()
  private readonly config: RuntimeConfig

  constructor(config: RuntimeConfig) {
    this.config = config
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const requestedType = context.runtimeType ?? this.config.type
    if (shouldHandleLocally(requestedType, context)) {
      debugLog('runtime.turn.select', {
        threadId: context.threadId,
        turnId: context.turnId,
        purpose: context.purpose ?? 'normal',
        requestedType: context.runtimeType,
        selectedType: 'local-structured-summary',
        configuredType: requestedType,
        model: context.model,
        effort: context.effort,
      })
      await runLocalStructuredSummaryTurn(context, handlers)
      return
    }

    const runtime = this.runtimeFor(requestedType)
    debugLog('runtime.turn.select', {
      threadId: context.threadId,
      turnId: context.turnId,
      purpose: context.purpose ?? 'normal',
      requestedType: context.runtimeType,
      selectedType: requestedType,
      model: context.model,
      effort: context.effort,
    })
    this.activeRuntimeByThread.set(context.threadId, runtime)
    try {
      await runtime.runTurn(context, handlers)
    } finally {
      if (this.activeRuntimeByThread.get(context.threadId) === runtime) {
        this.activeRuntimeByThread.delete(context.threadId)
      }
    }
  }

  async steer(threadId: string, prompt: string): Promise<void> {
    const runtime = this.activeRuntimeByThread.get(threadId) ?? this.runtimeFor(this.config.type)
    await runtime.steer(threadId, prompt)
  }

  async interrupt(threadId: string): Promise<void> {
    const runtime = this.activeRuntimeByThread.get(threadId)
    if (runtime) {
      await runtime.interrupt(threadId)
      return
    }
    await Promise.allSettled([...this.runtimes.values()].map((entry) => entry.interrupt(threadId)))
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.stop()))
  }

  private runtimeFor(type: RuntimeBackendType): ClaudeRuntime {
    const existing = this.runtimes.get(type)
    if (existing) return existing
    const runtime = instantiateRuntime(this.config, type)
    this.runtimes.set(type, runtime)
    return runtime
  }
}

function shouldHandleLocally(type: RuntimeBackendType, context: RuntimeTurnContext): boolean {
  return context.purpose === 'summary' && (type === 'agent-http' || type === 'agentapi')
}

async function runLocalStructuredSummaryTurn(
  context: RuntimeTurnContext,
  handlers: RuntimeHandlers,
): Promise<void> {
  const text = JSON.stringify(
    coerceStructuredValue(schemaFromOutputFormat(context.outputFormat), context.prompt),
    null,
    0,
  )
  await handlers.onEvent({ type: 'text_delta', delta: text })
  await handlers.onEvent({ type: 'completed', success: true, result: 'local structured summary' })
}

function schemaFromOutputFormat(outputFormat: unknown): unknown {
  if (!outputFormat || typeof outputFormat !== 'object' || Array.isArray(outputFormat))
    return outputFormat
  const record = outputFormat as Record<string, unknown>
  return record.type === 'json_schema' && 'schema' in record ? record.schema : outputFormat
}

function coerceStructuredValue(schema: unknown, prompt: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return conciseStructuredString(prompt)
  const record = schema as Record<string, unknown>
  if (record.type === 'string') return conciseStructuredString(prompt)
  if (record.type === 'array') {
    const itemSchema =
      record.items && typeof record.items === 'object' && !Array.isArray(record.items)
        ? record.items
        : { type: 'string' }
    const values = prompt
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*\d.、)\s]+/, ''))
      .filter(Boolean)
    return (values.length > 0 ? values : prompt.trim() ? [prompt.trim()] : [])
      .slice(0, 10)
      .map((value) => coerceStructuredValue(itemSchema, value))
  }
  if (record.type !== 'object') return null
  const properties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(record.required)
    ? record.required.map(String)
    : Object.keys(properties)
  const result: Record<string, unknown> = {}
  for (const key of required) {
    result[key] = coerceStructuredValue(properties[key], prompt)
  }
  return result
}

function conciseStructuredString(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const source = lines.at(-1) ?? prompt.trim()
  const colon = Math.max(source.lastIndexOf('：'), source.lastIndexOf(':'))
  const value = colon >= 0 ? source.slice(colon + 1).trim() : source
  return value
    .replace(/^[-*\d.、)\s]+/, '')
    .slice(0, 80)
    .trim()
}

function instantiateRuntime(config: RuntimeConfig, type: RuntimeBackendType): ClaudeRuntime {
  switch (type) {
    case 'mock':
      return new MockRuntime()
    case 'agent-http':
    case 'agentapi':
      return new HttpAgentRuntime({ kind: type, ...config.http })
    case 'claude-p':
      return new ClaudePTranscriptRuntime(config.claudeP)
    case 'codex-proxy':
      return new CodexProxyRuntime()
    case 'agent-sdk-sidecar':
    default:
      return new NativeClaudeRuntime()
  }
}
