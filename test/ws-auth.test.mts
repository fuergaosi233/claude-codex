import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import WebSocket from 'ws'
import { startWebSocketTransport } from '../src/transports.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'
import {
  authNotice,
  ensureTokenFile,
  isLoopbackHost,
  rejectUpgrade,
  resolveWebSocketAuth,
  selectProtocol,
  WS_BEARER_PROTOCOL_PREFIX,
  WS_PROTOCOL,
} from '../src/ws-auth.mjs'

process.env.CLAUDE_CODEX_DEBUG_LOG = '0'
const adapter = resolve('dist/src/adapter.mjs')
const TOKEN = 'test-token-0123456789abcdef'

test('loopback detection covers IPv4, IPv6 and localhost only', () => {
  for (const host of [
    '127.0.0.1',
    '127.1.2.3',
    'localhost',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    new URL('ws://[::ffff:127.0.0.1]:1').hostname,
  ])
    assert.equal(isLoopbackHost(host), true, host)
  for (const host of [
    '0.0.0.0',
    '::',
    '[::]',
    '192.168.1.2',
    '10.0.0.1',
    'example.com',
    new URL('ws://[::ffff:8.8.8.8]:1').hostname,
  ])
    assert.equal(isLoopbackHost(host), false, host)
})

test('websocket auth refuses a non-loopback listener without a token', () => {
  assert.throws(
    () => resolveWebSocketAuth('0.0.0.0', 8788, {}, {}),
    /refusing to start non-loopback websocket listener ws:\/\/0\.0\.0\.0:8788 without auth/,
  )
  assert.throws(
    () => resolveWebSocketAuth('192.168.1.2', 8788, { auth: 'none' }, {}),
    /refusing to start non-loopback/,
  )
  // The error names both ways forward.
  assert.throws(
    () => resolveWebSocketAuth('[::]', 8788, {}, {}),
    (error: Error) =>
      error.message.includes('--ws-auth capability-token') &&
      error.message.includes('CLAUDE_CODEX_WS_AUTH=capability-token') &&
      error.message.includes('--ws-allow-unauthenticated') &&
      error.message.includes('CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED=1') &&
      !error.message.includes('\n'),
  )
  assert.equal(resolveWebSocketAuth('127.0.0.1', 8788, {}, {}).mode, 'none')
  // An empty variable counts as unset.
  assert.equal(
    resolveWebSocketAuth('127.0.0.1', 8788, {}, { CLAUDE_CODEX_WS_AUTH: '' }).mode,
    'none',
  )
})

test('an explicit opt-out lets a non-loopback listener start without auth', () => {
  for (const [options, env] of [
    [{ allowUnauthenticated: true }, {}],
    [{ auth: 'none', allowUnauthenticated: true }, {}],
    [{}, { CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED: '1' }],
  ] as const) {
    const auth = resolveWebSocketAuth('0.0.0.0', 8788, options, env)
    assert.equal(auth.mode, 'none')
    // The startup line warns about it.
    assert.match(
      authNotice(auth, '0.0.0.0', 'ws://0.0.0.0:8788') ?? '',
      /^warning: ws:\/\/0\.0\.0\.0:8788 accepts clients without a token/,
    )
    // Web pages stay out all the same.
    assert.deepEqual(auth.verify(upgradeRequest({ origin: 'https://evil.example' })), {
      ok: false,
      status: 403,
      reason: 'origin not allowed',
    })
    assert.deepEqual(auth.verify(upgradeRequest({})), { ok: true })
  }
  // Other values leave the refusal in place.
  assert.throws(
    () => resolveWebSocketAuth('0.0.0.0', 8788, {}, { CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED: '0' }),
    /refusing to start non-loopback/,
  )
  // It never weakens token auth: asking for both is a mistake.
  assert.throws(
    () =>
      resolveWebSocketAuth(
        '0.0.0.0',
        8788,
        { allowUnauthenticated: true },
        { CLAUDE_CODEX_WS_TOKEN: TOKEN },
      ),
    /--ws-allow-unauthenticated .* cannot be combined with websocket token auth/,
  )
  // On loopback it changes nothing, and nothing is worth a warning.
  const loopback = resolveWebSocketAuth('127.0.0.1', 1, { allowUnauthenticated: true }, {})
  assert.equal(loopback.mode, 'none')
  assert.equal(authNotice(loopback, '127.0.0.1', 'ws://127.0.0.1:1'), null)
  assert.equal(authNotice(loopback, '[::1]', 'ws://[::1]:1'), null)
  const token = resolveWebSocketAuth('0.0.0.0', 1, {}, { CLAUDE_CODEX_WS_TOKEN: TOKEN })
  assert.equal(
    authNotice(token, '0.0.0.0', 'ws://0.0.0.0:1'),
    'websocket clients need the capability token from CLAUDE_CODEX_WS_TOKEN',
  )
})

