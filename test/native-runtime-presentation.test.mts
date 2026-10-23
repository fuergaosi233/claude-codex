import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { TOOL_INPUT_PREVIEW_INTERVAL_MS } from '../src/tool-input-preview.mjs'
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
  result: Record<string, unknown> = { type: 'result', subtype: 'success', result: 'done' },
): Promise<RuntimeEvent[]> {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      for (const message of messages) {
        // `{ wait: ms }` lets time pass between two messages.
        if (typeof message.wait === 'number') await delay(message.wait)
        else yield message
      }
      yield result
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

function toolStart(index: number, id: string, name: string, parent: string | null = null) {
  return stream(
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    parent,
  )
}

function inputDelta(index: number, json: string, parent: string | null = null) {
  return stream(
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } },
    parent,
  )
}

function blockStop(index: number) {
  return stream({ type: 'content_block_stop', index })
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool_use', id, name, input }
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

// Claude Code sends a `ping` every 30 seconds while it streams, and can close
// a cut-short reply late or not at all; neither changes what the turn shows.
test('native presentation ignores stream pings and a late or missing message_stop', async () => {
  const messages: Record<string, unknown>[] = [
    start('cut'),
    stream({ type: 'ping' }),
    delta('text', 'Cut short', 0),
    assistant('cut', [text('Cut short')]),
    stream({ type: 'ping' }),
    start('answer'),
    // The cut-short reply's, arriving after the next one started.
    stream({ type: 'message_stop' }),
    delta('text', 'Done.', 0),
    stream({ type: 'ping' }),
    assistant('answer', [text('Done.')]),
  ]
  const quiet = messages.filter((message) => {
    const type = (message.event as Record<string, unknown> | undefined)?.type
    return type !== 'ping' && type !== 'message_stop'
  })
  const shape = (events: RuntimeEvent[]) =>
    events.map((event) => (event.type === 'text_delta' ? `text:${event.delta}` : event.type))
  const events = shape(await collect(messages))
  assert.deepEqual(events, shape(await collect(quiet)))
  assert.deepEqual(events, ['message_boundary', 'text:Cut short', 'message_boundary', 'text:Done.'])
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

// Claude answers a structured turn by calling StructuredOutput, such as the
// App's title request; the prose around the call is not the answer.
test('a structured answer is what Claude passed to StructuredOutput', async () => {
  const outputFormat = { type: 'json_schema' as const, schema: { type: 'object' } }
  const title = { title: 'Reset relay backoff', description: 'Clear the reconnect timer' }
  const answer = [
    start('answer'),
    delta('text', 'Here is the title.'),
    assistant('answer', [
      text('Here is the title.'),
      toolUse('first', 'StructuredOutput', { title: 'Draft' }),
    ]),
    assistant('answer', [toolUse('second', 'StructuredOutput', title)]),
  ]
  const answered = [{ type: 'text_delta', delta: JSON.stringify(title) }]
  // The CLI reports the call it accepted as structured_output.
  assert.deepEqual(
    await collect(
      answer,
      { outputFormat },
      { type: 'result', subtype: 'success', result: '', structured_output: title },
    ),
    answered,
  )
  // A CLI that leaves it out: the latest call.
  assert.deepEqual(
    await collect(answer, { outputFormat }, { type: 'result', subtype: 'success', result: '' }),
    answered,
  )
  // A turn that failed passes no call off as its answer.
  const failed: RuntimeEvent[] = []
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      yield* answer
      yield {
        type: 'result',
        subtype: 'error_max_structured_output_retries',
        is_error: true,
        terminal_reason: 'structured_output_retry_exhausted',
      }
    },
  })
  await runtime
    .runTurn(
      { ...context, outputFormat },
      {
        onEvent: async (event) => {
          failed.push(event)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    .catch(() => {})
  assert.equal(
    failed.some((event) => event.type === 'text_delta' && event.delta.includes('"title"')),
    false,
  )
})

test('a dynamic tool call leaves no generic tool item: the server draws its own', async () => {
  const dynamicTools = [
    {
      server: 'codex_app',
      namespace: 'codex_app',
      description: '',
      tools: [
        {
          name: 'list_artifacts',
          description: '',
          inputSchema: { type: 'object' },
          deferLoading: false,
        },
      ],
    },
  ]
  const calls = [
    { type: 'tool_use', id: 'dynamic', name: 'mcp__codex_app__list_artifacts', input: {} },
    { type: 'tool_use', id: 'mcp', name: 'mcp__github__search', input: { q: 'x' } },
  ]
  const toolUses = (events: RuntimeEvent[]) =>
    events.flatMap((event) => (event.type === 'tool_use' ? [event.toolName] : []))
  assert.deepEqual(toolUses(await collect([assistant('a', calls)], { dynamicTools })), [
    'mcp__github__search',
  ])
  // In plan mode the tools are not offered, so the name is someone else's.
  assert.deepEqual(
    toolUses(await collect([assistant('a', calls)], { dynamicTools, planMode: true })),
    ['mcp__codex_app__list_artifacts', 'mcp__github__search'],
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

test('Claude compacting the conversation becomes compaction events; a subagent compacting does not', async () => {
  const events = await collect([
    system('status', { status: 'compacting' }),
    system('compact_boundary', {
      compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 21_000 },
    }),
    system('status', { status: null, compact_result: 'success' }),
    // A boundary alone, from a CLI that reports no status, without the size
    // of the summary.
    system('compact_boundary', { compact_metadata: { trigger: 'manual', pre_tokens: 90_000 } }),
    system('status', { status: 'compacting', parent_tool_use_id: 'agent' }),
    system('compact_boundary', {
      parent_tool_use_id: 'agent',
      compact_metadata: { trigger: 'auto', pre_tokens: 50_000, post_tokens: 4_000 },
    }),
    system('status', { status: 'requesting' }),
    system('status', { status: 'compacting' }),
    system('status', { status: null, compact_result: 'failed', compact_error: 'prompt too long' }),
    system('status', { status: null, compact_result: 'failed' }),
  ])
  assert.deepEqual(events, [
    { type: 'compaction_started' },
    { type: 'compaction_completed', trigger: 'auto', preTokens: 180_000, postTokens: 21_000 },
    { type: 'compaction_completed', trigger: 'manual', preTokens: 90_000, postTokens: null },
    { type: 'compaction_started' },
    {
      type: 'notice',
      level: 'warning',
      message: 'Claude could not compact the conversation: prompt too long',
    },
    { type: 'notice', level: 'warning', message: 'Claude could not compact the conversation.' },
  ])
  // /compact compacts the session, unless Claude Code has the command off.
  const disabled = process.env.DISABLE_COMPACT
  try {
    delete process.env.DISABLE_COMPACT
    assert.equal(new NativeClaudeRuntime().compactsSessions(), true)
    process.env.DISABLE_COMPACT = '1'
    assert.equal(new NativeClaudeRuntime().compactsSessions(), false)
  } finally {
    if (disabled === undefined) delete process.env.DISABLE_COMPACT
    else process.env.DISABLE_COMPACT = disabled
  }
})

test("native API retries become retrying events, a subagent's told by its Agent call, and urgent CLI notifications warnings", async () => {
  const notification = (key: string, fields: Record<string, unknown>) =>
    system('notification', { key, text: `${key} text`, priority: 'high', ...fields })
  const events = await collect([
    system('api_retry', {
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 600,
      error_status: 529,
      error: 'overloaded',
    }),
    // A subagent's retry is told against the Agent call that runs it.
    system('api_retry', {
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 600,
      error_status: 500,
      error: 'server_error',
      parent_tool_use_id: 'agent',
    }),
    system('api_retry', {
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 1200,
      error_status: null,
      error: 'unknown',
    }),
    notification('compact-failed', { color: 'error' }),
    notification('compact-failed', { color: 'error' }),
    notification('model-denied', { priority: 'immediate' }),
    notification('tip', { priority: 'low' }),
    notification('status', { priority: 'medium' }),
    notification('blank', { text: '' }),
  ])
  assert.deepEqual(events, [
    {
      type: 'retrying',
      attempt: 1,
      maxRetries: 10,
      status: 529,
      category: 'overloaded',
      delayMs: 600,
    },
    {
      type: 'retrying',
      attempt: 1,
      maxRetries: 10,
      status: 500,
      category: 'server_error',
      delayMs: 600,
      toolUseId: 'agent',
    },
    {
      type: 'retrying',
      attempt: 2,
      maxRetries: 10,
      status: null,
      category: 'unknown',
      delayMs: 1200,
    },
    { type: 'notice', level: 'error', message: 'compact-failed text' },
    { type: 'notice', level: 'warning', message: 'model-denied text' },
  ])
})

async function completedEvent(messages: Record<string, unknown>[]) {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: async function* () {
      yield* messages
    },
  })
  const events: RuntimeEvent[] = []
  const outcome = await runtime
    .runTurn(context, {
      onEvent: async (event) => {
        events.push(event)
      },
      onPermissionRequest: async () => ({ decision: 'accept' }),
    })
    .then(
      () => 'resolved',
      (error: Error) => error.message,
    )
  return { outcome, completed: events.find((event) => event.type === 'completed') }
}

test('a failed native turn says why it failed, and a successful one carries no failure', async () => {
  const overloaded = await completedEvent([
    system('api_retry', {
      attempt: 10,
      max_retries: 10,
      retry_delay_ms: 30_000,
      error_status: 529,
      error: 'overloaded',
    }),
    {
      type: 'assistant',
      message: { id: 'failed', content: [text('API Error')] },
      error: 'overloaded',
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'API Error: 529 Overloaded',
      terminal_reason: 'api_error',
      api_error_status: 529,
    },
  ])
  assert.equal(overloaded.outcome, 'API Error: 529 Overloaded')
  assert.deepEqual(overloaded.completed, {
    type: 'completed',
    success: false,
    result: 'API Error: 529 Overloaded',
    claudeSessionId: null,
    failure: { terminalReason: 'api_error', category: 'overloaded', status: 529 },
  })

  // A retry the next response answered says nothing about a later failure.
  const tooLong = await completedEvent([
    system('api_retry', {
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 600,
      error_status: 529,
      error: 'overloaded',
    }),
    assistant('answered', [text('Working on it.')]),
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Prompt is too long',
      terminal_reason: 'prompt_too_long',
    },
  ])
  assert.deepEqual(tooLong.completed, {
    type: 'completed',
    success: false,
    result: 'Prompt is too long',
    claudeSessionId: null,
    failure: { terminalReason: 'prompt_too_long', category: null, status: null },
  })

  // A subagent's retry says nothing about why the main loop failed.
  const afterSubagentRetry = await completedEvent([
    system('api_retry', {
      attempt: 10,
      max_retries: 10,
      retry_delay_ms: 30_000,
      error_status: 529,
      error: 'overloaded',
      parent_tool_use_id: 'agent',
    }),
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Claude turn failed',
      terminal_reason: 'api_error',
    },
  ])
  assert.deepEqual(afterSubagentRetry.completed, {
    type: 'completed',
    success: false,
    result: 'Claude turn failed',
    claudeSessionId: null,
    failure: { terminalReason: 'api_error', category: null, status: null },
  })

  // A CLI that refused to start names the reason; its stderr stays behind,
  // and so does the id of a session it never loaded.
  const refused = await completedEvent([
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 0,
      num_turns: 0,
      session_id: 'never-loaded',
      startup_failure_reason: 'proxy_invalid',
      errors: ['Invalid proxy URL: http://user:secret@proxy.invalid:8080'],
    },
  ])
  assert.equal(refused.outcome, 'Claude turn failed')
  assert.deepEqual(refused.completed, {
    type: 'completed',
    success: false,
    result: null,
    claudeSessionId: null,
    failure: {
      terminalReason: null,
      category: null,
      status: null,
      startupFailure: 'proxy_invalid',
    },
  })

  const succeeded = await completedEvent([
    system('api_retry', {
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 600,
      error_status: 529,
      error: 'overloaded',
    }),
    { type: 'result', subtype: 'success', result: 'done' },
  ])
  assert.equal(succeeded.outcome, 'resolved')
  assert.deepEqual(succeeded.completed, {
    type: 'completed',
    success: true,
    result: 'done',
    claudeSessionId: null,
  })
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

  // The model switch may have left the CLI in another permission mode, so
  // the turn's mode goes back with it; without a switch nothing is sent.
  const modes: string[] = []
  const planned = {
    query: {
      setModel: async () => {},
      setPermissionMode: async (mode: string) => {
        modes.push(mode)
      },
    },
    model: 'opus',
    effort: null,
    permissionMode: 'plan',
  }
  const planTurn: RuntimeTurnContext = {
    ...context,
    model: 'sonnet',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    planMode: true,
  }
  await apply.call(runtime, planned, planTurn)
  assert.deepEqual(modes, ['plan'])
  await apply.call(runtime, planned, planTurn)
  assert.deepEqual(modes, ['plan'])
})

