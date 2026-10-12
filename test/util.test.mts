import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { codexProxyModelOptions, resolveCodexBinary } from '../src/util.mjs'

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
