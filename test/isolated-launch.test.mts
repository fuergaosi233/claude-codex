import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const launcher = resolve('dist/src/isolated-launch.mjs')
const shim = resolve('scripts/codex-shim')

interface Launch {
  proc: ChildProcess
  output(): string
}

async function fixture(t: TestContext) {
  // Keep the fake native Unix socket below sockaddr_un's macOS path limit.
  const root = await realpath(
    await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'ccx-isolated-')),
  )
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC)_/.test(key)) delete env[key]
  }
  Object.assign(env, {
    HOME: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'native'),
    CLAUDE_CODEX_HOME: join(root, 'shared-adapter'),
    CLAUDE_CODEX_SOCKET_PATH: join(root, 'native', 'app-server-control', 'app-server-control.sock'),
    CLAUDE_CODEX_DEBUG_LOG: join(root, 'native-debug.jsonl'),
    CLAUDE_CODEX_RUN_LOG: join(root, 'native-runs.jsonl'),
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  })
  const children: Launch[] = []
  const clients: WebSocket[] = []
  const servers: http.Server[] = []
  t.after(async () => {
    for (const ws of clients) ws.terminate()
    for (const child of children) await stop(child)
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  })
  const launch = (stateDir: string, args: string[] = []) => {
    const child = start(process.execPath, [launcher, '--state-dir', stateDir, ...args], env, true)
    children.push(child)
    return child
  }
  const connect = async (child: Launch, stateDir: string) => {
    const address = await listening(child)
    const token = (await readFile(join(stateDir, 'adapter', 'ws-token'), 'utf8')).trim()
    const ws = new WebSocket(address, { headers: { Authorization: `Bearer ${token}` } })
    clients.push(ws)
    await once(ws, 'open')
    const initialized = await request<{ codexHome: string }>(ws, 'initialize', {
      clientInfo: { name: 'isolated-test', version: '0' },
      capabilities: null,
    })
    assert.equal(initialized.codexHome, join(stateDir, 'codex'))
    return ws
  }
  return { root, env, launch, connect, children, servers }
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv, detached = false): Launch {
  const proc = spawn(command, args, {
    env,
    detached: detached && process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  proc.stdout?.on('data', (data) => {
    output += String(data)
  })
  proc.stderr?.on('data', (data) => {
    output += String(data)
  })
  return { proc, output: () => output }
}

async function listening(child: Launch): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const match = /listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(child.output())
    if (match?.[1]) return match[1]
    assert.equal(child.proc.exitCode, null, child.output())
    await delay(20)
  }
  assert.fail(`listener did not start: ${child.output()}`)
}

async function exited(child: Launch): Promise<number | null> {
  if (child.proc.exitCode !== null || child.proc.signalCode !== null) return child.proc.exitCode
  const result = await once(child.proc, 'exit')
  return result[0] as number | null
}

async function stop(
  child: Launch,
  signal: NodeJS.Signals = 'SIGTERM',
  terminalGroup = false,
): Promise<void> {
  if (child.proc.exitCode !== null || child.proc.signalCode !== null) return
  const done = exited(child)
  if (terminalGroup && child.proc.pid !== undefined && process.platform !== 'win32') {
    process.kill(-child.proc.pid, signal)
  } else {
    child.proc.kill(signal)
  }
  const timer = setTimeout(() => child.proc.kill('SIGKILL'), 5000)
  try {
    await done
  } finally {
    clearTimeout(timer)
  }
}

let rpcId = 0
function request<T>(ws: WebSocket, method: string, params: unknown = {}): Promise<T> {
  const id = ++rpcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', receive)
      reject(new Error(`no reply to ${method}`))
    }, 5000)
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as { id?: number; result: T; error?: unknown }
      if (message.id !== id) return
      clearTimeout(timer)
      ws.off('message', receive)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    ws.on('message', receive)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

function turnCompleted(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', receive)
      reject(new Error('mock turn did not complete'))
    }, 5000)
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as { method?: string }
      if (message.method !== 'turn/completed') return
      clearTimeout(timer)
      ws.off('message', receive)
      resolve()
    }
    ws.on('message', receive)
  })
}

