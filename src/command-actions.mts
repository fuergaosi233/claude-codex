// Parses a shell command into Codex CommandActions, so the App can show a
// Bash call that only reads, lists or searches files the way it shows Codex's
// own: grouped under "Explored", with the file or query instead of the raw
// command. A port of codex-rs `parse_command` (shell-command crate) for
// Bash-compatible scripts: plain words joined by `&&`, `||`, `|`, `;` or
// newlines. Anything else (redirects, expansions, globs, subshells, ...) is a
// single `unknown` action, which the App renders as the plain command.
//
// Unlike Codex, a command that can write files or start other programs never
// folds: `find -delete`, `fd -x`, `rg --pre`, `| xargs rm`, `| tee out`, an
// awk program that calls `system` and a sed script that writes all show as
// the plain command, so "Explored" never hides a change.
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
      // BSD sed, as on macOS, edits in place with `-I`.
      if (option === 'i' || option === 'I') return true
      if (option === 'e' || option === 'f') {
        if (j === options.length - 1) i += 1
        break
      }
    }
  }
  return false
}

// The scripts a sed command runs: its `-e` values, or else its first operand.
// Null when a script comes from a file.
function sedScripts(args: string[]): string[] | null {
  const scripts: string[] = []
  let firstOperand: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') {
      firstOperand ??= args[i + 1]
      break
    }
    if (arg === '--file' || arg.startsWith('--file=')) return null
    if (arg === '--expression') {
      const script = args[i + 1]
      if (script === undefined) return null
      scripts.push(script)
      i += 1
    } else if (arg.startsWith('--expression=')) {
      scripts.push(arg.slice('--expression='.length))
    } else if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      const options = arg.slice(1)
      for (let j = 0; j < options.length; j += 1) {
        const option = options[j]
        if (option === 'f') return null
        if (option === 'e') {
          const attached = options.slice(j + 1)
          const script = attached === '' ? args[i + 1] : attached
          if (script === undefined) return null
          scripts.push(script)
          if (attached === '') i += 1
          break
        }
        // `-l N` sets the line length.
        if (option === 'l') {
          if (j === options.length - 1) i += 1
          break
        }
      }
    } else if (!arg.startsWith('-')) {
      firstOperand ??= arg
    }
  }
  if (scripts.length === 0 && firstOperand !== undefined) scripts.push(firstOperand)
  return scripts
}

