#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'claude-codex-capability-probe-'))
const adapter = resolve('dist/src/adapter.mjs')
const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: process.env.CLAUDE_CODEX_MOCK ?? '1', NODE_NO_WARNINGS: '1' },
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

function send(message) { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') }
function next() {
  const existing = queue.shift()
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => waiters.push(resolve))
}
async function response(id) { for (;;) { const message = await next(); if (message.id === id && message.method == null) return message } }
async function waitFor(method, predicate = () => true) {
  for (;;) {
    const message = await next()
    if (message.method === method && predicate(message.params ?? {})) return message
  }
}

const timeout = setTimeout(() => { proc.kill(); console.error('capability probe timed out'); process.exit(1) }, 120000)
try {
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', title: 'Probe', version: '0' }, capabilities: { experimentalApi: true } } })
  const init = await response(1)
  assert.match(init.result.userAgent, /0\.130\.0/)

  send({ id: 2, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } })
  const started = await response(2)
  const threadId = started.result.thread.id

  const outputSchema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }
  send({ id: 3, method: 'turn/start', params: { threadId, model: 'gpt-5.4-mini', outputSchema, input: [{ type: 'text', text: 'output schema check', text_elements: [] }] } })
  await response(3)
  let titleText = ''
  for (;;) {
    const message = await next()
    if (message.method === 'item/agentMessage/delta') titleText += message.params.delta
    if (message.method === 'turn/completed') break
  }
  assert.equal(typeof JSON.parse(titleText), 'object')

  send({ id: 4, method: 'process/spawn', params: { processHandle: 'probe-process', command: 'printf process-ok', cwd: process.cwd() } })
  await response(4)
  const processExit = await waitFor('process/exited', (params) => params.processHandle === 'probe-process')
  assert.equal(processExit.params.exitCode, 0)
  assert.equal(processExit.params.stdout, 'process-ok')

  send({ id: 5, method: 'thread/compact/start', params: { threadId } })
  await response(5)
  await waitFor('item/completed', (params) => params.threadId === threadId && params.item?.type === 'contextCompaction')

  send({ id: 6, method: 'review/start', params: { threadId, delivery: 'inline', target: { type: 'custom', instructions: 'Review probe only.' } } })
  const review = await response(6)
  assert.equal(review.result.reviewThreadId, threadId)
  await waitFor('turn/completed', (params) => params.threadId === threadId && params.turn?.id === review.result.turn.id)

  console.log('capability probe passed')
} finally {
  clearTimeout(timeout)
  proc.kill()
  await rm(home, { recursive: true, force: true })
}
