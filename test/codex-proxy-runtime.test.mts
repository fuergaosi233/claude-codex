import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexProxyRuntime } from '../src/codex-proxy-runtime.mjs'
import type { RuntimeEvent, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

// A fake `codex` that records its argv (one per line) and its stdin, then
// prints the smallest JSONL turn the proxy accepts.
const FAKE_CODEX = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CODEX_DIR/argv"
cat > "$FAKE_CODEX_DIR/stdin"
echo '{"type":"thread.started","thread_id":"fake-session"}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"ok"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`

async function runFakeTurn(
  prompt: string,
  claudeSessionId: string | null,
): Promise<{ argv: string[]; stdin: string; events: RuntimeEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proxy-test-'))
  const binary = join(dir, 'codex')
  writeFileSync(binary, FAKE_CODEX)
  chmodSync(binary, 0o755)
  const saved = { real: process.env.CODEX_REAL, dir: process.env.FAKE_CODEX_DIR }
  process.env.CODEX_REAL = binary
  process.env.FAKE_CODEX_DIR = dir
  const events: RuntimeEvent[] = []
  try {
    const context = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      prompt,
      cwd: dir,
      runtimeType: null,
      model: 'gpt-test',
      effort: null,
      claudeSessionId,
      forkSession: false,
      mcpServers: null,
      allowedTools: null,
    } as unknown as RuntimeTurnContext
    const handlers: RuntimeHandlers = {
      onEvent: (event) => {
        events.push(event)
      },
      onPermissionRequest: async () => {
        throw new Error('codex-proxy never asks for permission')
      },
    }
    await new CodexProxyRuntime().runTurn(context, handlers)
    const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n').slice(0, -1)
    return { argv, stdin: readFileSync(join(dir, 'stdin'), 'utf8'), events }
  } finally {
    if (saved.real === undefined) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = saved.real
    if (saved.dir === undefined) delete process.env.FAKE_CODEX_DIR
    else process.env.FAKE_CODEX_DIR = saved.dir
    rmSync(dir, { recursive: true, force: true })
  }
}

const DASH_PROMPT = '--explain this flag'
// Over Linux's 128 KiB limit for one argv string (MAX_ARG_STRLEN).
const LONG_PROMPT = 'x'.repeat(200_000)

for (const [label, sessionId] of [
  ['fresh', null],
  ['resume', 'prior-session'],
] as const) {
  for (const [kind, prompt] of [
    ['a prompt starting with --', DASH_PROMPT],
    ['a prompt over 200 KB', LONG_PROMPT],
  ] as const) {
    test(`codex-proxy ${label} turn passes ${kind} on stdin`, async () => {
      const { argv, stdin, events } = await runFakeTurn(prompt, sessionId)
      assert.equal(argv.at(-1), '-')
      assert.ok(!argv.includes(prompt), 'the prompt must not be an argv entry')
      if (sessionId) assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', sessionId])
      else assert.equal(argv[0], 'exec')
      assert.equal(stdin, prompt)
      const completed = events.find((event) => event.type === 'completed')
      assert.ok(completed && completed.type === 'completed' && completed.success)
    })
  }
}
