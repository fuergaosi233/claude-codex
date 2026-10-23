import assert from 'node:assert/strict'
import test from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { type InProcessApp, scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

// The App draws a stored contextCompaction, or one item/completed closed, as
// "Context compacted", and an open one as compacting while its turn runs and
// as interrupted after it. So a compaction is stored only once it completes,
// and one that failed never ends as a compaction.

const REFUSAL = 'Claude could not compact the conversation: mock safeguard refusal'

const compactionEvents = (app: InProcessApp, method: string): any[] =>
  app.notified(method).filter((params) => params.item.type === 'contextCompaction')

const storedTypes = (app: InProcessApp, turnId: string): string[] =>
  (app.store.getTurn(turnId)?.items ?? []).map((item) => item.type)

test('a compaction Claude could not do leaves no compacted marker, and says why once', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'auto compaction check, fails 3 times')
    const turn = await app.turnCompleted(turnId)
    assert.equal(turn.status, 'completed')

    // Each try opened a compaction item, and each one closed as an empty
    // reasoning item, which the App does not draw.
    const started = compactionEvents(app, 'item/started')
    assert.equal(started.length, 3)
    assert.equal(new Set(started.map((params) => params.item.id)).size, 3)
    for (const params of started) {
      const completed = app
        .notified('item/completed')
        .filter((done) => done.item.id === params.item.id)
      assert.deepEqual(
        completed.map((done) => done.item),
        [{ type: 'reasoning', id: params.item.id, summary: [], content: [] }],
      )
    }
    assert.deepEqual(compactionEvents(app, 'item/completed'), [])
    assert.deepEqual(app.notified('thread/compacted'), [])

    // The refusal shows once, as a row under the turn that goes on.
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
    assert.deepEqual(storedTypes(app, turnId), ['userMessage', 'agentMessage', 'agentMessage'])
  })
})

test('a compaction that never reports its end is closed without a marker when the turn ends', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'auto compaction check, never ends')
    await app.turnCompleted(turnId)
    const [started] = compactionEvents(app, 'item/started')
    assert.ok(started)
    const closed = app.notified('item/completed').find((done) => done.item.id === started.item.id)
    assert.equal(closed?.item.type, 'reasoning')
    // Before the turn's end, so no open item is left behind.
    const index = (predicate: (message: any) => boolean) => app.messages.findIndex(predicate)
    assert.ok(
      index(
        (message) =>
          message.method === 'item/completed' && message.params.item.id === started.item.id,
      ) < index((message) => message.method === 'turn/completed'),
    )
    assert.deepEqual(app.notified('warning'), [])
    assert.ok(!storedTypes(app, turnId).includes('contextCompaction'))
  })
})

test('a compaction is stored only once it completes, in the place it started', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'auto compaction check, then hold')
    const [started] = await app.waitFor(() => {
      const events = compactionEvents(app, 'item/completed')
      return events.length > 0 ? events : undefined
    })
    assert.ok(started)
    assert.deepEqual(storedTypes(app, turnId), ['userMessage', 'agentMessage', 'contextCompaction'])
    await app.request('turn/interrupt', { threadId, turnId })
    await app.turnCompleted(turnId)
    // A completed compaction stays compacted.
    assert.ok(storedTypes(app, turnId).includes('contextCompaction'))
  })
})

