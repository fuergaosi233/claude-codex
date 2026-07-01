#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = join(root, 'crates', 'claude-codex-protocol', 'fixtures')
const repoShim = join(root, 'scripts', 'codex-shim')

const fixtures = [
  {
    file: 'initialize.request.json',
    kind: 'request',
    method: 'initialize',
    schemaFile: 'ClientRequest.ts',
  },
  {
    file: 'thread-start.request.json',
    kind: 'request',
    method: 'thread/start',
    schemaFile: 'ClientRequest.ts',
  },
  {
    file: 'turn-started.notification.json',
    kind: 'notification',
    method: 'turn/started',
    schemaFile: 'ServerNotification.ts',
  },
  {
    file: 'turn-completed.notification.json',
    kind: 'notification',
    method: 'turn/completed',
    schemaFile: 'ServerNotification.ts',
  },
  {
    file: 'mcp-server-status-list.response.json',
    kind: 'response',
    requestMethod: 'mcpServerStatus/list',
    schemaFile: 'ClientRequest.ts',
  },
]

function fail(message) {
  console.error(`rust protocol fixture drift check failed: ${message}`)
  process.exit(1)
}

function readFixture(file) {
  const path = join(fixturesDir, file)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateFixture(fixture) {
  const body = readFixture(fixture.file)
  if (body?.jsonrpc !== '2.0') fail(`${fixture.file} is not a JSON-RPC 2.0 envelope`)

  if (fixture.kind === 'request') {
    if (body.method !== fixture.method) fail(`${fixture.file} method is not ${fixture.method}`)
    if (body.id == null) fail(`${fixture.file} is missing request id`)
    if (!Object.hasOwn(body, 'params')) fail(`${fixture.file} is missing params`)
    return
  }

  if (fixture.kind === 'notification') {
    if (body.method !== fixture.method) fail(`${fixture.file} method is not ${fixture.method}`)
    if (Object.hasOwn(body, 'id')) fail(`${fixture.file} notification must not contain id`)
    if (!Object.hasOwn(body, 'params')) fail(`${fixture.file} is missing params`)
    return
  }

  if (fixture.kind === 'response') {
    if (body.id == null) fail(`${fixture.file} is missing response id`)
    if (!body.result || typeof body.result !== 'object') fail(`${fixture.file} is missing result`)
    if (!Array.isArray(body.result.data)) fail(`${fixture.file} result.data is not an array`)
    if (body.result.data.length === 0) fail(`${fixture.file} result.data is empty`)
    const [entry] = body.result.data
    for (const field of ['name', 'tools', 'resources', 'resourceTemplates', 'authStatus']) {
      if (!Object.hasOwn(entry, field)) fail(`${fixture.file} entry is missing ${field}`)
    }
    if (Object.hasOwn(entry, 'status')) fail(`${fixture.file} entry must not contain status`)
    return
  }

  fail(`${fixture.file} has unknown fixture kind ${fixture.kind}`)
}

function executableExists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function looksLikeAdapterShim(path) {
  try {
    const stat = statSync(path)
    if (stat.size > 128_000) return false
    const text = readFileSync(path, 'utf8')
    return (
      text.includes('CLAUDE_CODEX_ADAPTER') ||
      text.includes('codex shim') ||
      text.includes('CODEX_REAL')
    )
  } catch {
    return false
  }
}

function commandPath(command) {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function resolveGenerator() {
  const explicit = process.env.CODEX_REAL?.trim()
  const candidate = explicit || commandPath('codex')
  if (!candidate) {
    fail('CODEX_REAL is unset and no codex binary was found on PATH')
  }
  if (!executableExists(candidate)) fail(`generator is not executable: ${candidate}`)

  const realCandidate = realpathSync(candidate)
  const realShim = existsSync(repoShim) ? realpathSync(repoShim) : repoShim
  if (realCandidate === realShim || basename(realCandidate) === 'codex-shim') {
    fail(`refusing to use repository codex shim as schema generator: ${candidate}`)
  }

  if (!explicit) {
    if (looksLikeAdapterShim(candidate)) {
      fail(`CODEX_REAL is unset and PATH codex looks like an adapter shim: ${candidate}`)
    }
    const version = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (version.status !== 0 || !/\bcodex-cli\b/.test(`${version.stdout}\n${version.stderr}`)) {
      fail('CODEX_REAL is unset and PATH codex does not identify as the real codex-cli')
    }
  }

  return candidate
}

function generateSchema(generator, outDir) {
  const result = spawnSync(
    generator,
    ['app-server', 'generate-ts', '--experimental', '--out', outDir],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    fail(
      [`schema generation exited ${result.status}`, result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join('\n'),
    )
  }
  const clientRequest = join(outDir, 'ClientRequest.ts')
  const serverNotification = join(outDir, 'ServerNotification.ts')
  if (!existsSync(clientRequest) || !existsSync(serverNotification)) {
    fail(
      'schema generation exited 0 but did not emit ClientRequest.ts and ServerNotification.ts; this usually means an adapter shim handled app-server instead of the real Codex CLI. Set CODEX_REAL to the real codex binary.',
    )
  }
  return {
    'ClientRequest.ts': readFileSync(clientRequest, 'utf8'),
    'ServerNotification.ts': readFileSync(serverNotification, 'utf8'),
  }
}

function methodLiteral(method) {
  return `"method": "${method}"`
}

function validateSchema(fixturesByFile) {
  for (const fixture of fixtures) {
    const schema = fixturesByFile[fixture.schemaFile]
    const method = fixture.method ?? fixture.requestMethod
    if (!schema.includes(methodLiteral(method))) {
      fail(`${method} is missing from generated ${fixture.schemaFile}`)
    }
  }
}

for (const fixture of fixtures) validateFixture(fixture)

const generator = resolveGenerator()
const outDir = mkdtempSync(join(tmpdir(), 'claude-codex-schema-'))
try {
  const generated = generateSchema(generator, outDir)
  validateSchema(generated)
  console.log(`Rust protocol fixtures match generated Codex app-server methods using ${generator}`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
