import assert from 'node:assert/strict'
import test from 'node:test'
import { fileChangeFromTool } from '../src/server-helpers.mjs'

const header = '--- a/a.ts\n+++ b/a.ts\n@@\n'

test('Write diffs retain internal, leading and trailing blank lines', () => {
  for (const [content, body] of [
    ['a\n\nb\n\nc\n', '+a\n+\n+b\n+\n+c\n'],
    ['\na\n\n', '+\n+a\n+\n'],
    ['\n', '+\n'],
    ['a', '+a\n'],
    ['', ''],
  ]) {
    assert.equal(
      fileChangeFromTool('Write', { file_path: 'a.ts', content })[0]?.diff,
      header + body,
    )
  }
})

test('Edit diffs represent removed and added blank lines with bare markers', () => {
  for (const tool of ['Edit', 'MultiEdit']) {
    for (const [old_string, new_string, body] of [
      ['x\n\ny', 'x\ny', '-x\n-\n-y\n+x\n+y\n'],
      ['x\ny', 'x\n\ny', '-x\n-y\n+x\n+\n+y\n'],
      ['\n', '', '-\n'],
    ]) {
      const edit = { old_string, new_string }
      const input = { file_path: 'a.ts', ...(tool === 'MultiEdit' ? { edits: [edit] } : edit) }
      assert.equal(fileChangeFromTool(tool, input)[0]?.diff, header + body)
    }
  }
})
