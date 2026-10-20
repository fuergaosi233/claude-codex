import { execFileSync } from 'node:child_process'
import { parseProcessRows } from './cli-orphans.mjs'

// Several servers can share one state dir: the App's own, a second window, a
// one-shot `codex app-server` probe. Each turn records the server that wrote
// it, so a server that starts later fails only the turns of servers that are
// gone. A server is named by its pid and its start time, as in cli-orphans,
// so a pid the system has since handed to another process does not count as
// the server still running.

export interface ProcessOwner {
  pid: number
  started: string
}

let self: ProcessOwner | null | undefined

// This process, or null where ps cannot tell its start time (Windows).
export function currentProcessOwner(): ProcessOwner | null {
  if (self === undefined) {
    const started = startTimes([process.pid])?.get(process.pid)
    self = started ? { pid: process.pid, started } : null
  }
  return self
}

// Whether `owner` is another process that is still running. A process whose
// start time cannot be read counts as gone, which is how every turn was
// treated before turns recorded their server.
export function otherProcessRunning(owner: ProcessOwner): boolean {
  if (owner.pid === process.pid || !signalable(owner.pid)) return false
  return startTimes([owner.pid])?.get(owner.pid) === owner.started
}

function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Start times by pid, or null when ps could not run. The C locale and UTC
// make every server print the same start time for a process, whatever
// locale or time zone it was started with.
function startTimes(pids: number[]): Map<number, string> | null {
  if (process.platform === 'win32') return null
  let output: string
  try {
    output = execFileSync(
      'ps',
      ['-ww', '-o', 'pid=,ppid=,lstart=,command=', '-p', pids.join(',')],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      },
    )
  } catch (error) {
    // ps exits 1 when none of the pids is running.
    const failed = error as { status?: number | null; stdout?: unknown }
    if (failed.status !== 1) return null
    output = typeof failed.stdout === 'string' ? failed.stdout : ''
  }
  return new Map(parseProcessRows(output).map((row) => [row.pid, row.started]))
}