test('a file tool call streams its input as throttled progress before the finished call', async () => {
  const input = { file_path: '/tmp/notes.md', content: '# Notes\n\nFirst line\u00e9\n' }
  const events = await collect([
    start('edit'),
    delta('text', 'Writing it.', 0),
    blockStop(0),
    assistant('edit', [text('Writing it.')]),
    toolStart(1, 'write', 'Write'),
    // The path is still being written: no file to show yet.
    inputDelta(1, '{"file_path": "/tmp/no'),
    inputDelta(1, 'tes.md", "content": "# No'),
    inputDelta(1, 'tes\\n\\nFirst'),
    { wait: TOOL_INPUT_PREVIEW_INTERVAL_MS + 20 },
    inputDelta(1, ' line\\u00'),
    inputDelta(1, 'e9\\n"}'),
    blockStop(1),
    assistant('edit', [toolUse('write', 'Write', input)]),
  ])
  const progress = (content: string) => ({
    type: 'tool_input_progress',
    toolUseId: 'write',
    toolName: 'Write',
    input: { file_path: '/tmp/notes.md', content },
  })
  assert.deepEqual(events, [
    { type: 'message_boundary' },
    { type: 'text_delta', delta: 'Writing it.' },
    progress('# No'),
    // The cut escape is left out until it is complete.
    progress('# Notes\n\nFirst line'),
    { type: 'tool_use', toolUseId: 'write', toolName: 'Write', input },
  ])
})

