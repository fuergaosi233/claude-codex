import { existsSync, readdirSync, statSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { gitRoot, realPath } from './project-instructions.mjs'
import type { ClaudeCheckpoint } from './types.mjs'
import { isPathInside, projectSlugs } from './util.mjs'

// Session changes give Claude the changes a chat made to files as a unified
// diff, for reviews where git has none: outside a git work tree the review
// commands (/simplify, /review) find nothing to review. The changes come from
// the chat's Claude Code transcripts: each Edit, Write and NotebookEdit that
// went through, its subagents' included. The diff shows each file as it is
// now against the file before the chat first changed it. What shell commands
// changed is not in the transcripts. Off unless CLAUDE_CODEX_SESSION_CHANGES=1.

export const SESSION_MCP_SERVER = 'codex_session'
export const SESSION_CHANGES_TOOL = `mcp__${SESSION_MCP_SERVER}__changes`

export const SESSION_CHANGES_DESCRIPTION = `Show the changes this chat made to files as a unified diff, like git diff's: each file as it is now against the file before the chat first changed it. It covers every Edit, Write and NotebookEdit of the chat and of its subagents; changes made by shell commands are not tracked.
Use it as the diff to review where git has none, such as when the working directory is not in a git repository. Files outside the working directory are only listed unless paths names them. A long diff is cut short and lists the files it left out; call again with paths to see those.`

export function sessionChangesEnabled(): boolean {
  return process.env.CLAUDE_CODEX_SESSION_CHANGES === '1'
}

// What Claude is told outside a git work tree, where the commands that review
// changes (/simplify, /review and the like) find none in git: where the
// chat's own are. Null inside one.
export function sessionChangesHint(cwd: string): string | null {
  if (gitRoot(resolve(cwd)) !== null) return null
  return `The working directory is not in a git repository, so git diff shows no changes. To review or describe the changes this chat made to files, as a command that reads them from git diff would, call ${SESSION_CHANGES_TOOL}.`
}

export interface SessionChangesQuery {
  cwd: string
  // The config dirs the transcripts may be in.
  configRoots: readonly string[]
  // The chat's Claude sessions, each read up to the entry named (the last
  // checkpoint the chat keeps in it), or to its end for null.
  sessions: ReadonlyMap<string, string | null>
  // Only the last few turns' changes: those made after the entry the turn
  // before them ended at or, when no transcript has it, those made from when
  // the first of them started, in ms.
  turns?: { after: ClaudeCheckpoint | null; startedAt: number | null } | null
  paths?: readonly string[] | undefined
  stat?: boolean | undefined
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// The transcript lines that call one of them, and the ids of the calls a
// line answers. Claude Code writes its entries as compact JSON.
const FILE_TOOL_CALL = /"name":"(?:Edit|Write|NotebookEdit)"/
const TOOL_RESULT_ID = /"tool_use_id":"([^"]+)"/g
const READ_CHUNK = 256 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIFF_CHARS = 60_000
const MAX_LISTED_OUTSIDE = 20
const CONTEXT_LINES = 3
// Past this many line edits, a diff gives the changed part as one
// replacement instead of searching on.
const MAX_EDIT_DISTANCE = 1000

// A change one tool call made to a file. `before` is the file just before
// it: its text, or null when it did not exist. Without it, as for a
// subagent's call, which records only its input, or an Edit of a large file,
// whose result leaves the text out, the change may still be undone: by the
// lines its result recorded (`patch`), or by the strings it replaced.
interface FileChange {
  file: string
  at: number
  before?: string | null
  patch?: Hunk[]
  edit?: { oldString: string; newString: string }
}

// A hunk of the patch Claude Code records with a change, jsdiff's
// structuredPatch: 1-based starts, and lines tagged ' ', '-' or '+'.
interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface FileReport {
  name: string
  status: 'M' | 'A' | 'D' | '?'
  summary: string
  diff: string
}

