import { type ChildProcess, spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { asTable, codexUserConfigPath, readTomlFile } from './codex-config.mjs'
import { codexHome, debugLog, isPathInside } from './util.mjs'

// The MCP servers of the Codex App's bundled plugins, run for the App's own
// requests: mcpServer/tool/call, mcpServer/resource/read and
// mcpServerStatus/list. Some App panels talk to a plugin's server through the
// host rather than through a thread; the Pull Requests panel, for one, calls
// the code-review plugin's server. Codex starts these servers from the
// plugins its config enables, and so does the adapter, but only with
// CLAUDE_CODEX_APP_PLUGIN_MCP set and only for the plugins it names: their
// code runs as the user, with the host's own logins (such as the gh CLI's).
// Claude threads never see these servers' tools.

// Set in a plugin server's environment. A plugin that runs `codex app-server`
// through the shim would otherwise start a second adapter on the same state
// (see adapter.mts).
export const APP_PLUGIN_SERVER_ENV = 'CLAUDE_CODEX_APP_PLUGIN_SERVER'

// `1` names the plugin the App's Pull Requests panel needs.
const DEFAULT_PLUGINS = ['code-review']

// Plugins and servers that need the App itself, its tool pipe or the browser
// it drives, and cannot run on their own.
const EXCLUDED_PLUGINS = new Set(['codex-app-tools', 'browser-use'])
const EXCLUDED_SERVERS = new Set(['codex_app', 'browser-use', 'browser_use'])

// What Codex passes every stdio server on macOS and Linux, before the
// variables a server lists itself.
const DEFAULT_ENV = [
  'HOME',
  'LOGNAME',
  'PATH',
  'SHELL',
  'USER',
  '__CF_USER_TEXT_ENCODING',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
]

// Credentials stay with the tools that keep them: a variable named like one
// is not passed on even when a plugin lists it, so a plugin reaches GitHub
// through the host's gh login rather than a token in the adapter's
// environment.
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(^|_)(API_?)?KEY$/i

type Env = Record<string, string | undefined>

const NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface InstalledAppPlugin {
  // <plugin>@<marketplace>, as the Codex config names it.
  readonly id: string
  readonly root: string
}

export interface AppPluginServer {
  readonly name: string
  readonly pluginId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly startupTimeoutMs: number
  readonly toolTimeoutMs: number
}

// The plugins CLAUDE_CODEX_APP_PLUGIN_MCP names: `1` or `true` for the
// code-review plugin, or a comma-separated list of plugin names. Unset, `0`
// or `false` runs none.
export function appPluginMcpPlugins(env: Env = process.env): Set<string> {
  const raw = (env.CLAUDE_CODEX_APP_PLUGIN_MCP ?? '').trim()
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return new Set()
  const names =
    raw === '1' || raw.toLowerCase() === 'true'
      ? DEFAULT_PLUGINS
      : raw.split(',').map((name) => name.trim())
  return new Set(names.filter((name) => NAME.test(name) && !EXCLUDED_PLUGINS.has(name)))
}

// `-c key=value` settings from the command line the App starts the
// app-server with, as Codex layers them over config.toml. Only the
// plugins.* keys matter here: the App turns the code-review server on with
// plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true.
let configOverrides: Array<{ path: string[]; value: unknown }> = []

export function setAppPluginConfigOverrides(values: readonly string[]): void {
  configOverrides = values.flatMap((raw) => {
    const at = raw.indexOf('=')
    if (at <= 0) return []
    const path = raw
      .slice(0, at)
      .trim()
      .split('.')
      .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    if (path[0] !== 'plugins' || path.some((part) => !part)) return []
    return [{ path, value: overrideValue(raw.slice(at + 1).trim()) }]
  })
}

function overrideValue(text: string): unknown {
  if (text === 'true') return true
  if (text === 'false') return false
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function setting(path: readonly string[], fallback: unknown): unknown {
  for (let index = configOverrides.length - 1; index >= 0; index--) {
    const override = configOverrides[index] as { path: string[]; value: unknown }
    if (override.path.length === path.length && override.path.every((part, i) => part === path[i]))
      return override.value
  }
  return fallback
}

// The servers of the named plugins that are installed and enabled: those
// $CODEX_HOME/config.toml enables (installed in Codex's plugin cache), and
// those the App installed through plugin/install unless the config turns
// them off. A server runs when the -c settings, the config or else its own
// .mcp.json entry enable it. A name the Claude config has stays Claude's.
export function appPluginServers(
  installed: readonly InstalledAppPlugin[],
  env: Env = process.env,
): AppPluginServer[] {
  const wanted = appPluginMcpPlugins(env)
  if (wanted.size === 0) return []
  const config = asTable(asTable(readTomlFile(codexUserConfigPath()))?.plugins) ?? {}
  const roots = new Map<string, string>()
  for (const id of Object.keys(config).sort()) {
    const parts = pluginIdParts(id)
    if (!parts || !wanted.has(parts.name)) continue
    if (setting(['plugins', id, 'enabled'], asTable(config[id])?.enabled) === false) continue
    const root = cachedPluginRoot(parts.name, parts.marketplace)
    if (root) roots.set(id, root)
  }
  for (const plugin of installed) {
    const parts = pluginIdParts(plugin.id)
    if (!parts || !wanted.has(parts.name)) continue
    if (setting(['plugins', plugin.id, 'enabled'], asTable(config[plugin.id])?.enabled) === false)
      continue
    roots.set(plugin.id, plugin.root)
  }
  const servers: AppPluginServer[] = []
  for (const [pluginId, root] of roots) {
    const configured = asTable(asTable(config[pluginId])?.mcp_servers) ?? {}
    for (const [name, entry] of Object.entries(pluginMcpServers(root))) {
      if (EXCLUDED_SERVERS.has(name) || servers.some((server) => server.name === name)) continue
      const enabled = setting(
        ['plugins', pluginId, 'mcp_servers', name, 'enabled'],
        asTable(configured[name])?.enabled ?? entry.enabled,
      )
      if (enabled === false) continue
      const server = stdioServer(name, pluginId, root, entry, env)
      if (server) servers.push(server)
    }
  }
  return servers
}

function pluginIdParts(id: string): { name: string; marketplace: string } | null {
  const at = id.lastIndexOf('@')
  const name = id.slice(0, at)
  const marketplace = id.slice(at + 1)
  return at > 0 && NAME.test(name) && NAME.test(marketplace) ? { name, marketplace } : null
}

// Codex installs a plugin at $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/
// <version>; the most recently written version is the one in use.
function cachedPluginRoot(name: string, marketplace: string): string | null {
  const dir = join(codexHome(), 'plugins', 'cache', marketplace, name)
  let best: { root: string; at: number } | null = null
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue
      const root = join(dir, entry.name)
      const at = statSync(join(root, '.codex-plugin', 'plugin.json'), { throwIfNoEntry: false })
      if (at && (!best || at.mtimeMs > best.at)) best = { root, at: at.mtimeMs }
    }
  } catch {
    return null
  }
  return best?.root ?? null
}

