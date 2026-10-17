import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  // Values the config refers to as ${NAME}, for the CLI's environment. The
  // SDK passes the server configs on the CLI's command line, where any
  // local process can read them, so a secret goes in the environment.
  readonly env?: Readonly<Record<string, string>>
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

// The working tree of the repository `cwd` belongs to; for a linked worktree
// git vouches for, the main checkout's.
export function mainRepositoryRoot(cwd: string): string | null {
  const root = gitRoot(cwd)
  if (!root) return null
  const commonDir = linkedCommonDir(root)
  return commonDir && basename(commonDir) === '.git' ? dirname(commonDir) : root
}

// A checkout's .git file is the checkout's to write: a folder can carry one
// that names another, trusted repository's git folder, or a folder of its own
// made up to look like one. So a pointer only counts as far as git's records
// elsewhere vouch for it.

// The main repository's git folder for the linked worktree at `root`, or null
// unless git set the link up: the .git file names a folder outside the
// checkout, under that git folder's worktrees/, whose gitdir file points back
// at this .git file, as git writes them.
export function linkedCommonDir(root: string): string | null {
  const pointed = pointedGitDir(root)
  if (!pointed) return null
  const linked = realPath(pointed)
  if (basename(dirname(linked)) !== 'worktrees') return null
  const common = readText(join(linked, 'commondir'))?.trim()
  const back = readText(join(linked, 'gitdir'))?.trim()
  if (!common || !back) return null
  const commonDir = resolve(pointed, common)
  if (dirname(linked) !== join(realPath(commonDir), 'worktrees')) return null
  return realPath(resolve(linked, back)) === realPath(join(root, '.git')) ? commonDir : null
}

// Whether git set up the checkout at `root`: it has a .git folder, or its
// .git file is a linked worktree's that git vouches for, or a submodule's,
// naming a folder outside the checkout whose core.worktree is this checkout.
export function gitVouchesForCheckout(root: string): boolean {
  if (isDirectory(join(root, '.git'))) return true
  if (linkedCommonDir(root)) return true
  const pointed = pointedGitDir(root)
  if (!pointed) return false
  const linked = realPath(pointed)
  const config = readText(join(linked, 'config')) ?? ''
  const worktree = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config)?.[1]
  return worktree != null && realPath(resolve(linked, worktree)) === realPath(root)
}

// The folder a checkout's .git file names, when it is one outside the
// checkout.
function pointedGitDir(root: string): string | null {
  const pointer = readText(join(root, '.git'))
  const target = pointer && /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim()
  if (!target) return null
  const dir = resolve(root, target)
  return isDirectory(dir) && !within(realPath(root), realPath(dir)) ? dir : null
}

// Whether `path` is `dir` or inside it.
function within(dir: string, path: string): boolean {
  const rest = relative(dir, path)
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
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
    const server = sdkServerConfig(name, entry, base)
    if (!server) continue
    const enabledTools = stringList(entry.enabled_tools)
    const disabledTools = stringList(entry.disabled_tools)
    servers.push({
      name,
      source,
      config: server.config,
      ...(Array.isArray(entry.enabled_tools) ? { enabledTools } : {}),
      ...(disabledTools.length > 0 ? { disabledTools } : {}),
      ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    })
  }
  return servers
}

// One Codex server entry in the SDK's terms. Codex resolves environment
// variable names against its own environment; so does this, because the
// Claude CLI may run with a narrower one. Such a value reaches the CLI in
// its environment, under a name of its own, and the config refers to it as
// ${NAME} for the CLI to fill in.
function sdkServerConfig(
  name: string,
  entry: Table,
  base: string,
): { config: Record<string, unknown>; env: Record<string, string> } | null {
  if (entry.enabled === false) return null
  // Runs on a remote executor Claude threads do not have.
  if (entry.experimental_environment === 'remote') return null
  const seconds = typeof entry.tool_timeout_sec === 'number' ? entry.tool_timeout_sec : null
  const timeout = seconds && seconds > 0 ? { timeout: Math.round(seconds * 1000) } : {}
  const secrets: Record<string, string> = {}
  const reference = (kind: string, key: string, value: string): string => {
    const alias = secretAlias(name, kind, key)
    secrets[alias] = value
    return `\${${alias}}`
  }
  if (typeof entry.command === 'string' && entry.command) {
    const env: Record<string, string> = {}
    // Codex hands a server the PATH it runs with.
    if (process.env.PATH) env.PATH = process.env.PATH
    for (const item of Array.isArray(entry.env_vars) ? entry.env_vars : []) {
      const spec = typeof item === 'string' ? { name: item } : asTable(item)
      const key = typeof spec?.name === 'string' ? spec.name : ''
      if (!key || spec?.source === 'remote') continue
      const value = process.env[key]
      if (value !== undefined) env[key] = reference('env', key, value)
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
    return { config: { type: 'stdio', ...launch, env, ...timeout }, env: secrets }
  }
  if (typeof entry.url === 'string' && entry.url) {
    const headers = stringRecord(entry.http_headers)
    for (const [header, variable] of Object.entries(stringRecord(entry.env_http_headers))) {
      const value = process.env[variable]
      if (value !== undefined) headers[header] = reference('header', header, value)
    }
    if (typeof entry.bearer_token_env_var === 'string' && entry.bearer_token_env_var) {
      const token = process.env[entry.bearer_token_env_var]
      if (token) headers.Authorization = `Bearer ${reference('bearer', 'Authorization', token)}`
      else debugLog('codex_mcp_server_token_missing', { server: name })
    }
    const config = {
      type: 'http',
      url: entry.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...timeout,
    }
    return { config, env: secrets }
  }
  return null
}

// The CLI's environment name for a value a server's config takes from the
// adapter's. A name of its own keeps it apart from the CLI's own variables
// and from the credential names the CLI never fills in toward a server.
function secretAlias(server: string, kind: string, key: string): string {
  const digest = createHash('sha256').update(`${server}\0${kind}\0${key}`).digest('hex')
  return `CLAUDE_CODEX_MCP_${digest.slice(0, 16).toUpperCase()}`
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
