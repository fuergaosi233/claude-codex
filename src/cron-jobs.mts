// Session-only scheduled jobs (Claude's CronCreate tool) live inside the
// Claude Code process that created them: they fire only while that process
// runs and die with it. A resumed session gets them back, because the CLI
// re-creates every job its transcript still holds (CronCreate results,
// minus CronDelete calls, minus recurring jobs past their age limit and
// one-shot jobs already due), and a recurring job it re-creates that way
// fires straight away to catch up.
//
// CronJobs follows the same record, from the live stream and from the
// transcript a session resumes, so the runtime knows how long a process has
// scheduled work and keeps it open until then. Durable jobs are written to
// disk and are not the session's to keep.

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
// The CLI retires a recurring session job after seven days.
export const RECURRING_MAX_AGE_MS = 7 * DAY_MS
// Fires are jittered, and a retiring recurring job fires one final time.
const FIRE_GRACE_MS = 60 * MINUTE_MS
// A day-of-month like the 29th of February can be years away.
const SEARCH_LIMIT_MS = 5 * 366 * DAY_MS

interface CronCall {
  cron: string
  recurring: boolean
  createdAt: number
}

export class CronJobs {
  // The Claude session these jobs were scheduled in.
  sessionId: string | null = null
  private calls = new Map<string, CronCall>()
  // Job id → when the CLI drops it.
  private jobs = new Map<string, number>()

  // Takes a stream message or a transcript line.
  observe(message: Record<string, unknown>, now = Date.now()): void {
    const type = message.type
    if (type !== 'assistant' && type !== 'user') return
    const content = (message.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return
    const createdAt = Date.parse(String(message.timestamp ?? '')) || now
    for (const block of content as Record<string, unknown>[]) {
      if (type === 'assistant' && block?.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>
        if (block.name === 'CronCreate' && typeof block.id === 'string') {
          this.calls.set(block.id, {
            cron: String(input.cron ?? ''),
            recurring: input.recurring !== false,
            createdAt,
          })
        } else if (block.name === 'CronDelete' && input.id != null) {
          this.jobs.delete(String(input.id))
        }
      } else if (type === 'user' && block?.type === 'tool_result') {
        const call = this.calls.get(String(block.tool_use_id))
        if (!call) continue
        this.calls.delete(String(block.tool_use_id))
        const created = (message.tool_use_result ?? message.toolUseResult) as
          | Record<string, unknown>
          | undefined
        if (block.is_error === true || !created || created.id == null) continue
        if (created.durable === true) continue
        const recurring =
          typeof created.recurring === 'boolean' ? created.recurring : call.recurring
        const lastFire = recurring
          ? call.createdAt + RECURRING_MAX_AGE_MS
          : (nextCronFire(call.cron, call.createdAt) ?? call.createdAt + RECURRING_MAX_AGE_MS)
        this.jobs.set(String(created.id), lastFire + FIRE_GRACE_MS)
      }
    }
  }

  // Replays a session transcript up to (and including) the message a resume
  // stops at.
  scanTranscript(text: string, stopAt: string | null = null): void {
    if (!text.includes('CronCreate')) return
    for (const line of text.split('\n')) {
      const stop = stopAt != null && line.includes(stopAt)
      if (
        line.includes('CronCreate') ||
        line.includes('CronDelete') ||
        line.includes('humanSchedule')
      ) {
        try {
          this.observe(JSON.parse(line) as Record<string, unknown>)
        } catch {}
      }
      if (stop && lineUuid(line) === stopAt) return
    }
  }

  // When the last scheduled job is dropped, or null when none is left.
  until(now = Date.now()): number | null {
    let latest: number | null = null
    for (const [id, endsAt] of this.jobs) {
      if (endsAt <= now) this.jobs.delete(id)
      else if (latest == null || endsAt > latest) latest = endsAt
    }
    return latest
  }
}

function lineUuid(line: string): string | null {
  try {
    const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid
    return typeof uuid === 'string' ? uuid : null
  } catch {
    return null
  }
}

interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

// The first time after `after` a standard 5-field cron expression matches,
// in local time; null when the expression is not one this understands.
export function nextCronFire(expr: string, after: number): number | null {
  const fields = parseCron(expr)
  if (!fields) return null
  const date = new Date(after)
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)
  const limit = after + SEARCH_LIMIT_MS
  while (date.getTime() <= limit) {
    if (!fields.month.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1)
      date.setHours(0, 0, 0, 0)
    } else if (!dayMatches(fields, date)) {
      date.setDate(date.getDate() + 1)
      date.setHours(0, 0, 0, 0)
    } else if (!fields.hour.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0)
    } else if (!fields.minute.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0)
    } else {
      return date.getTime()
    }
  }
  return null
}

// With both day fields restricted, either may match (as in cron).
function dayMatches(fields: CronFields, date: Date): boolean {
  const dom = fields.dayOfMonth.has(date.getDate())
  const dow = fields.dayOfWeek.has(date.getDay())
  if (fields.anyDayOfMonth) return dow
  if (fields.anyDayOfWeek) return dom
  return dom || dow
}

function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = [
    parseField(parts[0] as string, 0, 59),
    parseField(parts[1] as string, 0, 23),
    parseField(parts[2] as string, 1, 31),
    parseField(parts[3] as string, 1, 12),
    parseField(parts[4] as string, 0, 7),
  ]
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  if (dayOfWeek.delete(7)) dayOfWeek.add(0)
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    anyDayOfMonth: parts[2] === '*',
    anyDayOfWeek: parts[4] === '*',
  }
}

// `*`, `n`, `a-b`, with an optional `/step`, comma-separated.
function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!match) return null
    const step = match[3] != null ? Number(match[3]) : 1
    let low = min
    let high = max
    if (match[1] != null) {
      low = Number(match[1])
      high = match[2] != null ? Number(match[2]) : match[3] != null ? max : low
    }
    if (step < 1 || low < min || high > max || low > high) return null
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}
