import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  APP_PLUGIN_SERVER_ENV,
  appPluginMcpPlugins,
  appPluginServers,
  setAppPluginConfigOverrides,
} from '../src/app-plugin-mcp.mjs'
import { appMarketplacePlugin } from '../src/claude-capabilities.mjs'
import { toolCallMeta } from '../src/mcp.mjs'

const adapter = resolve('dist/src/adapter.mjs')
const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')

// The code-review plugin's server entry as the App bundles it: off unless
// the App's -c setting turns it on, started through /bin/sh with the App's
// Node, in the plugin's folder.
const codeReviewServer = {
  command: '/bin/sh',
  args: ['-c', 'exec "$CODEX_MCP_NODE_PATH" ./server.mjs "$@"', '--'],
  cwd: '.',
  enabled: false,
  tool_timeout_sec: 120,
  env_vars: [
    'PATH',
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CODEX_API_KEY',
    'CODEX_CLI_PATH',
    'CODEX_MCP_NODE_PATH',
  ],
}

// A plugin folder with its manifest and .mcp.json.
async function plugin(root: string, servers: Record<string, unknown>): Promise<string> {
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await writeFile(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'code-review', mcpServers: './.mcp.json' }),
  )
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
  return root
}

async function withCodexHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-app-plugin-mcp-'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  try {
    await run(home)
  } finally {
    setAppPluginConfigOverrides([])
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

const on = { CLAUDE_CODEX_APP_PLUGIN_MCP: '1', PATH: '/usr/bin:/bin', HOME: '/home/user' }

test('CLAUDE_CODEX_APP_PLUGIN_MCP names the plugins whose servers run', () => {
  assert.deepEqual([...appPluginMcpPlugins({})], [])
  assert.deepEqual([...appPluginMcpPlugins({ CLAUDE_CODEX_APP_PLUGIN_MCP: '0' })], [])
  assert.deepEqual([...appPluginMcpPlugins({ CLAUDE_CODEX_APP_PLUGIN_MCP: 'false' })], [])
  assert.deepEqual([...appPluginMcpPlugins({ CLAUDE_CODEX_APP_PLUGIN_MCP: '1' })], ['code-review'])
  assert.deepEqual(
    [
      ...appPluginMcpPlugins({
        CLAUDE_CODEX_APP_PLUGIN_MCP: 'code-review, latex,codex-app-tools,browser-use,../x',
      }),
    ],
    ['code-review', 'latex'],
  )
})

test('appPluginServers resolves enabled plugins from the Codex config and plugin cache', async () => {
  await withCodexHome(async (home) => {
    const root = await plugin(join(home, 'plugins', 'cache', 'market', 'code-review', '1.0.0'), {
      'code-review': { ...codeReviewServer, env: { FIXED: 'yes' } },
      codex_app: { command: './launch', cwd: '.' },
      remote: { type: 'http', url: 'https://example.com/mcp' },
      outside: { command: 'node', cwd: '../..' },
    })
    await writeFile(
      join(home, 'config.toml'),
      '[plugins."code-review@market"]\nenabled = true\n\n[plugins."latex@market"]\nenabled = true\n',
    )
    // Off by default, and the bundled entry is off until a setting turns it on.
    assert.deepEqual(appPluginServers([], { PATH: '/bin' }), [])
    assert.deepEqual(appPluginServers([], on), [])

    setAppPluginConfigOverrides([
      'model="gpt"',
      'plugins.code-review@market.mcp_servers.code-review.enabled=true',
    ])
    const env = {
      ...on,
      GH_CONFIG_DIR: '/home/user/.config/gh',
      GH_TOKEN: 'not-forwarded',
      GITHUB_TOKEN: 'not-forwarded',
      CODEX_API_KEY: 'not-forwarded',
      CODEX_CLI_PATH: '/usr/local/bin/codex',
      UNLISTED: 'not-forwarded',
    }
    const [server, ...rest] = appPluginServers([], env)
    assert.deepEqual(rest, [])
    assert.ok(server)
    assert.equal(server.name, 'code-review')
    assert.equal(server.pluginId, 'code-review@market')
    assert.equal(server.cwd, root)
    assert.equal(server.command, '/bin/sh')
    assert.deepEqual(server.args, codeReviewServer.args)
    assert.equal(server.toolTimeoutMs, 120_000)
    assert.equal(server.startupTimeoutMs, 10_000)
    // Codex's defaults, the listed variables but no credentials, the
    // server's own values, Node for CODEX_MCP_NODE_PATH and the marker.
    assert.deepEqual(server.env, {
      HOME: '/home/user',
      PATH: '/usr/bin:/bin',
      GH_CONFIG_DIR: '/home/user/.config/gh',
      CODEX_CLI_PATH: '/usr/local/bin/codex',
      CODEX_MCP_NODE_PATH: process.execPath,
      FIXED: 'yes',
      [APP_PLUGIN_SERVER_ENV]: '1',
    })
    assert.equal(
      appPluginServers([], { ...env, CODEX_MCP_NODE_PATH: '/app/node' })[0]?.env
        .CODEX_MCP_NODE_PATH,
      '/app/node',
    )

    // The App's own copy of the plugin wins over the cached one.
    const appRoot = await plugin(join(home, 'bundled', 'plugins', 'code-review'), {
      'code-review': codeReviewServer,
    })
    const installed = [{ id: 'code-review@market', root: appRoot }]
    assert.equal(appPluginServers(installed, on)[0]?.cwd, appRoot)
    // Plugins the switch does not name stay off.
    const other = [{ id: 'latex@market', root: appRoot }]
    assert.deepEqual(
      appPluginServers(other, on).map((entry) => entry.pluginId),
      ['code-review@market'],
    )

    // A later setting wins; the config's own server setting applies without one.
    setAppPluginConfigOverrides([
      'plugins.code-review@market.mcp_servers.code-review.enabled=true',
      'plugins.code-review@market.mcp_servers.code-review.enabled=false',
    ])
    assert.deepEqual(appPluginServers(installed, on), [])
    setAppPluginConfigOverrides([])
    await writeFile(
      join(home, 'config.toml'),
      '[plugins."code-review@market".mcp_servers.code-review]\nenabled = true\n',
    )
    assert.equal(appPluginServers(installed, on)[0]?.cwd, appRoot)
    // A plugin the config turns off stays off, the App's copy included.
    await writeFile(join(home, 'config.toml'), '[plugins."code-review@market"]\nenabled = false\n')
    setAppPluginConfigOverrides(['plugins.code-review@market.mcp_servers.code-review.enabled=true'])
    assert.deepEqual(appPluginServers(installed, on), [])
  })
})

test('appPluginServers keeps a plugin to its own folder', async () => {
  await withCodexHome(async (home) => {
    const root = join(home, 'plugin')
    await mkdir(join(root, '.codex-plugin'), { recursive: true })
    await writeFile(join(home, 'elsewhere.json'), JSON.stringify({ x: { command: 'node' } }))
    await writeFile(
      join(root, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ mcpServers: '../elsewhere.json' }),
    )
    assert.deepEqual(appPluginServers([{ id: 'code-review@market', root }], on), [])
    // Without a manifest entry the plugin's .mcp.json is read, bare or wrapped.
    await writeFile(join(root, '.codex-plugin', 'plugin.json'), '{}')
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({ x: { command: 'node' }, y: { command: 'node', cwd: '..' } }),
    )
    assert.deepEqual(
      appPluginServers([{ id: 'code-review@market', root }], on).map((entry) => entry.name),
      ['x'],
    )
  })
})

