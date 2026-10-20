import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findOccurrences,
  forkTurns,
  offsetCursor,
  pageItems,
  pageLimit,
  pageTimeline,
  pageTurns,
  snippetAt,
  threadSnippet,
} from '../src/thread-history.mjs'
import type { ThreadItem, TurnRecord } from '../src/types.mjs'

function user(id: string, text: string): ThreadItem {
  return { type: 'userMessage', id, content: [{ type: 'text', text }] }
}

function agent(id: string, text: string, phase: string | null = null): ThreadItem {
  return { type: 'agentMessage', id, text, phase, memoryCitation: null }
}

function turn(id: string, items: ThreadItem[], status: TurnRecord['status'] = 'completed') {
  return {
    id,
    threadId: 'thread',
    status,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1000,
    items,
    diff: '',
    error: null,
  } satisfies TurnRecord
}

const ids = (page: { data: Array<{ id: string }> }): string[] => page.data.map((entry) => entry.id)
const itemIds = (page: { data: Array<{ item: ThreadItem }> }): string[] =>
  page.data.map((entry) => entry.item.id)

test('pageTurns pages either way from an inclusive turn cursor', () => {
  const turns = [turn('t1', []), turn('t2', []), turn('t3', [])]
  const newest = pageTurns(turns, { cursor: null, limit: null, sortDirection: 'desc' })
  assert.deepEqual(ids(newest), ['t3', 't2', 't1'])
  assert.equal(newest.nextCursor, null)
  assert.equal(newest.backwardsCursor, 't3')

  const first = pageTurns(turns, { cursor: null, limit: 2, sortDirection: 'desc' })
  assert.deepEqual(ids(first), ['t3', 't2'])
  assert.equal(first.nextCursor, 't1')
  const second = pageTurns(turns, { cursor: first.nextCursor, limit: 2, sortDirection: 'desc' })
  assert.deepEqual(ids(second), ['t1'])
  assert.equal(second.nextCursor, null)

  // A search match's turn, read both ways: the anchor is in both pages.
  assert.deepEqual(ids(pageTurns(turns, { cursor: 't2', limit: 5, sortDirection: 'desc' })), [
    't2',
    't1',
  ])
  assert.deepEqual(ids(pageTurns(turns, { cursor: 't2', limit: 5, sortDirection: 'asc' })), [
    't2',
    't3',
  ])
  assert.throws(
    () => pageTurns(turns, { cursor: 'gone', limit: 1, sortDirection: 'asc' }),
    /invalid turn cursor: gone/,
  )
})

test('forkTurns keeps the turns through lastTurnId or before beforeTurnId', () => {
  const turns = [turn('t1', []), turn('t2', []), turn('t3', [], 'inProgress')]
  const kept = (params: { lastTurnId?: unknown; beforeTurnId?: unknown }) =>
    forkTurns(turns, params)?.map((entry) => entry.id) ?? null
  assert.equal(kept({}), null)
  assert.equal(kept({ lastTurnId: null, beforeTurnId: 7 }), null)
  assert.deepEqual(kept({ lastTurnId: 't1' }), ['t1'])
  assert.deepEqual(kept({ lastTurnId: 't2' }), ['t1', 't2'])
  assert.deepEqual(kept({ beforeTurnId: 't1' }), [])
  // A fork may stop short of a running turn, but not keep it.
  assert.deepEqual(kept({ beforeTurnId: 't3' }), ['t1', 't2'])
  assert.throws(() => kept({ lastTurnId: 't3' }), /lastTurnId 't3' identifies an in-progress turn/)
  assert.throws(
    () => kept({ lastTurnId: 't1', beforeTurnId: 't2' }),
    /`beforeTurnId` cannot be combined with `lastTurnId`/,
  )
  assert.throws(() => kept({ lastTurnId: 'gone' }), /lastTurnId 'gone' was not found/)
  assert.throws(() => kept({ beforeTurnId: 'gone' }), /beforeTurnId 'gone' was not found/)
})

