import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { TurnInput, type TurnInputMessage } from '../src/native-turn-input.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

const context: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn',
  prompt: 'resume check',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: 'session',
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

type Prompt = AsyncIterator<Record<string, any>>

function message(text: string): TurnInputMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  }
}

async function sentUuid(input: TurnInput, reader: AsyncIterator<{ uuid?: string }>, text: string) {
  input.send(message(text))
  const { value } = await reader.next()
  assert.equal(typeof value?.uuid, 'string')
  return value?.uuid as string
}

function result(fields: Record<string, unknown>) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...fields,
  }
}

function assistant(id: string, value: string) {
  return { type: 'assistant', message: { id, content: [{ type: 'text', text: value }] } }
}

// The fake SDK drives the turn from the prompt it is handed, the way the CLI
// reads stdin: script() pulls messages from the runtime's prompt stream.
function runtimeWith(script: (prompt: Prompt) => AsyncGenerator<Record<string, unknown>>) {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: ({ prompt }: { prompt: AsyncIterable<Record<string, any>> }) =>
      script(prompt[Symbol.asyncIterator]()),
  })
  return runtime
}

async function run(
  runtime: NativeClaudeRuntime,
  onEvent: (event: RuntimeEvent) => void = () => {},
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  await runtime.runTurn(context, {
    onEvent: async (event) => {
      events.push(event)
      onEvent(event)
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onUserInputRequest: async () => ({ answers: {} }),
  })
  return events
}

test('turn input stamps each send with a client uuid and ends on close', async () => {
  const input = new TurnInput()
  const reader = input[Symbol.asyncIterator]()
  const first = await sentUuid(input, reader, 'first')
  const second = await sentUuid(input, reader, 'second')
  assert.notEqual(first, second)

  const next = reader.next()
  input.close()
  assert.deepEqual(await next, { done: true, value: undefined })
  assert.equal(input.send(message('late')), false)
})

test('turn input drops sends still queued when the turn closes', async () => {
  const input = new TurnInput()
  input.send(message('never written'))
  input.close()
  const reader = input[Symbol.asyncIterator]()
  assert.deepEqual(await reader.next(), { done: true, value: undefined })
})

test('turn input classifies results by the uuids they echo', async () => {
  const input = new TurnInput()
  const reader = input[Symbol.asyncIterator]()
  const prompt = await sentUuid(input, reader, 'prompt')

  // A resumed session's queued task notification runs before our prompt.
  assert.equal(
    input.classifyResult(result({ origin: { kind: 'task-notification' }, queued_turn_count: 1 })),
    'foreign',
  )
  assert.equal(input.classifyResult(result({ user_message_uuids: ['someone-else'] })), 'foreign')

  const steer = await sentUuid(input, reader, 'steer')
  // The prompt is answered but the steer queued behind it as its own turn.
  assert.equal(
    input.classifyResult(result({ user_message_uuid: prompt, user_message_uuids: [prompt] })),
    'pending',
  )
  // Older producers echo only the single triggering uuid.
  assert.equal(input.classifyResult(result({ user_message_uuid: steer })), 'final')
})

test('turn input completes when a steer folds into the running turn', async () => {
  const input = new TurnInput()
  const reader = input[Symbol.asyncIterator]()
  const prompt = await sentUuid(input, reader, 'prompt')
  const steer = await sentUuid(input, reader, 'steer')
  assert.equal(
    input.classifyResult(result({ user_message_uuid: steer, user_message_uuids: [prompt, steer] })),
    'final',
  )
})

test('turn input keeps the first-result rule for producers without echoes', () => {
  const input = new TurnInput()
  input.send(message('prompt'))
  assert.equal(input.classifyResult(result({})), 'final')
  assert.equal(input.classifyResult(result({ origin: { kind: 'human' } })), 'final')
})

test('turn input does not wait on a steer a single-uuid producer cannot report', async () => {
  const input = new TurnInput()
  const reader = input[Symbol.asyncIterator]()
  const prompt = await sentUuid(input, reader, 'prompt')
  await sentUuid(input, reader, 'steer')
  // Without user_message_uuids a folded steer is indistinguishable from a
  // queued one, and no later result may come for it.
  assert.equal(input.classifyResult(result({ user_message_uuid: prompt })), 'final')
})

test('a resumed native turn waits past results for work it did not send', async () => {
  let promptEnded = false
  let promptEndedBeforeAnswer: boolean | null = null
  const runtime = runtimeWith(async function* (prompt) {
    const sent = (await prompt.next()).value
    // CLI 2.1.x re-queues background tasks the previous process left behind
    // as a <task-notification> and answers it before the new prompt.
    yield result({
      num_turns: 0,
      result: '',
      origin: { kind: 'task-notification' },
      queued_turn_count: 1,
      result_index: 0,
    })
    void prompt.next().then(() => {
      promptEnded = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    promptEndedBeforeAnswer = promptEnded
    yield assistant('answer', 'Here is the answer.')
    yield result({
      result: 'Here is the answer.',
      origin: { kind: 'human' },
      user_message_uuid: sent?.uuid,
      user_message_uuids: [sent?.uuid],
      queued_turn_count: 0,
      result_index: 1,
    })
  })

  const events = await run(runtime)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(promptEndedBeforeAnswer, false, 'prompt stream must stay open for the turn')
  assert.equal(promptEnded, true, 'prompt stream must end once the turn settles')
  assert.deepEqual(
    events.filter((event) => event.type === 'completed'),
    [
      {
        type: 'completed',
        success: true,
        result: 'Here is the answer.',
        claudeSessionId: null,
      },
    ],
  )
  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta').map((event) => event.delta),
    ['Here is the answer.'],
  )
  assert.equal(events.filter((event) => event.type === 'usage').length, 2)
  assert.equal(events.filter((event) => event.type === 'metrics').length, 1)
})

test('a steered native turn completes with the answer to the steer', async () => {
  let steerMessage: Record<string, any> | undefined
  const runtime = runtimeWith(async function* (prompt) {
    const sent = (await prompt.next()).value
    yield assistant('first', 'Working on it.')
    steerMessage = (await prompt.next()).value
    yield result({
      result: 'First answer.',
      user_message_uuid: sent?.uuid,
      user_message_uuids: [sent?.uuid],
      queued_turn_count: 1,
    })
    yield assistant('second', 'Also done.')
    yield result({
      result: 'Also done.',
      user_message_uuid: steerMessage?.uuid,
      user_message_uuids: [steerMessage?.uuid],
      queued_turn_count: 0,
    })
  })

  let steered = false
  const events = await run(runtime, (event) => {
    if (event.type !== 'text_delta' || steered) return
    steered = true
    void runtime.steer(context.threadId, 'and the follow-up')
  })

  assert.equal(steerMessage?.message.content, 'and the follow-up')
  assert.deepEqual(steerMessage?.origin, { kind: 'human' })
  assert.deepEqual(
    events.filter((event) => event.type === 'completed').map((event) => event.result),
    ['Also done.'],
  )
  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta').map((event) => event.delta),
    ['Working on it.', 'Also done.'],
  )
})
