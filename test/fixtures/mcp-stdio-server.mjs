#!/usr/bin/env node
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const request = JSON.parse(line)
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
    respond(request.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo back the provided value',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
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
