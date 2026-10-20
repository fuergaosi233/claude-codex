import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DYNAMIC_TOOLS_SERVER,
  dynamicToolCallResult,
  dynamicToolResponse,
  dynamicToolServers,
  dynamicToolsEnabled,
  parseDynamicTools,
} from '../src/dynamic-tools.mjs'

const adapter = resolve('dist/src/adapter.mjs')

const listArtifacts = {
  type: 'function',
  name: 'list_artifacts',
  description: 'List the artifacts of a chat.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { query: { type: 'string' } },
  },
}

// The canonical form, as the App sends it.
const appTools = [
  {
    type: 'namespace',
    name: 'codex_app',
    description: 'Tools provided by the app.',
    tools: [
      listArtifacts,
      {
        type: 'function',
        name: 'restore_worktree',
        description: 'Restore a worktree.',
        inputSchema: { type: 'object', properties: {} },
        deferLoading: true,
      },
    ],
  },
  {
    type: 'function',
    name: 'echo',
    description: 'Echo the input.',
    inputSchema: { properties: {} },
  },
]

test('CLAUDE_CODEX_DYNAMIC_TOOLS=1 is the only opt-in', () => {
  assert.equal(dynamicToolsEnabled({}), false)
  assert.equal(dynamicToolsEnabled({ CLAUDE_CODEX_DYNAMIC_TOOLS: '0' }), false)
  assert.equal(dynamicToolsEnabled({ CLAUDE_CODEX_DYNAMIC_TOOLS: 'true' }), false)
  assert.equal(dynamicToolsEnabled({ CLAUDE_CODEX_DYNAMIC_TOOLS: '1' }), true)
})

test('dynamic tool specs read in both of the forms Codex takes', () => {
  assert.deepEqual(parseDynamicTools(undefined), [])
  assert.deepEqual(parseDynamicTools(null), [])
  assert.deepEqual(parseDynamicTools(appTools), appTools)
  // The flat form groups by namespace in first-seen order, and a tool kept
  // out of the context is deferred.
  assert.deepEqual(
    parseDynamicTools([
      { namespace: 'codex_app', name: 'a', description: 'A', inputSchema: {} },
      { name: 'b', description: 'B', inputSchema: { type: 'object' } },
      {
        namespace: 'codex_app',
        name: 'c',
        description: 'C',
        inputSchema: {},
        exposeToContext: false,
      },
    ]),
    [
      {
        type: 'namespace',
        name: 'codex_app',
        description: '',
        tools: [
          { type: 'function', name: 'a', description: 'A', inputSchema: {} },
          { type: 'function', name: 'c', description: 'C', inputSchema: {}, deferLoading: true },
        ],
      },
      { type: 'function', name: 'b', description: 'B', inputSchema: { type: 'object' } },
    ],
  )
})

test('dynamic tool specs Codex rejects fail with its messages', () => {
  const fn = (name: string, extra: Record<string, unknown> = {}) => ({
    type: 'function',
    name,
    description: '',
    inputSchema: { type: 'object' },
    ...extra,
  })
  const namespace = (name: string, tools: unknown[]) => ({
    type: 'namespace',
    name,
    description: '',
    tools,
  })
  const rejects = (value: unknown, message: string) =>
    assert.throws(() => parseDynamicTools(value), { message })
  rejects({}, 'dynamicTools must be an array')
  rejects(
    [fn('a'), { name: 'b', description: '', inputSchema: {} }],
    'dynamic tools must use either canonical or legacy format consistently',
  )
  rejects(
    [namespace('web', [fn('a')])],
    'dynamic tool namespace collides with a reserved Responses API namespace: web',
  )
  rejects([namespace('mcp__x', [fn('a')])], 'dynamic tool namespace is reserved: mcp__x')
  rejects([fn('mcp')], 'dynamic tool name is reserved: mcp')
  rejects([fn('a b')], 'dynamic tool name must match ^[a-zA-Z0-9_-]+$ to match Responses API: a b')
  rejects(
    [fn('x'.repeat(129))],
    `dynamic tool name must be at most 128 characters to match Responses API: ${'x'.repeat(129)}`,
  )
  rejects([fn(' a')], 'dynamic tool name has leading/trailing whitespace:  a')
  rejects([fn('a'), fn('a')], 'duplicate dynamic tool name: a')
  rejects([namespace('ns', [fn('a'), fn('a')])], 'duplicate dynamic tool name in namespace ns: a')
  rejects(
    [namespace('ns', [fn('a')]), namespace('ns', [fn('b')])],
    'duplicate dynamic tool namespace: ns',
  )
  rejects([namespace('ns', [])], 'dynamic tool namespace must contain at least one tool: ns')
  rejects([fn('a', { deferLoading: true })], 'deferred dynamic tool must include a namespace: a')
  rejects(
    [fn('a', { inputSchema: { type: 'string' } })],
    'dynamic tool input schema is not supported for a: the input schema must describe an object, not "string"',
  )
  rejects([{ type: 'function', name: 'a', description: '' }], 'dynamic tool is missing inputSchema')
  // A tool may share its name with one in a namespace.
  assert.equal(parseDynamicTools([fn('a'), namespace('ns', [fn('a')])]).length, 2)
})

