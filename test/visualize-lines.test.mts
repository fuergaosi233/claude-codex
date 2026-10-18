import assert from 'node:assert/strict'
import test from 'node:test'
import { markVisualizeLines } from '../src/visualize-lines.mjs'

const json = '{"path":"/tmp/chart.html","mode":"wide"}'
const marked = (indent = ''): string => `${indent}\uE200visualize\uE202${json}\uE201`

test('a plain visualize line gets the marks, keeping up to three spaces of indent', () => {
  assert.equal(markVisualizeLines(`visualize${json}`), marked())
  assert.equal(
    markVisualizeLines(`Here is the chart.\n\nvisualize${json}\n\nDone.`),
    `Here is the chart.\n\n${marked()}\n\nDone.`,
  )
  assert.equal(markVisualizeLines(`   visualize${json}`), marked('   '))
  assert.equal(markVisualizeLines(`visualize${json} \t`), marked())
  // Four spaces make an indented code block.
  assert.equal(markVisualizeLines(`    visualize${json}`), `    visualize${json}`)
})

test('every visualize line of a message gets the marks', () => {
  const other = '{"path":"/tmp/table.html"}'
  assert.equal(
    markVisualizeLines(`visualize${json}\ntext\n visualize${other}`),
    `${marked()}\ntext\n \uE200visualize\uE202${other}\uE201`,
  )
})

test('a line already marked stays as it is', () => {
  const text = `Chart:\n${marked()}\n`
  assert.equal(markVisualizeLines(text), text)
})

test('lines inside code fences stay as they are', () => {
  for (const fence of ['```', '~~~', '````md']) {
    const text = `${fence}\nvisualize${json}\n${fence.replace('md', '')}`
    assert.equal(markVisualizeLines(text), text)
  }
  // Only a fence of the same character, at least as long, closes one.
  const open = `\`\`\`\`\nvisualize${json}\n\`\`\`\n~~~~\nvisualize${json}`
  assert.equal(markVisualizeLines(open), open)
  assert.equal(
    markVisualizeLines(`  ~~~\nvisualize${json}\n~~~~~ \nvisualize${json}`),
    `  ~~~\nvisualize${json}\n~~~~~ \n${marked()}`,
  )
})

test('a line whose JSON names no path stays as it is', () => {
  for (const body of [
    '{"path":',
    '{"path":"/tmp/a.html",}',
    '{"mode":"wide"}',
    '{"path":""}',
    '{"path":42}',
    '{"path":null}',
  ]) {
    const text = `visualize${body}`
    assert.equal(markVisualizeLines(text), text)
  }
})

test('a visualize mention inside a sentence stays as it is', () => {
  for (const text of [
    `Use visualize${json} to show it.`,
    `Run \`visualize${json}\``,
    `- visualize${json}`,
    `visualize ${json}`,
  ])
    assert.equal(markVisualizeLines(text), text)
})

test('CRLF line endings are kept', () => {
  assert.equal(
    markVisualizeLines(`Chart:\r\nvisualize${json}\r\n\`\`\`\r\nvisualize${json}\r\n\`\`\`\r\n`),
    `Chart:\r\n${marked()}\r\n\`\`\`\r\nvisualize${json}\r\n\`\`\`\r\n`,
  )
})

test('text without a plain visualize line comes back unchanged', () => {
  for (const text of ['', 'plain reply', 'visualize it\r\nlater', `${marked()}\n`])
    assert.equal(markVisualizeLines(text), text)
})
