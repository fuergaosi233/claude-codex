import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import {
  SLEEP_NOTICE_MIN_MS,
  type SleepClock,
  SleepTracker,
  sleepDuration,
  sleepNotice,
  withSleepNotice,
} from '../src/sleep-notice.mjs'
import type { RuntimeHandlers } from '../src/types.mjs'
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
  // Sleep does not explain a refusal of the request itself, or an API too
  // busy to take it.
  for (const code of [
    'usageLimitExceeded',
    'contextWindowExceeded',
    'unauthorized',
    'serverOverloaded',
  ] as const) {
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
  let sleepInTurn = 0
  const runtime = scriptedRuntime(async (_context, handlers) => {
    slept += sleepInTurn
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

      sleepInTurn = 25 * MINUTE
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

test('only a sleep since the turn last made progress explains its failure', async () => {
  let slept = 0
  const failed = {
    type: 'completed',
    success: false,
    result: 'API Error: Connection error.',
    failure: { terminalReason: 'api_error', category: null, status: null },
  } as const
  // What a turn whose connection broke hears before it fails: retries (its
  // own, and a subagent's), notices, a compaction that failed, the message
  // naming the error, a StopFailure hook, and the usage and figures of the
  // result that ends it.
  const brokenOff = async (handlers: RuntimeHandlers): Promise<void> => {
    for (const attempt of [1, 2])
      await handlers.onEvent({
        type: 'retrying',
        attempt,
        maxRetries: 10,
        status: null,
        category: 'unknown',
        delayMs: 1000,
      })
    await handlers.onEvent({ type: 'subagent_progress', toolUseId: 'agent', idle: true })
    await handlers.onEvent({ type: 'notice', level: 'warning', message: 'Still reconnecting.' })
    await handlers.onEvent({
      type: 'compaction_failed',
      message: 'Claude could not compact the conversation: Connection error.',
    })
    await handlers.onEvent({
      type: 'model_rerouted',
      fromModel: 'claude-a',
      toModel: 'claude-b',
      category: null,
      message: 'Claude switched from claude-a to claude-b after a refusal.',
    })
    await handlers.onEvent({ type: 'message_boundary', failedRequest: true })
    await handlers.onEvent({
      type: 'usage_progress',
      messageId: 'msg_error',
      usage: { input_tokens: 0, output_tokens: 0 },
      failedRequest: true,
    })
    await handlers.onEvent({
      type: 'text_delta',
      delta: 'API Error: Connection error.',
      failedRequest: true,
    })
    for (const status of ['running', 'completed'] as const)
      await handlers.onEvent({
        type: 'hook_run',
        hookId: 'hook-1',
        hookEvent: 'StopFailure',
        status,
        entries: [],
      })
    await handlers.onEvent({ type: 'usage', usage: { input_tokens: 0, output_tokens: 0 } })
    await handlers.onEvent({
      type: 'metrics',
      durationMs: 1,
      apiDurationMs: 0,
      numTurns: 1,
      costUsd: 0,
    })
    await handlers.onEvent(failed)
  }
  const runtime = scriptedRuntime(async (context, handlers) => {
    const prompt = context.prompt ?? ''
    if (/slept, then went on/.test(prompt)) {
      // Asleep long before the failure; Claude went on after waking.
      slept += 2 * 60 * MINUTE
      await handlers.onEvent({ type: 'text_delta', delta: 'Back at it.' })
      await handlers.onEvent({ type: 'message_boundary' })
      await brokenOff(handlers)
    } else if (/went on, then slept/.test(prompt)) {
      await handlers.onEvent({ type: 'text_delta', delta: 'Working.' })
      await handlers.onEvent({ type: 'message_boundary' })
      slept += 25 * MINUTE
      await brokenOff(handlers)
    } else if (/slept twice/.test(prompt)) {
      slept += 2 * 60 * MINUTE
      await handlers.onEvent({ type: 'text_delta', delta: 'Back at it.' })
      slept += 14 * MINUTE
      await brokenOff(handlers)
    } else {
      await handlers.onEvent(failed)
    }
  })
  await withInProcessApp(
    runtime,
    async (app) => {
      const threadId = await app.startThread()
      const awake = await app.turnCompleted(await app.startTurn(threadId, 'awake'))
      assert.equal(awake.status, 'failed')
      assert.doesNotMatch(awake.error.message, /slept/)

      const earlier = await app.turnCompleted(await app.startTurn(threadId, 'slept, then went on'))
      assert.equal(earlier.status, 'failed')
      assert.equal(earlier.error.message, awake.error.message)

      const late = await app.turnCompleted(await app.startTurn(threadId, 'went on, then slept'))
      assert.equal(late.error.message, withSleepNotice(awake.error, 25 * MINUTE, 'linux').message)

      // Only the sleep since Claude last went on counts.
      const twice = await app.turnCompleted(await app.startTurn(threadId, 'slept twice'))
      assert.equal(twice.error.message, withSleepNotice(awake.error, 14 * MINUTE, 'linux').message)
    },
    {
      server: {
        sleepMonitor: { suspendedMs: () => slept, sleptSince: () => slept },
        platform: 'linux',
      },
    },
  )
})

// What Claude Code sends when a model request fails for good: its retries,
// then a message of its own naming the error (a made-up id, model
// <synthetic>, no usage), a StopFailure hook, and an error result.
function failedRequestFrames(sessionId: string): Record<string, unknown>[] {
  const noUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const retry = (attempt: number) => ({
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 10,
    retry_delay_ms: 1000,
    error_status: null,
    error: 'unknown',
    session_id: sessionId,
  })
  const hook = (subtype: string, extra: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype,
    hook_id: 'hook-1',
    hook_name: 'StopFailure',
    hook_event: 'StopFailure',
    session_id: sessionId,
    ...extra,
  })
  return [
    retry(1),
    retry(2),
    {
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: `${sessionId}-error`,
      error: 'unknown',
      message: {
        id: `${sessionId}-synthetic`,
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'API Error: Connection error.' }],
        usage: noUsage,
      },
    },
    hook('hook_started'),
    hook('hook_response', { outcome: 'success', exit_code: 0, stdout: '', stderr: '' }),
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'API Error: Connection error.',
      terminal_reason: 'api_error',
      session_id: sessionId,
      usage: noUsage,
    },
  ]
}