export async function sessionChanges(query: SessionChangesQuery): Promise<string> {
  const { changes, since } = await recordedChanges(query)
  const cwds = [resolve(query.cwd), realPath(query.cwd)]
  // A file goes by its path in the working directory, which joins the paths
  // through a symlinked one, or else by its absolute path.
  const byName = new Map<string, FileChange[]>()
  for (const change of changes) {
    const name = displayName(change.file, cwds)
    const named = byName.get(name)
    if (named) named.push(change)
    else byName.set(name, [change])
  }
  const wanted = (query.paths ?? []).map((path) => displayName(resolve(query.cwd, path), cwds))
  const names = [...byName.keys()]
  const shown =
    wanted.length > 0
      ? names.filter((name) => wanted.some((path) => within(path, name)))
      : names.filter((name) => !isAbsolute(name))
  const outside = wanted.length > 0 ? [] : names.filter((name) => isAbsolute(name))
  const reports = (await Promise.all(shown.map((name) => fileReport(name, byName.get(name) ?? []))))
    .filter((report): report is FileReport => report !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  const scope = since != null ? ` since ${new Date(since).toISOString()}` : ''
  const lead = `The files this chat changed${scope} with Edit, Write and NotebookEdit, its subagents' included: each as it is now against the file before the chat's first change to it${scope ? ' in that time' : ''}. Changes made by shell commands are not tracked.`
  const out = [lead, '']
  if (reports.length === 0) out.push(wanted.length > 0 ? 'None in those paths.' : 'None.')
  for (const report of reports) out.push(`${report.status} ${report.name} ${report.summary}`)
  if (outside.length > 0) {
    const listed = outside.slice(0, MAX_LISTED_OUTSIDE).join(', ')
    const more =
      outside.length > MAX_LISTED_OUTSIDE ? ` and ${outside.length - MAX_LISTED_OUTSIDE} more` : ''
    out.push('', `Outside the working directory, not shown: ${listed}${more}.`)
  }
  if (query.stat) return out.join('\n')
  let budget = MAX_DIFF_CHARS
  const leftOut: string[] = []
  for (const report of reports) {
    if (!report.diff) continue
    if (report.diff.length <= budget) {
      out.push('', report.diff)
      budget -= report.diff.length
    } else if (budget === MAX_DIFF_CHARS) {
      // One file's diff alone is too long: its start, rather than nothing.
      out.push('', `${report.diff.slice(0, budget)}\n[diff cut short at ${budget} characters]`)
      budget = 0
    } else {
      leftOut.push(report.name)
    }
  }
  if (leftOut.length > 0)
    out.push(
      '',
      `Left out to keep this short: ${leftOut.join(', ')}. Call again with paths to see them.`,
    )
  return out.join('\n')
}

// A file inside the working directory by its path there, any other by its
// absolute path.
function displayName(file: string, cwds: readonly string[]): string {
  const cwd = cwds.find((dir) => file === dir || isPathInside(dir, file))
  return cwd ? relative(cwd, file) : file
}

// Whether the file `name` is the path `path` names or lies below it; '' is
// the working directory.
function within(path: string, name: string): boolean {
  if (path === '') return !isAbsolute(name)
  return name === path || name.startsWith(path.endsWith(sep) ? path : `${path}${sep}`)
}

// Every change the sessions' transcripts record, once each (a forked
// session's transcript repeats its parent's calls), oldest first: of the
// turns asked for, and from when they start.
async function recordedChanges(
  query: SessionChangesQuery,
): Promise<{ changes: FileChange[]; since: number | null }> {
  const after = query.turns?.after ?? null
  const changes = new Map<string, FileChange>()
  const keep = (read: TranscriptRead) => {
    for (const [id, change] of read.changes) if (!changes.has(id)) changes.set(id, change)
  }
  let afterAt: number | null = null
  const subagents: Array<{ files: string[]; notAfter: number | null }> = []
  for (const [sessionId, until] of query.sessions) {
    const files = sessionFiles(sessionId, query.cwd, query.configRoots)
    const mark = after?.sessionId === sessionId ? after.messageUuid : null
    const read = files.main ? await readTranscript(files.main, { until, mark }) : null
    if (read) keep(read)
    if (read?.markAt != null) afterAt = read.markAt
    // The session's subagents count up to the same entry, by its time.
    subagents.push({ files: files.subagents, notAfter: until ? (read?.untilAt ?? null) : null })
  }
  const since = !query.turns ? null : afterAt !== null ? afterAt + 1 : query.turns.startedAt
  if (query.turns && since === null) throw new Error('Cannot tell when those turns started.')
  for (const { files, notAfter } of subagents) {
    for (const file of files) {
      // A transcript last written before then has nothing newer.
      if (since !== null && (modifiedAt(file) ?? 0) < since) continue
      keep(await readTranscript(file, { notAfter }))
    }
  }
  return {
    changes: [...changes.values()]
      .filter((change) => since === null || change.at >= since)
      .sort((a, b) => a.at - b.at),
    since,
  }
}

// A session's transcripts: its own, the newest copy of it in the config
// dirs, in the project dir named after the cwd or, for a session that ran
// elsewhere, in any project dir; and its subagents' and workflow agents', in
// the session's dir beside each copy.
function sessionFiles(
  sessionId: string,
  cwd: string,
  roots: readonly string[],
): { main: string | null; subagents: string[] } {
  const holds = (dir: string) =>
    existsSync(join(dir, `${sessionId}.jsonl`)) || existsSync(join(dir, sessionId))
  const projects = [...new Set(roots)].map((root) => join(root, 'projects'))
  const slugs = projectSlugs(resolve(cwd))
  let dirs = projects.flatMap((dir) => slugs.map((slug) => join(dir, slug))).filter(holds)
  if (dirs.length === 0) dirs = projects.flatMap(subdirectories).filter(holds)
  let main: string | null = null
  let newest = -1
  for (const dir of dirs) {
    const file = join(dir, `${sessionId}.jsonl`)
    const time = modifiedAt(file)
    if (time !== null && time > newest) {
      main = file
      newest = time
    }
  }
  return {
    main,
    subagents: dirs.flatMap((dir) => agentTranscripts(join(dir, sessionId, 'subagents'))),
  }
}

function modifiedAt(file: string): number | null {
  try {
    const info = statSync(file)
    return info.isFile() ? info.mtimeMs : null
  } catch {
    return null
  }
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

function agentTranscripts(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => basename(name).startsWith('agent-') && name.endsWith('.jsonl'))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

interface TranscriptRead {
  // By tool call id.
  changes: Map<string, FileChange>
  // When the `until` and `mark` entries were written; null when the
  // transcript lacks them.
  untilAt: number | null
  markAt: number | null
}

// The file changes a transcript records, up to its `until` entry and up to
// the time `notAfter`, and when its `mark` entry was written.
async function readTranscript(
  path: string,
  options: { until?: string | null; mark?: string | null; notAfter?: number | null },
): Promise<TranscriptRead> {
  const { until = null, mark = null, notAfter = null } = options
  const read: TranscriptRead = { changes: new Map(), untilAt: null, markAt: null }
  // The file tool calls still waiting for their result.
  const calls = new Map<string, Record<string, unknown>>()
  try {
    for await (const line of fileLines(path)) {
      // Only what calls a file tool, answers one or marks an entry is parsed.
      const relevant =
        FILE_TOOL_CALL.test(line) ||
        answers(line, calls) ||
        (until !== null && line.includes(until)) ||
        (mark !== null && line.includes(mark))
      if (!relevant) continue
      let entry: Record<string, unknown>
      try {
        entry = record(JSON.parse(line))
      } catch {
        continue
      }
      const at = Date.parse(String(entry.timestamp ?? '')) || 0
      if (notAfter !== null && at > notAfter) break
      const content = record(entry.message).content
      for (const block of Array.isArray(content) ? content.map(record) : []) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          if (FILE_TOOLS.has(String(block.name))) calls.set(block.id, block)
          continue
        }
        const id = block.type === 'tool_result' ? String(block.tool_use_id ?? '') : ''
        const call = calls.get(id)
        if (!call) continue
        calls.delete(id)
        if (block.is_error === true) continue
        const change = fileChange(call, entry.toolUseResult, resultText(block.content), at)
        if (change) read.changes.set(id, change)
      }
      if (mark !== null && entry.uuid === mark) read.markAt = at
      if (until !== null && entry.uuid === until) {
        read.untilAt = at
        break
      }
    }
  } catch {
    // An unreadable transcript gives what was read of it.
  }
  return read
}

