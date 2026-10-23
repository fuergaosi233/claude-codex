import assert from 'node:assert/strict'
import test from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { type InProcessApp, withInProcessApp } from './fixtures/in-process-app.mjs'

// A compaction Claude could not do is a notice: a warning, and a row under
// the turn, which goes on.

const REFUSAL = 'Claude could not compact the conversation: mock safeguard refusal'

const storedTypes = (app: InProcessApp, turnId: string): string[] =>
  (app.store.getTurn(turnId)?.items ?? []).map((item) => item.type)

test('a compaction Claude refuses again and again says why once', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'auto compaction check, fails 3 times')
    assert.equal((await app.turnCompleted(turnId)).status, 'completed')
    assert.deepEqual(
      app.notified('warning').map((params) => params.message),
      [REFUSAL],
    )
    assert.deepEqual(app.notified('error'), [
      {
        threadId,
        turnId,
        willRetry: true,
        error: { message: REFUSAL, codexErrorInfo: null, additionalDetails: null },
      },
    ])
  })
})

test('a /compact Claude refuses shows the refusal as a row, and the summary still lands', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread()
    const first = await app.startTurn(threadId, 'next compaction fails')
    await app.turnCompleted(first)
    await app.request('thread/compact/start', { threadId })
    const compactTurn = await app.waitFor(
      () => app.notified('turn/started').find((params) => params.turn.id !== first)?.turn.id,
    )
    assert.equal((await app.turnCompleted(compactTurn)).status, 'completed')
    const message = 'Claude could not compact the conversation: mock compaction failure'
    assert.deepEqual(
      app
        .notified('error')
        .map((params) => [params.turnId, params.willRetry, params.error.message]),
      [[compactTurn, true, message]],
    )
    // The summary written instead compacts the thread: stored first.
    assert.equal(storedTypes(app, compactTurn)[0], 'contextCompaction')
  })
})
