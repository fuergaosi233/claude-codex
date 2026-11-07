import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { startWebSocketTransport } from '../src/transports.mjs'

const adapter = resolve('dist/src/adapter.mjs')

// Short, so the socket path stays within the sockaddr_un limit on macOS too.
async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'ccx-'))
}

function startDaemon(home: string, sock: string): ChildProcess {
  return spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
}

function collectStderr(proc: ChildProcess): () => string {
  let text = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    text += chunk
  })
  return () => text
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([once(proc, 'exit').then(([code]) => code as number | null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

// Why a unix listener at the path fails to start, or null when it starts. One
// that starts is closed again, so it cannot keep the test process alive.
async function listenError(path: string): Promise<string | null> {
  try {
    const transport = await startWebSocketTransport(
      `unix://${path}`,
      () => {},
      () => {},
    )
    await transport.close()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// A socket file with no server behind it, as a SIGKILLed daemon leaves.
async function leaveStaleSocket(sock: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'require("node:net").createServer().listen(process.argv[1], () => console.log("ready"))',
      sock,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  await once(child.stdout, 'data')
  child.kill('SIGKILL')
  await once(child, 'exit')
  assert.equal(existsSync(sock), true, 'the killed listener leaves its socket')
}

test('a unix listener refuses a path that holds a regular file or a directory', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'notes.txt')
    await writeFile(file, 'keep\n')
    assert.equal(await listenError(file), `refusing to replace non-socket file at ${file}`)
    assert.equal(await readFile(file, 'utf8'), 'keep\n')

    const folder = join(dir, 'folder')
    await mkdir(folder)
    await writeFile(join(folder, 'inside.txt'), 'keep\n')
    assert.equal(await listenError(folder), `refusing to replace non-socket file at ${folder}`)
    assert.equal(await readFile(join(folder, 'inside.txt'), 'utf8'), 'keep\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a unix listener replaces a stale socket', async () => {
  const dir = await tempDir()
  try {
    const sock = join(dir, 's.sock')
    await leaveStaleSocket(sock)
    const transport = await startWebSocketTransport(
      `unix://${sock}`,
      () => {},
      () => {},
    )
    try {
      const probe = net.createConnection(sock)
      await once(probe, 'connect')
      probe.destroy()
    } finally {
      await transport.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unix daemon exits 1 and leaves a regular file at its socket path alone', {
  timeout: 30_000,
}, async () => {
  const dir = await tempDir()
  const file = join(dir, 'notes.txt')
  await writeFile(file, 'keep\n')
  const proc = startDaemon(join(dir, 'home'), file)
  const stderr = collectStderr(proc)
  try {
    assert.equal(await waitForExit(proc, 10_000), 1, stderr())
    assert.equal(
      stderr(),
      `[claude-codex-adapter] refusing to replace non-socket file at ${file}\n`,
    )
    assert.equal(await readFile(file, 'utf8'), 'keep\n')
    assert.equal(existsSync(`${file}.pid`), false)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('unix daemon replaces a stale socket left by a killed daemon', {
  timeout: 30_000,
}, async () => {
  const dir = await tempDir()
  const sock = join(dir, 's.sock')
  await leaveStaleSocket(sock)
  const proc = startDaemon(join(dir, 'home'), sock)
  const stderr = collectStderr(proc)
  try {
    assert.ok(await waitFor(() => /listening on/.test(stderr()), 10_000), stderr())
    const probe = net.createConnection(sock)
    await once(probe, 'connect')
    probe.destroy()
    proc.kill('SIGTERM')
    assert.equal(await waitForExit(proc, 10_000), 0)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})
