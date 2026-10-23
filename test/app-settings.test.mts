import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { INVALID_REQUEST } from '../src/host-methods.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

// What the Codex App's settings write with config/value/write and
// config/batchWrite, and what Claude threads do with it (app-settings.mts).

async function withEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// Settings that would leak in from the test runner's own environment.
const clean = {
  CLAUDE_CODEX_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CODEX_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined,
  CLAUDE_CODEX_CLAUDE_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CLAUDE_PERMISSIONS: undefined,
  CLAUDE_CODEX_APP_MCP_SERVERS: undefined,
  CLAUDE_CODEX_WEBSEARCH: undefined,
}

interface Response {
  result?: any
  error?: { code: number; message: string }
}

interface TestApp {
  // A request that must succeed; its result.
  request: (method: string, params: Record<string, unknown>) => Promise<any>
  // A request that may fail; the whole response.
  send: (method: string, params: Record<string, unknown>) => Promise<Response>
  // Runs a turn and returns the context the runtime got.
  turn: (threadId: string, params?: Record<string, unknown>) => Promise<RuntimeTurnContext>
  notifications: Array<{ method: string; params: any }>
}

// An app server over a fake runtime that records each turn's context. The
// adapter keeps its settings in <root>/adapter; CODEX_HOME is <root>/codex.
async function withServer(
  root: string,
  env: Record<string, string | undefined>,
  run: (app: TestApp) => Promise<void>,
): Promise<void> {
  const vars = {
    ...clean,
    CLAUDE_CODEX_HOME: join(root, 'adapter'),
    CODEX_HOME: join(root, 'codex'),
    ...env,
  }
  await withEnv(vars, async () => {
    const store = new SessionStore(join(root, 'state.sqlite'))
    const contexts: RuntimeTurnContext[] = []
    const responses = new Map<unknown, Response>()
    const notifications: TestApp['notifications'] = []
    let finish: (() => void) | undefined
    const runtime: ClaudeRuntime = {
      runTurn: async (context, handlers) => {
        contexts.push(context)
        await handlers.onEvent({ type: 'text_delta', delta: 'All done.' })
        await handlers.onEvent({ type: 'completed', success: true, result: 'All done.' })
      },
      steer: async () => {},
      interrupt: async () => {},
      stop: async () => {},
    }
    const server = new CodexClaudeAppServer(store, runtime)
    const peer: RpcPeer = {
      id: 'app-settings-test',
      close: () => {},
      send: (message) => {
        if ('id' in message) responses.set(message.id, message as Response)
        if ('method' in message) {
          notifications.push({ method: message.method, params: message.params })
          if (message.method === 'turn/completed') finish?.()
        }
      },
    }
    let nextId = 0
    const send = async (method: string, params: Record<string, unknown>) => {
      const id = ++nextId
      await server.handle(peer, { id, method, params })
      const response = responses.get(id)
      assert.ok(response, `Missing ${method} response`)
      return response
    }
    const request = async (method: string, params: Record<string, unknown>) => {
      const response = await send(method, params)
      assert.equal(response.error, undefined, `${method} failed: ${response.error?.message}`)
      return response.result
    }
    const turn = async (threadId: string, params: Record<string, unknown> = {}) => {
      const completed = new Promise<void>((done) => {
        finish = done
      })
      await request('turn/start', { threadId, input: [{ type: 'text', text: 'Hi.' }], ...params })
      await completed
      const context = contexts.at(-1)
      assert.ok(context)
      return context
    }
    try {
      await run({ request, send, turn, notifications })
    } finally {
      await server.stop()
    }
  })
}

const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')

// The edit the App's MCP settings send when a server is added or saved.
function saveServer(root: string, name: string, value: unknown): Record<string, unknown> {
  return {
    edits: [{ keyPath: `mcp_servers.${name}`, value, mergeStrategy: 'replace' }],
    filePath: join(root, 'codex', 'config.toml'),
    expectedVersion: null,
  }
}

// The write its switch sends.
function switchServer(root: string, name: string, enabled: boolean): Record<string, unknown> {
  return {
    keyPath: `mcp_servers.${name}.enabled`,
    value: enabled,
    mergeStrategy: 'upsert',
    filePath: join(root, 'codex', 'config.toml'),
    expectedVersion: null,
  }
}

const servers = (context: RuntimeTurnContext) =>
  (context.mcpServers ?? null) as Record<string, Record<string, unknown>> | null

// The servers added in the App's MCP settings apply only with this.
const appServersOn = { CLAUDE_CODEX_APP_MCP_SERVERS: '1' }

