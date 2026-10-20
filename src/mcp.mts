import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  type AppPluginServer,
  appPluginRequest,
  appPluginServers,
  type InstalledAppPlugin,
  startAppPluginServer,
} from './app-plugin-mcp.mjs'
import { inheritedMcpServers, type McpToolRules, mcpToolRules } from './inherited-config.mjs'
import { ownVariable, remoteCredential } from './mcp-credentials.mjs'
import type { RuntimeMcpServerStatus } from './types.mjs'

export interface McpConfigSnapshot {
  sdkValue: unknown | null
  // mcpServerStatus/list -> Array<McpServerStatus>
  listStatuses: Array<Record<string, unknown>>
  // mcpServer/startupStatus/updated -> { name, status: McpServerStartupState, error }
  startupStatuses: Array<{ name: string; status: string; error: string | null }>
  // The Codex config's tool lists for the inherited servers still in use.
  toolRules: McpToolRules
}

export interface McpConfigScope {
  // The thread's folder, for the servers its project adds; null for the
  // servers that apply in every folder.
  readonly cwd?: string | null
  // false leaves out the servers the Codex and Claude Code configs bring.
  readonly inherit?: boolean
  // The App plugins plugin/install named. Their MCP servers answer the App's
  // own requests when CLAUDE_CODEX_APP_PLUGIN_MCP names them (see
  // app-plugin-mcp.mts); a name the Claude config has stays Claude's.
  readonly appPlugins?: readonly InstalledAppPlugin[]
}

