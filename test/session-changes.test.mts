import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { gitRoot } from '../src/project-instructions.mjs'
import {
  SESSION_CHANGES_TOOL,
  type SessionChangesQuery,
  sessionChanges,
  sessionChangesHint,
} from '../src/session-changes.mjs'
import { projectSlugs } from '../src/util.mjs'
import { withInProcessApp } from './fixtures/in-process-app.mjs'

// Session changes: the diff of what a chat's Claude sessions changed, read
// from their transcripts, and how the adapter hands it to Claude.

const lead = (since?: string) =>
  `The files this chat changed${since ? ` since ${since}` : ''} with Edit, Write and NotebookEdit, its subagents' included: each as it is now against the file before the chat's first change to it${since ? ' in that time' : ''}. Changes made by shell commands are not tracked.`

interface Dirs {
  base: string
  // The Claude config dir.
  root: string
  cwd: string
  // The cwd's project dir under root, where its sessions' transcripts are.
  project: string
}

async function withDirs(run: (dirs: Dirs) => Promise<void>): Promise<void> {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'claude-codex-session-changes-')))
  const root = join(base, 'claude')
  const cwd = join(base, 'work')
  const project = join(root, 'projects', projectSlugs(cwd)[0] ?? '')
  await mkdir(cwd, { recursive: true })
  await mkdir(project, { recursive: true })
  try {
    await run({ base, root, cwd, project })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

// Well before the tests run, so transcripts written now are newer.
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z')
const at = (second: number) => new Date(BASE_TIME + second * 1000).toISOString()
// The time just after an entry written at `second`.
const justAfter = (second: number) => new Date(Date.parse(at(second)) + 1).toISOString()

// A file tool call and its result, as Claude Code writes them. The chat's
// own transcript keeps the call's result in toolUseResult; a subagent's keeps
// only the result text.
function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
  second: number,
  result: { detail?: Record<string, unknown>; text?: string; isError?: boolean } = {},
): string[] {
  return [
    JSON.stringify({
      type: 'assistant',
      uuid: `${id}-call`,
      timestamp: at(second),
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    }),
    JSON.stringify({
      type: 'user',
      uuid: `${id}-result`,
      timestamp: at(second),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: result.text ?? 'ok',
            ...(result.isError ? { is_error: true } : {}),
          },
        ],
      },
      ...(result.detail ? { toolUseResult: result.detail } : {}),
    }),
  ]
}

// An Edit; `originalFile` undefined writes it as a subagent's, null as the
// result of an edit to a file too large to keep whole, which only has the
// patch in `extra`.
function edit(
  id: string,
  file: string,
  [oldString, newString]: [string, string],
  second: number,
  originalFile?: string | null,
  extra: Record<string, unknown> = {},
): string[] {
  return toolCall(
    id,
    'Edit',
    { file_path: file, old_string: oldString, new_string: newString },
    second,
    originalFile === undefined
      ? { text: `The file ${file} has been updated successfully.` }
      : {
          detail: {
            filePath: file,
            oldString,
            newString,
            originalFile,
            structuredPatch: [],
            userModified: false,
            replaceAll: false,
            ...extra,
          },
        },
  )
}

// A hunk of a recorded patch.
const hunk = (oldStart: number, oldLines: number, newLines: number, lines: string[]) => ({
  oldStart,
  oldLines,
  newStart: oldStart,
  newLines,
  lines,
})

// A Write; `originalFile` null creates the file, undefined writes it as a
// subagent's creating call.
function write(
  id: string,
  file: string,
  content: string,
  second: number,
  originalFile?: string | null,
): string[] {
  return toolCall(
    id,
    'Write',
    { file_path: file, content },
    second,
    originalFile === undefined
      ? { text: `File created successfully at: ${file}` }
      : {
          detail: {
            type: originalFile === null ? 'create' : 'update',
            filePath: file,
            content,
            structuredPatch: [],
            originalFile,
          },
        },
  )
}

