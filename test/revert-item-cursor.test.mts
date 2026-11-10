import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItemEntry } from '../src/thread-history.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

test('revert item cursors resume inclusive descending pages of retained history', async () => {
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await handlers.onEvent({ type: 'text_delta', delta: 'Reply.' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'Reply.' })
  })
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turns: string[] = []
    for (const text of ['one', 'two', 'three']) {
      const turnId = await app.startTurn(threadId, text)
      turns.push(turnId)
      await app.turnCompleted(turnId)
    }
    const before = await app.request('thread/items/list', { threadId })
    const kept = (before.data as ThreadItemEntry[]).filter((entry) => entry.turnId !== turns[2])
    assert.ok(kept.length > 2)
    assert.ok(kept.some((entry) => entry.turnId === turns[0]))
    assert.ok(kept.some((entry) => entry.turnId === turns[1]))

    const reverted = await app.request('thread/revert', { threadId, beforeTurnId: turns[2] })
    assert.equal(reverted.turnsBackwardsCursor, turns[1])
    const first = await app.request('thread/items/list', {
      threadId,
      cursor: reverted.itemsBackwardsCursor,
      sortDirection: 'desc',
      limit: 1,
    })
    assert.deepEqual(first.data, [kept.at(-1)])
    assert.notEqual(first.nextCursor, null)
    const rest = await app.request('thread/items/list', {
      threadId,
      cursor: first.nextCursor,
      sortDirection: 'desc',
    })
    assert.deepEqual([...first.data, ...rest.data], kept.toReversed())
    assert.equal(rest.nextCursor, null)

    const empty = await app.request('thread/revert', { threadId, beforeTurnId: turns[0] })
    assert.equal(empty.turnsBackwardsCursor, null)
    assert.equal(empty.itemsBackwardsCursor, null)
    const page = await app.request('thread/items/list', {
      threadId,
      cursor: empty.itemsBackwardsCursor,
      sortDirection: 'desc',
    })
    assert.deepEqual(page.data, [])
    assert.equal(page.nextCursor, null)
  })
})
