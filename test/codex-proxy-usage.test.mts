import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexProxyRuntime } from '../src/codex-proxy-runtime.mjs'
import { tokenBreakdownFromClaudeUsage } from '../src/server-helpers.mjs'
import type { RuntimeEvent } from '../src/types.mjs'

async function forwardedUsage(usage: Record<string, unknown>) {
  const runtime = new CodexProxyRuntime()
  const events: RuntimeEvent[] = []
  let resolved = false
  await Reflect.get(runtime, 'handleEvent').call(
    runtime,
    {
      context: { turnId: 'turn' },
      handlers: {
        onEvent: (event: RuntimeEvent) => {
          events.push(event)
        },
      },
      resolve: () => {
        resolved = true
      },
      reject: (error: Error) => {
        throw error
      },
    },
    { type: 'turn.completed', usage },
  )
  assert.equal(resolved, true)
  const event = events.find((event) => event.type === 'usage')
  assert.ok(event?.type === 'usage')
  return event.usage
}

test('Codex cached input is counted once and reasoning remains a subset of output', async () => {
  const usage = await forwardedUsage({
    input_tokens: 10_000,
    cached_input_tokens: 8_000,
    output_tokens: 100,
    reasoning_output_tokens: 40,
  })
  assert.deepEqual(usage, {
    input_tokens: 2_000,
    cache_read_input_tokens: 8_000,
    output_tokens: 100,
    reasoning_output_tokens: 40,
  })
  assert.deepEqual(tokenBreakdownFromClaudeUsage(usage), {
    inputTokens: 2_000,
    cachedInputTokens: 8_000,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 10_100,
  })
})

test('Codex usage defaults missing counters and clamps noncached input at zero', async () => {
  const usage = await forwardedUsage({ input_tokens: 10, cached_input_tokens: 20 })
  assert.equal(usage.input_tokens, 0)
  assert.equal(usage.cache_read_input_tokens, 20)
  assert.equal(usage.output_tokens, 0)
  assert.equal(usage.reasoning_output_tokens, 0)
  const missing = await forwardedUsage({ input_tokens: '100', cached_input_tokens: '80' })
  assert.equal(missing.input_tokens, 0)
  assert.equal(missing.cache_read_input_tokens, 0)
})

test('Claude cache creation still counts as input and missing reasoning defaults to zero', () => {
  assert.deepEqual(
    tokenBreakdownFromClaudeUsage({
      input_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
      output_tokens: 10,
    }),
    {
      inputTokens: 50,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 100,
    },
  )
})
