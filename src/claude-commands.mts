import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { adapterHome, debugLog } from './util.mjs'

// Claude Code's own prompt skills (/simplify, /code-review, ...) live inside
// the CLI binary, so nothing on disk lists them. The CLI reports them at
// session init; the adapter keeps the latest report under adapterHome and
// serves it through skills/list, which is what fills the "Skills" group of the
// App's "/" popup. Each command gets a small SKILL.md the App can open when the
// chip is clicked; the chip itself arrives in the prompt as
// `[$name](<that SKILL.md>)` and is turned back into `/name args` for the CLI.
// App rule: skills-popup

export interface ClaudeCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint: string
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

// The App's own "/" commands. A same-named Claude skill would sit next to
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

const COMMAND_NAME = /^[A-Za-z0-9][\w.-]*$/

let cache: ClaudeCommand[] | null = null
const listeners = new Set<() => void>()

function catalogPath(): string {
  return join(adapterHome(), 'claude-commands.json')
}

export function claudeCommandsDir(): string {
  return join(adapterHome(), 'claude-commands')
}

export function claudeCommandManifest(name: string): string {
  return join(claudeCommandsDir(), name, 'SKILL.md')
}

export function listClaudeCommands(): ClaudeCommand[] {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(catalogPath(), 'utf8')) as {
      commands?: ClaudeCommand[]
    }
    cache = Array.isArray(parsed.commands) ? parsed.commands.filter(validCommand) : [...SEED]
  } catch {
    cache = [...SEED]
  }
  for (const command of cache) writeManifest(command)
  return cache
}

export function onClaudeCommandsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// `commands` is Query.supportedCommands(); `skills` is the init message's
// skill list. Only Claude Code's own skills are kept: user and project skills
// are already read from disk, and plain built-ins like /cost are not prompts.
export function noteClaudeCommands(
  commands: ReadonlyArray<{
    name: string
    description?: string
    argumentHint?: string
    builtin?: boolean
  }>,
  skills: readonly string[],
): void {
  const skillNames = new Set(skills)
  const next = commands
    .filter((command) => command.builtin === true && skillNames.has(command.name))
    .map((command) => ({
      name: command.name,
      description: command.description ?? '',
      argumentHint: command.argumentHint ?? '',
    }))
    .filter(validCommand)
    .sort((a, b) => a.name.localeCompare(b.name))
  if (next.length === 0) return
  const current = listClaudeCommands()
  if (JSON.stringify(current) === JSON.stringify(next)) return
  cache = next
  try {
    mkdirSync(adapterHome(), { recursive: true })
    writeFileSync(catalogPath(), `${JSON.stringify({ commands: next }, null, 2)}\n`)
  } catch (error) {
    debugLog('claudeCommands.saveFailed', { message: (error as Error).message })
  }
  for (const command of next) writeManifest(command)
  debugLog('claudeCommands.updated', { names: next.map((command) => command.name) })
  for (const listener of listeners) listener()
}

function validCommand(command: ClaudeCommand): boolean {
  return (
    typeof command?.name === 'string' &&
    COMMAND_NAME.test(command.name) &&
    !APP_COMMANDS.has(command.name)
  )
}

function writeManifest(command: ClaudeCommand): void {
  const path = claudeCommandManifest(command.name)
  const usage = command.argumentHint
    ? `/${command.name} ${command.argumentHint}`
    : `/${command.name}`
  const content = [
    '---',
    `name: ${command.name}`,
    `description: ${JSON.stringify(command.description)}`,
    '---',
    '',
    `Claude Code built-in command. Picking it runs \`${usage}\` in Claude Code;`,
    'whatever else you type in the message is passed as its arguments.',
    '',
    command.description,
    '',
  ].join('\n')
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === content) return
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
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
// to one of the built-in commands above becomes `/name` there and the rest of
// the message its arguments. Later ones stay inline as `/name`, which the
// model can still act on. Links to skills under .claude/skills are left alone:
// the CLI runs without setting sources, so it does not know them as commands
// and the model reads the linked SKILL.md instead.
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

function claudeSkillName(label: string, path: string): string | null {
  const skillDir = basename(path) === 'SKILL.md' ? dirname(path) : path
  if (dirname(skillDir) !== claudeCommandsDir()) return null
  const fromLabel = label.trim().replace(/^\$/, '')
  if (COMMAND_NAME.test(fromLabel)) return fromLabel
  const fromDir = basename(skillDir)
  return COMMAND_NAME.test(fromDir) ? fromDir : null
}
