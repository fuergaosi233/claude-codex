import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const adapter = resolve('dist/src/adapter.mjs')

interface DaemonSetup {
  home: string
  sock: string
  pidFile: string
}

// A short socket path: unix socket paths are limited to about 100 bytes.
async function setup(): Promise<DaemonSetup> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-pid-${randomUUID().slice(0, 8)}.sock`)
  return { home, sock, pidFile: `${sock}.pid` }
}

async function cleanup({ home, sock, pidFile }: DaemonSetup): Promise<void> {
  await rm(sock, { force: true })
  await rm(pidFile, { force: true })
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
}

function startDaemon({ home, sock }: DaemonSetup): ChildProcess {
  return spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
}

// Resolves with the stderr seen once it matches; rejects if the process exits
// first or nothing matches in time.
function waitForStderr(proc: ChildProcess, pattern: RegExp, timeoutMs = 8000): Promise<string> {
  const stderr = proc.stderr
  if (!stderr) throw new Error('test process has no stderr')
  stderr.setEncoding('utf8')
  let seen = ''
  return new Promise((resolvePromise, reject) => {
    const finish = (error: Error | null) => {
      clearTimeout(timer)
      stderr.off('data', onData)
      proc.off('exit', onExit)
      if (error) reject(error)
      else resolvePromise(seen)
    }
    const onData = (chunk: string) => {
      seen += chunk
      if (pattern.test(seen)) finish(null)
    }
    const onExit = () => finish(new Error(`exited before stderr matched ${pattern}; saw: ${seen}`))
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for stderr ${pattern}; saw: ${seen}`)),
      timeoutMs,
    )
    stderr.on('data', onData)
    proc.once('exit', onExit)
  })
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = once(proc, 'exit')
  proc.kill()
  const done = await Promise.race([exited.then(() => true), delay(2000).then(() => false)])
  if (!done) {
    proc.kill('SIGKILL')
    await exited
  }
}

// The daemon starts despite the pid file and leaves its own pid there, as
// plain text a script can hand to kill.
async function assertDaemonReplacesPidFile(
  state: DaemonSetup,
  daemon = startDaemon(state),
): Promise<void> {
  try {
    // Well inside the 10 s startup grace window, so a pid file wrongly taken
    // for a starting daemon makes this time out.
    const stderr = await waitForStderr(daemon, /listening on/, 5000)
    assert.doesNotMatch(stderr, /already running/)
    assert.equal(await readFile(state.pidFile, 'utf8'), `${daemon.pid}\n`)
  } finally {
    await stopProcess(daemon)
  }
}

for (const [name, content] of [
  ['an empty', ''],
  ['a newline-only', '\n'],
  ['a zero', '0\n'],
  ['a negative', '-1\n'],
  ['an init (pid 1)', '1\n'],
] as const) {
  test(`${name} daemon pid file does not block startup`, { timeout: 15_000 }, async () => {
    const state = await setup()
    try {
      await writeFile(state.pidFile, content)
      await assertDaemonReplacesPidFile(state)
    } finally {
      await cleanup(state)
    }
  })
}

test('a recycled pid with no socket behind it does not block startup', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  // A live process of the same user that is not a daemon, as after a reboot.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    await once(other, 'spawn')
    await writeFile(state.pidFile, `${other.pid}\n`)
    // Older than the window in which a starting daemon may not listen yet.
    const old = new Date(Date.now() - 60_000)
    await utimes(state.pidFile, old, old)
    await assertDaemonReplacesPidFile(state)
  } finally {
    await stopProcess(other)
    await cleanup(state)
  }
})

test('a running daemon still turns away a second one', { timeout: 15_000 }, async () => {
  const state = await setup()
  const first = startDaemon(state)
  try {
    await waitForStderr(first, /listening on/)
    const second = startDaemon(state)
    try {
      const stderr = await waitForStderr(second, /already running/)
      assert.match(stderr, new RegExp(`\\(pid ${first.pid}\\)`))
      const code = second.exitCode ?? (await once(second, 'exit'))[0]
      assert.equal(code, 0)
    } finally {
      await stopProcess(second)
    }
    assert.equal(await readFile(state.pidFile, 'utf8'), `${first.pid}\n`)
  } finally {
    await stopProcess(first)
    await cleanup(state)
  }
})

test('a live pid followed by other text does not block startup', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  // parseInt would read the live pid and, as the file is fresh, wait out the
  // startup grace window for a daemon that never listens.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    await once(other, 'spawn')
    await writeFile(state.pidFile, `${other.pid}abc\n`)
    await assertDaemonReplacesPidFile(state)
  } finally {
    await stopProcess(other)
    await cleanup(state)
  }
})

test('a pid file naming the starting daemon itself does not block startup', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  try {
    // The shell writes its own pid, then exec keeps that pid for the daemon,
    // so the fresh pid file names a live process that is not listening yet.
    const daemon = spawn(
      'sh',
      [
        '-c',
        'echo $$ > "$1"; shift; exec "$@"',
        'sh',
        state.pidFile,
        process.execPath,
        adapter,
        'app-server',
        '--listen',
        `unix://${state.sock}`,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: state.home,
          CLAUDE_CODEX_MOCK: '1',
          NODE_NO_WARNINGS: '1',
        },
      },
    )
    await assertDaemonReplacesPidFile(state, daemon)
  } finally {
    await cleanup(state)
  }
})

interface StartingDaemon {
  // A live process named by a fresh pid file that does not listen yet, as
  // when a first daemon has written its pid but not opened its socket.
  other: ChildProcess
  // A daemon started behind it, which should be waiting.
  second: ChildProcess
}

// Runs check with both processes and stops them afterwards, even when check
// or the waiting assertions fail.
async function withStartingDaemon(
  state: DaemonSetup,
  check: (procs: StartingDaemon) => Promise<void>,
): Promise<void> {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  let second: ChildProcess | undefined
  try {
    await once(other, 'spawn')
    await writeFile(state.pidFile, `${other.pid}\n`)
    second = startDaemon(state)
    // Several 200 ms polls later, the second daemon is still waiting: it has
    // neither exited nor replaced the pid file.
    await delay(800)
    assert.equal(second.exitCode, null)
    assert.equal(await readFile(state.pidFile, 'utf8'), `${other.pid}\n`)
    await check({ other, second })
  } finally {
    if (second) await stopProcess(second)
    await stopProcess(other)
  }
}

test('a daemon still starting turns away a second one once it listens', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  const server = createServer((socket) => socket.destroy())
  try {
    await withStartingDaemon(state, async ({ other, second }) => {
      const stderr = waitForStderr(second, /already running/)
      server.listen(state.sock)
      await once(server, 'listening')
      assert.match(await stderr, new RegExp(`\\(pid ${other.pid}\\)`))
      const code = second.exitCode ?? (await once(second, 'exit'))[0]
      assert.equal(code, 0)
      assert.equal(await readFile(state.pidFile, 'utf8'), `${other.pid}\n`)
    })
  } finally {
    server.close()
    await cleanup(state)
  }
})

test('a daemon that dies while starting lets the waiting one take over', {
  timeout: 15_000,
}, async () => {
  const state = await setup()
  try {
    await withStartingDaemon(state, async ({ other, second }) => {
      await stopProcess(other)
      await assertDaemonReplacesPidFile(state, second)
    })
  } finally {
    await cleanup(state)
  }
})
