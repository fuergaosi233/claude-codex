import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

const context: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn',
  prompt: 'presentation check',
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

async function collect(
  messages: Record<string, unknown>[],
  overrides: Partial<RuntimeTurnContext> = {},
): Promise<RuntimeEvent[]> {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      yield* messages
      yield { type: 'result', subtype: 'success', result: 'done' }
    },
  })
  const events: RuntimeEvent[] = []
  await runtime.runTurn(
    { ...context, ...overrides },
    {
      onEvent: async (event) => {
        events.push(event)
      },
      onPermissionRequest: async () => ({ decision: 'accept' }),
      onUserInputRequest: async () => ({ answers: {} }),
    },
  )
  return events.filter((event) => event.type !== 'metrics' && event.type !== 'completed')
}

function stream(event: Record<string, unknown>, parent: string | null = null) {
  return { type: 'stream_event', parent_tool_use_id: parent, event }
}

function start(id: string) {
  return stream({ type: 'message_start', message: { id } })
}

function delta(type: 'text' | 'thinking', text: string, index = 0) {
  return stream({
    type: 'content_block_delta',
    index,
    delta: { type: `${type}_delta`, [type]: text },
  })
}

function assistant(id: string, content: Record<string, unknown>[]) {
  return { type: 'assistant', message: { id, content } }
}

function text(value: string) {
  return { type: 'text', text: value }
}

test('native presentation keeps streamed progress and a later unstreamed final answer', async () => {
  const events = await collect([
    start('progress'),
    delta('thinking', 'Inspect first.', 0),
    delta('text', 'I will inspect the file.', 1),
    assistant('progress', [{ type: 'thinking', thinking: 'Inspect first.' }]),
    assistant('progress', [text('I will inspect the file.')]),
    assistant('progress', [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/tmp/example' } },
    ]),
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'contents' }] },
    },
    assistant('answer', [
      { type: 'thinking', thinking: 'Now summarize.' },
      text('## Result\n\nDone.'),
    ]),
  ])
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'message_boundary',
      'reasoning_delta',
      'text_delta',
      'tool_use',
      'tool_result',
      'message_boundary',
      'reasoning_delta',
      'text_delta',
    ],
  )
  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta').map((event) => event.delta),
    ['I will inspect the file.', '## Result\n\nDone.'],
  )
})

test('native presentation deduplicates per content block without losing adjacent unstreamed blocks', async () => {
  const events = await collect([
    start('answer'),
    delta('text', 'First', 0),
    assistant('answer', [text('First'), text(' second')]),
    assistant('answer', [text('First')]),
    delta('thinking', 'One thought', 2),
    assistant('answer', [
      { type: 'thinking', thinking: 'One thought' },
      { type: 'thinking', thinking: 'Another thought' },
    ]),
    stream({ type: 'message_stop' }),
  ])
  assert.deepEqual(events, [
    { type: 'message_boundary' },
    { type: 'text_delta', delta: 'First' },
    { type: 'text_delta', delta: ' second' },
    { type: 'text_delta', delta: 'First' },
    { type: 'reasoning_delta', delta: 'One thought' },
    { type: 'reasoning_delta', delta: 'Another thought' },
  ])
})

test('native presentation recovers the unstreamed suffix of a partially streamed block', async () => {
  assert.deepEqual(
    await collect([
      start('answer'),
      delta('text', 'Hello'),
      assistant('answer', [text('Hello world')]),
    ]),
    [
      { type: 'message_boundary' },
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
    ],
  )
})

test('nested assistant events do not split or contaminate parent messages', async () => {
  const nestedStart = stream({ type: 'message_start', message: { id: 'child' } }, 'parent-tool')
  const nestedDelta = { ...delta('text', 'Hidden child prose'), parent_tool_use_id: 'parent-tool' }
  assert.deepEqual(
    await collect([
      start('parent'),
      delta('text', 'Parent'),
      nestedStart,
      nestedDelta,
      { ...assistant('child', [text('Hidden child prose')]), parent_tool_use_id: 'parent-tool' },
      assistant('parent', [text('Parent')]),
    ]),
    [{ type: 'message_boundary' }, { type: 'text_delta', delta: 'Parent' }],
  )
})

test('structured output remains a single deduplicated result', async () => {
  assert.deepEqual(
    await collect(
      [start('answer'), delta('text', '{"ok":'), assistant('answer', [text('{"ok":true}')])],
      { outputFormat: { type: 'json_schema', schema: { type: 'object' } } },
    ),
    [{ type: 'text_delta', delta: '{"ok":true}' }],
  )
})

test('ordinary subscription limit updates are quiet and real warnings retain context', async () => {
  const events = await collect([
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 0.2 } },
    { type: 'rate_limit_event', rate_limit_info: {} },
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.83,
        resetsAt: 1_800_000_000,
      },
    },
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' },
    },
    { type: 'rate_limit', message: 'Retry after 30 seconds.' },
  ])
  assert.equal(events.length, 3)
  assert.deepEqual(events[0], {
    type: 'notice',
    level: 'warning',
    message:
      'Claude usage is nearing the five hour limit (83% used). Resets at 2027-01-15T08:00:00.000Z.',
  })
  assert.deepEqual(events[1], {
    type: 'notice',
    level: 'warning',
    message: 'Claude seven day limit reached.',
  })
  assert.deepEqual(events[2], {
    type: 'notice',
    level: 'warning',
    message: 'Retry after 30 seconds.',
  })
})
