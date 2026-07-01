import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export interface McpConfigSnapshot {
  sdkValue: unknown | null
  // mcpServerStatus/list -> Array<McpServerStatus>
  listStatuses: Array<Record<string, unknown>>
  // mcpServer/startupStatus/updated -> { name, status: McpServerStartupState, error }
  startupStatuses: Array<{ name: string; status: string; error: string | null }>
}

export function readMcpConfig(): McpConfigSnapshot {
  const raw = process.env.CLAUDE_CODEX_MCP_SERVERS
  if (!raw) return { sdkValue: null, listStatuses: [], startupStatuses: [] }

  try {
    const sdkValue = parseMcpValue(raw)
    const names = serverNames(sdkValue)
    return {
      sdkValue,
      listStatuses: names.map((name) => listStatusEntry(name)),
      // The adapter passes MCP servers straight to the Claude Agent SDK; it
      // does not run a separate startup handshake, so the optimistic terminal
      // state is "ready" rather than the invalid "pending".
      startupStatuses: names.map((name) => ({ name, status: 'ready', error: null })),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      sdkValue: null,
      listStatuses: [listStatusEntry('CLAUDE_CODEX_MCP_SERVERS')],
      startupStatuses: [{ name: 'CLAUDE_CODEX_MCP_SERVERS', status: 'failed', error: message }],
    }
  }
}

// Cache enumerated server statuses briefly: the App's MCP panel can poll
// mcpServerStatus/list, and each miss spawns one child process per server.
let statusCache: { key: string; at: number; data: Array<Record<string, unknown>> } | null = null
const STATUS_CACHE_MS = 10_000

// mcpServerStatus/list with real tools/resources enumerated from each server.
// Falls back to the conformant empty shape per server on any error/timeout so a
// single unreachable server never fails the whole list.
export async function listMcpServerStatuses(): Promise<Array<Record<string, unknown>>> {
  const snapshot = readMcpConfig()
  const names = serverNames(snapshot.sdkValue)
  const key = JSON.stringify(snapshot.sdkValue ?? null)
  if (statusCache && statusCache.key === key && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.data
  }
  const data = await Promise.all(names.map((name) => enumerateServerStatus(name)))
  statusCache = { key, at: Date.now(), data }
  return data
}

async function enumerateServerStatus(name: string): Promise<Record<string, unknown>> {
  const base = listStatusEntry(name)
  const [tools, resources, resourceTemplates] = await Promise.all([
    safeMcpList(name, 'tools/list', 'tools'),
    safeMcpList(name, 'resources/list', 'resources'),
    safeMcpList(name, 'resources/templates/list', 'resourceTemplates'),
  ])
  if (Array.isArray(tools)) base.tools = toolMap(tools)
  if (Array.isArray(resources)) {
    base.resources = resources.map((raw) => asRecord(raw)).filter((r) => typeof r.uri === 'string')
  }
  if (Array.isArray(resourceTemplates)) {
    base.resourceTemplates = resourceTemplates
      .map((raw) => asRecord(raw))
      .filter((r) => typeof r.uriTemplate === 'string')
  }
  return base
}

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
      },
    ])
  return Object.fromEntries(entries)
}

async function safeMcpList(name: string, method: string, key: string): Promise<unknown[] | null> {
  const result = await runMcpRequest(name, method, {}).then(
    (value) => asRecord(value),
    () => null,
  )
  if (!result) return null
  const value = result[key]
  return Array.isArray(value) ? value : []
}

export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const result = await runMcpRequest(serverName, 'tools/call', {
    name: toolName,
    arguments: args ?? {},
  })
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
): Promise<Record<string, unknown>> {
  const result = await runMcpRequest(serverName, 'resources/read', { uri })
  const record = asRecord(result)
  return { contents: Array.isArray(record.contents) ? record.contents : [] }
}

async function runMcpRequest(
  serverName: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const config = getServerConfig(serverName)
  if (config.type === 'http') {
    return runHttpMcpRequest(config, method, params)
  }
  if (config.type && config.type !== 'stdio') {
    throw new Error(
      `direct MCP ${method} only supports stdio servers; ${serverName} is ${config.type}`,
    )
  }
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
  let spawnError: Error | null = null
  // Without an error handler a failed spawn (for example ENOENT for a missing
  // server binary) emits an unhandled error and crashes the adapter.
  child.on('error', (error) => {
    spawnError = error
    for (const wait of pending.values()) wait.reject(error)
    pending.clear()
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
      const message = JSON.parse(line) as Record<string, unknown>
      const id = Number(message.id)
      const wait = pending.get(id)
      if (!wait) continue
      pending.delete(id)
      if (message.error) wait.reject(new Error(JSON.stringify(message.error)))
      else wait.resolve(message.result)
    }
  })

  const request = (requestMethod: string, requestParams: unknown): Promise<unknown> => {
    if (spawnError) return Promise.reject(spawnError)
    const id = nextId++
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: requestMethod, params: requestParams })}\n`,
    )
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }

  const timeout = setTimeout(() => {
    for (const wait of pending.values())
      wait.reject(new Error(`MCP request timed out${stderr ? `: ${stderr}` : ''}`))
    pending.clear()
    child.kill()
  }, 20_000)

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-codex-adapter', version: '0.1.0' },
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    )
    return await request(method, params)
  } finally {
    clearTimeout(timeout)
    child.kill()
  }
}

async function runHttpMcpRequest(
  config: Record<string, unknown>,
  method: string,
  params: unknown,
): Promise<unknown> {
  const url = stringOr(config.url, '')
  if (!url) throw new Error('HTTP MCP server has no url')
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...stringRecord(config.headers),
  }
  const initialize = await fetchJsonRpc(url, headers, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-codex-adapter', version: '0.1.0' },
    },
  })
  if (asRecord(initialize).error) throw new Error(JSON.stringify(asRecord(initialize).error))
  const response = await fetchJsonRpc(url, headers, { jsonrpc: '2.0', id: 2, method, params })
  const record = asRecord(response)
  if (record.error) throw new Error(JSON.stringify(record.error))
  return record.result
}

async function fetchJsonRpc(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP MCP request failed ${response.status}: ${text}`)
  const trimmed = text.trim()
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLine = trimmed.split('\n').find((line) => line.startsWith('data:'))
    return JSON.parse((dataLine ?? '').slice('data:'.length).trim())
  }
  return JSON.parse(trimmed)
}

function getServerConfig(serverName: string): Record<string, unknown> {
  const snapshot = readMcpConfig()
  const value = snapshot.sdkValue
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('CLAUDE_CODEX_MCP_SERVERS is not an object config')
  const config = (value as Record<string, unknown>)[serverName]
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error(`unknown MCP server: ${serverName}`)
  return config as Record<string, unknown>
}

function parseMcpValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }
  if (existsSync(trimmed)) {
    return trimmed
  }
  return JSON.parse(readFileSync(trimmed, 'utf8'))
}

function serverNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as Record<string, unknown>)
}

// Codex v2 McpServerStatus: { name, tools: { [name]: Tool }, resources: [],
// resourceTemplates: [], authStatus }. The adapter does not eagerly enumerate
// tools/resources, so it reports the conformant empty shape with authStatus
// "unsupported" (no Codex-managed OAuth) instead of a non-schema object.
function listStatusEntry(name: string): Record<string, unknown> {
  return {
    name,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: 'unsupported',
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
