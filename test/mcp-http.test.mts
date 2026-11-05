import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { callMcpTool, readMcpResource } from '../src/mcp.mjs'

// A streamable HTTP MCP server that answers each request as an event stream:
// a log notification, then the reply, written in two pieces. With `keepOpen`
// it leaves the stream open after the reply, as the transport allows, and
// answers notifications with a stream it never ends.
async function withStreamingServer(
  keepOpen: boolean,
  body: (call: () => Promise<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const open = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      text += chunk
    })
    req.on('end', () => {
      if (req.method === 'DELETE') {
        res.end()
        return
      }
      const message = JSON.parse(text)
      if (message.id == null) {
        // A notification has no reply; this server opens a stream for it anyway.
        if (keepOpen) {
          res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders()
          open.add(res)
        } else {
          res.writeHead(202).end()
        }
        return
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { resources: {}, tools: {} },
              serverInfo: { name: 'streaming', version: '1.0.0' },
            }
          : message.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'called' }] }
            : { contents: [{ uri: 'memo://note', text: 'hello' }] }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' })
      const log = { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'working' } }
      res.write(`event: message\r\ndata: ${JSON.stringify(log)}\r\n\r\n`)
      const reply = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`
      const half = Math.floor(reply.length / 2)
      res.write(reply.slice(0, half))
      setTimeout(() => {
        if (keepOpen) {
          res.write(reply.slice(half))
          open.add(res)
        } else {
          res.end(reply.slice(half))
        }
      }, 20)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const saved = {
    servers: process.env.CLAUDE_CODEX_MCP_SERVERS,
    timeout: process.env.CLAUDE_CODEX_MCP_TIMEOUT_MS,
  }
  process.env.CLAUDE_CODEX_MCP_SERVERS = JSON.stringify({
    streaming: { type: 'http', url: `http://127.0.0.1:${address.port}/mcp` },
  })
  process.env.CLAUDE_CODEX_MCP_TIMEOUT_MS = '3000'
  try {
    await body(() => readMcpResource('streaming', 'memo://note', { inherit: false }))
  } finally {
    restoreEnv('CLAUDE_CODEX_MCP_SERVERS', saved.servers)
    restoreEnv('CLAUDE_CODEX_MCP_TIMEOUT_MS', saved.timeout)
    for (const res of open) res.destroy()
    server.closeAllConnections()
    server.close()
  }
}

test('an HTTP MCP reply is read from an event stream the server keeps open', async () => {
  await withStreamingServer(true, async (read) => {
    const started = Date.now()
    const result = await read()
    assert.deepEqual(result, { contents: [{ uri: 'memo://note', text: 'hello' }] })
    assert.ok(Date.now() - started < 2_000, 'answered before the MCP timeout')
    const called = await callMcpTool('streaming', 'echo', {}, { inherit: false })
    assert.deepEqual(called.content, [{ type: 'text', text: 'called' }])
  })
})

test('an HTTP MCP reply is read from an event stream the server ends', async () => {
  await withStreamingServer(false, async (read) => {
    assert.deepEqual(await read(), { contents: [{ uri: 'memo://note', text: 'hello' }] })
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
