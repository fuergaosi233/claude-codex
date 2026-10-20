import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

// Model process profiles: each selectable model id maps to its own Claude Code
// process (executable, provider environment, CLAUDE_CONFIG_DIR). Profiles come
// from CLAUDE_CODEX_MODEL_PROFILES_FILE (a JSON file owned by the user) or the
// inline CLAUDE_CODEX_MODEL_PROFILES. A thread pins the fingerprint of the
// profile it started with, so a provider change never silently resumes an old
// session against a different backend. Fingerprints never hash secret values.

export type ClaudeModelProfile = {
  id: string
  sdkModel: string
  displayName: string
  description: string
  executable: string | null
  envFile: string | null
  env: Record<string, string>
  inheritEnv: string[]
  isDefault: boolean
}

export type ClaudeModelProcess = {
  profileId: string
  sdkModel: string
  executable: string | null
  env: Record<string, string>
  fingerprint: string
}

type Environment = Record<string, string | undefined>

const MODEL_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
// Provider settings of the adapter's own environment never reach a profile
// process; the profile must set them itself.
const PROVIDER_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CONFIG_DIR',
])
const SECRET_ENV_KEY = /(TOKEN|KEY|SECRET|PASSWORD|AUTH)/i
// Token budgets such as CLAUDE_CODE_MAX_OUTPUT_TOKENS are counts, not secrets.
const TOKEN_COUNT = /TOKENS(?=_|$)/gi
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const ENV_REFERENCE_ONLY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const DEFAULT_INHERITED_ENV = [
  'HOME',
  'PATH',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSH_AUTH_SOCK',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'NO_COLOR',
  'FORCE_COLOR',
]

export function loadClaudeModelProfiles(env: Environment = process.env): ClaudeModelProfile[] {
  const source = modelProfilesSource(env)
  if (!source) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(source.text)
  } catch (error) {
    throw new Error(`invalid Claude model profiles JSON: ${errorMessage(error)}`)
  }
  const root = asRecord(parsed)
  const entries = Array.isArray(parsed) ? parsed : root?.models
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Claude model profiles must contain a non-empty models array')
  }
  const defaultModel = typeof root?.defaultModel === 'string' ? root.defaultModel.trim() : ''
  const seen = new Set<string>()
  const profiles = entries.map((entry: unknown, index: number): ClaudeModelProfile => {
    const record = asRecord(entry)
    if (!record) throw new Error(`Claude model profile at index ${index} must be an object`)
    const id = requiredString(record.id, `Claude model profile at index ${index} requires id`)
    if (!MODEL_PROFILE_ID.test(id)) {
      throw new Error(`invalid Claude model profile id: ${id}`)
    }
    if (seen.has(id)) throw new Error(`duplicate Claude model profile id: ${id}`)
    seen.add(id)
    const sdkModel = optionalString(record.sdkModel) || id
    const executableValue = optionalString(record.executable)
    const executable = executableValue
      ? expandPath(executableValue, source.directory, env, 'executable')
      : null
    if (executable && !isAbsolute(executable)) {
      throw new Error(`Claude model profile ${id} executable must be absolute`)
    }
    const envFileValue = optionalString(record.envFile)
    const envFile = envFileValue ? expandPath(envFileValue, source.directory, env, 'envFile') : null
    const profileEnv = stringRecord(record.env, `Claude model profile ${id} env`)
    for (const [key, value] of Object.entries(profileEnv)) {
      if (secretLikeEnvKey(key) && !ENV_REFERENCE_ONLY.test(value)) {
        throw new Error(
          `Claude model profile ${id} secret-like environment key must reference a parent environment variable: ${key}`,
        )
      }
    }
    return {
      id,
      sdkModel,
      displayName: optionalString(record.displayName) || id,
      description: optionalString(record.description) || 'Claude Code model process profile',
      executable,
      envFile,
      env: profileEnv,
      inheritEnv: inheritedEnvironment(record.inheritEnv, `Claude model profile ${id}`),
      isDefault: record.isDefault === true || defaultModel === id,
    }
  })
  if (defaultModel && !seen.has(defaultModel)) {
    throw new Error(`Claude model profiles defaultModel is unknown: ${defaultModel}`)
  }
  if (!profiles.some((profile) => profile.isDefault)) {
    const first = profiles[0]
    if (!first) throw new Error('Claude model profiles must contain a non-empty models array')
    first.isDefault = true
  }
  if (profiles.filter((profile) => profile.isDefault).length > 1) {
    throw new Error('Claude model profiles must define exactly one default model')
  }
  return profiles
}

