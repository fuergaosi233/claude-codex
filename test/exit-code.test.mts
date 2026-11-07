import assert from 'node:assert/strict'
import test from 'node:test'
import { parseExitCodeFromResult } from '../src/server-helpers.mjs'

test('Bash exit codes are parsed only from a final trailer line', () => {
  for (const [content, expected] of [
    ['bash: command not found\nExit code 127', 127],
    ['ls: missing\nExit code: 2', 2],
    [[{ type: 'text', text: 'failed\nExit code 130' }], 130],
    [['failed\n', { type: 'text', text: 'Exit code -1\n' }], -1],
    ['EXIT STATUS: 101\r\n', 101],
    ['process did not exit successfully (exit status: 101)', null],
    ['Exit code 2\nmore output', null],
    ['log says Exit code: 2', null],
    ['Exit code nope', null],
    ['', null],
    [null, null],
  ] as const) {
    assert.equal(parseExitCodeFromResult(content), expected)
  }
})