test('isolated launcher validates its CLI before creating state', async (t) => {
  const f = await fixture(t)
  const stateDir = join(f.root, 'unused')
  for (const args of [
    [],
    ['--state-dir', stateDir, '--port', '-1'],
    ['--state-dir', stateDir, '--port', '65536'],
    ['--state-dir', stateDir, '--port', '1.5'],
    ['--state-dir', stateDir, '--listen', 'unix://'],
    ['--state-dir', stateDir, 'app-server'],
  ]) {
    const result = spawnSync(process.execPath, [launcher, ...args], {
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /claude-codex-isolated/)
    assert.equal(existsSync(stateDir), false)
  }
  const help = spawnSync(process.execPath, [launcher, '--help'], { env: f.env, encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--state-dir PATH/)
})

test('parallel isolated instances have independent addresses, auth and persisted threads', {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t)
  const aDir = join(f.root, 'a')
  const bDir = join(f.root, 'b')
  await writeFile(f.env.CLAUDE_CODEX_DEBUG_LOG as string, 'native-debug\n')
  await writeFile(f.env.CLAUDE_CODEX_RUN_LOG as string, 'native-runs\n')
  const a = f.launch(aDir)
  const b = f.launch(bDir)
  const [aWs, bWs] = await Promise.all([f.connect(a, aDir), f.connect(b, bDir)])
  assert.notEqual(await listening(a), await listening(b))
  const aToken = await readFile(join(aDir, 'adapter', 'ws-token'), 'utf8')
  assert.notEqual(aToken, await readFile(join(bDir, 'adapter', 'ws-token'), 'utf8'))
  const denied = new WebSocket(await listening(b), {
    headers: { Authorization: `Bearer ${aToken.trim()}` },
  })
  denied.on('error', () => {})
  const [, response] = await once(denied, 'unexpected-response')
  assert.equal(response.statusCode, 401)
  response.resume()
  denied.terminate()

  const { thread } = await request<{ thread: { id: string } }>(aWs, 'thread/start', { cwd: f.root })
  const completed = turnCompleted(aWs)
  await request(aWs, 'turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
  })
  await completed
  assert.deepEqual((await request<{ data: unknown[] }>(bWs, 'thread/list')).data, [])
  assert.equal(existsSync(join(aDir, 'adapter', 'state.sqlite')), true)
  assert.equal(existsSync(join(bDir, 'adapter', 'state.sqlite')), true)
  assert.equal(existsSync(f.env.CLAUDE_CODEX_HOME as string), false)
  assert.equal(existsSync(f.env.CODEX_HOME as string), false)
  assert.equal(await readFile(f.env.CLAUDE_CODEX_DEBUG_LOG as string, 'utf8'), 'native-debug\n')
  assert.equal(await readFile(f.env.CLAUDE_CODEX_RUN_LOG as string, 'utf8'), 'native-runs\n')

  // Simulate terminal Ctrl-C to this launcher's group, not only its PID.
  // It must shut down gracefully once, while the sibling still serves.
  await stop(a, 'SIGINT', true)
  assert.equal(a.proc.exitCode, 0, a.output())
  assert.equal(existsSync(join(aDir, 'launcher.lock')), false)
  assert.deepEqual((await request<{ data: unknown[] }>(bWs, 'thread/list')).data, [])
  const restarted = f.launch(aDir)
  const ws = await f.connect(restarted, aDir)
  const listed = await request<{ data: { id: string }[] }>(ws, 'thread/list')
  assert.equal(listed.data[0]?.id, thread.id)
  assert.equal(await readFile(join(aDir, 'adapter', 'ws-token'), 'utf8'), aToken)
})

test('a duplicate state directory and an unverified stale lock fail without touching the owner', {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t)
  const stateDir = join(f.root, 'instance')
  const owner = f.launch(stateDir)
  const ws = await f.connect(owner, stateDir)
  const token = await readFile(join(stateDir, 'adapter', 'ws-token'), 'utf8')
  const duplicate = f.launch(stateDir)
  assert.equal(await exited(duplicate), 1)
  assert.match(duplicate.output(), /state directory is reserved/)
  assert.equal(await readFile(join(stateDir, 'adapter', 'ws-token'), 'utf8'), token)
  assert.deepEqual((await request<{ data: unknown[] }>(ws, 'thread/list')).data, [])
  await stop(owner)
  const lockPath = join(stateDir, 'launcher.lock')
  await writeFile(lockPath, 'unverified previous owner\n')
  const stale = f.launch(stateDir)
  assert.equal(await exited(stale), 1)
  assert.match(stale.output(), /confirm both launcher and adapter have stopped/)
  assert.equal(await readFile(lockPath, 'utf8'), 'unverified previous owner\n')
})

