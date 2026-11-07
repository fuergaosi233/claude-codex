import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeRpcParams } from '../src/server-helpers.mjs'

const secret = 'hunter2 私密\n'
const encoded = Buffer.from(secret).toString('base64')
const bytes = Buffer.byteLength(secret, 'utf8')

function summary(method: string, params: unknown) {
  const result = summarizeRpcParams(method, params)
  const json = JSON.stringify(result)
  assert.ok(!json.includes('hunter2'), method)
  assert.ok(!json.includes(encoded), method)
  return result
}

test('debug summaries omit steer inputs, diffs and injected items', () => {
  assert.deepEqual(
    summary('turn/steer', { threadId: 't', input: [{ type: 'text', text: secret }] }),
    { threadId: 't', inputTypes: ['text'] },
  )
  assert.deepEqual(summary('turn/diff/updated', { threadId: 't', diff: secret }), {
    threadId: 't',
    diffBytes: bytes,
  })
  assert.deepEqual(summary('thread/inject_items', { threadId: 't', items: [{ text: secret }] }), {
    threadId: 't',
    itemCount: 1,
  })
})

for (const method of ['process/writeStdin', 'command/exec/write']) {
  test(`debug summaries omit plain and base64 stdin for ${method}`, () => {
    for (const payload of [{ delta: secret }, { deltaBase64: encoded }, {}]) {
      assert.deepEqual(
        summary(method, {
          processHandle: 'h',
          processId: 'p',
          closeStdin: true,
          ...payload,
        }),
        {
          processHandle: 'h',
          processId: 'p',
          deltaBytes: Object.keys(payload).length ? bytes : 0,
          closeStdin: true,
        },
      )
    }
  })
}

test('debug file write summaries keep only path and byte count', () => {
  for (const payload of [{ data: secret }, { dataBase64: encoded }, {}]) {
    assert.deepEqual(summary('fs/writeFile', { path: '/tmp/file', ...payload }), {
      path: '/tmp/file',
      bytes: Object.keys(payload).length ? bytes : 0,
    })
  }
})

for (const method of [
  'item/agentMessage/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/plan/delta',
  'item/future/delta',
  'item/future/textDelta',
]) {
  test(`debug text summary counts characters for ${method}`, () => {
    assert.deepEqual(summary(method, { threadId: 't', turnId: 'u', itemId: 'i', delta: secret }), {
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      deltaChars: secret.length,
    })
  })
}

test('outputDelta retains its byte summary ahead of generic delta handling', () => {
  assert.deepEqual(
    summary('item/commandExecution/outputDelta', {
      processHandle: 'h',
      processId: 'p',
      itemId: 'i',
      stream: 'stdout',
      deltaBase64: encoded,
      capReached: false,
    }),
    {
      processHandle: 'h',
      processId: 'p',
      itemId: 'i',
      stream: 'stdout',
      deltaBytes: bytes,
      capReached: false,
    },
  )
})

test('missing content produces empty metadata', () => {
  assert.deepEqual(summarizeRpcParams('turn/steer', null), {
    threadId: undefined,
    inputTypes: [],
  })
  assert.deepEqual(summarizeRpcParams('turn/diff/updated', {}), {
    threadId: undefined,
    diffBytes: 0,
  })
  assert.deepEqual(summarizeRpcParams('thread/inject_items', {}), {
    threadId: undefined,
    itemCount: 0,
  })
  assert.deepEqual(summarizeRpcParams('item/reasoning/textDelta', {}), {
    threadId: undefined,
    turnId: undefined,
    itemId: undefined,
    deltaChars: 0,
  })
})