test('pageItems pages a thread or one turn, with offset and item anchors', () => {
  const turns = [
    turn('t1', [user('u1', 'one'), agent('a1', 'one back')]),
    turn('t2', [user('u2', 'two'), agent('a2', 'two back'), agent('c2', 'aside', 'commentary')]),
  ]
  const all = pageItems(turns, { turnId: null, cursor: null, limit: null, sortDirection: 'asc' })
  assert.deepEqual(itemIds(all), ['u1', 'a1', 'u2', 'a2', 'c2'])
  assert.deepEqual(
    all.data.map((entry) => entry.turnId),
    ['t1', 't1', 't2', 't2', 't2'],
  )
  assert.equal(all.data[0]?.startedAtMs, null)
  assert.equal(all.nextCursor, null)

  const first = pageItems(turns, { turnId: null, cursor: null, limit: 2, sortDirection: 'asc' })
  assert.deepEqual(itemIds(first), ['u1', 'a1'])
  assert.equal(first.nextCursor, '2')
  assert.equal(first.backwardsCursor, '0')
  const next = pageItems(turns, { turnId: null, cursor: '2', limit: 2, sortDirection: 'asc' })
  assert.deepEqual(itemIds(next), ['u2', 'a2'])
  assert.equal(next.nextCursor, '4')

  const newest = pageItems(turns, { turnId: null, cursor: null, limit: 2, sortDirection: 'desc' })
  assert.deepEqual(itemIds(newest), ['c2', 'a2'])
  assert.equal(newest.nextCursor, '2')

  // An item anchor is excluded, in either direction.
  const after = pageItems(turns, {
    turnId: 't2',
    cursor: { type: 'item', itemId: 'u2' },
    limit: null,
    sortDirection: 'asc',
  })
  assert.deepEqual(itemIds(after), ['a2', 'c2'])
  const before = pageItems(turns, {
    turnId: 't2',
    cursor: { type: 'item', itemId: 'c2' },
    limit: null,
    sortDirection: 'desc',
  })
  assert.deepEqual(itemIds(before), ['a2', 'u2'])

  assert.throws(
    () => pageItems(turns, { turnId: 'nope', cursor: null, limit: null, sortDirection: 'asc' }),
    /turn not found: nope/,
  )
  assert.throws(
    () =>
      pageItems(turns, {
        turnId: null,
        cursor: { type: 'item', itemId: 'u2' },
        limit: null,
        sortDirection: 'asc',
      }),
    /an item cursor needs a turnId/,
  )
  assert.throws(
    () =>
      pageItems(turns, {
        turnId: 't1',
        cursor: { type: 'item', itemId: 'u2' },
        limit: null,
        sortDirection: 'asc',
      }),
    /item not found in turn t1: u2/,
  )
  assert.throws(
    () => pageItems(turns, { turnId: null, cursor: 'x', limit: 1, sortDirection: 'asc' }),
    /invalid item cursor/,
  )
})

test('pageTimeline numbers turn starts, items and completions in order', () => {
  const turns = [turn('t1', [user('u1', 'one')]), turn('t2', [user('u2', 'two')], 'inProgress')]
  const all = pageTimeline(turns, { cursor: null, limit: null })
  assert.deepEqual(
    all.data.map((entry) => [entry.position, entry.type, entry.turnId]),
    [
      [0, 'turnStarted', 't1'],
      [1, 'item', 't1'],
      [2, 'turnCompleted', 't1'],
      [3, 'turnStarted', 't2'],
      [4, 'item', 't2'],
    ],
  )
  assert.equal(all.activeRealtimeSessionAtPageStart, null)
  assert.equal(all.nextCursor, null)

  // The first page is the newest stretch, in order; each cursor leads to
  // older entries until the oldest page.
  const positions = (page: { data: Array<{ position: number }> }) =>
    page.data.map((entry) => entry.position)
  const newest = pageTimeline(turns, { cursor: null, limit: 2 })
  assert.deepEqual(positions(newest), [3, 4])
  assert.equal(newest.nextCursor, '3')
  const older = pageTimeline(turns, { cursor: newest.nextCursor, limit: 2 })
  assert.deepEqual(positions(older), [1, 2])
  assert.equal(older.nextCursor, '1')
  const oldest = pageTimeline(turns, { cursor: older.nextCursor, limit: 2 })
  assert.deepEqual(positions(oldest), [0])
  assert.equal(oldest.nextCursor, null)
  assert.throws(() => pageTimeline(turns, { cursor: 'x', limit: 2 }), /invalid timeline cursor/)
})

