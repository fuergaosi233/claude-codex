import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { adapterHome, ensureParent } from './util.mjs'

export type RunRegistryEventName =
  | 'thread.started'
  | 'thread.resumed'
  | 'thread.forked'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'subagent.spawned'
  | 'subagent.completed'

export interface RunRegistryWriteResult {
  readonly ok: boolean
  readonly path: string | null
  readonly error: string | null
}

export function runRegistryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CLAUDE_CODEX_RUN_LOG
  if (configured === '0' || configured === 'false') return null
  return resolve(configured || join(adapterHome(), 'runs.jsonl'))
}

export function recordRunEvent(
  event: RunRegistryEventName,
  data: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): RunRegistryWriteResult {
  const path = runRegistryPath(env)
  if (!path) return { ok: true, path: null, error: null }
  try {
    ensureParent(path)
    appendFileSync(path, `${JSON.stringify(runRegistryEntry(event, data))}\n`, {
      mode: 0o600,
    })
    return { ok: true, path, error: null }
  } catch (error) {
    if (error instanceof Error) return { ok: false, path, error: error.message }
    throw error
  }
}

export function runRegistryEntry(
  event: RunRegistryEventName,
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...redactRecord(data),
  }
}

export function redactRunRegistryData(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map((item) => redactRunRegistryData(item))
  if (typeof value === 'object') return redactRecord(value)
  if (typeof value === 'string') return redactString(value)
  return value
}

function redactRecord(value: object): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = sensitiveKeyPattern.test(key) ? '[redacted]' : redactRunRegistryData(child)
  }
  return redacted
}

function redactString(value: string): string {
  return value.replace(secretLikePattern, '$1=[redacted]')
}

const sensitiveKeyPattern =
  /prompt|input|output|response|content|text|secret|token|key|password|authorization/i
const secretLikePattern =
  /\b(api[_-]?key|token|secret|password|authorization)\s*=\s*([A-Za-z0-9._~+/=-]{8,})/gi
