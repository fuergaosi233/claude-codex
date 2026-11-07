import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexProxyRuntime } from '../src/codex-proxy-runtime.mjs'
import { parseExitCodeFromResult } from '../src/server-helpers.mjs'
import type { RuntimeEvent } from '../src/types.mjs'

async function mapped(type: string, item: Record<string, unknown>): Promise<RuntimeEvent> {
  const runtime = new CodexProxyRuntime()
  const events: RuntimeEvent[] = []
  const handleEvent = Reflect.get(runtime, 'handleEvent')
  await handleEvent.call(
    runtime,
    {
      context: { turnId: 'turn' },
      handlers: { onEvent: (event: RuntimeEvent) => events.push(event) },
    },
    { type, item: { id: 'item_1', ...item } },
  )
  assert.equal(events.length, 1)
  const event = events[0]
  assert.ok(event)
  return event
}

test('codex command failures preserve status and exit code', async () => {
  for (const [status, exitCode, isError] of [
    ['failed', 3, true],
    ['declined', null, true],
    ['completed', 127, true],
    ['completed', 0, false],
  ] as const) {
    const event = await mapped('item.completed', {
      type: 'command_execution',
      command: 'example',
      aggregated_output: 'command output',
      exit_code: exitCode,
      status,
    })
    assert.equal(event.type, 'tool_result')
    if (event.type !== 'tool_result') return
    assert.equal(event.toolUseId, 'item_1')
    assert.equal(event.isError, isError)
    assert.match(String(event.content), /command output/)
    if (exitCode !== null) assert.equal(parseExitCodeFromResult(event.content), exitCode)
  }
})

test('codex file changes use nested paths and propagate failed status', async () => {
  const changes = [{ path: 'src/example.mts', kind: 'update' }]
  const started = await mapped('item.started', { type: 'file_change', changes })
  assert.equal(started.type, 'tool_use')
  if (started.type !== 'tool_use') return
  assert.equal(started.toolName, 'Edit')
  assert.equal(started.input.file_path, 'src/example.mts')
  assert.deepEqual(started.input.changes, changes)

  const completed = await mapped('item.completed', {
    type: 'file_change',
    changes,
    status: 'failed',
  })
  assert.equal(completed.type, 'tool_result')
  if (completed.type !== 'tool_result') return
  assert.equal(completed.isError, true)
})

test('codex MCP calls preserve text content and error messages', async () => {
  const success = await mapped('item.completed', {
    type: 'mcp_tool_call',
    server: 'fixture',
    tool: 'lookup',
    arguments: {},
    result: {
      content: [
        { type: 'text', text: 'first result' },
        { type: 'image', data: 'ignored-image', mimeType: 'image/png' },
        { type: 'text', text: 'second result' },
      ],
      structured_content: { found: true },
    },
    error: null,
    status: 'completed',
  })
  assert.equal(success.type, 'tool_result')
  if (success.type !== 'tool_result') return
  assert.equal(success.isError, false)
  assert.equal(success.content, 'first result\nsecond result')

  const failure = await mapped('item.completed', {
    type: 'mcp_tool_call',
    server: 'fixture',
    tool: 'lookup',
    arguments: {},
    result: null,
    error: { message: 'upstream connection refused' },
    status: 'failed',
  })
  assert.equal(failure.type, 'tool_result')
  if (failure.type !== 'tool_result') return
  assert.equal(failure.isError, true)
  assert.equal(failure.content, 'upstream connection refused')
})