test('each namespace becomes an MCP server, and the loose tools share one', () => {
  assert.deepEqual(dynamicToolServers(parseDynamicTools(appTools)), [
    {
      server: 'codex_app',
      namespace: 'codex_app',
      description: 'Tools provided by the app.',
      tools: [
        {
          name: 'list_artifacts',
          description: 'List the artifacts of a chat.',
          // The schema loses its draft marker and states its object type.
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          deferLoading: false,
        },
        {
          name: 'restore_worktree',
          description: 'Restore a worktree.',
          inputSchema: { type: 'object', properties: {} },
          deferLoading: true,
        },
      ],
    },
    {
      server: DYNAMIC_TOOLS_SERVER,
      namespace: null,
      description: '',
      tools: [
        {
          name: 'echo',
          description: 'Echo the input.',
          inputSchema: { properties: {}, type: 'object' },
          deferLoading: false,
        },
      ],
    },
  ])
  // Claude takes tool names of at most 64 characters, mcp__<server>__ included.
  const long = 'x'.repeat(60)
  assert.deepEqual(
    dynamicToolServers([
      {
        type: 'namespace',
        name: 'ns',
        description: '',
        tools: [
          { type: 'function', name: long, description: '', inputSchema: {} },
          { type: 'function', name: 'short', description: '', inputSchema: {} },
        ],
      },
      { type: 'function', name: long, description: '', inputSchema: {} },
    ]).map((server) => [server.server, server.tools.map((tool) => tool.name)]),
    [['ns', ['short']]],
  )
  // A namespace of the loose tools' server name keeps it.
  assert.deepEqual(
    dynamicToolServers([
      {
        type: 'namespace',
        name: DYNAMIC_TOOLS_SERVER,
        description: '',
        tools: [{ type: 'function', name: 'a', description: '', inputSchema: {} }],
      },
      { type: 'function', name: 'b', description: '', inputSchema: {} },
    ]).map((server) => [server.server, server.namespace]),
    [[DYNAMIC_TOOLS_SERVER, DYNAMIC_TOOLS_SERVER]],
  )
})

test('client answers are checked as Codex checks them', () => {
  const ok = {
    contentItems: [
      { type: 'inputText', text: 'done' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
      { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AAAA' },
    ],
    success: true,
  }
  assert.deepEqual(dynamicToolResponse(ok), ok)
  const failure = (text: string) => ({
    contentItems: [{ type: 'inputText', text }],
    success: false,
  })
  const invalid = failure('dynamic tool response was invalid')
  assert.deepEqual(dynamicToolResponse(null), invalid)
  assert.deepEqual(dynamicToolResponse({ contentItems: [] }), invalid)
  assert.deepEqual(
    dynamicToolResponse({ contentItems: [{ type: 'text' }], success: true }),
    invalid,
  )
  assert.deepEqual(
    dynamicToolResponse({
      contentItems: [{ type: 'inputImage', imageUrl: 'HTTPS://example.com/a.png' }],
      success: true,
    }),
    failure('remote image URLs are not supported; use an inline data URL instead'),
  )
  assert.deepEqual(
    dynamicToolResponse({
      contentItems: [{ type: 'inputAudio', audioUrl: 'file:///a.wav' }],
      success: true,
    }),
    failure('audio URLs must use an inline data URL'),
  )
})

test('answers reach Claude as MCP results it can read', () => {
  assert.deepEqual(
    dynamicToolCallResult({
      contentItems: [
        { type: 'inputText', text: 'done' },
        { type: 'inputImage', imageUrl: 'data:image/JPEG;charset=x;base64,AAAA' },
        { type: 'inputImage', imageUrl: 'data:image/png,raw' },
        { type: 'inputImage', imageUrl: '/tmp/a.png' },
        { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AAAA' },
      ],
      success: true,
    }),
    {
      content: [
        { type: 'text', text: 'done' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'text', text: '[image omitted]' },
        { type: 'text', text: '[image omitted]' },
        { type: 'text', text: '[audio omitted]' },
      ],
    },
  )
  assert.deepEqual(
    dynamicToolCallResult({ contentItems: [{ type: 'inputText', text: 'no' }], success: false }),
    { content: [{ type: 'text', text: 'no' }], isError: true },
  )
})

// The App's side of the protocol: requests, notifications, and answers to
// the adapter's item/tool/call requests.
class App {
  readonly messages: any[] = []
  // The answer to an item/tool/call request; null leaves it unanswered.
  answer: (params: any) => { result: unknown } | { error: unknown } | null = () => ({
    result: { contentItems: [{ type: 'inputText', text: 'ok' }], success: true },
  })
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >()
  private nextId = 1
  private buffer = ''

  constructor(home: string, enabled: boolean) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    }
    if (enabled) env.CLAUDE_CODEX_DYNAMIC_TOOLS = '1'
    else delete env.CLAUDE_CODEX_DYNAMIC_TOOLS
    this.proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    this.proc.stderr.resume()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.read(chunk))
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++
    this.write({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async waitFor(match: (message: any) => boolean, from = 0): Promise<any> {
    for (let waited = 0; waited < 10_000; waited += 20) {
      const found = this.messages.slice(from).find(match)
      if (found) return found
      await delay(20)
    }
    throw new Error('the message never arrived')
  }

  // Runs a turn to its end; returns the turn id and the messages it brought.
  async turn(threadId: string, text: string): Promise<{ turnId: string; messages: any[] }> {
    const from = this.messages.length
    const { turn } = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    await this.waitFor(
      (message) => message.method === 'turn/completed' && message.params.turn.id === turn.id,
      from,
    )
    return { turnId: turn.id, messages: this.messages.slice(from) }
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    const exited = once(this.proc, 'exit')
    this.proc.kill()
    await exited
  }

  private write(message: unknown): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method == null) {
        const waiter = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) waiter?.reject(new Error(message.error.message))
        else waiter?.resolve(message.result)
        continue
      }
      this.messages.push(message)
      if (message.id != null && message.method === 'item/tool/call') {
        const answer = this.answer(message.params)
        if (answer) this.write({ jsonrpc: '2.0', id: message.id, ...answer })
      }
    }
  }
}

