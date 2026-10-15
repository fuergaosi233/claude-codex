import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeEvent, RuntimeTurnContext, RuntimeTurnSettings } from '../src/types.mjs'

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

function system(subtype: string, fields: Record<string, unknown>) {
  return { type: 'system', subtype, ...fields }
}

test('native hook lifecycle frames become hook runs with Codex statuses', async () => {
  const hook = (id: string, fields: Record<string, unknown>) =>
    system('hook_response', {
      hook_id: id,
      hook_name: `PreToolUse:${id}`,
      hook_event: 'PreToolUse',
      output: '',
      stdout: '',
      stderr: '',
      ...fields,
    })
  const events = await collect([
    system('hook_started', {
      hook_id: 'ok',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
    }),
    hook('ok', { outcome: 'success', exit_code: 0 }),
    hook('exit2', { outcome: 'error', exit_code: 2, stderr: 'no rm -rf\n' }),
    hook('crash', { outcome: 'error', exit_code: 1, stderr: 'boom' }),
    hook('json', {
      outcome: 'success',
      exit_code: 0,
      stdout: JSON.stringify({
        decision: 'block',
        reason: 'lint first',
        systemMessage: 'heads up',
      }),
    }),
    hook('halt', {
      outcome: 'success',
      exit_code: 0,
      stdout: JSON.stringify({ continue: false, stopReason: 'done for today' }),
    }),
    hook('cancel', { outcome: 'cancelled' }),
    system('hook_progress', { hook_id: 'ok', hook_event: 'PreToolUse', stdout: 'tick' }),
  ])
  assert.deepEqual(events, [
    { type: 'hook_run', hookId: 'ok', hookEvent: 'PreToolUse', status: 'running', entries: [] },
    { type: 'hook_run', hookId: 'ok', hookEvent: 'PreToolUse', status: 'completed', entries: [] },
    {
      type: 'hook_run',
      hookId: 'exit2',
      hookEvent: 'PreToolUse',
      status: 'blocked',
      entries: [{ kind: 'feedback', text: 'no rm -rf' }],
    },
    {
      type: 'hook_run',
      hookId: 'crash',
      hookEvent: 'PreToolUse',
      status: 'failed',
      entries: [{ kind: 'error', text: 'boom' }],
    },
    {
      type: 'hook_run',
      hookId: 'json',
      hookEvent: 'PreToolUse',
      status: 'blocked',
      entries: [
        { kind: 'warning', text: 'heads up' },
        { kind: 'feedback', text: 'lint first' },
      ],
    },
    {
      type: 'hook_run',
      hookId: 'halt',
      hookEvent: 'PreToolUse',
      status: 'blocked',
      entries: [{ kind: 'stop', text: 'done for today' }],
    },
    { type: 'hook_run', hookId: 'cancel', hookEvent: 'PreToolUse', status: 'stopped', entries: [] },
  ])
})

test('native refusal fallbacks and warning banners surface without ending the turn', async () => {
  const fallback = (fields: Record<string, unknown>) =>
    system('model_refusal_fallback', {
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-a',
      fallback_model: 'claude-b',
      request_id: null,
      content: 'Switched to claude-b.',
      ...fields,
    })
  const events = await collect([
    fallback({ scope: 'session', api_refusal_category: 'cyber' }),
    fallback({ api_refusal_category: null, content: '' }),
    fallback({ scope: 'local', content: 'A subagent switched models.' }),
    fallback({ direction: 'revert', content: 'Back on claude-a.' }),
    system('model_refusal_no_fallback', { original_model: 'claude-a', content: 'Refused.' }),
    system('informational', { level: 'info', content: 'transcript only' }),
    system('informational', { level: 'warning', content: 'Stop hook blocked continuation' }),
  ])
  assert.deepEqual(events, [
    {
      type: 'model_rerouted',
      fromModel: 'claude-a',
      toModel: 'claude-b',
      category: 'cyber',
      message: 'Switched to claude-b.',
    },
    {
      type: 'model_rerouted',
      fromModel: 'claude-a',
      toModel: 'claude-b',
      category: null,
      message: 'Claude switched from claude-a to claude-b after a refusal.',
    },
    { type: 'notice', level: 'warning', message: 'A subagent switched models.' },
    { type: 'notice', level: 'warning', message: 'Back on claude-a.' },
    { type: 'notice', level: 'warning', message: 'Refused.' },
    { type: 'notice', level: 'warning', message: 'Stop hook blocked continuation' },
  ])
})

