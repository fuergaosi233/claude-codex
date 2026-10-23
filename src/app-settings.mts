import { asTable, codexMcpServer, type InheritedMcpServer, mergeTables } from './codex-config.mjs'
import { INVALID_REQUEST, RpcError } from './host-methods.mjs'
import { codexHome } from './util.mjs'

// What the Codex App's settings write with config/value/write and
// config/batchWrite, and what each write does for Claude threads. The adapter
// keeps the settings in its own config file rather than in config.toml, so a
// write is honest only where a Claude thread acts on it:
//
// - mcp_servers.<name>: the servers added under Settings > MCP servers. With
//   CLAUDE_CODEX_APP_MCP_SERVERS=1 Claude threads run them (see
//   appMcpServers); otherwise a write that would change them is refused with
//   a message saying so, and the servers already saved stay saved, unused.
// - A setting Claude has no counterpart for fails when it sets a value, so the
//   App shows the setting as not saved; clearing it succeeds. config/read
//   reports what Claude threads actually do for it, but for the network
//   access the App's permission presets need unset (see server.mts).
// - Everything else is kept as written and reported back by config/read:
//   settings the adapter applies itself (model, effort, approval policy,
//   sandbox mode, web search, reasoning summaries, memories) and the App's own
//   state (desktop.*, plugins.*, projects.*, features.*, and so on).

type Table = Record<string, unknown>

export interface ConfigEdit {
  readonly keyPath: string
  readonly value: unknown
  // Codex's MergeStrategy: replace sets the value as given, upsert merges a
  // table into the one already there.
  readonly mergeStrategy: 'replace' | 'upsert'
}

// Whether the servers added in the App's MCP settings apply to Claude threads.
// Off unless asked for: a server added there starts a program, or reaches a
// URL, from every Claude thread, which is more than the settings page says.
export function appMcpServersEnabled(): boolean {
  return process.env.CLAUDE_CODEX_APP_MCP_SERVERS === '1'
}

// What the App's MCP settings show when a save, switch or delete is refused
// because the servers do not apply.
export const APP_MCP_SERVERS_OFF =
  "MCP servers added in the App are not used for Claude threads unless the adapter runs with CLAUDE_CODEX_APP_MCP_SERVERS=1. You can also add a server to Claude Code's own MCP config (claude mcp add, or a project's .mcp.json)."

// App rule: desktop-mcp-servers
// The servers the App's main process writes into the user config each time it
// starts, for its own Codex threads: they run the App's desktop tools with the
// App's private environment, so Claude threads do not run them and the
// adapter does not keep them.
const DESKTOP_MCP_SERVERS = new Set(['node_repl', 'cua_repl'])

// The App names a server it adds with these characters, as Codex requires.
const SERVER_NAME = /^[A-Za-z0-9_-]+$/

function invalid(message: string): RpcError {
  return new RpcError(message, undefined, INVALID_REQUEST)
}