// CLAUDE_CODEX_MCP_SERVERS, over the servers the Codex and Claude Code
// configs bring (see inherited-config.mts); it wins a name.
export function readMcpConfig(scope: McpConfigScope = {}): McpConfigSnapshot {
  const inherited = scope.inherit === false ? [] : inheritedMcpServers(scope.cwd ?? null)
  const servers: Record<string, unknown> = {}
  for (const server of inherited) servers[server.name] = server.config
  const raw = process.env.CLAUDE_CODEX_MCP_SERVERS
  let failure: string | null = null
  if (raw) {
    try {
      for (const [name, config] of Object.entries(explicitServers(parseMcpValue(raw)))) {
        delete servers[name]
        servers[name] = config
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  const names = Object.keys(servers)
  const used = inherited.filter((server) => servers[server.name] === server.config)
  const snapshot: McpConfigSnapshot = {
    sdkValue: names.length > 0 ? servers : null,
    toolRules: mcpToolRules(used),
    listStatuses: names.map((name) => listStatusEntry(name)),
    // The adapter passes MCP servers straight to the Claude Agent SDK; it
    // does not run a separate startup handshake, so the optimistic terminal
    // state is "ready" rather than the invalid "pending".
    startupStatuses: names.map((name) => ({ name, status: 'ready', error: null })),
  }
  if (failure) {
    snapshot.listStatuses.push(listStatusEntry('CLAUDE_CODEX_MCP_SERVERS'))
    snapshot.startupStatuses.push({
      name: 'CLAUDE_CODEX_MCP_SERVERS',
      status: 'failed',
      error: failure,
    })
  }
  return snapshot
}

// Cache enumerated server statuses briefly: the App's MCP panel can poll
// mcpServerStatus/list, and each miss spawns one child process per server.
let statusCache: { key: string; at: number; data: Array<Record<string, unknown>> } | null = null
const STATUS_CACHE_MS = 10_000

// mcpServerStatus/list with real tools/resources enumerated from each server.
// Falls back to the conformant empty shape per server on any error/timeout so a
// single unreachable server never fails the whole list. session is what the
// thread's live Claude session says of its servers, when it has one.
export async function listMcpServerStatuses(
  scope: McpConfigScope = {},
  session: readonly RuntimeMcpServerStatus[] | null = null,
): Promise<Array<Record<string, unknown>>> {
  const snapshot = readMcpConfig(scope)
  const names = serverNames(snapshot.sdkValue)
  const plugins = pluginServers(names, scope)
  const key = JSON.stringify([
    snapshot.sdkValue ?? null,
    plugins.map((server) => [server.pluginId, server.name, server.cwd]),
  ])
  let data =
    statusCache && statusCache.key === key && Date.now() - statusCache.at < STATUS_CACHE_MS
      ? statusCache.data
      : null
  if (!data) {
    data = await Promise.all([
      ...names.map((name) => enumerateServerStatus(name, snapshot.sdkValue)),
      ...plugins.map((server) => pluginServerStatus(server)),
    ])
    statusCache = { key, at: Date.now(), data }
  }
  return session ? data.map((status) => withSessionStatus(status, session)) : data
}

// Codex's McpServerConnectionStatus for each state Claude Code gives an MCP
// server in a live session.
const SESSION_STATES = new Map([
  ['connected', 'connected'],
  ['failed', 'failed'],
  ['needs-auth', 'authenticationRequired'],
  ['pending', 'starting'],
  ['disabled', 'disabled'],
])

// runtimeStatus is the state of the thread's own connection to the server,
// which only the thread's live Claude session knows. A server the session
// does not list, or a plugin server the adapter runs itself, keeps what the
// adapter found.
function withSessionStatus(
  status: Record<string, unknown>,
  session: readonly RuntimeMcpServerStatus[],
): Record<string, unknown> {
  if (status.pluginId != null) return status
  const seen = session.find((server) => server.name === status.name)
  if (!seen) return status
  return {
    ...status,
    runtimeStatus: SESSION_STATES.get(seen.status) ?? null,
    serverInfo:
      status.serverInfo ??
      (seen.serverInfo ? mcpServerInfo(seen.serverInfo, String(status.name)) : null),
  }
}

// config/mcpServer/reload: the next mcpServerStatus/list asks the servers
// again instead of answering from the cache.
export function resetMcpStatusCache(): void {
  statusCache = null
}

// mcpServer/oauth/login: Claude Code signs in to an MCP server itself, and the
// Agent SDK has no call that starts that sign-in, so there is no authorization
// URL to give the App.
export function mcpOauthUnavailable(name: string): string {
  const server = name ? `"${name}"` : 'the server'
  return `Claude Code signs in to MCP servers itself, and the adapter cannot start that sign-in. Sign in to ${server} with /mcp in a Claude Code session that has it configured.`
}

// The App plugin servers a request can reach: those whose names the Claude
// config does not have.
function pluginServers(claudeNames: readonly string[], scope: McpConfigScope): AppPluginServer[] {
  if (!scope.appPlugins) return []
  return appPluginServers(scope.appPlugins).filter((server) => !claudeNames.includes(server.name))
}

function pluginServerFor(serverName: string, scope: McpConfigScope): AppPluginServer | null {
  const servers = scope.appPlugins ? appPluginServers(scope.appPlugins) : []
  const server = servers.find((candidate) => candidate.name === serverName)
  if (!server || serverNames(readMcpConfig(scope).sdkValue).includes(serverName)) return null
  return server
}

// A plugin server's status as Codex reports it: connected with the server's
// own info once it has started, failed with the reason otherwise.
async function pluginServerStatus(server: AppPluginServer): Promise<Record<string, unknown>> {
  const status: Record<string, unknown> = {
    ...listStatusEntry(server.name),
    runtimeStatus: 'failed',
    pluginId: server.pluginId,
  }
  let capabilities: Record<string, unknown>
  try {
    const initialized = await startAppPluginServer(server)
    capabilities = asRecord(initialized.capabilities)
    status.runtimeStatus = 'connected'
    status.serverInfo = mcpServerInfo(initialized.serverInfo, server.name)
    status.serverCapabilities = initialized.capabilities ?? null
  } catch (error) {
    status.toolsError = errorText(error)
    return status
  }
  const request = (method: string, params: unknown) => appPluginRequest(server, method, params)
  if (capabilities.tools) {
    try {
      const tools = await listPages(request, 'tools/list', 'tools')
      status.tools = toolMap(tools.items)
      status.toolListMeta = tools.meta
    } catch (error) {
      status.toolsError = errorText(error)
    }
  }
  if (capabilities.resources) {
    const [resources, templates] = await Promise.all([
      listPages(request, 'resources/list', 'resources').catch(() => null),
      listPages(request, 'resources/templates/list', 'resourceTemplates').catch(() => null),
    ])
    status.resources = resourceList(resources?.items ?? [])
    status.resourceTemplates = templateList(templates?.items ?? [])
  }
  return status
}

// A Claude server's status from the adapter's own look at it: one connection
// that initializes the server and lists its tools and resources. A server it
// cannot reach on its own (another transport, or a sign-in Claude Code keeps)
// is left as unknown rather than failed. runtimeStatus stays null here: it is
// the state of a thread's connection, see withSessionStatus.
async function enumerateServerStatus(
  name: string,
  servers: unknown,
): Promise<Record<string, unknown>> {
  const status = listStatusEntry(name)
  let connection: McpConnection
  try {
    const config = configFrom(servers, name)
    status.httpOrigin = httpOrigin(config)
    connection = await connectMcp(name, config)
  } catch (error) {
    if (!(error instanceof OutOfReach)) status.toolsError = errorText(error)
    return status
  }
  try {
    const { initialized } = connection
    const capabilities = asRecord(initialized.capabilities)
    if (isObject(initialized.serverInfo)) {
      status.serverInfo = mcpServerInfo(initialized.serverInfo, name)
    }
    if (isObject(initialized.capabilities)) status.serverCapabilities = initialized.capabilities
    const [tools, resources, templates] = await Promise.allSettled([
      listPages(connection.request, 'tools/list', 'tools'),
      listPages(connection.request, 'resources/list', 'resources'),
      listPages(connection.request, 'resources/templates/list', 'resourceTemplates'),
    ])
    if (tools.status === 'fulfilled') {
      status.tools = toolMap(tools.value.items)
      status.toolListMeta = tools.value.meta
    } else if (capabilities.tools) {
      // A server that does not offer tools has none to fail to list.
      status.toolsError = errorText(tools.reason)
    }
    if (resources.status === 'fulfilled') status.resources = resourceList(resources.value.items)
    if (templates.status === 'fulfilled') {
      status.resourceTemplates = templateList(templates.value.items)
    }
  } finally {
    connection.close()
  }
  return status
}

// Every page of a list, up to 20, and the _meta of the first: Codex reports
// a tool catalog's _meta as toolListMeta.
async function listPages(
  request: (method: string, params: unknown) => Promise<unknown>,
  method: string,
  key: string,
): Promise<{ items: unknown[]; meta: Record<string, unknown> | null }> {
  const items: unknown[] = []
  let meta: Record<string, unknown> | null = null
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const result = asRecord(await request(method, cursor == null ? {} : { cursor }))
    if (page === 0 && isObject(result._meta)) meta = result._meta
    if (Array.isArray(result[key])) items.push(...(result[key] as unknown[]))
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null
    if (cursor == null) break
  }
  return { items, meta }
}

function resourceList(items: unknown[]): Record<string, unknown>[] {
  return items.map(asRecord).filter((resource) => typeof resource.uri === 'string')
}

function templateList(items: unknown[]): Record<string, unknown>[] {
  return items.map(asRecord).filter((template) => typeof template.uriTemplate === 'string')
}

// Codex's McpServerInfo from the serverInfo of an initialize reply: every
// field present, null where the server gave none.
function mcpServerInfo(raw: unknown, fallbackName: string): Record<string, unknown> {
  const info = asRecord(raw)
  const text = (value: unknown) => (typeof value === 'string' ? value : null)
  return {
    name: stringOr(info.name, fallbackName),
    title: text(info.title),
    version: text(info.version) ?? '',
    description: text(info.description),
    icons: Array.isArray(info.icons) ? info.icons : null,
    websiteUrl: text(info.websiteUrl),
  }
}

// The origin of a remote server's url as Codex reports it: scheme, host and
// port, without credentials or path; null for a server that is not reached
// over HTTP.
function httpOrigin(config: Record<string, unknown>): string | null {
  if (typeof config.url !== 'string') return null
  try {
    const url = new URL(config.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

// The tools as Codex lists them, annotations, icons and _meta included: the
// App finds a plugin's views and entry points in a tool's _meta.
function toolMap(tools: unknown[]): Record<string, Record<string, unknown>> {
  const entries = tools
    .map((raw) => asRecord(raw))
    .filter((tool): tool is Record<string, unknown> & { name: string } => {
      return typeof tool.name === 'string'
    })
    .map((tool) => [
      tool.name,
      {
        name: tool.name,
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema ?? {},
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(isObject(tool.annotations) ? { annotations: tool.annotations } : {}),
        ...(Array.isArray(tool.icons) ? { icons: tool.icons } : {}),
        ...(isObject(tool._meta) ? { _meta: tool._meta } : {}),
      },
    ])
  return Object.fromEntries(entries)
}

// The _meta Codex hands the server with a client's tool call: the client's
// own, with the thread's id set in it. A _meta that is not an object stays
// as it is.
export function toolCallMeta(meta: unknown, threadId: string): unknown {
  if (!threadId) return meta ?? null
  if (meta == null) return { threadId }
  return isObject(meta) ? { ...meta, threadId } : meta
}

// meta is the _meta the server gets with the call, see toolCallMeta.
export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: unknown,
  scope: McpConfigScope = {},
  meta: unknown = null,
): Promise<Record<string, unknown>> {
  const result = await routeMcpRequest(
    serverName,
    'tools/call',
    {
      name: toolName,
      arguments: args ?? {},
      ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? { _meta: meta } : {}),
    },
    scope,
  )
  const record = asRecord(result)
  return {
    content: Array.isArray(record.content) ? record.content : [],
    structuredContent: record.structuredContent ?? null,
    isError: Boolean(record.isError),
    _meta: record._meta ?? null,
  }
}

export async function readMcpResource(
  serverName: string,
  uri: string,
  scope: McpConfigScope = {},
): Promise<Record<string, unknown>> {
  const result = await routeMcpRequest(serverName, 'resources/read', { uri }, scope)
  const record = asRecord(result)
  return { contents: Array.isArray(record.contents) ? record.contents : [] }
}

function routeMcpRequest(
  serverName: string,
  method: string,
  params: unknown,
  scope: McpConfigScope,
): Promise<unknown> {
  const plugin = pluginServerFor(serverName, scope)
  return plugin
    ? appPluginRequest(plugin, method, params)
    : runMcpRequest(serverName, method, params, scope)
}

async function runMcpRequest(
  serverName: string,
  method: string,
  params: unknown,
  scope: McpConfigScope,
): Promise<unknown> {
  const connection = await connectMcp(serverName, getServerConfig(serverName, scope))
  try {
    return await connection.request(method, params)
  } finally {
    connection.close()
  }
}

// A connection to a server the adapter reaches itself, past the initialize
// handshake: the server's reply to it, and requests over the same connection.
interface McpConnection {
  readonly initialized: Record<string, unknown>
  readonly request: (method: string, params: unknown) => Promise<unknown>
  readonly close: () => void
}

// The adapter speaks to stdio and http servers on its own. Another transport,
// or a remote server that wants the sign-in Claude Code keeps for it, is out
// of its reach, which says nothing of how Claude reaches the server.
class OutOfReach extends Error {}

const INITIALIZE_PARAMS = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'claude-codex-adapter', version: '0.1.0' },
}

async function connectMcp(
  serverName: string,
  config: Record<string, unknown>,
): Promise<McpConnection> {
  if (config.type === 'http') return connectHttp(config)
  if (config.type && config.type !== 'stdio') {
    throw new OutOfReach(
      `direct MCP requests only support stdio and http servers; ${serverName} is ${config.type}`,
    )
  }
  return connectStdio(serverName, config)
}

async function connectStdio(
  serverName: string,
  config: Record<string, unknown>,
): Promise<McpConnection> {
  const command = stringOr(config.command, '')
  if (!command) throw new Error(`MCP server ${serverName} has no command`)
  const child = spawn(command, Array.isArray(config.args) ? config.args.map(String) : [], {
    env: { ...process.env, ...stringRecord(config.env) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  let nextId = 1
  let buffer = ''
  let stderr = ''
  // Why the connection ended; every request still waiting, and every later
  // one, fails with it.
  let ended: Error | null = null
  const end = (error: Error) => {
    ended ??= error
    for (const wait of pending.values()) wait.reject(error)
    pending.clear()
  }
  // Without an error handler a failed spawn (for example ENOENT for a missing
  // server binary) emits an unhandled error and crashes the adapter.
  child.on('error', end)
  // A server that exits leaves nothing to wait for. Its output is read by
  // now, so every answer it gave has arrived.
  child.on('close', (code) => {
    end(
      new Error(
        `MCP server exited${code == null ? '' : ` with code ${code}`}${stderrNote(stderr)}`,
      ),
    )
  })
  // child.stdin can emit EPIPE when spawn fails; the child error above carries
  // the useful cause, so keep this stream from becoming an unhandled error too.
  child.stdin.on('error', () => undefined)
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let lineEnd: number
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd).trim()
      buffer = buffer.slice(lineEnd + 1)
      if (!line || !line.startsWith('{')) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const id = Number(message.id)
      const wait = pending.get(id)
      if (!wait) continue
      pending.delete(id)
      if (message.error) wait.reject(new Error(JSON.stringify(message.error)))
      else wait.resolve(message.result)
    }
  })

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (ended) return Promise.reject(ended)
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  const timeout = setTimeout(() => {
    end(new Error(`MCP request timed out${stderrNote(stderr)}`))
    child.kill()
  }, 20_000)
  const close = () => {
    clearTimeout(timeout)
    end(new Error('MCP connection closed'))
    child.kill()
  }

  try {
    const initialized = asRecord(await request('initialize', INITIALIZE_PARAMS))
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    )
    return { initialized, request, close }
  } catch (error) {
    close()
    throw error
  }
}

