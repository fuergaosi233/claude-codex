import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TurnWatchdog } from '../src/turn-watchdog.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

const WINDOW = 1_000

// A watchdog on a clock and timers the test runs.
function fakeWatchdog() {
  let now = 0
  let suspended = 0
  let expired = 0
  let pending: { callback: () => void; at: number } | null = null
  const watchdog = new TurnWatchdog({
    timeoutMs: WINDOW,
    onExpire: () => {
      expired += 1
    },
    now: () => now,
    suspendedMs: () => suspended,
    setTimer: (callback, ms) => {
      pending = { callback, at: now + ms }
      return pending
    },
    clearTimer: (handle) => {
      if (handle === pending) pending = null
    },
  })
  return {
    watchdog,
    get expired() {
      return expired
    },
    get dueAt() {
      return pending?.at ?? null
    },
    // Moves the clock, running the timer when it comes due.
    advance(ms: number) {
      const end = now + ms
      while (pending && pending.at <= end) {
        const due = pending
        now = due.at
        pending = null
        due.callback()
      }
      now = end
    },
    // The computer sleeps for `ms`: the clock runs on, as on macOS, and the
    // sleep monitor reports it once awake.
    sleep(ms: number) {
      now += ms
      suspended += ms
    },
    fireDue() {
      const due = pending
      pending = null
      due?.callback()
    },
  }
}

test('the watchdog gives up after a whole window without progress', () => {
  const fake = fakeWatchdog()
  fake.watchdog.arm()
  assert.ok(fake.watchdog.armed)
  fake.advance(600)
  fake.watchdog.noteProgress()
  // Progress moves the end of the window; the timer waits out the rest.
  fake.advance(900)
  assert.equal(fake.expired, 0)
  assert.equal(fake.dueAt, 1_600)
  fake.advance(200)
  assert.equal(fake.expired, 1)
  // Once run out, it stays out.
  fake.watchdog.arm()
  assert.equal(fake.watchdog.armed, false)
})

test('waiting on the user pauses the window, and the window starts over after', async () => {
  const fake = fakeWatchdog()
  fake.watchdog.arm()
  let answer: (value: string) => void = () => {}
  const waiting = fake.watchdog.whilePaused(
    new Promise<string>((resolve) => {
      answer = resolve
    }),
  )
  assert.ok(fake.watchdog.paused)
  fake.advance(10 * WINDOW)
  assert.equal(fake.expired, 0)
  // Pauses nest.
  fake.watchdog.pause()
  answer('yes')
  assert.equal(await waiting, 'yes')
  assert.ok(fake.watchdog.paused)
  fake.watchdog.resume()
  assert.equal(fake.watchdog.paused, false)
  // A whole window from the answer.
  fake.advance(WINDOW - 1)
  assert.equal(fake.expired, 0)
  fake.advance(WINDOW + 1)
  assert.equal(fake.expired, 1)
})

test('a sleep of the computer is not time without progress, and wake does not fire it', () => {
  const fake = fakeWatchdog()
  fake.watchdog.arm()
  fake.advance(500)
  // The computer sleeps for an hour; on wake the overdue timer runs at once.
  fake.sleep(3_600_000)
  fake.fireDue()
  assert.equal(fake.expired, 0)
  // The window starts over from the wake.
  fake.advance(WINDOW - 1)
  assert.equal(fake.expired, 0)
  fake.advance(1)
  assert.equal(fake.expired, 1)
})

test('a window of zero turns the watchdog off', () => {
  const watchdog = new TurnWatchdog({ timeoutMs: 0, onExpire: () => assert.fail('expired') })
  assert.equal(watchdog.enabled, false)
  watchdog.arm()
  assert.equal(watchdog.armed, false)
})

test('a turn whose subagent waits while the user answers a question is not failed', {
  timeout: 20_000,
}, async () => {
  const runtime = scriptedRuntime(async (context, handlers) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: `task-${context.turnId}`,
      toolName: 'Task',
      input: { description: 'research', prompt: 'look around' },
    })
    const answers = await handlers.onUserInputRequest?.({
      type: 'user_input_request',
      requestId: 'ask-1',
      toolUseId: `ask-${context.turnId}`,
      questions: [
        {
          id: 'q1',
          header: 'Scope',
          question: 'Which folder?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'src', description: '' }],
        },
      ],
    })
    await handlers.onEvent({
      type: 'tool_result',
      toolUseId: `task-${context.turnId}`,
      content: `searched ${answers?.answers.q1?.answers[0] ?? 'nothing'}`,
    })
    await handlers.onEvent({ type: 'text_delta', delta: 'done' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  })
  await withInProcessApp(
    runtime,
    async (app) => {
      const threadId = await app.startThread()
      const turnId = await app.startTurn(threadId, 'research with a question')
      const question = await app.waitFor(() =>
        app.messages.find((message) => message.method === 'item/tool/requestUserInput'),
      )
      // Many windows pass while the question waits.
      await delay(800)
      assert.equal(app.store.getTurn(turnId)?.status, 'inProgress')
      await app.respond(question.id, { answers: { q1: { answers: ['src'] } } })
      assert.equal((await app.turnCompleted(turnId)).status, 'completed')
    },
    { env: { CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS: '150' } },
  )
})