// The servers a plugin declares: the file its manifest's mcpServers names
// (by default .mcp.json), or the servers written into the manifest, with or
// without the "mcpServers" wrapper.
function pluginMcpServers(root: string): Record<string, Record<string, unknown>> {
  const manifest = readJson(join(root, '.codex-plugin', 'plugin.json'))
  const declared = manifest?.mcpServers ?? '.mcp.json'
  let value: Record<string, unknown> | null = null
  if (typeof declared === 'string') {
    const path = resolve(root, declared)
    if (isPathInside(root, path)) value = readJson(path)
  } else {
    value = asTable(declared)
  }
  const servers = asTable(value?.mcpServers) ?? value ?? {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, entry] of Object.entries(servers)) {
    const table = asTable(entry)
    if (table && NAME.test(name)) out[name] = table
  }
  return out
}

function stdioServer(
  name: string,
  pluginId: string,
  root: string,
  entry: Record<string, unknown>,
  env: Env,
): AppPluginServer | null {
  const type = typeof entry.type === 'string' ? entry.type : 'stdio'
  if (type !== 'stdio' || typeof entry.url === 'string') return null
  if (typeof entry.command !== 'string' || !entry.command) return null
  const cwd = resolve(root, typeof entry.cwd === 'string' ? entry.cwd : '.')
  if (cwd !== root && !isPathInside(root, cwd)) return null
  return {
    name,
    pluginId,
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    cwd,
    env: serverEnv(entry, env),
    startupTimeoutMs: seconds(entry.startup_timeout_sec, 10),
    toolTimeoutMs: seconds(entry.tool_timeout_sec, 60),
  }
}

