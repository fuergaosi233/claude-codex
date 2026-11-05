import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const adapter = resolve('dist/src/adapter.mjs')

// Runs `app-server` with a fresh CODEX_HOME so the state database it would
// open is easy to look for.
async function runAppServer(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-cli-test-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  }
  delete env.CLAUDE_CODEX_HOME
  try {
    const result = spawnSync(process.execPath, [adapter, 'app-server', ...args], {
      env,
      encoding: 'utf8',
      input: '',
      timeout: 15_000,
    })
    const stateDb = existsSync(join(home, 'claude-codex-adapter', 'state.sqlite'))
    return { ...result, stateDb }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('a bad --listen exits 1 with one line before opening the state database', async () => {
  for (const [args, message] of [
    [['--listen', 'tcp://x'], 'unsupported listen URL: tcp://x'],
    [['--listen=tcp://127.0.0.1:1'], 'unsupported listen URL: tcp://127.0.0.1:1'],
    [['--listen', 'ws://127.0.0.1:abc'], 'unsupported listen URL: ws://127.0.0.1:abc'],
    [['--listen'], '--listen needs a value'],
    [['--listen', '--ws-auth', 'none'], '--listen needs a value'],
  ] as const) {
    const result = await runAppServer([...args])
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stderr, `[claude-codex-adapter] ${message}\n`, args.join(' '))
    assert.doesNotMatch(result.stderr, /^ {4}at /m)
    assert.equal(result.stateDb, false, `${args.join(' ')} opened the state database`)
  }
})

test('--listen off still exits 0 without opening the state database', async () => {
  const result = await runAppServer(['--listen', 'off'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(result.stateDb, false)
})
