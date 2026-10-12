#!/usr/bin/env node

// Checks a Codex desktop App build against what the adapter assumes about it,
// before the build joins VERIFIED_APP_VERSIONS in src/app-compat.mts:
//
// - the app-server protocol its bundled codex generates (methods the App may
//   call that the adapter has no case for, methods the adapter sends that the
//   schema no longer has);
// - the App's feature-gate table and minimum app-server version, against the
//   version the adapter reports;
// - the clientInfo name the App sends in initialize;
// - the App rules, which only a person can re-check.
//
// The comparison is with scripts/app-baseline.json (the last verified build),
// or with another App bundle given as --old.
//
//   npm run check:app-upgrade -- --app /Applications/Codex.app
//   npm run check:app-upgrade -- --app <new.app> --old <old.app>
//   npm run check:app-upgrade -- --app <verified.app> --write-baseline

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    old: { type: 'string' },
    codex: { type: 'string' },
    baseline: { type: 'string', default: join(root, 'scripts', 'app-baseline.json') },
    'write-baseline': { type: 'boolean', default: false },
  },
})

function fail(message) {
  console.error(`check-app-upgrade: ${message}`)
  process.exit(2)
}

const baselinePath = resolve(args.baseline)
if (!args.app) fail('pass the App bundle to check with --app <path/to/Codex.app>')

const { APP_RULES, DESKTOP_CLIENT_NAME, VERIFIED_APP_VERSIONS } = await import(
  join(root, 'dist', 'src', 'app-compat.mjs')
).catch(() => fail('dist/ is missing; run it through `npm run check:app-upgrade`'))
const { codexCompatVersion } = await import(join(root, 'dist', 'src', 'util.mjs'))

// --- App bundle ------------------------------------------------------------

function resourcesDir(app) {
  const mac = join(app, 'Contents', 'Resources')
  if (existsSync(mac)) return mac
  const other = join(app, 'resources')
  if (existsSync(other)) return other
  return app
}

// Reads files straight out of app.asar: a pickled JSON index, then the file
// bodies at offsets relative to the end of that index.
function openAsar(path) {
  const fd = openSync(path, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  readSync(fd, json, 0, jsonSize, 16)
  const index = JSON.parse(json.toString('utf8'))
  const base = 8 + headerSize
  const files = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, path)
      else if (typeof entry.offset === 'string' && !entry.unpacked) files.push({ path, ...entry })
    }
  }
  walk(index, '')
  return {
    files,
    read(file) {
      const body = Buffer.alloc(file.size)
      readSync(fd, body, 0, file.size, base + Number(file.offset))
      return body.toString('latin1')
    },
    close: () => closeSync(fd),
  }
}

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
const KEY = String.raw`[A-Za-z_$][\w$]*`
const GATE_TABLE = new RegExp(
  String.raw`\{(?:${KEY}:\`${VERSION}\`,){8,}${KEY}:\`${VERSION}\`\}`,
  'g',
)
const MINIMUM = new RegExp(String.raw`\`(${VERSION})\`,\w+=\`codex-app-server-version-unsupported:`)
const CLIENT_NAME = /clientInfo:\{name:`([^`]+)`/g

function bundleFacts(app) {
  const asarPath = join(resourcesDir(app), 'app.asar')
  if (!existsSync(asarPath)) fail(`no app.asar under ${app}`)
  const asar = openAsar(asarPath)
  try {
    const pkg = asar.files.find((file) => file.path === 'package.json')
    const appVersion = pkg ? JSON.parse(asar.read(pkg)).version : null
    let gates = null
    let minimum = null
    const clientNames = new Set()
    for (const file of asar.files) {
      if (!file.path.endsWith('.js')) continue
      if (!file.path.startsWith('webview/assets/') && !file.path.startsWith('.vite/build/'))
        continue
      const text = asar.read(file)
      if (text.includes('threadQueue:`')) {
        for (const match of text.matchAll(GATE_TABLE)) {
          const table = Object.fromEntries(
            [...match[0].matchAll(new RegExp(`(${KEY}):\`([^\`]+)\``, 'g'))].map((entry) => [
              entry[1],
              entry[2],
            ]),
          )
          if (
            'threadQueue' in table &&
            (!gates || Object.keys(table).length > Object.keys(gates).length)
          )
            gates = table
        }
      }
      if (!minimum && text.includes('codex-app-server-version-unsupported:'))
        minimum = text.match(MINIMUM)?.[1] ?? null
      if (text.includes('clientInfo:{name:`'))
        for (const match of text.matchAll(CLIENT_NAME)) clientNames.add(match[1])
    }
    return { appVersion, gates, minimum, clientNames: [...clientNames].sort() }
  } finally {
    asar.close()
  }
}

