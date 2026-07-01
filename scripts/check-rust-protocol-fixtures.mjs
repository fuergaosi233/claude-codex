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
    file: 'config-read.request.json',
    kind: 'request',
    method: 'config/read',
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
  {
    file: 'config-read.response.json',
    kind: 'response',
    requestMethod: 'config/read',
    schemaFile: 'ClientRequest.ts',
  },
]

const unsupportedCredentialSources =
  'personal-session browser-cookie session-token personal-subscription credential-sharing credential-pooling subscription-pooling private-proxy provider-bypass oauth-session cli-session-export'.split(
    ' ',
  )

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
    validateResponseFixture(fixture, body)
    return
  }

  fail(`${fixture.file} has unknown fixture kind ${fixture.kind}`)
}

function validateResponseFixture(fixture, body) {
  if (fixture.requestMethod === 'mcpServerStatus/list') {
    validateMcpStatusResponse(fixture.file, body)
    return
  }
  if (fixture.requestMethod === 'config/read') {
    validateConfigReadResponse(fixture.file, body)
    return
  }
  fail(`${fixture.file} has unknown response request method ${fixture.requestMethod}`)
}

function validateMcpStatusResponse(file, body) {
  if (!Array.isArray(body.result.data)) fail(`${file} result.data is not an array`)
  if (body.result.data.length === 0) fail(`${file} result.data is empty`)
  const [entry] = body.result.data
  for (const field of ['name', 'tools', 'resources', 'resourceTemplates', 'authStatus']) {
    if (!Object.hasOwn(entry, field)) fail(`${file} entry is missing ${field}`)
  }
  if (Object.hasOwn(entry, 'status')) fail(`${file} entry must not contain status`)
}

function validateConfigReadResponse(file, body) {
  const providerLoopConfig = body.result.config?.provider_loop_config
  if (!providerLoopConfig || typeof providerLoopConfig !== 'object') {
    fail(`${file} is missing result.config.provider_loop_config`)
  }
  if (!Array.isArray(providerLoopConfig.providers)) {
    fail(`${file} provider_loop_config.providers is not an array`)
  }
  const providerIds = providerLoopConfig.providers.map((provider) => provider?.id)
  if (JSON.stringify(providerIds) !== JSON.stringify(['claude-code', 'codex'])) {
    fail(`${file} provider ids are not claude-code,codex in stable order`)
  }
  if (!Array.isArray(providerLoopConfig.issues) || providerLoopConfig.issues.length !== 0) {
    fail(`${file} provider_loop_config.issues is not empty`)
  }

  const claudeCode = providerLoopConfig.providers.find((provider) => provider.id === 'claude-code')
  if (!claudeCode) fail(`${file} is missing claude-code provider`)
  if (claudeCode.providerFamily !== 'anthropic') {
    fail(`${file} claude-code providerFamily is not anthropic`)
  }
  if (claudeCode.loopId !== 'native-claude-code-sdk') {
    fail(`${file} claude-code loopId is not native-claude-code-sdk`)
  }
  if (claudeCode.status !== 'stable') fail(`${file} claude-code status is not stable`)
  if (claudeCode.supportsSteer !== true) fail(`${file} claude-code supportsSteer is not true`)
  if (!Array.isArray(claudeCode.allowedCredentialSources)) {
    fail(`${file} claude-code allowedCredentialSources is not an array`)
  }
  if (!claudeCode.allowedCredentialSources.includes('user-api-key')) {
    fail(`${file} claude-code allowedCredentialSources is missing user-api-key`)
  }
  for (const unsupported of unsupportedCredentialSources) {
    if (claudeCode.allowedCredentialSources.includes(unsupported)) {
      fail(`${file} projects unsupported credential source as allowed: ${unsupported}`)
    }
  }
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
