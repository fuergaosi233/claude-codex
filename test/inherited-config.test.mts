import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { query, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { claudeAgents, frontmatterData } from '../src/claude-agents.mjs'
import {
  claudeGlobalConfigPath,
  claudeMcpServers,
  claudePermissionRules,
  claudeTrustsProject,
  repositorySupplied,
} from '../src/claude-config.mjs'
import { claudeHookSpecs } from '../src/claude-hooks.mjs'
import {
  removeCliMcpConfig,
  sweepCliMcpConfigs,
  writeCliMcpConfig,
} from '../src/cli-mcp-config.mjs'
import {
  codexMcpServers,
  codexTrustsProject,
  gitVouchesForCheckout,
  type InheritedMcpServer,
  mainRepositoryRoot,
  verbatim,
} from '../src/codex-config.mjs'
import { notifyPayload } from '../src/codex-notify.mjs'
import { inheritedHooksWarning, mcpToolName, mcpToolRules } from '../src/inherited-config.mjs'
import { expandServerConfig, readMcpConfig } from '../src/mcp.mjs'
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
  CLAUDE_CODEX_CODEX_NOTIFY: undefined,
  CLAUDE_CODEX_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CODEX_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined,
  CLAUDE_CODEX_CLAUDE_MCP_SERVERS: undefined,
  CLAUDE_CODEX_CLAUDE_AGENTS: undefined,
  CLAUDE_CODEX_CLAUDE_PERMISSIONS: undefined,
  CLAUDE_CODEX_CLAUDE_HOOKS: undefined,
}