// --- Protocol --------------------------------------------------------------

function looksLikeAdapterShim(path) {
  try {
    if (statSync(path).size > 128_000) return false
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

function codexVersion(path) {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return result.status === 0 && /\bcodex-cli\b/.test(output) ? output.trim() : null
}

// The App's own codex, never an adapter shim installed over it.
function appCodex(app, explicit) {
  const resources = resourcesDir(app)
  const candidates = explicit
    ? [explicit]
    : [
        join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
        join(resources, 'codex.real'),
        join(resources, 'codex'),
        join(resources, 'codex.exe'),
      ]
  for (const candidate of candidates) {
    if (!existsSync(candidate) || looksLikeAdapterShim(candidate)) continue
    const version = codexVersion(candidate)
    if (version) return { path: candidate, version }
  }
  fail(`found no real codex in ${resources}; pass one with --codex`)
}

function protocolFacts(codex) {
  const out = mkdtempSync(join(tmpdir(), 'claude-codex-app-schema-'))
  try {
    const result = spawnSync(
      codex.path,
      ['app-server', 'generate-ts', '--experimental', '--out', out],
      { encoding: 'utf8', env: { ...process.env, CODEX_HOME: out } },
    )
    const methodsIn = (file) => {
      const path = join(out, file)
      if (!existsSync(path)) fail(`${codex.path} generated no ${file}: ${result.stderr.trim()}`)
      return [
        ...new Set(
          [...readFileSync(path, 'utf8').matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]),
        ),
      ].sort()
    }
    const types = {}
    for (const dir of ['', 'v2']) {
      const path = join(out, dir)
      if (!existsSync(path)) continue
      for (const file of readdirSync(path)) {
        if (!file.endsWith('.ts')) continue
        const name = dir ? `${dir}/${file.slice(0, -3)}` : file.slice(0, -3)
        types[name] = createHash('sha256')
          .update(readFileSync(join(path, file)))
          .digest('hex')
          .slice(0, 12)
      }
    }
    return {
      codexVersion: codex.version,
      clientRequests: methodsIn('ClientRequest.ts'),
      serverRequests: methodsIn('ServerRequest.ts'),
      serverNotifications: methodsIn('ServerNotification.ts'),
      types,
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

function facts(app, codexPath) {
  return { ...bundleFacts(app), ...protocolFacts(appCodex(app, codexPath)) }
}

// --- Adapter side ------------------------------------------------------------

function adapterFacts() {
  const handled = new Set()
  const sent = new Set()
  const srcDir = join(root, 'src')
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.mts')) continue
    const text = readFileSync(join(srcDir, file), 'utf8')
    if (file === 'server.mts')
      for (const match of text.matchAll(/case '([A-Za-z][\w/]*)':/g)) handled.add(match[1])
    for (const match of text.matchAll(
      /method: '([a-zA-Z]+(?:\/[a-zA-Z_]+)+|configWarning|error|warning)'/g,
    ))
      sent.add(match[1])
  }
  return { handled, sent }
}

// --- Versions --------------------------------------------------------------

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  }
}

// Semver precedence, as the App compares gate versions.
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return Number.NaN
  for (let i = 0; i < 3; i += 1)
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i]
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

// --- Report ----------------------------------------------------------------

const problems = []
const notes = []

function diff(before, after) {
  const old = new Set(before)
  const now = new Set(after)
  return { added: after.filter((x) => !old.has(x)), removed: before.filter((x) => !now.has(x)) }
}

function list(label, items, describe = (x) => x) {
  if (items.length === 0) return
  console.log(`  ${label}:`)
  for (const item of items) console.log(`    ${describe(item)}`)
}

const next = facts(resolve(args.app), args.codex)
let previous
let previousLabel
if (args.old) {
  previous = facts(resolve(args.old))
  previousLabel = `--old ${previous.appVersion}`
} else if (existsSync(baselinePath)) {
  previous = JSON.parse(readFileSync(baselinePath, 'utf8'))
  previousLabel = `baseline ${previous.appVersion}`
} else if (args['write-baseline']) {
  previous = next
  previousLabel = 'itself (no baseline yet)'
} else {
  fail(`no ${baselinePath}; pass --old or create it with --write-baseline`)
}
const adapter = adapterFacts()
const reported = codexCompatVersion()
const verified = VERIFIED_APP_VERSIONS.includes(next.appVersion)

console.log(
  `Codex App ${next.appVersion} against ${previousLabel}` +
    (verified ? ' (already verified)' : ' (not verified yet)'),
)
console.log(`  codex: ${next.codexVersion}`)