export function resolveClaudeModelProfile(
  modelId: string | null | undefined,
  env: Environment = process.env,
): ClaudeModelProfile | null {
  const id = (modelId ?? '').trim()
  if (!id) return null
  return loadClaudeModelProfiles(env).find((profile) => profile.id === id) ?? null
}

// The process a turn of `modelId` runs in, or null when no profiles are
// configured. The child environment starts from the profile's inherited keys,
// drops every provider setting and every secret the profile references (with
// `*`, every secret any profile's env references), then applies the env file
// and the profile env.
export function resolveClaudeModelProcess(
  modelId: string | null | undefined,
  env: Environment = process.env,
  expectedFingerprint: string | null = null,
): ClaudeModelProcess | null {
  const profiles = loadClaudeModelProfiles(env)
  const profile = requiredConfiguredProfile(modelId, profiles)
  if (!profile) return null
  const envFileAssignments = profile.envFile ? readPrivateEnvAssignments(profile.envFile) : {}
  const fingerprint = fingerprintForProfile(profile, env, envFileAssignments)
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw new Error(
      `model process profile configuration changed for ${profile.id}; start a new thread`,
    )
  }
  const childEnv: Record<string, string> = {}
  if (profile.inheritEnv.includes('*')) {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value
    }
  } else {
    for (const key of profile.inheritEnv) {
      const value = env[key]
      if (value !== undefined) childEnv[key] = value
    }
  }
  for (const key of PROVIDER_ENV_KEYS) delete childEnv[key]
  for (const key of referencedSecretEnvKeys(profile, envFileAssignments)) delete childEnv[key]
  if (profile.inheritEnv.includes('*')) {
    // Nor does another profile's credential.
    for (const other of profiles) {
      for (const key of referencedSecretEnvKeys(other, {})) delete childEnv[key]
    }
  }
  Object.assign(
    childEnv,
    resolveEnvAssignments(envFileAssignments, env, profile.envFile ?? `${profile.id}.envFile`),
  )
  for (const [key, value] of Object.entries(profile.env)) {
    childEnv[key] = interpolate(value, { ...env, ...childEnv }, `env.${key}`)
  }
  return {
    profileId: profile.id,
    sdkModel: profile.sdkModel,
    executable: profile.executable,
    env: childEnv,
    fingerprint,
  }
}

export function modelProfileFingerprint(
  modelId: string | null | undefined,
  env: Environment = process.env,
): string | null {
  const profile = requiredConfiguredProfile(modelId, loadClaudeModelProfiles(env))
  if (!profile) return null
  const envFileAssignments = profile.envFile ? readPrivateEnvAssignments(profile.envFile) : {}
  return fingerprintForProfile(profile, env, envFileAssignments)
}

// A thread stays on the profile it started with: switching profiles would
// resume the session in a different process and config dir.
export function assertModelProfileTransition(
  currentModel: string | null | undefined,
  nextModel: string | null | undefined,
  env: Environment = process.env,
): void {
  const profiles = loadClaudeModelProfiles(env)
  if (profiles.length === 0) return
  const currentProfile = profiles.find((profile) => profile.id === (currentModel ?? '').trim())
  const nextProfile = profiles.find((profile) => profile.id === (nextModel ?? '').trim())
  if (!currentProfile) {
    throw new Error(`unknown configured Claude model profile: ${(currentModel ?? '').trim()}`)
  }
  if (!nextProfile) {
    throw new Error(`unknown configured Claude model profile: ${(nextModel ?? '').trim()}`)
  }
  if (currentProfile.id === nextProfile.id) return
  throw new Error(
    `cannot change model process profile from ${currentProfile.id} to ${nextProfile.id}; start a new thread`,
  )
}

