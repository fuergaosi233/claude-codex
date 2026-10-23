import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAFFEINATE,
  IdleSleepGuard,
  type IdleSleepGuardOptions,
  idleSleepPreventionEnabled,
  type KeepAwakeSpawner,
  MAX_KEEP_AWAKE_FAILURES,
  spawnKeepAwake,
} from '../src/idle-sleep.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

// A spawner that records each keep-awake process, and a poll the test runs.
function fakeKeepAwake() {
  const spawned: Array<{
    command: string
    args: string[]
    stopped: boolean
    exit: (error: Error | null) => void
  }> = []
  let poll: (() => void) | null = null
  const spawn: KeepAwakeSpawner = (command, args, onExit) => {
    const entry = { command, args, stopped: false, exit: onExit }
    spawned.push(entry)
    return {
      stop: () => {
        entry.stopped = true
      },
    }
  }
  const options: Omit<IdleSleepGuardOptions, 'busy'> = {
    enabled: true,
    pid: 4242,
    spawn,
    setInterval: (callback) => {
      poll = callback
      return 'poll'
    },
    clearInterval: () => {
      poll = null
    },
    log: () => {},
  }
  return {
    spawned,
    options,
    running: () => spawned.filter((entry) => !entry.stopped),
    poll: () => poll?.(),
    get polling() {
      return poll !== null
    },
  }
}

test('the switch is macOS only and off unless set to 1', () => {
  assert.equal(idleSleepPreventionEnabled({ CLAUDE_CODEX_PREVENT_IDLE_SLEEP: '1' }, 'darwin'), true)
  assert.equal(idleSleepPreventionEnabled({}, 'darwin'), false)
  assert.equal(
    idleSleepPreventionEnabled({ CLAUDE_CODEX_PREVENT_IDLE_SLEEP: '0' }, 'darwin'),
    false,
  )
  assert.equal(idleSleepPreventionEnabled({ CLAUDE_CODEX_PREVENT_IDLE_SLEEP: '1' }, 'linux'), false)
  assert.equal(idleSleepPreventionEnabled({ CLAUDE_CODEX_PREVENT_IDLE_SLEEP: '1' }, 'win32'), false)
})

test('the guard holds caffeinate on the adapter while busy, and lets go when idle', () => {
  const fake = fakeKeepAwake()
  let busy = false
  const guard = new IdleSleepGuard({ ...fake.options, busy: () => busy })
  guard.check()
  assert.equal(fake.spawned.length, 0)

  busy = true
  guard.check()
  guard.check()
  assert.deepEqual(
    fake.spawned.map((entry) => [entry.command, entry.args]),
    [[CAFFEINATE, ['-i', '-w', '4242']]],
  )
  assert.ok(guard.holding)
  assert.ok(fake.polling)

  busy = false
  guard.check()
  assert.equal(guard.holding, false)
  assert.deepEqual(fake.running(), [])
  assert.equal(fake.polling, false)
  // Its end, reported after the release, is not a failure.
  fake.spawned[0]?.exit(null)

  // Work that ends without the server hearing of it: the poll lets go.
  busy = true
  guard.check()
  assert.equal(fake.running().length, 1)
  busy = false
  fake.poll()
  assert.deepEqual(fake.running(), [])

  // Stopping lets go, and nothing takes hold after.
  busy = true
  guard.check()
  guard.stop()
  assert.deepEqual(fake.running(), [])
  guard.check()
  assert.equal(fake.spawned.length, 3)
})

test('the guard is a no-op when off', () => {
  const fake = fakeKeepAwake()
  const guard = new IdleSleepGuard({ ...fake.options, enabled: false, busy: () => true })
  guard.check()
  assert.equal(fake.spawned.length, 0)
  assert.equal(guard.holding, false)
})

