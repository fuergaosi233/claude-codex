import { spawnSync } from 'node:child_process'
import { lstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import {
  asTable,
  codexTrustsProject,
  gitVouchesForCheckout,
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
// user approved it in their own settings, never in settings the repository
// supplies. A server's ${VAR} references are left for the CLI to fill in
// from its own environment, as it does for its own config files: the values
// stay off its command line, and it keeps its own credentials and those it
// never sends to a remote server out of them.

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
// for the project itself: the repository's main checkout (which a worktree
// shares), or the folder outside a repository. As in Claude Code for the
// settings that let a project run code or skip a prompt, trust accepted for
// a folder above does not count.
export function claudeTrustsProject(cwd: string, configDir: string): boolean {
  if (codexTrustsProject(cwd)) return true
  const projects = asTable(readJsonFile(claudeGlobalConfigPath(configDir))?.projects)
  if (!projects) return false
  const folder = mainRepositoryRoot(cwd) ?? resolve(cwd)
  for (const key of new Set([folder, realPath(folder)]))
    if (asTable(projects[key])?.hasTrustDialogAccepted === true) return true
  return false
}

// Whether a project's settings.local.json is the repository's rather than
// the user's: checked into git, or reached through a symlinked .claude
// folder. Claude Code keeps that file out of git for the user's own choices,
// so approvals in a copy the repository supplies are not the user's. A git
// that cannot tell counts as yes, and so does a checkout whose .git file git
// does not vouch for, since git would then read an index the folder made up.
export function repositorySupplied(path: string): boolean {
  const folder = dirname(path)
  try {
    if (lstatSync(folder).isSymbolicLink()) return true
  } catch {
    return false
  }
  const root = gitRoot(dirname(folder))
  if (!root) return false
  if (!gitVouchesForCheckout(root)) {
    debugLog('claude_settings_git_pointer_unverified', { path })
    return true
  }
  // The repository at `root` and no other, whatever git variables the
  // adapter inherited, without the fsmonitor program its config can name.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  env.GIT_CEILING_DIRECTORIES = dirname(root)
  env.GIT_OPTIONAL_LOCKS = '0'
  const result = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', relative(root, path)],
    { cwd: root, stdio: 'ignore', timeout: 5000, env },
  )
  if (result.status === 0) return true
  if (result.status === 1) return false
  debugLog('claude_settings_git_check_failed', { path, status: result.status })
  return true
}

// The parts of the project's uncommitted settings files the user can rely
// on: all of a file of their own, and only what takes something away from a
// file the repository supplies.
function localSettings(cwd: string): Array<{ settings: Table; own: boolean }> {
  const out: Array<{ settings: Table; own: boolean }> = []
  for (const path of claudeProjectSettingsPaths(cwd).local) {
    const settings = readJsonFile(path)
    if (!settings) continue
    const own = !repositorySupplied(path)
    if (!own && !ignoredLocal.has(path)) {
      ignoredLocal.add(path)
      debugLog('claude_settings_local_not_own', { path })
    }
    out.push({ settings, own })
  }
  return out
}

const ignoredLocal = new Set<string>()

export function claudeMcpServers(cwd: string | null, configDir: string): InheritedMcpServer[] {
  const globalPath = claudeGlobalConfigPath(configDir)
  const global = readJsonFile(globalPath)
  const servers = new Map<string, InheritedMcpServer>()
  const add = (
    source: string,
    table: unknown,
    helpers: boolean,
    approve?: (name: string) => boolean,
  ): void => {
    for (const [name, raw] of Object.entries(asTable(table) ?? {})) {
      if (approve && !approve(name)) continue
      const config = sdkServerConfig(name, raw, helpers)
      if (config) {
        servers.delete(name)
        servers.set(name, { name, source, config })
      } else debugLog('claude_mcp_server_skipped', { server: name, source })
    }
  }
  add(globalPath, global?.mcpServers, true)
  if (cwd) {
    const approved = projectServerApproval(cwd, configDir, global)
    if (approved)
      for (const path of mcpJsonPaths(cwd))
        add(path, readJsonFile(path)?.mcpServers, true, approved)
    // A local-scope server's headersHelper runs only in a trusted project,
    // as in Claude Code.
    const trusted = approved !== null || claudeTrustsProject(cwd, configDir)
    add(globalPath, projectEntry(global, cwd)?.mcpServers, trusted)
  }
  return [...servers.values()]
}

// Every .mcp.json from the repository root (the folder itself outside a
// repository) down to the thread's folder; a closer file wins a name.
function mcpJsonPaths(cwd: string): string[] {
  const top = resolve(gitRoot(cwd) ?? cwd)
  const paths: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    paths.unshift(join(dir, '.mcp.json'))
    if (dir === top || dirname(dir) === dir) return paths
  }
}

