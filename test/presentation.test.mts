import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { codexErrorInfo, parseSubagentTrailer, retryTurnError } from '../src/server-helpers.mjs'
import { SessionStore } from '../src/store.mjs'
import type {
  ClaudeRuntime,
  RpcPeer,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeHandlers,
  ThreadItem,
  WireMessage,
} from '../src/types.mjs'

type CapturedMessage = { method?: string; id?: unknown; params?: any; result?: any; error?: any }

async function present(
  run: (handlers: RuntimeHandlers, turn: { interrupt: () => Promise<void> }) => Promise<void>,
  params: Record<string, unknown> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-presentation-'))
  const previousHome = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const messages: CapturedMessage[] = []
  let finish: () => void = () => {}
  const completed = new Promise<void>((resolve) => {
    finish = resolve
  })
  const runtime: ClaudeRuntime = {
    runTurn: async (context, handlers) =>
      run(handlers, {
        interrupt: () =>
          server.handle(peer, {
            id: 9,
            method: 'turn/interrupt',
            params: { threadId: context.threadId },
          }) as Promise<void>,
      }),
    steer: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  }
  const server = new CodexClaudeAppServer(store, runtime)
  const peer: RpcPeer = {
    id: 'presentation-test',
    close: () => {},
    send: (message: WireMessage) => {
      const captured = structuredClone(message) as CapturedMessage
      messages.push(captured)
      if (captured.method === 'turn/completed') finish()
      if (captured.method && captured.id != null) {
        const result =
          captured.method === 'item/tool/requestUserInput'
            ? { answers: { choice: { answers: ['Yes'] } } }
            : { decision: 'accept' }
        setImmediate(() => {
          void server.handle(peer, { jsonrpc: '2.0', id: String(captured.id), result })
        })
      }
    },
  }
  let timeout: NodeJS.Timeout | undefined
  try {
    await server.handle(peer, {
      id: 1,
      method: 'thread/start',
      params: { cwd: directory, approvalPolicy: 'untrusted', model: 'sonnet' },
    })
    const threadId = messages.find((message) => message.id === 1)?.result.thread.id
    assert.ok(threadId)
    await server.handle(peer, {
      id: 2,
      method: 'turn/start',
      params: { threadId, input: [{ type: 'text', text: 'Check presentation' }], ...params },
    })
    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Presentation turn timed out')), 5_000)
      }),
    ])
    const turns = store.listTurns(threadId)
    const turn = turns.at(-1)
    assert.ok(turn)
    await server.handle(peer, {
      id: 3,
      method: 'thread/read',
      params: { threadId, includeTurns: true },
    })
    const replay = messages.find((message) => message.id === 3)?.result.thread.turns.at(-1)
    return { messages, turn, replay }
  } finally {
    if (timeout) clearTimeout(timeout)
    await server.stop()
    if (previousHome == null) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

function emit(events: RuntimeEvent[]) {
  return async (handlers: RuntimeHandlers): Promise<void> => {
    for (const event of events) await handlers.onEvent(event)
  }
}

function assistantItems(items: ThreadItem[]) {
  return items.filter((item) => item.type === 'agentMessage')
}

test('progress, tools and final Markdown remain separate in streaming and replay', async () => {
  const markdown = '## Result\n\n- **Passed**\n\n```ts\nconst ok = true\n```'
  const { messages, turn, replay } = await present(
    emit([
      { type: 'message_boundary' },
      { type: 'text_delta', delta: 'I will inspect the file.' },
      { type: 'tool_use', toolUseId: 'read', toolName: 'Read', input: { file_path: 'app.ts' } },
      { type: 'tool_result', toolUseId: 'read', content: 'const ok = true' },
      { type: 'message_boundary' },
      { type: 'text_delta', delta: markdown.slice(0, 18) },
      { type: 'text_delta', delta: markdown.slice(18) },
      { type: 'completed', success: true },
    ]),
  )
  assert.deepEqual(
    turn.items.map((item) => item.type),
    ['userMessage', 'agentMessage', 'commandExecution', 'agentMessage'],
  )
  assert.deepEqual(
    assistantItems(turn.items).map(({ text, phase }) => ({ text, phase })),
    [
      { text: 'I will inspect the file.', phase: 'commentary' },
      { text: markdown, phase: 'final_answer' },
    ],
  )
  const completedItems = messages
    .filter((message) => message.method === 'item/completed')
    .map((message) => message.params.item)
  assert.deepEqual(
    completedItems.map((item) => item.type),
    ['agentMessage', 'commandExecution', 'agentMessage'],
  )
  assert.equal(new Set(completedItems.map((item) => item.id)).size, completedItems.length)
  assert.deepEqual(replay.items, turn.items)
})

test('fragmented Mermaid fences and image paths survive streaming and replay unchanged', async () => {
  const fragments = [
    '请求先经过路由，再由模型处理。\n\n`',
    '``mer',
    'maid\nflowchart LR\n  A["用户请求"] --> B{"匹配路由？"}\n',
    '  B -->|是| C["Claude Code"]\n  B -->|否| D["默认工具链"]\n``',
    '`\n\n![架构图](/home/tiger/output/architecture.png)',
  ]
  const markdown = fragments.join('')
  const { messages, turn, replay } = await present(
    emit([
      { type: 'message_boundary' },
      ...fragments.flatMap((delta): RuntimeEvent[] => [
        { type: 'text_delta', delta },
        { type: 'notice', level: 'info', message: 'Working' },
      ]),
      { type: 'completed', success: true },
    ]),
  )
  const items = assistantItems(turn.items)
  assert.equal(items.length, 1)
  assert.equal(items[0]?.text, markdown)
  assert.equal(items[0]?.phase, 'final_answer')
  assert.equal(
    messages
      .filter((message) => message.method === 'item/agentMessage/delta')
      .map((message) => message.params.delta)
      .join(''),
    markdown,
  )
  assert.deepEqual(replay.items, turn.items)
})

test('message boundaries split independent responses even without a tool', async () => {
  const { turn } = await present(
    emit([
      { type: 'text_delta', delta: 'First update.' },
      { type: 'message_boundary' },
      { type: 'message_boundary' },
      { type: 'text_delta', delta: 'Final response.' },
    ]),
  )
  assert.deepEqual(
    assistantItems(turn.items).map((item) => [item.text, item.phase]),
    [
      ['First update.', 'commentary'],
      ['Final response.', 'final_answer'],
    ],
  )
})

test('backends without explicit boundaries still split output around tools', async () => {
  const { turn } = await present(
    emit([
      { type: 'text_delta', delta: 'Checking.' },
      { type: 'tool_use', toolUseId: 'shell', toolName: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', toolUseId: 'shell', content: '/tmp' },
      { type: 'text_delta', delta: 'Done.' },
    ]),
  )
  assert.deepEqual(
    assistantItems(turn.items).map((item) => [item.text, item.phase]),
    [
      ['Checking.', 'commentary'],
      ['Done.', 'final_answer'],
    ],
  )
})

test('runtime notices do not pollute Markdown and genuine warnings are deduplicated', async () => {
  const { messages, turn } = await present(
    emit([
      { type: 'text_delta', delta: '**Clean' },
      { type: 'notice', level: 'info', message: 'Working' },
      { type: 'notice', level: 'warning', message: 'Quota nearly exhausted' },
      { type: 'notice', level: 'warning', message: 'Quota nearly exhausted' },
      { type: 'notice', level: 'error', message: 'Optional hook failed' },
      { type: 'text_delta', delta: ' answer**' },
    ]),
  )
  assert.equal(assistantItems(turn.items)[0]?.text, '**Clean answer**')
  assert.deepEqual(
    messages.filter((message) => message.method === 'warning').map((message) => message.params),
    [
      { threadId: turn.threadId, message: 'Quota nearly exhausted' },
      { threadId: turn.threadId, message: 'Optional hook failed' },
    ],
  )
})

test('reasoning appears once and completes before visible prose', async () => {
  const { messages, turn } = await present(
    emit([
      { type: 'reasoning_delta', delta: 'Think ' },
      { type: 'reasoning_delta', delta: 'carefully.' },
      { type: 'text_delta', delta: 'Answer.' },
    ]),
  )
  // The App renders reasoning from its summary alone.
  const reasoning = turn.items.flatMap((item) => (item.type === 'reasoning' ? [item] : []))
  assert.deepEqual(
    reasoning.map((item) => [item.summary, item.content]),
    [[['Think carefully.'], []]],
  )
  assert.equal(
    messages.filter((message) => message.method === 'item/reasoning/summaryPartAdded').length,
    1,
  )
  assert.equal(
    messages.some((message) => message.method === 'item/reasoning/textDelta'),
    false,
  )
  const reasoningDone = messages.findIndex(
    (message) => message.method === 'item/completed' && message.params.item.type === 'reasoning',
  )
  const answerStart = messages.findIndex(
    (message) => message.method === 'item/started' && message.params.item.type === 'agentMessage',
  )
  assert.ok(reasoningDone >= 0 && answerStart > reasoningDone)
})

test('approval and user questions retain their structured timeline items around hook runs', async () => {
  const { messages, turn } = await present(async (handlers) => {
    await handlers.onEvent({ type: 'text_delta', delta: 'Before hook.' })
    await handlers.onEvent({
      type: 'hook_run',
      hookId: 'pre',
      hookEvent: 'PreToolUse',
      status: 'completed',
      entries: [],
    })
    await handlers.onEvent({ type: 'message_boundary' })
    await handlers.onEvent({ type: 'text_delta', delta: 'Before approval.' })
    await handlers.onPermissionRequest({
      type: 'permission_request',
      requestId: 'approval',
      toolUseId: 'shell',
      toolName: 'Bash',
      input: { command: 'pwd' },
    })
    await handlers.onEvent({ type: 'tool_result', toolUseId: 'shell', content: '/tmp' })
    await handlers.onEvent({ type: 'text_delta', delta: 'Before question.' })
    await handlers.onUserInputRequest?.({
      type: 'user_input_request',
      requestId: 'question',
      toolUseId: 'question',
      questions: [
        {
          id: 'choice',
          header: 'Choice',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Continue' }],
          isOther: true,
          isSecret: false,
        },
      ],
    })
    await handlers.onEvent({ type: 'text_delta', delta: 'Finished.' })
  })
  assert.deepEqual(
    turn.items.map((item) => item.type),
    [
      'userMessage',
      'agentMessage',
      'agentMessage',
      'commandExecution',
      'agentMessage',
      'dynamicToolCall',
      'agentMessage',
    ],
  )
  assert.deepEqual(
    assistantItems(turn.items).map((item) => item.phase),
    ['commentary', 'commentary', 'commentary', 'final_answer'],
  )
  const completedIds = messages
    .filter((message) => message.method === 'item/completed')
    .map((message) => message.params.item.id)
  assert.equal(new Set(completedIds).size, completedIds.length)
})

test('hook telemetry and duplicate tools do not split a final Markdown response', async () => {
  const { turn } = await present(
    emit([
      { type: 'tool_use', toolUseId: 'read', toolName: 'Read', input: { file_path: 'app.ts' } },
      { type: 'tool_result', toolUseId: 'read', content: 'file content' },
      { type: 'text_delta', delta: '**Final' },
      { type: 'hook_run', hookId: 'stop', hookEvent: 'Stop', status: 'completed', entries: [] },
      { type: 'tool_use', toolUseId: 'read', toolName: 'Read', input: { file_path: 'app.ts' } },
      { type: 'text_delta', delta: ' answer**' },
      { type: 'hook_run', hookId: 'stop', hookEvent: 'Stop', status: 'completed', entries: [] },
      { type: 'completed', success: true },
    ]),
  )
  assert.deepEqual(
    assistantItems(turn.items).map((item) => [item.text, item.phase]),
    [['**Final answer**', 'final_answer']],
  )
})

test('completed structured text is not replaced by a fabricated fallback after a boundary', async () => {
  const { turn } = await present(
    emit([{ type: 'text_delta', delta: '{"result":"real"}' }, { type: 'message_boundary' }]),
    { outputSchema: { type: 'object', properties: { result: { type: 'string' } } } },
  )
  assert.deepEqual(
    assistantItems(turn.items).map((item) => item.text),
    ['{"result":"real"}'],
  )
})

test('failed partial messages are completed as commentary, never final answers', async () => {
  const { messages, turn } = await present(
    emit([
      { type: 'text_delta', delta: 'Partial response.' },
      { type: 'error', message: 'Connection lost' },
    ]),
  )
  assert.equal(turn.status, 'failed')
  assert.equal(assistantItems(turn.items)[0]?.phase, 'commentary')
  assert.equal(messages.filter((message) => message.method === 'item/completed').length, 1)
  // An error with no Codex code is 'other', as Codex reports one.
  const expected = { message: 'Connection lost', codexErrorInfo: 'other', additionalDetails: null }
  assert.deepEqual(turn.error, expected)
  assert.deepEqual(
    messages.filter((message) => message.method === 'error').map((message) => message.params),
    [{ threadId: turn.threadId, turnId: turn.id, willRetry: false, error: expected }],
  )
})

test('Claude failures map onto the Codex error codes the App knows', () => {
  const failure = (fields: Partial<RuntimeFailure>): RuntimeFailure => ({
    terminalReason: 'api_error',
    category: null,
    status: null,
    ...fields,
  })
  const cases: Array<[RuntimeFailure | null, unknown]> = [
    [
      failure({ terminalReason: 'prompt_too_long', category: 'invalid_request', status: 400 }),
      'contextWindowExceeded',
    ],
    [failure({ category: 'overloaded', status: 529 }), 'serverOverloaded'],
    [failure({ status: 529 }), 'serverOverloaded'],
    [failure({ category: 'rate_limit', status: 429 }), 'rateLimitExceeded'],
    [failure({ category: 'invalid_request', status: 400 }), 'badRequest'],
    [failure({ category: 'server_error', status: 500 }), 'internalServerError'],
    [failure({ status: 503 }), 'internalServerError'],
    [failure({}), { httpConnectionFailed: { httpStatusCode: null } }],
    [failure({ category: 'unknown' }), { httpConnectionFailed: { httpStatusCode: null } }],
    // The App answers these codes with ChatGPT account flows.
    [failure({ category: 'authentication_failed', status: 401 }), 'other'],
    [failure({ category: 'billing_error', status: 402 }), 'other'],
    [failure({ terminalReason: 'max_turns' }), 'other'],
    [null, 'other'],
  ]
  for (const [input, code] of cases) {
    assert.deepEqual(codexErrorInfo(input), code, JSON.stringify(input))
  }
  // A retry is a disconnected stream, as Codex reports every stream retry,
  // except an overloaded API, which the App shows as a busy server.
  assert.deepEqual(codexErrorInfo(failure({ category: 'server_error', status: 500 }), true), {
    responseStreamDisconnected: { httpStatusCode: 500 },
  })
  assert.deepEqual(codexErrorInfo(failure({ category: 'rate_limit', status: 429 }), true), {
    responseStreamDisconnected: { httpStatusCode: 429 },
  })
  assert.equal(
    codexErrorInfo(failure({ category: 'overloaded', status: 529 }), true),
    'serverOverloaded',
  )
  assert.deepEqual(
    retryTurnError({
      type: 'retrying',
      attempt: 3,
      maxRetries: 10,
      status: 500,
      category: 'server_error',
      delayMs: 4_400,
    }),
    {
      message: 'Reconnecting... 3/10',
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 500 } },
      additionalDetails: 'HTTP 500 server error; retrying in 4s',
    },
  )
})