// A file's lines, read a chunk at a time.
async function* fileLines(path: string): AsyncGenerator<string> {
  const handle = await open(path, 'r')
  try {
    const decoder = new StringDecoder('utf8')
    const chunk = Buffer.alloc(READ_CHUNK)
    let rest = ''
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      const text = decoder.write(chunk.subarray(0, bytesRead))
      const end = text.lastIndexOf('\n')
      if (end < 0) {
        rest += text
        continue
      }
      const lines = `${rest}${text.slice(0, end)}`.split('\n')
      rest = text.slice(end + 1)
      yield* lines
    }
    rest += decoder.end()
    if (rest) yield rest
  } finally {
    await handle.close()
  }
}

// Whether a transcript line answers one of `calls`.
function answers(line: string, calls: ReadonlyMap<string, unknown>): boolean {
  if (calls.size === 0 || !line.includes('"tool_result"')) return false
  for (const [, id] of line.matchAll(TOOL_RESULT_ID)) if (id && calls.has(id)) return true
  return false
}

// The change a call that went through made. The chat's own transcript keeps
// the call's result: the file as it was, or for a large file the patch; a
// subagent's keeps only the call's input and whether it created the file.
function fileChange(
  call: Record<string, unknown>,
  result: unknown,
  resultText: string,
  at: number,
): FileChange | null {
  const input = record(call.input)
  const detail = result && typeof result === 'object' ? record(result) : null
  // A staged change was held for review and never written.
  if (detail?.staged === true || typeof detail?.error === 'string') return null
  const path = call.name === 'NotebookEdit' ? input.notebook_path : input.file_path
  if (typeof path !== 'string' || !isAbsolute(path)) return null
  const change: FileChange = { file: resolve(path), at }
  const original = call.name === 'NotebookEdit' ? detail?.original_file : detail?.originalFile
  if (typeof original === 'string') change.before = original
  else if (
    call.name === 'Write' &&
    (detail?.type === 'create' || (!detail && resultText.startsWith('File created')))
  )
    change.before = null
  const patch = hunksOf(detail?.structuredPatch)
  if (patch) change.patch = patch
  if (call.name === 'Edit') {
    // The strings as the edit applied them, which its result gives.
    const strings = typeof detail?.oldString === 'string' ? detail : null
    const oldString = strings ? strings.oldString : input.old_string
    const newString = strings ? strings.newString : input.new_string
    change.edit = {
      oldString: typeof oldString === 'string' ? oldString : '',
      newString: typeof newString === 'string' ? newString : '',
    }
    // An Edit with nothing to replace creates the file.
    if (change.before === undefined && change.edit.oldString === '') change.before = null
  }
  return change
}

