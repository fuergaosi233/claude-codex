import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type {
  RuntimeBackgroundListener,
  RuntimeEvent,
  RuntimeHandlers,
  RuntimeTurnContext,
} from '../src/types.mjs'

const context: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn',
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
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

// A Claude Code process the test drives by hand: it records the options it
// was started with and what the runtime sends, and yields whatever the test
// pushes until it is closed, aborted or made to fail.
class FakeQuery implements AsyncIterable<Record<string, unknown>> {
  options: Record<string, unknown>
  prompts: Record<string, unknown>[] = []
  closed = false
  private queue: Record<string, unknown>[] = []
  private failure: Error | null = null
  private wake: (() => void) | null = null

  constructor(prompt: AsyncIterable<Record<string, unknown>>, options: Record<string, unknown>) {
    this.options = options
    void (async () => {
      for await (const message of prompt) this.prompts.push(message)
    })()
    const abort = options.abortController as AbortController | undefined
    abort?.signal.addEventListener('abort', () => this.fail(new Error('aborted')))
  }

  push(...messages: Record<string, unknown>[]): void {
    this.queue.push(...messages)
    this.notify()
  }

  fail(error: Error): void {
    this.failure = error
    this.notify()
  }

  async interrupt(): Promise<void> {}

  close(): void {
    this.closed = true
    this.notify()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.failure) throw this.failure
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

function fakeRuntime(): { runtime: NativeClaudeRuntime; queries: FakeQuery[] } {
  const runtime = new NativeClaudeRuntime()
  const queries: FakeQuery[] = []
  Reflect.set(runtime, 'sdk', {
    query: ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<Record<string, unknown>>
      options: Record<string, unknown>
    }) => {
      const query = new FakeQuery(prompt, options)
      queries.push(query)
      return query
    },
  })
  return { runtime, queries }
}

function handlers(events: RuntimeEvent[] = []): RuntimeHandlers {
  return {
    onEvent: async (event) => {
      events.push(event)
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onUserInputRequest: async () => ({ answers: {} }),
  }
}

function turn(name: string, overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    ...context,
    threadId: `thread-${name}`,
    turnId: `turn-${name}`,
    prompt: name,
    ...overrides,
  }
}

