import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type {
  ClaudeRuntime,
  RpcPeer,
  RuntimeEvent,
  RuntimeHandlers,
  ThreadItem,
  WireMessage,
} from '../src/types.mjs'

type CapturedMessage = { method?: string; id?: unknown; params?: any; result?: any; error?: any }

async function present(
  run: (handlers: RuntimeHandlers) => Promise<void>,
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
    runTurn: async (_context, handlers) => run(handlers),
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
    ['userMessage', 'agentMessage', 'mcpToolCall', 'agentMessage'],
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
    ['agentMessage', 'mcpToolCall', 'agentMessage'],
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
  const reasoning = turn.items.find((item) => item.type === 'reasoning')
  assert.equal(reasoning?.type, 'reasoning')
  assert.deepEqual(reasoning.summary, [])
  assert.deepEqual(reasoning.content, ['Think carefully.'])
  assert.equal(
    messages.some((message) => message.method === 'item/reasoning/summaryTextDelta'),
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

test('hooks, approval and user questions retain their structured timeline items', async () => {
  const { messages, turn } = await present(async (handlers) => {
    await handlers.onEvent({ type: 'text_delta', delta: 'Before hook.' })
    await handlers.onEvent({
      type: 'hook',
      hookName: 'PreToolUse',
      status: 'done',
      decision: null,
      message: 'Checked',
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
      'hookPrompt',
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
      { type: 'hook', hookName: 'Stop', status: 'done', decision: null, message: null },
      { type: 'tool_use', toolUseId: 'read', toolName: 'Read', input: { file_path: 'app.ts' } },
      { type: 'text_delta', delta: ' answer**' },
      { type: 'hook', hookName: 'Stop', status: 'done', decision: null, message: null },
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
})

test('plan output retains its native plan item and complete Markdown', async () => {
  const { turn, messages } = await present(
    emit([
      { type: 'message_boundary' },
      { type: 'text_delta', delta: '## Plan\n\n' },
      { type: 'text_delta', delta: '1. Inspect\n2. Implement' },
      { type: 'completed', success: true },
    ]),
    { planMode: true },
  )
  const plans = turn.items.filter((item) => item.type === 'plan')
  assert.equal(plans.length, 1)
  assert.equal(plans[0]?.text, '## Plan\n\n1. Inspect\n2. Implement')
  assert.equal(assistantItems(turn.items).length, 0)
  assert.equal(messages.filter((message) => message.method === 'item/completed').length, 1)
})