// The hunks a result recorded, when there are any and all are well formed.
function hunksOf(value: unknown): Hunk[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const hunks: Hunk[] = []
  for (const item of value) {
    const { oldStart, oldLines, newStart, newLines, lines } = record(item)
    if (
      ![oldStart, oldLines, newStart, newLines].every(Number.isInteger) ||
      !Array.isArray(lines) ||
      !lines.every((line) => typeof line === 'string')
    )
      return null
    hunks.push({ oldStart, oldLines, newStart, newLines, lines } as Hunk)
  }
  return hunks
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => String(record(part).text ?? '')).join('')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// What one file looks like against its text before the chat changed it, or
// null when it is back to that text.
async function fileReport(
  name: string,
  changes: readonly FileChange[],
): Promise<FileReport | null> {
  const file = changes[changes.length - 1]?.file ?? name
  let now: string | null
  try {
    const info = await stat(file)
    if (!info.isFile()) return { name, status: '?', summary: '(cannot be read)', diff: '' }
    if (info.size > MAX_FILE_BYTES) {
      const status = changes[0]?.before === null ? 'A' : 'M'
      return { name, status, summary: '(too large to diff)', diff: '' }
    }
    now = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return { name, status: '?', summary: '(cannot be read)', diff: '' }
    now = null
  }
  const before = baseline(changes, now)
  if (before === undefined) return unknownBaseline(name, changes)
  if (before === now) return null
  const status = before === null ? 'A' : now === null ? 'D' : 'M'
  if (before?.includes('\0') || now?.includes('\0'))
    return { name, status, summary: '(binary)', diff: '' }
  const ops = editScript(diffLines(before ?? ''), diffLines(now ?? ''))
  const added = ops.filter(([tag]) => tag === '+').length
  const removed = ops.filter(([tag]) => tag === '-').length
  const [oldName, newName] = isAbsolute(name) ? [name, name] : [`a/${name}`, `b/${name}`]
  return {
    name,
    status,
    summary: `(+${added} -${removed})`,
    diff: [
      `diff --git ${oldName} ${newName}`,
      `--- ${before === null ? '/dev/null' : oldName}`,
      `+++ ${now === null ? '/dev/null' : newName}`,
      ...hunks(ops),
    ].join('\n'),
  }
}