// The permissions preset the App's composer takes config/read's settings
// for: on-request with workspace-write is its Default permissions ('auto')
// only while sandbox_workspace_write is unset, or an empty table with network
// access and both exclude flags off. Otherwise it lists and preselects
// Custom (config.toml) for new chats.
// App rule: permission-presets
function appPermissionPreset(config: {
  approval_policy?: unknown
  sandbox_mode?: unknown
  sandbox_workspace_write?: {
    writable_roots?: unknown[]
    network_access?: unknown
    exclude_tmpdir_env_var?: unknown
    exclude_slash_tmp?: unknown
  } | null
}): string | null {
  const table = config.sandbox_workspace_write
  const plain =
    table == null ||
    ((table.writable_roots ?? []).length === 0 &&
      table.network_access === false &&
      table.exclude_tmpdir_env_var === false &&
      table.exclude_slash_tmp === false)
  if (config.sandbox_mode === 'workspace-write' && config.approval_policy === 'on-request')
    return plain ? 'auto' : null
  return null
}

test('servers added in the App MCP settings run in Claude threads and survive a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-mcp-settings-'))
  const userFile = join(root, 'codex', 'config.toml')
  const entry = { command: process.execPath, args: [fixture], env: { GREETING: 'hello' } }
  try {
    await withServer(root, appServersOn, async ({ request, turn, notifications }) => {
      // The App saves to the file named as the origin of mcp_servers, and
      // says the settings are unavailable without one.
      const before = await request('config/read', {})
      assert.deepEqual(before.config.mcp_servers, {})
      assert.deepEqual(before.origins.mcp_servers.name, { type: 'user', file: userFile })

      await request('config/batchWrite', saveServer(root, 'fixture', entry))
      const read = await request('config/read', {})
      assert.deepEqual(read.config.mcp_servers, { fixture: entry })
      assert.deepEqual(read.origins['mcp_servers.fixture'].name, { type: 'user', file: userFile })

      const started = await request('thread/start', { cwd: root, model: 'sonnet' })
      const threadId = started.thread.id
      const normal = await turn(threadId)
      assert.deepEqual(Object.keys(servers(normal) ?? {}), ['fixture'])
      assert.equal(servers(normal)?.fixture?.command, process.execPath)
      assert.deepEqual(servers(normal)?.fixture?.args, [fixture])
      const env = servers(normal)?.fixture?.env as Record<string, string> | undefined
      assert.equal(env?.GREETING, 'hello')
      // Summaries and other internal turns get none of them.
      const summary = await turn(threadId, {
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      })
      assert.equal(summary.mcpServers, null)

      // The App lists it, with its tools, and can call them.
      const listed = await request('mcpServerStatus/list', {})
      assert.deepEqual(
        listed.data.map((status: { name: string }) => status.name),
        ['fixture'],
      )
      assert.ok('echo' in listed.data[0].tools)
      const called = await request('mcpServer/tool/call', {
        server: 'fixture',
        tool: 'env',
        arguments: { value: 'GREETING' },
      })
      assert.deepEqual(called.content, [{ type: 'text', text: 'env:hello' }])
      // A reload tells every window about the servers configured now.
      const heard = notifications.length
      await request('config/mcpServer/reload', {})
      assert.deepEqual(
        notifications
          .slice(heard)
          .filter((note) => note.method === 'mcpServer/startupStatus/updated')
          .map((note) => note.params.name),
        ['fixture'],
      )

      // Switched off, the next turn goes without it; the App still lists it.
      await request('config/value/write', switchServer(root, 'fixture', false))
      const off = await request('config/read', {})
      assert.deepEqual(off.config.mcp_servers.fixture, { ...entry, enabled: false })
      assert.equal(servers(await turn(threadId)), null)

      // Saved again with tool lists, it is back with them.
      await request(
        'config/batchWrite',
        saveServer(root, 'fixture', {
          ...entry,
          enabled: true,
          enabled_tools: ['echo', 'env'],
          disabled_tools: ['env'],
        }),
      )
      const narrowed = await turn(threadId)
      assert.deepEqual(Object.keys(servers(narrowed) ?? {}), ['fixture'])
      assert.deepEqual(narrowed.disallowedTools, ['mcp__fixture__env'])
      assert.deepEqual(narrowed.mcpEnabledTools, {
        mcp__fixture__: ['mcp__fixture__echo', 'mcp__fixture__env'],
      })
    })

    // The adapter keeps them in its own settings, not in config.toml.
    const saved = JSON.parse(await readFile(join(root, 'adapter', 'config.json'), 'utf8'))
    assert.equal(saved.overrides.mcp_servers.fixture.command, process.execPath)
    await assert.rejects(readFile(userFile, 'utf8'))

    await withServer(root, appServersOn, async ({ request, turn }) => {
      const read = await request('config/read', {})
      assert.deepEqual(Object.keys(read.config.mcp_servers), ['fixture'])
      const started = await request('thread/start', { cwd: root, model: 'sonnet' })
      assert.deepEqual(Object.keys(servers(await turn(started.thread.id)) ?? {}), ['fixture'])
      // Deleting it takes it away.
      await request('config/batchWrite', saveServer(root, 'fixture', null))
      assert.deepEqual((await request('config/read', {})).config.mcp_servers, {})
      assert.deepEqual((await request('config/read', {})).origins['mcp_servers.fixture'], undefined)
      assert.equal(servers(await turn(started.thread.id)), null)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the App's desktop servers are accepted and never kept", async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-mcp-desktop-'))
  try {
    await withServer(root, appServersOn, async ({ request, turn }) => {
      // What the App's main process writes each time it starts.
      await request('config/batchWrite', {
        edits: [
          {
            keyPath: 'mcp_servers.node_repl',
            value: { command: '/app/node_repl', env: { APP_PRIVATE: 'secret' } },
            mergeStrategy: 'replace',
          },
          {
            keyPath: 'mcp_servers.cua_repl',
            value: { command: process.execPath, enabled: false },
            mergeStrategy: 'replace',
          },
        ],
        filePath: null,
        reloadUserConfig: true,
      })
      await request('config/batchWrite', {
        edits: [{ keyPath: 'mcp_servers.node_repl', value: null, mergeStrategy: 'replace' }],
        filePath: null,
      })
      const read = await request('config/read', {})
      assert.deepEqual(read.config.mcp_servers, {})
      assert.equal(read.config['mcp_servers.node_repl'], undefined)
      const started = await request('thread/start', { cwd: root, model: 'sonnet' })
      assert.equal(servers(await turn(started.thread.id)), null)
    })
    const saved = await readFile(join(root, 'adapter', 'config.json'), 'utf8')
    assert.ok(!saved.includes('node_repl'))
    assert.ok(!saved.includes('APP_PRIVATE'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('CLAUDE_CODEX_MCP_SERVERS wins over the App settings, which win over the Codex config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-mcp-precedence-'))
  await mkdir(join(root, 'codex'), { recursive: true })
  await writeFile(
    join(root, 'codex', 'config.toml'),
    `[mcp_servers.shared]
command = "/codex/shared"
disabled_tools = ["drop"]

[mcp_servers.codex-only]
command = "/codex/only"
`,
  )
  const env = {
    ...appServersOn,
    CLAUDE_CODEX_CODEX_MCP_SERVERS: '1',
    CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({ explicit: { command: '/env/explicit' } }),
  }
  try {
    await withServer(root, env, async ({ request, turn }) => {
      await request('config/batchWrite', {
        edits: [
          {
            keyPath: 'mcp_servers.shared',
            value: { command: '/app/shared' },
            mergeStrategy: 'replace',
          },
          {
            keyPath: 'mcp_servers.explicit',
            value: { command: '/app/explicit', disabled_tools: ['gone'] },
            mergeStrategy: 'replace',
          },
        ],
        filePath: null,
      })
      const started = await request('thread/start', { cwd: root, model: 'sonnet' })
      const context = await turn(started.thread.id)
      const used = servers(context) ?? {}
      assert.deepEqual(Object.keys(used).sort(), ['codex-only', 'explicit', 'shared'])
      assert.equal(used.shared?.command, '/app/shared')
      assert.equal(used.explicit?.command, '/env/explicit')
      assert.equal(used['codex-only']?.command, '/codex/only')
      // The tool lists of a server that lost its name go with it.
      assert.deepEqual(context.disallowedTools, [])
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a write the App MCP settings cannot hold fails and changes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-mcp-invalid-'))
  try {
    await withServer(root, appServersOn, async ({ request, send }) => {
      await request('config/batchWrite', saveServer(root, 'kept', { command: '/bin/kept' }))
      const failures: Array<[Record<string, unknown>, RegExp]> = [
        // Neither a command nor a URL, or both.
        [saveServer(root, 'empty', { args: ['x'] }), /needs either a command or a url/],
        [
          saveServer(root, 'both', { command: '/bin/x', url: 'https://example.com/mcp' }),
          /needs either a command or a url/,
        ],
        [saveServer(root, 'typed', { command: '/bin/x', args: 'not-a-list' }), /wrong type/],
        [saveServer(root, 'scalar', 'not-a-table'), /must be a table/],
        [saveServer(root, 'bad name', { command: '/bin/x' }), /invalid MCP server name/],
        // The switch of a server the App never added.
        [switchServer(root, 'missing', true), /no MCP server named missing/],
        // One bad edit fails the whole batch.
        [
          {
            edits: [
              { keyPath: 'mcp_servers.kept', value: null, mergeStrategy: 'replace' },
              { keyPath: 'model_verbosity', value: 'high', mergeStrategy: 'replace' },
            ],
            filePath: null,
          },
          /model_verbosity is not supported for Claude threads/,
        ],
        [
          {
            edits: [
              { keyPath: 'desktop.flag', value: true, mergeStrategy: 'replace' },
              { keyPath: 'mcp_servers.broken', value: { url: 7 }, mergeStrategy: 'replace' },
            ],
            filePath: null,
          },
          /needs either a command or a url/,
        ],
      ]
      for (const [params, message] of failures) {
        const method = 'edits' in params ? 'config/batchWrite' : 'config/value/write'
        const response = await send(method, params)
        assert.equal(response.error?.code, INVALID_REQUEST, JSON.stringify(params))
        assert.match(response.error?.message ?? '', message)
      }
      const read = await request('config/read', {})
      assert.deepEqual(read.config.mcp_servers, { kept: { command: '/bin/kept' } })
      assert.equal(read.config['desktop.flag'], undefined)
      // An upsert of a whole entry merges into the one there.
      await request('config/batchWrite', {
        edits: [{ keyPath: 'mcp_servers.kept', value: { args: ['--v'] }, mergeStrategy: 'upsert' }],
        filePath: null,
      })
      assert.deepEqual((await request('config/read', {})).config.mcp_servers.kept, {
        command: '/bin/kept',
        args: ['--v'],
      })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the App MCP settings are off unless CLAUDE_CODEX_APP_MCP_SERVERS=1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-mcp-off-'))
  const userFile = join(root, 'codex', 'config.toml')
  try {
    await withServer(root, appServersOn, async ({ request }) => {
      await request('config/batchWrite', saveServer(root, 'fixture', { command: '/bin/kept' }))
    })
    for (const value of [undefined, '0', 'true']) {
      await withServer(root, { CLAUDE_CODEX_APP_MCP_SERVERS: value }, async (app) => {
        const read = await app.request('config/read', {})
        // No server is listed, but the settings stay writable, so that a
        // save shows why it is refused rather than a page that is only
        // unavailable.
        assert.equal(read.config.mcp_servers, undefined, String(value))
        assert.deepEqual(read.origins.mcp_servers.name, { type: 'user', file: userFile })
        assert.equal(read.origins['mcp_servers.fixture'], undefined)
        const writes: Array<[string, Record<string, unknown>]> = [
          ['config/batchWrite', saveServer(root, 'other', { command: '/bin/other' })],
          ['config/value/write', switchServer(root, 'fixture', false)],
          // Nor can a saved server be deleted, one by one or with the whole
          // table.
          ['config/batchWrite', saveServer(root, 'fixture', null)],
          [
            'config/batchWrite',
            { edits: [{ keyPath: 'mcp_servers', value: {}, mergeStrategy: 'replace' }] },
          ],
          [
            'config/batchWrite',
            { edits: [{ keyPath: 'mcp_servers', value: null, mergeStrategy: 'replace' }] },
          ],
        ]
        for (const [method, params] of writes) {
          const response = await app.send(method, { filePath: null, ...params })
          assert.equal(response.error?.code, INVALID_REQUEST, JSON.stringify(params))
          const message = response.error?.message ?? ''
          assert.match(message, /^MCP servers added in the App are not used for Claude threads/)
          assert.match(message, /CLAUDE_CODEX_APP_MCP_SERVERS=1/)
          assert.match(message, /Claude Code's own MCP config/)
        }
        // The desktop servers the App writes at startup are still accepted.
        await app.request('config/batchWrite', {
          edits: [
            {
              keyPath: 'mcp_servers.node_repl',
              value: { command: '/x' },
              mergeStrategy: 'replace',
            },
          ],
          filePath: null,
        })
        const started = await app.request('thread/start', { cwd: root, model: 'sonnet' })
        assert.equal(servers(await app.turn(started.thread.id)), null)
        assert.deepEqual((await app.request('mcpServerStatus/list', {})).data, [])
      })
    }
    // What was saved stays for when the servers are turned on.
    await withServer(root, appServersOn, async ({ request }) => {
      const read = await request('config/read', {})
      assert.deepEqual(read.config.mcp_servers, { fixture: { command: '/bin/kept' } })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config writes keep credentials out of the debug log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-settings-debug-log-'))
  const debugLog = join(root, 'debug.jsonl')
  try {
    await withServer(root, { ...appServersOn, CLAUDE_CODEX_DEBUG_LOG: debugLog }, async (app) => {
      await app.request(
        'config/batchWrite',
        saveServer(root, 'local', { command: '/bin/kept', env: { GREETING: 'env-value-1' } }),
      )
      await app.request(
        'config/batchWrite',
        saveServer(root, 'remote', {
          url: 'https://someone:url-password-2@example.com/mcp?key=url-query-3',
          http_headers: { 'X-Custom': 'header-value-4' },
          env_http_headers: { 'X-Other': 'HEADER_VARIABLE_5' },
          bearer_token_env_var: 'BEARER_VARIABLE_6',
        }),
      )
      // A write of the map itself, or of one of its values.
      await app.request('config/value/write', {
        keyPath: 'mcp_servers.local.env',
        value: { OTHER: 'env-value-7' },
        mergeStrategy: 'upsert',
        filePath: null,
      })
      await app.send('config/value/write', {
        keyPath: 'mcp_servers.local.env.THIRD',
        value: 'env-value-8',
        mergeStrategy: 'replace',
        filePath: null,
      })
      // A credential-named key anywhere in a config value.
      await app.request('config/batchWrite', {
        edits: [
          {
            keyPath: 'desktop.integration',
            value: { name: 'kept-name', access_token: 'token-value-9' },
            mergeStrategy: 'replace',
          },
        ],
        filePath: null,
      })
      // Config overrides on thread/start, keyed by dotted paths.
      await app.send('thread/start', {
        cwd: root,
        model: 'sonnet',
        config: { 'mcp_servers.local.env.FOURTH': 'env-value-10' },
      })
    })
    const log = await readFile(debugLog, 'utf8')
    for (const secret of [
      'env-value-1',
      'url-password-2',
      'url-query-3',
      'header-value-4',
      'HEADER_VARIABLE_5',
      'BEARER_VARIABLE_6',
      'env-value-7',
      'env-value-8',
      'token-value-9',
      'env-value-10',
    ])
      assert.ok(!log.includes(secret), secret)
    // Key names and the rest of each value stay, for debugging.
    for (const kept of [
      'GREETING',
      'X-Custom',
      'X-Other',
      'bearer_token_env_var',
      'OTHER',
      'mcp_servers.local.env.THIRD',
      'access_token',
      'kept-name',
      '/bin/kept',
      'example.com/mcp',
      'mcp_servers.local.env.FOURTH',
      '[redacted]',
    ])
      assert.ok(log.includes(kept), kept)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings Claude threads have no counterpart for are refused, and read back as they hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-settings-unsupported-'))
  const write = (keyPath: string, value: unknown) => ({
    keyPath,
    value,
    mergeStrategy: 'replace',
    filePath: join(root, 'codex', 'config.toml'),
    expectedVersion: null,
  })
  try {
    await withServer(root, {}, async ({ request, send }) => {
      const before = await request('config/read', {})
      // New chats keep the App's Default permissions preset.
      assert.equal(appPermissionPreset(before.config), 'auto')
      assert.equal(before.config.sandbox_workspace_write, null)
      for (const key of [
        'model_verbosity',
        'service_tier',
        'instructions',
        'developer_instructions',
        'compact_prompt',
      ])
        assert.equal(before.config[key], null, key)

      const refused: Array<[string, unknown]> = [
        ['model_verbosity', 'low'],
        ['service_tier', 'fast'],
        ['profiles.work.service_tier', 'flex'],
        ['sandbox_workspace_write.network_access', false],
        ['sandbox_workspace_write.writable_roots', ['/tmp/extra']],
        ['sandbox_workspace_write', { network_access: false }],
        ['developer_instructions', 'Be terse.'],
        ['instructions', 'Be terse.'],
        ['compact_prompt', 'Summarize.'],
      ]
      for (const [keyPath, value] of refused) {
        const response = await send('config/value/write', write(keyPath, value))
        assert.equal(response.error?.code, INVALID_REQUEST, keyPath)
        assert.match(
          response.error?.message ?? '',
          new RegExp(`^${keyPath.replaceAll('.', '\\.')} is not supported for Claude threads`),
        )
      }
      // Clearing one, or writing what Claude threads do anyway, succeeds.
      const accepted: Array<[string, unknown]> = [
        ['model_verbosity', null],
        ['service_tier', 'default'],
        ['service_tier', null],
        ['profiles.work.service_tier', 'default'],
        ['sandbox_workspace_write.network_access', true],
        ['sandbox_workspace_write', { network_access: true, writable_roots: [] }],
        ['developer_instructions', null],
      ]
      for (const [keyPath, value] of accepted)
        await request('config/value/write', write(keyPath, value))
      // The service tier the speed menu writes with config/batchWrite.
      await request('config/batchWrite', {
        edits: [{ keyPath: 'service_tier', value: 'default', mergeStrategy: 'upsert' }],
        filePath: null,
        reloadUserConfig: true,
      })

      const after = await request('config/read', {})
      assert.deepEqual(after.config.sandbox_workspace_write, before.config.sandbox_workspace_write)
      assert.equal(after.config.service_tier, null)
      assert.equal(after.config.model_verbosity, null)
      for (const key of Object.keys(after.config))
        assert.ok(!key.startsWith('profiles.') && !key.startsWith('sandbox_workspace_write.'), key)

      // The settings the adapter applies still save and read back.
      await request('config/value/write', write('approval_policy', 'never'))
      await request('config/value/write', write('model_reasoning_summary', 'detailed'))
      await request('config/value/write', write('web_search', 'cached'))
      const applied = (await request('config/read', {})).config
      assert.equal(applied.approval_policy, 'never')
      assert.equal(applied.model_reasoning_summary, 'detailed')
      assert.equal(applied.web_search, 'cached')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('web search turned off in the App settings takes WebSearch from Claude', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-settings-web-search-'))
  try {
    await withServer(root, {}, async ({ request, turn }) => {
      const started = await request('thread/start', { cwd: root, model: 'sonnet' })
      const threadId = started.thread.id
      assert.ok(!(await turn(threadId)).disallowedTools?.includes('WebSearch'))
      await request('config/value/write', { keyPath: 'web_search', value: 'disabled' })
      assert.deepEqual((await turn(threadId)).disallowedTools, ['WebSearch'])
      // Claude has the one kind of search: the others keep it.
      for (const mode of ['cached', 'indexed', 'live']) {
        await request('config/value/write', { keyPath: 'web_search', value: mode })
        assert.ok(!(await turn(threadId)).disallowedTools?.includes('WebSearch'), mode)
      }
      await request('config/value/write', { keyPath: 'web_search', value: 'disabled' })
    })
    // The setting survives a restart.
    await withServer(root, {}, async ({ request, turn }) => {
      const started = await request('thread/start', { cwd: root, model: 'sonnet' })
      assert.deepEqual((await turn(started.thread.id)).disallowedTools, ['WebSearch'])
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings saved before the App settings were checked are cleaned up on start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'app-settings-legacy-'))
  const configPath = join(root, 'adapter', 'config.json')
  await mkdir(join(root, 'adapter'), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      model: 'sonnet',
      overrides: {
        // What the App's desktop server writes became before: flat keys
        // nothing read, holding the App's private environment.
        'mcp_servers.node_repl': { command: '/app/node_repl', env: { APP_PRIVATE: 'secret' } },
        'mcp_servers.cua_repl': null,
        model_verbosity: 'high',
        service_tier: 'default',
        'sandbox_workspace_write.network_access': false,
        'desktop.flag': true,
        approval_policy: 'never',
        mcp_servers: { node_repl: { command: '/x' }, kept: { command: '/bin/kept' }, bad: 3 },
      },
    }),
  )
  try {
    await withServer(root, appServersOn, async ({ request }) => {
      const { config } = await request('config/read', {})
      assert.deepEqual(config.mcp_servers, { kept: { command: '/bin/kept' } })
      assert.equal(config['mcp_servers.node_repl'], undefined)
      assert.equal(config.model_verbosity, null)
      assert.equal(config.sandbox_workspace_write, null)
      assert.equal(config['desktop.flag'], true)
      assert.equal(config.approval_policy, 'never')
    })
    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    assert.deepEqual(saved.overrides, {
      'desktop.flag': true,
      approval_policy: 'never',
      mcp_servers: { kept: { command: '/bin/kept' } },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