async function withApp(
  enabled: boolean,
  run: (app: App, home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const app = new App(home, enabled)
  try {
    await run(app, home)
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

function agentText(messages: any[]): string {
  return messages
    .filter((message) => message.method === 'item/agentMessage/delta')
    .map((message) => message.params.delta)
    .join('')
}

// The answer the mock runtime's call got back.
function answerSeen(messages: any[]): unknown {
  const text = agentText(messages)
  const at = text.indexOf('dynamic=')
  return at < 0 ? null : JSON.parse(text.slice(at + 'dynamic='.length))
}

function dynamicItems(messages: any[], method: string): any[] {
  return messages
    .filter(
      (message) => message.method === method && message.params.item.type === 'dynamicToolCall',
    )
    .map((message) => message.params.item)
}

test('a dynamic tool call round-trips through item/tool/call as a dynamicToolCall item', async () => {
  await withApp(true, async (app, home) => {
    const { thread } = await app.request('thread/start', { cwd: home, dynamicTools: appTools })
    const answer = {
      contentItems: [
        { type: 'inputText', text: '2 artifacts' },
        { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
      ],
      success: true,
    }
    app.answer = () => ({ result: answer })
    const { turnId, messages } = await app.turn(thread.id, 'dynamic tool check')
    const callId = `call-${turnId}`

    const methods = messages.map((message) => message.method)
    const started = methods.findIndex(
      (method, index) =>
        method === 'item/started' && messages[index].params.item.type === 'dynamicToolCall',
    )
    const request = messages.find((message) => message.method === 'item/tool/call')
    assert.ok(started >= 0 && started < messages.indexOf(request))
    assert.deepEqual(request.params, {
      threadId: thread.id,
      turnId,
      callId,
      namespace: 'codex_app',
      tool: 'list_artifacts',
      arguments: { query: 'mock' },
    })
    assert.deepEqual(dynamicItems(messages, 'item/started'), [
      {
        type: 'dynamicToolCall',
        id: callId,
        namespace: 'codex_app',
        tool: 'list_artifacts',
        arguments: { query: 'mock' },
        status: 'inProgress',
        contentItems: null,
        success: null,
        durationMs: null,
      },
    ])
    const [completed] = dynamicItems(messages, 'item/completed')
    assert.equal(completed.id, callId)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(completed.contentItems, answer.contentItems)
    assert.equal(completed.success, true)
    assert.equal(typeof completed.durationMs, 'number')
    assert.ok(
      messages.some(
        (message) =>
          message.method === 'serverRequest/resolved' && message.params.requestId === request.id,
      ),
    )
    // Claude sees every tool the thread registered, and reads the answer.
    assert.match(
      agentText(messages),
      /^tools=codex_app:list_artifacts,restore_worktree;dynamic_tools:echo/,
    )
    assert.deepEqual(answerSeen(messages), answer)
    // The item stays in the thread's history.
    const read = await app.request('thread/read', { threadId: thread.id, includeTurns: true })
    const item = read.thread.turns
      .flatMap((turn: any) => turn.items)
      .find((entry: any) => entry.type === 'dynamicToolCall')
    assert.deepEqual(item, completed)
  })
})

test('a failed, refused or unanswered call reaches Claude as Codex reports it', async () => {
  await withApp(true, async (app, home) => {
    const { thread } = await app.request('thread/start', { cwd: home, dynamicTools: appTools })
    const failure = (text: string) => ({
      contentItems: [{ type: 'inputText', text }],
      success: false,
    })

    app.answer = () => ({ error: { code: -32000, message: 'tool crashed' } })
    let turn = await app.turn(thread.id, 'dynamic tool check')
    assert.deepEqual(answerSeen(turn.messages), failure('dynamic tool request failed'))
    let [completed] = dynamicItems(turn.messages, 'item/completed')
    assert.equal(completed.status, 'failed')
    assert.equal(completed.success, false)

    app.answer = () => ({
      result: {
        contentItems: [{ type: 'inputImage', imageUrl: 'https://example.com/a.png' }],
        success: true,
      },
    })
    turn = await app.turn(thread.id, 'dynamic tool check')
    assert.deepEqual(
      answerSeen(turn.messages),
      failure('remote image URLs are not supported; use an inline data URL instead'),
    )

    // An interrupt while the App has not answered closes the call as
    // cancelled, the way Codex does, and resolves the request.
    app.answer = () => null
    const from = app.messages.length
    const { turn: running } = await app.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'dynamic tool check', text_elements: [] }],
    })
    const request = await app.waitFor((message) => message.method === 'item/tool/call', from)
    await app.request('turn/interrupt', { threadId: thread.id, turnId: running.id })
    await app.waitFor(
      (message) => message.method === 'turn/completed' && message.params.turn.id === running.id,
      from,
    )
    await app.waitFor(
      (message) =>
        message.method === 'serverRequest/resolved' && message.params.requestId === request.id,
      from,
    )
    ;[completed] = dynamicItems(app.messages.slice(from), 'item/completed')
    assert.deepEqual(
      {
        status: completed.status,
        contentItems: completed.contentItems,
        success: completed.success,
      },
      { status: 'failed', contentItems: [], success: false },
    )
  })
})

