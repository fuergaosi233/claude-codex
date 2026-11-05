import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileChangeFromTool } from '../src/server-helpers.mjs'
import {
  adapter,
  awaitMessage,
  completedItems,
  JsonLineReader,
  json,
  mockTurnMessages,
  nextNotification,
  readQuiet,
  readUntil,
  spawnMockAdapter,
  startMockThread,
  stopProcess,
  textInput,
  waitForExit,
} from './support/adapter-harness.mjs'

test('review/start and thread/compact/start emit real turn items', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'thread/compact/start', params: { threadId } }))
    await reader.nextResponse(2)
    let sawCompaction = false
    let summary = ''
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'contextCompaction')
        sawCompaction = true
      if (message.method === 'item/agentMessage/delta') summary += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawCompaction, true)
    // No Claude session to compact yet: the summary model writes a summary.
    assert.match(summary, /MOCK_COMPACT_SUMMARY/)

    proc.stdin.write(
      json({
        id: 3,
        method: 'review/start',
        params: {
          threadId,
          delivery: 'inline',
          target: { type: 'custom', instructions: 'notice event' },
        },
      }),
    )
    const review = await reader.nextResponse(3)
    assert.equal(review.result.reviewThreadId, threadId)
    assert.equal(review.result.turn.status, 'inProgress')
    // Like the real app-server's build_review_turn, the review/start RESPONSE
    // carries the synthesized userMessage (review label) with itemsView
    // notLoaded; enteredReviewMode arrives via the item/started event stream.
    assert.equal(review.result.turn.itemsView, 'notLoaded')
    assert.equal(
      review.result.turn.items.some((item: any) => item.type === 'userMessage'),
      true,
    )
    assert.equal(
      review.result.turn.items.some((item: any) => item.type === 'enteredReviewMode'),
      false,
    )

    let reviewText = ''
    let reviewWarning: any = null
    // Like Codex, the entered marker completes as the review starts, and the
    // exited one, holding the review, closes the turn: here the fallback
    // text, as the reviewer gave no answer.
    const markers: string[] = []
    let exited: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      const item = message.params?.item
      if (/^item\/(started|completed)$/.test(message.method) && /ReviewMode$/.test(item.type))
        markers.push(`${message.method} ${item.type}`)
      if (message.method === 'item/completed' && item.type === 'exitedReviewMode') exited = item
      if (message.method === 'item/agentMessage/delta') reviewText += message.params.delta
      if (message.method === 'warning') reviewWarning = message.params
      if (message.method === 'turn/completed') break
    }
    assert.deepEqual(markers, [
      'item/started enteredReviewMode',
      'item/completed enteredReviewMode',
      'item/started exitedReviewMode',
      'item/completed exitedReviewMode',
    ])
    assert.equal(exited.review, 'Reviewer failed to output a response.')
    assert.equal(reviewText, '')
    assert.deepEqual(reviewWarning, { threadId, message: 'mock rate limit notice' })

    // A review that answers ends with that answer as its review.
    proc.stdin.write(
      json({
        id: 4,
        method: 'review/start',
        params: {
          threadId,
          delivery: 'inline',
          target: { type: 'custom', instructions: 'thinking check' },
        },
      }),
    )
    const answered = await reader.nextResponse(4)
    let completedTurn: any = null
    for (let i = 0; i < 500 && !completedTurn; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') completedTurn = message.params.turn
    }
    assert.equal(completedTurn.id, answered.result.turn.id)
    assert.equal(completedTurn.status, 'completed')
    proc.stdin.write(
      json({ id: 5, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(5)
    const reviewTurn = read.result.thread.turns.find((turn: any) => turn.id === completedTurn.id)
    assert.deepEqual(
      reviewTurn.items.map((item: any) => item.type),
      ['userMessage', 'enteredReviewMode', 'reasoning', 'agentMessage', 'exitedReviewMode'],
    )
    // Reviews show Claude's thinking like any other turn.
    assert.equal(reviewTurn.items.at(-1).review, 'done thinkingDisplay=summarized')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a review cut off by an interrupt or by the adapter stopping still exits review mode', {
  timeout: 30_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const launch = () => {
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    t.signal.addEventListener('abort', () => proc.kill('SIGKILL'))
    return { proc, reader: new JsonLineReader(proc) }
  }
  const first = launch()
  let second: ReturnType<typeof launch> | null = null
  try {
    const { proc, reader } = first
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    // A review Claude is still answering when it is cut off.
    const heldReview = async (id: number): Promise<string> => {
      proc.stdin.write(
        json({
          id,
          method: 'review/start',
          params: {
            threadId,
            delivery: 'inline',
            target: { type: 'custom', instructions: 'hold this turn until released' },
          },
        }),
      )
      const turnId = (await reader.nextResponse(id)).result.turn.id
      await nextNotification(reader, 'item/agentMessage/delta')
      return turnId
    }

    // Interrupted: the exited marker, holding the fallback rather than the
    // unfinished text, goes out before the turn ends.
    const interruptedId = await heldReview(2)
    proc.stdin.write(
      json({ id: 3, method: 'turn/interrupt', params: { threadId, turnId: interruptedId } }),
    )
    const markers: string[] = []
    let exited: any = null
    let completed: any = null
    for (let i = 0; i < 500 && !completed; i += 1) {
      const message = await reader.next()
      const item = message.params?.item
      if (/^item\/(started|completed)$/.test(message.method) && /ReviewMode$/.test(item.type)) {
        markers.push(`${message.method} ${item.type}`)
        exited = item
      }
      if (message.method === 'turn/completed') completed = message.params.turn
    }
    assert.deepEqual(markers, ['item/started exitedReviewMode', 'item/completed exitedReviewMode'])
    assert.equal(exited.review, 'Reviewer failed to output a response.')
    assert.equal(completed.id, interruptedId)
    assert.equal(completed.status, 'interrupted')

    // Stopped: the adapter records the marker as it ends the turn, so the
    // thread reads the same after a restart.
    const stoppedId = await heldReview(4)
    proc.kill('SIGTERM')
    assert.equal(await waitForExit(proc, 20_000), 0)
    second = launch()
    second.proc.stdin.write(
      json({ id: 1, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await second.reader.nextResponse(1)
    const turns = read.result.thread.turns
    for (const turnId of [interruptedId, stoppedId]) {
      const turn = turns.find((candidate: any) => candidate.id === turnId)
      assert.equal(turn.status, 'interrupted')
      const reviewItems = turn.items.filter((item: any) => /ReviewMode$/.test(item.type))
      assert.deepEqual(
        reviewItems.map((item: any) => item.type),
        ['enteredReviewMode', 'exitedReviewMode'],
      )
      assert.equal(turn.items.at(-1).type, 'exitedReviewMode')
      assert.equal(turn.items.at(-1).review, 'Reviewer failed to output a response.')
    }
  } finally {
    first.proc.kill()
    second?.proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Runs the mock thinking turn and returns what it sent about reasoning.
async function runThinkingTurn(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
  threadId: string,
  id: number,
): Promise<{ reasoning: any[]; completed: any; text: string }> {
  proc.stdin.write(
    json({ id, method: 'turn/start', params: { threadId, input: textInput('thinking check') } }),
  )
  const seen = await readUntil(reader, (message) => message.method === 'turn/completed')
  const reasoning = seen.filter(
    (message) =>
      message.method?.startsWith('item/reasoning/') ||
      (message.method?.startsWith('item/') && message.params?.item?.type === 'reasoning'),
  )
  const completed = seen.find(
    (message) => message.method === 'item/completed' && message.params.item.type === 'reasoning',
  )?.params.item
  const text = seen
    .filter((message) => message.method === 'item/agentMessage/delta')
    .map((message) => message.params.delta)
    .join('')
  return { reasoning, completed, text }
}

async function readReasoningItems(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
  threadId: string,
  id: number,
): Promise<any[]> {
  proc.stdin.write(json({ id, method: 'thread/read', params: { threadId, includeTurns: true } }))
  const read = await reader.nextResponse(id)
  return read.result.thread.turns
    .flatMap((turn: any) => turn.items)
    .filter((item: any) => item.type === 'reasoning')
}

test('Claude thinking streams as the Codex reasoning summary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    const { reasoning, completed, text } = await runThinkingTurn(reader, proc, threadId, 2)

    // The CLI is asked for readable thinking, which the App shows only as a
    // summary: the part opens first, then the text streams into it.
    assert.equal(text, 'done thinkingDisplay=summarized')
    assert.deepEqual(
      reasoning.map((message) => message.method),
      [
        'item/started',
        'item/reasoning/summaryPartAdded',
        'item/reasoning/summaryTextDelta',
        'item/completed',
      ],
    )
    assert.deepEqual(reasoning[0].params.item.summary, [''])
    assert.deepEqual(reasoning[0].params.item.content, [])
    assert.equal(reasoning[1].params.summaryIndex, 0)
    assert.equal(reasoning[1].params.itemId, completed.id)
    assert.equal(reasoning[2].params.summaryIndex, 0)
    assert.equal(reasoning[2].params.delta, 'mock thinking')
    assert.deepEqual(completed.summary, ['mock thinking'])
    assert.deepEqual(completed.content, [])

    const stored = await readReasoningItems(reader, proc, threadId, 3)
    assert.deepEqual(
      stored.map((item) => [item.summary, item.content]),
      [[['mock thinking'], []]],
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('with reasoning summaries off Claude thinking stays raw reasoning content', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  let proc = spawnMockAdapter(home, { CLAUDE_CODEX_REASONING_VISIBLE: '0' })
  let reader = new JsonLineReader(proc)
  let threadId = ''
  try {
    threadId = await startMockThread(reader, proc)
    const { reasoning, completed, text } = await runThinkingTurn(reader, proc, threadId, 2)
    assert.equal(text, 'done thinkingDisplay=default')
    assert.deepEqual(
      reasoning.map((message) => message.method),
      ['item/started', 'item/reasoning/textDelta', 'item/completed'],
    )
    assert.equal(reasoning[1].params.contentIndex, 0)
    assert.deepEqual(completed.summary, [])
    assert.deepEqual(completed.content, ['mock thinking'])
  } finally {
    proc.kill()
    await once(proc, 'exit')
  }

  // Without the opt-out the thinking stored as content reads back as the
  // summary, until model_reasoning_summary turns summaries off again.
  proc = spawnMockAdapter(home)
  reader = new JsonLineReader(proc)
  try {
    const shown = await readReasoningItems(reader, proc, threadId, 1)
    assert.deepEqual(
      shown.map((item) => [item.summary, item.content]),
      [[['mock thinking'], ['mock thinking']]],
    )

    proc.stdin.write(
      json({
        id: 2,
        method: 'config/value/write',
        params: { keyPath: 'model_reasoning_summary', value: 'none' },
      }),
    )
    await reader.nextResponse(2)
    const hidden = await readReasoningItems(reader, proc, threadId, 3)
    assert.deepEqual(
      hidden.map((item) => [item.summary, item.content]),
      [[[], ['mock thinking']]],
    )
    const { completed, text } = await runThinkingTurn(reader, proc, threadId, 4)
    assert.equal(text, 'done thinkingDisplay=default')
    assert.deepEqual(completed.summary, [])
    assert.deepEqual(completed.content, ['mock thinking'])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('API retries show as Reconnecting errors and a failed turn carries its Codex error code', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('api retry check') },
      }),
    )
    const retried = await readUntil(reader, (message) => message.method === 'turn/completed')
    const retries = retried.filter((message) => message.method === 'error')
    const turnId = retried.at(-1)?.params.turn.id
    // The App counts attempts only from a message of exactly this form.
    assert.deepEqual(
      retries.map((message) => message.params),
      [
        {
          threadId,
          turnId,
          willRetry: true,
          error: {
            message: 'Reconnecting... 1/10',
            codexErrorInfo: 'serverOverloaded',
            additionalDetails: 'HTTP 529 overloaded; retrying in 1s',
          },
        },
        {
          threadId,
          turnId,
          willRetry: true,
          error: {
            message: 'Reconnecting... 2/10',
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
            additionalDetails: 'no response',
          },
        },
      ],
    )
    for (const retry of retries) {
      assert.match(retry.params.error.message, /^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$/)
    }
    assert.equal(retried.at(-1)?.params.turn.status, 'completed')
    assert.equal(retried.at(-1)?.params.turn.error, null)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: textInput('overloaded failure check') },
      }),
    )
    const failed = await readUntil(reader, (message) => message.method === 'turn/completed')
    const expected = {
      message: 'API Error: 529 Overloaded',
      codexErrorInfo: 'serverOverloaded',
      additionalDetails: 'HTTP 529 overloaded',
    }
    const errors = failed.filter((message) => message.method === 'error')
    assert.deepEqual(
      errors.map((message) => [message.params.willRetry, message.params.error]),
      [[false, expected]],
    )
    assert.equal(failed.at(-1)?.params.turn.status, 'failed')
    assert.deepEqual(failed.at(-1)?.params.turn.error, expected)

    // History keeps the failure with its code, and none of the retries.
    proc.stdin.write(
      json({ id: 4, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(4)
    const turns = read.result.thread.turns
    assert.deepEqual(
      turns.map((turn: any) => [turn.status, turn.error]),
      [
        ['completed', null],
        ['failed', expected],
      ],
    )
    assert.equal(
      turns.flatMap((turn: any) => turn.items).some((item: any) => item.type === 'error'),
      false,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a Claude Code that refused to start fails the turn with why, retryable only when a retry can help', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    const cases = [
      ['org_config_required_unavailable', { httpConnectionFailed: { httpStatusCode: null } }],
      ['org_config_refused', 'other'],
      ['provider_not_allowed', 'other'],
      ['proxy_invalid', 'other'],
    ] as const
    let id = 2
    for (const [reason, code] of cases) {
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: { threadId, input: textInput(`startup failure check ${reason}`) },
        }),
      )
      id += 1
      const failed = await readUntil(reader, (message) => message.method === 'turn/completed')
      const error = failed.at(-1)?.params.turn.error
      assert.equal(failed.at(-1)?.params.turn.status, 'failed', reason)
      assert.deepEqual(error.codexErrorInfo, code, reason)
      assert.equal(error.additionalDetails, `Claude Code startup failure: ${reason}`)
      assert.match(error.message, /^Claude Code |^Anthropic |^Your organization|^A proxy/, reason)
      assert.deepEqual(
        failed
          .filter((message) => message.method === 'error')
          .map((message) => [message.params.willRetry, message.params.error]),
        [[false, error]],
        reason,
      )
      // The CLI's own text, with the proxy's credentials, reaches no one.
      assert.doesNotMatch(JSON.stringify(failed), /secret|proxy\.invalid/, reason)
    }
    proc.stdin.write(json({ id, method: 'thread/read', params: { threadId, includeTurns: true } }))
    const read = await reader.nextResponse(id)
    assert.doesNotMatch(JSON.stringify(read.result), /secret|proxy\.invalid/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the context gauge follows the last API call and child tokens add to the total', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('context usage check') },
      }),
    )
    await reader.nextResponse(2)
    const turn = await readUntil(
      reader,
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    )
    const updates = turn
      .filter((m) => m.method === 'thread/tokenUsage/updated')
      .map((m) => m.params.tokenUsage)
    const lastCall = {
      inputTokens: 30,
      cachedInputTokens: 120,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      totalTokens: 200,
    }
    assert.equal(updates.length, 2)
    // Codex's last_token_usage is one response, which is what fills the
    // context; the result's sum over both calls would not be.
    assert.deepEqual(updates[0].last, lastCall)
    assert.equal(updates[0].total.totalTokens, 320)
    assert.equal(updates[0].modelContextWindow, 200_000)
    assert.deepEqual(updates[1].last, lastCall, 'child tokens leave the gauge alone')
    assert.equal(updates[1].total.totalTokens, 1320)
    assert.equal(updates[1].modelContextWindow, 200_000)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the context gauge moves with each API call once the window is known', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  // [last, total, window] of each token usage update of a turn.
  const runTurn = async (id: number, threadId: string): Promise<unknown[]> => {
    proc.stdin.write(
      json({
        id,
        method: 'turn/start',
        params: { threadId, input: textInput('context usage check') },
      }),
    )
    const turn = await readUntil(
      reader,
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    )
    return turn
      .filter((m) => m.method === 'thread/tokenUsage/updated' && m.params.threadId === threadId)
      .map(({ params: { tokenUsage } }) => [
        tokenUsage.last.totalTokens,
        tokenUsage.total.totalTokens,
        tokenUsage.modelContextWindow,
      ])
  }
  try {
    const threadId = await startMockThread(reader, proc)
    // The window comes with the first result, so the first turn moves the
    // gauge only at its end.
    assert.deepEqual(await runTurn(2, threadId), [
      [200, 320, 200_000],
      [200, 1320, 200_000],
    ])
    // Then each call moves it as it streams, once however often it repeats
    // its usage, on top of the settled total; the result settles the same
    // total, counting nothing twice, and a child adds to the total only.
    assert.deepEqual(await runTurn(3, threadId), [
      [120, 1440, 200_000],
      [200, 1640, 200_000],
      [200, 1640, 200_000],
      [200, 2640, 200_000],
    ])

    // A new thread on the same model starts with the window it reported.
    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const other = (await reader.nextResponse(4)).result.thread.id
    assert.deepEqual(await runTurn(5, other), [
      [120, 120, 200_000],
      [200, 320, 200_000],
      [200, 320, 200_000],
      [200, 1320, 200_000],
    ])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude token usage maps to thread/tokenUsage/updated notifications', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'usage check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    let tokenUsage: any = null
    let completedTurn: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/tokenUsage/updated') tokenUsage = message.params
      if (message.method === 'turn/completed') {
        completedTurn = message.params.turn
        break
      }
    }
    assert.ok(tokenUsage, 'expected a thread/tokenUsage/updated notification')
    assert.equal(tokenUsage.threadId, threadId)
    // The Codex v2 Turn schema has no api/cost metadata fields, so turn/completed
    // must not carry the adapter's internal apiDurationMs/numTurns/costUsd; token
    // metrics are surfaced through thread/tokenUsage/updated instead.
    assert.ok(completedTurn, 'turn/completed must arrive')
    assert.ok(!('apiDurationMs' in completedTurn))
    assert.ok(!('numTurns' in completedTurn))
    assert.ok(!('costUsd' in completedTurn))
    // input_tokens 100 + cache_creation 5 = 105 input; cache_read 10; output 40.
    assert.deepEqual(tokenUsage.tokenUsage.last, {
      inputTokens: 105,
      cachedInputTokens: 10,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 155,
    })
    assert.deepEqual(tokenUsage.tokenUsage.total, tokenUsage.tokenUsage.last)
    assert.equal(tokenUsage.tokenUsage.modelContextWindow, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('baseInstructions / developerInstructions / personality flow into the system prompt addendum', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          baseInstructions: 'Always write SQL in lowercase.',
          developerInstructions: 'Avoid SELECT *.',
          personality: 'pragmatic',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'system prompt check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    const addendumLine = text.replace(/^systemPromptAddendum=/, '')
    const addendum = JSON.parse(addendumLine)
    assert.ok(typeof addendum === 'string', 'systemPromptAddendum should be a non-null string')
    assert.match(addendum, /Always write SQL in lowercase\./)
    assert.match(addendum, /Avoid SELECT \*/)
    assert.match(addendum, /Personality: pragmatic/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude hook runs are reported as Codex hook/started and hook/completed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const project = await mkdtemp(join(tmpdir(), 'claude-codex-hooks-'))
  const settings = join(project, '.claude', 'settings.json')
  await mkdir(join(project, '.claude'), { recursive: true })
  await writeFile(
    settings,
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'true' }] }] } }),
  )
  // HOME too: hooks in the runner's own ~/.claude/settings.json would claim
  // the run before the project's file.
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: project } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hook check', text_elements: [] }] },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id

    const hookMessages: any[] = []
    const itemTypes: string[] = []
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'hook/started' || message.method === 'hook/completed')
        hookMessages.push(message)
      if (message.method === 'item/started') itemTypes.push(message.params.item.type)
      if (message.method === 'turn/completed') break
    }
    // The Notification hook has no Codex event name and is dropped.
    assert.deepEqual(
      hookMessages.map((message) => message.method),
      ['hook/started', 'hook/completed'],
    )
    const [started, completed] = hookMessages
    assert.equal(started.params.threadId, threadId)
    assert.equal(started.params.turnId, turnId)
    assert.deepEqual(
      {
        id: started.params.run.id,
        eventName: started.params.run.eventName,
        status: started.params.run.status,
        source: started.params.run.source,
        sourcePath: started.params.run.sourcePath,
        scope: started.params.run.scope,
        completedAt: started.params.run.completedAt,
      },
      {
        id: 'mock-hook',
        eventName: 'preToolUse',
        status: 'running',
        source: 'project',
        sourcePath: settings,
        scope: 'turn',
        completedAt: null,
      },
    )
    assert.equal(completed.params.run.id, 'mock-hook')
    assert.equal(completed.params.run.status, 'blocked')
    assert.deepEqual(completed.params.run.entries, [
      { kind: 'feedback', text: 'Bash about to run echo hi' },
    ])
    assert.equal(typeof completed.params.run.completedAt, 'number')
    assert.equal(typeof completed.params.run.durationMs, 'number')
    // Hook runs are not transcript items.
    assert.equal(itemTypes.includes('hookPrompt'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

for (const mode of ['form', 'url'] as const) {
  test(`MCP ${mode} elicitations are bridged to mcpServer/elicitation/request`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
      const threadId = (await reader.nextResponse(1)).result.thread.id
      const prompt = mode === 'url' ? 'elicitation check url' : 'elicitation check'
      proc.stdin.write(
        json({
          id: 2,
          method: 'turn/start',
          params: { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] },
        }),
      )
      const turnId = (await reader.nextResponse(2)).result.turn.id

      let request: any = null
      let waiting = false
      while (request == null) {
        const message = await reader.next()
        if (
          message.method === 'thread/status/changed' &&
          message.params.status.activeFlags?.includes('waitingOnUserInput')
        )
          waiting = true
        if (message.method === 'mcpServer/elicitation/request') request = message
      }
      assert.equal(waiting, true)
      const expected =
        mode === 'url'
          ? {
              threadId,
              turnId,
              serverName: 'mock-mcp',
              message: 'Sign in to continue',
              mode: 'url',
              url: 'https://example.com/auth',
              elicitationId: 'mock-elicitation',
            }
          : {
              threadId,
              turnId,
              serverName: 'mock-mcp',
              message: 'Pick a region',
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: { region: { type: 'string' } },
                required: ['region'],
              },
            }
      assert.deepEqual(request.params, expected)

      const result =
        mode === 'url'
          ? { action: 'decline', content: null, _meta: null }
          : { action: 'accept', content: { region: 'eu' }, _meta: null }
      proc.stdin.write(json({ jsonrpc: '2.0', id: request.id, result }))

      let resolved = false
      let text = ''
      for (let i = 0; i < 200; i += 1) {
        const message = await reader.next()
        if (message.method === 'serverRequest/resolved' && message.params.requestId === request.id)
          resolved = true
        if (message.method === 'item/agentMessage/delta') text += message.params.delta
        if (message.method === 'turn/completed') break
      }
      assert.equal(resolved, true)
      assert.equal(
        text,
        mode === 'url'
          ? 'elicitation={"action":"decline"}'
          : 'elicitation={"action":"accept","content":{"region":"eu"}}',
      )
    } finally {
      proc.kill()
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  })
}

