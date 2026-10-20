// Parses a shell command into Codex CommandActions, so the App can show a
// Bash call that only reads, lists or searches files the way it shows Codex's
// own: grouped under "Explored", with the file or query instead of the raw
// command. A port of codex-rs `parse_command` (shell-command crate) for
// Bash-compatible scripts: plain words joined by `&&`, `||`, `|`, `;` or
// newlines. Anything else (redirects, expansions, globs, subshells, ...) is a
// single `unknown` action, which the App renders as the plain command.
import { isAbsolute, join } from 'node:path'
import type { CommandAction } from './types.mjs'

interface ShellCommand {
  words: string[]
  // The command as written in the script.
  text: string
}

interface ShellSequence {
  commands: ShellCommand[]
  connectors: string[]
}

interface Parsed {
  action: CommandAction
  words: string[]
}

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  'coproc',
])

// Characters whose unquoted meaning is not a plain word: expansions, globs,
// redirects, subshells, comments, history and escapes.
const UNSAFE_UNQUOTED = new Set([...'(){}<>*?[]\\~^#$!`'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

// Splits a script into plain commands, or returns null when it uses any shell
// syntax beyond quoted and unquoted words and the four connectors.
function splitWordOnlyCommands(script: string): ShellSequence | null {
  const commands: ShellCommand[] = []
  const connectors: string[] = []
  let words: string[] = []
  let word: string | null = null
  let wordQuoted = false
  let start = -1
  let end = -1
  let pendingConnector = false

  const endWord = (): boolean => {
    if (word === null) return true
    if (words.length === 0) {
      if (wordQuoted || SHELL_KEYWORDS.has(word) || ASSIGNMENT.test(word)) return false
    }
    words.push(word)
    word = null
    wordQuoted = false
    return true
  }
  const endCommand = (): void => {
    commands.push({ words, text: script.slice(start, end) })
    words = []
    start = -1
  }
  const beginWordPart = (index: number): void => {
    if (word === null) word = ''
    if (start < 0) start = index
    pendingConnector = false
  }
  const connect = (connector: string): boolean => {
    if (!endWord() || words.length === 0) return false
    endCommand()
    connectors.push(connector)
    pendingConnector = connector !== ';'
    return true
  }

  let i = 0
  while (i < script.length) {
    const char = script[i] as string
    if (char === ' ' || char === '\t' || char === '\r') {
      if (!endWord()) return null
      i += 1
      continue
    }
    if (char === '\n') {
      if (!endWord()) return null
      // A newline after `&&`, `||` or `|` continues the command list.
      if (words.length > 0) endCommand()
      i += 1
      continue
    }
    if (char === "'") {
      const close = script.indexOf("'", i + 1)
      if (close < 0) return null
      beginWordPart(i)
      word = `${word ?? ''}${script.slice(i + 1, close)}`
      wordQuoted = true
      end = close + 1
      i = close + 1
      continue
    }
    if (char === '"') {
      const close = script.indexOf('"', i + 1)
      if (close < 0) return null
      const content = script.slice(i + 1, close)
      // Double quotes still expand `$` and backticks and remove escapes.
      if (/[$`]/.test(content) || /\\[$`"\\\n]/.test(content) || content.endsWith('\\')) return null
      beginWordPart(i)
      word = `${word ?? ''}${content}`
      wordQuoted = true
      end = close + 1
      i = close + 1
      continue
    }
    if (char === '&') {
      if (script[i + 1] !== '&' || !connect('&&')) return null
      i += 2
      continue
    }
    if (char === '|') {
      if (script[i + 1] === '&') return null
      const connector = script[i + 1] === '|' ? '||' : '|'
      if (!connect(connector)) return null
      i += connector.length
      continue
    }
    if (char === ';') {
      if (script[i + 1] === ';' || !connect(';')) return null
      i += 1
      continue
    }
    if (UNSAFE_UNQUOTED.has(char)) return null
    if (char === '=' && word === null) return null
    beginWordPart(i)
    word = `${word ?? ''}${char}`
    end = i + 1
    i += 1
  }
  if (!endWord()) return null
  if (words.length > 0) endCommand()
  else if (pendingConnector) return null
  return { commands, connectors }
}

// The last path component, skipping build/dist/node_modules/src, as Codex
// names a listed or searched directory.
export function shortDisplayPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  // A loop, not /\/+$/, which backtracks quadratically on a long run of
  // slashes that does not end the path.
  let end = normalized.length
  while (end > 0 && normalized[end - 1] === '/') end -= 1
  const trimmed = normalized.slice(0, end)
  const parts = trimmed
    .split('/')
    .reverse()
    .filter((part) => part !== '' && !['build', 'dist', 'node_modules', 'src'].includes(part))
  return parts[0] ?? trimmed
}

const isDigits = (value: string): boolean => /^[0-9]+$/.test(value)

// Positional operands, skipping flags, `--flag=value` and the values the
// given flags take.
function positionalOperands(args: string[], flagsWithValues: string[]): string[] {
  const out: string[] = []
  let afterDoubleDash = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (afterDoubleDash) {
      out.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (arg.startsWith('--') && arg.includes('=')) continue
    if (flagsWithValues.includes(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    out.push(arg)
  }
  return out
}

// Arguments without the values the given flags take; everything after `--`
// is kept.
function skipFlagValues(args: string[], flagsWithValues: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') {
      out.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--') && arg.includes('=')) continue
    if (flagsWithValues.includes(arg)) {
      i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

function singleOperand(args: string[], flagsWithValues: string[]): string | null {
  const operands = positionalOperands(args, flagsWithValues)
  return operands.length === 1 ? (operands[0] as string) : null
}

const nonFlags = (args: string[]): string[] => args.filter((arg) => !arg.startsWith('-'))

// `sed -n 12p` or `sed -n 1,40p`.
function isSedRange(arg: string | undefined): boolean {
  if (!arg?.endsWith('p')) return false
  const parts = arg.slice(0, -1).split(',')
  return parts.length <= 2 && parts.every((part) => isDigits(part))
}

function sedHasInPlaceFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') break
    if (['-e', '-f', '--expression', '--file'].includes(arg)) {
      i += 1
      continue
    }
    if (arg === '--in-place' || arg.startsWith('--in-place=')) return true
    if (arg.startsWith('--') || !arg.startsWith('-')) continue
    const options = arg.slice(1)
    for (let j = 0; j < options.length; j += 1) {
      const option = options[j]
      if (option === 'i') return true
      if (option === 'e' || option === 'f') {
        if (j === options.length - 1) i += 1
        break
      }
    }
  }
  return false
}

// The file a `sed -n <range>p <file>` prints from.
function sedReadPath(args: string[]): string | null {
  if (sedHasInPlaceFlag(args) || !args.includes('-n')) return null
  let hasRange = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '-e' || arg === '--expression') {
      if (isSedRange(args[i + 1])) hasRange = true
      i += 1
    } else if (arg === '-f' || arg === '--file') {
      i += 1
    }
  }
  if (!hasRange) hasRange = args.some((arg) => !arg.startsWith('-') && isSedRange(arg))
  if (!hasRange) return null
  const operands = nonFlags(skipFlagValues(args, ['-e', '-f', '--expression', '--file']))
  if (operands.length === 0) return null
  if (isSedRange(operands[0])) return operands[1] ?? null
  return operands[0] as string
}

function awkDataFile(args: string[]): string | null {
  if (args.length === 0) return null
  const hasScriptFile = args.some((arg) => arg === '-f' || arg === '--file')
  const operands = nonFlags(
    skipFlagValues(args, ['-F', '-v', '-f', '--field-separator', '--assign', '--file']),
  )
  if (hasScriptFile) return operands[0] ?? null
  return operands[1] ?? null
}

function hasInPlaceFlag(args: string[]): boolean {
  return args.some(
    (arg) => arg.startsWith('-i') || arg.startsWith('-pi') || arg.startsWith('--in-place'),
  )
}

function xargsSubcommand(words: string[]): string[] | null {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] as string
    if (word === '--') return words.length > i + 1 ? words.slice(i + 1) : null
    if (!word.startsWith('-')) return words.slice(i)
    if (['-E', '-e', '-I', '-L', '-n', '-P', '-s'].includes(word)) i += 1
  }
  return null
}

function isMutatingXargs(words: string[]): boolean {
  const sub = xargsSubcommand(words)
  if (!sub) return false
  const [head, ...tail] = sub
  if (head === 'perl' || head === 'ruby') return hasInPlaceFlag(tail)
  if (head === 'sed') return sedHasInPlaceFlag(tail)
  if (head === 'rg') return tail.includes('--replace')
  return false
}

const isCount = (value: string, allowPlus: boolean): boolean =>
  isDigits(allowPlus && value.startsWith('+') ? value.slice(1) : value)

// Helpers that only format another command's output in a pipeline, such as
// `wc -l` or `head -n 40`. Variants that name a file stay.
function isSmallFormattingCommand(words: string[]): boolean {
  const [head, ...tail] = words
  switch (head) {
    case 'wc':
    case 'tr':
    case 'cut':
    case 'sort':
    case 'uniq':
    case 'tee':
    case 'column':
    case 'yes':
    case 'printf':
      return true
    case 'xargs':
      return !isMutatingXargs(words)
    case 'awk':
      return awkDataFile(tail) === null
    case 'head':
    case 'tail': {
      if (tail.length === 0) return true
      if (tail.length === 1) return (tail[0] as string).startsWith('-')
      if (tail.length === 2) {
        const [flag, count] = tail as [string, string]
        return (flag === '-n' || flag === '-c') && isCount(count, head === 'tail')
      }
      return false
    }
    case 'sed':
      return !sedHasInPlaceFlag(tail) && sedReadPath(tail) === null
    default:
      return false
  }
}

function headTailReadPath(head: string, tail: string[]): string | null {
  const first = tail[0]
  const allowPlus = head === 'tail'
  const validCount =
    first === '-n'
      ? tail[1] !== undefined && isCount(tail[1], allowPlus)
      : first?.startsWith('-n') === true && isCount(first.slice(2), allowPlus)
  if (validCount) {
    const candidates = first === '-n' ? tail.slice(2) : tail
    const path = candidates.find((arg) => !arg.startsWith('-'))
    if (path !== undefined) return path
  }
  if (tail.length === 1 && !(tail[0] as string).startsWith('-')) return tail[0] as string
  return null
}

const GREP_FLAGS_WITH_VALUES = [
  '-m',
  '--max-count',
  '-C',
  '--context',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
]

function grepLike(command: string, args: string[]): CommandAction {
  const operands: string[] = []
  let pattern: string | null = null
  let afterDoubleDash = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (afterDoubleDash) {
      operands.push(arg)
      continue
    }
    if (arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (['-e', '--regexp', '-f', '--file'].includes(arg)) {
      const value = args[i + 1]
      if (value !== undefined && pattern === null) pattern = value
      i += 1
      continue
    }
    if (GREP_FLAGS_WITH_VALUES.includes(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    operands.push(arg)
  }
  const path = operands[pattern === null ? 1 : 0]
  return {
    type: 'search',
    command,
    query: pattern ?? operands[0] ?? null,
    path: path === undefined ? null : shortDisplayPath(path),
  }
}

function read(command: string, path: string | null): CommandAction {
  if (path === null) return { type: 'unknown', command }
  return { type: 'read', command, name: shortDisplayPath(path), path }
}

function listFiles(command: string, path: string | undefined | null): CommandAction {
  return { type: 'listFiles', command, path: path ? shortDisplayPath(path) : null }
}

function search(
  command: string,
  query: string | null,
  path: string | undefined | null,
): CommandAction {
  return { type: 'search', command, query, path: path ? shortDisplayPath(path) : null }
}

const isPathish = (value: string): boolean =>
  value === '.' ||
  value === '..' ||
  value.startsWith('./') ||
  value.startsWith('../') ||
  value.includes('/') ||
  value.includes('\\')

const PYTHON_WALKS = [
  'os.walk',
  'os.listdir',
  'os.scandir',
  'glob.glob',
  'glob.iglob',
  'pathlib.Path',
  '.rglob(',
]

function summarize({ words, text: command }: ShellCommand): CommandAction {
  const [head, ...tail] = words as [string, ...string[]]
  switch (head) {
    case 'ls':
      return listFiles(
        command,
        positionalOperands(tail, [
          '-I',
          '-w',
          '--block-size',
          '--format',
          '--time-style',
          '--color',
          '--quoting-style',
        ])[0],
      )
    case 'eza':
    case 'exa':
      return listFiles(
        command,
        positionalOperands(tail, [
          '-I',
          '--ignore-glob',
          '--color',
          '--sort',
          '--time-style',
          '--time',
        ])[0],
      )
    case 'tree':
      return listFiles(
        command,
        positionalOperands(tail, ['-L', '-P', '-I', '--charset', '--filelimit', '--sort'])[0],
      )
    case 'du':
      return listFiles(
        command,
        positionalOperands(tail, [
          '-d',
          '--max-depth',
          '-B',
          '--block-size',
          '--exclude',
          '--time-style',
        ])[0],
      )
    case 'rg':
    case 'rga':
    case 'ripgrep-all': {
      const operands = nonFlags(
        skipFlagValues(tail, [
          '-g',
          '--glob',
          '--iglob',
          '-t',
          '--type',
          '--type-add',
          '--type-not',
          '-m',
          '--max-count',
          '-A',
          '-B',
          '-C',
          '--context',
          '--max-depth',
        ]),
      )
      if (tail.includes('--files')) return listFiles(command, operands[0])
      return search(command, operands[0] ?? null, operands[1])
    }
    case 'git': {
      const [sub, ...rest] = tail
      if (sub === 'grep') return grepLike(command, rest)
      if (sub === 'ls-files')
        return listFiles(
          command,
          positionalOperands(rest, ['--exclude', '--exclude-from', '--pathspec-from-file'])[0],
        )
      return { type: 'unknown', command }
    }
    case 'fd': {
      const operands = nonFlags(
        skipFlagValues(tail, [
          '-t',
          '--type',
          '-e',
          '--extension',
          '-E',
          '--exclude',
          '--search-path',
        ]),
      )
      const [first, second] = operands
      if (first !== undefined && second === undefined && isPathish(first))
        return listFiles(command, first)
      if (first === undefined) return listFiles(command, null)
      return search(command, first, second)
    }
    case 'find': {
      const root = tail.find((arg) => !arg.startsWith('-') && !['!', '(', ')'].includes(arg))
      const filter = tail.findIndex((arg) => ['-name', '-iname', '-path', '-regex'].includes(arg))
      const query = filter >= 0 ? (tail[filter + 1] ?? null) : null
      return query === null ? listFiles(command, root) : search(command, query, root)
    }
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return grepLike(command, tail)
    case 'ag':
    case 'ack':
    case 'pt': {
      const operands = nonFlags(
        skipFlagValues(tail, [
          '-G',
          '-g',
          '--file-search-regex',
          '--ignore-dir',
          '--ignore-file',
          '--path-to-ignore',
        ]),
      )
      return search(command, operands[0] ?? null, operands[1])
    }
    case 'cat':
    case 'more':
      return read(command, singleOperand(tail, []))
    case 'bat':
    case 'batcat':
      return read(
        command,
        singleOperand(tail, [
          '--theme',
          '--language',
          '--style',
          '--terminal-width',
          '--tabs',
          '--line-range',
          '--map-syntax',
        ]),
      )
    case 'less':
      return read(
        command,
        singleOperand(tail, [
          '-p',
          '-P',
          '-x',
          '-y',
          '-z',
          '-j',
          '--pattern',
          '--prompt',
          '--tabs',
          '--shift',
          '--jump-target',
        ]),
      )
    case 'head':
    case 'tail':
      return read(command, headTailReadPath(head, tail))
    case 'awk':
      return read(command, awkDataFile(tail))
    case 'nl':
      return read(
        command,
        skipFlagValues(tail, ['-s', '-w', '-v', '-i', '-b']).find((arg) => !arg.startsWith('-')) ??
          null,
      )
    case 'sed':
      return read(command, sedReadPath(tail))
    default:
      if (/^python([23](\..*)?)?$/.test(head)) {
        const flag = tail.indexOf('-c')
        const code = flag >= 0 ? tail[flag + 1] : undefined
        if (code !== undefined && PYTHON_WALKS.some((needle) => code.includes(needle)))
          return listFiles(command, null)
      }
      return { type: 'unknown', command }
  }
}

function cdTarget(args: string[]): string | null {
  let target: string | null = null
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') return args[i + 1] ?? null
    if (!arg.startsWith('-')) target = arg
  }
  return target
}

const joinPath = (base: string, path: string): string =>
  isAbsolute(path) || base === '' ? path : join(base, path)

const isBareTrue = (parsed: Parsed): boolean =>
  parsed.action.type === 'unknown' && parsed.words.length === 1 && parsed.words[0] === 'true'

// Drops what Codex treats as noise around the main command: a leading echo,
// a `cd` that more commands follow, `true`, and a bare `nl -flags`.
function simplifyOnce(commands: Parsed[]): Parsed[] | null {
  if (commands.length <= 1) return null
  const isUnknown = (parsed: Parsed) => parsed.action.type === 'unknown'
  const without = (index: number) => commands.filter((_, i) => i !== index)
  const first = commands[0] as Parsed
  if (isUnknown(first) && first.words[0] === 'echo') return commands.slice(1)
  const cd = commands.findIndex((parsed) => isUnknown(parsed) && parsed.words[0] === 'cd')
  if (cd >= 0 && commands.length > cd + 1) return without(cd)
  const trueIndex = commands.findIndex(isBareTrue)
  if (trueIndex >= 0) return without(trueIndex)
  const nl = commands.findIndex(
    (parsed) =>
      isUnknown(parsed) &&
      parsed.words[0] === 'nl' &&
      parsed.words.slice(1).every((word) => word.startsWith('-')),
  )
  if (nl >= 0) return without(nl)
  return null
}

// Simplifying a command list is quadratic in its length, as in Codex; longer
// lists show as the plain command.
const MAX_COMMANDS = 100

// The CommandActions of a shell command run in `cwd`. Returns one `unknown`
// action unless every part of the command reads, lists or searches files.
export function parseCommandActions(script: string, cwd: string): CommandAction[] {
  const unknown: CommandAction[] = [{ type: 'unknown', command: script }]
  const sequence = splitWordOnlyCommands(script)
  if (!sequence || sequence.commands.length === 0 || sequence.commands.length > MAX_COMMANDS)
    return unknown
  const hadMultipleCommands = sequence.commands.length > 1
  const kept = sequence.commands.filter((command) => !isSmallFormattingCommand(command.words))
  if (kept.length === 0) return unknown

  let parsed: Parsed[] = []
  let dir: string | null = null
  for (const command of kept) {
    const [head, ...tail] = command.words
    if (head === 'cd') {
      const target = cdTarget(tail)
      if (target !== null) dir = dir === null ? target : joinPath(dir, target)
      continue
    }
    const action = summarize(command)
    if (action.type === 'read' && dir !== null) action.path = joinPath(dir, action.path)
    parsed.push({ action, words: command.words })
  }
  if (parsed.length > 1) {
    parsed = parsed.filter((item) => !isBareTrue(item))
    for (let next = simplifyOnce(parsed); next; next = simplifyOnce(parsed)) parsed = next
  }
  if (parsed.length === 1) {
    const only = parsed[0] as Parsed
    const hadConnectors = hadMultipleCommands || sequence.connectors.length > 0
    const allWords = sequence.commands.flatMap((command) => command.words)
    const hasPipe = sequence.connectors.includes('|')
    const hasSedN = allWords.some((word, i) => word === 'sed' && allWords[i + 1] === '-n')
    if (only.action.type !== 'unknown') {
      if (!hadConnectors || (only.action.type === 'read' && hasPipe && hasSedN))
        only.action.command = script.trim()
    }
  }

  const actions: CommandAction[] = []
  for (const { action } of parsed) {
    const previous = actions[actions.length - 1]
    if (previous && JSON.stringify(previous) === JSON.stringify(action)) continue
    actions.push(action)
  }
  if (actions.some((action) => action.type === 'unknown')) return unknown
  return actions.map((action) =>
    action.type === 'read' ? { ...action, path: joinPath(cwd, action.path) } : action,
  )
}
