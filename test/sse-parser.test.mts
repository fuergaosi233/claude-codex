import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { SseParser } from '../src/http-agent-runtime.mjs'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const events = [
  { level: 'warning', message: 'A' },
  { level: 'error', message: 'B' },
  { level: 'error', message: 'C' },
]
const batched = events
  .map((event) => `event: agent_error\ndata: ${JSON.stringify(event)}\n\n`)
  .join('')

for (const [label, chunks] of [
  ['one chunk', [batched]],
  ['split lines and event boundaries', [...batched]],
] as const) {
  test(`SSE dispatches independent events from ${label}`, { timeout: 5000 }, async () => {
    const received: { name: string; data: unknown }[] = []
    const done = deferred()
    const parser = new SseParser(async (name, data) => {
      received.push({ name, data: JSON.parse(data) })
      if (received.length === events.length) done.resolve()
    })
    for (const chunk of chunks) parser.push(chunk)
    await done.promise
    assert.deepEqual(
      received,
      events.map((data) => ({ name: 'agent_error', data })),
    )
  })
}

test('SSE resets names and preserves multiline data across CRLF chunks', {
  timeout: 5000,
}, async () => {
  const received: [string, string][] = []
  const done = deferred()
  const parser = new SseParser(async (name, data) => {
    received.push([name, data])
    if (received.length === 2) done.resolve()
  })
  parser.push('event: message_update\r\ndata: first\r')
  parser.push('\n: comment\r\ndata: second\r\n\r')
  parser.push('\ndata: next\r\n\r\n')
  await done.promise
  assert.deepEqual(received, [
    ['message_update', 'first\nsecond'],
    ['message', 'next'],
  ])
})

test('SSE waits for async callbacks and continues after rejection', { timeout: 5000 }, async () => {
  const received: string[] = []
  const release = deferred()
  const done = deferred()
  const parser = new SseParser(async (_name, data) => {
    received.push(data)
    if (data === 'first') {
      await release.promise
      throw new Error('callback failure')
    }
    if (data === 'third') done.resolve()
  })
  parser.push('data: first\n\ndata: second\n\ndata: third\n\n')
  await setImmediate()
  assert.deepEqual(received, ['first'])
  release.resolve()
  await done.promise
  assert.deepEqual(received, ['first', 'second', 'third'])
})
