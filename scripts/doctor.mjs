#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const checks = []

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

check('@anthropic-ai/claude-agent-sdk installed', () => {
  // The native TS runtime imports the SDK dynamically; verify it resolves
  // from this package's node_modules.
  const pkgPath = resolve('node_modules/@anthropic-ai/claude-agent-sdk/package.json')
  if (!existsSync(pkgPath)) {
    throw new Error('run npm install — @anthropic-ai/claude-agent-sdk is missing')
  }
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