test('websocket auth rejects conflicting or weak token settings', () => {
  assert.throws(
    () =>
      resolveWebSocketAuth(
        '127.0.0.1',
        1,
        { tokenSha256: 'a'.repeat(64) },
        {
          CLAUDE_CODEX_WS_TOKEN: TOKEN,
        },
      ),
    /set only one of/,
  )
  assert.throws(
    () => resolveWebSocketAuth('127.0.0.1', 1, { auth: 'none' }, { CLAUDE_CODEX_WS_TOKEN: TOKEN }),
    /configured but websocket auth is set to none/,
  )
  assert.throws(
    () => resolveWebSocketAuth('127.0.0.1', 1, {}, { CLAUDE_CODEX_WS_TOKEN: 'short' }),
    /shorter than 16/,
  )
  assert.throws(
    () => resolveWebSocketAuth('127.0.0.1', 1, { tokenFile: 'relative/token' }, {}),
    /absolute path/,
  )
  assert.throws(() => resolveWebSocketAuth('127.0.0.1', 1, { auth: 'basic' }, {}), /unsupported/)
  assert.throws(
    () => resolveWebSocketAuth('127.0.0.1', 1, { allowedOrigins: 'not a url' }, {}),
    /invalid websocket allowed origin/,
  )
  // A token alone turns auth on, also on loopback.
  const auth = resolveWebSocketAuth('0.0.0.0', 1, {}, { CLAUDE_CODEX_WS_TOKEN: TOKEN })
  assert.equal(auth.mode, 'capability-token')
  assert.equal(auth.source, 'CLAUDE_CODEX_WS_TOKEN')
})

test('a SHA-256 digest checks the token it was made from', () => {
  const auth = resolveWebSocketAuth(
    '0.0.0.0',
    1,
    { tokenSha256: createHash('sha256').update(TOKEN).digest('hex').toUpperCase() },
    {},
  )
  assert.equal(auth.mode, 'capability-token')
  assert.deepEqual(auth.verify(upgradeRequest({ authorization: `Bearer ${TOKEN}` })), {
    ok: true,
  })
  assert.deepEqual(auth.verify(upgradeRequest({ authorization: `Bearer ${TOKEN}x` })), {
    ok: false,
    status: 401,
    reason: 'invalid token',
  })
  assert.throws(
    () => resolveWebSocketAuth('0.0.0.0', 1, { tokenSha256: 'a'.repeat(63) }, {}),
    /64 hex characters/,
  )
})

test('a refused upgrade survives the client resetting the connection', () => {
  const socket = new PassThrough()
  rejectUpgrade(socket, upgradeRequest({}), { status: 401, reason: 'missing token' })
  // Without a listener of its own, this error would end the process.
  assert.doesNotThrow(() => socket.emit('error', new Error('read ECONNRESET')))
  assert.equal(socket.destroyed, true)
})

