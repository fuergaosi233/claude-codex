import { createHash, randomUUID } from 'node:crypto'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'

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

// Unix domain socket paths are bounded by sockaddr_un.sun_path — roughly 104
// bytes on macOS and 108 on Linux. A deep CODEX_HOME (long usernames, nested
// workspaces) silently blew past that and surfaced as a cryptic EINVAL on
// connect. Fall back to a short, hashed path under the system temp dir.
export function socketPathLimit(): number {
  return platform() === 'darwin' ? 104 : 108
}

export function defaultSocketPath(): string {
  const preferred = join(codexHome(), 'app-server-control', 'app-server-control.sock')
  if (preferred.length <= socketPathLimit()) return preferred
  return join(tmpdir(), `ccx-${stableHash(preferred).slice(0, 16)}.sock`)
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.CLAUDE_CODEX_DEBUG_LOG === '0' || process.env.CLAUDE_CODEX_DEBUG_LOG === 'false') return
  const path = resolve(process.env.CLAUDE_CODEX_DEBUG_LOG || join(adapterHome(), 'debug.jsonl'))
  try {
    ensureParent(path)
    rotateLogIfNeeded(path)
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...(redact(data) as Record<string, unknown>) }) + '\n')
  } catch {}
}

// Long-running adapter daemons would otherwise grow debug.jsonl until the disk
// fills. Bound it with a simple `.1`/`.2`/... rotation: when the active log
// passes `maxBytes`, push it down one slot and start fresh. Bound by `keep`,
// dropping anything older. Sized envs override; failures swallow because the
// debug log is best-effort and must never break the main flow.
export function rotateLogIfNeeded(path: string): void {
  const maxBytes = numericEnv('CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES', 50 * 1024 * 1024)
  if (maxBytes <= 0) return
  const keep = Math.max(1, numericEnv('CLAUDE_CODEX_DEBUG_LOG_KEEP', 3))
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return // file does not exist yet — nothing to rotate
  }
  if (size < maxBytes) return
  // Drop the oldest slot if it would push us past `keep`.
  const oldest = `${path}.${keep}`
  try { unlinkSync(oldest) } catch {}
  // Shift `.k-1` → `.k`, `.k-2` → `.k-1`, …, `.1` → `.2`.
  for (let i = keep - 1; i >= 1; i -= 1) {
    try { renameSync(`${path}.${i}`, `${path}.${i + 1}`) } catch {}
  }
  // Move the active log to `.1`. The next appendFileSync recreates it.
  try { renameSync(path, `${path}.1`) } catch {}
}

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
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

export function codexCompatVersion(): string {
  return process.env.CLAUDE_CODEX_COMPAT_VERSION || process.env.CODEX_SHIM_COMPAT_VERSION || '0.130.0'
}

export function codexCliVersion(): string {
  return `codex-cli ${codexCompatVersion()}`
}

export function codexUserAgent(clientName: string, clientVersion: string): string {
  const name = clientName.trim() || 'codex-app'
  const version = clientVersion.trim() || 'unknown'
  const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  return `${name}/${codexCompatVersion()} (${platformOs()}; ${cpu}) unknown (${name}; ${version})`
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

export function resolveClaudeModel(model: string | null | undefined, purpose: 'normal' | 'summary' = 'normal'): string | null {
  const raw = (model ?? '').trim()
  if (purpose === 'summary') {
    const summaryModel = process.env.CLAUDE_CODEX_SUMMARY_MODEL || process.env.CLAUDE_CODEX_TITLE_MODEL || 'haiku'
    if (isCodexOpenAiModel(raw) || !raw) return summaryModel
  }
  if (!raw || raw === 'default' || raw === 'claude-default') return process.env.CLAUDE_CODEX_DEFAULT_MODEL || null
  if (raw === 'claude-code' || raw === 'custom') return process.env.CLAUDE_CODEX_DEFAULT_MODEL || null
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
  if (mapped) return mapped
  if (isNativeClaudeModel(raw)) return raw
  return process.env.CLAUDE_CODEX_DEFAULT_MODEL || null
}

export function defaultAllowedTools(): string[] | null {
  const raw = process.env.CLAUDE_CODEX_ALLOWED_TOOLS
  if (raw == null || raw.trim() === '') return null
  const value = raw.trim()
  if (value === '*' || value.toLowerCase() === 'default') return null
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

export function claudeOutputFormat(outputSchema: unknown): unknown | null {
  if (outputSchema == null) return null
  if (outputSchema && typeof outputSchema === 'object' && !Array.isArray(outputSchema)) {
    const record = outputSchema as Record<string, unknown>
    if (record.type === 'json_schema' && record.schema != null) return outputSchema
  }
  return { type: 'json_schema', schema: outputSchema }
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

function isNativeClaudeModel(model: string): boolean {
  return (
    model.startsWith('claude-') ||
    model === 'sonnet' ||
    model === 'opus' ||
    model === 'haiku' ||
    model === 'sonnet[1m]' ||
    model === 'opusplan'
  )
}

function isCodexOpenAiModel(model: string): boolean {
  return /^gpt[-_]/.test(model) || /^o[0-9]/.test(model) || model.startsWith('codex-')
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (typeof value === 'string') return value.length > 1200 ? value.slice(0, 1200) + '...[truncated]' : value
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 40).map((entry) => redact(entry, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (/token|secret|password|api.?key|authorization|cookie/i.test(key)) {
      result[key] = '[redacted]'
    } else {
      result[key] = redact(entry, depth + 1)
    }
  }
  return result
}