// The newest entry of a turn, where a checkpoint points.
function entry(uuid: string, second: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: at(second),
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  })
}

const lines = (...parts: Array<string | string[]>) => `${parts.flat().join('\n')}\n`

// The sessions, each to its end unless it names an entry.
function changesOf(
  dirs: Dirs,
  sessions: Record<string, string | null>,
  options: Partial<SessionChangesQuery> = {},
): Promise<string> {
  return sessionChanges({
    cwd: dirs.cwd,
    configRoots: [dirs.root],
    sessions: new Map(Object.entries(sessions)),
    ...options,
  })
}

test("the chat's own changes diff against each file before the chat changed it", async () => {
  await withDirs(async (dirs) => {
    const { cwd, project, base } = dirs
    const file = (name: string) => join(cwd, name)
    const elsewhere = join(base, 'elsewhere', 'other.txt')
    await put(file('a.txt'), 'one\nTWO\nthree\n')
    await put(file('new.txt'), 'hello')
    await put(file('same.txt'), 'x\n')
    await put(file('staged.txt'), 'staged\n')
    await put(file('failed.txt'), 'failed\n')
    await put(file('book.ipynb'), '{"cells":[1]}\n')
    await put(
      join(project, 'S1.jsonl'),
      lines(
        edit('t1', file('a.txt'), ['two', 'TWO'], 1, 'one\ntwo\nthree\n'),
        write('t2', file('new.txt'), 'hello', 2, null),
        write('t3', file('gone.txt'), 'later\n', 3, 'bye\n'),
        edit('t4', file('same.txt'), ['x', 'y'], 4, 'x\n'),
        edit('t5', file('same.txt'), ['y', 'x'], 5, 'y\n'),
        edit('t6', file('staged.txt'), ['old', 'staged'], 6, 'old\n', { staged: true }),
        toolCall('t7', 'Edit', { file_path: file('failed.txt') }, 7, { isError: true }),
        toolCall('t8', 'NotebookEdit', { notebook_path: file('book.ipynb') }, 8, {
          detail: { original_file: '{"cells":[]}\n', updated_file: '{"cells":[1]}\n' },
        }),
        edit('t9', elsewhere, ['a', 'b'], 9, 'a\n'),
      ),
    )
    const sessions = { S1: null }
    assert.equal(
      await changesOf(dirs, sessions),
      [
        lead(),
        '',
        'M a.txt (+1 -1)',
        'M book.ipynb (+1 -1)',
        'D gone.txt (+0 -1)',
        'A new.txt (+1 -0)',
        '',
        `Outside the working directory, not shown: ${elsewhere}.`,
        '',
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '',
        'diff --git a/book.ipynb b/book.ipynb',
        '--- a/book.ipynb',
        '+++ b/book.ipynb',
        '@@ -1 +1 @@',
        '-{"cells":[]}',
        '+{"cells":[1]}',
        '',
        'diff --git a/gone.txt b/gone.txt',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
        '',
        'diff --git a/new.txt b/new.txt',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1 @@',
        '+hello',
        '\\ No newline at end of file',
      ].join('\n'),
    )

    // The list alone, and the files under the paths asked for, outside ones
    // included, by their absolute paths.
    assert.equal(
      await changesOf(dirs, sessions, { stat: true }),
      [
        lead(),
        '',
        'M a.txt (+1 -1)',
        'M book.ipynb (+1 -1)',
        'D gone.txt (+0 -1)',
        'A new.txt (+1 -0)',
        '',
        `Outside the working directory, not shown: ${elsewhere}.`,
      ].join('\n'),
    )
    await put(elsewhere, 'b\n')
    assert.equal(
      await changesOf(dirs, sessions, { paths: ['a.txt', elsewhere] }),
      [
        lead(),
        '',
        `M ${elsewhere} (+1 -1)`,
        'M a.txt (+1 -1)',
        '',
        `diff --git ${elsewhere} ${elsewhere}`,
        `--- ${elsewhere}`,
        `+++ ${elsewhere}`,
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
      ].join('\n'),
    )
    assert.equal(
      await changesOf(dirs, sessions, { paths: ['sub'] }),
      `${lead()}\n\nNone in those paths.`,
    )
    assert.equal(await changesOf(dirs, { missing: null }), `${lead()}\n\nNone.`)
  })
})

