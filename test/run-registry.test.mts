import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  recordRunEvent,
  redactRunRegistryData,
  runRegistryEntry,
  runRegistryPath,
} from '../src/run-registry.mjs'

test('run registry redacts prompt-like fields and secret-like values', () => {
  const entry = runRegistryEntry('turn.started', {
    threadId: 'thread-a',
    prompt: 'do not store me',
    nested: {
      message: 'token=secret123456789',
      safe: 'model-name',
    },
  })

  assert.equal(entry.prompt, '[redacted]')
  assert.deepEqual(entry.nested, {
    message: 'token=[redacted]',
    safe: 'model-name',
  })
})

test('run registry can be disabled without touching the filesystem', () => {
  const path = runRegistryPath({ CLAUDE_CODEX_RUN_LOG: '0' })
  const result = recordRunEvent(
    'thread.started',
    { threadId: 'thread-a' },
    { CLAUDE_CODEX_RUN_LOG: '0' },
  )

  assert.equal(path, null)
  assert.deepEqual(result, { ok: true, path: null, error: null })
})

test('run registry appends redacted JSONL entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-run-registry-'))
  const path = join(dir, 'runs.jsonl')

  const result = recordRunEvent(
    'turn.completed',
    { threadId: 'thread-a', responseText: 'raw answer', note: 'api_key=secret123456789' },
    { CLAUDE_CODEX_RUN_LOG: path },
  )
  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>

  assert.equal(result.ok, true)
  assert.equal(entry.event, 'turn.completed')
  assert.equal(entry.responseText, '[redacted]')
  assert.equal(entry.note, 'api_key=[redacted]')
})

test('run registry redactor preserves arrays and primitive metadata', () => {
  assert.deepEqual(redactRunRegistryData(['safe', { input: 'hidden' }, 1]), [
    'safe',
    { input: '[redacted]' },
    1,
  ])
})
