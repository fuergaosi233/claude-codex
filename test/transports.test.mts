import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseProxySockArg } from '../src/transports.mjs'

const adapter = resolve('dist/src/adapter.mjs')

test('parseProxySockArg reads --sock PATH and --sock=PATH', () => {
  assert.equal(parseProxySockArg(['--sock=/a.sock']), '/a.sock')
  assert.equal(parseProxySockArg(['--sock', '/b.sock']), '/b.sock')
})

test('parseProxySockArg falls back to the default socket without --sock', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-sock-'))
  const saved = { codexHome: process.env.CODEX_HOME, socket: process.env.CLAUDE_CODEX_SOCKET_PATH }
  process.env.CODEX_HOME = home
  delete process.env.CLAUDE_CODEX_SOCKET_PATH
  try {
    const path = parseProxySockArg([])
    // A long CODEX_HOME moves the socket to a hashed name under the tmpdir.
    assert.ok(path.startsWith(home) || path.startsWith(join(tmpdir(), 'ccx-')), path)
  } finally {
    if (saved.codexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved.codexHome
    if (saved.socket !== undefined) process.env.CLAUDE_CODEX_SOCKET_PATH = saved.socket
    await rm(home, { recursive: true, force: true })
  }
})

test('parseProxySockArg rejects --sock without a path', () => {
  for (const args of [['--sock'], ['--sock='], ['--sock', '--other']]) {
    assert.throws(() => parseProxySockArg(args), /--sock needs a socket path/, args.join(' '))
  }
})

test('app-server proxy --sock=PATH connects to the named socket', async (t) => {
  const dir = await mkdtemp('/tmp/ccx-p-')
  const socketPath = join(dir, 's.sock')
  const server = net.createServer()
  const connected = once(server, 'connection')
  server.listen(socketPath)
  await once(server, 'listening')
  const proc = spawn(process.execPath, [adapter, 'app-server', 'proxy', `--sock=${socketPath}`], {
    env: { ...process.env, CODEX_HOME: dir, CLAUDE_CODEX_SOCKET_PATH: join(dir, 'default.sock') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(async () => {
    proc.kill('SIGKILL')
    server.close()
    await rm(dir, { recursive: true, force: true })
  })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('no connection on the named socket')), 5_000)
  })
  try {
    const [socket] = (await Promise.race([connected, timeout])) as [net.Socket]
    socket.destroy()
  } finally {
    clearTimeout(timer)
  }
})

test('app-server proxy --sock without a path exits with a one-line usage error', async () => {
  const proc = spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  proc.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const [code] = await once(proc, 'exit')
  assert.equal(code, 1)
  assert.equal(stderr, '[claude-codex-adapter] --sock needs a socket path\n')
})