const textBlock = (text: string) => ({ type: 'text', text })

// The main loop's call of an agent (or an agent's call of one nested in it),
// with the task Claude Code starts for it, and a frame of that agent's.
function agentCall(
  sessionId: string,
  call = 'agent-1',
  parent: string | null = null,
): Record<string, unknown>[] {
  return [
    {
      type: 'assistant',
      parent_tool_use_id: parent,
      session_id: sessionId,
      uuid: `${sessionId}-${call}`,
      message: {
        id: `msg_${call}`,
        model: 'claude-test',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: call, name: 'Agent', input: { prompt: 'check the build' } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'system',
      subtype: 'task_started',
      task_id: `task-${call}`,
      tool_use_id: call,
      task_type: 'local_agent',
      description: 'check the build',
      session_id: sessionId,
    },
  ]
}

function agentFrame(frame: Record<string, unknown>, call = 'agent-1'): Record<string, unknown> {
  return { parent_tool_use_id: call, agent_id: `task-${call}`, ...frame }
}

// What Claude Code sends once an agent's request failed for good: its
// retries, the frame that comes after the last one, the failure of its task,
// and the call's error result (to the main loop, or the agent it is nested
// in).
function agentFailedFrames(
  sessionId: string,
  call = 'agent-1',
  parent: string | null = null,
): Record<string, unknown>[] {
  const progress = (extra: Record<string, unknown>) =>
    agentFrame(
      {
        type: 'tool_progress',
        tool_use_id: `agent_msg_${call}`,
        tool_name: 'Agent',
        elapsed_time_seconds: 0,
        subagent_type: 'general-purpose',
        session_id: sessionId,
        ...extra,
      },
      call,
    )
  const retry = (attempt: number) =>
    progress({
      subagent_retry: {
        agent_id: `task-${call}`,
        attempt,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: null,
        error_category: 'unknown',
      },
    })
  return [
    retry(1),
    retry(2),
    progress({}),
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: `task-${call}`,
      patch: { status: 'failed', end_time: 1, error: 'API Error: Connection error.' },
      session_id: sessionId,
    },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: `task-${call}`,
      tool_use_id: call,
      status: 'failed',
      summary: 'check the build',
      output_file: '',
      session_id: sessionId,
    },
    {
      type: 'user',
      parent_tool_use_id: parent,
      session_id: sessionId,
      uuid: `${sessionId}-${call}-result`,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: call,
            is_error: true,
            content: [textBlock('API Error: Connection error.')],
          },
        ],
      },
    },
  ]
}

function reply(sessionId: string, id: string, text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: `${sessionId}-${id}`,
    message: {
      id,
      model: 'claude-test',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }
}

