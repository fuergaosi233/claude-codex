// Sleep and failed turns. A computer that sleeps during a turn drops
// Claude's connection to the model, and the turn then fails with a network
// or timeout error that says nothing about sleep. The tracker below notices
// that the computer slept, so the turn watchdog does not count the sleep as
// time without progress and a failed turn can say what happened and how to
// pick up again.
//
// Neither of Node's clocks tells sleep apart on its own. libuv's uv_hrtime,
// behind performance.now(), process.hrtime() and every timer deadline, reads
// mach_continuous_time() on macOS, which keeps counting while the computer
// sleeps (so an overdue timer fires right on wake), and CLOCK_MONOTONIC on
// Linux, which stops during suspend. A timer that ticks every few seconds
// does tell: after a sleep its next tick is late by about as long as the
// computer slept. The tracker takes the larger of the wall clock and the
// monotonic clock gaps between ticks, so the late tick shows on both: on
// macOS both clocks moved on, on Linux only the wall clock did. A wall clock
// set forward, or an event loop blocked for a long time, reads as sleep too;
// that only gives the watchdog more time or adds a sentence to an error.

import type { CodexTurnError } from './server-helpers.mjs'

export interface SleepClock {
  wall(): number
  monotonic(): number
}

export const systemClock: SleepClock = {
  wall: () => Date.now(),
  monotonic: () => performance.now(),
}

// What the server needs from a tracker; tests pass a fake.
export interface SleepMonitor {
  // Total time asleep since the tracker started. It never goes down, so a
  // reader can compare two readings.
  suspendedMs(): number
  // Time asleep between wallMs and now.
  sleptSince(wallMs: number): number
  start?(): void
  stop?(): void
}

export interface SleepTrackerOptions {
  clock?: SleepClock
  intervalMs?: number
  // A tick at least this late counts as sleep.
  minGapMs?: number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

interface SleepGap {
  startWall: number
  endWall: number
  ms: number
}

const DEFAULT_INTERVAL_MS = 10_000
const DEFAULT_MIN_GAP_MS = 20_000
// Enough for a day of naps; older ones no longer touch a running turn.
const MAX_GAPS = 64

export class SleepTracker implements SleepMonitor {
  private readonly clock: SleepClock
  private readonly intervalMs: number
  private readonly minGapMs: number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private timer: unknown = null
  private lastWall: number
  private lastMonotonic: number
  private committedMs = 0
  private readonly gaps: SleepGap[] = []

  constructor(options: SleepTrackerOptions = {}) {
    this.clock = options.clock ?? systemClock
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS
    this.setTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms))
    this.clearTimer =
      options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    this.lastWall = this.clock.wall()
    this.lastMonotonic = this.clock.monotonic()
  }

  get running(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer !== null) return
    this.mark()
    const handle = this.setTimer(() => this.beat(), this.intervalMs)
    ;(handle as { unref?: () => void } | null)?.unref?.()
    this.timer = handle ?? true
  }

  stop(): void {
    if (this.timer === null) return
    if (this.timer !== true) this.clearTimer(this.timer)
    this.timer = null
  }

  // One tick: records the gap since the last one when it was late.
  beat(): void {
    const gap = this.pendingGap()
    if (gap) {
      this.committedMs += gap.ms
      this.gaps.push(gap)
      if (this.gaps.length > MAX_GAPS) this.gaps.shift()
    }
    this.mark()
  }

  suspendedMs(): number {
    return this.committedMs + (this.pendingGap()?.ms ?? 0)
  }

  sleptSince(wallMs: number): number {
    const now = this.clock.wall()
    let total = 0
    const pending = this.pendingGap()
    for (const gap of pending ? [...this.gaps, pending] : this.gaps) {
      const start = Math.max(gap.startWall, wallMs)
      const end = Math.min(gap.endWall, now)
      if (end > start) total += end - start
    }
    return total
  }

  private mark(): void {
    this.lastWall = this.clock.wall()
    this.lastMonotonic = this.clock.monotonic()
  }

  // The gap the next tick would record, when the tracker is running and that
  // tick is already late enough to count: a turn can fail on wake before the
  // tracker's own tick has run.
  private pendingGap(): SleepGap | null {
    if (this.timer === null) return null
    const wall = this.clock.wall()
    const elapsed = Math.max(wall - this.lastWall, this.clock.monotonic() - this.lastMonotonic)
    const ms = elapsed - this.intervalMs
    if (!(ms >= this.minGapMs)) return null
    return { startWall: wall - ms, endWall: wall, ms }
  }
}

// Shorter sleeps rarely break the connection; Claude retries through them.
export const SLEEP_NOTICE_MIN_MS = 60_000

export function sleepDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes <= 1) return 'about a minute'
  if (minutes < 60) return `about ${minutes} minutes`
  const hours = Math.round(ms / 3_600_000)
  if (hours <= 1) return 'about an hour'
  return `about ${hours} hours`
}

// The sentence a failed turn gets when the computer slept during it, or null
// for a sleep too short to matter. The Codex App's "Prevent sleep while
// running" setting (Settings > General, desktop App on macOS and Windows)
// keeps the computer awake while a turn runs, but not with the lid closed.
export function sleepNotice(
  sleptMs: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!(sleptMs >= SLEEP_NOTICE_MIN_MS)) return null
  const lead =
    `The computer running Claude slept for ${sleepDuration(sleptMs)} during this turn, ` +
    "which interrupted Claude's connection to the model; send a message (or Continue) to " +
    'pick up where it left off'
  if (platform !== 'darwin' && platform !== 'win32') return `${lead}.`
  return (
    `${lead}, and turn on Settings > General > Prevent sleep while running to keep the ` +
    'computer awake during tasks (it does not stop sleep when the lid is closed).'
  )
}

// Codex error codes sleep does not explain: the request was refused for what
// it said or who sent it, not cut off.
const NOT_FROM_SLEEP = new Set([
  'contextWindowExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'badRequest',
  'unauthorized',
  'cyberPolicy',
])

// The failed turn's error with the sleep sentence appended to its message.
// The error code stays as it was, so the App offers the same actions.
export function withSleepNotice(
  error: CodexTurnError,
  sleptMs: number,
  platform: NodeJS.Platform = process.platform,
): CodexTurnError {
  const notice = sleepNotice(sleptMs, platform)
  if (!notice) return error
  const info = error.codexErrorInfo
  if (typeof info === 'string' && NOT_FROM_SLEEP.has(info)) return error
  // A Claude Code that refused to start for a reason a retry cannot fix.
  if (info === 'other' && error.additionalDetails?.startsWith('Claude Code startup failure')) {
    return error
  }
  const message = error.message.trimEnd()
  const joined =
    message === '' ? notice : `${message}${/[.!?]$/.test(message) ? '' : '.'} ${notice}`
  return { ...error, message: joined }
}