async function waitFor<T>(
  probe: () => T,
  label: string,
  timeoutMs = 2_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value as NonNullable<T>
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const GATE_ENV = ['CLAUDE_CODEX_SDK_LAUNCH_GATE', 'CLAUDE_CODEX_SDK_LAUNCH_GATE_TIMEOUT_MS']

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = GATE_ENV.map((name) => [name, process.env[name]] as const)
  for (const name of GATE_ENV) delete process.env[name]
  Object.assign(process.env, env)
  try {
    return await run()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function withGate<T>(run: () => Promise<T>, timeoutMs?: number): Promise<T> {
  return withEnv(
    {
      CLAUDE_CODEX_SDK_LAUNCH_GATE: '1',
      ...(timeoutMs ? { CLAUDE_CODEX_SDK_LAUNCH_GATE_TIMEOUT_MS: String(timeoutMs) } : {}),
    },
    run,
  )
}

const init = { type: 'system', subtype: 'init', session_id: 'session' }
const result = { type: 'result', subtype: 'success', result: 'done' }

function promptText(message: Record<string, unknown> | undefined): unknown {
  return (message?.message as { content?: unknown } | undefined)?.content
}

test('without the launch gate every Claude Code starts at once', async () => {
  // Unset, and switched off explicitly.
  for (const env of [{}, { CLAUDE_CODEX_SDK_LAUNCH_GATE: '0' }]) {
    await withEnv(env, async () => {
      const { runtime, queries } = fakeRuntime()
      const runs = ['a', 'b', 'c'].map((name) => runtime.runTurn(turn(name), handlers()))
      // Each CLI starts as its turn opens, before any of them says anything.
      await waitFor(() => queries.length === 3, 'three launches')
      for (const query of queries) query.push(init, result)
      await Promise.all(runs)
      await runtime.stop()
    })
  }
})

test('the launch gate starts the next Claude Code once the previous one says something', async () => {
  await withGate(async () => {
    const { runtime, queries } = fakeRuntime()
    const events: RuntimeEvent[][] = [[], [], []]
    const runs = ['a', 'b', 'c'].map((name, index) =>
      runtime.runTurn(turn(name), handlers(events[index])),
    )
    const first = await waitFor(() => queries[0], 'first launch')
    await sleep(20)
    assert.equal(queries.length, 1, 'the others wait for the first')

    first.push(init)
    const second = await waitFor(() => queries[1], 'second launch')
    await sleep(20)
    assert.equal(queries.length, 2, 'the third waits for the second')
    // Each CLI gets its own turn's prompt, queued before it started.
    assert.equal(promptText(second.prompts[0]), 'b')

    second.push(init)
    const third = await waitFor(() => queries[2], 'third launch')
    for (const query of [first, second, third]) query.push(result)
    await Promise.all(runs)
    for (const turnEvents of events)
      assert.ok(turnEvents.some((event) => event.type === 'completed'))
    await runtime.stop()
  })
})

test('a SessionStart hook a Claude Code runs does not hold the launch gate', async () => {
  await withGate(async () => {
    const { runtime, queries } = fakeRuntime()
    const hooked = runtime.runTurn(turn('a'), handlers())
    const first = await waitFor(() => queries[0], 'first launch')
    const next = runtime.runTurn(turn('b'), handlers())
    await sleep(20)
    assert.equal(queries.length, 1, 'the second launch waits for the first')
    // The CLI reports the hook as it starts it, before its init: however long
    // the hook runs, the next launch goes ahead well within the timeout.
    const hook = { type: 'system', hook_id: 'hook-1', hook_event: 'SessionStart' }
    first.push({ ...hook, subtype: 'hook_started', hook_name: 'SessionStart:startup' })
    const second = await waitFor(() => queries[1], 'second launch during the hook', 1_000)
    second.push(init, result)
    await next
    first.push(
      { ...hook, subtype: 'hook_response', outcome: 'success', exit_code: 0 },
      init,
      result,
    )
    await hooked
    await runtime.stop()
  }, 60_000)
})

test('the launch gate moves on when a Claude Code says nothing for its timeout', async () => {
  await withGate(async () => {
    const { runtime, queries } = fakeRuntime()
    const silent = runtime.runTurn(turn('a'), handlers())
    const first = await waitFor(() => queries[0], 'first launch')
    const next = runtime.runTurn(turn('b'), handlers())
    await sleep(30)
    assert.equal(queries.length, 1, 'the slot is held until the timeout')
    const second = await waitFor(() => queries[1], 'launch after the timeout')
    second.push(init, result)
    await next
    first.push(init, result)
    await silent
    await runtime.stop()
  }, 200)
})

test('the launch gate moves on when a Claude Code fails before saying anything', async () => {
  await withGate(async () => {
    const { runtime, queries } = fakeRuntime()
    const events: RuntimeEvent[] = []
    const failed = runtime.runTurn(turn('a'), handlers(events)).then(
      () => null,
      (error: Error) => error.message,
    )
    const next = runtime.runTurn(turn('b'), handlers())
    const first = await waitFor(() => queries[0], 'first launch')
    await sleep(20)
    assert.equal(queries.length, 1, 'the second launch waits for the first')
    first.fail(new Error('Claude Code exited with code 1'))
    assert.equal(await failed, 'Claude Code exited with code 1')
    assert.ok(events.some((event) => event.type === 'error'))
    const second = await waitFor(() => queries[1], 'second launch')
    second.push(init, result)
    await next
    await runtime.stop()
  })
})

test('a session interrupted while it waits for the launch gate never starts', async () => {
  await withGate(async () => {
    const { runtime, queries } = fakeRuntime()
    const released: string[] = []
    const listener: RuntimeBackgroundListener = {
      onTaskEvent: async () => {},
      onAutonomousTurn: () => {},
      onSessionReleased: (threadId) => {
        released.push(threadId)
      },
    }
    runtime.setBackgroundListener(listener)

    // The first thread's CLI holds the launch slot until it says something.
    const busy = runtime.runTurn(turn('busy'), handlers())
    const first = await waitFor(() => queries[0], 'first launch')
    const queued = runtime.runTurn(turn('queued'), handlers()).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await sleep(20)
    assert.equal(queries.length, 1, 'the second launch waits for the first')
    await runtime.interrupt('thread-queued')
    // The server settled the interrupted turn already; it just goes away.
    assert.equal(await queued, 'resolved')

    first.push(init, result)
    await busy
    await waitFor(() => released.includes('thread-queued'), 'queued session released')
    assert.equal(queries.length, 1, 'an interrupted session must not launch')

    // The thread starts over with a session of its own.
    const retry = runtime.runTurn(turn('queued', { turnId: 'turn-retry' }), handlers())
    const fresh = await waitFor(() => queries[1], 'fresh launch')
    fresh.push(init, result)
    await retry
    await runtime.stop()
  })
})

test('steers and settings changes wait with a queued session for its Claude Code', async () => {
  await withGate(async () => {
    const { runtime, queries } = fakeRuntime()
    const busy = runtime.runTurn(turn('busy'), handlers())
    const first = await waitFor(() => queries[0], 'first launch')
    const queued = runtime.runTurn(turn('queued', { model: 'sonnet' }), handlers())
    await sleep(10)

    let accepted = 0
    const onAccepted = () => {
      accepted += 1
    }
    assert.equal(await runtime.steer('thread-queued', 'also this', { onAccepted }), true)
    assert.equal(
      await runtime.updateTurnSettings('thread-queued', 'turn-queued', {
        model: 'opus',
        effort: 'high',
      }),
      true,
    )
    assert.equal(queries.length, 1)

    first.push(init)
    const second = await waitFor(() => queries[1], 'second launch')
    assert.equal(second.options.model, 'opus')
    assert.equal(second.options.effort, 'high')
    await waitFor(() => second.prompts.length === 2, 'prompt and steer')
    assert.deepEqual(second.prompts.map(promptText), ['queued', 'also this'])
    const uuids = second.prompts.map((prompt) => prompt.uuid)
    second.push(init, { ...result, user_message_uuids: uuids })
    await queued
    assert.equal(accepted, 1)
    first.push(result)
    await busy
    await runtime.stop()
  })
})

test('stopping the adapter fails a turn still waiting for the launch gate', async () => {
  await withGate(async () => {
    const { runtime, queries } = fakeRuntime()
    const busy = runtime.runTurn(turn('busy'), handlers()).catch(() => {})
    await waitFor(() => queries[0], 'first launch')
    const events: RuntimeEvent[] = []
    const queued = runtime.runTurn(turn('queued'), handlers(events)).then(
      () => null,
      (error: Error) => error.message,
    )
    await sleep(10)
    await runtime.stop()
    assert.equal(await queued, 'Claude turn interrupted before Claude Code started')
    assert.ok(events.some((event) => event.type === 'error'))
    await busy
    assert.equal(queries.length, 1, 'a stopped session must not launch')
  })
})
