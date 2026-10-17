import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { gitRoot, readText, realPath } from './project-instructions.mjs'
import { parseToml } from './toml.mjs'
import { codexHome, debugLog } from './util.mjs'

// The parts of the Codex config file Claude threads can take over when the
// user asks for them: its MCP servers and its `notify` program. The file is
// read the way Codex reads it (codex-rs config/): $CODEX_HOME/config.toml,
// then, for a project the user trusts, each .codex/config.toml from the
// project root down to the thread's folder, later files overriding earlier
// ones key by key.
//
// Servers that plugins bring along (plugins.*.mcp_servers) are not read:
// they belong to the Codex App's own tools.

type Table = Record<string, unknown>

export interface InheritedMcpServer {
  readonly name: string
  // The file the server's settings came from.
  readonly source: string
  // The server as the Claude Agent SDK's mcpServers option takes it.
  readonly config: Record<string, unknown>
  // Tool lists that narrow what Claude may call, when the config has them.
  readonly enabledTools?: readonly string[]
  readonly disabledTools?: readonly string[]
}

interface ConfigLayer {
  readonly path: string
  readonly table: Table
}

const parsed = new Map<string, { stamp: string; table: Table | null }>()

// A TOML file, parsed once per change. A file that does not parse counts as
// absent, as a broken config must not stop Claude threads.
export function readTomlFile(path: string): Table | null {
  let stamp: string
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    stamp = `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
  const hit = parsed.get(path)
  if (hit?.stamp === stamp) return hit.table
  let table: Table | null = null
  try {
    table = parseToml(readText(path) ?? '')
  } catch (error) {
    debugLog('codex_config_unreadable', {
      path,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  parsed.set(path, { stamp, table })
  return table
}

export function codexUserConfigPath(): string {
  return join(codexHome(), 'config.toml')
}

// Codex trusts a folder when the user config's [projects."<path>"] entry for
// it says trust_level = "trusted"; a folder without an entry follows the
// repository it belongs to, so a worktree follows its main checkout.
export function codexTrustsProject(cwd: string): boolean {
  const projects = asTable(readTomlFile(codexUserConfigPath())?.projects)
  if (!projects) return false
  for (const dir of [cwd, mainRepositoryRoot(cwd)]) {
    if (!dir) continue
    for (const key of new Set([resolve(dir), realPath(dir)])) {
      const entry = asTable(projects[key])
      if (entry && Object.hasOwn(entry, 'trust_level')) return entry.trust_level === 'trusted'
    }
  }
  return false
}

// The working tree of the repository `cwd` belongs to; for a linked worktree,
// the main checkout's.
export function mainRepositoryRoot(cwd: string): string | null {
  const root = gitRoot(cwd)
  if (!root) return null
  const pointer = readText(join(root, '.git'))
  const gitDir = pointer && /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim()
  if (!gitDir) return root
  const linked = resolve(root, gitDir)
  const common = readText(join(linked, 'commondir'))?.trim()
  const commonDir = common ? resolve(linked, common) : linked
  return basename(commonDir) === '.git' ? dirname(commonDir) : root
}

function configLayers(cwd: string | null): ConfigLayer[] {
  const layers: ConfigLayer[] = []
  const userPath = codexUserConfigPath()
  const user = readTomlFile(userPath)
  if (user) layers.push({ path: userPath, table: user })
  if (!cwd || !codexTrustsProject(cwd)) return layers
  const top = gitRoot(cwd) ?? cwd
  const folders: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    folders.unshift(dir)
    if (dir === resolve(top) || dirname(dir) === dir) break
  }
  for (const dir of folders) {
    const path = join(dir, '.codex', 'config.toml')
    if (realPath(path) === realPath(userPath)) continue
    const table = readTomlFile(path)
    if (table) layers.push({ path, table })
  }
  return layers
}

// The enabled [mcp_servers.<name>] entries, as SDK server configs, only with
// CLAUDE_CODEX_CODEX_MCP_SERVERS=1: the Codex App writes its own desktop
// servers into this file for Codex threads, and those do not belong in
// every Claude thread.
export function codexMcpServers(cwd: string | null): InheritedMcpServer[] {
  if (process.env.CLAUDE_CODEX_CODEX_MCP_SERVERS !== '1') return []
  const merged = new Map<string, { entry: Table; source: string; base: string }>()
  for (const layer of configLayers(cwd)) {
    const servers = asTable(layer.table.mcp_servers)
    if (!servers) continue
    for (const [name, raw] of Object.entries(servers)) {
      const entry = asTable(raw)
      if (!entry) continue
      const prior = merged.get(name)
      merged.set(name, {
        entry: prior ? mergeTables(prior.entry, entry) : entry,
        source: layer.path,
        // A relative cwd is relative to the file that set it.
        base: prior && !Object.hasOwn(entry, 'cwd') ? prior.base : dirname(layer.path),
      })
    }
  }
  const servers: InheritedMcpServer[] = []
  for (const [name, { entry, source, base }] of merged) {
    const config = sdkServerConfig(name, entry, base)
    if (!config) continue
    const enabledTools = stringList(entry.enabled_tools)
    const disabledTools = stringList(entry.disabled_tools)
    servers.push({
      name,
      source,
      config,
      ...(Array.isArray(entry.enabled_tools) ? { enabledTools } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
    })
  }
  return servers
}

// One Codex server entry in the SDK's terms. Codex resolves environment
// variable names against its own environment; so does this, because the
// Claude CLI may run with a narrower one.
function sdkServerConfig(name: string, entry: Table, base: string): Record<string, unknown> | null {
  if (entry.enabled === false) return null
  // Runs on a remote executor Claude threads do not have.
  if (entry.experimental_environment === 'remote') return null
  const seconds = typeof entry.tool_timeout_sec === 'number' ? entry.tool_timeout_sec : null
  const timeout = seconds && seconds > 0 ? { timeout: Math.round(seconds * 1000) } : {}
  if (typeof entry.command === 'string' && entry.command) {
    const env: Record<string, string> = {}
    // Codex hands a server the PATH it runs with.
    if (process.env.PATH) env.PATH = process.env.PATH
    for (const item of Array.isArray(entry.env_vars) ? entry.env_vars : []) {
      const spec = typeof item === 'string' ? { name: item } : asTable(item)
      const key = typeof spec?.name === 'string' ? spec.name : ''
      if (!key || spec?.source === 'remote') continue
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    Object.assign(env, stringRecord(entry.env))
    const args = stringList(entry.args)
    const cwd = typeof entry.cwd === 'string' && entry.cwd ? expandPath(entry.cwd, base) : null
    // The SDK has no cwd for a server, so a shell changes into it first.
    const launch = cwd
      ? {
          command: '/bin/sh',
          args: ['-c', 'cd "$1" && shift && exec "$@"', 'sh', cwd, entry.command, ...args],
        }
      : { command: entry.command, args }
    return { type: 'stdio', ...launch, env, ...timeout }
  }
  if (typeof entry.url === 'string' && entry.url) {
    const headers = stringRecord(entry.http_headers)
    for (const [header, variable] of Object.entries(stringRecord(entry.env_http_headers))) {
      const value = process.env[variable]
      if (value !== undefined) headers[header] = value
    }
    if (typeof entry.bearer_token_env_var === 'string' && entry.bearer_token_env_var) {
      const token = process.env[entry.bearer_token_env_var]
      if (token) headers.Authorization = `Bearer ${token}`
      else debugLog('codex_mcp_server_token_missing', { server: name })
    }
    return {
      type: 'http',
      url: entry.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...timeout,
    }
  }
  return null
}

// The program `notify` names, with its arguments, or null.
export function codexNotifyCommand(): string[] | null {
  const notify = readTomlFile(codexUserConfigPath())?.notify
  if (!Array.isArray(notify) || !notify.every((part) => typeof part === 'string')) return null
  return notify.length > 0 && notify[0] ? (notify as string[]) : null
}

function mergeTables(base: Table, over: Table): Table {
  const out: Table = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const prior = asTable(out[key])
    const next = asTable(value)
    out[key] = prior && next ? mergeTables(prior, next) : value
  }
  return out
}

function expandPath(path: string, base: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(base, path)
}

export function asTable(value: unknown): Table | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Table)
    : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> {
  const table = asTable(value)
  if (!table) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(table))
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')
      out[key] = String(raw)
  return out
}
