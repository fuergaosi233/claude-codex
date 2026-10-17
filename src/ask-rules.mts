import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { HookMatcher } from './sdk-hooks.mjs'

// The ask rules of the user's Claude Code settings (permissions.ask). The
// CLI takes no ask rules outside a settings file, so a PreToolUse callback
// stands in for them: a call a rule covers gets the 'ask' decision, which
// sends it to the permission prompt (the Codex approval) even when an allow
// rule or a hook would have let it run. Rules are matched as Claude Code
// matches them, erring towards asking: a Bash rule covers each command of
// a compound command line and what a wrapper such as `timeout` or `sh -c`
// runs, and a command line whose commands cannot be told apart (command
// substitution, a heredoc) is asked about when it mentions the rule's
// command at all.

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']
const SEARCH_TOOLS = ['Glob', 'Grep', 'LS']
// Commands that run (part of) the rest of their command line.
const WRAPPERS = new Set([
  'builtin',
  'caffeinate',
  'command',
  'doas',
  'env',
  'exec',
  'find',
  'ionice',
  'nice',
  'nohup',
  'stdbuf',
  'sudo',
  'taskset',
  'time',
  'timeout',
  'unbuffer',
  'watch',
  'xargs',
])
const SHELLS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh'])
// Words that start a shell construct rather than name a command.
const KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'if',
  'then',
  'until',
  'while',
])

// The PreToolUse matcher that asks before the calls `rules` cover. `cwd` is
// the thread's folder: a rule's relative paths start from it, as they do
// for the rules the CLI takes on its command line.
export function askRulesGuard(rules: readonly string[], cwd: string): HookMatcher {
  return {
    hooks: [
      async (input) => {
        const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
        const toolInput = asRecord(input.tool_input)
        const rule = rules.find((candidate) => askRuleCovers(candidate, tool, toolInput, cwd))
        if (!rule) return {}
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `Your Claude Code settings ask before ${rule}.`,
          },
        }
      },
    ],
  }
}

// Whether a permission rule (`Tool` or `Tool(specifier)`) covers a call.
export function askRuleCovers(
  rule: string,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  const match = /^([^(]+?)\s*(?:\(([\s\S]*)\))?$/.exec(rule.trim())
  if (!match?.[1]) return false
  const name = match[1]
  const specifier = match[2] ?? null
  if (name.startsWith('mcp__')) return mcpRuleCovers(name, tool)
  if (!toolsMatch(name, tool)) return false
  if (specifier === null || specifier === '' || specifier === '*') return true
  if (tool === 'Bash') return bashRuleCovers(specifier, stringOf(input.command))
  if (EDIT_TOOLS.includes(tool) || READ_TOOLS.includes(tool))
    return pathRuleCovers(specifier, toolPath(tool, input, cwd), cwd)
  if (tool === 'WebFetch') return domainRuleCovers(specifier, stringOf(input.url))
  if (tool === 'Agent' || tool === 'Task') return stringOf(input.subagent_type) === specifier
  // A specifier this does not know how to read: ask.
  return true
}

function toolsMatch(name: string, tool: string): boolean {
  if (name === tool) return true
  // An edit rule covers every tool that edits files; a Read rule every
  // tool that reads them.
  if (EDIT_TOOLS.includes(name)) return EDIT_TOOLS.includes(tool)
  if (name === 'Read') return READ_TOOLS.includes(tool)
  const agent = new Set(['Agent', 'Task'])
  return agent.has(name) && agent.has(tool)
}

// mcp__server covers the server's tools, as does mcp__server__*.
function mcpRuleCovers(name: string, tool: string): boolean {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9_*-]/g, '_')
  const rule = clean(name)
  const parts = rule.split('__')
  if (parts.length === 2) return tool === rule || tool.startsWith(`${rule}__`)
  if (rule.endsWith('*')) return tool.startsWith(rule.slice(0, -1))
  return tool === rule
}

