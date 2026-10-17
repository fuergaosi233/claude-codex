import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { claudeAgents, frontmatterData } from '../src/claude-agents.mjs'
import {
  claudeGlobalConfigPath,
  claudeMcpServers,
  claudePermissionRules,
} from '../src/claude-config.mjs'
import {
  codexMcpServers,
  codexTrustsProject,
  type InheritedMcpServer,
} from '../src/codex-config.mjs'
import { mcpToolName, mcpToolRules } from '../src/inherited-config.mjs'
import { readMcpConfig } from '../src/mcp.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { sdkHooks } from '../src/sdk-hooks.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import { parseToml } from '../src/toml.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

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

// A TOML basic string for a path.
const q = (path: string) => JSON.stringify(path)

const byName = (servers: readonly InheritedMcpServer[]): Record<string, InheritedMcpServer> =>
  Object.fromEntries(servers.map((server) => [server.name, server]))

// A server's SDK config, failing the test when the server is missing.
function configOf<T>(server: InheritedMcpServer | undefined): T {
  assert.ok(server)
  return server.config as T
}

// Settings that would leak in from the test runner's own environment.
const clean = {
  CLAUDE_CODEX_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CODEX_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined,
}

interface TestApp {
  request: (method: string, params: Record<string, unknown>) => Promise<any>
  // Runs a turn and returns the context the runtime got.
  turn: (threadId: string, params?: Record<string, unknown>) => Promise<RuntimeTurnContext>
  // Notifications the server sent, in order.
  notifications: Array<{ method: string; params: any }>
}

// An app server over a fake runtime that records each turn's context.
async function withServer(
  root: string,
  env: Record<string, string | undefined>,
  run: (app: TestApp) => Promise<void>,
): Promise<void> {
  await withEnv({ ...clean, CLAUDE_CODEX_HOME: join(root, 'adapter'), ...env }, async () => {
    const store = new SessionStore(join(root, 'state.sqlite'))
    const contexts: RuntimeTurnContext[] = []
    const responses = new Map<unknown, any>()
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
      id: 'inherited-config-test',
      close: () => {},
      send: (message) => {
        if ('id' in message) responses.set(message.id, message)
        if ('method' in message) {
          notifications.push({ method: message.method, params: message.params })
          if (message.method === 'turn/completed') finish?.()
        }
      },
    }
    let nextId = 0
    const request = async (method: string, params: Record<string, unknown>) => {
      const id = ++nextId
      await server.handle(peer, { id, method, params })
      const response = responses.get(id)
      assert.ok(response, `Missing ${method} response`)
      assert.equal(response.error, undefined)
      return response.result
    }
    const turn = async (threadId: string, params: Record<string, unknown> = {}) => {
      const completed = new Promise<void>((resolve) => {
        finish = resolve
      })
      await request('turn/start', { threadId, input: [{ type: 'text', text: 'Hi.' }], ...params })
      await completed
      const context = contexts.at(-1)
      assert.ok(context)
      return context
    }
    try {
      await run({ request, turn, notifications })
    } finally {
      await server.stop()
    }
  })
}

test('the TOML reader covers the syntax Codex config files use', () => {
  const parsed = parseToml(`
# comment
title = "a \\"quoted\\" \\u00e9 value" # trailing comment
literal = 'C:\\path'
multi = """
line one \\
   continued
"""
raw = '''
keep \\n as is'''
int = 1_000
hex = 0xff
float = -1.5e3
yes = true
date = 1979-05-27T07:32:00Z
list = [
  1, 2, # comment
  3,
]
nested = [[1, 2], ["a"]]
inline = { a = 1, b.c = "d" }
"quoted key" = 1
dotted.key = "v"
__proto__ = "plain key"

[server]
name = "x"

[server.sub]
deep = true

[[items]]
id = 1

[[items]]
id = 2

[items.extra]
flag = true

[a."b.c"]
x = 1
`)
  assert.equal(parsed.title, 'a "quoted" é value')
  assert.equal(parsed.literal, 'C:\\path')
  assert.equal(parsed.multi, 'line one continued\n')
  assert.equal(parsed.raw, 'keep \\n as is')
  assert.equal(parsed.int, 1000)
  assert.equal(parsed.hex, 255)
  assert.equal(parsed.float, -1500)
  assert.equal(parsed.yes, true)
  assert.equal(parsed.date, '1979-05-27T07:32:00Z')
  assert.deepEqual(parsed.list, [1, 2, 3])
  assert.deepEqual(parsed.nested, [[1, 2], ['a']])
  assert.deepEqual(parsed.inline, { a: 1, b: { c: 'd' } })
  assert.equal(parsed['quoted key'], 1)
  assert.deepEqual(parsed.dotted, { key: 'v' })
  // An ordinary key, not the object's prototype.
  assert.equal(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value, 'plain key')
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
  assert.deepEqual(parsed.server, { name: 'x', sub: { deep: true } })
  assert.deepEqual(parsed.items, [{ id: 1 }, { id: 2, extra: { flag: true } }])
  assert.deepEqual(parsed.a, { 'b.c': { x: 1 } })

  assert.throws(() => parseToml('a = 1\na = 2'), /TOML line 2: duplicate key a/)
  assert.throws(() => parseToml('a = "open'), /unterminated string/)
  assert.throws(() => parseToml('[table'), /unterminated table header/)
})

