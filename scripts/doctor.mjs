#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const checks = []

check('node >= 22.5 with node:sqlite', () => {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`Node ${process.versions.node} is too old`)
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

check('python >= 3.10', () => {
  const python = resolvePythonCommand()
  const result = run(python, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'])
  const [major, minor] = result.stdout.trim().split('.').map(Number)
  if (major < 3 || (major === 3 && minor < 10)) throw new Error(`${python} is ${result.stdout.trim()}, need 3.10+`)
})

check('claude_agent_sdk import', () => {
  const python = resolvePythonCommand()
  run(python, ['-c', 'import claude_agent_sdk; print(getattr(claude_agent_sdk, "__version__", "unknown"))'])
})

check('Claude auth surface for real smoke', () => {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return
  run('claude', ['--version'])
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