test('a keep-awake process that fails is taken up again, up to a limit', () => {
  const fake = fakeKeepAwake()
  const guard = new IdleSleepGuard({ ...fake.options, busy: () => true })
  guard.check()
  // It ended on its own while busy: the next poll takes hold again.
  fake.spawned[0]?.exit(new Error('caffeinate exited with code 1'))
  assert.equal(guard.holding, false)
  fake.poll()
  assert.equal(fake.spawned.length, 2)
  for (let i = 1; i < MAX_KEEP_AWAKE_FAILURES; i += 1) {
    fake.spawned.at(-1)?.exit(new Error('spawn ENOENT'))
    guard.check()
  }
  // Given up: no more tries, and no poll left running.
  assert.equal(fake.spawned.length, MAX_KEEP_AWAKE_FAILURES)
  assert.equal(guard.holding, false)
  assert.equal(fake.polling, false)
})

test('a spawn that throws, or fails before it returns, does not hold or throw', () => {
  const logged: string[] = []
  let throws = true
  const guard = new IdleSleepGuard({
    enabled: true,
    busy: () => true,
    spawn: (_command, _args, onExit) => {
      if (throws) throw new Error('EPERM')
      onExit(new Error('spawn ENOENT'))
      return { stop: () => assert.fail('stopped a process that never ran') }
    },
    setInterval: () => assert.fail('polled without a hold'),
    log: (event) => logged.push(event),
  })
  guard.check()
  assert.equal(guard.holding, false)
  throws = false
  guard.check()
  assert.equal(guard.holding, false)
  guard.stop()
  assert.deepEqual(logged, ['idleSleep.lost', 'idleSleep.lost'])
})

test('the real spawner reports a stop as a clean end, and a missing command as an error', async () => {
  const stopped = await new Promise<Error | null>((resolve) => {
    const handle = spawnKeepAwake('/bin/sleep', ['30'], resolve)
    setTimeout(() => handle.stop(), 50)
  })
  assert.equal(stopped, null)
  const missing = await new Promise<Error | null>((resolve) => {
    spawnKeepAwake('/nonexistent/caffeinate', ['-i'], resolve)
  })
  assert.match(missing?.message ?? '', /ENOENT/)
  const failed = await new Promise<Error | null>((resolve) => {
    spawnKeepAwake('/bin/sh', ['-c', 'exit 3'], resolve)
  })
  assert.match(failed?.message ?? '', /exited with code 3/)
})

test('the server holds it while a turn or background work runs, and lets go after', async () => {
  const fake = fakeKeepAwake()
  let release: (() => void) | null = null
  let backgroundWork = false
  const runtime = scriptedRuntime(
    async (context, handlers) => {
      if (context.prompt.includes('hold')) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      if (context.prompt.includes('background')) backgroundWork = true
      await handlers.onEvent({ type: 'text_delta', delta: 'done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    { hasBackgroundWork: () => backgroundWork },
  )
  await withInProcessApp(
    runtime,
    async (app) => {
      const threadId = await app.startThread()
      assert.equal(fake.spawned.length, 0)

      const held = await app.startTurn(threadId, 'hold')
      const releaseTurn = await app.waitFor(() => release ?? undefined)
      assert.equal(fake.running().length, 1)
      releaseTurn()
      await app.turnCompleted(held)
      await app.waitFor(() => (fake.running().length === 0 ? true : undefined))

      // A background task outlives the turn: held until it ends.
      await app.turnCompleted(await app.startTurn(threadId, 'start background work'))
      await app.waitFor(() => (fake.spawned.length === 2 ? true : undefined))
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(fake.running().length, 1)
      backgroundWork = false
      fake.poll()
      assert.deepEqual(fake.running(), [])

      // Stopping the server lets go of a hold it has.
      backgroundWork = true
      await app.turnCompleted(await app.startTurn(threadId, 'more background work'))
      assert.equal(fake.running().length, 1)
      await app.server.stop()
      assert.deepEqual(fake.running(), [])
    },
    { server: { idleSleep: fake.options } },
  )
})
