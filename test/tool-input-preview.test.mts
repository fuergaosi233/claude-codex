import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parsePartialJson,
  TOOL_INPUT_PREVIEW_INTERVAL_MS,
  ToolInputPreviews,
} from '../src/tool-input-preview.mjs'

const samples = [
  {
    file_path: '/tmp/notes.md',
    content: '# Notes\n\n"quoted" \\ back\tslash é 😀   end\n',
  },
  {
    file_path: '/tmp/app.ts',
    edits: [
      { old_string: 'let a = 1', new_string: 'const a = 1' },
      { old_string: 'x', new_string: 'y', replace_all: true },
    ],
  },
  {
    file_path: '/tmp/a.json',
    old_string: '',
    new_string: '{}',
    replace_all: false,
    count: -12.5e3,
    none: null,
    nested: { list: [1, [2, 3], { deep: 'v' }], empty: {} },
  },
]

// Whether a value parsed from the start of a text is part of the whole.
function isPrefixOf(part: unknown, whole: unknown): boolean {
  if (typeof part === 'string') return typeof whole === 'string' && whole.startsWith(part)
  if (Array.isArray(part)) {
    return (
      Array.isArray(whole) &&
      part.length <= whole.length &&
      part.every((value, index) => isPrefixOf(value, whole[index]))
    )
  }
  if (part && typeof part === 'object') {
    if (!whole || typeof whole !== 'object' || Array.isArray(whole)) return false
    return Object.entries(part).every(
      ([key, value]) => Object.hasOwn(whole, key) && isPrefixOf(value, Reflect.get(whole, key)),
    )
  }
  return part === whole
}

test('a complete JSON text parses like JSON.parse', () => {
  for (const sample of samples) {
    for (const text of [JSON.stringify(sample), JSON.stringify(sample, null, 2)]) {
      assert.deepEqual(parsePartialJson(text), { value: sample, openString: null })
    }
  }
  assert.deepEqual(parsePartialJson('"\\u00e9\\/"').value, 'é/')
  assert.deepEqual(parsePartialJson('[true, false, null, 0]').value, [true, false, null, 0])
})

test('every start of a JSON text parses to a growing part of the whole', () => {
  for (const sample of samples) {
    for (const text of [JSON.stringify(sample), JSON.stringify(sample, null, 2)]) {
      let previous: unknown
      for (let end = 0; end <= text.length; end += 1) {
        const { value } = parsePartialJson(text.slice(0, end))
        if (value === undefined) {
          assert.equal(previous, undefined, `value lost at ${end}`)
          continue
        }
        assert.ok(isPrefixOf(value, sample), `not part of the whole at ${end}`)
        if (previous !== undefined) assert.ok(isPrefixOf(previous, value), `shrank at ${end}`)
        previous = value
      }
    }
  }
})

test('a string cut inside an escape keeps the text before it', () => {
  const start = '{"file_path":"/tmp/a","content":"ab'
  assert.deepEqual(parsePartialJson(`${start}\\`).value, { file_path: '/tmp/a', content: 'ab' })
  assert.deepEqual(parsePartialJson(`${start}\\n`).value, { file_path: '/tmp/a', content: 'ab\n' })
  assert.deepEqual(parsePartialJson(`${start}\\u00`).value, { file_path: '/tmp/a', content: 'ab' })
  assert.deepEqual(parsePartialJson(`${start}\\u00e9`).value, {
    file_path: '/tmp/a',
    content: 'abé',
  })
  // Half of an escaped surrogate pair, and half of a raw one.
  assert.deepEqual(parsePartialJson(`${start}\\ud83d`).value, {
    file_path: '/tmp/a',
    content: 'ab',
  })
  assert.deepEqual(parsePartialJson(`${start}\\ud83d\\ude`).value, {
    file_path: '/tmp/a',
    content: 'ab',
  })
  assert.deepEqual(parsePartialJson(`${start}\\ud83d\\ude00`).value, {
    file_path: '/tmp/a',
    content: 'ab😀',
  })
  assert.deepEqual(parsePartialJson(`${start}\ud83d`).value, { file_path: '/tmp/a', content: 'ab' })
})

test('a member shows up once its value begins, a number or literal once it ends', () => {
  assert.deepEqual(parsePartialJson('{"file_path"').value, {})
  assert.deepEqual(parsePartialJson('{"file_path":').value, {})
  assert.deepEqual(parsePartialJson('{"file_path":"').value, { file_path: '' })
  assert.deepEqual(parsePartialJson('{"a":"x","conte').value, { a: 'x' })
  assert.deepEqual(parsePartialJson('{"count":12').value, {})
  assert.deepEqual(parsePartialJson('{"count":12 ').value, { count: 12 })
  assert.deepEqual(parsePartialJson('{"count":12,').value, { count: 12 })
  assert.deepEqual(parsePartialJson('{"replace_all":tru').value, {})
  assert.deepEqual(parsePartialJson('{"replace_all":true}').value, { replace_all: true })
  assert.deepEqual(parsePartialJson('{"edits":[{"old_string":"x"},{').value, {
    edits: [{ old_string: 'x' }, {}],
  })
  assert.deepEqual(parsePartialJson(''), { value: undefined, openString: null })
  assert.deepEqual(parsePartialJson('  '), { value: undefined, openString: null })
})