// A bridged Claude Code config folder (or none) with a switch value: only
// a bridged folder with the switch at exactly 1 brings that part along.
const switches: Array<[boolean, string | undefined]> = [
  [false, '1'],
  [true, undefined],
  [true, 'true'],
  [true, '1'],
]

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
bearer_token_env_var = "GITHUB_TOKEN"

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
        GITHUB_TOKEN: 'bearer-value',
      },
      async () => codexMcpServers(null),
    )
    assert.deepEqual(
      servers.map((server) => server.name),
      ['docs', 'local', 'remote'],
    )
    // Values from the environment never land in the configs, which go to
    // the CLI in a file: the configs refer to them as ${NAME}, for the CLI to
    // fill in from its environment.
    const configs = JSON.stringify(servers.map((server) => server.config))
    for (const secret of ['docs-token-value', 'header-value', 'bearer-value'])
      assert.ok(!configs.includes(secret), `${secret} is in the server configs`)
    const found = byName(servers)
    assert.deepEqual(found.docs, {
      name: 'docs',
      source: join(codexHome, 'config.toml'),
      config: {
        type: 'stdio',
        command: 'docs-mcp',
        args: ['--stdio'],
        env: {
          PATH: verbatim(process.env.PATH ?? ''),
          DOCS_TOKEN: '${DOCS_TOKEN}',
          DOCS_MODE: 'fast',
        },
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
      headers: {
        'X-Team': 'core',
        'X-Key': '${DOCS_HEADER}',
        Authorization: 'Bearer ${GITHUB_TOKEN}',
      },
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
    await write(join(repo, '.git', 'worktrees', 'wt', 'gitdir'), `${join(worktree, '.git')}\n`)
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
    // ${VAR} references are left for the CLI, which fills them in from its
    // own environment.
    assert.deepEqual(untrusted.remote?.config, {
      type: 'http',
      url: 'https://${TEAM}.example.com/mcp',
      headers: { Authorization: 'Bearer ${API_TOKEN:-none}', 'X-Other': '${MISSING_VAR}' },
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
      args: ['--team', '${TEAM}'],
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

test('Claude Code trust covers the project itself, never a folder above it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-claude-trust-'))
  const configDir = join(root, 'claude-config')
  const parent = join(root, 'parent')
  const repo = join(parent, 'repo')
  const nested = join(repo, 'vendor', 'nested')
  const worktree = join(root, 'worktree')
  try {
    await mkdir(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
    await mkdir(join(repo, 'src'), { recursive: true })
    await mkdir(join(nested, '.git'), { recursive: true })
    await mkdir(join(parent, 'plain'), { recursive: true })
    await write(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    await write(join(repo, '.git', 'worktrees', 'wt', 'gitdir'), `${join(worktree, '.git')}\n`)
    await write(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)
    const server = (command: string) => JSON.stringify({ mcpServers: { [command]: { command } } })
    await write(join(parent, '.mcp.json'), server('above'))
    await write(join(repo, '.mcp.json'), server('inside'))
    const stop = (command: string) => ({ Stop: [{ hooks: [{ type: 'command', command }] }] })
    await write(
      join(configDir, 'settings.json'),
      JSON.stringify({ enableAllProjectMcpServers: true, hooks: stop('user-hook') }),
    )
    await write(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(make:*)'] }, hooks: stop('repo-hook') }),
    )
    const trust = (folder: string) =>
      write(
        join(configDir, '.claude.json'),
        JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true } } }),
      )
    const read = (cwd: string) =>
      withEnv(
        { ...clean, CODEX_HOME: join(root, 'codex-home'), CLAUDE_CODEX_CLAUDE_HOOKS: 'project' },
        async () => ({
          trusted: claudeTrustsProject(cwd, configDir),
          servers: Object.keys(byName(claudeMcpServers(cwd, configDir))),
          allow: claudePermissionRules(cwd, configDir).allow,
          hooks: claudeHookSpecs(cwd, configDir).map((hook) => hook.command),
        }),
      )

    // Trust accepted for a folder above reaches neither a repository in it
    // nor a plain folder.
    await trust(parent)
    assert.equal((await read(parent)).trusted, true)
    assert.deepEqual(await read(repo), {
      trusted: false,
      servers: [],
      allow: [],
      hooks: ['user-hook'],
    })
    assert.equal((await read(join(parent, 'plain'))).trusted, false)

    await trust(repo)
    // A .mcp.json above the repository root is not the project's.
    assert.deepEqual(await read(repo), {
      trusted: true,
      servers: ['inside'],
      allow: ['Bash(make:*)'],
      hooks: ['user-hook', 'repo-hook'],
    })
    // A folder in the repository and a worktree of it share its trust; a
    // repository nested in it has its own.
    assert.equal((await read(join(repo, 'src'))).trusted, true)
    assert.equal((await read(worktree)).trusted, true)
    assert.equal((await read(nested)).trusted, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a settings.local.json the repository supplies approves and allows nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-claude-local-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  const git = (...args: string[]) =>
    assert.equal(spawnSync('git', args, { cwd: repo, stdio: 'ignore' }).status, 0)
  try {
    await mkdir(repo, { recursive: true })
    git('init', '-q')
    await write(
      join(repo, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          tool: { command: 'tool' },
          other: { command: 'other' },
          extra: { command: 'x' },
        },
      }),
    )
    await write(
      join(configDir, 'settings.json'),
      JSON.stringify({ enabledMcpjsonServers: ['tool', 'other'] }),
    )
    await write(
      join(configDir, '.claude.json'),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    )
    await write(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({
        enableAllProjectMcpServers: true,
        disabledMcpjsonServers: ['other'],
        permissions: { allow: ['Bash(curl:*)'], deny: ['WebFetch'] },
      }),
    )
    const read = () =>
      withEnv({ ...clean, CODEX_HOME: join(root, 'codex-home') }, async () => {
        const { allow, deny } = claudePermissionRules(repo, configDir)
        return { servers: Object.keys(byName(claudeMcpServers(repo, configDir))), allow, deny }
      })
    const supplied = { servers: ['tool'], allow: [], deny: ['WebFetch'] }

    // The user's own file.
    assert.deepEqual(await read(), {
      servers: ['tool', 'extra'],
      allow: ['Bash(curl:*)'],
      deny: ['WebFetch'],
    })
    // Checked in, it is the repository's: only what it takes away counts.
    git('add', '.claude/settings.local.json')
    assert.deepEqual(await read(), supplied)
    git('rm', '-q', '--cached', '.claude/settings.local.json')
    assert.deepEqual((await read()).allow, ['Bash(curl:*)'])
    // So is one reached through a symlinked .claude folder.
    await rename(join(repo, '.claude'), join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(repo, '.claude'))
    assert.deepEqual(await read(), supplied)
    await rm(join(repo, '.claude'))
    await rename(join(root, 'elsewhere'), join(repo, '.claude'))
    assert.deepEqual((await read()).allow, ['Bash(curl:*)'])

    // And one checked in under another spelling, which a case-insensitive
    // file system opens by this one (elsewhere it stands for this one).
    const local = join(repo, '.claude', 'settings.local.json')
    const contents = await readFile(local, 'utf8')
    await rename(join(repo, '.claude'), join(repo, '.claude-moving'))
    await rename(join(repo, '.claude-moving'), join(repo, '.Claude'))
    await rename(
      join(repo, '.Claude', 'settings.local.json'),
      join(repo, '.Claude', 'Settings.Local.json'),
    )
    git('add', '.Claude/Settings.Local.json')
    if (!existsSync(local)) await write(local, contents)
    assert.equal(repositorySupplied(local), true)
    assert.deepEqual(await read(), supplied)
    git('rm', '-q', '--cached', '.Claude/Settings.Local.json')
    assert.equal(repositorySupplied(local), false)

    // And one in a folder reached through a symlink anywhere below the
    // repository root, though git sees no settings.local.json there.
    const pkg = join(repo, 'vendor', 'pkg')
    await write(join(pkg, '.claude', 'settings.local.json'), contents)
    await symlink(join('vendor', 'pkg'), join(repo, 'pkg'))
    git('add', 'pkg')
    assert.equal(repositorySupplied(join(pkg, '.claude', 'settings.local.json')), false)
    assert.equal(repositorySupplied(join(repo, 'pkg', '.claude', 'settings.local.json')), true)
    // A symlink to the repository itself is the user's own way there.
    await symlink(repo, join(root, 'alias'))
    assert.equal(repositorySupplied(join(root, 'alias', '.claude', 'settings.local.json')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a .git file counts only as far as git vouches for it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inherited-git-pointer-')))
  const configDir = join(root, 'claude-config')
  const codexHome = join(root, 'codex-home')
  const trusted = join(root, 'trusted')
  const git = (cwd: string, ...args: string[]) => {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
    const ran = spawnSync('git', [...identity, ...args], { cwd, stdio: 'ignore' })
    assert.equal(ran.status, 0, `git ${args.join(' ')}`)
  }
  const shipped = JSON.stringify({ permissions: { allow: ['Bash(*)'] } })
  const trust = (...folders: string[]) =>
    write(
      join(configDir, '.claude.json'),
      JSON.stringify({
        projects: Object.fromEntries(
          folders.map((folder) => [folder, { hasTrustDialogAccepted: true }]),
        ),
      }),
    )
  const read = (cwd: string) =>
    withEnv({ ...clean, CODEX_HOME: codexHome }, async () => ({
      main: mainRepositoryRoot(cwd),
      codex: codexTrustsProject(cwd),
      claude: claudeTrustsProject(cwd, configDir),
      allow: claudePermissionRules(cwd, configDir).allow,
    }))
  try {
    await write(join(trusted, 'README.md'), 'Trusted.\n')
    git(trusted, 'init', '-q')
    git(trusted, 'add', 'README.md')
    git(trusted, 'commit', '-q', '-m', 'Initial commit')
    await write(
      join(codexHome, 'config.toml'),
      `[projects.${q(trusted)}]\ntrust_level = "trusted"\n`,
    )
    await trust(trusted)

    // A worktree git set up shares the main checkout's trust, and its own
    // uncommitted settings are the user's.
    const worktree = join(root, 'worktree')
    git(trusted, 'worktree', 'add', '-q', worktree)
    await write(join(worktree, '.claude', 'settings.local.json'), shipped)
    assert.deepEqual(await read(worktree), {
      main: trusted,
      codex: true,
      claude: true,
      allow: ['Bash(*)'],
    })

    // A folder in the trusted checkout whose .git file names the checkout's
    // own git folder is a repository of its own, trusted by nobody.
    const nested = join(trusted, 'vendor')
    await write(join(nested, '.git'), 'gitdir: ../.git\n')
    await write(join(nested, '.claude', 'settings.json'), shipped)
    await write(join(nested, '.claude', 'settings.local.json'), shipped)
    assert.deepEqual(await read(nested), { main: nested, codex: false, claude: false, allow: [] })
    assert.equal(repositorySupplied(join(nested, '.claude', 'settings.local.json')), true)

    // A folder of its own made up to look like a linked worktree of the
    // trusted repository: git would read the index it brings, where its
    // settings.local.json is not checked in.
    const forged = join(root, 'forged')
    await write(join(forged, '.git'), 'gitdir: meta\n')
    await write(join(forged, 'meta', 'commondir'), `${join(trusted, '.git')}\n`)
    await write(join(forged, 'meta', 'HEAD'), 'ref: refs/heads/main\n')
    await write(join(forged, 'meta', 'gitdir'), `${join(forged, '.git')}\n`)
    await write(join(forged, '.claude', 'settings.local.json'), shipped)
    assert.deepEqual(await read(forged), { main: forged, codex: false, claude: false, allow: [] })
    // Even trusted itself, the file it brings is not the user's.
    await trust(trusted, forged)
    assert.deepEqual((await read(forged)).allow, [])
    assert.equal(repositorySupplied(join(forged, '.claude', 'settings.local.json')), true)

    // Nor does a link to the real worktree's folder in git count, since that
    // folder points back at the worktree, not here.
    const linked = join(root, 'linked')
    const admin = join(trusted, '.git', 'worktrees', 'worktree')
    await mkdir(linked, { recursive: true })
    await symlink(admin, join(linked, 'meta'))
    await write(join(linked, '.git'), 'gitdir: meta\n')
    assert.equal(mainRepositoryRoot(linked), linked)
    await rm(join(linked, 'meta'))
    await write(join(linked, '.git'), `gitdir: ${admin}\n`)
    assert.equal(mainRepositoryRoot(linked), linked)
    assert.equal(gitVouchesForCheckout(linked), false)

    // A submodule's folder in git names it as its working tree.
    const sub = join(trusted, 'sub')
    await write(
      join(trusted, '.git', 'modules', 'sub', 'config'),
      '[core]\n\tworktree = ../../../sub\n',
    )
    await write(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n')
    assert.equal(gitVouchesForCheckout(sub), true)
    assert.equal(mainRepositoryRoot(sub), sub)
    assert.equal(gitVouchesForCheckout(nested), false)
    assert.equal(gitVouchesForCheckout(worktree), true)
    assert.equal(gitVouchesForCheckout(trusted), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a headersHelper runs for a user-scope server, for a local-scope one only when trusted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-claude-helper-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  const remote = { type: 'http', url: 'https://mcp.example.com/', headersHelper: './token.sh' }
  const global = (entry: Record<string, unknown>) =>
    write(
      join(configDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { user: remote },
        projects: { [repo]: { mcpServers: { local: remote }, ...entry } },
      }),
    )
  const helpers = () =>
    withEnv({ ...clean, CODEX_HOME: join(root, 'codex-home') }, async () =>
      Object.fromEntries(
        claudeMcpServers(repo, configDir).map((server) => [
          server.name,
          server.config.headersHelper ?? null,
        ]),
      ),
    )
  try {
    await mkdir(join(repo, '.git'), { recursive: true })
    await global({})
    assert.deepEqual(await helpers(), { user: './token.sh', local: null })
    await global({ hasTrustDialogAccepted: true })
    assert.deepEqual(await helpers(), { user: './token.sh', local: './token.sh' })
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
env_vars = ["OVERRIDDEN_TOKEN"]

[mcp_servers.narrow]
command = "codex-narrow"
enabled_tools = ["only"]
disabled_tools = ["never"]
env_vars = ["NARROW_TOKEN"]
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
      CLAUDE_CODEX_CLAUDE_MCP_SERVERS: '1',
      CLAUDE_CODEX_MCP_SERVERS: explicitFile,
      NARROW_TOKEN: 'narrow-secret',
      OVERRIDDEN_TOKEN: 'overridden-secret',
    }
    const snapshot = await withEnv(env, async () => readMcpConfig({ cwd: root }))
    assert.deepEqual(snapshot.sdkValue, {
      shared: { type: 'stdio', command: 'claude-shared', args: [] },
      narrow: {
        type: 'stdio',
        command: 'codex-narrow',
        args: [],
        env: { PATH: verbatim(process.env.PATH ?? ''), NARROW_TOKEN: '${NARROW_TOKEN}' },
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
  const { hooks } = sdkHooks(context)
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
  const none = sdkHooks({ mcpEnabledTools: {} } as unknown as RuntimeTurnContext)
  assert.equal(none.hooks, null)
  assert.equal(none.end, null)
  assert.equal(none.endBudgetSec(), 0)
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
env_vars = ["FIXTURE_TOKEN"]
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
  const optIn = {
    CODEX_HOME: codexHome,
    CLAUDE_CODEX_CODEX_MCP_SERVERS: '1',
    FIXTURE_TOKEN: 'fixture-secret',
  }
  await withServer(root, optIn, async ({ request, turn }) => {
    const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
    const normal = await turn(started.thread.id)
    assert.deepEqual(Object.keys(normal.mcpServers as object), ['everywhere', 'fixture'])
    // The config names the secret for the CLI to fill in from its
    // environment; the value is not in it.
    assert.ok(!JSON.stringify(normal.mcpServers).includes('fixture-secret'))
    const fixture = (normal.mcpServers as Record<string, { env?: object }>).fixture
    assert.deepEqual(fixture?.env, {
      PATH: verbatim(process.env.PATH ?? ''),
      FIXTURE_TOKEN: '${FIXTURE_TOKEN}',
    })
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
    // A server the adapter starts itself gets the value filled in.
    const env = await request('mcpServer/tool/call', {
      threadId: started.thread.id,
      server: 'fixture',
      tool: 'env',
      arguments: { value: 'FIXTURE_TOKEN' },
    })
    assert.deepEqual(env.content, [{ type: 'text', text: 'env:fixture-secret' }])
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

test('Claude threads get the Claude Code agents only when asked for', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-agents-server-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await write(
    join(configDir, 'agents', 'helper.md'),
    '---\nname: helper\ndescription: Helps\n---\nHelp.\n',
  )
  for (const [bridged, asked] of switches)
    await withServer(
      root,
      {
        CODEX_HOME: join(root, 'codex-home'),
        CLAUDE_CODEX_CLAUDE_CONFIG_DIR: bridged ? configDir : undefined,
        CLAUDE_CODEX_CLAUDE_AGENTS: asked,
      },
      async ({ request, turn }) => {
        const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
        const normal = await turn(started.thread.id)
        assert.deepEqual(
          normal.agents,
          bridged && asked === '1' ? { helper: { description: 'Helps', prompt: 'Help.' } } : null,
        )
        const summary = await turn(started.thread.id, {
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        })
        assert.equal(summary.agents, null)
      },
    )
  await rm(root, { recursive: true, force: true })
})

test('a bridged Claude Code config folder brings only its instructions unless asked for more', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-bridge-only-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await write(join(configDir, 'CLAUDE.md'), 'Bridged instructions.\n')
  await write(
    join(configDir, '.claude.json'),
    JSON.stringify({ mcpServers: { shared: { command: '/nonexistent/claude-shared' } } }),
  )
  await write(
    join(configDir, 'agents', 'helper.md'),
    '---\nname: helper\ndescription: Helps\n---\nHelp.\n',
  )
  await write(
    join(configDir, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(npm test:*)'], deny: ['WebFetch'], ask: ['Bash(git push:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-done' }] }] },
    }),
  )
  const base = { CODEX_HOME: join(root, 'codex-home'), CLAUDE_CODEX_CLAUDE_CONFIG_DIR: configDir }
  await withServer(root, base, async ({ request, turn }) => {
    const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
    const normal = await turn(started.thread.id)
    assert.match(normal.systemPromptAddendum ?? '', /Bridged instructions\./)
    assert.equal(normal.mcpServers, null)
    assert.equal(normal.agents, null)
    assert.equal(normal.inheritedAllowedTools, null)
    assert.equal(normal.inheritedAskRules, null)
    assert.deepEqual(normal.disallowedTools, [])
    assert.equal(normal.claudeHooks, null)
    // Nor does the App's MCP panel list its servers.
    for (const params of [{}, { threadId: started.thread.id }])
      assert.deepEqual((await request('mcpServerStatus/list', params)).data, [])
  })
  const asked = {
    ...base,
    CLAUDE_CODEX_CLAUDE_MCP_SERVERS: '1',
    CLAUDE_CODEX_CLAUDE_AGENTS: '1',
    CLAUDE_CODEX_CLAUDE_PERMISSIONS: '1',
  }
  await withServer(root, asked, async ({ request, turn }) => {
    const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
    const normal = await turn(started.thread.id)
    assert.deepEqual(Object.keys(normal.mcpServers as object), ['shared'])
    assert.deepEqual(Object.keys(normal.agents ?? {}), ['helper'])
    assert.deepEqual(normal.inheritedAllowedTools, ['Bash(npm test:*)'])
    assert.deepEqual(normal.disallowedTools, ['WebFetch'])
    // Hooks keep their own switch.
    assert.equal(normal.claudeHooks, null)
    for (const params of [{}, { threadId: started.thread.id }]) {
      const listed = await request('mcpServerStatus/list', params)
      assert.deepEqual(
        listed.data.map((entry: { name: string }) => entry.name),
        ['shared'],
      )
    }
  })
  await rm(root, { recursive: true, force: true })
})

// The options a native Claude session starts with for a turn context.
// `during` sees them while the session is open.
async function sessionOptions(
  overrides: Partial<RuntimeTurnContext>,
  during?: (options: Record<string, any>) => Promise<void>,
): Promise<Record<string, any>> {
  const runtime = new NativeClaudeRuntime()
  let captured: Record<string, any> | undefined
  Reflect.set(runtime, 'sdk', {
    query: async function* ({ options }: { options: Record<string, any> }) {
      captured = options
      await during?.(options)
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

// What the SDK runs the CLI with for these options. The SDK's own spawn
// hook catches the command line; the CLI never runs.
async function cliCommandLine(options: Record<string, any>): Promise<SpawnOptions> {
  let spawned: (spec: SpawnOptions) => void = () => {}
  const seen = new Promise<SpawnOptions>((resolve) => {
    spawned = resolve
  })
  const run = query({
    prompt: 'Hi.',
    options: {
      ...options,
      abortController: new AbortController(),
      pathToClaudeCodeExecutable: process.execPath,
      spawnClaudeCodeProcess: (spec) => {
        spawned(spec)
        // Stands in for the CLI: reads its input until the SDK closes it.
        return spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      },
    },
  })
  run.next().catch(() => {})
  const spec = await seen
  run.close()
  return spec
}

test('the native runtime passes inherited servers, tool rules and agents to the SDK', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-runtime-'))
  const home = join(root, 'adapter')
  try {
    await withEnv({ CLAUDE_CODEX_HOME: home }, async () => {
      const plain = await sessionOptions({})
      assert.equal(plain.disallowedTools, undefined)
      assert.equal(plain.agents, undefined)
      assert.equal(plain.hooks, undefined)
      assert.equal(plain.extraArgs, undefined)

      const agents = { helper: { description: 'Helps', prompt: 'Help.' } }
      const docs = { type: 'stdio', command: 'docs-mcp', env: { TOKEN: '${DOCS_TOKEN}' } }
      let file = ''
      const options = await sessionOptions(
        {
          mcpServers: { docs },
          disallowedTools: ['mcp__docs__drop'],
          mcpEnabledTools: { mcp__docs__: ['mcp__docs__read'] },
          agents,
        },
        async (options) => {
          // The servers reach the CLI in a file only the user can read.
          file = options.extraArgs['mcp-config']
          assert.equal(dirname(file), join(home, 'mcp-config'))
          assert.equal((await stat(file)).mode & 0o777, 0o600)
          assert.equal((await stat(dirname(file))).mode & 0o777, 0o700)
          assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mcpServers: { docs } })
        },
      )
      assert.equal(options.mcpServers, undefined)
      // It is gone with the session.
      const deadline = Date.now() + 5000
      while (existsSync(file) && Date.now() < deadline) await delay(10)
      assert.equal(existsSync(file), false)
      assert.deepEqual(options.disallowedTools, ['mcp__docs__drop'])
      assert.deepEqual(options.agents, agents)
      assert.equal(options.hooks.PreToolUse.length, 1)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('no inherited MCP server value reaches the SDK options or the CLI command line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-mcp-argv-'))
  const codexHome = join(root, 'codex-home')
  try {
    await write(
      join(codexHome, 'config.toml'),
      `[mcp_servers.docs]
command = "docs-mcp"
env = { DOCS_MODE = "literal-env-value" }
env_vars = ["DOCS_TOKEN"]

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
http_headers = { "X-Team" = "literal-header-value" }
env_http_headers = { "X-Key" = "DOCS_HEADER" }
bearer_token_env_var = "REMOTE_BEARER"
`,
    )
    const fromEnv = ['docs-token-secret', 'docs-header-secret', 'bearer-secret']
    const literal = ['literal-env-value', 'literal-header-value']
    const env = {
      ...clean,
      CODEX_HOME: codexHome,
      CLAUDE_CODEX_HOME: join(root, 'adapter'),
      CLAUDE_CODEX_CODEX_MCP_SERVERS: '1',
      DOCS_TOKEN: 'docs-token-secret',
      DOCS_HEADER: 'docs-header-secret',
      REMOTE_BEARER: 'bearer-secret',
    }
    await withEnv(env, async () => {
      const mcpServers = readMcpConfig({}).sdkValue
      let spec: SpawnOptions | undefined
      let written = ''
      const options = await sessionOptions({ mcpServers }, async (options) => {
        written = await readFile(options.extraArgs['mcp-config'], 'utf8')
        spec = await cliCommandLine(options)
      })
      // The file holds the settings, with references for the values from
      // the environment.
      for (const value of literal) assert.ok(written.includes(value), `${value} is not in the file`)
      for (const value of fromEnv) assert.ok(!written.includes(value), `${value} is in the file`)
      assert.ok(written.includes('Bearer ${REMOTE_BEARER}'))
      // The options and the command line hold none of them, past the
      // adapter's environment the CLI runs with, where the values from the
      // environment are under their own names.
      const { env: cliEnv, ...rest } = options
      const added = Object.entries(cliEnv).filter(([name, value]) => process.env[name] !== value)
      const serialized = JSON.stringify([rest, added])
      const args = spec?.args ?? []
      for (const value of [...fromEnv, ...literal]) {
        assert.ok(!serialized.includes(value), `${value} is in the SDK options`)
        assert.ok(!args.some((arg) => arg.includes(value)), `${value} is on the command line`)
      }
      const at = args.indexOf('--mcp-config')
      assert.ok(at > 0)
      assert.equal(args[at + 1], options.extraArgs['mcp-config'])
      assert.ok(!args.some((arg) => arg.includes('mcpServers')))
      // The CLI gets the values under their own names, to fill them in.
      assert.equal(spec?.env.DOCS_TOKEN, 'docs-token-secret')
      assert.deepEqual(
        Object.keys(spec?.env ?? {}).filter((name) => name.startsWith('CLAUDE_CODEX_MCP_')),
        [],
      )
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Codex server setting with ${...} in it reaches the server as written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-mcp-verbatim-'))
  const codexHome = join(root, 'codex-home')
  try {
    await write(
      join(codexHome, 'config.toml'),
      `[mcp_servers.raw]
command = "raw-\${HOME}"
args = ["\${HOME}", "$\${HOME}", "\${UNSET_NAME:-fallback}"]
env = { RAW = "\${RAW_SECRET}" }

[mcp_servers.remote]
url = "https://mcp.example.com/\${HOME}"
http_headers = { "X-Raw" = "\${RAW_SECRET}", "X-Two" = "\${\${RAW_SECRET}}" }
`,
    )
    const env = { ...clean, CODEX_HOME: codexHome, CLAUDE_CODEX_CODEX_MCP_SERVERS: '1' }
    const servers = byName(await withEnv(env, async () => codexMcpServers(null)))
    // What the server ends up with once the CLI has filled in what it fills in.
    const filled = (server: InheritedMcpServer | undefined) =>
      expandServerConfig(configOf(server), { HOME: '/home/user', RAW_SECRET: 'secret' })
    const raw = filled(servers.raw)
    assert.equal(raw.command, 'raw-${HOME}')
    assert.deepEqual(raw.args, ['${HOME}', '$${HOME}', '${UNSET_NAME:-fallback}'])
    assert.equal((raw.env as Record<string, string>).RAW, '${RAW_SECRET}')
    const remote = filled(servers.remote)
    assert.equal(remote.url, 'https://mcp.example.com/${HOME}')
    assert.deepEqual(remote.headers, { 'X-Raw': '${RAW_SECRET}', 'X-Two': '${${RAW_SECRET}}' })
    assert.equal(verbatim('no references'), 'no references')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the variable the ${ escape relies on stays unset even when exported', () => {
  const dist = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).href)
  // A CLI session gets the runtime's environment as it is when the session
  // starts, so what matters is that loading the runtime clears it.
  const script = `
    await import(${dist('native-runtime.mjs')})
    const cli = '__CLAUDE_CODEX_UNSET' in process.env
    const { verbatim } = await import(${dist('codex-config.mjs')})
    const { expandServerConfig } = await import(${dist('mcp.mjs')})
    const direct = expandServerConfig({ args: [verbatim('\${HOME}')] }, process.env).args[0]
    process.stdout.write(JSON.stringify({ cli, direct }))
  `
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, __CLAUDE_CODEX_UNSET: 'leaked' },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.deepEqual(JSON.parse(ran.stdout), { cli: false, direct: '${HOME}' })
})

test('the MCP config files of adapters that are gone are swept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inherited-mcp-sweep-'))
  try {
    assert.equal(writeCliMcpConfig({}, dir), null)
    assert.equal(writeCliMcpConfig(null, dir), null)
    const mine = writeCliMcpConfig({ docs: { type: 'stdio', command: 'docs-mcp' } }, dir)
    assert.ok(mine)
    // A process that has exited.
    const gone = spawnSync(process.execPath, ['-e', '']).pid
    const stale = join(dir, `${gone}-${randomUUID()}.json`)
    const alive = join(dir, `${process.ppid}-${randomUUID()}.json`)
    for (const file of [stale, alive, join(dir, 'notes.json')]) await write(file, '{}')
    assert.equal(sweepCliMcpConfigs(dir), 1)
    assert.deepEqual(
      (await readdir(dir)).sort(),
      [basename(mine), basename(alive), 'notes.json'].sort(),
    )
    removeCliMcpConfig(mine)
    removeCliMcpConfig(mine)
    assert.equal(sweepCliMcpConfigs(join(dir, 'missing')), 0)
    // However many sessions come and go, one exit handler removes their files.
    const listeners = process.listenerCount('exit')
    for (let i = 0; i < 20; i++) {
      const file = writeCliMcpConfig({ docs: { type: 'stdio', command: 'docs-mcp' } }, dir)
      assert.ok(file)
      removeCliMcpConfig(file)
    }
    assert.equal(process.listenerCount('exit'), listeners)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Claude Code permission rules: the user rules apply, project deny rules always, project allow rules when trusted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-permissions-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  try {
    await mkdir(repo, { recursive: true })
    // A real repository: its settings.local.json counts as the user's only
    // when git can tell it is not checked in.
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' }).status, 0)
    await write(
      join(configDir, 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(npm test:*)', 'Read(/notes/**)', 'Read(//etc/hosts)', 'Bash(/bin/ls)'],
          deny: ['Read(./.env)', 'WebFetch', 'Edit(/settings.json)'],
          ask: ['Bash(git push:*)', 'Read(/secrets/**)'],
          defaultMode: 'bypassPermissions',
        },
      }),
    )
    await write(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(make:*)'],
          deny: ['Bash(rm:*)', 'WebFetch'],
          ask: ['Edit(/package.json)'],
        },
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
    // Ask rules hold tools back, so the project's apply untrusted too.
    const ask = ['Bash(git push:*)', `Read(/${configDir}/secrets/**)`, 'Edit(/package.json)']
    assert.deepEqual(await read(), { allow: userAllow, deny, ask })

    await write(
      join(configDir, '.claude.json'),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    )
    assert.deepEqual(await read(), {
      allow: [...userAllow, 'Bash(make:*)', 'Edit(/src/**)'],
      deny,
      ask,
    })
    // No settings, no rules.
    assert.deepEqual(claudePermissionRules(join(root, 'elsewhere'), join(root, 'empty')), {
      allow: [],
      deny: [],
      ask: [],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude threads get the permission rules only when asked for', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-permissions-server-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await write(
    join(configDir, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(npm test:*)'], deny: ['WebFetch'], ask: ['Bash(git push:*)'] },
    }),
  )
  for (const [bridged, asked] of switches) {
    const on = bridged && asked === '1'
    await withServer(
      root,
      {
        CODEX_HOME: join(root, 'codex-home'),
        CLAUDE_CODEX_CLAUDE_CONFIG_DIR: bridged ? configDir : undefined,
        CLAUDE_CODEX_CLAUDE_PERMISSIONS: asked,
      },
      async ({ request, turn }) => {
        const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
        const normal = await turn(started.thread.id)
        assert.deepEqual(normal.inheritedAllowedTools, on ? ['Bash(npm test:*)'] : null)
        assert.deepEqual(normal.inheritedAskRules, on ? ['Bash(git push:*)'] : null)
        assert.deepEqual(normal.disallowedTools, on ? ['WebFetch'] : [])
        const summary = await turn(started.thread.id, {
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        })
        assert.equal(summary.inheritedAllowedTools, null)
        assert.equal(summary.inheritedAskRules, null)
      },
    )
  }
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

test('inherited ask rules send the calls they cover to the approval prompt, over allow rules and hooks', async () => {
  const approve = {
    event: 'PreToolUse',
    matcher: null,
    command:
      'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'',
    args: null,
    shell: 'sh' as const,
    timeoutSec: 30,
    async: false,
    if: null,
    source: 'settings.json',
  }
  const options = await withEnv({ CLAUDE_CODEX_PERMISSION_MODE: undefined }, () =>
    sessionOptions({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      inheritedAllowedTools: ['Bash(git:*)'],
      inheritedAskRules: ['Bash(git push:*)'],
      claudeHooks: [approve],
    }),
  )
  // The allow rule stays: the ask rule only takes precedence over it.
  assert.ok(options.allowedTools.includes('Bash(git:*)'))
  assert.equal(typeof options.canUseTool, 'function')
  const decisions = async (command: string) => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }
    const outputs = []
    for (const matcher of options.hooks.PreToolUse)
      for (const hook of matcher.hooks)
        outputs.push(
          (await hook(input, undefined, { signal: new AbortController().signal }))
            .hookSpecificOutput?.permissionDecision ?? null,
        )
    return outputs
  }
  // The guard asks; the user's hook still approves, and the CLI takes the
  // stricter of the two.
  assert.deepEqual(await decisions('git fetch && git push origin main'), ['ask', 'allow'])
  assert.deepEqual(await decisions('git status'), [null, 'allow'])
})

test('Claude threads run the Claude Code hooks only with the config folder bridged and the opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-hooks-server-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await write(
    join(configDir, 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] },
    }),
  )
  const cases: Array<[boolean, string | undefined]> = [
    [false, 'user'],
    [true, undefined],
    [true, 'user'],
  ]
  for (const [bridged, scope] of cases) {
    const runs = bridged && scope === 'user'
    await withServer(
      root,
      {
        CODEX_HOME: join(root, 'codex-home'),
        CLAUDE_CODEX_CLAUDE_CONFIG_DIR: bridged ? configDir : undefined,
        CLAUDE_CODEX_CLAUDE_HOOKS: scope,
      },
      async ({ request, turn }) => {
        const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
        const normal = await turn(started.thread.id)
        assert.deepEqual(
          normal.claudeHooks?.map((hook) => [hook.event, hook.matcher, hook.command]) ?? null,
          runs ? [['PreToolUse', 'Bash', 'guard']] : null,
        )
        const listed = await request('hooks/list', { cwds: [repo] })
        const commands = listed.data[0].hooks.map((hook: { command: string }) => hook.command)
        // hooks/list shows what the adapter runs.
        if (bridged) assert.deepEqual(commands, runs ? ['guard'] : [])
      },
    )
  }
  await rm(root, { recursive: true, force: true })
})

test('the native runtime registers the Claude Code hooks with the SDK', async () => {
  const hook = {
    event: 'PreToolUse',
    matcher: 'Bash',
    command:
      'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'',
    args: null,
    shell: 'sh' as const,
    timeoutSec: 30,
    async: false,
    if: null,
    source: 'settings.json',
  }
  const decision = async (overrides: Partial<RuntimeTurnContext>) => {
    const options = await withEnv({ CLAUDE_CODEX_PERMISSION_MODE: undefined }, () =>
      sessionOptions({ claudeHooks: [hook], mcpEnabledTools: { mcp__docs__: [] }, ...overrides }),
    )
    // The enabled_tools guard comes first, then the user's hook.
    assert.equal(options.hooks.PreToolUse.length, 2)
    const matcher = options.hooks.PreToolUse[1]
    assert.equal(matcher.matcher, 'Bash')
    const output = await matcher.hooks[0]({ tool_name: 'Bash' }, undefined, {
      signal: new AbortController().signal,
    })
    return output.hookSpecificOutput.permissionDecision ?? null
  }
  assert.equal(await decision({}), 'allow')
  assert.equal(await decision({ approvalPolicy: 'on-request', sandboxMode: 'read-only' }), null)
})

test('the notify event carries the fields Codex sends, in its order', () => {
  const event = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    cwd: '/work',
    client: 'codex-tui',
    inputMessages: ['Rename foo.'],
    lastAssistantMessage: 'Renamed.',
  }
  assert.equal(
    notifyPayload(event),
    '{"type":"agent-turn-complete","thread-id":"thread-1","turn-id":"turn-1","cwd":"/work","client":"codex-tui","input-messages":["Rename foo."],"last-assistant-message":"Renamed."}',
  )
  assert.deepEqual(
    Object.keys(JSON.parse(notifyPayload({ ...event, client: null, lastAssistantMessage: null }))),
    ['type', 'thread-id', 'turn-id', 'cwd', 'input-messages', 'last-assistant-message'],
  )
})

test('a completed Claude turn runs the Codex config notify program when enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inherited-notify-'))
  const codexHome = join(root, 'codex-home')
  const repo = join(root, 'repo')
  const script = join(root, 'notify.mjs')
  const calls = join(root, 'calls.jsonl')
  await mkdir(repo, { recursive: true })
  await write(
    script,
    "import { appendFileSync } from 'node:fs'\nappendFileSync(process.argv[2], `${JSON.stringify(process.argv.slice(3))}\\n`)\n",
  )
  await write(
    join(codexHome, 'config.toml'),
    `notify = [${q(process.execPath)}, ${q(script)}, ${q(calls)}]\n`,
  )
  const readCalls = async (count: number): Promise<string[][]> => {
    for (let i = 0; i < 100; i++) {
      const lines = await readFile(calls, 'utf8').then(
        (text) => text.split('\n').filter(Boolean),
        () => [],
      )
      if (lines.length >= count) return lines.map((line) => JSON.parse(line))
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.fail(`the notify program ran fewer than ${count} times`)
  }
  try {
    // Off unless asked for with exactly 1: the Codex App sets notify to its
    // own program.
    for (const value of [undefined, '0', 'true'])
      await withServer(
        root,
        { CODEX_HOME: codexHome, CLAUDE_CODEX_CODEX_NOTIFY: value },
        async ({ request, turn }) => {
          const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
          await turn(started.thread.id)
        },
      )
    await new Promise((resolve) => setTimeout(resolve, 300))
    await assert.rejects(readFile(calls, 'utf8'))

    const optIn = { CODEX_HOME: codexHome, CLAUDE_CODEX_CODEX_NOTIFY: '1' }
    await withServer(root, optIn, async ({ request, turn }) => {
      await request('initialize', { clientInfo: { name: 'notify-test-client', version: '1' } })
      const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
      // Summaries and other internal turns notify nobody.
      await turn(started.thread.id, {
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      })
      await turn(started.thread.id)
      const [call, ...rest] = await readCalls(1)
      assert.equal(rest.length, 0)
      assert.equal(call?.length, 1)
      const event = JSON.parse(call?.[0] ?? '{}')
      assert.equal(typeof event['turn-id'], 'string')
      assert.deepEqual(event, {
        type: 'agent-turn-complete',
        'thread-id': started.thread.id,
        'turn-id': event['turn-id'],
        cwd: repo,
        client: 'notify-test-client',
        'input-messages': ['Hi.'],
        'last-assistant-message': 'All done.',
      })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bridged hooks come with a warning about a CLI that would run them as well', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-hooks-warning-'))
  const warning = (env: Record<string, string | undefined>) =>
    withEnv({ ...clean, CLAUDE_CODEX_CLI: undefined, ...env }, async () => inheritedHooksWarning())
  try {
    const bridged = { CLAUDE_CODEX_CLAUDE_CONFIG_DIR: root }
    // No hooks bridged, nothing to say.
    assert.equal(await warning({}), null)
    assert.equal(await warning(bridged), null)
    assert.equal(await warning({ ...bridged, CLAUDE_CODEX_CLAUDE_HOOKS: '1' }), null)
    assert.equal(await warning({ CLAUDE_CODEX_CLAUDE_HOOKS: 'user' }), null)
    // The SDK's own CLI reads every setting source.
    const own = await warning({ ...bridged, CLAUDE_CODEX_CLAUDE_HOOKS: 'user' })
    assert.match(own ?? '', /^CLAUDE_CODEX_CLAUDE_HOOKS=user .*runs twice\. Set CLAUDE_CODEX_CLI/)
    assert.match(own ?? '', /--setting-sources ""/)
    // A named CLI may be a launcher that turns them off.
    const named = await warning({
      ...bridged,
      CLAUDE_CODEX_CLAUDE_HOOKS: 'project',
      CLAUDE_CODEX_CLI: join(root, 'claude'),
    })
    assert.match(named ?? '', /^CLAUDE_CODEX_CLAUDE_HOOKS=project .*CLAUDE_CODEX_CLI names has to/)
    assert.ok(!named?.includes(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
