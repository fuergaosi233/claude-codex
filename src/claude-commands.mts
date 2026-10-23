import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { adapterHome, debugLog } from './util.mjs'

// Claude Code's own prompt skills (/simplify, /code-review, ...) live inside
// the CLI binary, so nothing on disk lists them. Nor does anything the adapter
// can read list the commands a user, a project, a plugin or an MCP server adds
// (.claude/commands, plugin commands and skills, MCP prompts): the CLI finds
// them once it has loaded the settings of the folder it runs in. The CLI
// reports both kinds when a session starts (Query.supportedCommands()) and
// the second kind again when it changes (a commands_changed message). The
// adapter keeps the latest report under adapterHome, the second kind per
// folder, and serves them through skills/list, which is what fills the
// "Skills" group of the App's "/" popup. Each command gets a small SKILL.md the
// App can open when the chip is clicked; the chip itself arrives in the prompt
// as `[$name](<that SKILL.md>)` and is turned back into `/name args` for the
// CLI, which runs it as it would a typed command.
// App rule: skills-popup

export interface ClaudeCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
}

// A row of Query.supportedCommands() or of a commands_changed message.
export interface ReportedCommand {
  readonly name: string
  readonly description?: string
  readonly argumentHint?: string
  readonly builtin?: boolean
}

interface FolderCommands {
  readonly commands: ClaudeCommand[]
  // When the folder's list last changed or was confirmed, for eviction.
  readonly at: number
}

interface Catalog {
  // Claude Code's own skills, the same in every folder.
  commands: ClaudeCommand[]
  // The other commands, by the folder the reporting session ran in.
  folders: Record<string, FolderCommands>
}

// Shown before any CLI has reported its own list. /simplify carries no
// feature gate in CLI 2.1.283.
const SEED: readonly ClaudeCommand[] = [
  {
    name: 'simplify',
    description:
      'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that.',
    argumentHint: '[<target>]',
  },
]

// The App's own "/" commands. A same-named Claude command would sit next to
// them in the popup and do something else.
const APP_COMMANDS = new Set([
  'autoreview',
  'chat',
  'cloud',
  'compact',
  'feedback',
  'fork',
  'goal',
  'init',
  'local',
  'mcp',
  'memories',
  'model',
  'new',
  'plan-mode',
  'project',
  'reasoning',
  'rename',
  'review-mode',
  'share',
  'side',
  'status',
  'usage',
  'worktree',
])

// Plugin commands and skills are namespaced as `plugin:name`; MCP prompts are
// named after their server. A name that is not one slash-command word, such
// as a label with spaces, could not be typed back to the CLI and is skipped.
const COMMAND_NAME = /^[A-Za-z0-9][\w.-]*(?::[\w.-]+)*$/
// How many folders keep their own list.
const MAX_FOLDERS = 64
// An unchanged list is saved again only this often, to keep its folder from
// being evicted.
const REFRESH_MS = 24 * 60 * 60 * 1000

let cache: { readonly path: string; readonly catalog: Catalog } | null = null
// Manifests this process has written, by path.
const written = new Map<string, string>()
const listeners = new Set<() => void>()

function catalogPath(): string {
  return join(adapterHome(), 'claude-commands.json')
}

export function claudeCommandsDir(): string {
  return join(adapterHome(), 'claude-commands')
}

// A plugin command's `:` would be a path separator on some systems; `+` is
// never part of a command name, so the folder name maps back to one name.
export function claudeCommandManifest(name: string): string {
  return join(claudeCommandsDir(), name.replaceAll(':', '+'), 'SKILL.md')
}

function catalog(): Catalog {
  const path = catalogPath()
  if (cache?.path === path) return cache.catalog
  let parsed: { commands?: unknown; folders?: unknown } = {}
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) ?? {}
  } catch {}
  const value: Catalog = {
    commands: Array.isArray(parsed.commands) ? commandList(parsed.commands) : [...SEED],
    folders: {},
  }
  if (parsed.folders && typeof parsed.folders === 'object') {
    for (const [folder, raw] of Object.entries(parsed.folders)) {
      const entry = (raw ?? {}) as { commands?: unknown; at?: unknown }
      if (!isAbsolute(folder) || !Array.isArray(entry.commands)) continue
      const at = typeof entry.at === 'number' ? entry.at : 0
      value.folders[folder] = { commands: commandList(entry.commands), at }
    }
  }
  cache = { path, catalog: value }
  for (const command of value.commands) writeManifest(command, 'builtin')
  return value
}

export function listClaudeCommands(): ClaudeCommand[] {
  return catalog().commands
}

// The commands of the user, the project, plugins and MCP servers that Claude
// Code last reported for a session in `cwd`. A folder no Claude chat has run
// in yet has none until its first turn starts.
export function listFolderCommands(cwd: string): ClaudeCommand[] {
  const commands = catalog().folders[resolve(cwd)]?.commands ?? []
  for (const command of commands) writeManifest(command, 'folder')
  return commands
}

export function onClaudeCommandsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// `commands` is Query.supportedCommands(); `skills` is the init message's
// skill list. Only Claude Code's own skills are kept here: plain built-ins
// like /cost are not prompts, and the other commands are kept per folder by
// noteFolderCommands.
export function noteClaudeCommands(
  commands: readonly ReportedCommand[],
  skills: readonly string[],
): void {
  const skillNames = new Set(skills)
  const next = commandList(
    commands.filter((command) => command.builtin === true && skillNames.has(command.name)),
  )
  if (next.length === 0) return
  const current = catalog()
  if (sameCommands(current.commands, next)) return
  current.commands = next
  save(current)
  for (const command of next) writeManifest(command, 'builtin')
  debugLog('claudeCommands.updated', { names: next.map((command) => command.name) })
  announce()
}