function requiredConfiguredProfile(
  modelId: string | null | undefined,
  profiles: ClaudeModelProfile[],
): ClaudeModelProfile | null {
  if (profiles.length === 0) return null
  const id = (modelId ?? '').trim()
  const profile = profiles.find((entry) => entry.id === id)
  if (!profile) throw new Error(`unknown configured Claude model profile: ${id || '(empty)'}`)
  return profile
}

// Stored per thread, so the serialization must stay stable across releases.
// `${VAR}` resolves as in the child environment: an env file assignment reads
// the adapter's environment and the file's earlier assignments, a profile env
// assignment also the whole file and the profile's earlier ones.
function fingerprintForProfile(
  profile: ClaudeModelProfile,
  env: Environment,
  envFileAssignments: Record<string, string>,
): string {
  const scope: Environment = { ...env }
  const environment: Record<string, string> = {}
  const add = (key: string, value: string, label: string) => {
    const identity = secretLikeEnvKey(key)
      ? '<secret>'
      : interpolateForFingerprint(value, scope, label)
    environment[key] = identity
    scope[key] = identity
  }
  const envFileLabel = profile.envFile ?? `${profile.id}.envFile`
  for (const [key, value] of Object.entries(envFileAssignments))
    add(key, value, `${envFileLabel}:${key}`)
  for (const [key, value] of Object.entries(profile.env))
    add(key, value, `${profile.id}.env.${key}`)
  const identityEnvironment: Record<string, string> = {}
  for (const key of Object.keys(environment).sort()) {
    const value = environment[key]
    if (value !== undefined) identityEnvironment[key] = value
  }
  const identity = {
    id: profile.id,
    sdkModel: profile.sdkModel,
    executable: profile.executable,
    envFile: profile.envFile,
    env: identityEnvironment,
    inheritEnv: [...profile.inheritEnv].sort(),
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function interpolateForFingerprint(value: string, env: Environment, label: string): string {
  return value.replace(ENV_REFERENCE, (_match, key: string) => {
    if (secretLikeEnvKey(key)) return '<secret>'
    const resolved = env[key]
    if (resolved === undefined) throw new Error(`missing environment variable ${key} for ${label}`)
    return resolved
  })
}

function secretLikeEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key.replace(TOKEN_COUNT, ''))
}

function modelProfilesSource(env: Environment): { text: string; directory: string } | null {
  const fileValue = (env.CLAUDE_CODEX_MODEL_PROFILES_FILE ?? '').trim()
  const inlineValue = (env.CLAUDE_CODEX_MODEL_PROFILES ?? '').trim()
  if (fileValue && inlineValue) {
    throw new Error(
      'set only one of CLAUDE_CODEX_MODEL_PROFILES_FILE or CLAUDE_CODEX_MODEL_PROFILES',
    )
  }
  if (fileValue) {
    const path = expandPath(fileValue, process.cwd(), env, 'CLAUDE_CODEX_MODEL_PROFILES_FILE')
    assertControlledConfigFile(path)
    return { text: readFileSync(path, 'utf8'), directory: dirname(path) }
  }
  if (inlineValue) return { text: inlineValue, directory: process.cwd() }
  return null
}

