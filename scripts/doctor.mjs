#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const checks = []
const runtimeType = resolveRuntimeType()

check('node >= 24 with stable node:sqlite', () => {
  // node:sqlite ships flag-gated on Node 22 and stable on Node 24+. The adapter
  // imports it without --experimental-sqlite, so anything older than 24 will
  // crash at runtime even if it advertises a sqlite module.
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) throw new Error(`Node ${process.versions.node} is too old; install Node 24+`)
  requireModule('node:sqlite')
})

check('built adapter exists', () => {
  const adapter = process.env.CLAUDE_CODEX_ADAPTER || resolve('dist/src/adapter.mjs')
  if (!existsSync(adapter)) throw new Error(`${adapter} does not exist; run npm run build`)
})

check('shim version probe', () => {
  const result = run(resolve('scripts/codex-shim'), ['--version'], { CLAUDE_CODEX_ADAPTER: process.env.CLAUDE_CODEX_ADAPTER || resolve('dist/src/adapter.mjs') })
  if (!/codex-cli/.test(result.stdout)) throw new Error(`unexpected version output: ${result.stdout}`)
})

if (runtimeType === 'agent-sdk-sidecar' || runtimeType === 'agent-sdk-socket') check('python >= 3.10', () => {
  const python = resolvePythonCommand()
  const result = run(python, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'])
  const [major, minor] = result.stdout.trim().split('.').map(Number)
  if (major < 3 || (major === 3 && minor < 10)) throw new Error(`${python} is ${result.stdout.trim()}, need 3.10+`)
})

if (runtimeType === 'agent-sdk-sidecar' || runtimeType === 'agent-sdk-socket') check('claude_agent_sdk import', () => {
  const python = resolvePythonCommand()
  run(python, ['-c', 'import claude_agent_sdk; print(getattr(claude_agent_sdk, "__version__", "unknown"))'])
})

if (runtimeType === 'agent-http' || runtimeType === 'agentapi') check(`${runtimeType} HTTP endpoint`, () => {
  const url = new URL('/status', httpBaseUrl())
  const result = run(process.execPath, ['-e', `fetch(${JSON.stringify(url.toString())}).then(async r => { if (!r.ok) throw new Error(await r.text()); console.log(await r.text()) })`])
  if (!/"status"\s*:/.test(result.stdout)) throw new Error(`unexpected /status response: ${result.stdout.trim()}`)
})

if (runtimeType === 'claude-p') check('claude-p command', () => {
  const command = process.env.CLAUDE_CODEX_CLAUDE_P_COMMAND || process.env.CLAUDE_P || 'claude-p'
  run(command, ['--version'])
})

if (runtimeType === 'codex') check('real Codex passthrough', () => {
  const command = process.env.CODEX_REAL || 'codex'
  run(command, ['--version'])
})

if (runtimeType === 'agent-sdk-sidecar' || runtimeType === 'agent-sdk-socket') check('Claude auth surface for real smoke', () => {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return
  run(resolveClaudeCommand(), ['--version'])
})

for (const item of checks) {
  const marker = item.ok ? 'ok' : 'fail'
  console.log(`${marker} - ${item.name}${item.message ? `: ${item.message}` : ''}`)
}

if (checks.some((item) => !item.ok)) process.exit(1)

function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim())
  }
  return result
}

function requireModule(name) {
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(name)})`], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function resolveRuntimeType() {
  if (process.env.CLAUDE_CODEX_MOCK === '1') return 'mock'
  const raw = (process.env.CLAUDE_CODEX_RUNTIME_TYPE || process.env.CLAUDE_CODEX_RUNTIME || process.env.CLAUDE_CODEX_BACKEND || '').trim().toLowerCase()
  if (!raw && process.env.CLAUDE_CODEX_RUNTIME_SOCKET) return 'agent-sdk-socket'
  if (!raw) return 'agent-sdk-sidecar'
  if (['sdk', 'agent-sdk', 'agent-sdk-sidecar', 'sidecar', 'cloud-agent-sdk'].includes(raw)) return 'agent-sdk-sidecar'
  if (['agent-sdk-socket', 'socket', 'runtime-socket'].includes(raw)) return 'agent-sdk-socket'
  if (['agent-http', 'channels', 'channel', 'http-channel'].includes(raw)) return 'agent-http'
  if (['agentapi', 'agent-api'].includes(raw)) return 'agentapi'
  if (['claude-p', 'claudep', 'pty-transcript'].includes(raw)) return 'claude-p'
  if (['codex', 'native-codex', 'real-codex', 'native', 'real'].includes(raw)) return 'codex'
  if (raw === 'mock') return 'mock'
  throw new Error(`unknown CLAUDE_CODEX_RUNTIME_TYPE: ${raw}`)
}

function httpBaseUrl() {
  const value =
    process.env.CLAUDE_CODEX_HTTP_BASE_URL ||
    process.env.CLAUDE_CODEX_AGENT_HTTP_URL ||
    process.env.CLAUDE_CODEX_AGENTAPI_URL ||
    'http://127.0.0.1:3284'
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolvePythonCommand() {
  const candidates = [
    process.env.CLAUDE_CODEX_PYTHON,
    resolve('.venv/bin/python'),
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    const result = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], { encoding: 'utf8' })
    if (result.status === 0) return candidate
  }
  return process.env.CLAUDE_CODEX_PYTHON || 'python3'
}

function resolveClaudeCommand() {
  return process.env.CLAUDE_CODEX_CLI || 'claude'
}