console.log('\nProtocol')
for (const [key, label] of [
  ['clientRequests', 'client requests'],
  ['serverRequests', 'server requests'],
  ['serverNotifications', 'server notifications'],
]) {
  const { added, removed } = diff(previous[key], next[key])
  console.log(`  ${label}: ${next[key].length} (+${added.length} -${removed.length})`)
  if (key === 'clientRequests') {
    list(
      'new, adapter has no case for it',
      added.filter((m) => !adapter.handled.has(m)),
      (m) => `+ ${m}`,
    )
    list(
      'new, already handled',
      added.filter((m) => adapter.handled.has(m)),
      (m) => `+ ${m}`,
    )
  } else {
    list('new', added, (m) => `+ ${m}`)
  }
  list('removed', removed, (m) => `- ${m}`)
}
const unanswered = next.clientRequests.filter((m) => !adapter.handled.has(m))
console.log(
  `  answered with "method not implemented" (${unanswered.length}): ${unanswered.join(', ')}`,
)
const schemaOut = new Set([...next.serverRequests, ...next.serverNotifications])
const previousOut = new Set([...previous.serverRequests, ...previous.serverNotifications])
const gone = [...adapter.sent].filter((m) => !schemaOut.has(m) && previousOut.has(m)).sort()
for (const method of gone)
  problems.push(`the adapter sends ${method}, which the new schema dropped`)
if (previous.types && next.types) {
  const names = diff(Object.keys(previous.types).sort(), Object.keys(next.types).sort())
  const changed = Object.keys(next.types)
    .filter((name) => name in previous.types && previous.types[name] !== next.types[name])
    .sort()
  console.log(
    `  types: ${Object.keys(next.types).length} (+${names.added.length} -${names.removed.length} ~${changed.length})`,
  )
  list('changed', changed, (name) => `~ ${name}`)
  list('removed', names.removed, (name) => `- ${name}`)
}

console.log(`\nFeature gates (adapter reports ${reported})`)
if (!next.gates) {
  problems.push('found no feature-gate table in the bundle; check the gates by hand')
} else {
  const before = previous.gates ?? {}
  for (const [name, version] of Object.entries(next.gates).sort()) {
    const state = compareVersions(reported, version) >= 0 ? 'on ' : 'off'
    const change = !(name in before)
      ? '  (new)'
      : before[name] !== version
        ? `  (was ${before[name]})`
        : ''
    console.log(`  ${state} ${name.padEnd(32)} ${version}${change}`)
  }
  for (const name of Object.keys(before).filter((name) => !(name in next.gates)))
    console.log(`  --  ${name.padEnd(32)} removed`)
  if (compareVersions(reported, next.gates.threadQueue) < 0)
    notes.push(
      `the App keeps queued messages in the window: threadQueue needs ${next.gates.threadQueue}, set CLAUDE_CODEX_COMPAT_VERSION to use the server-side queue`,
    )
}
if (!next.minimum) {
  problems.push('found no minimum app-server version in the bundle; check it by hand')
} else {
  console.log(`  minimum app-server version: ${next.minimum}`)
  if (compareVersions(reported, next.minimum) < 0)
    problems.push(`the App requires app-server ${next.minimum}; the adapter reports ${reported}`)
}

console.log(`\nclientInfo names: ${next.clientNames.join(', ') || '(none found)'}`)
if (!next.clientNames.includes(DESKTOP_CLIENT_NAME))
  problems.push(`the App no longer sends clientInfo.name ${DESKTOP_CLIENT_NAME}`)

console.log('\nApp rules to re-check by hand (src/app-compat.mts, docs/reference/app-compat.md)')
for (const rule of APP_RULES) {
  console.log(`  [ ] ${rule.id}: ${rule.app}`)
  console.log(`      check: ${rule.verify}`)
}

for (const note of notes) console.log(`\nnote: ${note}`)
for (const problem of problems) console.log(`\nproblem: ${problem}`)

if (args['write-baseline']) {
  if (problems.length > 0) fail('not writing a baseline while there are problems')
  if (!verified)
    fail(`add ${next.appVersion} to VERIFIED_APP_VERSIONS before writing it as the baseline`)
  const { types: _types, ...baseline } = next
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
  // Lay it out the way `npm run check` expects.
  const biome = spawnSync(join(root, 'node_modules', '.bin', 'biome'), [
    'format',
    '--write',
    baselinePath,
  ])
  if (biome.status !== 0) console.log(`\nrun \`npx biome format --write ${baselinePath}\``)
  console.log(`\nwrote ${baselinePath}`)
} else if (!verified && problems.length === 0) {
  console.log(
    `\nOnce the rules hold, add ${next.appVersion} to VERIFIED_APP_VERSIONS and rerun with --write-baseline.`,
  )
}

process.exit(problems.length > 0 ? 1 : 0)
