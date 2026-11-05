import assert from 'node:assert/strict'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const modeScript = resolve('scripts/claude-codex-mode')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Resolves with the exit signal or code, or 'running' if the child is still up
// after `ms` (the stop command has already returned by then).
function exited(child: ChildProcess, ms = 2_000): Promise<NodeJS.Signals | number | 'running'> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode ?? child.exitCode ?? 'running')
  }
  return new Promise((done) => {
    const timer = setTimeout(() => done('running'), ms)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      done(signal ?? code ?? 'running')
    })
  })
}

async function runMode(stateDir: string, ...args: string[]) {
  return execFileAsync('bash', [modeScript, ...args], {
    env: {
      ...process.env,
      CLAUDE_CODEX_STATE_DIR: stateDir,
      // Never read the developer's real runtime.env.
      CLAUDE_CODEX_RUNTIME_ENV: join(stateDir, 'runtime.env'),
    },
    timeout: 20_000,
  })
}

test('stop-bridges force-kills a bridge that ignores SIGTERM and drops its pidfile', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'claude-codex-mode-stop-'))
  const bridgeDir = join(stateDir, 'bridges', 'agent-http', 'deadbeefdeadbeef')
  const stubborn = spawn('bash', ['-c', 'trap "" TERM; while :; do sleep 0.1; done'], {
    stdio: 'ignore',
  })
  try {
    assert.ok(stubborn.pid)
    await mkdir(bridgeDir, { recursive: true })
    await writeFile(join(bridgeDir, 'pid'), `${stubborn.pid}\n`)

    await runMode(stateDir, 'stop-bridges', 'agent-http')

    assert.equal(await exited(stubborn), 'SIGKILL')
    assert.equal(alive(stubborn.pid), false)
    assert.equal(existsSync(join(bridgeDir, 'pid')), false)
  } finally {
    stubborn.kill('SIGKILL')
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('stop-bridges stops a bridge that honors SIGTERM without escalating', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'claude-codex-mode-stop-'))
  const bridgeDir = join(stateDir, 'bridges', 'agentapi', 'feedfacefeedface')
  const polite = spawn('bash', ['-c', 'trap "exit 0" TERM; while :; do sleep 0.1; done'], {
    stdio: 'ignore',
  })
  try {
    assert.ok(polite.pid)
    await mkdir(bridgeDir, { recursive: true })
    await writeFile(join(bridgeDir, 'pid'), `${polite.pid}\n`)

    await runMode(stateDir, 'stop-bridges')

    assert.equal(await exited(polite), 0)
    assert.equal(existsSync(join(bridgeDir, 'pid')), false)
  } finally {
    polite.kill('SIGKILL')
    await rm(stateDir, { recursive: true, force: true })
  }
})
