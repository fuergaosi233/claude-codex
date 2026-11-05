#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Paths come from this script's location, so the doctor checks this checkout
// whatever the working directory is.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shimPath = join(repoRoot, 'scripts', 'codex-shim')
const runtimeEnvPath =
  process.env.CLAUDE_CODEX_RUNTIME_ENV || join(homedir(), '.claude-codex', 'runtime.env')
// The shim sources the runtime env file over its own environment, so the
// file's assignments win, as they do there.
const env = { ...process.env, ...readRuntimeEnv(runtimeEnvPath) }
const adapterPath = env.CLAUDE_CODEX_ADAPTER || join(repoRoot, 'dist', 'src', 'adapter.mjs')

const checks = []
let runtimeType = null

check('runtime type', () => {
  runtimeType = resolveRuntimeType()
  const source = existsSync(runtimeEnvPath) ? runtimeEnvPath : 'environment'
  return `${runtimeType} (from ${source})`
})

check('node >= 24 with stable node:sqlite', () => {
  // node:sqlite ships flag-gated on Node 22 and stable on Node 24+. The adapter
  // imports it without --experimental-sqlite, so anything older than 24 will
  // crash at runtime even if it advertises a sqlite module.
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) throw new Error(`Node ${process.versions.node} is too old; install Node 24+`)
  requireModule('node:sqlite')
})

check('built adapter starts', () => {
  if (!existsSync(adapterPath)) throw new Error(`${adapterPath} does not exist; run npm run build`)
  // The shim answers the plain startup probe itself; one with client info
  // goes to the adapter, which answers it without opening its state.
  const result = run(env.CLAUDE_CODEX_NODE || 'node', [
    adapterPath,
    'app-server',
    '--print-startup-config',
    '--startup-client-info',
    JSON.stringify({ name: 'claude-codex-doctor', version: '0' }),
  ])
  let version
  try {
    version = JSON.parse(result.stdout).appServerVersion
  } catch {}
  if (typeof version !== 'string')
    throw new Error(`unexpected startup config: ${result.stdout.trim()}`)
  return `appServerVersion ${version}`
})

check('shim version probe', () => {
  const result = run(shimPath, ['--version'], { CLAUDE_CODEX_ADAPTER: adapterPath })
  if (!/codex-cli/.test(result.stdout))
    throw new Error(`unexpected version output: ${result.stdout}`)
})

if (runtimeType === 'agent-sdk-sidecar')
  check('@anthropic-ai/claude-agent-sdk installed', () => {
    // The native TS runtime imports the SDK dynamically; verify it resolves
    // from this package's node_modules.
    const pkgPath = join(repoRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json')
    if (!existsSync(pkgPath)) {
      throw new Error('run npm install - @anthropic-ai/claude-agent-sdk is missing')
    }
  })

if (runtimeType === 'agent-http' || runtimeType === 'agentapi')
  check(`${runtimeType} HTTP endpoint`, () => {
    const url = new URL('/status', httpBaseUrl())
    const result = run(process.execPath, [
      '-e',
      `fetch(${JSON.stringify(url.toString())}).then(async r => { if (!r.ok) throw new Error(await r.text()); console.log(await r.text()) })`,
    ])
    if (!/"status"\s*:/.test(result.stdout))
      throw new Error(`unexpected /status response: ${result.stdout.trim()}`)
  })

if (runtimeType === 'claude-p')
  check('claude-p command', () => {
    const command = env.CLAUDE_CODEX_CLAUDE_P_COMMAND || env.CLAUDE_P || 'claude-p'
    run(command, ['--version'])
  })

if (runtimeType === 'codex' || runtimeType === 'codex-proxy')
  check(
    runtimeType === 'codex' ? 'real Codex passthrough' : 'real Codex CLI for codex-proxy',
    () => {
      const command = resolveRealCodex()
      if (!command) throw new Error('no real codex CLI found; set CODEX_REAL=/abs/path/to/codex')
      return run(command, ['--version']).stdout.trim()
    },
  )

if (runtimeType === 'agent-sdk-sidecar')
  check('Claude auth surface for real smoke', () => {
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) return
    run(resolveClaudeCommand(), ['--version'])
  })

for (const item of checks) {
  const marker = item.ok ? 'ok' : 'fail'
  console.log(`${marker} - ${item.name}${item.message ? `: ${item.message}` : ''}`)
}

