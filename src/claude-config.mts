import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  asTable,
  codexTrustsProject,
  type InheritedMcpServer,
  mainRepositoryRoot,
} from './codex-config.mjs'
import { gitRoot, readText, realPath } from './project-instructions.mjs'
import { debugLog } from './util.mjs'

// Claude Code settings the adapter applies on the CLI's behalf when
// CLAUDE_CODEX_CLAUDE_CONFIG_DIR names the user's Claude Code folder, for a
// CLI that reads none of its own (see project-instructions.mts). They are
// read from the files and with the precedence the CLI uses.
//
// MCP servers: user-scope servers in the global config file, then the
// project's .mcp.json servers, then local-scope servers recorded for the
// project in the global config file; a later scope wins a name. A .mcp.json
// server runs repository code, so it is used only in a project the user
// trusts (in Codex, or through Claude Code's trust dialog) and only once the
// user approved it in their own settings, never in settings checked into the
// repository.

type Table = Record<string, unknown>

const parsed = new Map<string, { stamp: string; value: Table | null }>()

export function readJsonFile(path: string): Table | null {
  let stamp: string
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    stamp = `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
  const hit = parsed.get(path)
  if (hit?.stamp === stamp) return hit.value
  let value: Table | null = null
  try {
    value = asTable(JSON.parse(readText(path) ?? ''))
  } catch (error) {
    debugLog('claude_config_unreadable', {
      path,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  parsed.set(path, { stamp, value })
  return value
}

// The CLI's global config file: the folder's legacy .config.json when there
// is one; ~/.claude.json for ~/.claude; <folder>/.claude.json otherwise.
export function claudeGlobalConfigPath(configDir: string): string {
  const legacy = join(configDir, '.config.json')
  if (readText(legacy) != null) return legacy
  const standard = join(homedir(), '.claude')
  return realPath(configDir) === realPath(standard)
    ? join(homedir(), '.claude.json')
    : join(configDir, '.claude.json')
}

export function claudeUserSettingsPath(configDir: string): string {
  return join(configDir, 'settings.json')
}

// The project's settings files the CLI reads: the checked-in one in the
// thread's folder, and the user's own uncommitted ones at the repository root
// and in the thread's folder.
export function claudeProjectSettingsPaths(cwd: string): {
  shared: string
  local: string[]
} {
  const root = mainRepositoryRoot(cwd) ?? cwd
  const local = [...new Set([resolve(root), resolve(cwd)])].map((dir) =>
    join(dir, '.claude', 'settings.local.json'),
  )
  return { shared: join(cwd, '.claude', 'settings.json'), local }
}

// The global config file's entry for the project, keyed by the repository's
// main checkout, the repository root or the folder itself.
function projectEntry(global: Table | null, cwd: string): Table | null {
  const projects = asTable(global?.projects)
  if (!projects) return null
  const dirs = [mainRepositoryRoot(cwd), gitRoot(cwd), cwd].filter(
    (dir): dir is string => dir != null,
  )
  for (const dir of dirs)
    for (const key of new Set([resolve(dir), realPath(dir)])) {
      const entry = asTable(projects[key])
      if (entry) return entry
    }
  return null
}

// Codex trusts the project, or the user accepted Claude Code's trust dialog
// for it or a folder above it.
export function claudeTrustsProject(cwd: string, configDir: string): boolean {
  if (codexTrustsProject(cwd)) return true
  const projects = asTable(readJsonFile(claudeGlobalConfigPath(configDir))?.projects)
  if (!projects) return false
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const key of new Set([dir, realPath(dir)]))
      if (asTable(projects[key])?.hasTrustDialogAccepted === true) return true
    if (dirname(dir) === dir) return false
  }
}

export function claudeMcpServers(cwd: string | null, configDir: string): InheritedMcpServer[] {
  const globalPath = claudeGlobalConfigPath(configDir)
  const global = readJsonFile(globalPath)
  const servers = new Map<string, InheritedMcpServer>()
  const add = (source: string, table: unknown, approve?: (name: string) => boolean): void => {
    for (const [name, raw] of Object.entries(asTable(table) ?? {})) {
      if (approve && !approve(name)) continue
      const config = sdkServerConfig(raw)
      if (config) {
        servers.delete(name)
        servers.set(name, { name, source, config })
      } else debugLog('claude_mcp_server_skipped', { server: name, source })
    }
  }
  add(globalPath, global?.mcpServers)
  if (cwd) {
    const approved = projectServerApproval(cwd, configDir, global)
    if (approved)
      for (const path of mcpJsonPaths(cwd)) add(path, readJsonFile(path)?.mcpServers, approved)
    add(globalPath, projectEntry(global, cwd)?.mcpServers)
  }
  return [...servers.values()]
}

// Every .mcp.json from the filesystem root down to the thread's folder; a
// closer file wins a name.
function mcpJsonPaths(cwd: string): string[] {
  const paths: string[] = []
  for (let dir = resolve(cwd); dirname(dir) !== dir; dir = dirname(dir))
    paths.unshift(join(dir, '.mcp.json'))
  return paths
}

// Which .mcp.json servers may run, or null when none may: the project must
// be trusted, and a server enabled by name or by enableAllProjectMcpServers
// in the user's settings, the project's uncommitted settings or the global
// config's project entry, and not disabled in any of them.
function projectServerApproval(
  cwd: string,
  configDir: string,
  global: Table | null,
): ((name: string) => boolean) | null {
  if (!claudeTrustsProject(cwd, configDir)) return null
  const sources = [
    readJsonFile(claudeUserSettingsPath(configDir)),
    ...claudeProjectSettingsPaths(cwd).local.map(readJsonFile),
    projectEntry(global, cwd),
  ]
  const enabled = new Set<string>()
  const disabled = new Set<string>()
  let all = false
  for (const source of sources) {
    if (!source) continue
    if (source.enableAllProjectMcpServers === true) all = true
    for (const name of stringList(source.enabledMcpjsonServers)) enabled.add(name)
    for (const name of stringList(source.disabledMcpjsonServers)) disabled.add(name)
  }
  if (!all && enabled.size === 0) return null
  return (name) => !disabled.has(name) && (all || enabled.has(name))
}

// A Claude Code server entry, with ${VAR} and ${VAR:-default} expanded from
// the adapter's environment as the CLI would from its own. Transports the
// SDK cannot pass on are skipped.
function sdkServerConfig(raw: unknown): Record<string, unknown> | null {
  const entry = asTable(raw)
  if (!entry) return null
  const type = typeof entry.type === 'string' ? entry.type : 'stdio'
  const timeout = typeof entry.timeout === 'number' ? { timeout: entry.timeout } : {}
  if (type === 'stdio') {
    if (typeof entry.command !== 'string' || !entry.command) return null
    const env = stringRecord(entry.env)
    return {
      type: 'stdio',
      command: expandVars(entry.command),
      args: stringList(entry.args).map(expandVars),
      ...(Object.keys(env).length > 0 ? { env: mapValues(env, expandVars) } : {}),
      ...timeout,
    }
  }
  if (type === 'http' || type === 'sse' || type === 'streamable-http') {
    if (typeof entry.url !== 'string' || !entry.url) return null
    const headers = stringRecord(entry.headers)
    return {
      type: type === 'sse' ? 'sse' : 'http',
      url: expandVars(entry.url),
      ...(Object.keys(headers).length > 0 ? { headers: mapValues(headers, expandVars) } : {}),
      ...(typeof entry.headersHelper === 'string' ? { headersHelper: entry.headersHelper } : {}),
      ...timeout,
    }
  }
  return null
}

function expandVars(value: string): string {
  return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (whole, name: string, fallback) => {
    const found = process.env[name]
    if (found !== undefined) return found
    return typeof fallback === 'string' ? fallback : whole
  })
}

function mapValues(
  record: Record<string, string>,
  map: (value: string) => string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))
}

export function stringList(value: unknown): string[] {
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