test('dynamic tools outlive a restart and pass to a fork', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  let app = new App(home, true)
  try {
    const { thread } = await app.request('thread/start', { cwd: home, dynamicTools: appTools })
    await app.close()
    app = new App(home, true)
    await app.request('thread/resume', { threadId: thread.id })
    let turn = await app.turn(thread.id, 'dynamic tool check')
    assert.match(agentText(turn.messages), /^tools=codex_app:list_artifacts,restore_worktree;/)
    assert.equal(dynamicItems(turn.messages, 'item/completed').length, 1)

    const { thread: fork } = await app.request('thread/fork', { threadId: thread.id })
    turn = await app.turn(fork.id, 'dynamic tool check')
    assert.match(agentText(turn.messages), /^tools=codex_app:list_artifacts,restore_worktree;/)

    // A thread started without tools has none.
    const { thread: plain } = await app.request('thread/start', { cwd: home })
    turn = await app.turn(plain.id, 'dynamic tool check')
    assert.equal(agentText(turn.messages), 'tools=none')
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('with the switch on, thread/start refuses specs Codex refuses', async () => {
  await withApp(true, async (app, home) => {
    await assert.rejects(
      app.request('thread/start', {
        cwd: home,
        dynamicTools: [{ type: 'namespace', name: 'web', description: '', tools: [listArtifacts] }],
      }),
      { message: /reserved Responses API namespace: web/ },
    )
    // The flat form works too.
    const { thread } = await app.request('thread/start', {
      cwd: home,
      dynamicTools: [{ namespace: 'codex_app', name: 'a', description: '', inputSchema: {} }],
    })
    const turn = await app.turn(thread.id, 'dynamic tool check')
    assert.match(agentText(turn.messages), /^tools=codex_app:a/)
    assert.deepEqual(answerSeen(turn.messages), {
      contentItems: [{ type: 'inputText', text: 'ok' }],
      success: true,
    })
  })
})

test('dynamic tools are off by default', async () => {
  await withApp(false, async (app, home) => {
    // Unchecked and dropped: Claude sees none of them, valid or not.
    const { thread } = await app.request('thread/start', {
      cwd: home,
      dynamicTools: [...appTools, { type: 'namespace', name: 'web', description: '', tools: [] }],
    })
    const turn = await app.turn(thread.id, 'dynamic tool check')
    assert.equal(agentText(turn.messages), 'tools=none')
    assert.equal(
      turn.messages.some((message) => message.method === 'item/tool/call'),
      false,
    )
  })
})
