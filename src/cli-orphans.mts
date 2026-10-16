import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterHome, debugLog } from './util.mjs'

// The SDK spawns the Claude CLI as a plain child of the adapter. When the
// adapter is SIGKILLed (App force-quit, crash) nothing tells the CLI: it keeps
// running its in-flight tool and model turn until they end, still writing the
// session transcript that the replacement adapter is about to resume. Each
// adapter records its CLI children under <adapterHome>/cli-children/<pid>.json;
// the next adapter on the same state dir reaps the children of owners that are
// gone. A child is only touched when its pid, start time and command line all
// match the record, so a recycled pid or a sibling adapter's CLI is never hit.

interface ProcessRow {
  pid: number
  ppid: number
  started: string
  command: string
}

interface ChildRecord {
  pid: number
  started: string
  command: string
}

interface OwnerRecord {
  pid: number
  started: string
  children: ChildRecord[]
}

// The SDK always launches the CLI in stream-json input mode; nothing else the
// adapter spawns (git, claude -p, shells) carries this flag pair.
const CLI_MARKER = '--input-format stream-json'

function enabled(): boolean {
  const flag = process.env.CLAUDE_CODEX_REAP_ORPHANED_CLI
  return process.platform !== 'win32' && flag !== '0' && flag !== 'false'
}

export function registryDir(): string {
  return join(adapterHome(), 'cli-children')
}

function listProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    // POSIX -A (every process) reads the same in BSD ps and Linux procps.
    execFile(
      'ps',
      ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,command='],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseProcessRows(stdout)),
    )
  })
}

// lstart is a fixed five-token date ("Mon Oct 12 02:52:58 2026").
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid = '', ppid = '', started = '', command = ''] = match
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      started: started.replace(/\s+/g, ' '),
      command,
    })
  }
  return rows
}

function sameProcess(row: ProcessRow | undefined, record: ChildRecord): row is ProcessRow {
  return row !== undefined && row.started === record.started && row.command === record.command
}

function descendantsOf(rootPid: number, rows: ProcessRow[]): number[] {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? []
    siblings.push(row.pid)
    children.set(row.ppid, siblings)
  }
  const result: number[] = []
  const stack = [...(children.get(rootPid) ?? [])]
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    result.push(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  return result
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {}
}

let recording: Promise<void> = Promise.resolve()

// Rewrites this adapter's record from a fresh process listing. Called when a
// CLI session reports init, i.e. once the child is up.
export function recordCliChildren(dir = registryDir()): Promise<void> {
  if (!enabled()) return Promise.resolve()
  recording = recording.then(async () => {
    const rows = await listProcesses()
    const self = rows.find((row) => row.pid === process.pid)
    if (!self) return
    const children = rows
      .filter((row) => row.ppid === process.pid && row.command.includes(CLI_MARKER))
      .map(({ pid, started, command }) => ({ pid, started, command }))
    const record: OwnerRecord = { pid: process.pid, started: self.started, children }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, `${process.pid}.json`), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      })
    } catch (error) {
      debugLog('cliOrphans.recordFailed', { message: (error as Error).message })
    }
  })
  return recording
}

// SIGTERMs the process tree of every recorded CLI whose owning adapter is
// gone, then SIGKILLs whatever is still there after `graceMs`. Resolves with
// the reaped CLI pids once the SIGTERM pass is done; the SIGKILL pass runs in
// the background.
export async function reapOrphanedCliChildren(
  dir = registryDir(),
  graceMs = 3000,
): Promise<number[]> {
  if (!enabled()) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name))
  } catch {
    return []
  }
  if (files.length === 0) return []
  const rows = await listProcesses()
  if (rows.length === 0) return []
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const reaped: number[] = []
  const targets: ChildRecord[] = []
  for (const name of files) {
    const path = join(dir, name)
    let owner: OwnerRecord
    try {
      owner = JSON.parse(readFileSync(path, 'utf8')) as OwnerRecord
    } catch {
      continue
    }
    if (owner.pid === process.pid) continue
    const ownerRow = byPid.get(owner.pid)
    if (ownerRow && ownerRow.started === owner.started) continue
    for (const child of owner.children ?? []) {
      const row = byPid.get(child.pid)
      if (!sameProcess(row, child)) continue
      const tree = descendantsOf(child.pid, rows)
      for (const pid of tree.reverse()) {
        const descendant = byPid.get(pid)
        if (descendant) targets.push(descendant)
        signal(pid, 'SIGTERM')
      }
      signal(child.pid, 'SIGTERM')
      targets.push(child)
      reaped.push(child.pid)
    }
    try {
      unlinkSync(path)
    } catch {}
  }
  if (reaped.length > 0) {
    debugLog('cliOrphans.reaped', { pids: reaped, processes: targets.length })
    const timer = setTimeout(() => {
      void listProcesses().then((now) => {
        const alive = new Map(now.map((row) => [row.pid, row]))
        for (const target of targets)
          if (sameProcess(alive.get(target.pid), target)) signal(target.pid, 'SIGKILL')
      })
    }, graceMs)
    timer.unref()
  }
  return reaped
}