// The file before the first of `changes` (oldest first), given its text now:
// the text the oldest change that recorded one had before it, with the
// changes before that undone, or else the text now with them all undone.
// Undefined when it cannot be told.
function baseline(changes: readonly FileChange[], now: string | null): string | null | undefined {
  const known = changes.findIndex((change) => change.before !== undefined)
  let text = known >= 0 ? changes[known]?.before : now
  for (let index = (known >= 0 ? known : changes.length) - 1; index >= 0; index -= 1) {
    const change = changes[index]
    if (change) text = undo(change, text)
  }
  return text
}

// The text before a change, given the text after it: by the lines its result
// recorded, else by putting an Edit's old string back for its new one where
// that shows just once (a replaceAll edit whose new string shows more often
// cannot tell which were there before). Undefined when neither can tell.
function undo(change: FileChange, after: string | null | undefined): string | undefined {
  if (typeof after !== 'string') return undefined
  const unpatched = change.patch ? unpatch(change.patch, after) : undefined
  if (unpatched !== undefined) return unpatched
  const edit = change.edit
  if (!edit || edit.newString === '') return undefined
  const parts = after.split(edit.newString)
  return parts.length === 2 ? parts.join(edit.oldString) : undefined
}

// The text before a patch, given the text after it. Undefined unless the
// text holds each hunk's new lines where the hunk says; a hunk that marks a
// missing final newline is not undone either.
function unpatch(patch: readonly Hunk[], after: string): string | undefined {
  const lines = after.split('\n')
  // From the last hunk back, so the lines before each stay where they were.
  for (let index = patch.length - 1; index >= 0; index -= 1) {
    const hunk = patch[index]
    if (!hunk || hunk.lines.some((line) => line.startsWith('\\'))) return undefined
    const newSide = hunk.lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1))
    const oldSide = hunk.lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1))
    const start = Math.max(0, hunk.newStart - 1)
    if (newSide.some((line, offset) => lines[start + offset] !== line)) return undefined
    lines.splice(start, newSide.length, ...oldSide)
  }
  return lines.join('\n')
}

// A file whose text before the chat is not known, such as one a subagent
// rewrote or changed after its last recorded state: the changes it took,
// each on its own.
function unknownBaseline(name: string, changes: readonly FileChange[]): FileReport {
  const parts = changes.map((change) => {
    if (change.patch)
      return change.patch
        .map((hunk) =>
          [
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
            ...hunk.lines,
          ].join('\n'),
        )
        .join('\n')
    if (change.edit)
      return [
        '@@ edit @@',
        ...textLines(change.edit.oldString).map((line) => `-${line}`),
        ...textLines(change.edit.newString).map((line) => `+${line}`),
      ].join('\n')
    return '@@ rewritten as a whole @@'
  })
  return {
    name,
    status: '?',
    summary: '(its text before the chat is not recorded; showing each change alone)',
    diff: [`--- ${name}`, `+++ ${name}`, ...parts].join('\n'),
  }
}

type Op = readonly [' ' | '-' | '+', string]

// A text's lines, without the newline that ends the last.
function textLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n')
}

// A text's lines, the last one marked as unified diffs mark it when the text
// does not end in a newline.
function diffLines(text: string): string[] {
  const lines = textLines(text)
  if (text !== '' && !text.endsWith('\n'))
    lines[lines.length - 1] += '\n\\ No newline at end of file'
  return lines
}

// The line edits from `a` to `b`: Myers' algorithm on what lies between
// their common start and end.
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const same = (lines: readonly string[]): Op[] => lines.map((line) => [' ', line])
  return [
    ...same(a.slice(0, start)),
    ...shortestEdit(a.slice(start, endA), b.slice(start, endB)),
    ...same(a.slice(endA)),
  ]
}