test('a native turn whose request failed for good says the computer slept, unless Claude went on after it', async () => {
  let slept = 0
  // Each turn's Claude Code session: what it sends, and when the computer
  // sleeps (a number of minutes between two frames). Time goes on during a
  // sleep, past the interval between two reports of an agent's progress.
  const sessions: Array<Array<Record<string, unknown> | number>> = []
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      for (const frame of sessions.shift() ?? []) {
        if (typeof frame === 'number') {
          slept += frame * MINUTE
          await delay(300)
        } else yield frame
      }
    },
  })
  const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId })
  try {
    await withInProcessApp(
      scriptedRuntime((context, handlers) => runtime.runTurn(context, handlers)),
      async (app) => {
        const threadId = await app.startThread()
        sessions.push([init('s-awake'), ...failedRequestFrames('s-awake')])
        const awake = await app.turnCompleted(await app.startTurn(threadId, 'awake'))
        assert.equal(awake.status, 'failed')
        assert.equal(awake.error.message, 'API Error: Connection error.')

        sessions.push([
          init('s-late'),
          reply('s-late', 'msg_working', 'Working.'),
          25,
          ...failedRequestFrames('s-late'),
        ])
        const late = await app.turnCompleted(await app.startTurn(threadId, 'went on, then slept'))
        assert.equal(late.status, 'failed')
        assert.equal(
          late.error.message,
          `API Error: Connection error. ${sleepNotice(25 * MINUTE, 'linux')}`,
        )
        assert.deepEqual(late.error.codexErrorInfo, awake.error.codexErrorInfo)

        // Claude answered after waking: the sleep did not break the request.
        sessions.push([
          init('s-early'),
          120,
          reply('s-early', 'msg_back', 'Back at it.'),
          ...failedRequestFrames('s-early'),
        ])
        const early = await app.turnCompleted(await app.startTurn(threadId, 'slept, then went on'))
        assert.equal(early.status, 'failed')
        assert.equal(early.error.message, awake.error.message)

        // The sleep broke a request of an agent the turn waited on: Claude
        // Code's timer ticks on waking, the agent retries and fails, its call
        // ends on the error, and the main loop's next request fails too.
        sessions.push([
          init('s-agent'),
          ...agentCall('s-agent'),
          25,
          {
            type: 'tool_progress',
            tool_use_id: 'agent-1-heartbeat-50',
            tool_name: 'Agent',
            parent_tool_use_id: 'agent-1',
            elapsed_time_seconds: 1530,
            heartbeat: true,
          },
          ...agentFailedFrames('s-agent'),
          ...failedRequestFrames('s-agent'),
        ])
        const agent = await app.turnCompleted(await app.startTurn(threadId, 'an agent slept'))
        assert.equal(agent.status, 'failed')
        assert.equal(
          agent.error.message,
          `API Error: Connection error. A subagent failed. ${sleepNotice(25 * MINUTE, 'linux')}`,
        )

        // The same, two agents deep: the nested agent's error result is
        // handed to the agent it is nested in, whose request then fails too.
        sessions.push([
          init('s-nested'),
          ...agentCall('s-nested'),
          ...agentCall('s-nested', 'agent-2', 'agent-1'),
          25,
          ...agentFailedFrames('s-nested', 'agent-2', 'agent-1'),
          ...agentFailedFrames('s-nested'),
          ...failedRequestFrames('s-nested'),
        ])
        const nested = await app.turnCompleted(await app.startTurn(threadId, 'agents slept'))
        assert.equal(nested.status, 'failed')
        assert.equal(
          nested.error.message,
          `API Error: Connection error. 2 subagents failed. ${sleepNotice(25 * MINUTE, 'linux')}`,
        )

        // An agent that answered after waking went on: a later failure is
        // not the sleep's.
        sessions.push([
          init('s-agent-on'),
          ...agentCall('s-agent-on'),
          25,
          agentFrame({
            type: 'assistant',
            session_id: 's-agent-on',
            message: {
              id: 'sub_work',
              model: 'claude-test',
              content: [
                { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'make' } },
              ],
            },
          }),
          ...agentFailedFrames('s-agent-on'),
          ...failedRequestFrames('s-agent-on'),
        ])
        const agentOn = await app.turnCompleted(await app.startTurn(threadId, 'an agent went on'))
        assert.equal(agentOn.status, 'failed')
        assert.equal(agentOn.error.message, 'API Error: Connection error. A subagent failed.')
      },
      {
        server: {
          sleepMonitor: { suspendedMs: () => slept, sleptSince: () => slept },
          platform: 'linux',
        },
      },
    )
  } finally {
    await runtime.stop()
  }
})
