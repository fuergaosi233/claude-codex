import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexProxyRuntime } from '../src/codex-proxy-runtime.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

test('Codex initial and resumed turns retain exec options and process cwd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-resume-'))
  const oldBinary = process.env.CODEX_REAL
  const runtime = new CodexProxyRuntime()
  try {
    const project = join(directory, 'project with spaces')
    const extra = join(directory, 'extra')
    await mkdir(project)
    await mkdir(extra)
    const log = join(directory, 'calls.jsonl')
    const binary = join(directory, 'codex-real.mjs')
    await writeFile(
      binary,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session-id' }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
    )
    await chmod(binary, 0o755)
    process.env.CODEX_REAL = binary
    const context: RuntimeTurnContext = {
      threadId: 'thread',
      turnId: 'turn',
      prompt: 'inspect this project',
      cwd: project,
      runtimeType: null,
      model: 'gpt-test',
      effort: null,
      claudeSessionId: null,
      forkSession: false,
      mcpServers: null,
      allowedTools: null,
      addDirs: [extra],
      enableFileCheckpointing: false,
      outputFormat: null,
      approvalPolicy: null,
      sandboxMode: 'workspace-write',
      systemPromptAddendum: null,
      planMode: false,
      imageInputs: [],
    }
    for (const sandboxMode of [
      'workspace-write',
      'read-only',
      'danger-full-access',
      null,
    ] as const) {
      const events: RuntimeEvent[] = []
      const handlers = {
        onEvent: (event: RuntimeEvent) => {
          events.push(event)
        },
        onPermissionRequest: async () => ({ decision: 'decline' as const }),
      }
      await runtime.runTurn({ ...context, sandboxMode }, handlers)
      const completed = events.find((event) => event.type === 'completed')
      assert.ok(completed?.type === 'completed')
      assert.equal(completed.claudeSessionId, 'session-id')
      await runtime.runTurn(
        { ...context, sandboxMode, turnId: 'turn-2', claudeSessionId: completed.claudeSessionId },
        handlers,
      )
      const calls = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .slice(-2)
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string })
      for (const [index, call] of calls.entries()) {
        assert.equal(call.cwd, await realpath(project))
        const shared = [
          'exec',
          '--json',
          '--skip-git-repo-check',
          ...(sandboxMode === 'workspace-write' || sandboxMode === 'read-only'
            ? ['-s', sandboxMode]
            : ['--dangerously-bypass-approvals-and-sandbox']),
          '-m',
          'gpt-test',
          '-C',
          project,
          '--add-dir',
          extra,
        ]
        assert.deepEqual(call.args, [
          ...shared,
          ...(index === 1 ? ['resume', 'session-id'] : []),
          context.prompt,
        ])
      }
    }
  } finally {
    await runtime.stop()
    if (oldBinary === undefined) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = oldBinary
    await rm(directory, { recursive: true, force: true })
  }
})
