import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexProxyRuntime } from '../src/codex-proxy-runtime.mjs'
import type { RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

// A stand-in for the real Codex CLI: logs its argv and cwd, then plays one
// short turn as `codex exec --json` JSONL.
const fakeCodex = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
for (const line of [
  { type: 'thread.started', thread_id: 'sess-123' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hello' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
]) console.log(JSON.stringify(line))
`

test('codex-proxy resumed turns keep the thread cwd, sandbox mode and --add-dir roots', async () => {
  const keys = ['CODEX_REAL', 'FAKE_CODEX_LOG'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-proxy-'))
  const project = join(directory, 'project')
  const extra = join(directory, 'extra')
  const log = join(directory, 'log')
  const binary = join(directory, 'codex.mjs')
  await writeFile(binary, fakeCodex, { mode: 0o755 })
  await writeFile(log, '')
  process.env.CODEX_REAL = binary
  process.env.FAKE_CODEX_LOG = log
  try {
    const runtime = new CodexProxyRuntime()
    const handlers = {
      onEvent: () => {},
      onPermissionRequest: async () => ({ behavior: 'deny' }),
    } as unknown as RuntimeHandlers
    const base = {
      threadId: 't1',
      prompt: 'hi',
      promptContext: [],
      cwd: project,
      model: 'gpt-5',
      sandboxMode: 'workspace-write',
      addDirs: [extra],
      imageInputs: [],
    }
    await runtime.runTurn(
      { ...base, turnId: 'u1', claudeSessionId: null } as unknown as RuntimeTurnContext,
      handlers,
    )
    await runtime.runTurn(
      { ...base, turnId: 'u2', claudeSessionId: 'sess-123' } as unknown as RuntimeTurnContext,
      handlers,
    )
    const runs = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[] })
    const [first, second] = runs
    assert.ok(first && second && runs.length === 2)
    const resumed = second.argv
    const resume = resumed.indexOf('resume')
    assert.ok(resume > 0, `resume missing: ${JSON.stringify(resumed)}`)
    assert.equal(resumed[resume + 1], 'sess-123')
    // codex exec takes -C, -s and --add-dir only before the resume subcommand,
    // so a resumed turn repeats the first turn's exec flags there.
    assert.deepEqual(resumed.slice(0, resume), first.argv.slice(0, -1))
    assert.deepEqual(resumed.slice(resume - 4, resume), ['-C', project, '--add-dir', extra])
    assert.equal(resumed[resumed.indexOf('-s') + 1], 'workspace-write')
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await rm(directory, { recursive: true, force: true })
  }
})
