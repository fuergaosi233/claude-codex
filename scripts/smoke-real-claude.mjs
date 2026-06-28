#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'claude-codex-real-smoke-'))
const adapter = resolve('dist/src/adapter.mjs')
const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_HOME: home, NODE_NO_WARNINGS: '1' },
})

let buffer = ''
const queue = []
const waiters = []
proc.stdout.setEncoding('utf8')
proc.stdout.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    const message = JSON.parse(line)
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  }
})
proc.stderr.setEncoding('utf8')
proc.stderr.on('data', (chunk) => process.stderr.write(chunk))

function send(message) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function next() {
  const existing = queue.shift()
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => waiters.push(resolve))
}

async function nextResponse(id) {
  for (;;) {
    const message = await next()
    if (message.id === id && message.method == null) return message
  }
}

const timeout = setTimeout(() => {
  proc.kill()
  console.error('real Claude smoke timed out')
  process.exit(1)
}, 120_000)

try {
  send({
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'smoke', title: 'Smoke', version: '0' }, capabilities: null },
  })
  await nextResponse(1)
  send({
    id: 2,
    method: 'thread/start',
    params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
  })
  const started = await nextResponse(2)
  const threadId = started.result.thread.id
  send({
    id: 3,
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text: 'Reply with exactly: claude-codex-ok', text_elements: [] }],
    },
  })
  await nextResponse(3)
  let text = ''
  for (;;) {
    const message = await next()
    if (message.method === 'item/agentMessage/delta') text += message.params.delta
    if (message.method === 'turn/completed') break
  }
  assert.match(text, /claude-codex-ok/i)
  console.log('real Claude smoke passed')
} finally {
  clearTimeout(timeout)
  proc.kill()
  await rm(home, { recursive: true, force: true })
}
