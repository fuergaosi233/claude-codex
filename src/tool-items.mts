// How Claude Code's built-in tools show up as Codex thread items: the file
// exploration tools as read, search and list commands the App groups under
// "Explored", a Read of an image as an imageView, and an MCP tool's name
// split into its server and tool.
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { mcpToolName } from './inherited-config.mjs'
import type { CommandAction, ThreadItem } from './types.mjs'

// Claude Code tools that only read, search or list files.
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

// The App keeps an exploration command's output with the item; a whole file
// or a long search result is cut to this many characters there. Claude
// itself always gets the full result.
export const EXPLORE_OUTPUT_LIMIT = 30_000

export function isExploreTool(toolName: string): boolean {
  return EXPLORE_TOOLS.has(toolName)
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const absolutePath = (path: string, cwd: string): string =>
  isAbsolute(path) || !cwd ? path : join(cwd, path)

// A path relative to cwd when it is inside cwd, else the path as given.
function displayPath(path: string, cwd: string): string {
  if (!cwd || !isAbsolute(path)) return path
  const inside = relative(cwd, path)
  if (inside === '') return '.'
  if (isAbsolute(inside) || inside.split(sep)[0] === '..') return path
  return inside
}

// The command line an exploration tool call is shown as, and its actions.
// The command names the tool rather than pretending to be a shell command.
export function exploreToolCommand(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): { command: string; commandActions: CommandAction[] } {
  if (toolName === 'Read') {
    const raw = text(input.file_path) || text(input.path)
    if (!raw) return { command: 'Read', commandActions: [{ type: 'unknown', command: 'Read' }] }
    const path = absolutePath(raw, cwd)
    const command = `Read ${displayPath(path, cwd)}`
    return { command, commandActions: [{ type: 'read', command, name: basename(path), path }] }
  }
  const rawPath = text(input.path)
  const where = rawPath ? displayPath(absolutePath(rawPath, cwd), cwd) : null
  if (toolName === 'LS') {
    const command = where ? `LS ${where}` : 'LS'
    return { command, commandActions: [{ type: 'listFiles', command, path: where }] }
  }
  // Grep and Glob both search: Glob for file names, Grep for contents. Codex
  // shows `find -name` and `fd <pattern>` the same way.
  const pattern = text(input.pattern)
  const command = [toolName, pattern, where ? `in ${where}` : ''].filter(Boolean).join(' ')
  return {
    command,
    commandActions: [{ type: 'search', command, query: pattern || null, path: where }],
  }
}

// The absolute path of an image Claude reads with the Read tool, or null.
export function imageReadPath(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  if (toolName !== 'Read') return null
  const raw = text(input.file_path) || text(input.path)
  if (!raw || !IMAGE_EXTENSIONS.has(extname(raw).toLowerCase())) return null
  const path = absolutePath(raw, cwd)
  return isAbsolute(path) ? path : null
}

// An image Read shows as an imageView. If Claude cannot read the image, the
// item becomes its fallback, a Read command, failed with what the tool said.
export function failedImageRead(
  fallback: ThreadItem | null | undefined,
  output: string | null,
  exitCode: number | null,
  durationMs: number | null,
): ThreadItem | null {
  if (fallback?.type !== 'commandExecution') return null
  return { ...fallback, status: 'failed', aggregatedOutput: output, exitCode, durationMs }
}

// Splits Claude's name for an MCP tool, mcp__<server>__<tool>, into the
// server and tool. A configured server's name wins (the longest one that
// matches, as server names may contain `__`); other names split at the
// first `__` after the prefix.
export function splitMcpToolName(
  name: string,
  servers: Iterable<string> = [],
): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  let best: { server: string; prefix: string } | null = null
  for (const server of servers) {
    const prefix = mcpToolName(server, '')
    if (name.length <= prefix.length || !name.startsWith(prefix)) continue
    if (!best || prefix.length > best.prefix.length) best = { server, prefix }
  }
  if (best) return { server: best.server, tool: name.slice(best.prefix.length) }
  const rest = name.slice('mcp__'.length)
  const split = rest.indexOf('__')
  if (split <= 0 || split + 2 >= rest.length) return null
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) }
}

export function capOutput(output: string, limit = EXPLORE_OUTPUT_LIMIT): string {
  if (output.length <= limit) return output
  return `${output.slice(0, limit)}\n… ${output.length - limit} more characters not shown`
}
