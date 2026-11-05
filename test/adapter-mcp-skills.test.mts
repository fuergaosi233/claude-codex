import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  adapter,
  awaitMessage,
  JsonLineReader,
  json,
  nextNotification,
} from './support/adapter-harness.mjs'

test('mcpServerStatus/list and startup notifications use conformant Codex v2 shapes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        github: { type: 'stdio', command: 'github-mcp' },
      }),
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    // Boot-time startup notification: correct method + valid McpServerStartupState.
    // The boot notifications are flushed via queueMicrotask, so they can land
    // before the initialize response — scan every message rather than reading
    // (and discarding) the response first.
    let startup = null
    let sawInit = false
    for (let i = 0; i < 50; i += 1) {
      const message = await reader.next()
      if (message.method === 'mcpServer/startupStatus/updated') startup = message.params
      if (message.id === 1 && message.method == null) sawInit = true
      if (startup && sawInit) break
    }
    assert.ok(startup, 'expected mcpServer/startupStatus/updated notification')
    assert.equal(startup.name, 'github')
    assert.ok(
      ['starting', 'ready', 'failed', 'cancelled'].includes(startup.status),
      `invalid startup state ${startup.status}`,
    )

    proc.stdin.write(json({ id: 2, method: 'mcpServerStatus/list', params: {} }))
    const list = await reader.nextResponse(2)
    const entry = list.result.data[0]
    assert.equal(entry.name, 'github')
    // Every field McpServerStatus requires, in 0.159 and 0.163 alike, plus
    // the toolListMeta 0.164 adds: the nullable ones are present as null.
    assert.deepEqual(Object.keys(entry).sort(), [
      'authStatus',
      'httpOrigin',
      'name',
      'pluginId',
      'resourceTemplates',
      'resources',
      'runtimeStatus',
      'serverCapabilities',
      'serverInfo',
      'toolListMeta',
      'tools',
      'toolsError',
    ])
    assert.deepEqual(entry.tools, {})
    assert.deepEqual(entry.resources, [])
    assert.deepEqual(entry.resourceTemplates, [])
    assert.ok(['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(entry.authStatus))
    assert.ok(!('status' in entry), 'McpServerStatus has no startup status field')
    // The server's command does not exist: nothing started, so the tool
    // catalog failed and nothing else is known.
    assert.match(entry.toolsError, /ENOENT/)
    assert.equal(entry.runtimeStatus, null)
    assert.equal(entry.serverInfo, null)
    assert.equal(entry.serverCapabilities, null)
    assert.equal(entry.toolListMeta, null)
    assert.equal(entry.pluginId, null)
    assert.equal(entry.httpOrigin, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('MCP sign-in says where to sign in, and a reload reaches the runtime and the App', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        github: { type: 'http', url: 'https://mcp.example.com/github' },
      }),
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    // The Agent SDK cannot start Claude Code's sign-in, so the App gets an
    // error naming where to sign in instead of a link that leads nowhere.
    proc.stdin.write(json({ id: 1, method: 'mcpServer/oauth/login', params: { name: 'github' } }))
    const login = await reader.nextResponse(1)
    assert.equal(login.result, undefined)
    assert.equal(
      login.error.message,
      'Claude Code signs in to MCP servers itself, and the adapter cannot start that sign-in. Sign in to "github" with /mcp in a Claude Code session that has it configured.',
    )

    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(2)).result.thread.id
    // The mock runtime answers with how many reloads have reached it.
    const reloadsSeen = async (id: number): Promise<string> => {
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: {
            threadId,
            input: [{ type: 'text', text: 'mcp reload check', text_elements: [] }],
          },
        }),
      )
      let text = ''
      for (let i = 0; i < 200; i += 1) {
        const message = await reader.next()
        if (message.method === 'item/agentMessage/delta') text += message.params.delta
        if (message.method === 'turn/completed') break
      }
      return text
    }
    assert.equal(await reloadsSeen(3), '0 MCP reloads')

    proc.stdin.write(json({ id: 4, method: 'config/mcpServer/reload', params: {} }))
    const statuses: any[] = []
    let reloaded: any = null
    for (let i = 0; i < 50 && !reloaded; i += 1) {
      const message = await reader.next()
      if (message.method === 'mcpServer/startupStatus/updated') statuses.push(message.params)
      if (message.id === 4 && message.method == null) reloaded = message
    }
    assert.deepEqual(reloaded.result, {})
    assert.deepEqual(statuses, [{ name: 'github', status: 'ready', error: null }])
    assert.equal(await reloadsSeen(5), '1 MCP reloads')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcp status list reflects configured Claude SDK MCP servers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        demo: { type: 'stdio', command: 'node', args: ['mcp.js'] },
        other: { type: 'stdio', command: 'node', args: ['other.js'] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    // Codex v2 McpServerStatus shape: { name, tools, resources, resourceTemplates, authStatus }.
    assert.deepEqual(
      response.result.data.map((server: any) => server.name),
      ['demo', 'other'],
    )
    assert.deepEqual(response.result.data[0].tools, {})
    assert.deepEqual(response.result.data[0].resources, [])
    assert.deepEqual(response.result.data[0].resourceTemplates, [])
    assert.ok(
      ['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(
        response.result.data[0].authStatus,
      ),
    )
    // serverName narrows the list to that server.
    proc.stdin.write(
      json({ id: 2, method: 'mcpServerStatus/list', params: { serverName: 'other' } }),
    )
    const one = await reader.nextResponse(2)
    assert.deepEqual(
      one.result.data.map((server: any) => server.name),
      ['other'],
    )
    assert.equal(one.result.nextCursor, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('direct MCP stdio resource and tool calls work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        fixture: { type: 'stdio', command: process.execPath, args: [fixture] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'mcpServer/tool/call',
        params: { threadId: 't', server: 'fixture', tool: 'echo', arguments: { value: 'ok' } },
      }),
    )
    const tool = await reader.nextResponse(1)
    assert.equal(tool.result.content[0].text, 'tool:echo:ok')
    assert.equal(tool.result.structuredContent.ok, true)

    proc.stdin.write(
      json({
        id: 2,
        method: 'mcpServer/resource/read',
        params: {
          threadId: 't',
          server: 'fixture',
          uri: 'fixture://resource',
          originCallId: 'call-1',
        },
      }),
    )
    const resource = await reader.nextResponse(2)
    assert.equal(resource.result.contents[0].uri, 'fixture://resource')
    assert.equal(resource.result.contents[0].text, 'resource-ok')
    // No hosted app scoped the read.
    assert.equal(resource.result.originCallId, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcpServerStatus/list enumerates tools and resources from the server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        fixture: { type: 'stdio', command: process.execPath, args: [fixture] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    const entry = response.result.data[0]
    assert.equal(entry.name, 'fixture')
    assert.ok(entry.tools.echo, 'expected the echo tool enumerated into the map')
    assert.equal(entry.tools.echo.name, 'echo')
    assert.ok(entry.tools.echo.inputSchema, 'tool must carry its inputSchema')
    // And, as Codex lists it, its annotations, icons and _meta.
    assert.deepEqual(entry.tools.echo.annotations, { readOnlyHint: true })
    assert.equal(entry.tools.echo.icons[0].mimeType, 'image/svg+xml')
    assert.equal(entry.tools.echo._meta.ui.resourceUri, 'ui://fixture/view.html')
    assert.equal(entry.resources[0].uri, 'fixture://resource')
    assert.ok(['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(entry.authStatus))
    // What the server's initialize reply and tool catalog said of it.
    assert.deepEqual(entry.serverInfo, {
      name: 'fixture',
      title: null,
      version: '1.0.0',
      description: null,
      icons: null,
      websiteUrl: null,
    })
    assert.deepEqual(entry.serverCapabilities, { tools: {}, resources: {} })
    assert.deepEqual(entry.toolListMeta, { 'fixture/catalog': 'v1' })
    assert.equal(entry.toolsError, null)
    // A stdio server has no HTTP origin, and no thread asked: no session state.
    assert.equal(entry.httpOrigin, null)
    assert.equal(entry.runtimeStatus, null)
    assert.equal(entry.pluginId, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcpServerStatus/list says which servers failed and how a live session sees them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')
  // A remote server that wants a sign-in the adapter does not have.
  const signIn = http.createServer((_req, res) => {
    res.statusCode = 401
    res.end('sign in first')
  })
  await new Promise<void>((resolve) => signIn.listen(0, '127.0.0.1', resolve))
  const address = signIn.address()
  const port = address && typeof address === 'object' ? address.port : 0
  const stdio = (env: Record<string, string> = {}) => ({
    type: 'stdio',
    command: process.execPath,
    args: [fixture],
    env,
  })
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        fixture: stdio(),
        broken: stdio({ MCP_FIXTURE_EXIT: '3' }),
        catalog: stdio({ MCP_FIXTURE_TOOLS_ERROR: '1' }),
        missing: { type: 'stdio', command: join(home, 'no-such-server') },
        remote: { type: 'sse', url: 'https://user:secret@mcp.example.com:8443/sse?team=1' },
        guarded: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  const byName = (data: any[]) => Object.fromEntries(data.map((entry) => [entry.name, entry]))
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const listed = byName((await reader.nextResponse(1)).result.data)

    // A server that exits before it answers, and one that never starts.
    assert.match(listed.broken.toolsError, /exited with code 3/)
    assert.equal(listed.broken.serverInfo, null)
    assert.match(listed.missing.toolsError, /ENOENT/)
    // A server that started but could not list its tools: what it said of
    // itself stays, and its resources are still listed.
    assert.match(listed.catalog.toolsError, /tool catalog unavailable/)
    assert.equal(listed.catalog.serverInfo.name, 'fixture')
    assert.deepEqual(listed.catalog.tools, {})
    assert.equal(listed.catalog.toolListMeta, null)
    assert.equal(listed.catalog.resources[0].uri, 'fixture://resource')
    // Servers the adapter cannot reach on its own are not failed ones: one
    // over a transport it does not speak, and one that wants a sign-in.
    // Their HTTP origin is known all the same, without credentials or path.
    assert.equal(listed.remote.toolsError, null)
    assert.equal(listed.remote.serverInfo, null)
    assert.equal(listed.remote.httpOrigin, 'https://mcp.example.com:8443')
    assert.equal(listed.guarded.toolsError, null)
    assert.equal(listed.guarded.httpOrigin, `http://127.0.0.1:${port}`)
    assert.equal(listed.fixture.toolsError, null)
    // Without a thread, no connection state is claimed for any of them.
    for (const entry of Object.values(listed) as any[]) assert.equal(entry.runtimeStatus, null)

    // A Claude thread whose session sees its servers.
    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(2)).result.thread.id
    const prompt =
      'mcp session fixture=connected remote=connected broken=failed missing=needs-auth catalog=pending guarded=disabled'
    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] },
      }),
    )
    for (let i = 0; i < 200; i += 1) {
      if ((await reader.next()).method === 'turn/completed') break
    }
    proc.stdin.write(json({ id: 4, method: 'mcpServerStatus/list', params: { threadId } }))
    const seen = byName((await reader.nextResponse(4)).result.data)
    assert.deepEqual(
      Object.fromEntries(
        Object.values(seen).map((entry: any) => [entry.name, entry.runtimeStatus]),
      ),
      {
        fixture: 'connected',
        broken: 'failed',
        catalog: 'starting',
        missing: 'authenticationRequired',
        remote: 'connected',
        guarded: 'disabled',
      },
    )
    // What the server told the adapter wins; the session names a server the
    // adapter could not reach.
    assert.equal(seen.fixture.serverInfo.name, 'fixture')
    assert.deepEqual(seen.remote.serverInfo, {
      name: 'remote-session',
      title: null,
      version: '2.0.0',
      description: null,
      icons: null,
      websiteUrl: null,
    })
    // The rest is the adapter's own finding, as before.
    assert.match(seen.catalog.toolsError, /tool catalog unavailable/)

    // A thread-less list right after still claims no connection state.
    proc.stdin.write(json({ id: 5, method: 'mcpServerStatus/list', params: {} }))
    const again = (await reader.nextResponse(5)).result.data
    for (const entry of again) assert.equal(entry.runtimeStatus, null)
  } finally {
    proc.kill()
    signIn.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcpServerStatus/list looks at servers once, within a deadline, and keeps secrets out', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')
  const starts = join(home, 'starts.log')
  // A streamable HTTP server as the MCP SDKs serve one: it takes clients that
  // accept an event stream, keeps a session, and answers tools/list as a
  // stream that logs before it replies.
  const seen: string[] = []
  const streamable = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const session = req.headers['mcp-session-id']
      if (req.method === 'DELETE') {
        seen.push(`DELETE ${session}`)
        res.end()
        return
      }
      if (!String(req.headers.accept).includes('text/event-stream')) {
        res.statusCode = 406
        res.end('Not Acceptable: Client must accept both application/json and text/event-stream')
        return
      }
      const message = JSON.parse(body)
      seen.push(`${message.method} ${session ?? '-'}`)
      if (message.method === 'initialize') {
        res.setHeader('content-type', 'application/json')
        res.setHeader('mcp-session-id', 'session-1')
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'streamable', version: '3.0.0' },
            },
          }),
        )
        return
      }
      if (session !== 'session-1') {
        res.statusCode = 400
        res.end('Bad Request: Mcp-Session-Id header is required')
        return
      }
      if (message.id == null) {
        res.statusCode = 202
        res.end()
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      const log = { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'listing' } }
      const reply =
        message.method === 'tools/list'
          ? { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'lookup' }] } }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } }
      res.end(
        `event: message\ndata: ${JSON.stringify(log)}\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`,
      )
    })
  })
  // A server that never answers.
  const stalled = http.createServer(() => {})
  const listen = async (server: http.Server) => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    return address && typeof address === 'object' ? address.port : 0
  }
  const streamablePort = await listen(streamable)
  const stalledPort = await listen(stalled)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_TIMEOUT_MS: '2000',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        counted: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: { MCP_FIXTURE_STARTS: starts },
        },
        noisy: {
          type: 'stdio',
          command: process.execPath,
          args: [fixture],
          env: { MCP_FIXTURE_EXIT: '4', MCP_FIXTURE_STDERR: `${'noise '.repeat(1500)}last words` },
        },
        streamable: { type: 'http', url: `http://127.0.0.1:${streamablePort}/mcp` },
        stalled: { type: 'http', url: `http://127.0.0.1:${stalledPort}/mcp` },
        leaky: {
          type: 'http',
          url: `http://user:secret@127.0.0.1:${streamablePort}/mcp?token=hidden`,
        },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  const byName = (data: any[]) => Object.fromEntries(data.map((entry) => [entry.name, entry]))
  const startCount = async () => (await readFile(starts, 'utf8')).split('\n').filter(Boolean).length
  try {
    // Two lists asked for at once share one look at the servers.
    const asked = Date.now()
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    proc.stdin.write(
      json({ id: 2, method: 'mcpServerStatus/list', params: { serverName: 'counted' } }),
    )
    const responses = new Map<number, any>()
    while (responses.size < 2) {
      const message = await reader.next()
      if (message.method == null && (message.id === 1 || message.id === 2)) {
        responses.set(message.id, message)
      }
    }
    const waited = Date.now() - asked
    assert.equal(await startCount(), 1)
    assert.deepEqual(
      responses.get(2).result.data.map((entry: any) => entry.name),
      ['counted'],
    )
    const listed = byName(responses.get(1).result.data)
    assert.equal(listed.counted.toolsError, null)

    // The server that never answers is given up on at the deadline, and the
    // list does not wait any longer for it.
    assert.match(listed.stalled.toolsError, /timed out/)
    assert.ok(waited < 10_000, `the list took ${waited} ms`)

    // The streamable server is spoken to as its SDK expects: with its
    // session, a stream reply read past the log before it, and the session
    // ended afterwards.
    assert.equal(listed.streamable.toolsError, null)
    assert.equal(listed.streamable.serverInfo.name, 'streamable')
    assert.deepEqual(Object.keys(listed.streamable.tools), ['lookup'])
    for (let i = 0; i < 100 && !seen.includes('DELETE session-1'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.deepEqual(seen.slice(0, 2), ['initialize -', 'notifications/initialized session-1'])
    assert.deepEqual(seen.slice(2, -1).sort(), [
      'resources/list session-1',
      'resources/templates/list session-1',
      'tools/list session-1',
    ])
    assert.equal(seen.at(-1), 'DELETE session-1')

    // An error says why a server failed without what its url or stderr
    // would spill: credentials and query stay out, and only the end of a
    // long stderr comes along.
    assert.match(listed.leaky.toolsError, /credentials/)
    assert.doesNotMatch(listed.leaky.toolsError, /secret|hidden/)
    assert.equal(listed.leaky.httpOrigin, `http://127.0.0.1:${streamablePort}`)
    assert.match(listed.noisy.toolsError, /exited with code 4: .*noise last words$/)
    assert.ok(listed.noisy.toolsError.length < 2_100, `${listed.noisy.toolsError.length} chars`)

    // A list asked for again soon after is answered from that look.
    proc.stdin.write(json({ id: 3, method: 'mcpServerStatus/list', params: {} }))
    assert.equal(byName((await reader.nextResponse(3)).result.data).counted.toolsError, null)
    assert.equal(await startCount(), 1)
  } finally {
    proc.kill()
    streamable.close()
    stalled.closeAllConnections()
    stalled.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('fuzzyFileSearch session streams updated and completed notifications', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  await writeFile(join(home, 'findme-fixture.txt'), 'x')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'fuzzyFileSearch/sessionStart',
        params: { sessionId: 's1', roots: [home] },
      }),
    )
    await reader.nextResponse(1)

    proc.stdin.write(
      json({
        id: 2,
        method: 'fuzzyFileSearch/sessionUpdate',
        params: { sessionId: 's1', query: 'findme' },
      }),
    )
    const updated = await nextNotification(reader, 'fuzzyFileSearch/sessionUpdated')
    assert.equal(updated.params.sessionId, 's1')
    assert.equal(updated.params.query, 'findme')
    const files = Array.isArray(updated.params.files) ? updated.params.files : []
    assert.ok(
      files.some((file: Record<string, unknown>) =>
        String(file.path).endsWith('findme-fixture.txt'),
      ),
    )
    await reader.nextResponse(2)

    proc.stdin.write(
      json({ id: 3, method: 'fuzzyFileSearch/sessionStop', params: { sessionId: 's1' } }),
    )
    const completed = await nextNotification(reader, 'fuzzyFileSearch/sessionCompleted')
    assert.equal(completed.params.sessionId, 's1')
    await reader.nextResponse(3)

    proc.stdin.write(
      json({
        id: 4,
        method: 'fuzzyFileSearch/sessionUpdate',
        params: { sessionId: 's1', query: 'findme' },
      }),
    )
    const afterStop = await reader.next()
    assert.equal(afterStop.id, 4)
    assert.equal(afterStop.method, undefined)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('skills/list and hooks/list surface Claude Code skills and settings hooks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const workspace = join(home, 'ws')
  await mkdir(join(home, '.claude', 'skills', 'user-skill'), { recursive: true })
  await writeFile(
    join(home, '.claude', 'skills', 'user-skill', 'SKILL.md'),
    '---\nname: user-skill\ndescription: A user skill for tests\n---\nbody\n',
  )
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    }),
  )
  await mkdir(join(workspace, '.claude', 'skills', 'demo-skill'), { recursive: true })
  await writeFile(
    join(workspace, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for tests\n---\nbody\n',
  )
  await writeFile(
    join(workspace, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'ignored' }] }],
      },
    }),
  )
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'skills/list', params: { cwds: [workspace] } }))
    const skills = await reader.nextResponse(1)
    const entry = skills.result.data.find((item: Record<string, unknown>) => item.cwd === workspace)
    assert.ok(entry, 'expected a skills entry for the workspace cwd')
    const skillList = Array.isArray(entry.skills) ? entry.skills : []
    const demo = skillList.find((skill: Record<string, unknown>) => skill.name === 'demo-skill')
    assert.ok(demo, 'expected the demo skill enumerated from .claude/skills')
    assert.equal(demo.description, 'A demo skill for tests')
    assert.equal(demo.scope, 'repo')
    assert.equal(demo.enabled, true)
    const userSkill = skillList.find(
      (skill: Record<string, unknown>) => skill.name === 'user-skill',
    )
    assert.ok(userSkill, 'expected the user skill enumerated from HOME/.claude/skills')
    assert.equal(userSkill.description, 'A user skill for tests')
    assert.equal(userSkill.scope, 'user')
    assert.equal(userSkill.enabled, true)

    proc.stdin.write(json({ id: 2, method: 'hooks/list', params: { cwds: [workspace] } }))
    const hooks = await reader.nextResponse(2)
    const hooksEntry = hooks.result.data.find(
      (item: Record<string, unknown>) => item.cwd === workspace,
    )
    assert.ok(hooksEntry, 'expected a hooks entry for the workspace cwd')
    const hookList = Array.isArray(hooksEntry.hooks) ? hooksEntry.hooks : []
    const pre = hookList.find(
      (hook: Record<string, unknown>) => hook.source === 'project' && hook.command === 'echo hi',
    )
    assert.ok(pre, 'expected the project PreToolUse hook mapped to preToolUse')
    assert.equal(pre.eventName, 'preToolUse')
    assert.equal(pre.matcher, 'Bash')
    assert.equal(pre.handlerType, 'command')
    assert.ok(typeof pre.currentHash === 'string' && pre.currentHash.length > 0)
    const userHook = hookList.find(
      (hook: Record<string, unknown>) => hook.source === 'user' && hook.command === 'echo user',
    )
    assert.ok(userHook, 'expected the user settings hook mapped from HOME/.claude/settings.json')
    assert.equal(userHook.eventName, 'postToolUse')
    assert.equal(userHook.matcher, 'Edit')
    assert.equal(userHook.handlerType, 'command')
    assert.ok(!hookList.some((hook: Record<string, unknown>) => hook.eventName === 'notification'))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude Code built-in commands are listed as skills and run as slash commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const adapterDir = join(home, 'adapter')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      HOME: home,
      CLAUDE_CODEX_HOME: adapterDir,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'skills/list', params: { cwds: [home] } }))
    const skills = await reader.nextResponse(1)
    const simplify = skills.result.data[0].skills.find(
      (skill: Record<string, unknown>) => skill.name === 'simplify',
    )
    assert.ok(simplify, 'expected /simplify in the App skill list')
    assert.equal(simplify.scope, 'system')
    assert.equal(simplify.enabled, true)
    assert.match(simplify.shortDescription, /^Review the changed code for reuse/)
    assert.equal(simplify.path, join(adapterDir, 'claude-commands', 'simplify', 'SKILL.md'))
    // The App opens `path` when the chip is clicked.
    assert.match(await readFile(simplify.path, 'utf8'), /runs `\/simplify \[<target>\]`/)

    proc.stdin.write(
      json({
        id: 2,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    await reader.nextResponse(2)
    proc.stdin.write(json({ id: 3, method: 'thread/start', params: { cwd: home } }))
    const threadId = (await reader.nextResponse(3)).result.thread.id
    // What the composer sends after the user picks /simplify and types.
    const text = `[$simplify](${simplify.path}) focus on the parser`
    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text, text_elements: [] }] },
      }),
    )
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    const reply = seen
      .filter((message) => message.method === 'item/agentMessage/delta')
      .map((message) => message.params.delta)
      .join('')
    assert.match(reply, /mock response for: \/simplify focus on the parser$/)
    // The transcript keeps what the user sent.
    proc.stdin.write(
      json({ id: 5, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(5)
    const userMessage = read.result.thread.turns[0].items.find(
      (item: Record<string, unknown>) => item.type === 'userMessage',
    )
    assert.equal(userMessage?.content[0].text, text)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('direct MCP HTTP tool calls work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const httpServer = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const message = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      if (message.method === 'initialize') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'http-fixture', version: '1' },
            },
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: `http:${message.params.name}` }],
            structuredContent: { http: true },
            isError: false,
          },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  assert.equal(typeof address, 'object')
  const url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({ fixture: { type: 'http', url } }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'mcpServer/tool/call',
        params: { threadId: 't', server: 'fixture', tool: 'echo', arguments: {} },
      }),
    )
    const tool = await reader.nextResponse(1)
    assert.equal(tool.result.content[0].text, 'http:echo')
    assert.equal(tool.result.structuredContent.http, true)
  } finally {
    proc.kill()
    httpServer.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