test('retries show as passing Reconnecting errors in chats, not in helper turns', async () => {
  const retrying: RuntimeEvent[] = [
    {
      type: 'retrying',
      attempt: 1,
      maxRetries: 10,
      status: 429,
      category: 'rate_limit',
      delayMs: 600,
    },
    { type: 'text_delta', delta: '{"result":"ok"}' },
  ]
  const chat = await present(emit(retrying))
  assert.equal(chat.turn.status, 'completed')
  assert.deepEqual(
    chat.messages.filter((message) => message.method === 'error').map((message) => message.params),
    [
      {
        threadId: chat.turn.threadId,
        turnId: chat.turn.id,
        willRetry: true,
        error: {
          message: 'Reconnecting... 1/10',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } },
          additionalDetails: 'HTTP 429 rate limit; retrying in 1s',
        },
      },
    ],
  )
  assert.equal(chat.turn.error, null)
  assert.equal(
    chat.replay.items.some((item: { type: string }) => item.type === 'error'),
    false,
  )

  const helper = await present(emit(retrying), {
    outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
  })
  assert.equal(helper.turn.status, 'completed')
  assert.equal(helper.messages.filter((message) => message.method === 'error').length, 0)
})

test('plan mode: the ExitPlanMode plan is the one plan item, prose stays agent messages', async () => {
  const plan = '## Plan\n\n1. Inspect\n2. Implement'
  const { turn, messages, replay } = await present(
    emit([
      { type: 'message_boundary' },
      { type: 'text_delta', delta: 'I looked around.' },
      { type: 'tool_use', toolUseId: 'exit-1', toolName: 'ExitPlanMode', input: { plan } },
      { type: 'proposed_plan', toolUseId: 'exit-1', text: plan },
      { type: 'tool_result', toolUseId: 'exit-1', content: 'delivered', isError: true },
      { type: 'text_delta', delta: 'Plan ready.' },
      { type: 'completed', success: true },
    ]),
    { planMode: true },
  )
  assert.equal(turn.status, 'completed')
  const shown = turn.items.filter((item) => item.type !== 'userMessage')
  assert.deepEqual(
    shown.map((item) => item.type),
    ['agentMessage', 'plan', 'agentMessage'],
    'ExitPlanMode is the card, not a tool item',
  )
  assert.deepEqual(
    shown.map((item) => (item as { text: string }).text),
    ['I looked around.', plan, 'Plan ready.'],
  )
  assert.equal(assistantItems(turn.items).at(-1)?.phase, 'final_answer')
  const planEvents = messages
    .filter(
      (message) => message.params?.item?.type === 'plan' || message.method?.startsWith('item/plan'),
    )
    .map((message) => [message.method, message.params.item?.text ?? message.params.delta])
  assert.deepEqual(planEvents, [
    ['item/started', ''],
    ['item/plan/delta', plan],
    ['item/completed', plan],
  ])
  assert.deepEqual(
    replay.items.filter((item: ThreadItem) => item.type === 'plan').map((item: any) => item.text),
    [plan],
  )
})