const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:\\.|[^\\/\n])*/)`
// A sed script that only prints, substitutes, deletes or quits: a single
// command without the `w`, `e` or `r` commands and flags, which write files,
// run commands or read other files.
const PLAIN_SED_SCRIPT = new RegExp(
  String.raw`^(?:s([^\\\n])(?:\\.|(?!\1)[^\\\n])*\1(?:\\.|(?!\1)[^\\\n])*\1[gIiMmp0-9]*|(?:${SED_ADDRESS}(?:,${SED_ADDRESS})?)?[dpq])$`,
)

// The file a `sed -n <range>p <file>` prints from.
function sedReadPath(args: string[]): string | null {
  if (sedHasInPlaceFlag(args) || !args.includes('-n')) return null
  const scripts = sedScripts(args)
  if (!scripts?.length || !scripts.every((script) => isSedRange(script))) return null
  const operands = nonFlags(skipFlagValues(args, ['-e', '-f', '--expression', '--file']))
  if (operands.length === 0) return null
  if (isSedRange(operands[0])) return operands[1] ?? null
  return operands[0] as string
}

const AWK_FLAGS_WITH_VALUES = ['-F', '-v', '--field-separator', '--assign']

// Whether an awk command may write files or run commands: its program
// redirects output (`print > "out"`), pipes (`|`), calls `system` or
// `getline`, or loads code (`@load`), or the program comes from a file or
// an option the command does not show. Comparisons look like redirects, so
// `awk '$3 > 1' data.csv` shows as the plain command too.
function awkMayWrite(args: string[]): boolean {
  if (args.some((arg) => /^-(?:[efilEW]|-(?:exec|file|include|load|source)(?:=|$))/.test(arg)))
    return true
  return nonFlags(skipFlagValues(args, AWK_FLAGS_WITH_VALUES)).some((arg) =>
    /system|getline|[|>@]/.test(arg),
  )
}

function awkDataFile(args: string[]): string | null {
  return nonFlags(skipFlagValues(args, AWK_FLAGS_WITH_VALUES))[1] ?? null
}

const hasPreprocessor = (args: string[]): boolean =>
  args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))

function xargsSubcommand(words: string[]): string[] | null {
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] as string
    if (word === '--') return words.length > i + 1 ? words.slice(i + 1) : null
    if (!word.startsWith('-')) return words.slice(i)
    // GNU's `-e` and `-i` take only an attached value, so unlike Codex the
    // word after them is the program, as in `xargs -e rm`.
    if (['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s'].includes(word)) i += 1
  }
  return null
}

// Programs xargs can run on its input and still only read or print.
const XARGS_READERS = new Set([
  'cat',
  'echo',
  'egrep',
  'fgrep',
  'grep',
  'head',
  'ls',
  'rg',
  'tail',
  'wc',
])

// An xargs that echoes its input or runs a program that only reads. Codex
// drops any xargs but one that runs an in-place editor; every other program
// it runs can write too.
function xargsOnlyReads(words: string[]): boolean {
  const sub = xargsSubcommand(words)
  if (sub === null) return true
  const [head, ...tail] = sub as [string, ...string[]]
  return XARGS_READERS.has(head) && !(head === 'rg' && hasPreprocessor(tail))
}

const isCount = (value: string, allowPlus: boolean): boolean =>
  isDigits(allowPlus && value.startsWith('+') ? value.slice(1) : value)

// Helpers that only format another command's output in a pipeline, such as
// `wc -l` or `head -n 40`. Variants that name a file stay, and so do
// variants that write one, which Codex drops.
function isSmallFormattingCommand(words: string[]): boolean {
  const [head, ...tail] = words
  switch (head) {
    case 'wc':
    case 'tr':
    case 'cut':
    case 'column':
    case 'yes':
    case 'printf':
      return true
    case 'tee':
      return nonFlags(tail).length === 0
    case 'sort':
      // `sort -o out`, also bundled as in `-ro out`.
      return !tail.some(
        (arg) =>
          /^-[^-]*o/.test(arg) ||
          arg.startsWith('--output') ||
          arg.startsWith('--compress-program'),
      )
    case 'uniq':
      // `uniq in out` writes `out`.
      return (
        positionalOperands(tail, [
          '-f',
          '-s',
          '-w',
          '--skip-fields',
          '--skip-chars',
          '--check-chars',
        ]).length < 2
      )
    case 'xargs':
      return xargsOnlyReads(words)
    case 'awk':
      return !awkMayWrite(tail) && awkDataFile(tail) === null
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
    case 'sed': {
      if (sedHasInPlaceFlag(tail) || sedReadPath(tail) !== null) return false
      const scripts = sedScripts(tail)
      return scripts?.every((script) => PLAIN_SED_SCRIPT.test(script)) === true
    }
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

// Options that make a listing or search tool delete, write files or run
// another program.
const WRITING_OPTIONS = new Map<string, RegExp>([
  ['find', /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/],
  ['fd', /^(?:--exec(?:-batch)?(?:=|$)|-[^-]*[xX])/],
  ['rg', /^--pre(?:=|$)/],
  ['rga', /^--pre(?:=|$)/],
  ['ripgrep-all', /^--pre(?:=|$)/],
  ['tree', /^(?:-o|-R$)/],
])

function summarize({ words, text: command }: ShellCommand): CommandAction {
  const [head, ...tail] = words as [string, ...string[]]
  const writing = WRITING_OPTIONS.get(head)
  if (writing && tail.some((arg) => writing.test(arg))) return { type: 'unknown', command }
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
      // `git grep -O` opens the matching files in a pager.
      if (sub === 'grep' && rest.some((arg) => /^(?:-[^-]*O|--open-files-in-pager)/.test(arg)))
        return { type: 'unknown', command }
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
      return awkMayWrite(tail) ? { type: 'unknown', command } : read(command, awkDataFile(tail))
    case 'nl':
      return read(
        command,
        skipFlagValues(tail, ['-s', '-w', '-v', '-i', '-b']).find((arg) => !arg.startsWith('-')) ??
          null,
      )
    case 'sed':
      return read(command, sedReadPath(tail))
    // Codex lists files for a `python -c` whose code mentions `os.walk` and
    // the like, whatever else the code does; here it is the plain command.
    default:
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
