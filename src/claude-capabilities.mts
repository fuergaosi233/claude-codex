import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { claudeCommandManifest, firstSentence, listClaudeCommands } from './claude-commands.mjs'
import { claudeHookFiles, claudeHookScope } from './claude-hooks.mjs'
import { bridgedClaudeConfigDir, claudeSkillFolders } from './project-instructions.mjs'
import { isPathInside } from './util.mjs'

interface SkillMetadata {
  readonly name: string
  readonly description: string
  readonly shortDescription?: string
  readonly path: string
  readonly scope: 'user' | 'repo' | 'system' | 'admin'
  readonly enabled: boolean
}

interface SkillsListEntry {
  readonly cwd: string
  readonly skills: readonly SkillMetadata[]
  readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>
}

interface HookMetadata {
  readonly key: string
  readonly eventName: string
  readonly handlerType: 'command' | 'prompt' | 'agent'
  readonly matcher: string | null
  readonly command: string | null
  readonly timeoutSec: number
  readonly statusMessage: string | null
  readonly sourcePath: string
  readonly source: 'system' | 'user' | 'project' | 'plugin' | 'unknown'
  readonly pluginId: string | null
  readonly displayOrder: number
  readonly enabled: boolean
  readonly isManaged: boolean
  readonly currentHash: string
  readonly trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified'
}

interface HooksListEntry {
  readonly cwd: string
  readonly hooks: readonly HookMetadata[]
  readonly warnings: readonly string[]
  readonly errors: ReadonlyArray<{ readonly path: string; readonly message: string }>
}

function userSkillDir(): string {
  return join(bridgedClaudeConfigDir() ?? join(homedir(), '.claude'), 'skills')
}

function repoSkillDirs(cwd: string): string[] {
  return claudeSkillFolders(cwd).map((dir) => join(dir, '.claude', 'skills'))
}

// The folders skills/list reads skills from for `cwd`.
export function claudeSkillDirs(cwd: string): string[] {
  return [userSkillDir(), ...repoSkillDirs(cwd)]
}

export function listClaudeSkills(params: Record<string, unknown>): SkillsListEntry[] {
  const roots = cwdsFromParams(params)
  const userSkills = readSkillDir(userSkillDir(), 'user')
  const builtins = listClaudeCommands().map(
    (command): SkillMetadata => ({
      name: command.name,
      description: command.description,
      shortDescription: firstSentence(command.description),
      path: claudeCommandManifest(command.name),
      scope: 'system',
      enabled: true,
    }),
  )
  return roots.map((cwd) => {
    const repo = repoSkillDirs(cwd).map((dir) => readSkillDir(dir, 'repo'))
    return {
      cwd,
      skills: [...userSkills.skills, ...repo.flatMap((entry) => entry.skills), ...builtins],
      errors: [...userSkills.errors, ...repo.flatMap((entry) => entry.errors)],
    }
  })
}

// App plugins whose skills Claude can carry out with its own tools: they only
// read and write files and shape the reply. The App's other plugins drive
// Codex-only tools, or MCP servers and hooks the App runs for Codex.
const CLAUDE_RUNNABLE_APP_PLUGINS = new Set(['visualize'])

const MARKETPLACE_MANIFEST = join('.agents', 'plugins', 'marketplace.json')

export interface AppPlugin {
  readonly name: string
  readonly root: string
}

export interface AppSkill {
  readonly name: string
  readonly description: string
  // The skill's SKILL.md; the rest of the skill sits beside it.
  readonly path: string
  readonly plugin: string
}

// The folder of an App plugin Claude can run, found the way plugin/install
// names it: a local plugin in a marketplace whose manifest lives at
// <root>/.agents/plugins/marketplace.json, with paths relative to <root>.
export function claudeRunnableAppPlugin(
  marketplacePath: unknown,
  pluginName: unknown,
): AppPlugin | null {
  if (typeof pluginName !== 'string' || !CLAUDE_RUNNABLE_APP_PLUGINS.has(pluginName)) return null
  if (typeof marketplacePath !== 'string' || !isAbsolute(marketplacePath)) return null
  try {
    const marketplace = asRecord(JSON.parse(readFileSync(marketplacePath, 'utf8')))
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins.map(asRecord) : []
    const source = plugins.find((plugin) => plugin.name === pluginName)?.source
    const path =
      typeof source === 'string'
        ? source
        : asRecord(source).source === 'local'
          ? asRecord(source).path
          : undefined
    if (typeof path !== 'string') return null
    const base = marketplacePath.endsWith(MARKETPLACE_MANIFEST)
      ? marketplacePath.slice(0, -MARKETPLACE_MANIFEST.length)
      : dirname(marketplacePath)
    const root = resolve(base, path)
    return isPathInside(base, root) ? { name: pluginName, root } : null
  } catch {
    return null
  }
}

