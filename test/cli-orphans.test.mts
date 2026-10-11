import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseProcessRows, reapOrphanedCliChildren } from '../src/cli-orphans.mjs'

const modulePath = resolve('dist/src/cli-orphans.mjs')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

// A stand-in adapter: it spawns a CLI look-alike (which itself runs a tool
// process), records it, and prints both pids.
function startOwner(dir: string): Promise<{ owner: ChildProcess; cli: number; tool: number }> {
  const script = `
    import { spawn } from 'node:child_process'
    import { recordCliChildren } from ${JSON.stringify(modulePath)}
    const cliCode = "const t = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); console.log(t.pid); setInterval(() => {}, 1000)"
    const cli = spawn(process.execPath, ['-e', cliCode, '--', '--input-format', 'stream-json'], { stdio: ['ignore', 'pipe', 'ignore'] })
    cli.stdout.once('data', async (chunk) => {
      await recordCliChildren(${JSON.stringify(dir)})
      console.log(JSON.stringify({ cli: cli.pid, tool: Number(String(chunk).trim()) }))
    })
    setInterval(() => {}, 1000)
  `
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolvePids, reject) => {
    owner.stdout.setEncoding('utf8')
    owner.stdout.once('data', (line: string) => {
      try {
        resolvePids({ owner, ...JSON.parse(line) })
      } catch (error) {
        reject(error)
      }
    })
    owner.once('exit', () => reject(new Error('owner exited early')))
  })
}

test('reapOrphanedCliChildren stops the CLI tree of a killed adapter only', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-cli-children-'))
  const { owner, cli, tool } = await startOwner(dir)
  try {
    assert.deepEqual(await readdir(dir), [`${owner.pid}.json`])
    // The owner is alive: its CLI is not an orphan.
    assert.deepEqual(await reapOrphanedCliChildren(dir, 200), [])
    assert.equal(alive(cli), true)

    owner.kill('SIGKILL')
    await once(owner, 'exit')
    assert.equal(alive(cli), true, 'the CLI outlives a SIGKILLed adapter')
    assert.deepEqual(await reapOrphanedCliChildren(dir, 200), [cli])
    assert.equal(await waitFor(() => !alive(cli) && !alive(tool), 5000), true)
    assert.deepEqual(await readdir(dir), [])
    // Nothing left to reap the second time.
    assert.deepEqual(await reapOrphanedCliChildren(dir, 200), [])
  } finally {
    for (const pid of [owner.pid, cli, tool])
      try {
        if (pid) process.kill(pid, 'SIGKILL')
      } catch {}
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseProcessRows reads ps lstart rows', () => {
  const rows = parseProcessRows(
    [
      ' 4802  4706 Mon Oct 12 02:52:58 2026     /usr/bin/node /x/adapter.mjs app-server',
      '16066     1 Sat Oct 10 17:53:01 2026     claude --input-format stream-json',
      'garbage',
    ].join('\n'),
  )
  assert.deepEqual(rows, [
    {
      pid: 4802,
      ppid: 4706,
      started: 'Mon Oct 12 02:52:58 2026',
      command: '/usr/bin/node /x/adapter.mjs app-server',
    },
    {
      pid: 16066,
      ppid: 1,
      started: 'Sat Oct 10 17:53:01 2026',
      command: 'claude --input-format stream-json',
    },
  ])
})