if (checks.some((item) => !item.ok)) process.exit(1)

// A check passes unless it throws; a string it returns is shown after the name.
function check(name, fn) {
  try {
    const message = fn()
    checks.push({ name, ok: true, message: typeof message === 'string' ? message : undefined })
  } catch (error) {
    checks.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  })
  if (result.error) throw new Error(`${command}: ${result.error.code || result.error.message}`)
  if (result.status !== 0) {
    const exit = result.signal ? `killed by ${result.signal}` : `exited ${result.status}`
    throw new Error((result.stderr || result.stdout || `${command} ${exit}`).trim())
  }
  return result
}

function requireModule(name) {
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(name)})`], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

// The `KEY=value` / `export KEY="value"` lines `claude-codex-mode set` writes.
// This is not a shell: lines with any other syntax, and values that expand
// `$` or a command, are skipped; for those the doctor may differ from the
// shim, which sources the file.
function readRuntimeEnv(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const values = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = shellWord(match[2])
    if (value !== null) values[match[1]] = value
  }
  return values
}

// One literal shell word, or null for anything that needs a shell.
function shellWord(raw) {
  const single = /^'([^']*)'$/.exec(raw)
  if (single) return single[1]
  const double = /^"((?:[^"\\$`]|\\["\\$`])*)"$/.exec(raw)
  if (double) return double[1].replace(/\\(["\\$`])/g, '$1')
  if (/^[^\s"'\\$`;&|<>()#]*$/.test(raw)) return raw
  return null
}

// Mirrors codex-shim, which runs the real Codex for the native modes of
// CLAUDE_CODEX_ROUTE / CLAUDE_CODEX_RUNTIME_TYPE, and normalizeRuntimeType()
// in src/runtime-config.mts for everything the adapter runs.
function resolveRuntimeType() {
  const route = (env.CLAUDE_CODEX_ROUTE || env.CLAUDE_CODEX_RUNTIME_TYPE || '').trim()
  if (['codex', 'native-codex', 'real-codex', 'native', 'real'].includes(route)) return 'codex'
  if (env.CLAUDE_CODEX_MOCK === '1') return 'mock'
  const raw = (
    env.CLAUDE_CODEX_RUNTIME_TYPE ||
    env.CLAUDE_CODEX_RUNTIME ||
    env.CLAUDE_CODEX_BACKEND ||
    ''
  )
    .trim()
    .toLowerCase()
  if (!raw) return 'agent-sdk-sidecar'
  if (
    [
      'sdk',
      'agent-sdk',
      'agent-sdk-sidecar',
      'sidecar',
      'cloud-agent-sdk',
      'agent-sdk-socket',
      'socket',
      'runtime-socket',
    ].includes(raw)
  )
    return 'agent-sdk-sidecar'
  if (['agent-http', 'channels', 'channel', 'http-channel'].includes(raw)) return 'agent-http'
  if (['agentapi', 'agent-api'].includes(raw)) return 'agentapi'
  if (['claude-p', 'claudep', 'pty-transcript'].includes(raw)) return 'claude-p'
  if (['codex-proxy', 'codex-exec'].includes(raw)) return 'codex-proxy'
  if (raw === 'mock') return 'mock'
  throw new Error(`unknown CLAUDE_CODEX_RUNTIME_TYPE: ${raw}`)
}

// CODEX_REAL, else the first `codex` on PATH that is not this adapter's shim,
// as codex-shim and resolveCodexBinary() in src/util.mts look for it.
function resolveRealCodex() {
  if (env.CODEX_REAL?.trim()) return env.CODEX_REAL.trim()
  for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'codex')
    try {
      if (!statSync(candidate).isFile()) continue
      const head = fileHead(candidate)
      if (head.includes('CLAUDE_CODEX_ADAPTER') || head.includes('claude-codex')) continue
      return candidate
    } catch {}
  }
  return null
}

// The first bytes only: the real codex is a large binary.
function fileHead(path) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(200)
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0))
  } finally {
    closeSync(fd)
  }
}

function httpBaseUrl() {
  const value =
    env.CLAUDE_CODEX_HTTP_BASE_URL ||
    env.CLAUDE_CODEX_AGENT_HTTP_URL ||
    env.CLAUDE_CODEX_AGENTAPI_URL ||
    'http://127.0.0.1:3284'
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveClaudeCommand() {
  return env.CLAUDE_CODEX_CLI || 'claude'
}