test('appMarketplacePlugin names any local plugin with its marketplace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-app-plugin-mcp-'))
  try {
    const manifest = await bundledMarketplace(directory)
    assert.deepEqual(appMarketplacePlugin(manifest, 'code-review'), {
      name: 'code-review',
      root: join(directory, 'plugins', 'code-review'),
      marketplace: 'test-market',
    })
    assert.equal(appMarketplacePlugin(manifest, 'missing'), null)
    assert.equal(appMarketplacePlugin('relative.json', 'code-review'), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// The App's bundled marketplace with a code-review plugin whose server is the
// test fixture.
async function bundledMarketplace(directory: string): Promise<string> {
  const manifest = join(directory, '.agents', 'plugins', 'marketplace.json')
  await mkdir(join(directory, '.agents', 'plugins'), { recursive: true })
  await writeFile(
    manifest,
    JSON.stringify({
      name: 'test-market',
      plugins: [
        { name: 'code-review', source: { source: 'local', path: './plugins/code-review' } },
      ],
    }),
  )
  const root = await plugin(join(directory, 'plugins', 'code-review'), {
    'code-review': codeReviewServer,
  })
  await copyFile(fixture, join(root, 'server.mjs'))
  return manifest
}

interface AdapterClient {
  readonly proc: ChildProcess
  request(method: string, params: Record<string, unknown>): Promise<any>
}

interface AdapterOptions {
  args?: string[]
  env?: Record<string, string>
}

// run gets an adapter on a fresh home, and a function that starts another
// one on the same home.
async function withAdapter(
  options: AdapterOptions,
  run: (
    client: AdapterClient,
    directory: string,
    manifest: string,
    restart: () => AdapterClient,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-app-plugin-mcp-'))
  const manifest = await bundledMarketplace(join(directory, 'bundled'))
  await mkdir(join(directory, 'codex-home'))
  const clients: AdapterClient[] = []
  const start = () => {
    const client = startAdapter(directory, options)
    clients.push(client)
    return client
  }
  try {
    await run(start(), directory, manifest, start)
  } finally {
    for (const { proc } of clients) {
      if (proc.exitCode == null && proc.signalCode == null) {
        proc.kill()
        await once(proc, 'exit')
      }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

function startAdapter(directory: string, options: AdapterOptions): AdapterClient {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CODEX_HOME: join(directory, 'codex-home'),
    CLAUDE_CODEX_HOME: join(directory, 'adapter-home'),
    CLAUDE_CODEX_MOCK: '1',
    NODE_NO_WARNINGS: '1',
    ...options.env,
  }
  delete env.CODEX_MCP_NODE_PATH
  delete env.CLAUDE_CODEX_MCP_SERVERS
  const proc = spawn(
    process.execPath,
    [adapter, 'app-server', '--listen', 'stdio://', ...(options.args ?? [])],
    { stdio: ['pipe', 'pipe', 'pipe'], env },
  )
  const waiting = new Map<number, (message: any) => void>()
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method != null) continue
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
  })
  let nextId = 1
  return {
    proc,
    request(method, params) {
      const id = nextId++
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolve) => waiting.set(id, resolve))
    },
  }
}