// The skills an installed App plugin ships, read from its current files so a
// plugin the App removed or updated is reflected on the next turn.
export function appPluginSkills(plugins: readonly AppPlugin[]): AppSkill[] {
  const skills: AppSkill[] = []
  for (const plugin of plugins) {
    if (!CLAUDE_RUNNABLE_APP_PLUGINS.has(plugin.name)) continue
    try {
      const manifest = asRecord(
        JSON.parse(readFileSync(join(plugin.root, '.codex-plugin', 'plugin.json'), 'utf8')),
      )
      if (typeof manifest.skills !== 'string') continue
      const dir = resolve(plugin.root, manifest.skills)
      if (!isPathInside(plugin.root, dir)) continue
      for (const skill of readSkillDir(dir, 'system').skills)
        skills.push({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          plugin: plugin.name,
        })
    } catch {}
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

function readSkillDir(
  dir: string,
  scope: 'user' | 'repo' | 'system',
): { skills: SkillMetadata[]; errors: Array<{ path: string; message: string }> } {
  const skills: SkillMetadata[] = []
  const errors: Array<{ path: string; message: string }> = []
  if (!existsSync(dir)) return { skills, errors }
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch (error) {
    errors.push({ path: dir, message: messageOf(error) })
    return { skills, errors }
  }
  for (const entry of entries) {
    const skillPath = join(dir, entry)
    const manifest = join(skillPath, 'SKILL.md')
    try {
      if (!statSync(skillPath).isDirectory() || !existsSync(manifest)) continue
      const frontmatter = parseFrontmatter(readFileSync(manifest, 'utf8'))
      const name = frontmatter.name || entry
      skills.push({
        name,
        description: frontmatter.description || '',
        ...(frontmatter.description ? { shortDescription: frontmatter.description } : {}),
        // Codex points `path` at the manifest; the App opens it when the
        // skill chip is clicked.
        path: manifest,
        scope,
        enabled: true,
      })
    } catch (error) {
      errors.push({ path: manifest, message: messageOf(error) })
    }
  }
  return { skills, errors }
}

// Claude events without a Codex hook surface, such as Notification, are intentionally dropped.
const HOOK_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PermissionRequest: 'permissionRequest',
  PreCompact: 'preCompact',
  PostCompact: 'postCompact',
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'userPromptSubmit',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  Stop: 'stop',
}

export function codexHookEventName(claudeEvent: string): string | null {
  return HOOK_EVENT_MAP[claudeEvent] ?? null
}

function hookSettingsFiles(cwd: string): Array<{ path: string; source: 'user' | 'project' }> {
  // With the Claude Code config bridged and its hooks asked for, the hooks
  // the adapter runs itself.
  const bridged = bridgedClaudeConfigDir()
  if (bridged && claudeHookScope() !== 'off')
    return claudeHookFiles(cwd, bridged).map((path, index) => ({
      path,
      source: index === 0 ? 'user' : 'project',
    }))
  return [
    { path: join(homedir(), '.claude', 'settings.json'), source: 'user' },
    { path: join(cwd, '.claude', 'settings.json'), source: 'project' },
    { path: join(cwd, '.claude', 'settings.local.json'), source: 'project' },
  ]
}

// Where a running hook most likely came from: the first settings file that
// configures its event. Plugin, managed and SDK hooks live elsewhere and
// report `unknown`.
export function claudeHookSource(
  cwd: string,
  claudeEvent: string,
): { source: 'user' | 'project' | 'unknown'; sourcePath: string } {
  for (const { path, source } of hookSettingsFiles(cwd)) {
    if (!existsSync(path)) continue
    try {
      const matchers = asRecord(asRecord(JSON.parse(readFileSync(path, 'utf8'))).hooks)[claudeEvent]
      if (Array.isArray(matchers) && matchers.length > 0) return { source, sourcePath: path }
    } catch {
      // hooks/list reports unreadable settings; a run just stays unattributed.
    }
  }
  return { source: 'unknown', sourcePath: join(homedir(), '.claude', 'settings.json') }
}

export function listClaudeHooks(params: Record<string, unknown>): HooksListEntry[] {
  const roots = cwdsFromParams(params)
  return roots.map((cwd) => {
    const hooks: HookMetadata[] = []
    const errors: Array<{ path: string; message: string }> = []
    let order = 0
    for (const { path, source } of hookSettingsFiles(cwd)) {
      if (!existsSync(path)) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        errors.push({ path, message: messageOf(error) })
        continue
      }
      const hookConfig = asRecord(parsed.hooks)
      for (const [claudeEvent, eventName] of Object.entries(HOOK_EVENT_MAP)) {
        const matchers = hookConfig[claudeEvent]
        if (!Array.isArray(matchers)) continue
        for (const rawMatcher of matchers) {
          const matcherEntry = asRecord(rawMatcher)
          const matcher = typeof matcherEntry.matcher === 'string' ? matcherEntry.matcher : null
          const handlers = Array.isArray(matcherEntry.hooks) ? matcherEntry.hooks : []
          for (const rawHandler of handlers) {
            const handler = asRecord(rawHandler)
            const command = typeof handler.command === 'string' ? handler.command : null
            const handlerType =
              handler.type === 'prompt' ? 'prompt' : handler.type === 'agent' ? 'agent' : 'command'
            hooks.push({
              key: `${source}:${eventName}:${order}`,
              eventName,
              handlerType,
              matcher,
              command,
              timeoutSec: typeof handler.timeout === 'number' ? handler.timeout : 60,
              statusMessage: null,
              sourcePath: path,
              source,
              pluginId: null,
              displayOrder: order,
              enabled: true,
              isManaged: false,
              currentHash: createHash('sha256')
                .update(`${eventName}:${matcher ?? ''}:${command ?? ''}`)
                .digest('hex'),
              trustStatus: 'trusted',
            })
            order += 1
          }
        }
      }
    }
    return { cwd, hooks, warnings: [], errors }
  })
}

function cwdsFromParams(params: Record<string, unknown>): string[] {
  const cwds = Array.isArray(params.cwds) ? params.cwds.map(String).filter(Boolean) : []
  return cwds.length > 0 ? cwds : [process.cwd()]
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const body = text.slice(3, end)
  const out: { name?: string; description?: string } = {}
  for (const line of body.split('\n')) {
    const match = /^\s*(name|description)\s*:\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const value = (match[2] ?? '').replace(/^["']|["']$/g, '')
    if (match[1] === 'name') out.name = value
    else out.description = value
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