// Claude Code leaves a large file's text out of an Edit's result and keeps
// only the patch, which undoes the edit even where its new string shows more
// than once or is empty.
test('edits recorded without the file are undone by their patch', async () => {
  await withDirs(async (dirs) => {
    const { cwd, project } = dirs
    const file = (name: string) => join(cwd, name)
    await put(file('q.txt'), 'keep\n')
    await put(file('r.txt'), 'x\nx\n')
    await put(file('t.txt'), 'a\nB')
    await put(file('u.txt'), 'three\n')
    await put(
      join(project, 'S1.jsonl'),
      lines(
        edit('t1', file('q.txt'), ['gone\n', ''], 1, null, {
          structuredPatch: [hunk(1, 2, 1, [' keep', '-gone'])],
        }),
        edit('t2', file('r.txt'), ['y', 'x'], 2, null, {
          structuredPatch: [hunk(1, 2, 2, [' x', '-y', '+x'])],
        }),
        // A patch that marks a missing final newline is not undone; the
        // edit's strings are.
        edit('t3', file('t.txt'), ['b', 'B'], 3, null, {
          structuredPatch: [
            hunk(1, 2, 2, [
              ' a',
              '-b',
              '\\ No newline at end of file',
              '+B',
              '\\ No newline at end of file',
            ]),
          ],
        }),
        // Undone newest first.
        edit('t4', file('u.txt'), ['one', 'two'], 4, null, {
          structuredPatch: [hunk(1, 1, 1, ['-one', '+two'])],
        }),
        edit('t5', file('u.txt'), ['two', 'three'], 5, null, {
          structuredPatch: [hunk(1, 1, 1, ['-two', '+three'])],
        }),
      ),
    )
    assert.equal(
      await changesOf(dirs, { S1: null }),
      [
        lead(),
        '',
        'M q.txt (+0 -1)',
        'M r.txt (+1 -1)',
        'M t.txt (+1 -1)',
        'M u.txt (+1 -1)',
        '',
        'diff --git a/q.txt b/q.txt',
        '--- a/q.txt',
        '+++ b/q.txt',
        '@@ -1,2 +1 @@',
        ' keep',
        '-gone',
        '',
        'diff --git a/r.txt b/r.txt',
        '--- a/r.txt',
        '+++ b/r.txt',
        '@@ -1,2 +1,2 @@',
        ' x',
        '-y',
        '+x',
        '',
        'diff --git a/t.txt b/t.txt',
        '--- a/t.txt',
        '+++ b/t.txt',
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+B',
        '\\ No newline at end of file',
        '',
        'diff --git a/u.txt b/u.txt',
        '--- a/u.txt',
        '+++ b/u.txt',
        '@@ -1 +1 @@',
        '-one',
        '+three',
      ].join('\n'),
    )
  })
})