// The fields of a Codex [mcp_servers.<name>] entry the App's form writes, with
// the type Codex takes for each. A value of another type fails, as Codex fails
// to read it back.
const FIELD_TYPES: Record<string, (value: unknown) => boolean> = {
  command: (value) => typeof value === 'string',
  args: (value) => stringArray(value),
  env: (value) => asTable(value) != null,
  env_vars: (value) => Array.isArray(value),
  cwd: (value) => typeof value === 'string',
  url: (value) => typeof value === 'string',
  bearer_token_env_var: (value) => typeof value === 'string',
  http_headers: (value) => asTable(value) != null,
  env_http_headers: (value) => asTable(value) != null,
  enabled: (value) => typeof value === 'boolean',
  required: (value) => typeof value === 'boolean',
  startup_timeout_sec: (value) => typeof value === 'number',
  startup_timeout_ms: (value) => typeof value === 'number',
  tool_timeout_sec: (value) => typeof value === 'number',
  enabled_tools: (value) => stringArray(value),
  disabled_tools: (value) => stringArray(value),
  scopes: (value) => stringArray(value),
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

// Why `entry` cannot be server `name`, or null when it can: it starts either
// a command or a URL, and its fields have the types Codex reads.
function serverEntryProblem(name: string, entry: Table): string | null {
  const command = typeof entry.command === 'string' && entry.command.length > 0
  const url = typeof entry.url === 'string' && entry.url.length > 0
  if (command === url) return `mcp_servers.${name} needs either a command or a url`
  for (const [field, value] of Object.entries(entry)) {
    const check = FIELD_TYPES[field]
    if (check && !check(value)) return `mcp_servers.${name}.${field} has the wrong type`
  }
  return null
}

// `table` with the value at `path` set, or removed for null.
function withPath(table: Table, path: readonly string[], value: unknown, upsert: boolean): Table {
  const [key, ...rest] = path
  if (key === undefined) return table
  const out: Table = { ...table }
  if (rest.length > 0) {
    out[key] = withPath(asTable(out[key]) ?? {}, rest, value, upsert)
    return out
  }
  const prior = asTable(out[key])
  const next = asTable(value)
  if (value == null) delete out[key]
  else out[key] = upsert && prior && next ? mergeTables(prior, next) : value
  return out
}

// Applies an edit of the mcp_servers table to `settings`, the adapter's saved
// settings, or throws an RpcError the App shows without anything changing.
// The App's MCP settings replace a server's whole entry on save and delete
// it with null, and upsert its `enabled` field when switched.
export function editMcpServers(settings: Table, edit: ConfigEdit): void {
  const [, name, ...field] = edit.keyPath.split('.')
  if (name !== undefined && DESKTOP_MCP_SERVERS.has(name)) return
  const upsert = edit.mergeStrategy === 'upsert'
  const prior = asTable(settings.mcp_servers) ?? {}
  let servers: Table
  if (name === undefined) {
    const table = asTable(edit.value)
    if (edit.value != null && !table) throw invalid('mcp_servers must be a table of servers')
    servers = upsert ? { ...prior } : {}
    for (const [key, entry] of Object.entries(table ?? {})) {
      if (DESKTOP_MCP_SERVERS.has(key)) continue
      servers = withPath(servers, [key], entry, upsert)
    }
  } else {
    if (!SERVER_NAME.test(name)) throw invalid(`invalid MCP server name: ${name}`)
    if (field.length > 0 && !asTable(prior[name]))
      throw invalid(`no MCP server named ${name} in the App's settings`)
    if (field.length === 0 && edit.value != null && !asTable(edit.value))
      throw invalid(`mcp_servers.${name} must be a table`)
    servers = withPath(prior, [name, ...field], edit.value, upsert)
  }
  // A server the edit removes is a change too: with the servers off, what was
  // saved stays as it is.
  const changed = [...new Set([...Object.keys(prior), ...Object.keys(servers)])].filter(
    (key) => servers[key] !== prior[key],
  )
  if (changed.length > 0 && !appMcpServersEnabled()) throw invalid(APP_MCP_SERVERS_OFF)
  for (const key of changed) {
    if (!Object.hasOwn(servers, key)) continue
    if (!SERVER_NAME.test(key)) throw invalid(`invalid MCP server name: ${key}`)
    const entry = asTable(servers[key])
    if (!entry) throw invalid(`mcp_servers.${key} must be a table`)
    const problem = serverEntryProblem(key, entry)
    if (problem) throw invalid(problem)
  }
  if (Object.keys(servers).length > 0) settings.mcp_servers = servers
  else delete settings.mcp_servers
}

// The servers the App's settings hold: what its MCP settings list and edit
// (config/read reports them only while they apply).
export function appMcpServerTable(settings: Table): Table {
  const out: Table = {}
  for (const [name, entry] of Object.entries(asTable(settings.mcp_servers) ?? {})) {
    if (!DESKTOP_MCP_SERVERS.has(name) && asTable(entry)) out[name] = entry
  }
  return out
}

// The App's MCP settings save to the file config/read names as the origin of
// mcp_servers, and say they are unavailable without one; a server whose
// origin is a user file can be edited there. With the servers off the origin
// is still reported, but no server: the page lists none, and a save shows
// APP_MCP_SERVERS_OFF under the form rather than a page that only says the
// settings are unavailable.
// App rule: mcp-settings
export function appMcpServerOrigins(settings: Table, origin: unknown): Table {
  const out: Table = { mcp_servers: origin }
  if (!appMcpServersEnabled()) return out
  for (const name of Object.keys(appMcpServerTable(settings))) out[`mcp_servers.${name}`] = origin
  return out
}

// The servers the App's settings add to Claude threads: the enabled ones, as
// Codex starts them. `source` is the file the adapter keeps them in. A
// relative cwd is relative to CODEX_HOME, the folder of the config file Codex
// would keep them in.
export function appMcpServers(settings: Table, source: string): InheritedMcpServer[] {
  if (!appMcpServersEnabled()) return []
  const servers: InheritedMcpServer[] = []
  for (const [name, entry] of Object.entries(appMcpServerTable(settings))) {
    const server = codexMcpServer(name, entry as Table, source, codexHome())
    if (server) servers.push(server)
  }
  return servers
}

// The settings Claude threads have no counterpart for, and what a write that
// sets one is told. A value listed in `accepts` is what Claude threads do
// anyway, so writing it succeeds and nothing is kept.
interface Unsupported {
  readonly reason: string
  readonly accepts?: (value: unknown) => boolean
}

const UNSUPPORTED: Record<string, Unsupported> = {
  // Settings > Configuration > Verbosity.
  model_verbosity: { reason: 'Claude models have no verbosity setting' },
  // The speed menu writes it, and "default" for none. Claude models offer no
  // service tiers.
  service_tier: {
    reason: 'Claude models have no service tiers',
    accepts: (value) => value === 'default' || value === 'standard',
  },
  // Settings > Configuration > Network access writes network_access. Claude
  // threads have no network or filesystem sandbox: commands reach the network
  // and every folder in each sandbox mode, which sets only how Claude asks
  // for permission.
  sandbox_workspace_write: {
    reason: 'Claude threads have no network or filesystem sandbox',
    accepts: (value) => {
      const table = asTable(value)
      return table != null && Object.entries(table).every(([key, item]) => sandboxValue(key, item))
    },
  },
  ...Object.fromEntries(
    Object.keys(claudeSandboxWorkspaceWrite()).map((key) => [
      `sandbox_workspace_write.${key}`,
      {
        reason:
          key === 'network_access'
            ? 'Claude threads always have network access'
            : 'Claude threads have no filesystem sandbox',
        accepts: (value: unknown) => sandboxValue(key, value),
      },
    ]),
  ),
  // Not written by the App: it sends developer instructions with each turn's
  // collaboration mode. Claude threads take their instructions from the
  // project's AGENTS.md and CLAUDE.md files.
  developer_instructions: { reason: 'set instructions in AGENTS.md or CLAUDE.md instead' },
  instructions: { reason: 'set instructions in AGENTS.md or CLAUDE.md instead' },
  // Claude Code compacts a conversation with its own prompt.
  compact_prompt: { reason: 'Claude Code compacts with its own prompt' },
}

// Whether `value` is what sandbox_workspace_write.<key> is for Claude threads.
function sandboxValue(key: string, value: unknown): boolean {
  const table = claudeSandboxWorkspaceWrite()
  return Object.hasOwn(table, key) && JSON.stringify(table[key]) === JSON.stringify(value)
}

// A setting of a profile is the setting.
function unsupportedFor(keyPath: string): Unsupported | null {
  const key = /^profiles\.[^.]+\.(.+)$/.exec(keyPath)?.[1] ?? keyPath
  return Object.hasOwn(UNSUPPORTED, key) ? (UNSUPPORTED[key] ?? null) : null
}

// For a write of a setting Claude threads have no counterpart for: the error
// when it sets a value, which the App shows next to the setting, or 'drop'
// when it clears the setting or sets what Claude threads do anyway. null for
// every other setting.
// App rule: settings-write-errors
export function unsupportedSettingWrite(edit: ConfigEdit): RpcError | 'drop' | null {
  const unsupported = unsupportedFor(edit.keyPath)
  if (!unsupported) return null
  if (edit.value == null || unsupported.accepts?.(edit.value)) return 'drop'
  return invalid(`${edit.keyPath} is not supported for Claude threads: ${unsupported.reason}`)
}

// What the adapter kept of the App's settings before it handled the keys
// above: mcp_servers.* writes kept as flat keys, which nothing read (the ones
// the App writes are its desktop servers, holding its private environment),
// and values of settings Claude threads have no counterpart for. Removes them
// from `settings`; true when there was any.
export function pruneLegacySettings(settings: Table): boolean {
  let pruned = false
  for (const key of Object.keys(settings)) {
    if (key.startsWith('mcp_servers.') || unsupportedFor(key)) {
      delete settings[key]
      pruned = true
    }
  }
  const servers = asTable(settings.mcp_servers)
  if (settings.mcp_servers !== undefined) {
    const kept = servers ? appMcpServerTable(settings) : {}
    if (!servers || Object.keys(kept).length !== Object.keys(servers).length) {
      if (Object.keys(kept).length > 0) settings.mcp_servers = kept
      else delete settings.mcp_servers
      pruned = true
    }
  }
  return pruned
}

// Codex's sandbox_workspace_write table as it holds for Claude threads: what
// a write of it may set without failing. config/read reports none.
function claudeSandboxWorkspaceWrite(): Table {
  return {
    writable_roots: [],
    network_access: true,
    exclude_tmpdir_env_var: false,
    exclude_slash_tmp: false,
  }
}