function shortestEdit(a: readonly string[], b: readonly string[]): Op[] {
  const replace = () => [...a.map((line): Op => ['-', line]), ...b.map((line): Op => ['+', line])]
  // With a side empty, or more edits than the search allows (it takes at
  // least the difference in length), it is one replacement.
  if (a.length === 0 || b.length === 0 || Math.abs(a.length - b.length) > MAX_EDIT_DISTANCE)
    return replace()
  // trace[d][k + d]: how far along `a` the furthest path with d edits on
  // diagonal k (x - y) reaches.
  const trace: Int32Array[] = []
  const maxEdits = Math.min(a.length + b.length, MAX_EDIT_DISTANCE)
  for (let d = 0; d <= maxEdits; d += 1) {
    const reach = new Int32Array(2 * d + 1)
    const prev = trace[d - 1]
    for (let k = -d; k <= d; k += 2) {
      let x = 0
      if (prev) x = fromAbove(prev, d, k) ? reached(prev, d, k + 1) : reached(prev, d, k - 1) + 1
      let y = x - k
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1
        y += 1
      }
      reach[k + d] = x
      if (x >= a.length && y >= b.length) {
        trace.push(reach)
        return backtrack(trace, a, b)
      }
    }
    trace.push(reach)
  }
  return replace()
}

// How far along `a` the furthest path with d - 1 edits on diagonal k reaches.
function reached(prev: Int32Array, d: number, k: number): number {
  return prev[k + d - 1] ?? 0
}

// Whether the furthest path with d edits to diagonal k comes down from
// diagonal k + 1 (an insertion) rather than across from k - 1 (a deletion).
function fromAbove(prev: Int32Array, d: number, k: number): boolean {
  return k === -d || (k !== d && reached(prev, d, k - 1) < reached(prev, d, k + 1))
}

function backtrack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[]): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d - 1] ?? new Int32Array(0)
    const k = x - y
    const down = fromAbove(prev, d, k)
    const prevK = down ? k + 1 : k - 1
    const prevX = reached(prev, d, prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      ops.push([' ', a[x] ?? ''])
    }
    if (down) {
      y -= 1
      ops.push(['+', b[y] ?? ''])
    } else {
      x -= 1
      ops.push(['-', a[x] ?? ''])
    }
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    ops.push([' ', a[x] ?? ''])
  }
  return ops.reverse()
}

// The edits as unified diff hunks, CONTEXT_LINES of unchanged lines around
// each change.
function hunks(ops: readonly Op[]): string[] {
  // Old and new lines before each op.
  const at: Array<[number, number]> = []
  let oldLine = 0
  let newLine = 0
  for (const [tag] of ops) {
    at.push([oldLine, newLine])
    if (tag !== '+') oldLine += 1
    if (tag !== '-') newLine += 1
  }
  const changed = ops.flatMap(([tag], index) => (tag === ' ' ? [] : [index]))
  const out: string[] = []
  for (let index = 0; index < changed.length; ) {
    const first = changed[index] ?? 0
    let last = first
    // Changes with no more than twice the context between them share a hunk.
    while (index + 1 < changed.length && (changed[index + 1] ?? 0) - last <= 2 * CONTEXT_LINES + 1)
      last = changed[(index += 1)] ?? last
    index += 1
    const from = Math.max(0, first - CONTEXT_LINES)
    const to = Math.min(ops.length, last + CONTEXT_LINES + 1)
    const slice = ops.slice(from, to)
    const [oldStart, newStart] = at[from] ?? [0, 0]
    const oldCount = slice.filter(([tag]) => tag !== '+').length
    const newCount = slice.filter(([tag]) => tag !== '-').length
    out.push(`@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`)
    for (const [tag, line] of slice) out.push(`${tag}${line}`)
  }
  return out
}

// A hunk's line range: where it starts (1-based) and how many lines it has.
// An empty side names the line it follows.
function hunkRange(before: number, count: number): string {
  if (count === 0) return `${before},0`
  return count === 1 ? `${before + 1}` : `${before + 1},${count}`
}