test('Codex config MCP servers become SDK server configs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-codex-mcp-'))
  const codexHome = join(root, 'codex-home')
  const serverDir = join(codexHome, 'servers', 'local')
  try {
    await mkdir(serverDir, { recursive: true })
    await write(
      join(codexHome, 'config.toml'),
      `model = "gpt-5"

[mcp_servers.docs]
command = "docs-mcp"
args = ["--stdio"]
env = { DOCS_MODE = "fast" }
env_vars = ["DOCS_TOKEN", { name = "REMOTE_ONLY", source = "remote" }, "UNSET_VAR"]
tool_timeout_sec = 12.5
startup_timeout_sec = 5
disabled_tools = ["delete"]

[mcp_servers.off]
command = "never-started"
enabled = false

[mcp_servers.local]
command = "pwd"
cwd = "servers/local"
enabled_tools = ["read", "list"]

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
http_headers = { "X-Team" = "core" }
env_http_headers = { "X-Key" = "DOCS_HEADER" }
bearer_token_env_var = "DOCS_BEARER"

[mcp_servers.elsewhere]
command = "remote-only"
experimental_environment = "remote"

[mcp_servers.broken]
startup_timeout_sec = 3

[plugins."tools@market"]
enabled = true

[plugins."tools@market".mcp_servers.app_tools]
command = "app-tools"
`,
    )
    const servers = await withEnv(
      {
        ...clean,
        CODEX_HOME: codexHome,
        CLAUDE_CODEX_CODEX_MCP_SERVERS: '1',
        DOCS_TOKEN: 'docs-token-value',
        REMOTE_ONLY: 'remote-value',
        UNSET_VAR: undefined,
        DOCS_HEADER: 'header-value',
        DOCS_BEARER: 'bearer-value',
      },
      async () => codexMcpServers(null),
    )
    assert.deepEqual(
      servers.map((server) => server.name),
      ['docs', 'local', 'remote'],
    )
    const found = byName(servers)
    assert.deepEqual(found.docs, {
      name: 'docs',
      source: join(codexHome, 'config.toml'),
      config: {
        type: 'stdio',
        command: 'docs-mcp',
        args: ['--stdio'],
        env: { PATH: process.env.PATH, DOCS_TOKEN: 'docs-token-value', DOCS_MODE: 'fast' },
        timeout: 12500,
      },
      disabledTools: ['delete'],
    })
    assert.deepEqual(found.local?.enabledTools, ['read', 'list'])
    const local = configOf<{ command: string; args: string[] }>(found.local)
    assert.equal(local.command, '/bin/sh')
    assert.deepEqual(local.args.slice(3), [serverDir, 'pwd'])
    // The launcher runs the server in its folder.
    const ran = spawnSync(local.command, local.args, { encoding: 'utf8' })
    assert.equal(await realpath(ran.stdout.trim()), await realpath(serverDir))
    assert.deepEqual(found.remote?.config, {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Team': 'core', 'X-Key': 'header-value', Authorization: 'Bearer bearer-value' },
    })

    // Off unless asked for with exactly 1.
    for (const value of [undefined, '0', 'true', 'yes'])
      assert.deepEqual(
        await withEnv(
          { ...clean, CODEX_HOME: codexHome, CLAUDE_CODEX_CODEX_MCP_SERVERS: value },
          async () => codexMcpServers(null),
        ),
        [],
      )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a trusted project adds its .codex/config.toml servers; a worktree follows its main checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-codex-project-'))
  const codexHome = join(root, 'codex-home')
  const repo = join(root, 'repo')
  const cwd = join(repo, 'packages', 'app')
  const worktree = join(root, 'worktree')
  try {
    await mkdir(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await write(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    await write(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)
    const userConfig = `[mcp_servers.docs]
command = "docs-mcp"
args = ["--user"]
env = { DOCS_MODE = "fast" }
`
    await write(join(codexHome, 'config.toml'), userConfig)
    await write(
      join(repo, '.codex', 'config.toml'),
      `[mcp_servers.docs]
args = ["--project"]

[mcp_servers.repo_tool]
command = "./bin/tool"
cwd = ".."
`,
    )
    await write(
      join(cwd, '.codex', 'config.toml'),
      `[mcp_servers.repo_tool]
enabled = false
`,
    )
    const read = (dir: string) =>
      withEnv(
        { ...clean, CODEX_HOME: codexHome, CLAUDE_CODEX_CODEX_MCP_SERVERS: '1' },
        async () => ({
          trusted: codexTrustsProject(dir),
          servers: byName(codexMcpServers(dir)),
        }),
      )

    const untrusted = await read(repo)
    assert.equal(untrusted.trusted, false)
    assert.deepEqual(Object.keys(untrusted.servers), ['docs'])
    assert.deepEqual(configOf<{ args: string[] }>(untrusted.servers.docs).args, ['--user'])

    await write(
      join(codexHome, 'config.toml'),
      `${userConfig}\n[projects.${q(repo)}]\ntrust_level = "trusted"\n`,
    )
    const trusted = await read(repo)
    assert.equal(trusted.trusted, true)
    assert.deepEqual(Object.keys(trusted.servers), ['docs', 'repo_tool'])
    // Merged key by key: the project changes the arguments, the env stays.
    const docs = configOf<{ args: string[]; env: Record<string, string> }>(trusted.servers.docs)
    assert.deepEqual(docs.args, ['--project'])
    assert.equal(docs.env.DOCS_MODE, 'fast')
    assert.equal(trusted.servers.docs?.source, join(repo, '.codex', 'config.toml'))
    // A relative cwd is relative to the file that set it.
    assert.deepEqual(configOf<{ args: string[] }>(trusted.servers.repo_tool).args.slice(3), [
      repo,
      './bin/tool',
    ])
    // A deeper folder's file disables the server.
    assert.deepEqual(Object.keys((await read(cwd)).servers), ['docs'])

    assert.equal((await read(worktree)).trusted, true)
    await write(
      join(codexHome, 'config.toml'),
      `${userConfig}\n[projects.${q(repo)}]\ntrust_level = "trusted"\n\n[projects.${q(worktree)}]\ntrust_level = "untrusted"\n`,
    )
    assert.equal((await read(worktree)).trusted, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude Code MCP servers come from the global config and approved .mcp.json files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-claude-mcp-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  const globalPath = join(configDir, '.claude.json')
  const global = (projectEntry: Record<string, unknown>) =>
    JSON.stringify({
      mcpServers: {
        shared: { command: 'user-shared' },
        remote: {
          type: 'http',
          url: 'https://${TEAM}.example.com/mcp',
          headers: { Authorization: 'Bearer ${API_TOKEN:-none}', 'X-Other': '${MISSING_VAR}' },
        },
        events: { type: 'sse', url: 'https://events.example.com/sse' },
        socket: { type: 'ws', url: 'ws://localhost:1' },
      },
      projects: {
        [repo]: { mcpServers: { shared: { command: 'local-shared' } }, ...projectEntry },
      },
    })
  try {
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(
      join(repo, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fromRepo: { command: 'repo-tool', args: ['--team', '${TEAM}'] },
          unapproved: { command: 'not-approved' },
          disabled: { command: 'disabled-tool' },
        },
      }),
    )
    // Checked into the repository: never approves anything.
    await write(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    )
    await write(join(globalPath), global({ enabledMcpjsonServers: ['fromRepo', 'disabled'] }))
    const read = () =>
      withEnv(
        { ...clean, CODEX_HOME: join(root, 'codex-home'), TEAM: 'core', API_TOKEN: undefined },
        async () => byName(claudeMcpServers(repo, configDir)),
      )

    const untrusted = await read()
    assert.deepEqual(Object.keys(untrusted), ['remote', 'events', 'shared'])
    // The project's local scope wins over the user scope.
    assert.deepEqual(untrusted.shared?.config, { type: 'stdio', command: 'local-shared', args: [] })
    assert.deepEqual(untrusted.remote?.config, {
      type: 'http',
      url: 'https://core.example.com/mcp',
      headers: { Authorization: 'Bearer none', 'X-Other': '${MISSING_VAR}' },
    })
    assert.equal(configOf<{ type: string }>(untrusted.events).type, 'sse')

    await write(
      globalPath,
      global({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ['fromRepo', 'disabled'] }),
    )
    await write(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({ disabledMcpjsonServers: ['disabled'] }),
    )
    const trusted = await read()
    assert.deepEqual(Object.keys(trusted), ['remote', 'events', 'fromRepo', 'shared'])
    assert.deepEqual(trusted.fromRepo?.config, {
      type: 'stdio',
      command: 'repo-tool',
      args: ['--team', 'core'],
    })
    assert.equal(trusted.fromRepo?.source, join(repo, '.mcp.json'))
    // Servers the project brings stay off with no approval.
    await write(globalPath, global({ hasTrustDialogAccepted: true }))
    await rm(join(repo, '.claude', 'settings.local.json'))
    assert.deepEqual(Object.keys(await read()), ['remote', 'events', 'shared'])
    // enableAllProjectMcpServers in the user's own settings approves them all.
    await write(
      join(configDir, 'settings.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    )
    assert.deepEqual(Object.keys(await read()), [
      'remote',
      'events',
      'fromRepo',
      'unapproved',
      'disabled',
      'shared',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Claude Code global config file is found where the CLI keeps it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-claude-global-'))
  const home = join(root, 'home')
  const other = join(root, 'other')
  try {
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(other, { recursive: true })
    await withEnv({ HOME: home }, async () => {
      assert.equal(claudeGlobalConfigPath(join(home, '.claude')), join(home, '.claude.json'))
      assert.equal(claudeGlobalConfigPath(other), join(other, '.claude.json'))
      await write(join(other, '.config.json'), '{}')
      assert.equal(claudeGlobalConfigPath(other), join(other, '.config.json'))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit servers win over inherited ones, which win by origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-mcp-precedence-'))
  const codexHome = join(root, 'codex-home')
  const configDir = join(root, 'claude-config')
  const explicitFile = join(root, 'servers.json')
  try {
    await write(
      join(codexHome, 'config.toml'),
      `[mcp_servers.shared]
command = "codex-shared"

[mcp_servers.overridden]
command = "codex-overridden"
disabled_tools = ["drop"]

[mcp_servers.narrow]
command = "codex-narrow"
enabled_tools = ["only"]
disabled_tools = ["never"]
`,
    )
    await write(
      join(configDir, '.claude.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'claude-shared' } } }),
    )
    await write(
      explicitFile,
      JSON.stringify({ mcpServers: { overridden: { type: 'stdio', command: 'explicit' } } }),
    )
    const env = {
      ...clean,
      CODEX_HOME: codexHome,
      CLAUDE_CODEX_CODEX_MCP_SERVERS: '1',
      CLAUDE_CODEX_CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODEX_MCP_SERVERS: explicitFile,
    }
    const snapshot = await withEnv(env, async () => readMcpConfig({ cwd: root }))
    assert.deepEqual(snapshot.sdkValue, {
      shared: { type: 'stdio', command: 'claude-shared', args: [] },
      narrow: {
        type: 'stdio',
        command: 'codex-narrow',
        args: [],
        env: { PATH: process.env.PATH },
      },
      overridden: { type: 'stdio', command: 'explicit' },
    })
    // The Codex tool lists apply only to servers still from the Codex config.
    assert.deepEqual(snapshot.toolRules, {
      disallowedTools: ['mcp__narrow__never'],
      enabledTools: { mcp__narrow__: ['mcp__narrow__only'] },
    })
    assert.deepEqual(
      snapshot.startupStatuses.map((status) => status.name),
      ['narrow', 'shared', 'overridden'],
    )

    const own = await withEnv(env, async () => readMcpConfig({ inherit: false }))
    assert.deepEqual(own.sdkValue, { overridden: { type: 'stdio', command: 'explicit' } })
    assert.deepEqual(own.toolRules, { disallowedTools: [], enabledTools: {} })

    const missing = await withEnv(
      { ...env, CLAUDE_CODEX_MCP_SERVERS: join(root, 'missing.json') },
      async () => readMcpConfig({}),
    )
    // A broken explicit setting is reported and leaves the inherited servers.
    assert.deepEqual(Object.keys(missing.sdkValue as object), ['overridden', 'narrow', 'shared'])
    assert.deepEqual(missing.startupStatuses.at(-1), {
      name: 'CLAUDE_CODEX_MCP_SERVERS',
      status: 'failed',
      error: `MCP config file not found: ${join(root, 'missing.json')}`,
    })

    const codexOnly = await withEnv(
      { ...env, CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined, CLAUDE_CODEX_MCP_SERVERS: undefined },
      async () => readMcpConfig({}),
    )
    assert.equal(
      (codexOnly.sdkValue as Record<string, { command: string }>).shared?.command,
      'codex-shared',
    )

    // Without the Codex opt-in only the Claude Code and explicit servers stay.
    const claudeOnly = await withEnv(
      { ...env, CLAUDE_CODEX_CODEX_MCP_SERVERS: undefined },
      async () => readMcpConfig({ cwd: root }),
    )
    assert.deepEqual(claudeOnly.sdkValue, {
      shared: { type: 'stdio', command: 'claude-shared', args: [] },
      overridden: { type: 'stdio', command: 'explicit' },
    })
    assert.deepEqual(claudeOnly.toolRules, { disallowedTools: [], enabledTools: {} })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('enabled_tools are enforced by a PreToolUse hook and disabled_tools are disallowed', async () => {
  assert.equal(mcpToolName('my.server', 'do-it'), 'mcp__my_server__do-it')
  const rules = mcpToolRules([
    { name: 'a', source: 'x', config: {}, enabledTools: ['read'] },
    { name: 'b', source: 'x', config: {}, disabledTools: ['write', 'rm'] },
    { name: 'c', source: 'x', config: {}, enabledTools: [] },
  ])
  assert.deepEqual(rules, {
    disallowedTools: ['mcp__b__write', 'mcp__b__rm'],
    enabledTools: { mcp__a__: ['mcp__a__read'], mcp__c__: [] },
  })
  const context = { mcpEnabledTools: rules.enabledTools } as unknown as RuntimeTurnContext
  const hooks = sdkHooks(context)
  const guard = hooks?.PreToolUse?.[0]?.hooks[0]
  assert.ok(guard)
  const signal = new AbortController().signal
  const call = (tool: string) => guard({ tool_name: tool }, undefined, { signal })
  assert.deepEqual(await call('mcp__a__read'), {})
  assert.deepEqual(await call('Bash'), {})
  assert.deepEqual(await call('mcp__b__write'), {})
  assert.deepEqual(await call('mcp__a__write'), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'mcp__a__write is not among the tools the Codex config enables for this MCP server.',
    },
  })
  assert.equal((await call('mcp__c__anything')).hookSpecificOutput !== undefined, true)
  assert.equal(sdkHooks({ mcpEnabledTools: {} } as unknown as RuntimeTurnContext), null)
})

test('Claude threads run with the inherited servers and the App lists them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-mcp-server-'))
  const codexHome = join(root, 'codex-home')
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(join(repo, 'tools'), { recursive: true })
  await copyFile(resolve('test/fixtures/mcp-stdio-server.mjs'), join(repo, 'tools', 'server.mjs'))
  await write(
    join(codexHome, 'config.toml'),
    `[mcp_servers.everywhere]
command = "/nonexistent/everywhere-mcp"
disabled_tools = ["drop"]

[projects.${q(repo)}]
trust_level = "trusted"
`,
  )
  await write(
    join(repo, '.codex', 'config.toml'),
    `[mcp_servers.fixture]
command = ${q(process.execPath)}
args = ["server.mjs"]
cwd = "../tools"
enabled_tools = ["echo"]
`,
  )
  // Off by default: the Codex App keeps its own desktop servers in that file.
  await withServer(root, { CODEX_HOME: codexHome }, async ({ request, turn }) => {
    const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
    const normal = await turn(started.thread.id)
    assert.equal(normal.mcpServers ?? null, null)
    assert.deepEqual(normal.disallowedTools, [])
    const listed = await request('mcpServerStatus/list', { threadId: started.thread.id })
    assert.deepEqual(listed.data, [])
  })
  const optIn = { CODEX_HOME: codexHome, CLAUDE_CODEX_CODEX_MCP_SERVERS: '1' }
  await withServer(root, optIn, async ({ request, turn }) => {
    const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
    const normal = await turn(started.thread.id)
    assert.deepEqual(Object.keys(normal.mcpServers as object), ['everywhere', 'fixture'])
    assert.deepEqual(normal.disallowedTools, ['mcp__everywhere__drop'])
    assert.deepEqual(normal.mcpEnabledTools, { mcp__fixture__: ['mcp__fixture__echo'] })
    // Summaries and other internal turns get none of them.
    const summary = await turn(started.thread.id, {
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    })
    assert.equal(summary.mcpServers, null)
    assert.deepEqual(summary.disallowedTools, [])

    // Without a thread only the servers for every folder are listed.
    const global = await request('mcpServerStatus/list', {})
    assert.deepEqual(
      global.data.map((entry: { name: string }) => entry.name),
      ['everywhere'],
    )
    // With one, its project's servers too, enumerated in their folder.
    const scoped = await request('mcpServerStatus/list', { threadId: started.thread.id })
    assert.deepEqual(
      scoped.data.map((entry: { name: string }) => entry.name),
      ['everywhere', 'fixture'],
    )
    assert.deepEqual(Object.keys(scoped.data[1].tools), ['echo'])
    const called = await request('mcpServer/tool/call', {
      threadId: started.thread.id,
      server: 'fixture',
      tool: 'echo',
      arguments: { value: 'hi' },
    })
    assert.deepEqual(called.content, [{ type: 'text', text: 'tool:echo:hi' }])
  })
  await rm(root, { recursive: true, force: true })
})

test('agent frontmatter is read as YAML', () => {
  const data = frontmatterData(`---
name: reviewer
# a comment
description: "Reviews code.\\nUse after edits."
tools: Read, Grep, Bash(git diff:*)
disallowedTools:
  - Write
  - Edit
model: sonnet # the alias
maxTurns: 5
background: true
skills: [lint, "deploy"]
mcpServers:
  - github
  - inline:
      command: x
hooks:
  PreToolUse:
    - matcher: Bash
initialPrompt: >
  Start by
  listing files.
notes: |-
  line one
  line two
summary: Use when: the diff is large
  and needs care
---
Body.
`)
  assert.deepEqual(data, {
    name: 'reviewer',
    description: 'Reviews code.\nUse after edits.',
    tools: 'Read, Grep, Bash(git diff:*)',
    disallowedTools: ['Write', 'Edit'],
    model: 'sonnet',
    maxTurns: 5,
    background: true,
    skills: ['lint', 'deploy'],
    mcpServers: ['github', {}],
    hooks: {},
    initialPrompt: 'Start by listing files.\n',
    notes: 'line one\nline two',
    summary: 'Use when: the diff is large and needs care',
  })
  assert.equal(frontmatterData('No frontmatter.'), null)
})

test('Claude Code agents come from the config folder and the project, the project winning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-agents-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  const cwd = join(repo, 'app')
  try {
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(
      join(configDir, 'agents', 'reviewer.md'),
      `---
name: reviewer
description: User reviewer
tools: "*"
model: inherit
permissionMode: bypassPermissions
---

Review as the user likes.
`,
    )
    await write(
      join(configDir, 'agents', 'team', 'writer.md'),
      `---
name: writer
description: Writes docs.\\nKeeps them short.
tools:
  - Read
  - Write
disallowedTools: Bash
effort: high
memory: user
maxTurns: "3"
skills: docs
---
Write docs.
`,
    )
    await write(join(configDir, 'agents', 'README.md'), 'Notes about agents, not an agent.')
    await write(
      join(configDir, 'agents', 'nameless.md'),
      '---\ndescription: No name\n---\nIgnored.\n',
    )
    await write(
      join(repo, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Repo reviewer\ntools: Read, Grep\n---\nRepo rules.\n',
    )
    await write(
      join(cwd, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: App reviewer\n---\nApp rules.\n',
    )
    await write(
      join(repo, '.claude', 'agents', 'tester.md'),
      '---\nname: tester\ndescription: Runs tests\nbackground: true\n---\nTest.\n',
    )

    const atRoot = Object.fromEntries(
      claudeAgents(repo, configDir).map((agent) => [agent.name, agent]),
    )
    assert.deepEqual(Object.keys(atRoot), ['writer', 'reviewer', 'tester'])
    assert.deepEqual(atRoot.writer?.definition, {
      description: 'Writes docs.\nKeeps them short.',
      prompt: 'Write docs.',
      tools: ['Read', 'Write'],
      disallowedTools: ['Bash'],
      skills: ['docs'],
      maxTurns: 3,
      memory: 'user',
      effort: 'high',
    })
    assert.deepEqual(atRoot.reviewer, {
      name: 'reviewer',
      source: join(repo, '.claude', 'agents', 'reviewer.md'),
      definition: { description: 'Repo reviewer', prompt: 'Repo rules.', tools: ['Read', 'Grep'] },
    })
    assert.deepEqual(atRoot.tester?.definition, {
      description: 'Runs tests',
      prompt: 'Test.',
      background: true,
    })
    // The closest folder wins.
    const inApp = claudeAgents(cwd, configDir).find((agent) => agent.name === 'reviewer')
    assert.equal(inApp?.definition.description, 'App reviewer')
    // Alone, the user agent: every tool, the main model, no permission mode.
    const userOnly = claudeAgents(join(root, 'elsewhere'), configDir)
    assert.deepEqual(userOnly.find((agent) => agent.name === 'reviewer')?.definition, {
      description: 'User reviewer',
      prompt: 'Review as the user likes.',
      model: 'inherit',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude threads get the Claude Code agents only with the config folder bridged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-agents-server-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await write(
    join(configDir, 'agents', 'helper.md'),
    '---\nname: helper\ndescription: Helps\n---\nHelp.\n',
  )
  for (const bridged of [false, true])
    await withServer(
      root,
      {
        CODEX_HOME: join(root, 'codex-home'),
        CLAUDE_CODEX_CLAUDE_CONFIG_DIR: bridged ? configDir : undefined,
      },
      async ({ request, turn }) => {
        const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
        const normal = await turn(started.thread.id)
        assert.deepEqual(
          normal.agents,
          bridged ? { helper: { description: 'Helps', prompt: 'Help.' } } : null,
        )
        const summary = await turn(started.thread.id, {
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        })
        assert.equal(summary.agents, null)
      },
    )
  await rm(root, { recursive: true, force: true })
})

// The options a native Claude session starts with for a turn context.
async function sessionOptions(
  overrides: Partial<RuntimeTurnContext>,
): Promise<Record<string, any>> {
  const runtime = new NativeClaudeRuntime()
  let captured: Record<string, any> | undefined
  Reflect.set(runtime, 'sdk', {
    query: async function* ({ options }: { options: Record<string, any> }) {
      captured = options
      yield { type: 'result', subtype: 'success', result: 'done' }
    },
  })
  await runtime.runTurn(
    {
      threadId: 'thread',
      turnId: 'turn',
      prompt: 'Hi.',
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
      ...overrides,
    },
    {
      onEvent: async () => {},
      onPermissionRequest: async () => ({ decision: 'accept' }),
      onUserInputRequest: async () => ({ answers: {} }),
    },
  )
  await runtime.stop()
  assert.ok(captured)
  return captured
}

test('the native runtime passes inherited servers, tool rules and agents to the SDK', async () => {
  const plain = await sessionOptions({})
  assert.equal(plain.disallowedTools, undefined)
  assert.equal(plain.agents, undefined)
  assert.equal(plain.hooks, undefined)

  const agents = { helper: { description: 'Helps', prompt: 'Help.' } }
  const options = await sessionOptions({
    mcpServers: { docs: { type: 'stdio', command: 'docs-mcp' } },
    disallowedTools: ['mcp__docs__drop'],
    mcpEnabledTools: { mcp__docs__: ['mcp__docs__read'] },
    agents,
  })
  assert.deepEqual(options.mcpServers, { docs: { type: 'stdio', command: 'docs-mcp' } })
  assert.deepEqual(options.disallowedTools, ['mcp__docs__drop'])
  assert.deepEqual(options.agents, agents)
  assert.equal(options.hooks.PreToolUse.length, 1)
})

test('Claude Code permission rules: the user rules apply, project deny rules always, project allow rules when trusted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-permissions-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  try {
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(
      join(configDir, 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(npm test:*)', 'Read(/notes/**)', 'Read(//etc/hosts)', 'Bash(/bin/ls)'],
          deny: ['Read(./.env)', 'WebFetch', 'Edit(/settings.json)'],
          ask: ['Bash(git push:*)'],
          defaultMode: 'bypassPermissions',
        },
      }),
    )
    await write(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(make:*)'], deny: ['Bash(rm:*)', 'WebFetch'] },
      }),
    )
    await write(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Edit(/src/**)'], deny: ['Write(/dist/**)'] } }),
    )
    const read = () =>
      withEnv({ ...clean, CODEX_HOME: join(root, 'codex-home') }, async () =>
        claudePermissionRules(repo, configDir),
      )
    const userAllow = [
      'Bash(npm test:*)',
      // A user-settings file rule is anchored at the config folder.
      `Read(/${configDir}/notes/**)`,
      'Read(//etc/hosts)',
      'Bash(/bin/ls)',
    ]
    const deny = [
      'Read(./.env)',
      'WebFetch',
      `Edit(/${configDir}/settings.json)`,
      'Bash(rm:*)',
      // A project rule stays relative to the project.
      'Write(/dist/**)',
    ]
    assert.deepEqual(await read(), { allow: userAllow, deny, ask: 1 })

    await write(
      join(configDir, '.claude.json'),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    )
    assert.deepEqual(await read(), {
      allow: [...userAllow, 'Bash(make:*)', 'Edit(/src/**)'],
      deny,
      ask: 1,
    })
    // No settings, no rules.
    assert.deepEqual(claudePermissionRules(join(root, 'elsewhere'), join(root, 'empty')), {
      allow: [],
      deny: [],
      ask: 0,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude threads get the permission rules only with the config folder bridged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-permissions-server-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await write(
    join(configDir, 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'], deny: ['WebFetch'] } }),
  )
  for (const bridged of [false, true])
    await withServer(
      root,
      {
        CODEX_HOME: join(root, 'codex-home'),
        CLAUDE_CODEX_CLAUDE_CONFIG_DIR: bridged ? configDir : undefined,
      },
      async ({ request, turn }) => {
        const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
        const normal = await turn(started.thread.id)
        assert.deepEqual(normal.inheritedAllowedTools, bridged ? ['Bash(npm test:*)'] : null)
        assert.deepEqual(normal.disallowedTools, bridged ? ['WebFetch'] : [])
        const summary = await turn(started.thread.id, {
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        })
        assert.equal(summary.inheritedAllowedTools, null)
      },
    )
  await rm(root, { recursive: true, force: true })
})

test('inherited allow rules stay out of plan mode and a read-only sandbox', async () => {
  const rule = 'Bash(npm test:*)'
  const allowed = async (overrides: Partial<RuntimeTurnContext>) =>
    (
      await withEnv({ CLAUDE_CODEX_PERMISSION_MODE: undefined }, () =>
        sessionOptions({ allowedTools: ['Read'], inheritedAllowedTools: [rule], ...overrides }),
      )
    ).allowedTools as string[]
  assert.deepEqual(await allowed({}), ['Read', rule])
  assert.deepEqual(
    await allowed({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }),
    ['Read', rule],
  )
  assert.deepEqual(await allowed({ approvalPolicy: 'on-request', sandboxMode: 'read-only' }), [
    'Read',
  ])
  assert.ok(!(await allowed({ planMode: true })).includes(rule))
})