// Which .mcp.json servers may run, or null when none may: the project must
// be trusted, and a server enabled by name or by enableAllProjectMcpServers
// in the user's settings, the project's uncommitted settings of their own or
// the global config's project entry, and not disabled in any of them.
function projectServerApproval(
  cwd: string,
  configDir: string,
  global: Table | null,
): ((name: string) => boolean) | null {
  if (!claudeTrustsProject(cwd, configDir)) return null
  const sources = [
    { settings: readJsonFile(claudeUserSettingsPath(configDir)), own: true },
    ...localSettings(cwd),
    { settings: projectEntry(global, cwd), own: true },
  ]
  const enabled = new Set<string>()
  const disabled = new Set<string>()
  let all = false
  for (const { settings, own } of sources) {
    if (!settings) continue
    for (const name of stringList(settings.disabledMcpjsonServers)) disabled.add(name)
    if (!own) continue
    if (settings.enableAllProjectMcpServers === true) all = true
    for (const name of stringList(settings.enabledMcpjsonServers)) enabled.add(name)
  }
  if (!all && enabled.size === 0) return null
  return (name) => !disabled.has(name) && (all || enabled.has(name))
}

export interface ClaudePermissionRules {
  // Rules that let a tool run without asking, as --allowedTools entries.
  readonly allow: string[]
  // Rules that refuse a tool, as --disallowedTools entries.
  readonly deny: string[]
  // Rules that send a tool call to the permission prompt (see ask-rules.mts).
  readonly ask: string[]
}

// permissions.allow, permissions.ask and permissions.deny from the user's
// settings and the project's (the checked-in .claude/settings.json and the
// uncommitted settings.local.json files). Deny and ask rules only hold
// tools back, so the project's always apply; its allow rules only in a
// project the user trusts, and those of a settings.local.json only when it
// is the user's own.
export function claudePermissionRules(cwd: string, configDir: string): ClaudePermissionRules {
  const allow = new Set<string>()
  const deny = new Set<string>()
  const ask = new Set<string>()
  const add = (settings: Table | null, withAllow: boolean, root: string | null): void => {
    const permissions = asTable(settings?.permissions)
    if (!permissions) return
    const anchor = (rule: string) => (root ? anchoredRule(rule, root) : rule)
    if (withAllow) for (const rule of stringList(permissions.allow)) allow.add(anchor(rule))
    for (const rule of stringList(permissions.deny)) deny.add(anchor(rule))
    for (const rule of stringList(permissions.ask)) ask.add(anchor(rule))
  }
  add(readJsonFile(claudeUserSettingsPath(configDir)), true, configDir)
  const trusted = claudeTrustsProject(cwd, configDir)
  add(readJsonFile(claudeProjectSettingsPaths(cwd).shared), trusted, null)
  for (const { settings, own } of localSettings(cwd)) add(settings, trusted && own, null)
  return { allow: [...allow], deny: [...deny], ask: [...ask] }
}

// A file rule's /path is relative to the folder of the settings file it is
// in; given on the command line it would be relative to the thread's
// folder, so a user-settings rule is made absolute (//path).
function anchoredRule(rule: string, root: string): string {
  const match = /^(Read|Edit|Write|MultiEdit|NotebookEdit)\(\/(?!\/)(.*)\)$/.exec(rule)
  if (!match) return rule
  return `${match[1]}(/${resolve(root)}/${match[2]})`
}

// A Claude Code server entry as the SDK takes it, its ${VAR} references
// left for the CLI. Transports the SDK cannot pass on are skipped, and so
// is a headersHelper that may not run.
function sdkServerConfig(
  name: string,
  raw: unknown,
  helpers: boolean,
): Record<string, unknown> | null {
  const entry = asTable(raw)
  if (!entry) return null
  const type = typeof entry.type === 'string' ? entry.type : 'stdio'
  const timeout = typeof entry.timeout === 'number' ? { timeout: entry.timeout } : {}
  if (type === 'stdio') {
    if (typeof entry.command !== 'string' || !entry.command) return null
    const env = stringRecord(entry.env)
    return {
      type: 'stdio',
      command: entry.command,
      args: stringList(entry.args),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...timeout,
    }
  }
  if (type === 'http' || type === 'sse' || type === 'streamable-http') {
    if (typeof entry.url !== 'string' || !entry.url) return null
    const headers = stringRecord(entry.headers)
    const helper = typeof entry.headersHelper === 'string' ? entry.headersHelper : null
    if (helper && !helpers) debugLog('claude_mcp_headers_helper_skipped', { server: name })
    return {
      type: type === 'sse' ? 'sse' : 'http',
      url: entry.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(helper && helpers ? { headersHelper: helper } : {}),
      ...timeout,
    }
  }
  return null
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