async function connectHttp(config: Record<string, unknown>): Promise<McpConnection> {
  const url = stringOr(config.url, '')
  if (!url) throw new Error('HTTP MCP server has no url')
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...stringRecord(config.headers),
  }
  let nextId = 1
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const body = { jsonrpc: '2.0', id: nextId++, method, params }
    const record = asRecord(await fetchJsonRpc(url, headers, body))
    if (record.error) throw new Error(JSON.stringify(record.error))
    return record.result
  }
  const initialized = asRecord(await request('initialize', INITIALIZE_PARAMS))
  return { initialized, request, close: () => {} }
}

async function fetchJsonRpc(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    throw new OutOfReach(`HTTP MCP request failed ${response.status}: ${text}`)
  }
  if (!response.ok) throw new Error(`HTTP MCP request failed ${response.status}: ${text}`)
  const trimmed = text.trim()
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLine = trimmed.split('\n').find((line) => line.startsWith('data:'))
    return JSON.parse((dataLine ?? '').slice('data:'.length).trim())
  }
  return JSON.parse(trimmed)
}

// What a stdio server wrote to stderr, to go with an error.
function stderrNote(stderr: string): string {
  const text = stderr.trim()
  return text ? `: ${text}` : ''
}

// A server's config with its ${VAR} references filled in, as the CLI
// would fill them in for the servers it starts.
function getServerConfig(serverName: string, scope: McpConfigScope): Record<string, unknown> {
  return configFrom(readMcpConfig(scope).sdkValue, serverName)
}