test('a plan revised in the same turn replaces its card', async () => {
  const { turn, messages } = await present(
    emit([
      { type: 'proposed_plan', toolUseId: 'exit-1', text: '1. First draft' },
      { type: 'proposed_plan', toolUseId: 'exit-2', text: '1. Final plan' },
      { type: 'completed', success: true },
    ]),
    { planMode: true },
  )
  const plans = turn.items.filter((item) => item.type === 'plan')
  assert.deepEqual(
    plans.map((item) => item.text),
    ['1. Final plan'],
  )
  const completedPlans = messages.filter(
    (message) => message.method === 'item/completed' && message.params.item.type === 'plan',
  )
  assert.equal(new Set(completedPlans.map((message) => message.params.item.id)).size, 1)
  assert.equal(completedPlans.at(-1)?.params.item.text, '1. Final plan')
})

test('an interrupt completes the message still streaming before the turn', async () => {
  // Plan mode streams prose as an agent message too; only ExitPlanMode
  // makes a plan item.
  for (const planMode of [false, true]) {
    const { messages, turn, replay } = await present(
      async (handlers, { interrupt }) => {
        await handlers.onEvent({ type: 'text_delta', delta: 'Started the workflow.' })
        await interrupt()
      },
      { planMode },
    )
    assert.equal(turn.status, 'interrupted')
    const order = messages
      .filter(
        (message) => message.method === 'item/completed' || message.method === 'turn/completed',
      )
      .map((message) => message.params.item?.type ?? message.method)
    assert.deepEqual(order, ['agentMessage', 'turn/completed'])
    const live = messages.find((message) => message.method === 'item/completed')?.params.item
    assert.equal(live.text, 'Started the workflow.')
    assert.deepEqual(
      replay.items.find((item: ThreadItem) => item.type === 'agentMessage'),
      live,
    )
  }
})