// Runs `text` as a turn of the thread and returns what arrived until it ended.
async function runCompactionTestTurn(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
  id: number,
  threadId: string,
  text: string,
): Promise<{ turnId: string; seen: any[] }> {
  proc.stdin.write(json({ id, method: 'turn/start', params: { threadId, input: textInput(text) } }))
  const seen: any[] = []
  const response = await awaitMessage(reader, (message) => message.id === id, seen)
  await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
  return { turnId: response.result.turn.id, seen }
}

// Starts thread/compact/start and returns the compaction turn's id and what
// arrived until `done`.
async function compactTestThread(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
  id: number,
  threadId: string,
  done: (message: any) => boolean,
): Promise<{ turnId: string; seen: any[] }> {
  proc.stdin.write(json({ id, method: 'thread/compact/start', params: { threadId } }))
  const seen: any[] = []
  const response = await awaitMessage(reader, (message) => message.id === id, seen)
  assert.deepEqual(response.result, {})
  const started = await awaitMessage(reader, (message) => message.method === 'turn/started', seen)
  await awaitMessage(reader, done, seen)
  return { turnId: started.params.turn.id, seen }
}

function compactionItemEvents(seen: any[], method: string): any[] {
  return seen.filter(
    (message) => message.method === method && message.params.item?.type === 'contextCompaction',
  )
}

