import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  claudeCodeAtLeast,
  codexProxyModelOptions,
  debugLog,
  defaultSocketPath,
  isPathInside,
  newThreadId,
  resolveCodexBinary,
  threadVisualizationDir,
} from '../src/util.mjs'

test('newThreadId issues UUIDv7 ids that carry their creation time', () => {
  const before = Date.now()
  const ids = Array.from({ length: 64 }, () => newThreadId())
  const after = Date.now()
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const created = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
    assert.ok(created >= before && created <= after, id)
  }
})

test('threadVisualizationDir follows the App layout for UUIDv7 ids only', () => {
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = '/tmp/codex-home'
  try {
    // Created 2026-10-16T23:55Z: the folder takes the UTC date.
    const id = '01a14723-f020-7000-8000-0123456789ab'
    assert.equal(
      threadVisualizationDir(id),
      join('/tmp/codex-home', 'visualizations', '2026', '10', '16', id),
    )
    assert.equal(threadVisualizationDir('3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'), null)
    assert.equal(threadVisualizationDir('thread-1'), null)
  } finally {
    if (previous == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
  }
})

test('claudeCodeAtLeast compares Claude Code versions and treats an unreadable one as new enough', () => {
  assert.equal(claudeCodeAtLeast('2.1.287', '2.1.287'), true)
  assert.equal(claudeCodeAtLeast('2.1.286', '2.1.287'), false)
  assert.equal(claudeCodeAtLeast('2.1.300', '2.1.287'), true)
  assert.equal(claudeCodeAtLeast('2.2.0', '2.1.292'), true)
  assert.equal(claudeCodeAtLeast('1.9.999', '2.1.292'), false)
  assert.equal(claudeCodeAtLeast('2.1.10', '2.1.9'), true)
  assert.equal(claudeCodeAtLeast('v2.1.291 (Claude Code)', '2.1.292'), false)
  assert.equal(claudeCodeAtLeast('2.1.292-beta.1', '2.1.292'), true)
  for (const unknown of [null, undefined, '', 'dev', '2.1']) {
    assert.equal(claudeCodeAtLeast(unknown, '2.1.292'), true, String(unknown))
  }
})

test('isPathInside accepts strict descendants only', () => {
  assert.equal(isPathInside('/a/b', '/a/b/c.md'), true)
  assert.equal(isPathInside('/a/b', '/a/b'), false)
  assert.equal(isPathInside('/a/b', '/a/bc/d'), false)
  assert.equal(isPathInside('/a/b', '/a/b/../c'), false)
  assert.equal(isPathInside('/a/b', '/a/b/..c/d'), true)
})

test('defaultSocketPath takes CLAUDE_CODEX_SOCKET_PATH over CODEX_HOME', () => {
  const keys = ['CODEX_HOME', 'CLAUDE_CODEX_SOCKET_PATH'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.CODEX_HOME = '/tmp/codex-home'
  try {
    process.env.CLAUDE_CODEX_SOCKET_PATH = '/run/claude-codex/app-server.sock'
    assert.equal(defaultSocketPath(), '/run/claude-codex/app-server.sock')
    // A relative path resolves against the working directory.
    process.env.CLAUDE_CODEX_SOCKET_PATH = ' run/app-server.sock '
    assert.equal(defaultSocketPath(), resolve('run/app-server.sock'))
    // Blank means unset.
    process.env.CLAUDE_CODEX_SOCKET_PATH = '  '
    assert.equal(
      defaultSocketPath(),
      join('/tmp/codex-home', 'app-server-control', 'app-server-control.sock'),
    )
  } finally {
    for (const key of keys) {
      const value = previous[key]
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('resolveCodexBinary prefers CODEX_REAL over PATH and homedir fallbacks', async () => {
  const previous = process.env.CODEX_REAL
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-util-'))
  const binary = join(directory, 'codex.real')
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.CODEX_REAL = binary
  try {
    assert.equal(resolveCodexBinary(), binary)
  } finally {
    if (previous == null) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test('codexProxyModelOptions reads the model catalog under CODEX_HOME', async () => {
  const keys = [
    'CODEX_HOME',
    'CODEX_REAL',
    'CLAUDE_CODEX_MOCK',
    'CLAUDE_CODEX_DISABLE_CODEX_PROXY',
    'CLAUDE_CODEX_CODEX_MODELS',
  ] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-util-'))
  const binary = join(directory, 'codex.real')
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(
    join(directory, 'model_catalog.json'),
    JSON.stringify({ models: [{ slug: 'gpt-from-codex-home' }] }),
  )
  for (const key of keys) delete process.env[key]
  process.env.CODEX_HOME = directory
  process.env.CODEX_REAL = binary
  try {
    assert.deepEqual(
      codexProxyModelOptions().map((option) => option.id),
      ['gpt-from-codex-home'],
    )
  } finally {
    for (const key of keys) {
      const value = previous[key]
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})

// Runs `body` with the debug-log env knobs set, restoring them afterwards.
async function withDebugLogEnv(
  env: Record<string, string>,
  body: (dir: string) => void | Promise<void>,
): Promise<void> {
  const names = [
    'CLAUDE_CODEX_DEBUG_LOG',
    'CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES',
    'CLAUDE_CODEX_DEBUG_LOG_KEEP',
  ]
  const previous = names.map((name) => process.env[name])
  const dir = await mkdtemp(join(tmpdir(), 'ccx-debuglog-'))
  for (const name of names) delete process.env[name]
  for (const [name, value] of Object.entries(env)) process.env[name] = value.replace('<dir>', dir)
  try {
    await body(dir)
  } finally {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]
      else process.env[name] = previous[i]
    })
    await rm(dir, { recursive: true, force: true })
  }
}

function logEvents(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).event)
}

test('debugLog rotates at the size limit and keeps only CLAUDE_CODEX_DEBUG_LOG_KEEP old logs', async () => {
  await withDebugLogEnv(
    {
      CLAUDE_CODEX_DEBUG_LOG: '<dir>/logs/debug.jsonl',
      CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES: '400',
      CLAUDE_CODEX_DEBUG_LOG_KEEP: '2',
    },
    (dir) => {
      const path = join(dir, 'logs', 'debug.jsonl')
      for (let i = 0; i < 40; i += 1) debugLog(`event.${i}`, { i })
      assert.ok(existsSync(`${path}.1`))
      assert.ok(existsSync(`${path}.2`))
      assert.equal(existsSync(`${path}.3`), false)
      const lineBytes = (readFileSync(path, 'utf8').split('\n')[0]?.length ?? 0) + 1
      for (const file of [path, `${path}.1`, `${path}.2`]) {
        assert.ok(statSync(file).size < 400 + lineBytes, file)
      }
      // Nothing is lost or reordered across the files that are kept.
      const kept = [...logEvents(`${path}.2`), ...logEvents(`${path}.1`), ...logEvents(path)]
      assert.equal(kept.at(-1), 'event.39')
      const first = Number(kept[0]?.split('.')[1])
      assert.deepEqual(
        kept,
        Array.from({ length: 40 - first }, (_, i) => `event.${first + i}`),
      )
    },
  )
})

test('debugLog writes nothing when CLAUDE_CODEX_DEBUG_LOG is 0 or false', async () => {
  for (const off of ['0', 'false']) {
    await withDebugLogEnv({ CLAUDE_CODEX_DEBUG_LOG: off }, (dir) => {
      const home = process.env.CLAUDE_CODEX_HOME
      process.env.CLAUDE_CODEX_HOME = dir
      try {
        debugLog('ignored')
      } finally {
        if (home === undefined) delete process.env.CLAUDE_CODEX_HOME
        else process.env.CLAUDE_CODEX_HOME = home
      }
      assert.equal(existsSync(join(dir, 'debug.jsonl')), false)
    })
  }
})

test('debugLog recreates its folder when it is removed while running', async () => {
  await withDebugLogEnv({ CLAUDE_CODEX_DEBUG_LOG: '<dir>/logs/debug.jsonl' }, async (dir) => {
    const path = join(dir, 'logs', 'debug.jsonl')
    debugLog('before')
    await rm(join(dir, 'logs'), { recursive: true, force: true })
    debugLog('after')
    assert.deepEqual(logEvents(path), ['after'])
  })
})

test('debugLog notices another writer growing the log and still rotates it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withDebugLogEnv(
    { CLAUDE_CODEX_DEBUG_LOG: '<dir>/debug.jsonl', CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES: '1000' },
    (dir) => {
      const path = join(dir, 'debug.jsonl')
      debugLog('mine.1')
      // A second adapter process appends to the same file.
      appendFileSync(path, `${JSON.stringify({ event: 'other', pad: 'x'.repeat(2000) })}\n`)
      t.mock.timers.tick(1000)
      debugLog('mine.2')
      assert.deepEqual(logEvents(`${path}.1`), ['mine.1', 'other'])
      assert.deepEqual(logEvents(path), ['mine.2'])
    },
  )
})