test('a turn that ends early fails the tool calls still running before the turn', async () => {
  for (const ending of ['interrupt', 'error'] as const) {
    const { messages, turn, replay } = await present(async (handlers, { interrupt }) => {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'sleep',
        toolName: 'Bash',
        input: { command: 'sleep 10' },
      })
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'read',
        toolName: 'Read',
        input: { file_path: 'notes.md' },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId: 'read', content: 'notes' })
      if (ending === 'error') throw new Error('Claude exited')
      await interrupt()
      // The result that arrives after the interrupt is dropped.
      await handlers.onEvent({ type: 'tool_result', toolUseId: 'sleep', content: 'late' })
    })
    assert.equal(turn.status, ending === 'interrupt' ? 'interrupted' : 'failed')
    const order = messages
      .filter(
        (message) => message.method === 'item/completed' || message.method === 'turn/completed',
      )
      .map((message) =>
        message.params.item
          ? `${message.params.item.type}:${message.params.item.status}`
          : message.method,
      )
    assert.deepEqual(order, [
      'commandExecution:completed',
      'commandExecution:failed',
      'turn/completed',
    ])
    const live = messages.find(
      (message) =>
        message.method === 'item/completed' && message.params.item.command === 'sleep 10',
    )?.params.item
    assert.equal(live.exitCode, null)
    assert.equal(typeof live.durationMs, 'number')
    assert.deepEqual(
      replay.items.find(
        (item: ThreadItem) => item.type === 'commandExecution' && item.command === 'sleep 10',
      ),
      live,
    )
  }
})

