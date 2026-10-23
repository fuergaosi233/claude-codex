import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SLEEP_NOTICE_MIN_MS,
  type SleepClock,
  SleepTracker,
  sleepDuration,
  sleepNotice,
  withSleepNotice,
} from '../src/sleep-notice.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

const MINUTE = 60_000
const INTERVAL = 10_000

// A clock the test moves, and a tracker whose tick the test runs.
function fakeTracker() {
  const clock = { wallMs: 1_000_000, monotonicMs: 5_000 }
  const fake: SleepClock = { wall: () => clock.wallMs, monotonic: () => clock.monotonicMs }
  let tick: (() => void) | null = null
  const tracker = new SleepTracker({
    clock: fake,
    intervalMs: INTERVAL,
    minGapMs: 20_000,
    setInterval: (callback) => {
      tick = callback
      return { id: 'timer' }
    },
    clearInterval: () => {
      tick = null
    },
  })
  return {
    clock,
    tracker,
    // Time passes awake: both clocks move and the tick runs on time.
    awake(ms: number) {
      for (let left = ms; left > 0; left -= INTERVAL) {
        clock.wallMs += Math.min(INTERVAL, left)
        clock.monotonicMs += Math.min(INTERVAL, left)
        tick?.()
      }
    },
    // The computer sleeps. On macOS the monotonic clock counts the sleep, on
    // Linux it stops; the wall clock moves on either way.
    sleep(ms: number, monotonicCounts: boolean) {
      clock.wallMs += ms
      if (monotonicCounts) clock.monotonicMs += ms
    },
    tick: () => tick?.(),
    get ticking() {
      return tick !== null
    },
  }
}

for (const monotonicCounts of [true, false]) {
  const platform = monotonicCounts ? 'a clock that counts sleep' : 'a clock that stops'
  test(`the tracker notices a sleep by its late tick, on ${platform}`, () => {
    const fake = fakeTracker()
    fake.tracker.start()
    assert.ok(fake.ticking)
    fake.awake(60_000)
    assert.equal(fake.tracker.suspendedMs(), 0)
    const turnStart = fake.clock.wallMs
    fake.awake(5_000)
    fake.sleep(10 * MINUTE, monotonicCounts)
    // Woken, before the tick runs: the gap already counts.
    const pending = fake.tracker.suspendedMs()
    assert.ok(pending >= 10 * MINUTE - INTERVAL && pending <= 10 * MINUTE, `${pending}`)
    assert.equal(fake.tracker.sleptSince(turnStart), pending)
    fake.tick()
    assert.equal(fake.tracker.suspendedMs(), pending)
    fake.awake(30_000)
    assert.equal(fake.tracker.suspendedMs(), pending)
    // A turn that started after the sleep slept none of it.
    assert.equal(fake.tracker.sleptSince(fake.clock.wallMs - 20_000), 0)
    assert.equal(fake.tracker.sleptSince(turnStart), pending)
  })
}

test('a tick a little late is not a sleep, and a stopped tracker sees none', () => {
  const fake = fakeTracker()
  fake.tracker.start()
  fake.sleep(15_000, true)
  fake.tick()
  assert.equal(fake.tracker.suspendedMs(), 0)
  fake.tracker.stop()
  assert.equal(fake.ticking, false)
  fake.sleep(10 * MINUTE, true)
  assert.equal(fake.tracker.suspendedMs(), 0)
  // Starting again measures from then.
  fake.tracker.start()
  assert.equal(fake.tracker.suspendedMs(), 0)
})

test('the sleep sentence names the time asleep, and the App setting where it has one', () => {
  assert.equal(sleepDuration(70_000), 'about a minute')
  assert.equal(sleepDuration(14 * MINUTE), 'about 14 minutes')
  assert.equal(sleepDuration(65 * MINUTE), 'about an hour')
  assert.equal(sleepDuration(5.4 * 60 * MINUTE), 'about 5 hours')

  assert.equal(sleepNotice(SLEEP_NOTICE_MIN_MS - 1, 'darwin'), null)
  assert.equal(
    sleepNotice(14 * MINUTE, 'darwin'),
    "The computer running Claude slept for about 14 minutes during this turn, which interrupted Claude's connection to the model; send a message (or Continue) to pick up where it left off, and turn on Settings > General > Prevent sleep while running to keep the computer awake during tasks (it does not stop sleep when the lid is closed).",
  )
  for (const platform of ['linux', 'win32'] as const) {
    assert.equal(
      sleepNotice(14 * MINUTE, platform),
      "The computer running Claude slept for about 14 minutes during this turn, which interrupted Claude's connection to the model; send a message (or Continue) to pick up where it left off.",
      platform,
    )
  }
})

test('a failed turn that slept says so, keeping its error code', () => {
  const error = {
    message: 'API Error: Connection error',
    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } },
    additionalDetails: 'ECONNRESET',
  }
  const explained = withSleepNotice(error, 14 * MINUTE, 'linux')
  assert.deepEqual(explained, {
    ...error,
    message: `API Error: Connection error. ${sleepNotice(14 * MINUTE, 'linux')}`,
  })
  // Too short to matter.
  assert.equal(withSleepNotice(error, 30_000, 'linux'), error)
  // Sleep does not explain a refusal of the request itself.
  for (const code of ['usageLimitExceeded', 'contextWindowExceeded', 'unauthorized'] as const) {
    const refused = { ...error, codexErrorInfo: code }
    assert.equal(withSleepNotice(refused, 14 * MINUTE, 'linux'), refused)
  }
  const startup = {
    message: 'Claude Code could not start.',
    codexErrorInfo: 'other' as const,
    additionalDetails: 'Claude Code startup failure: org_config_refused',
  }
  assert.equal(withSleepNotice(startup, 14 * MINUTE, 'linux'), startup)
  // A message that ends a sentence is not given another stop.
  assert.equal(
    withSleepNotice({ ...error, message: 'Network down.' }, 14 * MINUTE, 'linux').message,
    `Network down. ${sleepNotice(14 * MINUTE, 'linux')}`,
  )
})

test('a turn that fails after the computer slept says so in the turn and the error', async () => {
  let slept = 0
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await handlers.onEvent({
      type: 'completed',
      success: false,
      result: 'API Error: Connection error.',
      failure: { terminalReason: null, category: null, status: null },
    })
  })
  await withInProcessApp(
    runtime,
    async (app) => {
      const threadId = await app.startThread()
      const awake = await app.turnCompleted(await app.startTurn(threadId, 'first'))
      assert.equal(awake.status, 'failed')

      slept = 25 * MINUTE
      const turnId = await app.startTurn(threadId, 'second')
      const failed = await app.turnCompleted(turnId)
      assert.match(failed.error.message, /Prevent sleep while running/)
      assert.equal(
        failed.error.message,
        withSleepNotice(awake.error, 25 * MINUTE, 'darwin').message,
      )
      assert.deepEqual(failed.error.codexErrorInfo, awake.error.codexErrorInfo)
      const error = app
        .notified('error')
        .find((params) => params.turnId === turnId && params.willRetry === false)
      assert.deepEqual(error?.error, failed.error)
      assert.equal(error?.willRetry, false)
      const stored = app.store.getTurn(turnId)?.error as { message: string } | null | undefined
      assert.match(stored?.message ?? '', /slept for about 25 minutes/)
    },
    {
      server: {
        sleepMonitor: { suspendedMs: () => slept, sleptSince: () => slept },
        platform: 'darwin',
      },
    },
  )
})