// Bash(specifier): `prefix:*`, a pattern with * wildcards, or a command.
// The specifier is read as a command line too, so its quoting does not
// have to match the command's.
export function bashRuleCovers(specifier: string, line: string): boolean {
  const parsed = simpleCommands(specifier)
  const words = parsed?.length === 1 ? parsed[0] : null
  const pattern = words ? words.join(' ') : specifier.trim()
  const commands = commandCandidates(line)
  if (commands === null) {
    // Cannot tell the commands apart: ask when the rule's command shows up.
    const head = /^[^\s*:]*/.exec(pattern)?.[0] ?? ''
    return head === '' || line.includes(head)
  }
  return commands.some(commandMatcher(pattern))
}

function commandMatcher(specifier: string): (command: string) => boolean {
  // Legacy prefix form.
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2)
    return (command) => command.startsWith(prefix)
  }
  if (specifier.includes('*')) {
    // `cmd *` also covers `cmd` alone.
    const optionalTail = specifier.endsWith(' *')
    const body = optionalTail ? specifier.slice(0, -2) : specifier
    const source = body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    const pattern = new RegExp(`^${source}${optionalTail ? '(?: .*)?' : ''}$`, 's')
    return (command) => pattern.test(command)
  }
  // A plain command, with or without more arguments.
  return (command) => command === specifier || command.startsWith(`${specifier} `)
}

// Every command a command line runs, each as its words joined by single
// spaces, plus the commands its wrappers run; null when the line runs
// something only the shell can work out.
export function commandCandidates(line: string, depth = 0): string[] | null {
  if (depth > 3) return null
  const commands = simpleCommands(line)
  if (commands === null) return null
  const out: string[] = []
  for (const words of commands) {
    const rest = withoutPrefixes(words)
    if (rest.length === 0) continue
    if (rest[0]?.includes('$')) return null
    const program = basename(rest[0] ?? '')
    out.push(rest.join(' '), [program, ...rest.slice(1)].join(' '))
    if (WRAPPERS.has(program))
      for (let index = 1; index < rest.length; index += 1) {
        const tail = rest.slice(index)
        out.push(tail.join(' '), [basename(tail[0] ?? ''), ...tail.slice(1)].join(' '))
      }
    if (program === 'eval') {
      const inner = commandCandidates(rest.slice(1).join(' '), depth + 1)
      if (inner === null) return null
      out.push(...inner)
    }
    if (SHELLS.has(program)) {
      const flag = rest.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
      if (flag > 0) {
        const inner = commandCandidates(rest[flag + 1] ?? '', depth + 1)
        if (inner === null) return null
        out.push(...inner)
      }
    }
  }
  return [...new Set(out)]
}

// Leading variable assignments and shell keywords.
function withoutPrefixes(words: string[]): string[] {
  let start = 0
  while (
    start < words.length &&
    (KEYWORDS.has(words[start] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? ''))
  )
    start += 1
  return words.slice(start)
}