const enableCodeReview = [
  '-c',
  'plugins.code-review@test-market.mcp_servers.code-review.enabled=true',
]

test('the App reaches its code-review plugin server through a Claude host', async () => {
  let serverPid = 0
  await withAdapter(
    {
      args: enableCodeReview,
      env: {
        CLAUDE_CODEX_APP_PLUGIN_MCP: '1',
        GH_TOKEN: 'not-forwarded',
        GH_CONFIG_DIR: '/tmp/gh-config',
      },
    },
    async (client, directory, manifest) => {
      const install = await client.request('plugin/install', {
        marketplacePath: manifest,
        pluginName: 'code-review',
      })
      assert.deepEqual(install.result, { authPolicy: 'ON_USE', appsNeedingAuth: [] })
      const root = join(directory, 'bundled', 'plugins', 'code-review')
      const config = JSON.parse(
        await readFile(join(directory, 'adapter-home', 'config.json'), 'utf8'),
      )
      assert.deepEqual(config.installedAppPlugins, [{ id: 'code-review@test-market', root }])

      const status = await client.request('mcpServerStatus/list', {
        detail: 'toolsAndAuthOnly',
        serverName: 'code-review',
      })
      const [entry, ...others] = status.result.data
      assert.deepEqual(others, [])
      assert.equal(entry.name, 'code-review')
      assert.equal(entry.pluginId, 'code-review@test-market')
      assert.equal(entry.runtimeStatus, 'connected')
      assert.equal(entry.serverInfo.name, 'fixture')
      assert.equal(entry.toolsError, null)
      // The App finds the plugin's views and entry points in a tool's _meta.
      assert.deepEqual(entry.tools.echo.annotations, { readOnlyHint: true })
      assert.equal(entry.tools.echo.icons.length, 1)
      assert.deepEqual(entry.tools.echo._meta, {
        ui: { resourceUri: 'ui://fixture/view.html', visibility: ['app'] },
        'openai/ui': { entrypoints: [{ type: 'global' }] },
      })
      assert.equal(entry.resources[0].uri, 'fixture://resource')

      const call = (tool: string, args: Record<string, unknown> = {}) =>
        client.request('mcpServer/tool/call', {
          threadId: 'thread-1',
          server: 'code-review',
          tool,
          arguments: args,
          _meta: { thread_id: 'thread-1', threadId: 'thread-1' },
        })
      // One process serves every call, in the plugin's folder, and gets the
      // call's _meta.
      const first = await call('process')
      const second = await call('process')
      serverPid = first.result.structuredContent.pid
      assert.equal(second.result.structuredContent.pid, serverPid)
      assert.notEqual(serverPid, client.proc.pid)
      assert.equal(first.result.structuredContent.cwd, await realpath(root))
      assert.deepEqual(first.result.structuredContent.meta, {
        thread_id: 'thread-1',
        threadId: 'thread-1',
      })
      // As in Codex, the call's thread id is set in the _meta, made for a call
      // that has none.
      const metaOf = async (meta: Record<string, unknown>) =>
        (
          await client.request('mcpServer/tool/call', {
            threadId: 'thread-1',
            server: 'code-review',
            tool: 'process',
            arguments: {},
            ...meta,
          })
        ).result.structuredContent.meta
      assert.deepEqual(await metaOf({}), { threadId: 'thread-1' })
      assert.deepEqual(await metaOf({ _meta: { threadId: 'thread-2', other: 1 } }), {
        threadId: 'thread-1',
        other: 1,
      })
      const env = async (name: string) =>
        (await call('env', { value: name })).result.content[0].text
      assert.equal(await env('GH_CONFIG_DIR'), 'env:/tmp/gh-config')
      assert.equal(await env('GH_TOKEN'), 'env:')
      assert.equal(await env('CLAUDE_CODEX_MOCK'), 'env:')
      assert.equal(await env(APP_PLUGIN_SERVER_ENV), 'env:1')
      // The adapter answers the server's own pings.
      assert.equal((await call('ping')).result.content[0].text, 'pong:{}')

      const resource = await client.request('mcpServer/resource/read', {
        threadId: 'thread-1',
        server: 'code-review',
        uri: 'fixture://resource',
      })
      assert.equal(resource.result.contents[0].text, 'resource-ok')

      await client.request('plugin/uninstall', { pluginId: 'code-review@test-market' })
      const gone = await call('echo', { value: 'x' })
      assert.match(gone.error.message, /unknown MCP server: code-review/)
    },
  )
  // The server stops with the adapter.
  assert.ok(serverPid > 0)
  for (let attempt = 0; attempt < 50 && alive(serverPid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(alive(serverPid), false)
})

test('the code-review plugin server comes back after it exits and after an adapter restart', async () => {
  const options = { args: enableCodeReview, env: { CLAUDE_CODEX_APP_PLUGIN_MCP: '1' } }
  await withAdapter(options, async (client, _directory, manifest, restart) => {
    await client.request('plugin/install', { marketplacePath: manifest, pluginName: 'code-review' })
    const pidOf = async (adapterClient: AdapterClient): Promise<number | null> => {
      const call = await adapterClient.request('mcpServer/tool/call', {
        threadId: 'thread-1',
        server: 'code-review',
        tool: 'process',
        arguments: {},
      })
      return call.result?.structuredContent?.pid ?? null
    }
    const first = await pidOf(client)
    assert.ok(first)
    process.kill(first)
    let next: number | null = null
    for (let attempt = 0; attempt < 50 && (next == null || next === first); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      next = await pidOf(client)
    }
    assert.ok(next && next !== first, 'expected a new server process')

    // The next adapter knows the installed plugin from its config.
    client.proc.kill()
    await once(client.proc, 'exit')
    const restarted = restart()
    const status = await restarted.request('mcpServerStatus/list', { serverName: 'code-review' })
    assert.equal(status.result.data.length, 1)
    assert.equal(status.result.data[0].pluginId, 'code-review@test-market')
    assert.equal(status.result.data[0].runtimeStatus, 'connected')
  })
})

test('the code-review plugin server stays off without the switch or the App setting', async () => {
  for (const options of [
    { args: enableCodeReview },
    { env: { CLAUDE_CODEX_APP_PLUGIN_MCP: '1' } },
  ]) {
    await withAdapter(options, async (client, _directory, manifest) => {
      await client.request('plugin/install', {
        marketplacePath: manifest,
        pluginName: 'code-review',
      })
      const status = await client.request('mcpServerStatus/list', {})
      assert.deepEqual(status.result.data, [])
      const call = await client.request('mcpServer/tool/call', {
        server: 'code-review',
        tool: 'echo',
        arguments: {},
      })
      assert.match(call.error.message, /unknown MCP server: code-review/)
    })
  }
})

test('a tool call carries its thread id in the _meta as in Codex', () => {
  assert.deepEqual(toolCallMeta(null, 'thread-1'), { threadId: 'thread-1' })
  assert.deepEqual(toolCallMeta(undefined, 'thread-1'), { threadId: 'thread-1' })
  assert.deepEqual(toolCallMeta({ thread_id: 'thread-1', threadId: 'old' }, 'thread-1'), {
    thread_id: 'thread-1',
    threadId: 'thread-1',
  })
  // A _meta that is not an object, and a call without a thread, stay as sent.
  assert.equal(toolCallMeta('text', 'thread-1'), 'text')
  assert.deepEqual(toolCallMeta([1], 'thread-1'), [1])
  assert.deepEqual(toolCallMeta({ a: 1 }, ''), { a: 1 })
  assert.equal(toolCallMeta(undefined, ''), null)
})

test('an App plugin server cannot start a second app-server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-app-plugin-mcp-'))
  try {
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        [APP_PLUGIN_SERVER_ENV]: '1',
      },
    })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const [code] = await once(proc, 'exit')
    assert.equal(code, 1)
    assert.match(stderr, /App plugin servers cannot run the app-server/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// A process that has exited, even one not yet reaped, is not alive.
function alive(pid: number): boolean {
  if (existsSync('/proc/self/stat')) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
