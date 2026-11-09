import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ClaudePTranscriptRuntime } from '../src/claude-p-runtime.mjs'
import type { RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

// Regression tests for nwverse/claude-codex#263: when a claude-p turn times
// out, the SIGKILL escalation must still reach descendants that ignore
// SIGTERM, even after claude-p itself has exited. The stubs below model a
// claude-p leader that exits at once on SIGTERM/SIGINT and a detached
// grandchild that traps both signals and keeps running.
//
// Note: a node process takes ~1 s to boot in this sandbox, so the tests
// wait for the descendant's ready file (written after its signal handlers
// are installed) before triggering a timeout or interrupt; otherwise the
// signals land before the handlers exist and the descendant dies for the
// wrong reason.

const LEADER_STUB = `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [pidFile, holdStdio, descendantPath, markerFile, readyFile] = process.argv.slice(2)
const grandchild = spawn(process.execPath, [descendantPath, markerFile ?? '', readyFile ?? ''], {
  stdio: holdStdio === '1' ? 'inherit' : 'ignore',
  detached: true,
})
writeFileSync(pidFile, String(grandchild.pid), 'utf8')
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1000)
`

const DESCENDANT_STUB = `import { appendFileSync, writeFileSync } from 'node:fs'
const [markerFile, readyFile] = process.argv.slice(2)
const mark = (signal) => {
  if (markerFile) appendFileSync(markerFile, signal + String.fromCharCode(10))
}
process.on('SIGTERM', () => mark('SIGTERM'))
process.on('SIGINT', () => mark('SIGINT'))
if (readyFile) writeFileSync(readyFile, 'ready', 'utf8')
setInterval(() => {}, 1000)
`

const ECHO_STUB = `console.log(JSON.stringify({ result: 'hello', session_id: 's1', is_error: false }))
`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killLeftover(pid: number | null): void {
  if (pid === null) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

async function waitForFile(path: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await sleep(25)
  }
  throw new Error(`file never appeared: ${path}`)
}

async function waitForPidFile(pidFile: string, timeoutMs = 10000): Promise<number> {
  await waitForFile(pidFile, timeoutMs)
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`bad pid in ${pidFile}`)
  return pid
}

function turnContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread-263',
    turnId: 'turn-1',
    prompt: 'hello',
    cwd: process.cwd(),
    runtimeType: null,
    model: null,
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    approvalPolicy: null,
    sandboxMode: null,
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

const handlers: RuntimeHandlers = {
  onEvent: () => {},
  onPermissionRequest: async () => ({ decision: 'decline' }),
}

async function writeStubs(dir: string): Promise<{ leader: string; descendant: string }> {
  const leader = join(dir, 'leader.mjs')
  const descendant = join(dir, 'descendant.mjs')
  await writeFile(leader, LEADER_STUB, 'utf8')
  await writeFile(descendant, DESCENDANT_STUB, 'utf8')
  return { leader, descendant }
}

interface StubPaths {
  pidFile: string
  markerFile: string
  readyFile: string
}

async function startStubTurn(
  dir: string,
  holdStdio: '0' | '1',
  timeoutMs: number,
): Promise<{ runtime: ClaudePTranscriptRuntime; turn: Promise<void>; paths: StubPaths }> {
  const { leader, descendant } = await writeStubs(dir)
  const paths: StubPaths = {
    pidFile: join(dir, 'grandchild.pid'),
    markerFile: join(dir, 'signals.txt'),
    readyFile: join(dir, 'ready.txt'),
  }
  const runtime = new ClaudePTranscriptRuntime({
    command: process.execPath,
    extraArgs: [leader, paths.pidFile, holdStdio, descendant, paths.markerFile, paths.readyFile],
    timeoutMs,
    skipPermissions: true,
    resume: false,
    stopTimeoutRetries: 0,
  })
  const turn = runtime.runTurn(turnContext(), handlers)
  return { runtime, turn, paths }
}

test('claude-p timeout SIGKILLs a detached descendant after the leader exits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-p-runtime-263-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { turn, paths } = await startStubTurn(dir, '0', 3000)
  const observed = turn.then(
    () => 'resolved',
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  )
  const grandchildPid = await waitForPidFile(paths.pidFile)
  t.after(() => killLeftover(grandchildPid))
  await waitForFile(paths.readyFile)
  assert.equal(
    await Promise.race([observed, sleep(8000).then(() => 'unsettled')]),
    'rejected: claude-p timed out after 3000ms',
  )
  // The turn rejects when SIGTERM fires; the SIGKILL follows 1500 ms
  // later. Poll until the descendant is gone (deadline: grace + margin)
  // instead of sleeping a fixed offset from an unrelated timestamp: on a
  // fast machine the ready file appears long before the timeout, so a
  // fixed wait from there can check before the SIGKILL has fired.
  const deadline = Date.now() + 4000
  while (isAlive(grandchildPid) && Date.now() < deadline) {
    await sleep(100)
  }
  assert.equal(
    isAlive(grandchildPid),
    false,
    'detached descendant must be SIGKILLed after the grace period even though claude-p exited',
  )
})

test('claude-p timeout settles when a descendant holds stdio open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-p-runtime-263-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { turn, paths } = await startStubTurn(dir, '1', 3000)
  const observed = turn.then(
    () => 'resolved',
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  )
  const grandchildPid = await waitForPidFile(paths.pidFile)
  t.after(() => killLeftover(grandchildPid))
  await waitForFile(paths.readyFile)
  try {
    const outcome = await Promise.race([observed, sleep(8000).then(() => 'unsettled')])
    assert.equal(
      outcome,
      'rejected: claude-p timed out after 3000ms',
      'turn promise must settle once the escalation SIGKILLs the stdio-holding descendant',
    )
  } finally {
    killLeftover(grandchildPid)
    await Promise.race([observed, sleep(3000)])
  }
})

test('interrupt follow-up SIGTERM reaches descendants after the leader exits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-p-runtime-263-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { runtime, turn, paths } = await startStubTurn(dir, '0', 30000)
  const settled = turn.then(
    () => 'resolved',
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  )
  const grandchildPid = await waitForPidFile(paths.pidFile)
  t.after(() => killLeftover(grandchildPid))
  await waitForFile(paths.readyFile)
  const interruptedAt = Date.now()
  await runtime.interrupt('thread-263')
  assert.equal(await Promise.race([settled, sleep(5000).then(() => 'unsettled')]), 'resolved')
  // The SIGTERM follow-up is scheduled 1500 ms after SIGINT; check past it.
  await sleep(Math.max(0, interruptedAt + 2200 - Date.now()))
  const signals = existsSync(paths.markerFile) ? await readFile(paths.markerFile, 'utf8') : ''
  assert.match(
    signals,
    /SIGTERM/,
    'interrupt follow-up SIGTERM must reach the descendant even though claude-p exited on SIGINT',
  )
})

test('claude-p turn still completes normally without a timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-p-runtime-263-'))
  const echo = join(dir, 'echo.mjs')
  await writeFile(echo, ECHO_STUB, 'utf8')
  const seen: string[] = []
  const runtime = new ClaudePTranscriptRuntime({
    command: process.execPath,
    extraArgs: [echo],
    timeoutMs: 10000,
    skipPermissions: true,
    resume: false,
    stopTimeoutRetries: 0,
  })
  await runtime.runTurn(turnContext(), {
    onEvent: (event) => {
      if (event.type === 'completed' && event.result) seen.push(event.result)
    },
    onPermissionRequest: async () => ({ decision: 'decline' }),
  })
  assert.deepEqual(seen, ['hello'])
  await rm(dir, { recursive: true, force: true })
})