test('an image Read asks about and falls back to its Read command', async () => {
  const image = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
  ]
  let decision: string | null = null
  const { messages, turn, replay } = await present(
    async (handlers, { interrupt }) => {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'asked',
        toolName: 'Read',
        input: { file_path: '/elsewhere/chart.png' },
      })
      decision = (
        await handlers.onPermissionRequest({
          type: 'permission_request',
          requestId: 'perm-asked',
          toolUseId: 'asked',
          toolName: 'Read',
          input: { file_path: '/elsewhere/chart.png' },
        })
      ).decision
      await handlers.onEvent({ type: 'tool_result', toolUseId: 'asked', content: image })
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'open',
        toolName: 'Read',
        input: { file_path: 'late.png' },
      })
      await interrupt()
    },
    // Full access, the default, would accept without asking.
    { sandbox: 'workspace-write' },
  )
  assert.equal(decision, 'accept')
  const cwd = messages.find((message) => message.id === 1)?.result.thread.cwd
  const started = messages
    .filter((message) => message.method === 'item/started')
    .map((message) => message.params.item)
    .filter((item) => item.type !== 'userMessage')
  assert.deepEqual(
    started.map(({ type, path }) => ({ type, path })),
    [
      { type: 'imageView', path: '/elsewhere/chart.png' },
      { type: 'imageView', path: join(cwd, 'late.png') },
    ],
  )
  // The App asks about the Read on the command card, as for a command.
  const request = messages.find(
    (message) => message.method === 'item/commandExecution/requestApproval',
  )?.params
  assert.deepEqual(
    {
      itemId: request?.itemId,
      command: request?.command,
      cwd: request?.cwd,
      commandActions: request?.commandActions,
      availableDecisions: request?.availableDecisions,
    },
    {
      itemId: started[0].id,
      command: 'Read /elsewhere/chart.png',
      cwd,
      commandActions: [
        {
          type: 'read',
          command: 'Read /elsewhere/chart.png',
          name: 'chart.png',
          path: '/elsewhere/chart.png',
        },
      ],
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    },
  )
  const completed = messages
    .filter((message) => message.method === 'item/completed')
    .map((message) => message.params.item)
  assert.deepEqual(completed[0], {
    type: 'imageView',
    id: started[0].id,
    path: '/elsewhere/chart.png',
  })
  // The image a stopped Read never showed is the Read that failed.
  assert.deepEqual(
    {
      id: completed[1].id,
      type: completed[1].type,
      command: completed[1].command,
      status: completed[1].status,
      aggregatedOutput: completed[1].aggregatedOutput,
      exitCode: completed[1].exitCode,
    },
    {
      id: started[1].id,
      type: 'commandExecution',
      command: 'Read late.png',
      status: 'failed',
      aggregatedOutput: null,
      exitCode: null,
    },
  )
  assert.equal(turn.status, 'interrupted')
  assert.deepEqual(replay.items, turn.items)
})

