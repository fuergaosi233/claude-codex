// The subagent watchdog of a turn: a turn that waits on subagents or a
// workflow fails once a whole window passes without any sign of life from
// them, so a missing Task result cannot leave the Codex App working forever.
//
// Two kinds of quiet are not a stall. While the turn waits on the user (an
// approval, a question, an MCP elicitation, a client tool call) the children
// may well be idle, so the window is paused. And time the computer spent
// asleep is not time without progress: on macOS the timer runs on a clock
// that counts sleep (see sleep-notice.mts), so without a check it would fire
// right on wake. After either, the window starts over.

export interface TurnWatchdogOptions {
  timeoutMs: number
  onExpire: () => void
  // The clock the timers run on.
  now?: () => number
  // Total time the computer has slept; only its growth is read.
  suspendedMs?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class TurnWatchdog {
  private readonly timeoutMs: number
  private readonly onExpire: () => void
  private readonly now: () => number
  private readonly suspendedMs: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private timer: unknown = null
  private lastProgressAt = 0
  private suspendedAtProgress = 0
  private pauses = 0
  private expired = false

  constructor(options: TurnWatchdogOptions) {
    this.timeoutMs = options.timeoutMs
    this.onExpire = options.onExpire
    this.now = options.now ?? (() => performance.now())
    this.suspendedMs = options.suspendedMs ?? (() => 0)
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms)
        timer.unref()
        return timer
      })
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.lastProgressAt = this.now()
    this.suspendedAtProgress = this.suspendedMs()
  }

  // False when the window is zero, the documented opt-out.
  get enabled(): boolean {
    return this.timeoutMs > 0
  }

  get armed(): boolean {
    return this.timer !== null
  }

  get paused(): boolean {
    return this.pauses > 0
  }

  // Starts the window, unless it already runs or has run out.
  arm(): void {
    if (!this.enabled || this.timer !== null || this.expired) return
    this.noteProgress()
    this.schedule(this.timeoutMs)
  }

  disarm(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  // A busy child reports many times a second, so progress only moves this
  // mark; a timer that comes due early waits out the rest of the window.
  noteProgress(): void {
    this.lastProgressAt = this.now()
    this.suspendedAtProgress = this.suspendedMs()
  }

  // Pauses nest: each pause() needs its resume().
  pause(): void {
    this.pauses += 1
  }

  resume(): void {
    if (this.pauses > 0) this.pauses -= 1
    this.noteProgress()
  }

  // Runs pending while the window is paused.
  async whilePaused<T>(pending: Promise<T>): Promise<T> {
    this.pause()
    try {
      return await pending
    } finally {
      this.resume()
    }
  }

  private schedule(delayMs: number): void {
    this.timer = this.setTimer(() => this.check(), Math.max(1, delayMs))
  }

  private check(): void {
    this.timer = null
    if (this.pauses > 0 || this.suspendedMs() > this.suspendedAtProgress) {
      this.noteProgress()
      this.schedule(this.timeoutMs)
      return
    }
    const idleMs = this.now() - this.lastProgressAt
    if (idleMs < this.timeoutMs) {
      this.schedule(this.timeoutMs - idleMs)
      return
    }
    this.expired = true
    this.onExpire()
  }
}