test('a compaction an interrupt cuts short is not stored, so it never reads as compacted', async () => {
  await withInProcessApp(new MockRuntime(), async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'auto compaction check, stalls')
    await app.waitFor(() => compactionEvents(app, 'item/started')[0])
    // Open while it runs: the App shows it compacting; nothing stored yet.
    assert.ok(!storedTypes(app, turnId).includes('contextCompaction'))
    await app.request('turn/interrupt', { threadId, turnId })
    assert.equal((await app.turnCompleted(turnId)).status, 'interrupted')
    assert.deepEqual(compactionEvents(app, 'item/completed'), [])
    assert.ok(!storedTypes(app, turnId).includes('contextCompaction'))

    // The same for a compaction the user started.
    const holdTurn = await app.startTurn(threadId, 'next compaction holds')
    await app.turnCompleted(holdTurn)
    await app.request('thread/compact/start', { threadId })
    const compactTurn = await app.waitFor(
      () =>
        app
          .notified('turn/started')
          .find((params) => params.turn.id !== turnId && params.turn.id !== holdTurn)?.turn.id,
    )
    await app.waitFor(() =>
      compactionEvents(app, 'item/started').find((params) => params.turnId === compactTurn),
    )
    assert.deepEqual(storedTypes(app, compactTurn), [])
    await app.request('turn/interrupt', { threadId, turnId: compactTurn })
    assert.equal((await app.turnCompleted(compactTurn)).status, 'interrupted')
    assert.deepEqual(storedTypes(app, compactTurn), [])
  })
})

test('a /compact Claude refuses shows the refusal as a row and the summary, not a compaction', async () => {
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
    // The item that showed it compacting closes as an empty reasoning item,
    // which the App does not draw, before the summary written instead.
    const [started] = compactionEvents(app, 'item/started').filter(
      (params) => params.turnId === compactTurn,
    )
    assert.ok(started)
    const closedAt = app.messages.findIndex(
      (message) =>
        message.method === 'item/completed' && message.params.item.id === started.item.id,
    )
    assert.deepEqual(app.messages[closedAt]?.params.item, {
      type: 'reasoning',
      id: started.item.id,
      summary: [],
      content: [],
    })
    const summaryAt = app.messages.findIndex(
      (message) =>
        message.method === 'item/started' &&
        message.params.turnId === compactTurn &&
        message.params.item.type === 'agentMessage',
    )
    assert.ok(closedAt < summaryAt)
    assert.deepEqual(compactionEvents(app, 'item/completed'), [])
    assert.deepEqual(app.notified('thread/compacted'), [])
    // The turn keeps the summary alone, so nothing reads as compacted.
    assert.deepEqual(storedTypes(app, compactTurn), ['agentMessage'])
    const [summary] = app.store.getTurn(compactTurn)?.items ?? []
    assert.ok(summary?.type === 'agentMessage' && summary.text.length > 0)

    // A /compact Claude does compacts the thread, and says so.
    await app.request('thread/compact/start', { threadId })
    const nextTurn = await app.waitFor(
      () =>
        app
          .notified('turn/started')
          .find((params) => params.turn.id !== first && params.turn.id !== compactTurn)?.turn.id,
    )
    await app.turnCompleted(nextTurn)
    assert.deepEqual(storedTypes(app, nextTurn), ['contextCompaction'])
    assert.deepEqual(app.notified('thread/compacted'), [{ threadId, turnId: nextTurn }])
  })
})

test('a /compact that compacted the session stands when its run goes wrong afterwards', async () => {
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      if (context.prompt === '/compact') {
        await handlers.onEvent({
          type: 'compaction_completed',
          trigger: 'manual',
          preTokens: 90_000,
          postTokens: 9_000,
        })
        throw new Error('the stream broke after the compaction')
      }
      await handlers.onEvent({ type: 'session', claudeSessionId: 'claude-session' })
      await handlers.onEvent({ type: 'text_delta', delta: 'done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    { compactsSessions: () => true },
  )
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const first = await app.startTurn(threadId, 'hello')
    await app.turnCompleted(first)
    await app.request('thread/compact/start', { threadId })
    const compactTurn = await app.waitFor(
      () => app.notified('turn/started').find((params) => params.turn.id !== first)?.turn.id,
    )
    assert.equal((await app.turnCompleted(compactTurn)).status, 'completed')
    // Compacted, and said so: no summary written in its place.
    assert.deepEqual(storedTypes(app, compactTurn), ['contextCompaction'])
    assert.deepEqual(app.notified('thread/compacted'), [{ threadId, turnId: compactTurn }])
    assert.deepEqual(app.notified('error'), [])
  })
})
