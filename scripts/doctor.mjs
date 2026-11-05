#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Paths come from this script's location, so the doctor checks this checkout
// whatever the working directory is.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shimPath = join(repoRoot, 'scripts', 'codex-shim')

// Every variable resolveRuntimeType() reads.
const RUNTIME_TYPE_KEYS = [
  'CLAUDE_CODEX_ROUTE',
  'CLAUDE_CODEX_RUNTIME_TYPE',
  'CLAUDE_CODEX_MOCK',
  'CLAUDE_CODEX_RUNTIME',
  'CLAUDE_CODEX_BACKEND',
]

const runtimeEnvPath =
  process.env.CLAUDE_CODEX_RUNTIME_ENV || join(homedir(), '.claude-codex', 'runtime.env')
// The shim sources the runtime env file over its own environment, so the
// file's assignments win, as they do there.
const runtimeEnv = readRuntimeEnv(runtimeEnvPath)
const env = { ...process.env, ...runtimeEnv.values }
const adapterPath = env.CLAUDE_CODEX_ADAPTER || join(repoRoot, 'dist', 'src', 'adapter.mjs')

const checks = []
let runtimeType = null

check('runtime type', () => {
  // A line the doctor cannot evaluate may set the runtime differently in the
  // shim, so a guess from the rest would be a false ok.
  const unread = runtimeEnv.skipped.filter((item) =>
    RUNTIME_TYPE_KEYS.some((key) => item.text.includes(key)),
  )
  if (unread.length > 0)
    throw new Error(
      `cannot read ${unread.map((item) => `${item.key} (line ${item.line})`).join(', ')} ` +
        `in ${runtimeEnvPath}; write it as KEY="value"`,
    )
  const resolved = resolveRuntimeType()
  runtimeType = resolved.type
  const source = !resolved.key
    ? 'default'
    : `from ${resolved.key in runtimeEnv.values ? runtimeEnvPath : 'environment'}`
  return `${runtimeType} (${source})`
})

if (runtimeEnv.skipped.length > 0)
  check('runtime env file', () => {
    // Not a failure: the shim may read them fine. The checks below use the
    // environment's values for these keys instead.
    const lines = runtimeEnv.skipped.map((item) => `${item.key} (line ${item.line})`)
    return `skipped lines the doctor cannot evaluate: ${lines.join(', ')}`
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
      // The shim runs the real Codex in the native mode; the adapter runs
      // it for codex-proxy, and the two look for it differently.
      const command = runtimeType === 'codex' ? shimRealCodex() : adapterRealCodex()
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

// The `KEY=value` / `export KEY="value"` lines `claude-codex-mode set` writes,
// with an optional trailing `# comment`. This is not a shell: lines that
// expand `$`, run a command or use any other syntax are not evaluated; they
// are returned as `skipped`, because there the doctor may differ from the
// shim, which sources the file.
function readRuntimeEnv(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { values: {}, skipped: [] }
  }
  const values = {}
  const skipped = []
  text.split('\n').forEach((line, index) => {
    if (/^\s*(?:#.*)?$/.test(line)) return
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(line)
    if (!match) {
      skipped.push({ key: line.trim().split(/[\s=]/)[0], line: index + 1, text: line })
      return
    }
    const value = shellWord(match[2])
    if (value === null) skipped.push({ key: match[1], line: index + 1, text: line })
    else values[match[1]] = value
  })
  return { values, skipped }
}

// One literal shell word, then an optional comment; null for anything that
// needs a shell.
function shellWord(raw) {
  const word = /^('[^']*'|"(?:[^"\\$`]|\\["\\$`])*"|[^\s"'\\$`;&|<>()#]*)(?:\s+#.*)?$/.exec(raw)
  if (!word) return null
  const value = word[1]
  if (value.startsWith("'")) return value.slice(1, -1)
  if (value.startsWith('"')) return value.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  // Unquoted, the shell expands a leading `~` or `~/` to HOME; `~user` and a
  // `~` after `:` need a shell.
  if (/^~(?:\/|$)/.test(value)) return homedir() + value.slice(1)
  if (value.includes('~')) return null
  return value
}

// Mirrors codex-shim, which runs the real Codex for the native modes of
// CLAUDE_CODEX_ROUTE / CLAUDE_CODEX_RUNTIME_TYPE, and normalizeRuntimeType()
// in src/runtime-config.mts for everything the adapter runs. Returns the type
// and the variable that set it (none for the default).
function resolveRuntimeType() {
  const routeKey = ['CLAUDE_CODEX_ROUTE', 'CLAUDE_CODEX_RUNTIME_TYPE'].find((key) => env[key])
  const route = (routeKey ? env[routeKey] : '').trim()
  if (['codex', 'native-codex', 'real-codex', 'native', 'real'].includes(route))
    return { type: 'codex', key: routeKey }
  if (env.CLAUDE_CODEX_MOCK === '1') return { type: 'mock', key: 'CLAUDE_CODEX_MOCK' }
  const key = ['CLAUDE_CODEX_RUNTIME_TYPE', 'CLAUDE_CODEX_RUNTIME', 'CLAUDE_CODEX_BACKEND'].find(
    (name) => env[name],
  )
  const type = normalizeRuntimeType((key ? env[key] : '').trim().toLowerCase())
  return { type, key }
}

function normalizeRuntimeType(raw) {
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

// As resolve_real_codex in codex-shim: CODEX_REAL if it is executable, else
// the first executable `codex` on PATH that is not the shim. The doctor also
// skips other copies of the shim, which it cannot tell from the one in use.
function shimRealCodex() {
  const explicit = env.CODEX_REAL
  if (explicit && isExecutable(explicit)) return explicit
  let self = shimPath
  try {
    self = realpathSync(shimPath)
  } catch {}
  return pathCodex((candidate) => {
    if (!isExecutable(candidate)) return false
    try {
      return realpathSync(candidate) !== self
    } catch {
      return false
    }
  })
}

// As resolveCodexBinary() in src/util.mts: any non-empty CODEX_REAL, then the
// npm-installed binary, then the first file named `codex` on PATH.
function adapterRealCodex() {
  if (env.CODEX_REAL?.trim()) return env.CODEX_REAL.trim()
  const known = join(
    homedir(),
    '.local/node/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex.real',
  )
  if (existsSync(known)) return known
  return pathCodex((candidate) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

// The first `codex` on PATH that passes `accept` and does not look like the
// shim (a script naming the adapter).
function pathCodex(accept) {
  for (const dir of (env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'codex')
    if (!accept(candidate)) continue
    try {
      const head = fileHead(candidate)
      if (head.includes('CLAUDE_CODEX_ADAPTER') || head.includes('claude-codex')) continue
    } catch {
      continue
    }
    return candidate
  }
  return null
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
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
