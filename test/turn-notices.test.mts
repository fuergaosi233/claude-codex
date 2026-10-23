import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_VISIBLE_NOTICES_PER_TURN,
  noticeTurnError,
  TurnNoticeLog,
  withTurnNotices,
} from '../src/turn-notices.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

// Notices: what Claude Code reports beside a turn. The App ignores
// `warning`, so each one also shows as an `error` row with willRetry, which
// it draws under the turn without failing it.

test('a turn records each notice once, and shows only the first few as rows', () => {
  const log = new TurnNoticeLog()
  assert.deepEqual(log.record('turn-1', 'one'), { warn: true, show: true })
  assert.deepEqual(log.record('turn-1', 'one'), { warn: false, show: false })
  // Another turn has its own.
  assert.deepEqual(log.record('turn-2', 'one'), { warn: true, show: true })
  for (let i = 2; i <= MAX_VISIBLE_NOTICES_PER_TURN; i += 1) {
    assert.deepEqual(log.record('turn-1', `notice ${i}`), { warn: true, show: true })
  }
  // Past the limit the warning still goes out, without a row.
  assert.deepEqual(log.record('turn-1', 'one more'), { warn: true, show: false })
  assert.deepEqual(log.messages('turn-1'), [
    'one',
    ...Array.from({ length: MAX_VISIBLE_NOTICES_PER_TURN - 1 }, (_, i) => `notice ${i + 2}`),
    'one more',
  ])
  log.forget('turn-1')
  assert.deepEqual(log.messages('turn-1'), [])
})

test("a failed turn's details repeat its notices", () => {
  const error = { message: 'Connection error.', codexErrorInfo: 'other' as const }
  const failed = { ...error, additionalDetails: null }
  assert.equal(withTurnNotices(failed, []), failed)
  // The notice that is the error itself is not repeated.
  assert.equal(withTurnNotices(failed, ['Connection error.']), failed)
  assert.deepEqual(withTurnNotices(failed, ['Claude switched to claude-b.']), {
    ...error,
    additionalDetails: 'Claude reported during this turn:\n- Claude switched to claude-b.',
  })
  assert.deepEqual(
    withTurnNotices({ ...error, additionalDetails: 'HTTP 502' }, ['Compaction failed.']),
    {
      ...error,
      additionalDetails: 'HTTP 502\n\nClaude reported during this turn:\n- Compaction failed.',
    },
  )
  const many = Array.from({ length: 13 }, (_, i) => `notice ${i + 1}`)
  const details = withTurnNotices(failed, many).additionalDetails ?? ''
  assert.match(details, /- notice 10\n- and 3 more$/)
  assert.doesNotMatch(details, /notice 11/)
  assert.deepEqual(noticeTurnError('hello'), {
    message: 'hello',
    codexErrorInfo: null,
    additionalDetails: null,
  })
})

test('notices show as rows under their turn, once each, without failing it', async () => {
  const runtime = scriptedRuntime(async (_context, handlers) => {
    for (let i = 1; i <= 7; i += 1) {
      await handlers.onEvent({ type: 'notice', level: 'warning', message: `Notice ${i}` })
    }
    await handlers.onEvent({ type: 'notice', level: 'warning', message: 'Notice 1' })
    await handlers.onEvent({ type: 'notice', level: 'info', message: 'Just so you know' })
    await handlers.onEvent({ type: 'text_delta', delta: 'done' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  })
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'go')
    const completed = await app.turnCompleted(turnId)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(
      app.notified('warning').map((params) => params.message),
      ['Notice 1', 'Notice 2', 'Notice 3', 'Notice 4', 'Notice 5', 'Notice 6', 'Notice 7'],
    )
    const rows = app.notified('error')
    assert.deepEqual(
      rows,
      ['Notice 1', 'Notice 2', 'Notice 3', 'Notice 4', 'Notice 5'].map((message) => ({
        threadId,
        turnId,
        willRetry: true,
        error: { message, codexErrorInfo: null, additionalDetails: null },
      })),
    )
    // A row is not part of the turn's history.
    assert.equal(app.store.getTurn(turnId)?.error, null)
  })
})