// The named server's config in the servers by name, filled in the same way.
function configFrom(value: unknown, serverName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`unknown MCP server: ${serverName}`)
  const config = (value as Record<string, unknown>)[serverName]
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error(`unknown MCP server: ${serverName}`)
  return expandServerConfig(config as Record<string, unknown>, process.env)
}

// ${NAME} and ${NAME:-default} in the places the CLI expands them: a stdio
// server's command, arguments and env, a remote server's url and headers,
// the headers twice, as the CLI fills them in when it reads the config and
// again when it connects. A variable set, even to nothing, wins over the
// default, and a missing one without a default stays as written. Like the
// CLI, this never fills in Claude's own variables (ANTHROPIC_*, CLAUDE_CODE_*
// and the like) that are set, and toward a remote server not the credentials
// on the CLI's list either: there those read as empty, set or not.
export function expandServerConfig(
  config: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const fill = (text: string, remote: boolean): string =>
    text.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (whole, name: string, fallback: string | undefined) => {
        const found = env[name]
        if (remote ? remoteCredential(name) : found !== undefined && ownVariable(name)) return ''
        if (found !== undefined) return found
        return fallback ?? whole
      },
    )
  const local = (text: string) => fill(text, false)
  const remote = (text: string) => fill(text, true)
  const record = (value: unknown, expand: (text: string) => string) =>
    Object.fromEntries(Object.entries(stringRecord(value)).map(([key, raw]) => [key, expand(raw)]))
  const out = { ...config }
  if (typeof out.command === 'string') out.command = local(out.command)
  if (Array.isArray(out.args)) out.args = out.args.map((arg) => local(String(arg)))
  if (typeof out.url === 'string') out.url = remote(out.url)
  if (out.env) out.env = record(out.env, local)
  if (out.headers) out.headers = record(out.headers, (text) => remote(remote(text)))
  return out
}

function parseMcpValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }
  if (!existsSync(trimmed)) throw new Error(`MCP config file not found: ${trimmed}`)
  return JSON.parse(readFileSync(trimmed, 'utf8'))
}

// The servers by name; a file may wrap them in "mcpServers" as Claude Code's
// .mcp.json does.
function explicitServers(value: unknown): Record<string, unknown> {
  const record = asRecord(value)
  const wrapped = asRecord(record.mcpServers)
  return Object.keys(record).length === 1 && Object.keys(wrapped).length > 0 ? wrapped : record
}

function serverNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as Record<string, unknown>)
}

// Codex v2 McpServerStatus before anything is known of the server: every
// field the 0.159 to 0.164 protocols require, null where the adapter cannot
// say, and authStatus "unsupported" (Claude Code, not Codex, signs in to
// these servers).
function listStatusEntry(name: string): Record<string, unknown> {
  return {
    name,
    runtimeStatus: null,
    pluginId: null,
    httpOrigin: null,
    serverInfo: null,
    serverCapabilities: null,
    toolListMeta: null,
    tools: {},
    toolsError: null,
    resources: [],
    resourceTemplates: [],
    authStatus: 'unsupported',
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, String(raw)]),
  )
}