test('subagent and non-file tool input does not stream', async () => {
  const events = await collect([
    start('main'),
    toolStart(0, 'bash', 'Bash'),
    inputDelta(0, '{"command": "ls", "file_path": "/tmp/a.txt"}'),
    blockStop(0),
    assistant('main', [toolUse('bash', 'Bash', { command: 'ls', file_path: '/tmp/a.txt' })]),
    toolStart(1, 'write', 'Write'),
    // A subagent streams beside the main loop, numbering its own blocks.
    stream({ type: 'message_start', message: { id: 'child' } }, 'agent'),
    toolStart(1, 'child-edit', 'Edit', 'agent'),
    inputDelta(1, '{"file_path": "/tmp/child.txt", "old_string": "x', 'agent'),
    inputDelta(1, '{"file_path": "/tmp/b.txt"}'),
    blockStop(1),
    {
      ...assistant('child', [toolUse('child-edit', 'Edit', { file_path: '/tmp/child.txt' })]),
      parent_tool_use_id: 'agent',
    },
    assistant('main', [toolUse('write', 'Write', { file_path: '/tmp/b.txt', content: '' })]),
  ])
  assert.deepEqual(events, [
    { type: 'message_boundary' },
    {
      type: 'tool_use',
      toolUseId: 'bash',
      toolName: 'Bash',
      input: { command: 'ls', file_path: '/tmp/a.txt' },
    },
    {
      type: 'tool_input_progress',
      toolUseId: 'write',
      toolName: 'Write',
      input: { file_path: '/tmp/b.txt' },
    },
    {
      type: 'tool_use',
      toolUseId: 'write',
      toolName: 'Write',
      input: { file_path: '/tmp/b.txt', content: '' },
    },
  ])
})