test('an occupied TCP port is refused without disrupting its existing listener', {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t)
  const existing = http.createServer((_req, res) => res.end('existing native listener'))
  f.servers.push(existing)
  existing.listen(0, '127.0.0.1')
  await once(existing, 'listening')
  const address = existing.address()
  assert.ok(address && typeof address === 'object')
  const stateDir = join(f.root, 'conflict')
  const child = f.launch(stateDir, ['--port', String(address.port)])
  assert.equal(await exited(child), 1)
  assert.match(child.output(), /EADDRINUSE/)
  assert.equal(existsSync(join(stateDir, 'launcher.lock')), false)
  const reply = await fetch(`http://127.0.0.1:${address.port}`)
  assert.equal(await reply.text(), 'existing native listener')
  // A failed bind does not strand this state directory.
  await f.connect(f.launch(stateDir), stateDir)
})

test('native routes and the native control socket survive isolated startup and shutdown; SSH shim remains opt-in', {
  timeout: 15_000,
  skip: process.platform === 'win32',
}, async (t) => {
  const f = await fixture(t)
  const bin = join(f.root, 'bin')
  await mkdir(bin)
  const native = join(bin, 'codex')
  await writeFile(
    native,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ native: process.argv.slice(2) })); if (process.argv.includes('--hold')) setInterval(() => {}, 1000)\n`,
  )
  await chmod(native, 0o755)
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}` }
  const nativeProcess = start(native, ['app-server', '--hold'], env)
  f.children.push(nativeProcess)
  const nativeSocket = f.env.CLAUDE_CODEX_SOCKET_PATH as string
  await mkdir(dirname(nativeSocket), { recursive: true })
  const existing = http.createServer((_req, res) => res.end('native socket'))
  f.servers.push(existing)
  existing.listen(nativeSocket)
  await once(existing, 'listening')
  const nativeRoutes = async () => {
    for (const args of [['app-server'], ['exec', 'example'], ['--remote', 'ws://127.0.0.1:1234']]) {
      const result = spawnSync('codex', args, { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { native: args })
    }
    assert.equal(nativeProcess.proc.exitCode, null)
    const reply = await new Promise<string>((resolve, reject) => {
      http
        .get({ socketPath: nativeSocket, path: '/' }, (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += String(chunk)
          })
          res.on('end', () => resolve(body))
        })
        .on('error', reject)
    })
    assert.equal(reply, 'native socket')
  }
  await nativeRoutes()
  const stateDir = join(f.root, 'isolated')
  const isolated = f.launch(stateDir)
  await f.connect(isolated, stateDir)
  await nativeRoutes()
  await stop(isolated)
  assert.equal(isolated.proc.exitCode, 0, isolated.output())
  await nativeRoutes()

  const fakeNode = join(bin, 'fake-node')
  await writeFile(fakeNode, '#!/bin/sh\nprintf "adapter\\n"\nprintf "%s\\n" "$@"\n')
  await chmod(fakeNode, 0o755)
  const shimEnv = {
    ...env,
    CODEX_REAL: native,
    CLAUDE_CODEX_NODE: fakeNode,
    CLAUDE_CODEX_ADAPTER: '/example/adapter.mjs',
    CLAUDE_CODEX_RUNTIME_ENV: join(f.root, 'absent-runtime.env'),
  }
  const app = spawnSync(shim, ['app-server'], { env: shimEnv, encoding: 'utf8' })
  assert.equal(app.status, 0, app.stderr)
  assert.equal(app.stdout, 'adapter\n/example/adapter.mjs\napp-server\n')
  const exec = spawnSync(shim, ['exec', 'example'], { env: shimEnv, encoding: 'utf8' })
  assert.equal(exec.status, 0, exec.stderr)
  assert.deepEqual(JSON.parse(exec.stdout), { native: ['exec', 'example'] })
})