test('pageLimit and offsetCursor accept only what the server hands out', () => {
  assert.equal(pageLimit(undefined), null)
  assert.equal(pageLimit(0), 1)
  assert.equal(pageLimit(2.7), 2)
  assert.equal(pageLimit(500, 200), 200)
  assert.equal(offsetCursor(null, 'x'), 0)
  assert.equal(offsetCursor('3', 'x'), 3)
  assert.throws(() => offsetCursor('-1', 'item'), /invalid item cursor/)
  assert.throws(() => offsetCursor('1.5', 'item'), /invalid item cursor/)
})

test('snippetAt keeps the match on one line and its range exact', () => {
  const text = `${'a'.repeat(50)}needle\n${'b'.repeat(100)}`
  const { snippet, snippetMatchRange } = snippetAt(text, 50, 56)
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'))
  assert.ok(!snippet.includes('\n'))
  assert.equal(snippet.slice(snippetMatchRange.start, snippetMatchRange.end), 'needle')

  const short = snippetAt('find the needle', 9, 15)
  assert.equal(short.snippet, 'find the needle')
  assert.deepEqual(short.snippetMatchRange, { start: 9, end: 15 })
})

test('snippetAt never splits a surrogate pair', () => {
  // The 40-unit window would start on the low half of an emoji.
  const text = `${'😀'.repeat(30)}xneedle${'😀'.repeat(60)}`
  const start = text.indexOf('needle')
  const { snippet, snippetMatchRange } = snippetAt(text, start, start + 6)
  assert.doesNotMatch(
    snippet,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
  )
  assert.equal(snippet.slice(snippetMatchRange.start, snippetMatchRange.end), 'needle')
})

test('findOccurrences searches visible messages literally, ignoring case', () => {
  const turns = [
    turn('t1', [user('u1', 'what is (A+B)?'), agent('c1', '(a+b) aside', 'commentary')]),
    turn('t2', [agent('a2', 'It is (a+b), twice: (A+B).')]),
  ]
  const found = findOccurrences(turns, '(a+b)')
  assert.deepEqual(
    found.map((entry) => [entry.turnId, entry.itemId, entry.turnCursor]),
    [
      ['t1', 'u1', 't1'],
      ['t2', 'a2', 't2'],
      ['t2', 'a2', 't2'],
    ],
  )
  for (const entry of found)
    assert.equal(
      entry.snippet.slice(entry.snippetMatchRange.start, entry.snippetMatchRange.end).toLowerCase(),
      '(a+b)',
    )
  assert.deepEqual(findOccurrences(turns, '   '), [])
})

test('threadSnippet tries the name and preview before reading messages', () => {
  let read = 0
  const turns = (): TurnRecord[] => {
    read += 1
    return [turn('t1', [user('u1', 'the needle is in the message')])]
  }
  assert.equal(threadSnippet(['Needle hunt', null], turns, 'needle'), 'Needle hunt')
  assert.equal(read, 0)
  assert.equal(threadSnippet([null, 'preview'], turns, 'NEEDLE'), 'the needle is in the message')
  assert.equal(threadSnippet(['name', 'preview'], turns, 'missing'), null)
  assert.equal(threadSnippet(['name'], turns, ''), null)
})