test('thread/compact/start compacts the Claude session of a thread that has one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    await runCompactionTestTurn(reader, proc, 2, threadId, 'hello world')

    const { turnId, seen } = await compactTestThread(
      reader,
      proc,
      3,
      threadId,
      (message) => message.method === 'thread/compacted',
    )
    // Claude compacts its own session: one contextCompaction item, and no
    // summary message of the adapter's.
    const started = compactionItemEvents(seen, 'item/started')
    const completed = compactionItemEvents(seen, 'item/completed')
    assert.equal(started.length, 1)
    assert.equal(completed.length, 1)
    assert.equal(completed[0].params.item.id, started[0].params.item.id)
    assert.equal(completed[0].params.turnId, turnId)
    const ofTurn = seen.filter((message) => message.params?.turnId === turnId)
    assert.equal(
      ofTurn.some(
        (message) =>
          message.method === 'item/started' && message.params.item.type === 'agentMessage',
      ),
      false,
    )
    assert.equal(
      ofTurn.some((message) => message.method === 'item/agentMessage/delta'),
      false,
    )
    // The context meter drops to the summary Claude goes on from.
    const usage = ofTurn.filter((message) => message.method === 'thread/tokenUsage/updated')
    assert.equal(usage.length, 1)
    assert.equal(usage[0].params.turnId, turnId)
    assert.equal(usage[0].params.tokenUsage.last.totalTokens, 12_000)
    const turnCompleted = seen.find((message) => message.method === 'turn/completed')
    assert.equal(turnCompleted.params.turn.id, turnId)
    assert.equal(turnCompleted.params.turn.status, 'completed')
    assert.deepEqual(seen.at(-1).params, { threadId, turnId })

    // The thread goes on in the session it compacted.
    const next = await runCompactionTestTurn(reader, proc, 4, threadId, 'rewind check')
    const text = next.seen
      .filter((message) => message.method === 'item/agentMessage/delta')
      .map((message) => message.params.delta)
      .join('')
    assert.equal(text, `resumed mock-${threadId} at end after 0 resets`)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/compact/start writes a summary when Claude cannot compact, and keeps the session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    await runCompactionTestTurn(reader, proc, 2, threadId, 'next compaction fails')

    const { turnId, seen } = await compactTestThread(
      reader,
      proc,
      3,
      threadId,
      (message) => message.method === 'turn/completed',
    )
    seen.push(...(await readQuiet(reader, 300)))
    const warning = seen.find((message) => message.method === 'warning')
    assert.equal(
      warning?.params.message,
      'Claude could not compact the conversation: mock compaction failure',
    )
    // The summary model's summary, not the local template.
    const text = seen
      .filter((message) => message.method === 'item/agentMessage/delta')
      .map((message) => message.params.delta)
      .join('')
    assert.match(text, /MOCK_COMPACT_SUMMARY/)
    assert.doesNotMatch(text, /Context compacted for thread/)
    // Nothing claims the session was compacted: the item closes as an empty
    // reasoning item, and no thread/compacted follows.
    const [started] = compactionItemEvents(seen, 'item/started')
    assert.equal(compactionItemEvents(seen, 'item/completed').length, 0)
    assert.deepEqual(
      seen
        .filter(
          (message) =>
            message.method === 'item/completed' &&
            message.params.item.id === started.params.item.id,
        )
        .map((message) => message.params.item),
      [{ type: 'reasoning', id: started.params.item.id, summary: [], content: [] }],
    )
    assert.equal(
      seen.some((message) => message.method === 'thread/compacted'),
      false,
    )
    assert.equal(
      seen.some(
        (message) =>
          message.method === 'thread/tokenUsage/updated' && message.params.turnId === turnId,
      ),
      false,
    )
    const turnCompleted = seen.find((message) => message.method === 'turn/completed')
    assert.equal(turnCompleted.params.turn.id, turnId)
    assert.equal(turnCompleted.params.turn.status, 'completed')

    const next = await runCompactionTestTurn(reader, proc, 4, threadId, 'rewind check')
    const resumed = next.seen
      .filter((message) => message.method === 'item/agentMessage/delta')
      .map((message) => message.params.delta)
      .join('')
    assert.equal(resumed, `resumed mock-${threadId} at end after 0 resets`)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude compacting on its own within a turn shows as a contextCompaction item', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    const { turnId, seen } = await runCompactionTestTurn(
      reader,
      proc,
      2,
      threadId,
      'auto compaction check',
    )
    const index = (predicate: (message: any) => boolean): number => seen.findIndex(predicate)
    const firstMessageDone = index(
      (message) =>
        message.method === 'item/completed' &&
        message.params.item.type === 'agentMessage' &&
        message.params.item.text === 'Reading the files.',
    )
    const compactionStarted = index(
      (message) =>
        message.method === 'item/started' && message.params.item.type === 'contextCompaction',
    )
    const compactionDone = index(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'contextCompaction',
    )
    const compacted = index((message) => message.method === 'thread/compacted')
    const laterMessage = index(
      (message) =>
        message.method === 'item/agentMessage/delta' &&
        message.params.delta === 'Done after compacting.',
    )
    // What Claude said before compacting stays above the compaction.
    assert.ok(firstMessageDone >= 0)
    assert.ok(firstMessageDone < compactionStarted)
    assert.ok(compactionStarted < compactionDone)
    assert.ok(compactionDone < laterMessage)
    assert.deepEqual(seen[compacted].params, { threadId, turnId })
    assert.equal(seen[compactionDone].params.item.id, seen[compactionStarted].params.item.id)
    assert.equal(compactionItemEvents(seen, 'item/started').length, 1)
    // The meter drops to the compacted context right away, and the turn's
    // result does not fill it back up with the whole turn's sum.
    const usage = seen.filter((message) => message.method === 'thread/tokenUsage/updated')
    assert.equal(usage[0].params.tokenUsage.last.totalTokens, 20_000)
    assert.equal(usage.at(-1).params.tokenUsage.last.totalTokens, 20_000)
    assert.equal(usage.at(-1).params.tokenUsage.modelContextWindow, 200_000)
    assert.equal(usage.at(-1).params.tokenUsage.total.totalTokens, 550)
    assert.equal(seen.at(-1).params.turn.status, 'completed')

    proc.stdin.write(
      json({ id: 3, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    const items = await reader.nextResponse(3)
    assert.deepEqual(
      items.result.data.map((item: any) => item.type),
      ['userMessage', 'agentMessage', 'contextCompaction', 'agentMessage'],
    )

    // A boundary that comes without the status before it starts and ends
    // the item at once.
    const boundaryOnly = await runCompactionTestTurn(
      reader,
      proc,
      4,
      threadId,
      'auto compaction check, boundary only',
    )
    const started = compactionItemEvents(boundaryOnly.seen, 'item/started')
    const completed = compactionItemEvents(boundaryOnly.seen, 'item/completed')
    assert.equal(started.length, 1)
    assert.equal(completed.length, 1)
    assert.equal(completed[0].params.item.id, started[0].params.item.id)
    assert.ok(boundaryOnly.seen.some((message) => message.method === 'thread/compacted'))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a compaction an interrupt cuts short stays open, like Codex shows it interrupted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('auto compaction check, stalls') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    const seen: any[] = []
    await awaitMessage(
      reader,
      (message) =>
        message.method === 'item/started' && message.params.item.type === 'contextCompaction',
      seen,
    )
    proc.stdin.write(json({ id: 3, method: 'turn/interrupt', params: { threadId, turnId } }))
    const done = await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.equal(done.params.turn.status, 'interrupted')
    seen.push(...(await readQuiet(reader, 300)))
    assert.equal(compactionItemEvents(seen, 'item/completed').length, 0)
    assert.equal(
      seen.some((message) => message.method === 'thread/compacted'),
      false,
    )
    // The message before it is still completed.
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'item/completed' && message.params.item.type === 'agentMessage',
      ),
    )

    // The same for a compaction the user started.
    await runCompactionTestTurn(reader, proc, 4, threadId, 'next compaction holds')
    const compaction = await compactTestThread(
      reader,
      proc,
      5,
      threadId,
      (message) =>
        message.method === 'item/started' && message.params.item.type === 'contextCompaction',
    )
    proc.stdin.write(
      json({ id: 6, method: 'turn/interrupt', params: { threadId, turnId: compaction.turnId } }),
    )
    const interrupted = await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed',
      compaction.seen,
    )
    assert.equal(interrupted.params.turn.status, 'interrupted')
    compaction.seen.push(...(await readQuiet(reader, 300)))
    assert.equal(compactionItemEvents(compaction.seen, 'item/completed').length, 0)
    assert.equal(
      compaction.seen.some(
        (message) =>
          message.method === 'thread/compacted' ||
          (message.method === 'item/started' && message.params.item.type === 'agentMessage'),
      ),
      false,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn/steer reaches a turn Claude compacted on its own, not a compaction or review turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('auto compaction check, then hold') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    const seen: any[] = []
    await awaitMessage(
      reader,
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'contextCompaction',
      seen,
    )
    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: turnId, input: textInput('release') },
      }),
    )
    const steer = await awaitMessage(reader, (message) => message.id === 3, seen)
    assert.equal(steer.error, undefined)
    assert.equal(steer.result.turnId, turnId)
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'item/agentMessage/delta' &&
          message.params.delta === 'Released after compacting.',
      ),
    )

    // A compaction the user started takes no steering, like Codex's.
    await runCompactionTestTurn(reader, proc, 4, threadId, 'next compaction holds')
    const compaction = await compactTestThread(
      reader,
      proc,
      5,
      threadId,
      (message) =>
        message.method === 'item/started' && message.params.item.type === 'contextCompaction',
    )
    proc.stdin.write(
      json({
        id: 6,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: compaction.turnId, input: textInput('more') },
      }),
    )
    const rejected = await reader.nextResponse(6)
    // Codex's invalid-request code, which the App matches with the turn kind.
    assert.equal(rejected.error.code, -32600)
    assert.equal(rejected.error.message, 'cannot steer a compact turn')
    assert.deepEqual(rejected.error.data, {
      message: 'cannot steer a compact turn',
      codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } },
      additionalDetails: null,
      misalignment: null,
    })
    proc.stdin.write(
      json({ id: 7, method: 'turn/interrupt', params: { threadId, turnId: compaction.turnId } }),
    )
    await awaitMessage(reader, (message) => message.method === 'turn/completed')
    await readQuiet(reader, 200)

    // Nor does a review.
    proc.stdin.write(
      json({
        id: 8,
        method: 'review/start',
        params: {
          threadId,
          delivery: 'inline',
          target: { type: 'custom', instructions: 'hold this turn until released' },
        },
      }),
    )
    // The review holds until it is released or interrupted.
    const review = await reader.nextResponse(8)
    proc.stdin.write(
      json({
        id: 9,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: review.result.turn.id, input: textInput('release') },
      }),
    )
    const reviewSteer = await reader.nextResponse(9)
    assert.equal(reviewSteer.error.code, -32600)
    assert.equal(reviewSteer.error.message, 'cannot steer a review turn')
    assert.equal(reviewSteer.error.data.codexErrorInfo.activeTurnNotSteerable.turnKind, 'review')
    proc.stdin.write(
      json({
        id: 10,
        method: 'turn/interrupt',
        params: { threadId, turnId: review.result.turn.id },
      }),
    )
    await awaitMessage(reader, (message) => message.method === 'turn/completed')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('localImage user input becomes a multimodal Claude prompt + an imageView ThreadItem', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Tiny 1x1 PNG to avoid pulling a real image binary.
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  )
  const imgPath = join(home, 'pixel.png')
  const fs = await import('node:fs/promises')
  await fs.writeFile(imgPath, png1x1)

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: 'image input check', text_elements: [] },
            { type: 'localImage', path: imgPath },
          ],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    let imageView: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'imageView')
        imageView = message.params.item
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    // imageView is surfaced live via the item/* event stream (the turn envelope
    // itself stays empty/notLoaded, matching the real app-server).
    assert.ok(imageView, 'turn should emit an imageView item for the user-uploaded image')
    assert.equal(imageView.path, imgPath)
    // Mock echoes the parsed image inputs; assert kind=base64 + media type +
    // a non-trivial payload landed in the runtime context.
    assert.match(
      text,
      /^images=base64:image\/png:\d+/,
      'runtime should receive base64 image input — got: ' + text,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude WebSearch maps to a Codex webSearch item that stays a search', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'web search check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let webSearchItem: any = null
    let completedWebSearch: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'webSearch')
        webSearchItem = message.params.item
      if (
        message.method === 'item/completed' &&
        webSearchItem &&
        message.params.item.id === webSearchItem.id
      )
        completedWebSearch = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.ok(webSearchItem, 'WebSearch tool_use should emit a native webSearch ThreadItem')
    assert.equal(webSearchItem.query, 'mock query')
    // Protocol-correct action shape: 'search' variant has required query/queries
    // (Option<...> with no serde default) — bare {type:'search'} would crash App.
    assert.deepEqual(webSearchItem.action, { type: 'search', query: 'mock query', queries: null })
    assert.ok(completedWebSearch, 'webSearch item should complete')
    // Its results hold links, but the search opened no page.
    assert.deepEqual(completedWebSearch.action, {
      type: 'search',
      query: 'mock query',
      queries: null,
    })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('collaborationMode/list offers the Plan and Default presets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'collaborationMode/list', params: {} }))
    const listed = await reader.nextResponse(1)
    assert.deepEqual(listed.result, {
      data: [
        { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null },
        { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
      ],
    })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Plan mode: the thread keeps the mode and ExitPlanMode becomes one plan card', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  let id = 0
  let threadId = ''
  const mode = (name: 'plan' | 'default') => ({
    mode: name,
    settings: { model: '', reasoning_effort: null, developer_instructions: null },
  })
  // Runs one turn and sorts what it streamed.
  const runTurn = async (params: Record<string, unknown>) => {
    const requestId = ++id
    proc.stdin.write(
      json({
        id: requestId,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'plan mode check', text_elements: [] }],
          ...params,
        },
      }),
    )
    await reader.nextResponse(requestId)
    const seen = {
      text: '',
      planDelta: '',
      planStarted: [] as any[],
      planCompleted: [] as any[],
      tools: [] as any[],
      planUpdated: false,
      status: '',
    }
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') seen.text += message.params.delta
      if (message.method === 'item/plan/delta') seen.planDelta += message.params.delta
      if (message.method === 'turn/plan/updated') seen.planUpdated = true
      if (message.method === 'item/started') {
        const item = message.params.item
        if (item.type === 'plan') seen.planStarted.push(item)
        else if (item.type !== 'agentMessage' && item.type !== 'userMessage') seen.tools.push(item)
      }
      if (message.method === 'item/completed' && message.params.item.type === 'plan')
        seen.planCompleted.push(message.params.item)
      if (message.method === 'turn/completed') {
        seen.status = message.params.turn.status
        break
      }
    }
    return seen
  }
  try {
    proc.stdin.write(json({ id: ++id, method: 'thread/start', params: { cwd: process.cwd() } }))
    threadId = (await reader.nextResponse(id)).result.thread.id
    const plan = '# Mock plan\n\n1. Inspect the code\n2. Make the change'

    // The App's Plan toggle: the mode rides in collaborationMode, with the
    // top-level model and effort null.
    const planned = await runTurn({ model: null, effort: null, collaborationMode: mode('plan') })
    assert.equal(planned.status, 'completed', 'the App offers to implement only completed turns')
    assert.equal(planned.text, 'planMode=truePlan ready.', 'prose around the plan stays prose')
    assert.equal(planned.planStarted.length, 1, 'exactly one plan card')
    assert.equal(planned.planStarted[0].text, '')
    assert.equal(planned.planDelta, plan)
    assert.equal(planned.planCompleted.length, 1)
    assert.equal(planned.planCompleted[0].text, plan)
    assert.deepEqual(planned.tools, [], 'ExitPlanMode is the card, not a tool item')
    assert.equal(planned.planUpdated, false, 'turn/plan/updated is for the TodoWrite checklist')

    // The plan item is part of the turn's history.
    proc.stdin.write(
      json({ id: ++id, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(id)
    const items = read.result.thread.turns.at(-1).items
    assert.deepEqual(
      items.filter((item: any) => item.type === 'plan').map((item: any) => item.text),
      [plan],
    )

    // A turn that names no mode keeps the thread's.
    const kept = await runTurn({})
    assert.equal(kept.planStarted.length, 1)
    assert.match(kept.text, /^planMode=true/)

    // Implementing the plan switches back to Default, which sticks too.
    const implemented = await runTurn({ collaborationMode: mode('default') })
    assert.equal(implemented.text, 'planMode=false')
    assert.equal(implemented.planStarted.length, 0)
    assert.equal((await runTurn({})).text, 'planMode=false')

    // The legacy planMode flag still plans a single turn.
    const legacy = await runTurn({ planMode: true })
    assert.equal(legacy.planStarted.length, 1)
    assert.match(legacy.text, /^planMode=true/)
    assert.equal((await runTurn({})).text, 'planMode=false')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn/start takes the model and effort a collaborationMode carries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: null,
          effort: null,
          collaborationMode: {
            mode: 'default',
            settings: { model: 'haiku', reasoning_effort: 'low', developer_instructions: null },
          },
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=haiku effort=low')
    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resumed = await reader.nextResponse(3)
    assert.equal(resumed.result.model, 'haiku')
    assert.equal(resumed.result.reasoningEffort, 'low')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('TodoWrite maps to a Codex v2 turn/plan/updated notification, not a timeline item', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'update the todo list', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let planUpdate: any = null
    let sawTodoItem = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/plan/updated') planUpdate = message.params
      if (
        (message.method === 'item/started' || message.method === 'item/completed') &&
        /todo/i.test(message.params.item?.tool ?? '')
      )
        sawTodoItem = true
      if (message.method === 'turn/completed') break
    }
    assert.ok(planUpdate, 'expected a turn/plan/updated notification')
    // Codex v2 TurnPlanUpdatedNotification = { threadId, turnId, explanation, plan }.
    assert.equal(planUpdate.threadId, threadId)
    assert.equal(planUpdate.explanation, null)
    assert.deepEqual(planUpdate.plan, [
      { step: 'Investigate', status: 'completed' },
      { step: 'Implement', status: 'inProgress' },
      { step: 'Verify', status: 'pending' },
    ])
    // The checklist tool itself is not surfaced as a separate timeline item.
    assert.equal(sawTodoItem, false, 'TodoWrite must not produce a timeline tool item')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex App approvalPolicy=never + sandbox=danger-full-access auto-accepts tool calls', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    // Envelope reflects the App's chosen policy/sandbox instead of the previous hardcoded `on-request` + workspaceWrite.
    assert.equal(start.result.approvalPolicy, 'never')
    assert.equal((start.result.sandbox as any).type, 'dangerFullAccess')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let sawApprovalRequest = false
    let sawCommandOutput = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/commandExecution/requestApproval') sawApprovalRequest = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawCommandOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(
      sawApprovalRequest,
      false,
      'expected no requestApproval round-trip when approvalPolicy=never',
    )
    assert.equal(sawCommandOutput, true, 'tool should still execute and stream output')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude Code tools Codex has no item for complete as mcpToolCall items', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please use generic tool', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let completedTool: any = null
    let sawIdle = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/status/changed' && message.params.status.type === 'idle')
        sawIdle = true
      if (message.method === 'item/completed' && message.params.item.type === 'mcpToolCall')
        completedTool = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.equal(completedTool?.server, 'claude-code')
    assert.equal(completedTool?.tool, 'ListMcpResourcesTool')
    assert.equal(completedTool?.status, 'completed')
    // Result must be wrapped in Codex v2 McpToolCallResult shape — {content[], structuredContent, _meta}.
    // The mock runtime returns {text:'mock tool result'} as the raw content, which we wrap as:
    //   content: [{type:'text', text:'<json>'}], structuredContent: <object>, _meta: null.
    assert.deepEqual(completedTool?.result, {
      content: [{ type: 'text', text: JSON.stringify({ text: 'mock tool result' }) }],
      structuredContent: { text: 'mock tool result' },
      _meta: null,
    })
    assert.equal(sawIdle, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

const replayedItems = (seen: any[]): any[] =>
  seen.find((message) => message.id === 3)?.result.thread.turns.at(-1).items ?? []

test('file exploration shows as commands the Codex App groups under Explored', async () => {
  const seen = await mockTurnMessages('explore tools check')
  const cwd = process.cwd()
  const commands = completedItems(seen).filter((item) => item.type === 'commandExecution')
  assert.deepEqual(
    commands.map(({ command, cwd, processId, status, commandActions }) => ({
      command,
      cwd,
      processId,
      status,
      commandActions,
    })),
    [
      {
        command: 'Read README.md',
        commandActions: [
          {
            type: 'read',
            command: 'Read README.md',
            name: 'README.md',
            path: join(cwd, 'README.md'),
          },
        ],
      },
      {
        command: 'Grep TODO in src',
        commandActions: [
          { type: 'search', command: 'Grep TODO in src', query: 'TODO', path: 'src' },
        ],
      },
      {
        command: 'Glob **/*.mts',
        commandActions: [
          { type: 'search', command: 'Glob **/*.mts', query: '**/*.mts', path: null },
        ],
      },
      {
        command: 'cat README.md',
        commandActions: [
          {
            type: 'read',
            command: 'cat README.md',
            name: 'README.md',
            path: join(cwd, 'README.md'),
          },
        ],
      },
      {
        // The card shows the search; `head` only trims its output.
        command: 'rg -n TODO src | head -n 5',
        commandActions: [{ type: 'search', command: 'rg -n TODO src', query: 'TODO', path: 'src' }],
      },
    ].map((expected, index) => ({
      command: expected.command,
      cwd,
      processId: `claude:explore-${index}`,
      status: 'completed',
      commandActions: expected.commandActions,
    })),
  )
  assert.equal(
    completedItems(seen).some((item) => item.type === 'mcpToolCall'),
    false,
  )
  // A whole file stays with Claude; the App keeps the first 30,000 characters.
  const capped = `${'x'.repeat(30_000)}\n… 10000 more characters not shown`
  assert.equal(commands[0].aggregatedOutput, capped)
  assert.deepEqual(
    seen
      .filter(
        (message) =>
          message.method === 'item/commandExecution/outputDelta' &&
          message.params.itemId === commands[0].id,
      )
      .map((message) => message.params.delta),
    [capped],
  )
  assert.deepEqual(
    replayedItems(seen).filter((item: any) => item.type === 'commandExecution'),
    commands,
  )
})

test('an image Claude reads shows as an imageView, and a failed one as its Read', async () => {
  const seen = await mockTurnMessages('image read check')
  const cwd = process.cwd()
  const started = seen
    .filter((message) => message.method === 'item/started')
    .map((message) => message.params.item)
    .filter((item) => item.type !== 'userMessage')
  assert.deepEqual(
    started.map(({ type, path }) => ({ type, path })),
    [
      { type: 'imageView', path: join(cwd, 'diagram.png') },
      { type: 'imageView', path: join(cwd, 'missing.png') },
    ],
  )
  const [shown, missing] = started
  const completed = completedItems(seen)
  assert.deepEqual(
    completed.find((item) => item.id === shown.id),
    { type: 'imageView', id: shown.id, path: join(cwd, 'diagram.png') },
  )
  const failed = completed.find((item) => item.id === missing.id)
  assert.deepEqual(
    {
      type: failed.type,
      command: failed.command,
      status: failed.status,
      aggregatedOutput: failed.aggregatedOutput,
      exitCode: failed.exitCode,
      commandActions: failed.commandActions,
    },
    {
      type: 'commandExecution',
      command: 'Read missing.png',
      status: 'failed',
      aggregatedOutput: 'File does not exist.',
      exitCode: 1,
      commandActions: [
        {
          type: 'read',
          command: 'Read missing.png',
          name: 'missing.png',
          path: join(cwd, 'missing.png'),
        },
      ],
    },
  )
  // The output of an item that was an image comes with the completed item.
  assert.equal(
    seen.some((message) => message.method === 'item/commandExecution/outputDelta'),
    false,
  )
  assert.deepEqual(
    replayedItems(seen).filter((item: any) => item.type !== 'userMessage'),
    [completed.find((item) => item.id === shown.id), failed],
  )
})

test('Claude WebFetch shows as a Codex page open', async () => {
  const seen = await mockTurnMessages('web fetch check')
  const fetched = completedItems(seen).find((item) => item.type === 'webSearch')
  assert.deepEqual(fetched, {
    type: 'webSearch',
    id: fetched?.id,
    query: 'https://example.com/docs',
    action: { type: 'openPage', url: 'https://example.com/docs' },
  })
})

test('MCP tool calls name their server and tool, even a server named with __', async () => {
  const seen = await mockTurnMessages('mcp tool check', {
    CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
      team__docs: { command: 'node', args: ['docs-server.mjs'] },
    }),
  })
  assert.deepEqual(
    completedItems(seen)
      .filter((item) => item.type === 'mcpToolCall')
      .map(({ server, tool, arguments: args, status }) => ({ server, tool, args, status })),
    [
      { server: 'github', tool: 'create_issue', args: { title: 'Bug' }, status: 'completed' },
      { server: 'team__docs', tool: 'search', args: { query: 'setup' }, status: 'completed' },
    ],
  )
})

test('AskUserQuestion is bridged to Codex item/tool/requestUserInput', async () => {
  // Bug repro: Claude's AskUserQuestion tool calls weren't surfaced in the
  // App UI — they fell through as generic mcpToolCall items with no choice
  // card. We bridge them to Codex's native request_user_input reverse RPC
  // so the App pops its structured picker, then route the user's answer
  // back to the model.
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'ask user question check', text_elements: [] }],
        },
      }),
    )
    const started = await reader.nextResponse(2)
    const turnId = started.result.turn.id

    // Wait for the server's reverse-RPC asking us to answer. Real Codex
    // protocol: request id is numeric/server-side, params carry the
    // structured questions.
    let askRequest: any | null = null
    while (askRequest == null) {
      const message = await reader.next()
      if (message.method === 'item/tool/requestUserInput') {
        askRequest = message
      }
    }
    assert.equal(askRequest.params.threadId, threadId)
    assert.equal(askRequest.params.turnId, turnId)
    assert.equal(Array.isArray(askRequest.params.questions), true)
    assert.equal(askRequest.params.questions[0].header, 'Auth')
    assert.equal(askRequest.params.questions[0].question, 'Which auth method do you want?')
    // The bridge auto-appends an "Other" option so the App's free-text
    // affordance lights up even when Claude didn't model one explicitly.
    assert.equal(
      askRequest.params.questions[0].options.some((o: any) => o.label === 'Other'),
      true,
    )

    // Answer as the App would.
    proc.stdin.write(
      json({
        jsonrpc: '2.0',
        id: askRequest.id,
        result: { answers: { q0: { answers: ['OAuth'] } } },
      }),
    )

    let completed = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') {
        completed = true
        break
      }
    }
    assert.equal(completed, true)

    proc.stdin.write(
      json({ id: 4, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    const items = await reader.nextResponse(4)
    const itemsList = items.result.data as Array<any>
    const dynamic = itemsList.find((item) => item.type === 'dynamicToolCall')
    assert.ok(dynamic, 'expected a dynamicToolCall item in the turn')
    assert.equal(dynamic.tool, 'AskUserQuestion')
    assert.equal(dynamic.status, 'completed')
    assert.equal(dynamic.success, true)
    assert.equal(Array.isArray(dynamic.contentItems), true)
    assert.match(dynamic.contentItems[0].text, /OAuth/)
    // No stray mcpToolCall for AskUserQuestion (otherwise the App would
    // draw a duplicate generic card alongside the choice picker).
    assert.equal(
      itemsList.some((item) => item.type === 'mcpToolCall' && item.tool === 'AskUserQuestion'),
      false,
    )
    // The chosen answer also reached the mock through onUserInputRequest's
    // return value (and got echoed back as the final agent message text).
    const agent = itemsList.find((item) => item.type === 'agentMessage')
    assert.ok(
      agent && /picked=OAuth/.test(agent.text),
      'expected the agent message to echo the picked answer',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('file change approval emits patch and git diff updates', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: repo,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          permissions: ':workspace',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please edit file', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let approvalRequest: any = null
    let sawPatch = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/fileChange/patchUpdated') sawPatch = true
      if (message.method === 'item/fileChange/requestApproval') {
        approvalRequest = message
        break
      }
    }
    assert.equal(sawPatch, true)
    assert.equal(approvalRequest?.params.threadId, threadId)
    proc.stdin.write(json({ id: approvalRequest.id, result: { decision: 'accept' } }))

    let diff = ''
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/diff/updated') diff = message.params.diff
      if (message.method === 'turn/completed') break
    }
    assert.match(diff, /README.md/)
    assert.match(diff, /changed by mock runtime/)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Runs a `live patch check` turn, accepting its file change, and returns what
// the App saw: every notification, and the changes of the item the approval
// was asked for as they stood when it was asked.
async function runLivePatchTurn(prompt: string): Promise<{
  home: string
  threadId: string
  messages: any[]
  approved: { itemId: string; changes: unknown } | null
  stored: any[]
}> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: home, permissions: ':workspace' } }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] },
      }),
    )
    const messages: any[] = []
    const changes = new Map<string, unknown>()
    let approved: { itemId: string; changes: unknown } | null = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      messages.push(message)
      if (message.method === 'item/started' && message.params.item.type === 'fileChange')
        changes.set(message.params.item.id, message.params.item.changes)
      if (message.method === 'item/fileChange/patchUpdated')
        changes.set(message.params.itemId, message.params.changes)
      if (message.method === 'item/fileChange/requestApproval') {
        approved = { itemId: message.params.itemId, changes: changes.get(message.params.itemId) }
        proc.stdin.write(json({ id: message.id, result: { decision: 'accept' } }))
      }
      // A subagent's turn completes in its own thread.
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(3)
    return { home, threadId, messages, approved, stored: read.result.thread.turns.at(-1).items }
  } finally {
    await stopProcess(proc)
  }
}