// The commands a session in `cwd` reports beyond Claude Code's own, from
// Query.supportedCommands() or a commands_changed message, which replaces the
// folder's list. A row that shares its name with one of Claude Code's own
// commands is left out: `/name` runs Claude Code's.
export function noteFolderCommands(cwd: string, commands: readonly ReportedCommand[]): void {
  // A CLI that marks none of its rows predates the marker, and its own
  // commands cannot be told from the others.
  if (!commands.some((command) => command.builtin === true)) return
  const builtins = new Set(
    commands.filter((command) => command.builtin === true).map((command) => command.name),
  )
  const next = commandList(commands.filter((command) => !builtins.has(command.name)))
  const folder = resolve(cwd)
  const current = catalog()
  const previous = current.folders[folder]
  const changed = !sameCommands(previous?.commands ?? [], next)
  if (!changed && (!previous || Date.now() - previous.at < REFRESH_MS)) return
  if (next.length === 0) delete current.folders[folder]
  else current.folders[folder] = { commands: next, at: Date.now() }
  const kept = Object.entries(current.folders)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_FOLDERS)
  current.folders = Object.fromEntries(kept)
  save(current)
  if (!changed) return
  for (const command of next) writeManifest(command, 'folder')
  debugLog('claudeCommands.folderUpdated', {
    folder,
    names: next.map((command) => command.name),
  })
  announce()
}

function announce(): void {
  for (const listener of listeners) listener()
}

function save(value: Catalog): void {
  try {
    mkdirSync(adapterHome(), { recursive: true })
    writeFileSync(catalogPath(), `${JSON.stringify(value, null, 2)}\n`)
  } catch (error) {
    debugLog('claudeCommands.saveFailed', { message: (error as Error).message })
  }
}

// Valid, not the App's own, one row per name (the first), sorted.
function commandList(rows: readonly unknown[]): ClaudeCommand[] {
  const byName = new Map<string, ClaudeCommand>()
  for (const row of rows) {
    const raw = (row ?? {}) as Partial<ReportedCommand>
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (!COMMAND_NAME.test(name) || APP_COMMANDS.has(name) || byName.has(name)) continue
    byName.set(name, {
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      argumentHint: typeof raw.argumentHint === 'string' ? raw.argumentHint : '',
    })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function sameCommands(a: readonly ClaudeCommand[], b: readonly ClaudeCommand[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function writeManifest(command: ClaudeCommand, kind: 'builtin' | 'folder'): void {
  const path = claudeCommandManifest(command.name)
  const usage = command.argumentHint
    ? `/${command.name} ${command.argumentHint}`
    : `/${command.name}`
  const origin =
    kind === 'builtin'
      ? 'Claude Code built-in command.'
      : 'Claude Code command from your Claude Code settings, the project, a plugin or an MCP server.'
  const content = [
    '---',
    `name: ${command.name}`,
    `description: ${JSON.stringify(command.description)}`,
    '---',
    '',
    `${origin} Picking it runs \`${usage}\` in Claude Code;`,
    'whatever else you type in the message is passed as its arguments.',
    '',
    command.description,
    '',
  ].join('\n')
  if (written.get(path) === content) return
  try {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    written.set(path, content)
  } catch (error) {
    debugLog('claudeCommands.manifestFailed', { path, message: (error as Error).message })
  }
}

// "(e.g. /loop 5m)" must not end the sentence, so the next one has to start
// with a capital.
export function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?=\s+[A-Z]|\s*$)/s.exec(text.trim())
  return (match?.[1] ?? text.trim()).replace(/\s+/g, ' ')
}

// The App sends a picked skill as a markdown link inside the text. Claude Code
// only runs a slash command at the very start of the prompt, so the first link
// to one of the commands above becomes `/name` there and the rest of the
// message its arguments. Later ones stay inline as `/name`, which the model
// can still act on. Links to skills under .claude/skills are left alone: the
// adapter lists those from disk, and their SKILL.md goes into the prompt
// instead (see turn-context.mts), which also works for a CLI started without
// setting sources.
const SKILL_LINK = /\[\$([^\]\n]+)\]\(([^)\n]+)\)/g

export function skillLinksToCommand(text: string): string {
  let command: string | null = null
  const rest = text.replace(SKILL_LINK, (match, label: string, path: string) => {
    const name = claudeSkillName(label, path)
    if (!name) return match
    if (command === null) {
      command = name
      return ''
    }
    return `/${name}`
  })
  if (command === null) return text
  const args = rest
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '')
    .trim()
  return args ? `/${command} ${args}` : `/${command}`
}

// The command a link to one of the manifests names: its folder's, which the
// adapter chose, else the link text's, without the `?label=...` the App may
// add to it.
function claudeSkillName(label: string, target: string): string | null {
  const path = target.trim().replace(/^<(.*)>$/, '$1')
  const skillDir = basename(path) === 'SKILL.md' ? dirname(path) : path
  if (dirname(skillDir) !== claudeCommandsDir()) return null
  const fromDir = basename(skillDir).replaceAll('+', ':')
  if (COMMAND_NAME.test(fromDir)) return fromDir
  const fromLabel = label.trim().replace(/^\$/, '').split('?')[0]?.trim() ?? ''
  return COMMAND_NAME.test(fromLabel) ? fromLabel : null
}