// Codex's default variables, the ones the server lists in env_vars (but
// none named like a credential, nor those a remote host would supply), and
// the values its env sets. CODEX_MCP_NODE_PATH, which the App sets to its
// bundled Node, falls back to the Node running the adapter.
function serverEnv(entry: Record<string, unknown>, env: Env): Record<string, string> {
  const out: Record<string, string> = {}
  const pass = (name: string): void => {
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  for (const name of DEFAULT_ENV) pass(name)
  const listed = Array.isArray(entry.env_vars) ? entry.env_vars : []
  for (const item of listed) {
    const table = asTable(item)
    const name = typeof item === 'string' ? item : table?.name
    if (typeof name !== 'string' || !ENV_NAME.test(name) || table?.source === 'remote') continue
    if (CREDENTIAL_NAME.test(name)) continue
    pass(name)
    if (name === 'CODEX_MCP_NODE_PATH' && !out[name]) out[name] = process.execPath
  }
  for (const [name, value] of Object.entries(asTable(entry.env) ?? {}))
    if (ENV_NAME.test(name)) out[name] = String(value)
  out[APP_PLUGIN_SERVER_ENV] = '1'
  return out
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : fallback * 1000
}

// One process per server, kept running across requests: the App polls these
// servers, and a large one takes a while to start. A server whose command,
// folder or variables change, or that exits, starts afresh on the next
// request.
const connections = new Map<string, ServerConnection>()

// The server's initialize result, once it is running.
export function startAppPluginServer(server: AppPluginServer): Promise<Record<string, unknown>> {
  return connection(server).initialized
}

export async function appPluginRequest(
  server: AppPluginServer,
  method: string,
  params: unknown,
): Promise<unknown> {
  const open = connection(server)
  await open.initialized
  return open.request(method, params, server.toolTimeoutMs)
}

export function stopAppPluginServers(): void {
  for (const open of connections.values()) open.stop()
  connections.clear()
}

function connection(server: AppPluginServer): ServerConnection {
  const key = JSON.stringify([
    server.pluginId,
    server.command,
    server.args,
    server.cwd,
    Object.entries(server.env).sort(([left], [right]) => left.localeCompare(right)),
  ])
  const open = connections.get(server.name)
  if (open && !open.closed && open.key === key) return open
  open?.stop()
  const fresh = new ServerConnection(server, key)
  connections.set(server.name, fresh)
  return fresh
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

class ServerConnection {
  readonly key: string
  readonly initialized: Promise<Record<string, unknown>>
  closed = false
  private readonly name: string
  private readonly child: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private failure: Error | null = null
  private nextId = 1
  private buffer = ''
  private stderr = ''

  constructor(server: AppPluginServer, key: string) {
    this.key = key
    this.name = server.name
    this.child = spawn(server.command, [...server.args], {
      cwd: server.cwd,
      env: { ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // A failed spawn (a missing command, say) must not crash the adapter.
    this.child.on('error', (error) => this.close(error))
    this.child.on('exit', (code, signal) =>
      this.close(new Error(`MCP server ${this.name} exited (${signal ?? code})${this.tail()}`)),
    )
    this.child.stdin?.on('error', () => undefined)
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-2000)
    })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk) => this.read(String(chunk)))
    this.initialized = this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-codex-adapter', version: '0.1.0' },
      },
      server.startupTimeoutMs,
    ).then((result) => {
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return asTable(result) ?? {}
    })
    // A server that does not come up is dropped; the next request retries.
    this.initialized.catch((error: Error) => {
      debugLog('app_plugin_mcp_start_failed', { server: this.name, error: error.message })
      this.stop()
    })
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed)
      return Promise.reject(this.failure ?? new Error(`MCP server ${this.name} stopped`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.send({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'timed out' },
        })
        reject(new Error(`MCP ${method} to ${this.name} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  stop(): void {
    this.close(new Error(`MCP server ${this.name} stopped`))
    this.child.kill()
  }

  private close(error: Error): void {
    if (!this.closed) this.failure = error
    this.closed = true
    for (const wait of this.pending.values()) wait.reject(this.failure ?? error)
    this.pending.clear()
  }

  private send(message: Record<string, unknown>): void {
    if (this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let lineEnd: number
    while ((lineEnd = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, lineEnd).trim()
      this.buffer = this.buffer.slice(lineEnd + 1)
      if (!line.startsWith('{')) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.receive(message)
    }
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.method === 'string') {
      // The adapter offers the server no client features: it answers pings
      // and turns down every other request. Notifications need no answer.
      if (message.id === undefined || message.id === null) return
      this.send(
        message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` },
            },
      )
      return
    }
    const wait = this.pending.get(Number(message.id))
    if (!wait) return
    this.pending.delete(Number(message.id))
    if (message.error) wait.reject(new Error(JSON.stringify(message.error)))
    else wait.resolve(message.result)
  }

  private tail(): string {
    const text = this.stderr.trim()
    return text ? `: ${text.slice(-500)}` : ''
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return asTable(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
