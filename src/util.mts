import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadClaudeModelProfiles, modelProfileFingerprint } from './model-profiles.mjs'
import type { ImageInput, TurnToolOutput, UserInput } from './types.mjs'

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function nowMillis(): number {
  return Date.now()
}

export function newId(): string {
  return randomUUID()
}

// Thread ids are UUIDv7, as Codex app-server makes them: the App reads a
// thread's creation date from its id to find the thread's files, such as its
// inline visualizations, and refuses to read them for any other id.
// App rule: inline-visualizations
export function newThreadId(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Where the App looks for a thread's inline visualizations:
// <CODEX_HOME>/visualizations/<UTC YYYY/MM/DD from the id>/<thread id>. Only
// UUIDv7 thread ids have one.
// App rule: inline-visualizations
export function threadVisualizationDir(threadId: string): string | null {
  if (!UUID_V7.test(threadId)) return null
  const created = new Date(Number.parseInt(threadId.replace(/-/g, '').slice(0, 12), 16))
  const day = [
    String(created.getUTCFullYear()),
    String(created.getUTCMonth() + 1).padStart(2, '0'),
    String(created.getUTCDate()).padStart(2, '0'),
  ]
  return join(codexHome(), 'visualizations', ...day, threadId)
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

// CLAUDE_CODEX_SOCKET_PATH moves the socket. The daemon and the proxy each
// resolve it, so both need it set. An explicit path is used as given, without
// the short temp-directory fallback for a path too long for a socket.
export function defaultSocketPath(): string {
  const explicit = process.env.CLAUDE_CODEX_SOCKET_PATH?.trim()
  if (explicit) return resolve(explicit)
  const preferred = join(codexHome(), 'app-server-control', 'app-server-control.sock')
  if (preferred.length <= socketPathLimit()) return preferred
  return join(tmpdir(), `ccx-${stableHash(preferred).slice(0, 16)}.sock`)
}

// `path` lies strictly below `root`; both are compared lexically.
export function isPathInside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
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

// Codex app-server protocol version the adapter advertises (codex --version /
// initialize userAgent). The App turns its feature gates on by this version.
// This is the Codex build of App 26.1013, the baseline (codexVersion in
// scripts/app-baseline.json), so every gate that build and App 26.930 know is
// on; codex 0.163.0 has the same app-server protocol. check:app-upgrade checks
// each gate it turns on against the adapter. Older App builds only check a
// minimum version. Keep the default in scripts/codex-shim the same. Override
// per host with CLAUDE_CODEX_COMPAT_VERSION.
// App rule: feature-gates
const DEFAULT_CODEX_COMPAT_VERSION = '0.163.0-alpha.10.2'

export function codexCompatVersion(): string {
  return (
    process.env.CLAUDE_CODEX_COMPAT_VERSION ||
    process.env.CODEX_SHIM_COMPAT_VERSION ||
    DEFAULT_CODEX_COMPAT_VERSION
  )
}

// Distinguishing tag appended after the (clean, probe-parseable) version so the
// Claude adapter is identifiable next to a real `codex` that now reports the
// same version. Set CLAUDE_CODEX_VERSION_SUFFIX="" to disable and behave exactly
// like upstream codex.
const DEFAULT_VERSION_SUFFIX = 'claude-codex'

export function codexVersionSuffix(): string {
  return process.env.CLAUDE_CODEX_VERSION_SUFFIX ?? DEFAULT_VERSION_SUFFIX
}

export function codexCliVersion(): string {
  const suffix = codexVersionSuffix()
  // Number first so a semver probe still extracts the bare version.
  return `codex-cli ${codexCompatVersion()}${suffix ? ` (${suffix})` : ''}`
}

// The first Claude Code versions with a feature the adapter uses only when the
// session's CLI has it: the get_task_output request behind live Bash output,
// and the Agent tool's effort parameter.
export const CLAUDE_CODE_TASK_OUTPUT_VERSION = '2.1.287'
export const CLAUDE_CODE_AGENT_EFFORT_VERSION = '2.1.292'

// Whether a Claude Code version, as system/init or the initialize reply
// report it ("2.1.304"), is at least `minimum`. A version that is unknown or
// cannot be read counts as new enough: a feature is never turned off only
// because the version could not be read.
export function claudeCodeAtLeast(version: string | null | undefined, minimum: string): boolean {
  const have = versionParts(version)
  const need = versionParts(minimum)
  if (!have || !need) return true
  for (let index = 0; index < 3; index += 1) {
    const ours = have[index] ?? 0
    const wanted = need[index] ?? 0
    if (ours !== wanted) return ours > wanted
  }
  return true
}

function versionParts(value: string | null | undefined): number[] | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(value ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function codexUserAgent(clientName: string, clientVersion: string): string {
  const name = clientName.trim() || 'codex-app'
  const version = clientVersion.trim() || 'unknown'
  const cpu =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  // The originator field (real codex puts a build tag here) carries our marker.
  const originator = codexVersionSuffix() || 'unknown'
  return `${name}/${codexCompatVersion()} (${platformOs()}; ${cpu}) ${originator} (${name}; ${version})`
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
      if (value.type === 'skill') return skillInputText(value)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

// A skill input item reads like the link the composer writes for a picked
// skill, so both reach Claude the same way (see turn-context.mts).
// App rule: skill-injection
function skillInputText(item: { name?: string; path?: string }): string {
  const name = item.name || 'skill'
  return item.path ? `[$${name}](${item.path})` : `/${name}`
}

export function turnToolOutputFromParams(value: unknown): TurnToolOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string') return null
  const output =
    typeof record.output === 'string'
      ? record.output
      : Array.isArray(record.output)
        ? record.output.filter(
            (part): part is Record<string, unknown> =>
              !!part && typeof part === 'object' && !Array.isArray(part),
          )
        : null
  if (output === null) return null
  return {
    name: record.name,
    namespace: typeof record.namespace === 'string' ? record.namespace : null,
    output,
  }
}

// What Claude reads for a tool result: its text and images, as user input.
export function toolOutputInput(output: TurnToolOutput['output']): UserInput[] {
  if (typeof output === 'string') return output ? [{ type: 'text', text: output }] : []
  return output.flatMap((part): UserInput[] => {
    if (part.type === 'input_text' && typeof part.text === 'string')
      return [{ type: 'text', text: part.text }]
    if (part.type === 'input_image' && typeof part.image_url === 'string')
      return [{ type: 'image', url: part.image_url }]
    return []
  })
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
    else if (item.type === 'skill') texts.push(skillInputText(item))
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

// `base` ended as a sentence, then `sentence` after it.
export function appendSentence(base: string, sentence: string): string {
  if (!base) return sentence
  return `${/[.!?。！？]$/.test(base) ? base : `${base}.`} ${sentence}`
}

export function modelDisplayName(model: string): string {
  if (model === 'default') return 'Claude Default'
  if (model === 'sonnet') return 'Claude Sonnet'
  if (model === 'opus') return 'Claude Opus'
  if (model === 'fable') return 'Claude Fable'
  if (model === 'haiku') return 'Claude Haiku'
  if (model === 'sonnet-1m') return 'Claude Sonnet 1M'
  if (model === 'opus-plan') return 'Claude Opus Plan / Sonnet Execute'
  return model
}

// model/list swaps this placeholder for Claude Code's own description of the
// model once Claude Code has reported one.
export const GENERIC_MODEL_DESCRIPTION = 'Claude Code runtime model'

function modelDescription(model: string): string {
  if (model === 'opus-plan' || model === 'claude-opus-plan' || model === 'opusplan') {
    return 'Uses Opus in plan mode and Sonnet for execution; selecting this model does not enable plan mode.'
  }
  return GENERIC_MODEL_DESCRIPTION
}

function scanDiscoveredRouterModels(): Set<string> {
  const models = new Set<string>()
  models.add('sonnet')
  models.add('opus')
  models.add('fable')
  models.add('haiku')
  models.add('sonnet-1m')
  models.add('opus-plan')

  const cacheBase = join(homedir(), '.cache')
  if (existsSync(cacheBase)) {
    try {
      for (const sub of readdirSync(cacheBase)) {
        const routerDir = join(cacheBase, sub, 'claude-router')
        if (existsSync(routerDir)) {
          for (const item of readdirSync(routerDir)) {
            if (!item.startsWith('.')) models.add(item)
          }
        }
      }
    } catch {}
  }

  const extraRoots = (process.env.CLAUDE_CONFIG_DIRS || process.env.CLAUDE_ROUTER_DIR || '')
    .split(/[,:]/)
    .map((p) => p.trim())
    .filter(Boolean)
  for (const extra of extraRoots) {
    if (existsSync(extra)) {
      try {
        for (const item of readdirSync(extra)) {
          if (!item.startsWith('.')) models.add(item)
        }
      } catch {}
    }
  }
  return models
}

let cachedDiscoveredModels: { expiresAt: number; set: Set<string> } | null = null
function getDiscoveredRouterModelsCached(): Set<string> {
  const now = Date.now()
  if (cachedDiscoveredModels && cachedDiscoveredModels.expiresAt > now) {
    return cachedDiscoveredModels.set
  }
  const set = scanDiscoveredRouterModels()
  cachedDiscoveredModels = { expiresAt: now + 15_000, set }
  return set
}

let cachedClaudeModelOptions: { expiresAt: number; data: Array<any> } | null = null
const cachedCodexProxyModelOptions: { expiresAt: number; data: Array<any> } | null = null

export function claudeModelOptions(): Array<{
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
}> {
  // Model process profiles, when configured, are the whole picker.
  const processProfiles = loadClaudeModelProfiles()
  if (processProfiles.length > 0) {
    return processProfiles.map((profile) => ({
      id: profile.id,
      sdkModel: profile.sdkModel,
      displayName: profile.displayName,
      description: profile.description,
      isDefault: profile.isDefault,
    }))
  }
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
                typeof record.description === 'string' ? record.description : modelDescription(id),
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
  const now = Date.now()
  if (cachedClaudeModelOptions && cachedClaudeModelOptions.expiresAt > now) {
    return cachedClaudeModelOptions.data
  }

  const models = new Set<string>()
  models.add('sonnet')
  models.add('opus')
  models.add('fable')
  models.add('haiku')
  models.add('sonnet-1m')
  models.add('opus-plan')

  const cacheBase = join(homedir(), '.cache')
  if (existsSync(cacheBase)) {
    try {
      for (const sub of readdirSync(cacheBase)) {
        const routerDir = join(cacheBase, sub, 'claude-router')
        if (existsSync(routerDir)) {
          for (const item of readdirSync(routerDir)) {
            if (!item.startsWith('.')) models.add(item)
          }
        }
      }
    } catch {}
  }

  const extraRoots = (process.env.CLAUDE_CONFIG_DIRS || process.env.CLAUDE_ROUTER_DIR || '')
    .split(/[,:]/)
    .map((p) => p.trim())
    .filter(Boolean)
  for (const extra of extraRoots) {
    if (existsSync(extra)) {
      try {
        for (const item of readdirSync(extra)) {
          if (!item.startsWith('.')) models.add(item)
        }
      } catch {}
    }
  }

  const result = Array.from(models).map((m, i) => modelOption(m, i === 0))
  cachedClaudeModelOptions = { expiresAt: now + 15_000, data: result }
  return result
}

export function resolveClaudeModel(
  model: string | null | undefined,
  purpose: 'normal' | 'summary' = 'normal',
): string | null {
  const raw = (model ?? '').trim()
  const processProfiles = loadClaudeModelProfiles()
  if (processProfiles.length > 0) return resolveProfileModel(raw, purpose, processProfiles)
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
    'claude-fable': 'fable',
    'claude-haiku': 'haiku',
    'sonnet-1m': 'sonnet[1m]',
    'claude-sonnet-1m': 'sonnet[1m]',
    'opus-plan': 'opusplan',
    'claude-opus-plan': 'opusplan',
  }
  const envAliases = parseJsonObject(process.env.CLAUDE_CODEX_MODEL_ALIASES)
  const mapped = typeof envAliases[raw] === 'string' ? envAliases[raw] : aliases[raw]
  if (mapped) return mapped
  // Case-insensitive match against configured models (e.g. GLM-5.3 -> glm-5.3)
  const configured = process.env.CLAUDE_CODEX_MODELS
  if (configured) {
    const list = configured
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const matched = list.find((m) => m.toLowerCase() === raw.toLowerCase())
    if (matched) return matched
  }
  // Match case-insensitively against discovered router models
  const discoveredIds = getDiscoveredRouterModelsCached()
  for (const id of discoveredIds) {
    if (id.toLowerCase() === raw.toLowerCase()) return id
  }
  if (isNativeClaudeModel(raw)) return raw
  return process.env.CLAUDE_CODEX_DEFAULT_MODEL || null
}

type ClaudeModelProfiles = ReturnType<typeof loadClaudeModelProfiles>

function isDefaultModelAlias(raw: string): boolean {
  return (
    !raw ||
    raw === 'default' ||
    raw === 'claude-default' ||
    raw === 'claude-code' ||
    raw === 'custom'
  )
}

function defaultModelProfile(profiles: ClaudeModelProfiles): ClaudeModelProfiles[number] | null {
  return profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null
}

// The profile that answers summary turns (titles, compaction) of threads that
// are not on a profile themselves.
function summaryModelProfile(profiles: ClaudeModelProfiles): ClaudeModelProfiles[number] {
  const summaryProfileId =
    process.env.CLAUDE_CODEX_SUMMARY_MODEL ||
    process.env.CLAUDE_CODEX_TITLE_MODEL ||
    defaultModelProfile(profiles)?.id ||
    ''
  const profile = profiles.find((entry) => entry.id === summaryProfileId)
  if (!profile) {
    throw new Error(`unknown configured Claude summary model profile: ${summaryProfileId}`)
  }
  return profile
}

// With model process profiles configured, only profile ids (and the default
// aliases) are Claude models; anything else is a configuration error rather
// than a silent fallback to another provider.
function resolveProfileModel(
  raw: string,
  purpose: 'normal' | 'summary',
  profiles: ClaudeModelProfiles,
): string | null {
  if (purpose === 'summary' && (isCodexOpenAiModel(raw) || !raw)) {
    return summaryModelProfile(profiles).sdkModel
  }
  const profile = profiles.find((entry) => entry.id === raw)
  if (profile) return profile.sdkModel
  if (isDefaultModelAlias(raw)) return defaultModelProfile(profiles)?.sdkModel ?? null
  if (isCodexOpenAiModel(raw)) return raw
  throw new Error(`unknown configured Claude model profile: ${raw}`)
}

// The model a summary turn runs on, plus the profile identity its process is
// checked against. A thread on a profile keeps its pinned fingerprint; a
// substitute profile (summary or default) is checked against its current one.
export function resolveClaudeSummaryModelIdentity(
  model: string | null | undefined,
  pinnedProfileFingerprint: string | null = null,
): {
  model: string | null
  modelProfileId: string | null
  modelProfileFingerprint: string | null
} {
  const raw = (model ?? '').trim()
  const processProfiles = loadClaudeModelProfiles()
  const directProfile = processProfiles.find((profile) => profile.id === raw) ?? null
  let profile = directProfile
  if (!profile && processProfiles.length > 0) {
    if (isCodexOpenAiModel(raw) || !raw) profile = summaryModelProfile(processProfiles)
    else if (isDefaultModelAlias(raw)) profile = defaultModelProfile(processProfiles)
  }
  if (!profile) {
    return {
      model: resolveClaudeModel(model, 'summary'),
      modelProfileId: null,
      modelProfileFingerprint: null,
    }
  }
  return {
    model: profile.sdkModel,
    modelProfileId: profile.id,
    modelProfileFingerprint:
      directProfile && pinnedProfileFingerprint
        ? pinnedProfileFingerprint
        : modelProfileFingerprint(profile.id),
  }
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
    if (record.type === 'json_schema' && record.schema != null)
      return { ...record, schema: withoutSchemaDialect(record.schema) }
  }
  return { type: 'json_schema', schema: withoutSchemaDialect(outputSchema) }
}

// The Claude CLI checks a structured output schema against the JSON Schema
// draft it ships and refuses one that declares another, such as the draft
// 2020-12 the Codex App's zod schemas declare. Those use nothing
// draft-specific, so the declaration is dropped.
// App rule: helper-thread-model
function withoutSchemaDialect(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !('$schema' in schema))
    return schema
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>
  return rest
}

// The efforts a thread or the config can hold. Only Claude models list 'max';
// 'none' (a model without efforts) keeps whatever was set before.
export function normalizeCodexReasoningEffort(
  value: string | null | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
    return value
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
  description = modelDescription(id),
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

/**
 * Determine if a model identifier should be routed to Claude Code runtime.
 * In modern proxy/gateway environments (such as custom LLM endpoints, local fine-tunes,
 * or non-Anthropic backend relays), arbitrary model identifiers (e.g. glm-*, ark-*, qwen-*)
 * can be served via Claude Code CLI. We allow any non-Codex-OpenAI model string to pass through.
 */
function isNativeClaudeModel(model: string): boolean {
  return !isCodexOpenAiModel(model)
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
  const now = Date.now()
  if (cachedCodexProxyModelOptions && cachedCodexProxyModelOptions.expiresAt > now) {
    return cachedCodexProxyModelOptions.data
  }
  const env = process.env.CLAUDE_CODEX_CODEX_MODELS
  let ids: string[] = []
  if (env && env.trim()) {
    ids = env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } else {
    // The App and its bundled codex share CODEX_HOME, which is not ~/.codex
    // for every install.
    const catalogCandidates = [join(codexHome(), 'model_catalog.json')]
    for (const p of catalogCandidates) {
      if (existsSync(p)) {
        try {
          const cat = JSON.parse(readFileSync(p, 'utf8'))
          if (cat && Array.isArray(cat.models)) {
            ids = cat.models.map((m: any) => m.slug || m.id || m.model).filter(Boolean)
            break
          }
        } catch {}
      }
    }
    if (ids.length === 0) {
      ids = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']
    }
  }
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
  const knownCandidates = [
    join(
      homedir(),
      '.local/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex.real',
    ),
  ]
  for (const c of knownCandidates) {
    if (existsSync(c)) return c
  }
  // PATH walk is mostly for dev — production deployments should set
  // CODEX_REAL explicitly in the shim env (~/.zshenv).
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean)

  for (const dir of paths) {
    const candidate = `${dir}/codex`
    try {
      const st = statSync(candidate)
      if (!st.isFile()) continue
      // Skip our shim — a hashbang + 'CLAUDE_CODEX' header is a strong
      // signal it's our codex-shim and would recurse.
      const head = readFileSync(candidate, { encoding: 'utf8' }).slice(0, 200)
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
