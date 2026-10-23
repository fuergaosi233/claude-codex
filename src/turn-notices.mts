// Notices: what Claude Code reports beside a turn rather than in it (a
// compaction it could not do, a model it switched to, an urgent status line,
// a tool call it denied while no turn was running). Codex sends such things
// as `warning` notifications, and the adapter still does, but the Codex App
// opts out of `warning`, so a warning alone is never seen.
//
// The adapter also sends each notice as an `error` notification with
// willRetry: true and no error code. Both App versions render that inline
// under the turn it names, as a dim row with the message as written, without
// failing the turn, ending it or marking the thread; a turn that has already
// ended takes the row too. Only a message of the exact form "Reconnecting...
// n/m" merges with others, which a notice never has. The App does not keep
// these rows, so when the turn then fails its error's details repeat the
// turn's notices, and a failed turn is persisted.
// App rule: turn-notices

import type { CodexTurnError } from './server-helpers.mjs'

// Rows a single turn shows; later notices still go out as warnings and into
// a failed turn's details.
export const MAX_VISIBLE_NOTICES_PER_TURN = 5
// Turns whose notices are remembered, oldest forgotten first.
const MAX_TRACKED_TURNS = 64
// Notices a failed turn's details repeat, and how long that part may grow.
const MAX_DETAIL_NOTICES = 10
const MAX_DETAIL_CHARS = 2_000

export interface NoticeDecision {
  // Send the `warning`: the turn has not had this notice yet.
  warn: boolean
  // Also show it as a row.
  show: boolean
}

interface TurnNotices {
  seen: Set<string>
  shown: number
}

export class TurnNoticeLog {
  private readonly turns = new Map<string, TurnNotices>()

  // Records a notice for the turn (or the thread, between turns) and says
  // how to send it: each message once per key, and only the first few as
  // rows.
  record(key: string, message: string): NoticeDecision {
    let entry = this.turns.get(key)
    if (!entry) {
      entry = { seen: new Set(), shown: 0 }
      this.turns.set(key, entry)
      if (this.turns.size > MAX_TRACKED_TURNS) {
        const oldest = this.turns.keys().next().value
        if (oldest !== undefined) this.turns.delete(oldest)
      }
    }
    if (entry.seen.has(message)) return { warn: false, show: false }
    entry.seen.add(message)
    if (entry.shown >= MAX_VISIBLE_NOTICES_PER_TURN) return { warn: true, show: false }
    entry.shown += 1
    return { warn: true, show: true }
  }

  // The turn's notices, in the order they came.
  messages(key: string): string[] {
    return [...(this.turns.get(key)?.seen ?? [])]
  }

  forget(key: string): void {
    this.turns.delete(key)
  }
}

// CLAUDE_CODEX_NOTICE_ROWS=0 keeps notices to the `warning` alone, as
// before the rows.
export function noticeRowsEnabled(): boolean {
  return process.env.CLAUDE_CODEX_NOTICE_ROWS !== '0'
}

// The `error` notification that shows a notice under a turn.
export function noticeTurnError(message: string): CodexTurnError {
  return { message, codexErrorInfo: null, additionalDetails: null }
}

// A failed turn's error with the turn's notices added to its details, so the
// persisted turn still says what Claude reported along the way. The message
// and code stay as they were.
export function withTurnNotices(error: CodexTurnError, notices: readonly string[]): CodexTurnError {
  const extra = notices.filter((notice) => notice !== error.message)
  if (extra.length === 0) return error
  const lines = extra.slice(0, MAX_DETAIL_NOTICES).map((notice) => `- ${notice}`)
  if (extra.length > MAX_DETAIL_NOTICES) {
    lines.push(`- and ${extra.length - MAX_DETAIL_NOTICES} more`)
  }
  let block = `Claude reported during this turn:\n${lines.join('\n')}`
  if (block.length > MAX_DETAIL_CHARS) block = `${block.slice(0, MAX_DETAIL_CHARS - 1)}…`
  const additionalDetails = error.additionalDetails
    ? `${error.additionalDetails}\n\n${block}`
    : block
  return { ...error, additionalDetails }
}
