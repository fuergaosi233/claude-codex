import { createHash, randomUUID } from 'node:crypto'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import type { ImageInput } from './types.mjs'

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
  if (process.env.CLAUDE_CODEX_DEBUG_LOG === '0' || process.env.CLAUDE_CODEX_DEBUG_LOG === 'false')
    return
  const path = resolve(process.env.CLAUDE_CODEX_DEBUG_LOG || join(adapterHome(), 'debug.jsonl'))
  try {
    ensureParent(path)
    rotateLogIfNeeded(path)
    appendFileSync(
      path,
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...(redact(data) as Record<string, unknown>),
      }) + '\n',
    )
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
  try {
    unlinkSync(oldest)
  } catch {}
  // Shift `.k-1` → `.k`, `.k-2` → `.k-1`, …, `.1` → `.2`.
  for (let i = keep - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`)
    } catch {}
  }
  // Move the active log to `.1`. The next appendFileSync recreates it.
  try {
    renameSync(path, `${path}.1`)
  } catch {}
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
  return (
    process.env.CLAUDE_CODEX_COMPAT_VERSION || process.env.CODEX_SHIM_COMPAT_VERSION || '0.130.0'
  )
}

export function codexCliVersion(): string {
  return `codex-cli ${codexCompatVersion()}`
}

export function codexUserAgent(clientName: string, clientVersion: string): string {
  const name = clientName.trim() || 'codex-app'
  const version = clientVersion.trim() || 'unknown'
  const cpu =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
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

// Split UserInput[] into the text prompt + a list of image inputs ready to
// hand to Claude SDK as multimodal content blocks. localImage paths are read
// + base64 encoded (capped at 10 MiB to avoid OOM); image URLs pass through
// (data: URLs decode inline). Anything we can't read falls back to the same
// `[image]` text representation textFromInput uses, so the user still sees
// an indication in the prompt.
export interface ImageExtractResult {
  textPrompt: string
  images: ImageInput[]
}

export function extractImageInputs(input: unknown): ImageExtractResult {
  if (!Array.isArray(input)) return { textPrompt: '', images: [] }
  const texts: string[] = []
  const images: ImageInput[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as { type?: string; text?: string; path?: string; name?: string; url?: string }
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
    else if (item.type === 'mention') texts.push(`@${item.path ?? item.name ?? ''}`)
    else if (item.type === 'skill') texts.push(`/${item.name ?? 'skill'}`)
    else if (item.type === 'localImage' && typeof item.path === 'string') {
      const img = readLocalImage(item.path)
      if (img) images.push(img)
      else texts.push(`[local image unavailable: ${item.path}]`)
    } else if (item.type === 'image' && typeof item.url === 'string') {
      const img = parseImageUrl(item.url)
      if (img) images.push(img)
      else texts.push('[image]')
    }
  }
  return { textPrompt: texts.filter(Boolean).join('\n'), images }
}

function readLocalImage(path: string): ImageInput | null {
  try {
    const stat = statSync(path)
    if (stat.size > 10 * 1024 * 1024) return null
    const buf = readFileSync(path)
    return {
      kind: 'base64',
      mediaType: sniffImageMediaType(path),
      data: buf.toString('base64'),
      displayPath: path,
    }
  } catch {
    return null
  }
}

function parseImageUrl(url: string): ImageInput | null {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)(?:;([^,]+))?,(.*)$/)
    if (!match) return null
    const mediaType = match[1] || 'application/octet-stream'
    const isBase64 = (match[2] ?? '').includes('base64')
    const payload = match[3] ?? ''
    return {
      kind: 'base64',
      mediaType,
      data: isBase64
        ? payload
        : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64'),
      displayPath: url.slice(0, 64) + (url.length > 64 ? '...' : ''),
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) {
    return { kind: 'url', mediaType: 'image/*', data: url, displayPath: url }
  }
  return null
}

function sniffImageMediaType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'image/png'
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

export function claudeModelOptions(): Array<{
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
}> {
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
              sdkModel:
                typeof record.sdkModel === 'string' ? record.sdkModel : resolveClaudeModel(id),
              displayName:
                typeof record.displayName === 'string' ? record.displayName : modelDisplayName(id),
              description:
                typeof record.description === 'string'
                  ? record.description
                  : 'Claude Code runtime model',
              isDefault: record.isDefault === true,
            }
          }
          return modelOption('sonnet')
        })
      }
    } catch {}
    return configured
      .split(',')
      .map((part) => modelOption(part.trim()))
      .filter((entry) => entry.id.length > 0)
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

export function resolveClaudeModel(
  model: string | null | undefined,
  purpose: 'normal' | 'summary' = 'normal',
): string | null {
  const raw = (model ?? '').trim()
  if (purpose === 'summary') {
    const summaryModel =
      process.env.CLAUDE_CODEX_SUMMARY_MODEL || process.env.CLAUDE_CODEX_TITLE_MODEL || 'haiku'
    if (isCodexOpenAiModel(raw) || !raw) return summaryModel
  }
  if (!raw || raw === 'default' || raw === 'claude-default')
    return process.env.CLAUDE_CODEX_DEFAULT_MODEL || null
  if (raw === 'claude-code' || raw === 'custom')
    return process.env.CLAUDE_CODEX_DEFAULT_MODEL || null
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
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function claudeOutputFormat(outputSchema: unknown): unknown | null {
  if (outputSchema == null) return null
  if (outputSchema && typeof outputSchema === 'object' && !Array.isArray(outputSchema)) {
    const record = outputSchema as Record<string, unknown>
    if (record.type === 'json_schema' && record.schema != null) return outputSchema
  }
  return { type: 'json_schema', schema: outputSchema }
}

export function normalizeCodexReasoningEffort(
  value: string | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value
  if (value === 'minimal') return 'low'
  return null
}

export function resolveClaudeEffort(
  value: string | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null {
  const raw = (value ?? '').trim()
  const envAliases = parseJsonObject(process.env.CLAUDE_CODEX_EFFORT_ALIASES)
  const mapped = typeof envAliases[raw] === 'string' ? envAliases[raw] : raw
  if (
    mapped === 'low' ||
    mapped === 'medium' ||
    mapped === 'high' ||
    mapped === 'xhigh' ||
    mapped === 'max'
  )
    return mapped
  if (mapped === 'minimal') return 'low'
  return null
}

function modelOption(
  id: string,
  isDefault = false,
  description = 'Claude Code runtime model',
): {
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
} {
  return {
    id,
    sdkModel: resolveClaudeModel(id),
    displayName: modelDisplayName(id),
    description,
    isDefault,
  }
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
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

export function isCodexOpenAiModel(model: string): boolean {
  return /^gpt[-_]/.test(model) || /^o[0-9]/.test(model) || model.startsWith('codex-')
}

// Models exposed in model/list when a real Codex CLI is available — picking
// any of these in the Codex App flips the new thread to runtimeBackend='codex'
// so turns get forwarded to the OpenAI Codex CLI instead of the Claude SDK.
// We only expose them when `resolveCodexBinary()` returns a real path; that
// way Mac/Linux installs without `codex` see only Claude models and the
// picker stays clean.
export function codexProxyModelOptions(): Array<{
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
}> {
  // Suppressed in mock / opt-out flows. Mock runtime tests assume a clean
  // Claude-only model list; environments without a real Codex shouldn't see
  // unusable picker entries.
  if (process.env.CLAUDE_CODEX_MOCK === '1') return []
  if (process.env.CLAUDE_CODEX_DISABLE_CODEX_PROXY === '1') return []
  if (!resolveCodexBinary()) return []
  const env = process.env.CLAUDE_CODEX_CODEX_MODELS
  const ids =
    env && env.trim()
      ? env
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : ['gpt-5.5', 'gpt-5.5-mini', 'gpt-5.5-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5-codex']
  return ids.map((id) => ({
    id,
    sdkModel: id,
    displayName: `Codex · ${id}`,
    description: 'Real OpenAI Codex CLI (forwarded via `codex exec --json`).',
    isDefault: false,
  }))
}

// Resolve the real codex CLI binary — explicit CODEX_REAL wins; otherwise
// walk PATH for an entry that isn't this very script (to avoid recursion if
// our shim is also called `codex`). Returns null when nothing usable found.
export function resolveCodexBinary(): string | null {
  const explicit = process.env.CODEX_REAL
  if (explicit && explicit.trim()) return explicit.trim()
  // PATH walk is mostly for dev — production deployments should set
  // CODEX_REAL explicitly in the shim env (~/.zshenv).
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean)
  const fsSync = require('node:fs') as typeof import('node:fs')
  for (const dir of paths) {
    const candidate = `${dir}/codex`
    try {
      const st = fsSync.statSync(candidate)
      if (!st.isFile()) continue
      // Skip our shim — a hashbang + 'CLAUDE_CODEX' header is a strong
      // signal it's our codex-shim and would recurse.
      const head = fsSync.readFileSync(candidate, { encoding: 'utf8' }).slice(0, 200)
      if (head.includes('CLAUDE_CODEX_ADAPTER') || head.includes('claude-codex')) continue
      return candidate
    } catch {}
  }
  return null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (typeof value === 'string')
    return value.length > 1200 ? value.slice(0, 1200) + '...[truncated]' : value
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
