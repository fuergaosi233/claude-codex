import { join } from 'node:path'
import {
  claudeSkillFolders,
  frontmatterBody,
  markdownFiles,
  readText,
  withoutFrontmatter,
} from './project-instructions.mjs'
import { debugLog } from './util.mjs'

// Claude Code subagents (agents/*.md) for a CLI that reads none of its own:
// the user's, in the Claude Code config folder, then the project's, in each
// .claude/agents folder from the git root down to the thread's folder. As
// in Claude Code, a project agent wins a name over a user agent, and a
// closer folder over one further up. They reach Claude as the SDK's
// `agents` option.
//
// The frontmatter fields the SDK takes are passed on. permissionMode is
// not: the Codex approval policy decides. hooks and inline mcpServers
// definitions are not either; servers named by a string are.

export interface ClaudeAgent {
  readonly name: string
  // The file the agent came from.
  readonly source: string
  // The agent as the SDK's agents option takes it.
  readonly definition: Record<string, unknown>
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MEMORY_SCOPES = ['user', 'project', 'local']

export function claudeAgents(cwd: string, configDir: string): ClaudeAgent[] {
  const agents = new Map<string, ClaudeAgent>()
  const dirs = [
    join(configDir, 'agents'),
    ...claudeSkillFolders(cwd).map((dir) => join(dir, '.claude', 'agents')),
  ]
  for (const dir of dirs)
    for (const path of markdownFiles(dir).sort()) {
      const agent = agentFrom(path, readText(path) ?? '')
      if (!agent) continue
      agents.delete(agent.name)
      agents.set(agent.name, agent)
    }
  return [...agents.values()]
}

function agentFrom(source: string, text: string): ClaudeAgent | null {
  const data = frontmatterData(text)
  // A Markdown file without frontmatter is a note, not an agent.
  if (!data) return null
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  if (!name || !description) {
    debugLog('claude_agent_skipped', { path: source, reason: 'no name or description' })
    return null
  }
  const definition: Record<string, unknown> = {
    // Claude Code reads \n in a one-line description as a line break.
    description: description.replace(/\\n/g, '\n'),
    prompt: withoutFrontmatter(text).trim(),
  }
  const tools = toolList(data.tools)
  // * stands for every tool, as no list does.
  if (tools && !tools.includes('*')) definition.tools = tools
  const disallowed = toolList(data.disallowedTools)
  if (disallowed && disallowed.length > 0) definition.disallowedTools = disallowed
  if (typeof data.model === 'string' && data.model.trim()) definition.model = data.model.trim()
  const skills = toolList(data.skills)
  if (skills && skills.length > 0) definition.skills = skills
  const maxTurns = Number(data.maxTurns)
  if (Number.isInteger(maxTurns) && maxTurns > 0) definition.maxTurns = maxTurns
  // The token count at which the subagent compacts its own conversation; it
  // only ever lowers the window the subagent would inherit.
  const autoCompactWindow =
    typeof data.autoCompactWindow === 'number' || typeof data.autoCompactWindow === 'string'
      ? Number(data.autoCompactWindow)
      : Number.NaN
  if (Number.isSafeInteger(autoCompactWindow) && autoCompactWindow > 0)
    definition.autoCompactWindow = autoCompactWindow
  if (data.background === true || data.background === 'true') definition.background = true
  if (typeof data.memory === 'string' && MEMORY_SCOPES.includes(data.memory))
    definition.memory = data.memory
  if (typeof data.effort === 'string' && EFFORTS.includes(data.effort))
    definition.effort = data.effort
  else if (typeof data.effort === 'number' && Number.isInteger(data.effort))
    definition.effort = data.effort
  if (typeof data.initialPrompt === 'string' && data.initialPrompt.trim())
    definition.initialPrompt = data.initialPrompt
  const servers = Array.isArray(data.mcpServers)
    ? data.mcpServers.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
  if (servers.length > 0) definition.mcpServers = servers
  return { name, source, definition }
}

// A tool list given as a YAML list or a comma-separated string.
function toolList(value: unknown): string[] | null {
  const items = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null
  if (!items) return null
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

// The frontmatter's top-level keys: the subset of YAML agent files use
// (plain, quoted and block scalars, flow and block lists). Nested mappings
// read as empty objects. Like Claude Code, it tolerates a plain value with
// a colon in it. Null without frontmatter.
export function frontmatterData(text: string): Record<string, unknown> | null {
  const body = frontmatterBody(text)
  if (body == null) return null
  const lines = body.split(/\r?\n/)
  const out: Record<string, unknown> = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim() || line.startsWith('#') || /^\s/.test(line)) continue
    const match = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$/.exec(line)
    if (!match?.[1]) continue
    const rest = (match[2] ?? '').trim()
    const block: string[] = []
    for (;;) {
      const next = lines[i + 1]
      if (next === undefined) break
      const continues =
        /^\s/.test(next) || next.trim() === '' || (rest === '' && /^-(\s|$)/.test(next))
      if (!continues) break
      block.push(next)
      i++
    }
    while (block.length > 0 && !block.at(-1)?.trim()) block.pop()
    Object.defineProperty(out, match[1], {
      value: yamlValue(rest, block),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

function yamlValue(rest: string, block: string[]): unknown {
  const indicator = /^([|>])([+-]?)\s*(#.*)?$/.exec(rest)
  if (indicator) return blockScalar(indicator[1] === '>', indicator[2] ?? '', block)
  if (rest.startsWith('[')) return flowList([rest, ...block.map((line) => line.trim())].join(' '))
  if (rest.startsWith('"') || rest.startsWith("'"))
    return quoted([rest, ...block.map((line) => line.trim())].join(' '))
  // The first line under the key tells a list or a mapping from text.
  const first = block.find((line) => line.trim()) ?? ''
  const indent = /^\s*/.exec(first)?.[0] ?? ''
  if (rest === '' && /^\s*-(\s|$)/.test(first))
    return block
      .filter((line) => line.startsWith(`${indent}-`))
      .map((line) => {
        const item = line.slice(indent.length + 1).trim()
        return /^[A-Za-z0-9_-]+\s*:(\s|$)/.test(item) ? {} : scalar(item)
      })
  if (rest === '' && /^\s*[A-Za-z0-9_-]+\s*:(\s|$)/.test(first)) return {}
  // A plain value folds its continuation lines into one.
  return scalar(
    [rest, ...block.map((line) => line.trim())].filter(Boolean).join(' '),
    block.length === 0,
  )
}

function blockScalar(folded: boolean, chomp: string, block: string[]): string {
  const indent = Math.min(
    ...block.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)?.[0].length ?? 0),
  )
  const lines = block.map((line) => line.slice(Number.isFinite(indent) ? indent : 0))
  let text = ''
  if (!folded) text = lines.join('\n')
  else
    for (const [index, line] of lines.entries()) {
      const previous = lines[index - 1]
      if (index === 0) text = line
      else if (line === '' || previous === '' || /^\s/.test(line)) text += `\n${line}`
      else text += ` ${line}`
    }
  if (chomp === '-') return text
  return `${text}\n`
}

function flowList(text: string): unknown[] {
  const inner = text.slice(1, text.lastIndexOf(']') < 0 ? undefined : text.lastIndexOf(']'))
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      items.push(current)
      current = ''
    } else current += ch
  }
  items.push(current)
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('"') || item.startsWith("'") ? quoted(item) : scalar(item)))
}

function quoted(text: string): string {
  const mark = text[0]
  const end = text.lastIndexOf(mark ?? '')
  const inner = text.slice(1, end > 0 ? end : undefined)
  if (mark === "'") return inner.replace(/''/g, "'")
  return inner.replace(/\\(u[0-9A-Fa-f]{4}|.)/g, (_, sequence: string) => {
    if (sequence.length > 1) return String.fromCharCode(Number.parseInt(sequence.slice(1), 16))
    return { n: '\n', t: '\t', r: '\r', '0': '\0' }[sequence] ?? sequence
  })
}

function scalar(text: string, typed = true): unknown {
  const value = text.replace(/\s+#.*$/, '').trim()
  if (!typed) return value
  if (value === 'true' || value === 'false') return value === 'true'
  if (value === '' || value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}
