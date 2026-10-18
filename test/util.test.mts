import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  codexProxyModelOptions,
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

test('isPathInside accepts strict descendants only', () => {
  assert.equal(isPathInside('/a/b', '/a/b/c.md'), true)
  assert.equal(isPathInside('/a/b', '/a/b'), false)
  assert.equal(isPathInside('/a/b', '/a/bc/d'), false)
  assert.equal(isPathInside('/a/b', '/a/b/../c'), false)
  assert.equal(isPathInside('/a/b', '/a/b/..c/d'), true)
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