test('subagent results keep only the report, in both CLI trailer formats', () => {
  const legacy = parseSubagentTrailer(
    "found it\nagentId: a1b2c3d4e5f6a7b8 (use SendMessage with to: 'a1b2c3d4e5f6a7b8' to continue this agent)\n<usage>total_tokens: 12\ntool_uses: 1\nduration_ms: 3</usage>",
  )
  assert.deepEqual(legacy, {
    cleanText: 'found it',
    agentId: 'a1b2c3d4e5f6a7b8',
    usage: { totalTokens: 12, toolUses: 1, durationMs: 3 },
  })

  const framed = parseSubagentTrailer(
    [
      '  SECURITY WARNING: a note for the parent model.',
      '[Subagent hand-back] The text below is the final report of a subagent. The report follows:',
      '  Done.',
      '  [Subagent hand-back] quoted by the agent, so it stays',
      '  ',
      '    nested indent',
      "agentId: aef61b963198d372e (use SendMessage with to: 'aef61b963198d372e', summary: '<5-10 word recap>' to continue this agent)",
      'worktreePath: /tmp/wt',
      'worktreeBranch: agent-wt',
      '<usage>subagent_tokens: 18437',
      'tool_uses: 1',
      'duration_ms: 97082</usage>',
    ].join('\n'),
  )
  assert.deepEqual(framed, {
    cleanText: 'Done.\n[Subagent hand-back] quoted by the agent, so it stays\n\n  nested indent',
    agentId: 'aef61b963198d372e',
    usage: { totalTokens: 18437, toolUses: 1, durationMs: 97082 },
  })
})
