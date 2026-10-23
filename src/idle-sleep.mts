// Keeping the Mac awake while Claude works. A computer that idle-sleeps
// during a turn drops Claude's connection to the model and the turn fails
// (see sleep-notice.mts). With CLAUDE_CODEX_PREVENT_IDLE_SLEEP=1 on macOS,
// the adapter holds `caffeinate -i -w <adapter pid>` while a turn, a
// background agent or other background work runs, and lets it go once
// nothing does. `-i` only prevents idle sleep: closing the lid still sleeps.
// `-w` ties the assertion to the adapter's process, so it ends with the
// adapter even if the adapter never gets to release it. Off by default, and
// a no-op on other platforms.

import { spawn } from 'node:child_process'
import { debugLog } from './util.mjs'

export const CAFFEINATE = '/usr/bin/caffeinate'

// A keep-awake process that runs until stop(). onExit reports its end:
// null when stop() ended it, an error when it failed to start or ended on
// its own.
export interface KeepAwakeHandle {
  stop(): void
}

export type KeepAwakeSpawner = (
  command: string,
  args: string[],
  onExit: (error: Error | null) => void,
) => KeepAwakeHandle

export function idleSleepPreventionEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && env.CLAUDE_CODEX_PREVENT_IDLE_SLEEP === '1'
}

export const spawnKeepAwake: KeepAwakeSpawner = (command, args, onExit) => {
  let stopping = false
  let ended = false
  const end = (error: Error | null): void => {
    if (ended) return
    ended = true
    onExit(error)
  }
  const child = spawn(command, args, { stdio: 'ignore' })
  child.once('error', (error) => end(error))
  child.once('exit', (code, signal) =>
    end(
      stopping || code === 0
        ? null
        : new Error(`${command} exited with ${code === null ? signal : `code ${code}`}`),
    ),
  )
  // The adapter's exit does not wait on it; -w ends it then.
  child.unref()
  return {
    stop: () => {
      if (ended || stopping) return
      stopping = true
      child.kill('SIGTERM')
    },
  }
}

export interface IdleSleepGuardOptions {
  // Whether anything still runs that sleep would cut short.
  busy: () => boolean
  enabled?: boolean
  pid?: number
  spawn?: KeepAwakeSpawner
  // While held, how often to look again: background work can end without
  // the server hearing of it.
  pollMs?: number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  log?: (event: string, data: Record<string, unknown>) => void
}

// After this many keep-awake processes failed or ended on their own, the
// guard stops trying until the adapter restarts.
export const MAX_KEEP_AWAKE_FAILURES = 3

interface Hold {
  handle: KeepAwakeHandle | null
  live: boolean
}

export class IdleSleepGuard {
  private readonly busy: () => boolean
  private readonly enabled: boolean
  private readonly pid: number
  private readonly spawn: KeepAwakeSpawner
  private readonly pollMs: number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (event: string, data: Record<string, unknown>) => void
  private hold: Hold | null = null
  private poll: unknown = null
  private failures = 0
  private stopped = false

  constructor(options: IdleSleepGuardOptions) {
    this.busy = options.busy
    this.enabled = options.enabled ?? idleSleepPreventionEnabled()
    this.pid = options.pid ?? process.pid
    this.spawn = options.spawn ?? spawnKeepAwake
    this.pollMs = options.pollMs ?? 30_000
    this.setTimer =
      options.setInterval ??
      ((callback, ms) => {
        const timer = setInterval(callback, ms)
        timer.unref()
        return timer
      })
    this.clearTimer =
      options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    this.log = options.log ?? debugLog
  }

  get holding(): boolean {
    return this.hold !== null
  }

  // Holds the keep-awake process while anything runs, and lets it go when
  // nothing does.
  check(): void {
    if (!this.enabled || this.stopped) return
    if (this.busy()) this.acquire()
    else this.release()
  }

  stop(): void {
    this.stopped = true
    this.release()
  }

  private acquire(): void {
    if (this.hold || this.failures >= MAX_KEEP_AWAKE_FAILURES) return
    const hold: Hold = { handle: null, live: true }
    this.hold = hold
    try {
      hold.handle = this.spawn(CAFFEINATE, ['-i', '-w', String(this.pid)], (error) =>
        this.ended(hold, error),
      )
    } catch (error) {
      this.ended(hold, error instanceof Error ? error : new Error(String(error)))
      return
    }
    // It may have failed before spawn returned.
    if (!hold.live) return
    this.log('idleSleep.hold', { pid: this.pid })
    if (this.poll === null) this.poll = this.setTimer(() => this.check(), this.pollMs)
  }

  private ended(hold: Hold, error: Error | null): void {
    // Let go of on purpose.
    if (!hold.live) return
    hold.live = false
    if (this.hold === hold) this.hold = null
    this.failures += 1
    const gaveUp = this.failures >= MAX_KEEP_AWAKE_FAILURES
    this.log('idleSleep.lost', {
      error: error?.message ?? 'ended on its own',
      failures: this.failures,
      gaveUp,
    })
    // The poll takes it up again while anything runs, unless it gave up.
    if (gaveUp) this.stopPoll()
  }

  private release(): void {
    this.stopPoll()
    const hold = this.hold
    if (!hold) return
    this.hold = null
    hold.live = false
    hold.handle?.stop()
    this.log('idleSleep.release', {})
  }

  private stopPoll(): void {
    if (this.poll === null) return
    this.clearTimer(this.poll)
    this.poll = null
  }
}
