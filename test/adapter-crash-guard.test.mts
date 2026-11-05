import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const adapter = resolve('dist/src/adapter.mjs')

type Exit = { code: number | null; signal: NodeJS.Signals | null }

// A stdio adapter with a preload that throws `error` once the adapter's
// crash guard is installed.
async function adapterWithInjectedThrow(error: string) {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-crash-'))
  const debugLog = join(home, 'debug.jsonl')
  const preload = join(home, 'throw.mjs')
  await writeFile(
    preload,
    `const timer = setInterval(() => {
  if (process.listenerCount('uncaughtException') === 0) return
  clearInterval(timer)
  setImmediate(() => { throw ${error} })
}, 10)
`,
  )
  const proc: ChildProcess = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload).href, adapter, 'app-server', '--listen', 'stdio://'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_DEBUG_LOG: debugLog,
        NODE_NO_WARNINGS: '1',
      },
    },
  )
  let stderr = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  let exit: Exit | null = null
  const exited = once(proc, 'exit').then(([code, signal]) => {
    exit = { code, signal }
    return exit
  })
  const crashEvents = async (): Promise<number> => {
    try {
      return (await readFile(debugLog, 'utf8'))
        .split('\n')
        .filter((line) => line.includes('"adapter.uncaughtException"')).length
    } catch {
      return 0
    }
  }
  return {
    exited,
    exit: () => exit,
    stderr: () => stderr,
    crashEvents,
    async close() {
      if (exit === null) {
        proc.kill('SIGKILL')
        await exited
      }
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    },
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

test('an unexpected uncaught exception is logged once and ends the process', async () => {
  const run = await adapterWithInjectedThrow("new Error('injected crash')")
  try {
    const exit = await within(run.exited, 20_000)
    assert.notEqual(exit, null, 'the adapter kept running after an unexpected exception')
    assert.equal(exit?.code, 1)
    assert.match(run.stderr(), /injected crash/)
    assert.equal(await run.crashEvents(), 1)
  } finally {
    await run.close()
  }
})

test('an EPIPE uncaught exception is swallowed and the process keeps running', async () => {
  const run = await adapterWithInjectedThrow(
    "Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })",
  )
  try {
    const deadline = Date.now() + 20_000
    while ((await run.crashEvents()) === 0 && run.exit() === null && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await run.crashEvents(), 1)
    assert.equal(await within(run.exited, 500), null, 'the adapter exited on a routine EPIPE')
  } finally {
    await run.close()
  }
})