test("subagents' edits are undone from the file as it is now", async () => {
  await withDirs(async (dirs) => {
    const { cwd, project } = dirs
    const file = (name: string) => join(cwd, name)
    await put(file('a.txt'), 'one\n2\nthree\n')
    await put(file('b.txt'), 'made\n')
    await put(file('c.txt'), 'y\ny\n')
    await put(file('d.txt'), 'D\nE\n')
    await put(join(project, 'S1.jsonl'), lines(entry('e1', 1)))
    await put(
      join(project, 'S1', 'subagents', 'agent-a1.jsonl'),
      lines(
        edit('s1', file('a.txt'), ['two', '2'], 2),
        // A new string the file now holds twice: where it went is unknown.
        edit('s2', file('c.txt'), ['x', 'y'], 3),
        // Undone back to back: E→e first, then D→d.
        edit('s3', file('d.txt'), ['d', 'D'], 4),
        edit('s4', file('d.txt'), ['e', 'E'], 5),
      ),
    )
    // A workflow's agents, deeper down; its journal is not a transcript.
    await put(
      join(project, 'S1', 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl'),
      lines(write('s5', file('b.txt'), 'made\n', 6)),
    )
    await put(
      join(project, 'S1', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'),
      lines(edit('s6', file('a.txt'), ['one', '1'], 7)),
    )
    assert.equal(
      await changesOf(dirs, { S1: null }),
      [
        lead(),
        '',
        'M a.txt (+1 -1)',
        'A b.txt (+1 -0)',
        '? c.txt (its text before the chat is not recorded; showing each change alone)',
        'M d.txt (+2 -2)',
        '',
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+2',
        ' three',
        '',
        'diff --git a/b.txt b/b.txt',
        '--- /dev/null',
        '+++ b/b.txt',
        '@@ -0,0 +1 @@',
        '+made',
        '',
        '--- c.txt',
        '+++ c.txt',
        '@@ edit @@',
        '-x',
        '+y',
        '',
        'diff --git a/d.txt b/d.txt',
        '--- a/d.txt',
        '+++ b/d.txt',
        '@@ -1,2 +1,2 @@',
        '-d',
        '-e',
        '+D',
        '+E',
      ].join('\n'),
    )
  })
})

test('an older session counts up to its checkpoint, its subagents up to that time', async () => {
  await withDirs(async (dirs) => {
    const { cwd, project } = dirs
    const file = (name: string) => join(cwd, name)
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      await put(file(`${name}.txt`), `${name.toUpperCase()}\n`)
    const first = edit('t1', file('a.txt'), ['a', 'A'], 1, 'a\n')
    await put(
      join(project, 'S1.jsonl'),
      lines(first, entry('c1', 2), edit('t2', file('b.txt'), ['b', 'B'], 3, 'b\n')),
    )
    await put(
      join(project, 'S1', 'subagents', 'agent-x.jsonl'),
      lines(edit('s1', file('d.txt'), ['d', 'D'], 1), edit('s2', file('c.txt'), ['c', 'C'], 4)),
    )
    // The session forked from S1 at c1 repeats what came before it.
    await put(
      join(project, 'S2.jsonl'),
      lines(first, entry('c1', 2), edit('t3', file('e.txt'), ['e', 'E'], 5, 'e\n')),
    )
    assert.equal(
      await changesOf(dirs, { S1: 'c1', S2: null }, { stat: true }),
      [lead(), '', 'M a.txt (+1 -1)', 'M d.txt (+1 -1)', 'M e.txt (+1 -1)'].join('\n'),
    )
    // The live session counts to its end.
    assert.equal(
      await changesOf(dirs, { S1: null }, { stat: true }),
      [lead(), '', 'M a.txt (+1 -1)', 'M b.txt (+1 -1)', 'M c.txt (+1 -1)', 'M d.txt (+1 -1)'].join(
        '\n',
      ),
    )
  })
})

test("the last turns' changes start after the turn before them ended", async () => {
  await withDirs(async (dirs) => {
    const { cwd, project } = dirs
    const file = (name: string) => join(cwd, name)
    await put(file('a.txt'), 'c\n')
    await put(file('d.txt'), 'D\n')
    await put(file('f.txt'), 'F\n')
    await put(file('g.txt'), 'G\n')
    await put(
      join(project, 'S1.jsonl'),
      lines(
        edit('t1', file('a.txt'), ['a', 'b'], 1, 'a\n'),
        edit('t2', file('f.txt'), ['f', 'F'], 1, 'f\n'),
        entry('c1', 2),
        edit('t3', file('a.txt'), ['b', 'c'], 3, 'b\n'),
      ),
    )
    await put(
      join(project, 'S1', 'subagents', 'agent-s.jsonl'),
      lines(edit('s1', file('g.txt'), ['g', 'G'], 1), edit('s2', file('d.txt'), ['d', 'D'], 4)),
    )
    const expected = (since: string) =>
      [
        lead(since),
        '',
        'M a.txt (+1 -1)',
        'M d.txt (+1 -1)',
        '',
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1 @@',
        '-b',
        '+c',
        '',
        'diff --git a/d.txt b/d.txt',
        '--- a/d.txt',
        '+++ b/d.txt',
        '@@ -1 +1 @@',
        '-d',
        '+D',
      ].join('\n')
    const ended = { sessionId: 'S1', messageUuid: 'c1' }
    assert.equal(
      await changesOf(dirs, { S1: null }, { turns: { after: ended, startedAt: null } }),
      expected(justAfter(2)),
    )
    // Where no transcript has the entry the turn before ended at, the
    // changes count from when the first turn started.
    const started = BASE_TIME + 2000
    for (const after of [null, { sessionId: 'S1', messageUuid: 'gone' }])
      assert.equal(
        await changesOf(dirs, { S1: null }, { turns: { after, startedAt: started } }),
        expected(at(2)),
      )
    await assert.rejects(
      changesOf(dirs, { S1: null }, { turns: { after: null, startedAt: null } }),
      /^Error: Cannot tell when those turns started\.$/,
    )
  })
})

test('a symlinked working directory finds the sessions and paths of the real one', async () => {
  await withDirs(async (dirs) => {
    const { base, cwd, project } = dirs
    const link = join(base, 'link')
    await symlink(cwd, link)
    await put(join(cwd, 'a.txt'), 'A\n')
    // Claude Code keeps the session under the real path.
    await put(
      join(project, 'S1.jsonl'),
      lines(edit('t1', join(cwd, 'a.txt'), ['a', 'A'], 1, 'a\n')),
    )
    const listed = [lead(), '', 'M a.txt (+1 -1)'].join('\n')
    for (const paths of [undefined, ['a.txt'], ['.'], [join(link, 'a.txt')], [join(cwd, 'a.txt')]])
      assert.equal(
        await changesOf({ ...dirs, cwd: link }, { S1: null }, { paths, stat: true }),
        listed,
        String(paths),
      )
  })
})

test('the newest copy of a session counts, wherever the config dirs keep it', async () => {
  await withDirs(async (dirs) => {
    const { base, root, cwd, project } = dirs
    const other = join(base, 'claude-other')
    const file = (name: string) => join(cwd, name)
    await put(file('a.txt'), 'A\n')
    await put(file('b.txt'), 'B\n')
    const older = join(project, 'S1.jsonl')
    const newer = join(other, 'projects', projectSlugs(cwd)[0] ?? '', 'S1.jsonl')
    await put(older, lines(edit('t1', file('a.txt'), ['a', 'A'], 1, 'a\n')))
    await put(
      newer,
      lines(
        edit('t1', file('a.txt'), ['a', 'A'], 1, 'a\n'),
        edit('t2', file('b.txt'), ['b', 'B'], 2, 'b\n'),
      ),
    )
    const stamp = (path: string, seconds: number) => utimes(path, seconds, seconds)
    const now = Date.now() / 1000
    await stamp(older, now - 60)
    const roots = { configRoots: [root, other], stat: true }
    assert.equal(
      await changesOf(dirs, { S1: null }, roots),
      [lead(), '', 'M a.txt (+1 -1)', 'M b.txt (+1 -1)'].join('\n'),
    )
    await stamp(newer, now - 120)
    assert.equal(
      await changesOf(dirs, { S1: null }, roots),
      [lead(), '', 'M a.txt (+1 -1)'].join('\n'),
    )
    // A session that ran from another directory is in that one's project
    // dir.
    await put(
      join(other, 'projects', 'elsewhere', 'S2.jsonl'),
      lines(edit('t3', file('b.txt'), ['b', 'B'], 3, 'b\n')),
    )
    assert.equal(
      await changesOf(dirs, { S2: null }, roots),
      [lead(), '', 'M b.txt (+1 -1)'].join('\n'),
    )
  })
})

test('a long diff is cut short and names the files it left out', async () => {
  await withDirs(async (dirs) => {
    const { cwd, project } = dirs
    const file = (name: string) => join(cwd, name)
    const text = (count: number) =>
      `${Array.from({ length: count }, (_, index) => `line ${String(index).padStart(5, '0')}`).join('\n')}\n`
    // About 24,000 characters of diff each: two fit, the third does not.
    for (const name of ['a', 'b', 'c']) await put(file(`${name}.txt`), text(2000))
    await put(file('huge.txt'), text(8000))
    await put(
      join(project, 'S1.jsonl'),
      lines(
        ...['a', 'b', 'c'].map((name, index) =>
          write(`t${index}`, file(`${name}.txt`), text(2000), index, null),
        ),
      ),
    )
    await put(join(project, 'S2.jsonl'), lines(write('h', file('huge.txt'), text(8000), 1, null)))
    const three = await changesOf(dirs, { S1: null })
    assert.match(three, /\ndiff --git a\/a\.txt b\/a\.txt\n/)
    assert.match(three, /\ndiff --git a\/b\.txt b\/b\.txt\n/)
    assert.doesNotMatch(three, /diff --git a\/c\.txt/)
    assert.ok(
      three.endsWith('\n\nLeft out to keep this short: c.txt. Call again with paths to see them.'),
    )
    const huge = await changesOf(dirs, { S2: null })
    assert.ok(huge.endsWith('\n[diff cut short at 60000 characters]'))
  })
})

// The diff's line edits are the fewest that turn one text into the other,
// and applying its hunks to the old text gives the new one.
test('diffs are minimal and apply', async () => {
  await withDirs(async (dirs) => {
    const { cwd, project } = dirs
    let seed = 7
    const random = (below: number) => {
      seed = (seed * 48271) % 2147483647
      return seed % below
    }
    const randomLines = () => Array.from({ length: random(30) }, () => 'abcd'[random(4)] ?? 'a')
    for (let index = 0; index < 120; index += 1) {
      const before = randomLines()
      // Half the time the new text is the old one with a few changes.
      const after =
        index % 2 === 0
          ? randomLines()
          : before.flatMap((line) => {
              const roll = random(10)
              return roll === 0 ? [] : roll === 1 ? [line, 'e'] : roll === 2 ? ['f'] : [line]
            })
      const name = `f${index}.txt`
      const asText = (text: string[]) => text.map((line) => `${line}\n`).join('')
      await put(join(cwd, name), asText(after))
      await put(
        join(project, `R${index}.jsonl`),
        lines(write(`r${index}`, join(cwd, name), asText(after), 1, asText(before))),
      )
      const out = await changesOf(dirs, { [`R${index}`]: null })
      if (asText(before) === asText(after)) {
        assert.equal(out, `${lead()}\n\nNone.`)
        continue
      }
      const counts = /\n[MAD] \S+ \(\+(\d+) -(\d+)\)\n/.exec(out)
      assert.ok(counts, out)
      assert.equal(
        Number(counts[1]) + Number(counts[2]),
        before.length + after.length - 2 * commonLength(before, after),
        out,
      )
      const diff = out.slice(out.indexOf('\n@@ ') + 1)
      assert.deepEqual(applyHunks(before, diff), after, out)
    }
  })
})

function commonLength(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (const line of a) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0
      row[j] = line === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] ?? 0)
      diagonal = above
    }
  }
  return row[b.length] ?? 0
}