test('the parse names the string the text breaks off in', () => {
  assert.deepEqual(parsePartialJson('{"file_path":"/tmp/no').openString, ['file_path'])
  assert.deepEqual(parsePartialJson('{"file_path":"/tmp/notes.md"').openString, null)
  assert.deepEqual(parsePartialJson('{"edits":[{"old_string":"x').openString, [
    'edits',
    0,
    'old_string',
  ])
  // An unfinished key is not a value.
  assert.deepEqual(parsePartialJson('{"file_path":"/tmp/a","con').openString, null)
})

test('malformed text ends the parse without throwing', () => {
  assert.deepEqual(parsePartialJson('{"a":"x",]').value, { a: 'x' })
  assert.deepEqual(parsePartialJson('{"a" "b"}').value, {})
  assert.deepEqual(parsePartialJson('{"a":nope,"b":"c"}').value, {})
  assert.deepEqual(parsePartialJson('{"a":"\\q tail"}').value, { a: '' })
  assert.deepEqual(parsePartialJson('{"a":"\\uzzzz"}').value, { a: '' })
  assert.deepEqual(parsePartialJson('[1,2').value, [1])
})

test('a __proto__ member is an own property, as JSON.parse makes it', () => {
  const { value } = parsePartialJson('{"__proto__":{"polluted":true},"file_path":"/tmp/a"}')
  const parsed = value as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
  assert.ok(Object.hasOwn(parsed, '__proto__'))
  assert.equal(Reflect.get({}, 'polluted'), undefined)
  assert.deepEqual(parsed, JSON.parse('{"__proto__":{"polluted":true},"file_path":"/tmp/a"}'))
})

function clock(): { now: () => number; set: (ms: number) => void } {
  let time = 1_000
  return { now: () => time, set: (ms) => (time = 1_000 + ms) }
}

test('file tool input is reported once it names the file, then at most once per interval', () => {
  const time = clock()
  const previews = new ToolInputPreviews(time.now)
  previews.start(1, 'write-1', 'Write')
  assert.equal(previews.push(1, '{"file_path": "/tmp/no'), null)
  // The path is complete: reported at once.
  assert.deepEqual(previews.push(1, 'tes.md", "content": "# N'), {
    toolUseId: 'write-1',
    toolName: 'Write',
    input: { file_path: '/tmp/notes.md', content: '# N' },
  })
  time.set(100)
  assert.equal(previews.push(1, 'otes\\n'), null)
  time.set(TOOL_INPUT_PREVIEW_INTERVAL_MS - 1)
  assert.equal(previews.push(1, 'First'), null)
  time.set(TOOL_INPUT_PREVIEW_INTERVAL_MS)
  assert.deepEqual(previews.push(1, ' line\\u00')?.input, {
    file_path: '/tmp/notes.md',
    content: '# Notes\nFirst line',
  })
  // Nothing new to show: the cut escape is still incomplete.
  time.set(2 * TOOL_INPUT_PREVIEW_INTERVAL_MS)
  assert.equal(previews.push(1, 'e'), null)
  assert.deepEqual(previews.push(1, '9"}')?.input, {
    file_path: '/tmp/notes.md',
    content: '# Notes\nFirst lineé',
  })
  previews.stop(1)
  time.set(3 * TOOL_INPUT_PREVIEW_INTERVAL_MS)
  assert.equal(previews.push(1, ' '), null)
})

test('only file tool calls are followed, each by its block', () => {
  const time = clock()
  const previews = new ToolInputPreviews(time.now)
  previews.start(0, 'bash-1', 'Bash')
  assert.equal(previews.push(0, '{"command": "ls", "file_path": "/tmp/a"}'), null)
  previews.start(1, 'edit-1', 'Edit')
  previews.start(2, 'multi-1', 'MultiEdit')
  previews.start(3, '', 'Write')
  assert.equal(previews.push(3, '{"file_path":"/tmp/c"}'), null)
  assert.deepEqual(previews.push(1, '{"file_path":"/tmp/a","old_string":"x'), {
    toolUseId: 'edit-1',
    toolName: 'Edit',
    input: { file_path: '/tmp/a', old_string: 'x' },
  })
  assert.deepEqual(previews.push(2, '{"file_path":"/tmp/b","edits":[{"old_string":"y"'), {
    toolUseId: 'multi-1',
    toolName: 'MultiEdit',
    input: { file_path: '/tmp/b', edits: [{ old_string: 'y' }] },
  })
  assert.equal(previews.push(1, '"'), null)
  // A new model response numbers its blocks from zero again.
  previews.clear()
  time.set(TOOL_INPUT_PREVIEW_INTERVAL_MS)
  assert.equal(previews.push(2, '}]}'), null)
  assert.equal(previews.push(1, ',"new_string":"z"}'), null)
})

test('an empty or non-object input names no file', () => {
  const previews = new ToolInputPreviews(() => 0)
  previews.start(0, 'write-1', 'Write')
  assert.equal(previews.push(0, ''), null)
  assert.equal(previews.push(0, '{"file_path":""'), null)
  previews.start(1, 'write-2', 'Write')
  assert.equal(previews.push(1, '["/tmp/a"]'), null)
  previews.start(2, 'write-3', 'Write')
  assert.equal(previews.push(2, '{"file_path":42,"content":"x"}'), null)
})