// Env files hold provider credentials: read them only if they are private to
// the current user, and make sure the file read is the file checked.
function readPrivateEnvAssignments(path: string): Record<string, string> {
  const pathStat = lstatSync(path)
  if (pathStat.isSymbolicLink())
    throw new Error(`model profile env file must not be a symbolic link: ${path}`)
  assertPrivateEnvMetadata(pathStat, path)
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedStat = fstatSync(descriptor)
    assertPrivateEnvMetadata(openedStat, path)
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`model profile env file changed while opening: ${path}`)
    }
    const text = readFileSync(descriptor, 'utf8')
    const afterReadStat = fstatSync(descriptor)
    if (
      afterReadStat.dev !== openedStat.dev ||
      afterReadStat.ino !== openedStat.ino ||
      afterReadStat.size !== openedStat.size ||
      afterReadStat.mtimeMs !== openedStat.mtimeMs ||
      afterReadStat.ctimeMs !== openedStat.ctimeMs
    ) {
      throw new Error(`model profile env file changed while reading: ${path}`)
    }
    return parseEnvAssignments(text, path)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function assertPrivateEnvMetadata(stat: Stats, path: string): void {
  if (!stat.isFile()) throw new Error(`model profile env file must be a regular file: ${path}`)
  if ((stat.mode & 0o077) !== 0)
    throw new Error(`model profile env file must have mode 0600: ${path}`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`model profile env file must be owned by the current user: ${path}`)
  }
}

function assertControlledConfigFile(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new Error(`model profiles config must not be a symbolic link: ${path}`)
  }
  if (!stat.isFile()) throw new Error(`model profiles config must be a regular file: ${path}`)
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`model profiles config must not be group or world writable: ${path}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`model profiles config must be owned by the current user: ${path}`)
  }
}

function referencedSecretEnvKeys(
  profile: ClaudeModelProfile,
  envFileAssignments: Record<string, string>,
): Set<string> {
  const values = [...Object.values(profile.env), ...Object.values(envFileAssignments)]
  const keys = new Set<string>()
  for (const value of values) {
    for (const match of value.matchAll(ENV_REFERENCE)) {
      const key = match[1]
      if (key && secretLikeEnvKey(key)) keys.add(key)
    }
  }
  return keys
}

function resolveEnvAssignments(
  assignments: Record<string, string>,
  parentEnv: Environment,
  label: string,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(assignments)) {
    values[key] = interpolate(value, { ...parentEnv, ...values }, `${label}:${key}`)
  }
  return values
}

function parseEnvAssignments(text: string, path: string): Record<string, string> {
  const values: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const declaration = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const separator = declaration.indexOf('=')
    if (separator <= 0) throw new Error(`invalid env assignment at ${path}:${index + 1}`)
    const key = declaration.slice(0, separator).trim()
    if (!ENV_KEY.test(key)) throw new Error(`invalid env key at ${path}:${index + 1}`)
    let value = declaration.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

function inheritedEnvironment(value: unknown, label: string): string[] {
  if (value == null) return [...DEFAULT_INHERITED_ENV]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} inheritEnv must be a non-empty array`)
  }
  const keys: string[] = []
  for (const entry of value) {
    if (entry !== '*' && (typeof entry !== 'string' || !ENV_KEY.test(entry))) {
      throw new Error(`${label} inheritEnv must contain environment variable names or '*'`)
    }
    if (!keys.includes(entry)) keys.push(entry)
  }
  if (keys.includes('*') && keys.length !== 1) {
    throw new Error(`${label} inheritEnv '*' cannot be combined with named variables`)
  }
  return keys
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value == null) return {}
  const record = asRecord(value)
  if (!record) throw new Error(`${label} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (!ENV_KEY.test(key) || typeof entry !== 'string') {
      throw new Error(`${label} must contain string environment assignments`)
    }
    result[key] = entry
  }
  return result
}

function expandPath(value: string, baseDirectory: string, env: Environment, label: string): string {
  const expanded = interpolate(value, env, label)
  if (expanded === '~') return resolve(env.HOME || homedir())
  if (expanded.startsWith('~/')) return resolve(env.HOME || homedir(), expanded.slice(2))
  return resolve(baseDirectory, expanded)
}

function interpolate(value: string, env: Environment, label: string): string {
  return value.replace(ENV_REFERENCE, (_match, key: string) => {
    const resolved = env[key]
    if (resolved === undefined) throw new Error(`missing environment variable ${key} for ${label}`)
    return resolved
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function requiredString(value: unknown, message: string): string {
  const result = optionalString(value)
  if (!result) throw new Error(message)
  return result
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