function applyHunks(before: readonly string[], diff: string): string[] {
  const out: string[] = []
  let next = 0
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(line)
    if (header) {
      const start = Number(header[1])
      const from = header[2] === '0' ? start : start - 1
      out.push(...before.slice(next, from))
      next = from
    } else if (line.startsWith('+')) {
      out.push(line.slice(1))
    } else {
      assert.equal(before[next], line.slice(1))
      if (line.startsWith(' ')) out.push(line.slice(1))
      next += 1
    }
  }
  return [...out, ...before.slice(next)]
}

test('outside git Claude is told where the chat changes are', async () => {
  await withDirs(async ({ cwd }) => {
    // Unless the test's own dir is in a git work tree.
    if (gitRoot(cwd) === null)
      assert.equal(
        sessionChangesHint(cwd),
        `The working directory is not in a git repository, so git diff shows no changes. To review or describe the changes this chat made to files, as a command that reads them from git diff would, call ${SESSION_CHANGES_TOOL}.`,
      )
    // In a git work tree, git has the changes.
    await mkdir(join(cwd, '.git'))
    assert.equal(sessionChangesHint(join(cwd, 'src')), null)
  })
})

// End to end: the mock runtime calls the codex_session tool for every
// `session changes <json>` line of a prompt. Mock sessions are
// `mock-<threadId>`, a turn's checkpoint is `<turnId>-entry`, and a turn
// resumed at a checkpoint runs in `<session>~<turnId>`.
test("the adapter gives Claude the changes of the thread's history", async () => {
  await withDirs(async ({ root, cwd, project }) => {
    await withInProcessApp(
      new MockRuntime(),
      async (app) => {
        const ask = async (threadId: string, text: string) => {
          const turnId = await app.startTurn(threadId, text)
          await app.turnCompleted(turnId)
          const items = app.store.getTurn(turnId)?.items ?? []
          const reply = items.findLast((item) => item.type === 'agentMessage')
          return { turnId, reply: reply?.type === 'agentMessage' ? reply.text : '' }
        }
        const threadId = await app.startThread({ cwd })
        const { turnId: first } = await ask(threadId, 'first')
        const { turnId: second } = await ask(threadId, 'second')
        // Each turn changed a file, this one c.txt, all before now.
        const start = Math.floor((Date.now() - BASE_TIME) / 1000) - 600
        for (const name of ['a', 'b', 'c'])
          await put(join(cwd, `${name}.txt`), `${name.toUpperCase()}\n`)
        await put(
          join(project, `mock-${threadId}.jsonl`),
          lines(
            edit('t1', join(cwd, 'a.txt'), ['a', 'A'], start, 'a\n'),
            entry(`${first}-entry`, start + 1),
            edit('t2', join(cwd, 'b.txt'), ['b', 'B'], start + 2, 'b\n'),
            entry(`${second}-entry`, start + 3),
            edit('t3', join(cwd, 'c.txt'), ['c', 'C'], start + 4, 'c\n'),
          ),
        )
        const listed = (since: string | undefined, ...names: string[]) =>
          [lead(since), '', ...names.map((name) => `M ${name} (+1 -1)`)].join('\n')
        assert.equal(
          (
            await ask(
              threadId,
              [
                'session changes {"stat":true}',
                'session changes {"stat":true,"turns":1}',
                'session changes {"stat":true,"turns":2}',
                'session changes {"stat":true,"turns":3}',
              ].join('\n'),
            )
          ).reply,
          [
            listed(undefined, 'a.txt', 'b.txt', 'c.txt'),
            listed(justAfter(start + 3), 'c.txt'),
            listed(justAfter(start + 1), 'b.txt', 'c.txt'),
            listed(undefined, 'a.txt', 'b.txt', 'c.txt'),
          ].join('\n\n'),
        )

        // Rolled back to the first turn, the thread resumes its session at the
        // first turn's checkpoint: what came after it is gone from its history.
        await app.request('thread/rollback', { threadId, numTurns: 2 })
        assert.equal(
          (await ask(threadId, 'session changes {"stat":true}')).reply,
          listed(undefined, 'a.txt'),
        )

        delete process.env.CLAUDE_CODEX_SESSION_CHANGES
        assert.equal(
          (await ask(threadId, 'session changes {}')).reply,
          'error: session changes are off',
        )
      },
      { env: { CLAUDE_CONFIG_DIR: root, CLAUDE_CODEX_SESSION_CHANGES: '1' } },
    )
  })
})