test('native MCP elicitations reach the turn handler, and are declined without one', async () => {
  const elicit = async (handled: boolean) => {
    const runtime = new NativeClaudeRuntime()
    const answers: unknown[] = []
    Reflect.set(runtime, 'sdk', {
      query: async function* ({ options }: { options: Record<string, any> }) {
        const signal = new AbortController().signal
        answers.push(
          await options.onElicitation(
            {
              serverName: 'db',
              message: 'Which table?',
              mode: 'form',
              requestedSchema: { type: 'object', properties: { table: { type: 'string' } } },
            },
            { signal, requestId: 'r1' },
          ),
        )
        answers.push(
          await options.onElicitation(
            { serverName: 'db', message: 'Sign in', mode: 'url', url: 'https://example.com' },
            { signal, requestId: 'r2' },
          ),
        )
        yield { type: 'result', subtype: 'success', result: 'done' }
      },
    })
    const requests: unknown[] = []
    await runtime.runTurn(context, {
      onEvent: async () => {},
      onPermissionRequest: async () => ({ decision: 'accept' }),
      ...(handled
        ? {
            onElicitationRequest: async (request) => {
              requests.push(request)
              return request.mode === 'form'
                ? { action: 'accept' as const, content: { table: 'users' } }
                : { action: 'cancel' as const }
            },
          }
        : {}),
    })
    return { answers, requests }
  }
  const handled = await elicit(true)
  assert.deepEqual(handled.requests, [
    {
      serverName: 'db',
      message: 'Which table?',
      mode: 'form',
      requestedSchema: { type: 'object', properties: { table: { type: 'string' } } },
      url: null,
      elicitationId: null,
    },
    {
      serverName: 'db',
      message: 'Sign in',
      mode: 'url',
      requestedSchema: null,
      url: 'https://example.com',
      elicitationId: null,
    },
  ])
  assert.deepEqual(handled.answers, [
    { action: 'accept', content: { table: 'users' } },
    { action: 'cancel' },
  ])
  const unhandled = await elicit(false)
  assert.deepEqual(unhandled.answers, [{ action: 'decline' }, { action: 'decline' }])
})

test('turn settings switch the running turn in place, and the next turn restores its own', async () => {
  const runtime = new NativeClaudeRuntime()
  const calls: unknown[] = []
  const outcomes: unknown[] = []
  let failModel = false
  Reflect.set(runtime, 'sdk', {
    query: () => {
      const messages = (async function* () {
        const update = (turnId: string, settings: RuntimeTurnSettings) =>
          runtime
            .updateTurnSettings('thread', turnId, settings)
            .catch((error: Error) => error.message)
        outcomes.push(await update('turn', { model: 'opus', effort: 'high' }))
        // Unchanged settings send nothing.
        outcomes.push(await update('turn', { model: 'opus', effort: 'high' }))
        outcomes.push(await update('other-turn', { effort: 'low' }))
        failModel = true
        outcomes.push(await update('turn', { model: 'haiku' }))
        yield { type: 'result', subtype: 'success', result: 'done' }
      })()
      return Object.assign(messages, {
        setModel: async (model?: string) => {
          calls.push(['setModel', model])
          if (failModel) throw new Error('unknown model')
        },
        applyFlagSettings: async (settings: unknown) => {
          calls.push(['applyFlagSettings', settings])
        },
      })
    },
  })
  await runtime.runTurn(
    { ...context, model: 'sonnet', effort: 'medium' },
    {
      onEvent: async () => {},
      onPermissionRequest: async () => ({ decision: 'accept' }),
    },
  )
  assert.deepEqual(outcomes, [
    true,
    true,
    false,
    'Claude Code rejected the model switch: unknown model',
  ])
  assert.deepEqual(calls, [
    ['setModel', 'opus'],
    ['applyFlagSettings', { effortLevel: 'high' }],
    ['setModel', 'haiku'],
  ])
  assert.equal(await runtime.updateTurnSettings('thread', 'turn', { effort: 'low' }), false)

  // A later turn on the same live session puts its own model and effort back.
  const restored: unknown[] = []
  const query = {
    setModel: async (model?: string) => {
      restored.push(['setModel', model])
    },
    applyFlagSettings: async (settings: unknown) => {
      restored.push(['applyFlagSettings', settings])
    },
    setPermissionMode: async () => {},
  }
  const session = { query, model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' }
  const apply = Reflect.get(runtime, 'applySessionSettings') as (
    session: unknown,
    context: RuntimeTurnContext,
  ) => Promise<void>
  await apply.call(runtime, session, { ...context, model: 'sonnet', effort: null })
  assert.deepEqual(restored, [
    ['setModel', 'sonnet'],
    ['applyFlagSettings', { effortLevel: null }],
  ])
  assert.equal(session.effort, null)
})
