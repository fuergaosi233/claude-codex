import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

export function listClaudeSkills(params: Record<string, unknown>): SkillsListEntry[] {
  const roots = cwdsFromParams(params)
  const userSkills = readSkillDir(join(homedir(), '.claude', 'skills'), 'user')
  return roots.map((cwd) => {
    const repo = readSkillDir(join(cwd, '.claude', 'skills'), 'repo')
    return {
      cwd,
      skills: [...userSkills.skills, ...repo.skills],
      errors: [...userSkills.errors, ...repo.errors],
    }
  })
}

function readSkillDir(
  dir: string,
  scope: 'user' | 'repo',
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
        path: skillPath,
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
  UserPromptSubmit: 'userPromptSubmit',
  Stop: 'stop',
}

export function listClaudeHooks(params: Record<string, unknown>): HooksListEntry[] {
  const roots = cwdsFromParams(params)
  const userSources = [
    { path: join(homedir(), '.claude', 'settings.json'), source: 'user' as const },
  ]
  return roots.map((cwd) => {
    const sources = [
      ...userSources,
      { path: join(cwd, '.claude', 'settings.json'), source: 'project' as const },
      { path: join(cwd, '.claude', 'settings.local.json'), source: 'project' as const },
    ]
    const hooks: HookMetadata[] = []
    const errors: Array<{ path: string; message: string }> = []
    let order = 0
    for (const { path, source } of sources) {
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