test('CLAUDE_CODEX_NOTICE_ROWS=0, and a structured-output turn, keep notices to warnings', async () => {
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await handlers.onEvent({ type: 'notice', level: 'warning', message: 'Heads up' })
    await handlers.onEvent({ type: 'text_delta', delta: '{"title":"Hi"}' })
    await handlers.onEvent({ type: 'completed', success: true, result: '{"title":"Hi"}' })
  })
  await withInProcessApp(
    runtime,
    async (app) => {
      const threadId = await app.startThread()
      await app.turnCompleted(await app.startTurn(threadId, 'go'))
      assert.deepEqual(
        app.notified('warning').map((params) => params.message),
        ['Heads up'],
      )
      assert.deepEqual(app.notified('error'), [])
    },
    { env: { CLAUDE_CODEX_NOTICE_ROWS: '0' } },
  )
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'title this', {
      outputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    })
    await app.turnCompleted(turnId)
    assert.deepEqual(
      app.notified('warning').map((params) => params.message),
      ['Heads up'],
    )
    assert.equal(
      app.notified('error').some((params) => params.willRetry === true),
      false,
    )
  })
})

test("a failed turn keeps the notices it had in its error's details", async () => {
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await handlers.onEvent({
      type: 'notice',
      level: 'warning',
      message: 'Claude switched to claude-b.',
    })
    await handlers.onEvent({
      type: 'completed',
      success: false,
      result: 'API Error: Connection error.',
      failure: { terminalReason: null, category: null, status: null },
    })
  })
  await withInProcessApp(runtime, async (app) => {
    const threadId = await app.startThread()
    const turnId = await app.startTurn(threadId, 'go')
    const completed = await app.turnCompleted(turnId)
    assert.equal(completed.status, 'failed')
    const details = 'Claude reported during this turn:\n- Claude switched to claude-b.'
    assert.ok(completed.error.additionalDetails.endsWith(details))
    const failure = app.notified('error').find((params) => params.willRetry === false)
    assert.deepEqual(failure?.error, completed.error)
    // The App keeps the failed turn, details included.
    const stored = app.store.getTurn(turnId)?.error as { additionalDetails?: string } | null
    assert.ok(stored?.additionalDetails?.endsWith(details))
  })
})

test('a notice between turns shows under the running turn, else the last one', async () => {
  let release: (() => void) | null = null
  const runtime = scriptedRuntime(async (context, handlers) => {
    if (context.prompt.includes('hold')) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    await handlers.onEvent({ type: 'text_delta', delta: 'done' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  })
  await withInProcessApp(runtime, async (app) => {
    const listener = runtime.listener
    assert.ok(listener?.onNotice)
    const denied =
      'Bash was denied: background work asked for it while no turn was running, so there was nowhere to ask you for approval. Ask Claude to run it again in a new message to approve it.'

    // A thread without turns has nothing to show it under.
    const fresh = await app.startThread()
    listener.onNotice(fresh, denied)
    assert.deepEqual(app.notified('warning'), [{ threadId: fresh, message: denied }])
    assert.deepEqual(app.notified('error'), [])

    const threadId = await app.startThread()
    const firstTurn = await app.startTurn(threadId, 'go')
    await app.turnCompleted(firstTurn)
    listener.onNotice(threadId, denied)
    assert.deepEqual(app.notified('error'), [
      {
        threadId,
        turnId: firstTurn,
        willRetry: true,
        error: { message: denied, codexErrorInfo: null, additionalDetails: null },
      },
    ])
    // The ended turn stays as it was.
    assert.equal(app.store.getTurn(firstTurn)?.status, 'completed')
    // The same notice again for that turn is not repeated.
    listener.onNotice(threadId, denied)
    assert.equal(app.notified('error').length, 1)

    const running = await app.startTurn(threadId, 'hold')
    const releaseTurn = await app.waitFor(() => release ?? undefined)
    listener.onNotice(threadId, 'tracker asked for your input while no turn was running.')
    assert.equal(app.notified('error').at(-1)?.turnId, running)
    releaseTurn()
    assert.equal((await app.turnCompleted(running)).status, 'completed')
  })
})