test('a new model response drops the input of a call it did not finish', async () => {
  const input = { file_path: '/tmp/a.txt', content: 'xyz' }
  const events = await collect([
    start('first'),
    toolStart(0, 'lost', 'Write'),
    inputDelta(0, '{"file_path": "/tmp/a.txt", "content": "x'),
    // The stream broke off and Claude asked again.
    start('retry'),
    inputDelta(0, 'yz"}'),
    toolStart(0, 'write', 'Write'),
    inputDelta(0, '{"file_path": "/tmp/a.txt"'),
    blockStop(0),
    assistant('retry', [toolUse('write', 'Write', input)]),
  ])
  assert.deepEqual(events, [
    { type: 'message_boundary' },
    {
      type: 'tool_input_progress',
      toolUseId: 'lost',
      toolName: 'Write',
      input: { file_path: '/tmp/a.txt', content: 'x' },
    },
    { type: 'message_boundary' },
    {
      type: 'tool_input_progress',
      toolUseId: 'write',
      toolName: 'Write',
      input: { file_path: '/tmp/a.txt' },
    },
    { type: 'tool_use', toolUseId: 'write', toolName: 'Write', input },
  ])
})

test('CLAUDE_CODEX_LIVE_FILE_CHANGES=0 shows a file tool call only once it is finished', async () => {
  const previous = process.env.CLAUDE_CODEX_LIVE_FILE_CHANGES
  process.env.CLAUDE_CODEX_LIVE_FILE_CHANGES = '0'
  try {
    const input = { file_path: '/tmp/a.txt', content: 'xyz' }
    const events = await collect([
      start('edit'),
      toolStart(0, 'write', 'Write'),
      inputDelta(0, JSON.stringify(input)),
      blockStop(0),
      assistant('edit', [toolUse('write', 'Write', input)]),
    ])
    assert.deepEqual(
      events.map((event) => event.type),
      ['message_boundary', 'tool_use'],
    )
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_LIVE_FILE_CHANGES
    else process.env.CLAUDE_CODEX_LIVE_FILE_CHANGES = previous
  }
})