// The simple commands of a command line, as their words with quotes
// removed and redirections dropped; null for command substitution, process
// substitution, a heredoc or an unterminated quote.
function simpleCommands(line: string): string[][] | null {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let skipNext = false
  const endWord = () => {
    if (inWord) {
      if (skipNext) skipNext = false
      else words.push(word)
    }
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    skipNext = false
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? ''
    const next = line[index + 1] ?? ''
    if (char === '\\') {
      if (next !== '\n') {
        word += next
        inWord = true
      }
      index += 1
      continue
    }
    if (char === "'") {
      const close = line.indexOf("'", index + 1)
      if (close < 0) return null
      word += line.slice(index + 1, close)
      inWord = true
      index = close
      continue
    }
    if (char === '"') {
      let close = index + 1
      let text = ''
      for (; close < line.length && line[close] !== '"'; close += 1) {
        if (line[close] === '\\' && close + 1 < line.length) {
          close += 1
          text += line[close]
          continue
        }
        if (line[close] === '`' || (line[close] === '$' && line[close + 1] === '(')) return null
        text += line[close]
      }
      if (close >= line.length) return null
      word += text
      inWord = true
      index = close
      continue
    }
    if (char === '`' || (char === '$' && next === '(')) return null
    if (char === '#' && !inWord) {
      const newline = line.indexOf('\n', index)
      if (newline < 0) break
      index = newline - 1
      continue
    }
    if (char === '<' || char === '>') {
      if (next === '(' || (char === '<' && next === '<')) return null
      // A redirection: dropped with its target. A file descriptor number
      // right before it belongs to it.
      if (/^\d+$/.test(word)) {
        word = ''
        inWord = false
      }
      endWord()
      while (/[>&|]/.test(line[index + 1] ?? '')) index += 1
      // >&2 and the like name no file.
      if (line[index] === '&' && /[\d-]/.test(line[index + 1] ?? '')) {
        while (/[\d-]/.test(line[index + 1] ?? '')) index += 1
        continue
      }
      skipNext = true
      continue
    }
    if (
      char === ';' ||
      char === '|' ||
      char === '&' ||
      char === '\n' ||
      char === '(' ||
      char === ')'
    ) {
      endCommand()
      continue
    }
    if (/\s/.test(char)) {
      endWord()
      continue
    }
    word += char
    inWord = true
  }
  endCommand()
  return commands
}

// The file a file tool works on, or the folder a search tool looks in, as an
// absolute path; null when the call names none it should.
function toolPath(tool: string, input: Record<string, unknown>, cwd: string): string | null {
  const raw =
    stringOf(input.file_path) || stringOf(input.notebook_path) || stringOf(input.path) || null
  if (raw === null) return SEARCH_TOOLS.includes(tool) ? resolve(cwd) : null
  if (raw === '~' || raw.startsWith('~/')) return join(homedir(), raw.slice(1))
  return resolve(cwd, raw)
}

// A file rule: //absolute, ~/home, /from-the-project or relative to the
// thread's folder, in gitignore pattern syntax; it covers what is inside a
// folder it names too.
export function pathRuleCovers(specifier: string, target: string | null, cwd: string): boolean {
  if (target === null) return true
  const roots = [...new Set([resolve(cwd), realPathOf(cwd)])]
  const targets = [...new Set([target, realPathOf(target)])]
  const patterns: string[] = []
  for (const root of roots) {
    if (specifier.startsWith('//')) patterns.push(specifier.slice(1))
    else if (specifier === '~' || specifier.startsWith('~/'))
      patterns.push(join(homedir(), specifier.slice(1)))
    else {
      const relative = specifier.replace(/^\.?\//, '')
      patterns.push(join(root, relative))
      // A pattern without a slash matches at any depth, as in .gitignore.
      if (!relative.includes('/')) patterns.push(join(root, '**', relative))
    }
  }
  const expressions = patterns.flatMap((pattern) => {
    const absolute = isAbsolute(pattern) ? pattern : resolve(pattern)
    return [...new Set([absolute, realPathOf(absolute)])].map(globExpression)
  })
  return targets.some((path) => expressions.some((expression) => expression.test(path)))
}

// A trailing /** covers the folder itself as well.
function globExpression(glob: string): RegExp {
  const pattern = glob.endsWith('/**') ? glob.slice(0, -3) : glob
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      index += slash ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source.replace(/\/$/, '')}(?:/.*)?$`, 's')
}

// WebFetch(domain:example.com) covers the host and its subdomains.
function domainRuleCovers(specifier: string, url: string): boolean {
  if (!specifier.startsWith('domain:')) return true
  const domain = specifier.slice('domain:'.length).replace(/^\*\./, '').toLowerCase()
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return true
  }
  return host === domain || host.endsWith(`.${domain}`)
}

// The real path of a file that may not exist yet.
function realPathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(realPathOf(parent), basename(path))
  }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