test('websocket token file is created once with mode 0600', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-ws-auth-'))
  try {
    const path = join(home, 'nested', 'ws-token')
    assert.equal(ensureTokenFile(path), true)
    const first = await readFile(path, 'utf8')
    assert.match(first.trim(), /^[A-Za-z0-9_-]{43}$/)
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal(ensureTokenFile(path), false)
    assert.equal(await readFile(path, 'utf8'), first)

    const loose = join(home, 'loose-token')
    await writeFile(loose, `${TOKEN}\n`, { mode: 0o644 })
    if (process.platform !== 'win32') {
      assert.throws(
        () => resolveWebSocketAuth('127.0.0.1', 1, { tokenFile: loose }, {}),
        /readable by other users/,
      )
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('selected subprotocol never echoes a token', () => {
  const bearer = `${WS_BEARER_PROTOCOL_PREFIX}${TOKEN}`
  assert.equal(selectProtocol(new Set([bearer, WS_PROTOCOL])), WS_PROTOCOL)
  assert.equal(selectProtocol(new Set([bearer])), false)
  assert.equal(selectProtocol(new Set(['other', bearer])), 'other')
})

test('capability-token listener checks the token and the Origin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-ws-auth-'))
  const tokenFile = join(home, 'token')
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  const auth = resolveWebSocketAuth(
    '127.0.0.1',
    0,
    { tokenFile, allowedOrigins: 'https://phone.example' },
    {},
  )
  const transport = await startWebSocketTransport('ws://127.0.0.1:0', echo, () => {}, undefined, {
    auth,
  })
  try {
    const url = transport.address
    assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/)
    assert.notEqual(url, 'ws://127.0.0.1:0')
    assert.equal((await attempt(url)).status, 401)
    assert.equal((await attempt(url, { bearer: 'wrong-token-0123456789' })).status, 401)
    assert.equal(
      (
        await attempt(url, {
          protocols: [WS_PROTOCOL, `${WS_BEARER_PROTOCOL_PREFIX}nope-nope-nope`],
        })
      ).status,
      401,
    )
    // A web page cannot get in, even with the token.
    assert.equal(
      (await attempt(url, { bearer: TOKEN, origin: 'https://evil.example' })).status,
      403,
    )

    const byHeader = await attempt(url, { bearer: TOKEN })
    assert.ok(byHeader.ws)
    assert.deepEqual(await roundTrip(byHeader.ws), { id: 1, result: { ok: true } })
    byHeader.ws.close()

    const byProtocol = await attempt(url, {
      protocols: [WS_PROTOCOL, `${WS_BEARER_PROTOCOL_PREFIX}${TOKEN}`],
      origin: 'https://phone.example',
    })
    assert.ok(byProtocol.ws)
    assert.equal(byProtocol.ws.protocol, WS_PROTOCOL)
    assert.deepEqual(await roundTrip(byProtocol.ws), { id: 1, result: { ok: true } })
    byProtocol.ws.close()
  } finally {
    await transport.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('loopback listener without auth keeps accepting clients that send no token', async () => {
  const auth = resolveWebSocketAuth('127.0.0.1', 0, {}, {})
  const transport = await startWebSocketTransport('ws://127.0.0.1:0', echo, () => {}, undefined, {
    auth,
  })
  try {
    const plain = await attempt(transport.address)
    assert.ok(plain.ws)
    assert.deepEqual(await roundTrip(plain.ws), { id: 1, result: { ok: true } })
    plain.ws.close()
    assert.equal(
      (await attempt(transport.address, { origin: 'http://localhost:3000' })).status,
      403,
    )
  } finally {
    await transport.close()
  }
})

test('listener binds the IPv6 loopback address and reports the bound port', async (t) => {
  // The bracketed host from the URL counts as loopback, so no token is needed.
  const auth = resolveWebSocketAuth('[::1]', 0, {}, {})
  assert.equal(auth.mode, 'none')
  let transport: Awaited<ReturnType<typeof startWebSocketTransport>>
  try {
    transport = await startWebSocketTransport('ws://[::1]:0', echo, () => {}, undefined, { auth })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
      t.skip(`this host has no IPv6 loopback (${code})`)
      return
    }
    throw error
  }
  try {
    assert.match(transport.address, /^ws:\/\/\[::1\]:\d+$/)
    assert.notEqual(transport.address, 'ws://[::1]:0')
    const plain = await attempt(transport.address)
    assert.ok(plain.ws)
    assert.deepEqual(await roundTrip(plain.ws), { id: 1, result: { ok: true } })
    plain.ws.close()
  } finally {
    await transport.close()
  }
})

test('adapter creates a private token file and refuses an unprotected public listener', {
  timeout: 20_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-ws-auth-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: home,
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
  }
  delete env.CLAUDE_CODEX_HOME
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_CODEX_WS_')) delete env[name]
  }
  let proc: ChildProcess | null = null
  try {
    const refused = await runToExit(['app-server', '--listen', 'ws://0.0.0.0:0'], env)
    assert.equal(refused.code, 1)
    assert.match(refused.output, /refusing to start non-loopback websocket listener/)
    assert.match(refused.output, /--ws-auth capability-token/)
    assert.match(refused.output, /--ws-allow-unauthenticated/)
    // A configuration mistake shows its message, not a stack trace.
    assert.equal(refused.output.trim().split('\n').length, 1, refused.output)
    const misplacedMessage =
      '[claude-codex-adapter] --ws-auth, --ws-token-file, --ws-token-sha256, --ws-allowed-origins and --ws-allow-unauthenticated need --listen ws://\n'
    assert.deepEqual(await runToExit(['app-server', '--ws-auth', 'none'], env), {
      code: 1,
      output: misplacedMessage,
    })
    assert.deepEqual(await runToExit(['app-server', '--ws-allow-unauthenticated'], env), {
      code: 1,
      output: misplacedMessage,
    })
    // The opt-out reaches the auth check (refused here before it binds).
    const conflicting = await runToExit(
      [
        'app-server',
        '--listen',
        'ws://0.0.0.0:0',
        '--ws-allow-unauthenticated',
        '--ws-auth',
        'capability-token',
      ],
      env,
    )
    assert.equal(conflicting.code, 1)
    assert.match(conflicting.output, /cannot be combined with websocket token auth/)
    const tokenFile = join(home, 'claude-codex-adapter', 'ws-token')
    await assert.rejects(stat(tokenFile), { code: 'ENOENT' })

    proc = spawn(
      process.execPath,
      [adapter, 'app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token'],
      { stdio: ['ignore', 'ignore', 'pipe'], env },
    )
    const output = collect(proc)
    const url = await waitForListening(proc, output)
    const token = (await readFile(tokenFile, 'utf8')).trim()
    if (process.platform !== 'win32') assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
    assert.ok(output().includes(`${tokenFile} (created)`))
    assert.equal(output().includes(token), false)

    assert.equal((await attempt(url)).status, 401)
    const connected = await attempt(url, { bearer: token })
    assert.ok(connected.ws)
    const reply = await roundTrip(connected.ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
    })
    assert.equal((reply.result as { codexHome: string }).codexHome, home)
    connected.ws.close()
    assert.equal(output().includes(token), false)
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill()
      await once(proc, 'exit')
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

function echo(peer: RpcPeer, message: WireMessage): void {
  const id = (message as { id?: unknown }).id
  peer.send({ jsonrpc: '2.0', id, result: { ok: true } } as WireMessage)
}

interface Attempt {
  ws?: WebSocket
  status?: number
}

function attempt(
  url: string,
  options: { bearer?: string; protocols?: string[]; origin?: string } = {},
): Promise<Attempt> {
  return new Promise((resolvePromise, reject) => {
    const headers: Record<string, string> = {}
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`
    const ws = new WebSocket(url, options.protocols ?? [], {
      headers,
      ...(options.origin ? { origin: options.origin } : {}),
    })
    let settled = false
    ws.once('open', () => {
      settled = true
      resolvePromise({ ws })
    })
    ws.once('unexpected-response', (req, res) => {
      settled = true
      res.resume()
      ws.on('error', () => {})
      req.destroy()
      resolvePromise({ status: res.statusCode ?? 0 })
    })
    ws.once('error', (error) => {
      if (!settled) reject(error)
    })
  })
}

async function roundTrip(
  ws: WebSocket,
  message: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method: 'ping' },
): Promise<Record<string, unknown>> {
  const reply = new Promise<Record<string, unknown>>((resolveReply) => {
    const onMessage = (data: WebSocket.RawData): void => {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>
      if (parsed.id !== message.id || 'method' in parsed) return
      ws.off('message', onMessage)
      delete parsed.jsonrpc
      resolveReply(parsed)
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify(message))
  return await reply
}

async function runToExit(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
  const proc = spawn(process.execPath, [adapter, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  const output = collect(proc)
  // On close, once all of stderr has arrived.
  const [code] = (await once(proc, 'close')) as [number | null]
  return { code, output: output() }
}

// Just enough of an upgrade request for WebSocketAuth.verify.
function upgradeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
}

function collect(proc: ChildProcess): () => string {
  let text = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    text += chunk
  })
  return () => text
}

async function waitForListening(proc: ChildProcess, output: () => string): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const match = /listening on (ws:\/\/\S+)/.exec(output())
    if (match?.[1]) return match[1]
    if (proc.exitCode !== null) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`adapter did not start listening: ${output()}`)
}
