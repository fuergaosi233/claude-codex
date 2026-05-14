import { createHash, randomUUID } from 'node:crypto'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function nowMillis(): number {
  return Date.now()
}

export function newId(): string {
  return randomUUID()
}

export function codexHome(): string {
  return resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
}

export function adapterHome(): string {
  return resolve(process.env.CLAUDE_CODEX_HOME || join(codexHome(), 'claude-codex-adapter'))
}

export function defaultSocketPath(): string {
  return join(codexHome(), 'app-server-control', 'app-server-control.sock')
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}

export function platformFamily(): string {
  return platform() === 'win32' ? 'windows' : 'unix'
}

export function platformOs(): string {
  switch (platform()) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      return platform()
  }
}

export function textFromInput(input: unknown): string {
  if (!Array.isArray(input)) return ''
  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const value = item as { type?: string; text?: string; path?: string; name?: string }
      if (value.type === 'text') return value.text ?? ''
      if (value.type === 'mention') return `@${value.path ?? value.name ?? ''}`
      if (value.type === 'localImage') return `[local image: ${value.path ?? ''}]`
      if (value.type === 'image') return `[image]`
      if (value.type === 'skill') return `/${value.name ?? 'skill'}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function modelDisplayName(model: string): string {
  if (model === 'default') return 'Claude Default'
  if (model === 'sonnet') return 'Claude Sonnet'
  if (model === 'opus') return 'Claude Opus'
  if (model === 'haiku') return 'Claude Haiku'
  if (model === 'sonnet-1m') return 'Claude Sonnet 1M'
  if (model === 'opus-plan') return 'Claude Opus Plan'
  return model
}

export function claudeModelOptions(): Array<{ id: string; sdkModel: string | null; displayName: string; description: string; isDefault?: boolean }> {
  const configured = process.env.CLAUDE_CODEX_MODELS
  if (configured) {
    try {
      const parsed = JSON.parse(configured)
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => {
          if (typeof entry === 'string') return modelOption(entry)
          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id : String(record.model ?? 'sonnet')
            return {
              id,
              sdkModel: typeof record.sdkModel === 'string' ? record.sdkModel : resolveClaudeModel(id),
              displayName: typeof record.displayName === 'string' ? record.displayName : modelDisplayName(id),
              description: typeof record.description === 'string' ? record.description : 'Claude Code runtime model',
              isDefault: record.isDefault === true,
            }
          }
          return modelOption('sonnet')
        })
      }
    } catch {}
    return configured.split(',').map((part) => modelOption(part.trim())).filter((entry) => entry.id.length > 0)
  }
  return [
    modelOption('sonnet', true, 'Claude Code latest Sonnet alias'),
    modelOption('opus', false, 'Claude Code latest Opus alias'),
    modelOption('haiku', false, 'Claude Code latest Haiku alias'),
    modelOption('sonnet-1m', false, 'Claude Code Sonnet long-context alias'),
    modelOption('opus-plan', false, 'Claude Code Opus planning alias'),
    modelOption('claude-sonnet-4-6', false, 'Pinned Claude Sonnet model'),
    modelOption('claude-sonnet-4-5', false, 'Pinned Claude Sonnet model'),
    modelOption('claude-opus-4-5', false, 'Pinned Claude Opus model'),
  ]
}

export function resolveClaudeModel(model: string | null | undefined): string | null {
  const raw = (model ?? '').trim()
  if (!raw || raw === 'default' || raw === 'claude-default') return null
  const aliases: Record<string, string> = {
    'claude-sonnet': 'sonnet',
    'claude-opus': 'opus',
    'claude-haiku': 'haiku',
    'sonnet-1m': 'sonnet[1m]',
    'claude-sonnet-1m': 'sonnet[1m]',
    'opus-plan': 'opusplan',
    'claude-opus-plan': 'opusplan',
  }
  const envAliases = parseJsonObject(process.env.CLAUDE_CODEX_MODEL_ALIASES)
  const mapped = typeof envAliases[raw] === 'string' ? envAliases[raw] : aliases[raw]
  return mapped ?? raw
}

export function normalizeCodexReasoningEffort(value: string | null | undefined): 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value
  if (value === 'minimal') return 'low'
  return null
}

export function resolveClaudeEffort(value: string | null | undefined): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null {
  const raw = (value ?? '').trim()
  const envAliases = parseJsonObject(process.env.CLAUDE_CODEX_EFFORT_ALIASES)
  const mapped = typeof envAliases[raw] === 'string' ? envAliases[raw] : raw
  if (mapped === 'low' || mapped === 'medium' || mapped === 'high' || mapped === 'xhigh' || mapped === 'max') return mapped
  if (mapped === 'minimal') return 'low'
  return null
}

function modelOption(id: string, isDefault = false, description = 'Claude Code runtime model'): { id: string; sdkModel: string | null; displayName: string; description: string; isDefault?: boolean } {
  return { id, sdkModel: resolveClaudeModel(id), displayName: modelDisplayName(id), description, isDefault }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
