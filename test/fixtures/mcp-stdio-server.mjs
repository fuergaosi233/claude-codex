#!/usr/bin/env node
import { appendFileSync, writeSync } from 'node:fs'
import readline from 'node:readline'

// MCP_FIXTURE_STARTS names a file that gets a line each time the server starts.
if (process.env.MCP_FIXTURE_STARTS) appendFileSync(process.env.MCP_FIXTURE_STARTS, 'start\n')
// MCP_FIXTURE_EXIT exits before answering anything, as a broken server does,
// after writing MCP_FIXTURE_STDERR to stderr.
if (process.env.MCP_FIXTURE_EXIT) {
  if (process.env.MCP_FIXTURE_STDERR) writeSync(2, process.env.MCP_FIXTURE_STDERR)
  process.exit(Number(process.env.MCP_FIXTURE_EXIT))
}
const rl = readline.createInterface({ input: process.stdin })
// The tool call waiting for the client to answer the server's ping.
let pingCall = null
rl.on('line', (line) => {
  if (!line.trim()) return
  const request = JSON.parse(line)
  if (request.id === 'server-ping' && !request.method) {
    respond(pingCall, {
      content: [{ type: 'text', text: `pong:${JSON.stringify(request.result)}` }],
    })
    return
  }
  if (request.method === 'notifications/initialized') return
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    })
    return
  }
  if (request.method === 'tools/list') {
    // MCP_FIXTURE_TOOLS_ERROR fails the tool catalog of a server that started.
    if (process.env.MCP_FIXTURE_TOOLS_ERROR) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'tool catalog unavailable' } })}\n`,
      )
      return
    }
    respond(request.id, {
      _meta: { 'fixture/catalog': 'v1' },
      tools: [
        {
          name: 'echo',
          description: 'Echo back the provided value',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          annotations: { readOnlyHint: true },
          icons: [{ src: 'data:image/svg+xml,%3Csvg%2F%3E', mimeType: 'image/svg+xml' }],
          _meta: {
            ui: { resourceUri: 'ui://fixture/view.html', visibility: ['app'] },
            'openai/ui': { entrypoints: [{ type: 'global' }] },
          },
        },
      ],
    })
    return
  }
  if (request.method === 'resources/list') {
    respond(request.id, {
      resources: [{ uri: 'fixture://resource', name: 'fixture resource', mimeType: 'text/plain' }],
    })
    return
  }
  if (request.method === 'tools/call' && request.params.name === 'env') {
    // The value of the environment variable named by `value`.
    const value = process.env[request.params.arguments?.value ?? ''] ?? ''
    respond(request.id, { content: [{ type: 'text', text: `env:${value}` }], isError: false })
    return
  }
  if (request.method === 'tools/call' && request.params.name === 'process') {
    // Which process answers, where it runs, and the _meta the call carried.
    respond(request.id, {
      content: [{ type: 'text', text: `pid:${process.pid}` }],
      structuredContent: {
        pid: process.pid,
        cwd: process.cwd(),
        meta: request.params._meta ?? null,
      },
      isError: false,
    })
    return
  }
  if (request.method === 'tools/call' && request.params.name === 'ping') {
    // Asks the client for a ping before it answers.
    pingCall = request.id
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' })}\n`,
    )
    return
  }
  if (request.method === 'tools/call') {
    respond(request.id, {
      content: [
        {
          type: 'text',
          text: `tool:${request.params.name}:${request.params.arguments?.value ?? ''}`,
        },
      ],
      structuredContent: { ok: true },
      isError: false,
    })
    return
  }
  if (request.method === 'resources/read') {
    respond(request.id, {
      contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'resource-ok' }],
    })
    return
  }
  respond(request.id, null)
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