function fileChangeItems(messages: any[], method: string): any[] {
  return messages
    .filter((message) => message.method === method && message.params.item?.type === 'fileChange')
    .map((message) => message.params.item)
}

for (const variant of ['', 'approval first']) {
  test(`a file change shows while Claude writes it${variant ? ` (${variant})` : ''}`, async () => {
    const { home, messages, approved, stored } = await runLivePatchTurn(
      `live patch check ${variant}`,
    )
    try {
      const path = join(home, 'live.txt')
      const final = fileChangeFromTool('Write', { file_path: path, content: 'one\ntwo\nthree\n' })
      const started = fileChangeItems(messages, 'item/started')
      assert.equal(started.length, 1, 'one card, not a second one for the finished call')
      const [item] = started
      // The card opens with the file and nothing written yet.
      assert.deepEqual(item.changes, fileChangeFromTool('Write', { file_path: path }))
      assert.equal(item.status, 'inProgress')
      // The commentary before the call is complete by then.
      const agentDone = messages.findIndex(
        (message) =>
          message.method === 'item/completed' && message.params.item.type === 'agentMessage',
      )
      const cardStart = messages.findIndex(
        (message) => message.method === 'item/started' && message.params.item.id === item.id,
      )
      assert.ok(agentDone >= 0 && agentDone < cardStart)
      const patches = messages
        .filter((message) => message.method === 'item/fileChange/patchUpdated')
        .map((message) => {
          assert.equal(message.params.itemId, item.id)
          return message.params.changes
        })
      assert.deepEqual(patches, [
        fileChangeFromTool('Write', { file_path: path }),
        fileChangeFromTool('Write', { file_path: path, content: 'one\ntw' }),
        final,
      ])
      // The approval, the completed card and history hold the finished call.
      assert.deepEqual(approved, { itemId: item.id, changes: final })
      const completed = fileChangeItems(messages, 'item/completed')
      assert.equal(completed.length, 1)
      assert.equal(completed[0].id, item.id)
      assert.equal(completed[0].status, 'completed')
      assert.deepEqual(completed[0].changes, final)
      const kept = stored.filter((entry) => entry.type === 'fileChange')
      assert.deepEqual(
        kept.map((entry) => [entry.id, entry.status, entry.changes]),
        [[item.id, 'completed', final]],
      )
      assert.equal(await readFile(path, 'utf8'), 'one\ntwo\nthree\n')
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  })
}

test('a file change Claude never finished fails when the next response starts', async () => {
  const { home, messages, stored } = await runLivePatchTurn('live patch check abandoned')
  try {
    const started = fileChangeItems(messages, 'item/started')
    const completed = fileChangeItems(messages, 'item/completed')
    assert.equal(started.length, 2)
    const [lost, live] = started
    assert.deepEqual(
      completed.map((entry) => [entry.id, entry.status]),
      [
        [lost.id, 'failed'],
        [live.id, 'completed'],
      ],
    )
    // The lost card failed before the next one opened.
    const lostDone = messages.findIndex(
      (message) => message.method === 'item/completed' && message.params.item.id === lost.id,
    )
    const liveStart = messages.findIndex(
      (message) => message.method === 'item/started' && message.params.item.id === live.id,
    )
    assert.ok(lostDone >= 0 && lostDone < liveStart)
    assert.deepEqual(
      stored.filter((entry) => entry.type === 'fileChange').map((entry) => entry.status),
      ['failed', 'completed'],
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test("a subagent's streamed file change stays out of the parent's timeline", async () => {
  const { home, messages } = await runLivePatchTurn('live patch check nested')
  try {
    const started = fileChangeItems(messages, 'item/started')
    assert.deepEqual(
      started.map((item) => item.changes[0].path),
      [join(home, 'live.txt')],
    )
    assert.equal(
      messages.some((message) => JSON.stringify(message).includes('nested.txt')),
      false,
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('gitDiffToRemote includes untracked files for Codex diff review', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )
  await writeFile(join(repo, 'new-file.txt'), 'new content\n')

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'gitDiffToRemote', params: { cwd: repo } }))
    const response = await reader.nextResponse(1)
    assert.match(response.result.diff, /new-file\.txt/)
    assert.match(response.result.diff, /\+new content/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
