// Codex's paged views of a thread's history: thread/turns/list,
// thread/items/list, thread/timeline/list and the two searches. A thread's
// turns come from the store whole, so cursors are positions in them.

import type { ThreadItem, TurnRecord } from './types.mjs'
import { toolOutputInput } from './util.mjs'

export type SortDirection = 'asc' | 'desc'

export function sortDirectionOr(value: unknown, fallback: SortDirection): SortDirection {
  return value === 'asc' || value === 'desc' ? value : fallback
}

// The page size the client asked for, from 1 to max; null when it sent none.
export function pageLimit(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(1, Math.min(Math.floor(value), max))
}

// An offset cursor this module handed out; null starts from the beginning.
export function offsetCursor(value: unknown, what: string): number {
  if (value == null) return 0
  const offset = typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid ${what} cursor`)
  return offset
}

// thread/turns/list, newest first by default. A cursor is the id of the turn
// a page starts at, included in either direction: search occurrences hand
// out the same cursors, and the App reads both ways from one to load a
// match's turn. Without a limit the page runs to the end.
export function pageTurns(
  turns: TurnRecord[],
  params: { cursor: unknown; limit: number | null; sortDirection: SortDirection },
): { data: TurnRecord[]; nextCursor: string | null; backwardsCursor: string | null } {
  const ordered = params.sortDirection === 'asc' ? turns : turns.toReversed()
  let start = 0
  if (params.cursor != null) {
    start = ordered.findIndex((turn) => turn.id === params.cursor)
    if (start < 0) throw new Error(`invalid turn cursor: ${String(params.cursor)}`)
  }
  const end = params.limit == null ? ordered.length : start + params.limit
  const data = ordered.slice(start, end)
  return {
    data,
    nextCursor: ordered[end]?.id ?? null,
    backwardsCursor: data[0]?.id ?? null,
  }
}

export interface ThreadItemEntry {
  turnId: string
  item: ThreadItem
  // The store keeps no per-item times.
  startedAtMs: null
  completedAtMs: null
}

// thread/items/list over one turn or the whole thread, oldest first by
// default. A string cursor is the index of the first entry of the page,
// included either way; an item anchor names an item of the turn and is
// excluded.
export function pageItems(
  turns: TurnRecord[],
  params: {
    turnId: string | null
    cursor: unknown
    limit: number | null
    sortDirection: SortDirection
  },
): { data: ThreadItemEntry[]; nextCursor: string | null; backwardsCursor: string | null } {
  const scope = params.turnId == null ? turns : turns.filter((turn) => turn.id === params.turnId)
  if (params.turnId != null && scope.length === 0)
    throw new Error(`turn not found: ${params.turnId}`)
  const entries = scope.flatMap((turn) =>
    turn.items.map(
      (item): ThreadItemEntry => ({
        turnId: turn.id,
        item,
        startedAtMs: null,
        completedAtMs: null,
      }),
    ),
  )
  const step = params.sortDirection === 'asc' ? 1 : -1
  let start = step === 1 ? 0 : entries.length - 1
  const cursor = params.cursor
  if (cursor != null && typeof cursor === 'object') {
    const itemId = (cursor as { itemId?: unknown }).itemId
    if (params.turnId == null) throw new Error('an item cursor needs a turnId')
    const anchor = entries.findIndex((entry) => entry.item.id === itemId)
    if (anchor < 0) throw new Error(`item not found in turn ${params.turnId}: ${String(itemId)}`)
    start = anchor + step
  } else if (cursor != null) {
    start = offsetCursor(cursor, 'item')
  }
  const limit = params.limit ?? entries.length
  const data: ThreadItemEntry[] = []
  let index = start
  for (; index >= 0 && index < entries.length && data.length < limit; index += step) {
    const entry = entries[index]
    if (entry) data.push(entry)
  }
  return {
    data,
    nextCursor: index >= 0 && index < entries.length ? String(index) : null,
    backwardsCursor: data.length > 0 ? String(start) : null,
  }
}

export type TimelineEntry =
  | { type: 'turnStarted'; position: number; turnId: string; startedAt: number | null }
  | { type: 'item'; position: number; turnId: string; item: ThreadItem }
  | {
      type: 'turnCompleted'
      position: number
      turnId: string
      status: TurnRecord['status']
      error: unknown
      startedAt: number | null
      completedAt: number | null
      durationMs: number | null
    }

// thread/timeline/list: each turn as its start, its items and, once it ended,
// its completion, numbered in order. Like Codex, the first page is the newest
// stretch and nextCursor leads to older entries; a cursor is the position a
// page ends before.
export function pageTimeline(
  turns: TurnRecord[],
  params: { cursor: unknown; limit: number | null },
): { data: TimelineEntry[]; nextCursor: string | null; activeRealtimeSessionAtPageStart: null } {
  const entries: TimelineEntry[] = []
  for (const turn of turns) {
    entries.push({
      type: 'turnStarted',
      position: entries.length,
      turnId: turn.id,
      startedAt: turn.startedAt,
    })
    for (const item of turn.items)
      entries.push({ type: 'item', position: entries.length, turnId: turn.id, item })
    if (turn.status !== 'inProgress')
      entries.push({
        type: 'turnCompleted',
        position: entries.length,
        turnId: turn.id,
        status: turn.status,
        error: turn.error,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
      })
  }
  const end =
    params.cursor == null
      ? entries.length
      : Math.min(offsetCursor(params.cursor, 'timeline'), entries.length)
  const start = params.limit == null ? 0 : Math.max(0, end - params.limit)
  return {
    data: entries.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
    // Realtime voice never runs here.
    activeRealtimeSessionAtPageStart: null,
  }
}

// The text of a message as the App shows it: what the user wrote, or one of
// Claude's answers. Commentary between tool calls, tool output and reasoning
// are not searched.
export function visibleMessageText(item: ThreadItem): string | null {
  const input =
    item.type === 'userMessage'
      ? item.content
      : item.type === 'functionCallOutput'
        ? toolOutputInput(item.output)
        : null
  if (input)
    return input.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n') || null
  if (item.type === 'agentMessage' && item.phase !== 'commentary') return item.text || null
  return null
}

// Case-insensitive literal search; null for a blank term.
export function searchPattern(term: string): RegExp | null {
  if (!term.trim()) return null
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'), 'giu')
}

const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 80

// Up to SNIPPET_BEFORE code units before the match and SNIPPET_AFTER after it,
// on one line, with the match's range in the snippet.
export function snippetAt(
  text: string,
  start: number,
  end: number,
): { snippet: string; snippetMatchRange: { start: number; end: number } } {
  let from = Math.max(0, start - SNIPPET_BEFORE)
  let to = Math.min(text.length, end + SNIPPET_AFTER)
  // Never split a surrogate pair.
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to += 1
  const prefix = from > 0 ? '…' : ''
  const body = text.slice(from, to).replace(/\s/g, ' ')
  return {
    snippet: `${prefix}${body}${to < text.length ? '…' : ''}`,
    snippetMatchRange: { start: prefix.length + start - from, end: prefix.length + end - from },
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export interface SearchOccurrence {
  turnId: string
  itemId: string
  snippet: string
  snippetMatchRange: { start: number; end: number }
  turnCursor: string
}

// thread/searchOccurrences: every match in the thread's messages, oldest
// first, with the thread/turns/list cursor of its turn.
export function findOccurrences(turns: TurnRecord[], term: string): SearchOccurrence[] {
  const pattern = searchPattern(term)
  if (!pattern) return []
  return turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      const text = visibleMessageText(item)
      if (!text) return []
      return [...text.matchAll(pattern)].map((match) => ({
        turnId: turn.id,
        itemId: item.id,
        ...snippetAt(text, match.index, match.index + match[0].length),
        turnCursor: turn.id,
      }))
    }),
  )
}

// thread/search's snippet: the first match in the thread's name, its
// preview, then its messages; null when the thread does not match.
export function threadSnippet(
  texts: Array<string | null>,
  turns: () => TurnRecord[],
  term: string,
): string | null {
  const pattern = searchPattern(term)
  if (!pattern) return null
  const firstMatch = (text: string | null): string | null => {
    if (!text) return null
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    return match ? snippetAt(text, match.index, match.index + match[0].length).snippet : null
  }
  for (const text of texts) {
    const snippet = firstMatch(text)
    if (snippet) return snippet
  }
  for (const turn of turns())
    for (const item of turn.items) {
      const snippet = firstMatch(visibleMessageText(item))
      if (snippet) return snippet
    }
  return null
}
