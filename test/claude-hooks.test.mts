import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  type ClaudeHookSpec,
  claudeHookMatchers,
  claudeHookSpecs,
  hookOutput,
} from '../src/claude-hooks.mjs'
import type { HookOutput, SdkHooks } from '../src/sdk-hooks.mjs'

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const settings = (hooks: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hooks, ...extra })

const command = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'command',
  command: text,
  ...extra,
})

const spec = (overrides: Partial<ClaudeHookSpec>): ClaudeHookSpec => ({
  event: 'PreToolUse',
  matcher: null,
  command: 'true',
  args: null,
  timeoutSec: 30,
  async: false,
  once: false,
  source: 'settings.json',
  ...overrides,
})

// Calls the only callback registered for an event.
async function call(
  hooks: SdkHooks,
  event: string,
  input: Record<string, unknown>,
): Promise<HookOutput> {
  const matcher = hooks[event]?.[0]
  const callback = matcher?.hooks[0]
  assert.ok(callback, `no ${event} hook`)
  return callback(input, undefined, { signal: new AbortController().signal })
}

const result = (code: number | null, stdout = '', stderr = '') => ({
  code,
  stdout,
  stderr,
  timedOut: false,
  error: null,
  durationMs: 1,
})

test('Claude Code hooks are read from the user settings, and a trusted project only on request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-hooks-specs-'))
  const configDir = join(root, 'claude-config')
  const repo = join(root, 'repo')
  try {
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(
      join(configDir, 'settings.json'),
      settings({
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              command('guard.sh', { timeout: 5 }),
              command('guard.sh', { timeout: 9 }),
              command('filtered.sh', { if: 'Bash(git *)' }),
              command('pwsh.ps1', { shell: 'powershell' }),
              { type: 'prompt', prompt: 'Is this safe?' },
            ],
          },
          { matcher: '*', hooks: [command('node', { args: ['log.mjs', '--all'], once: true })] },
        ],
        UserPromptSubmit: [{ hooks: [command('context.sh', { async: true })] }],
        Stop: [{ hooks: [command('rewake.sh', { asyncRewake: true })] }],
        PreCompact: [{ hooks: [command('compact.sh')] }],
      }),
    )
    await write(
      join(repo, '.claude', 'settings.json'),
      settings({ PostToolUse: [{ matcher: 'Edit', hooks: [command('format.sh')] }] }),
    )
    const read = (env: Record<string, string | undefined> = {}) =>
      withEnv(
        { CODEX_HOME: join(root, 'codex-home'), CLAUDE_CODEX_CLAUDE_HOOKS: undefined, ...env },
        () => claudeHookSpecs(repo, configDir),
      )
    const user = join(configDir, 'settings.json')
    const userSpecs = [
      spec({ matcher: 'Bash', command: 'guard.sh', timeoutSec: 5, source: user }),
      spec({
        command: 'node',
        args: ['log.mjs', '--all'],
        once: true,
        timeoutSec: 600,
        source: user,
      }),
      spec({
        event: 'UserPromptSubmit',
        command: 'context.sh',
        async: true,
        timeoutSec: 600,
        source: user,
      }),
      spec({ event: 'Stop', command: 'rewake.sh', async: true, timeoutSec: 600, source: user }),
    ]
    // No hooks unless asked for.
    for (const value of [undefined, '0', '1', 'true', 'all'])
      assert.deepEqual(await read({ CLAUDE_CODEX_CLAUDE_HOOKS: value }), [])
    assert.deepEqual(await read({ CLAUDE_CODEX_CLAUDE_HOOKS: 'user' }), userSpecs)
    // The project's hooks need both the opt-in and the project's trust.
    assert.deepEqual(await read({ CLAUDE_CODEX_CLAUDE_HOOKS: 'project' }), userSpecs)
    await write(
      join(configDir, '.claude.json'),
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    )
    assert.deepEqual(await read({ CLAUDE_CODEX_CLAUDE_HOOKS: 'user' }), userSpecs)
    assert.deepEqual(await read({ CLAUDE_CODEX_CLAUDE_HOOKS: 'project' }), [
      ...userSpecs,
      spec({
        event: 'PostToolUse',
        matcher: 'Edit',
        command: 'format.sh',
        timeoutSec: 600,
        source: join(repo, '.claude', 'settings.json'),
      }),
    ])
    assert.deepEqual(await read({ CLAUDE_CODEX_CLAUDE_HOOKS: '0' }), [])
    // disableAllHooks anywhere turns them all off.
    await write(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({ disableAllHooks: true }),
    )
    assert.deepEqual(await read({ CLAUDE_CODEX_CLAUDE_HOOKS: 'project' }), [])
    assert.equal((await read({ CLAUDE_CODEX_CLAUDE_HOOKS: 'user' })).length, 4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hook command gets the input on stdin and answers as Claude Code reads it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-run-')))
  const project = join(root, 'project')
  const work = join(project, 'sub')
  const seen = join(root, 'seen')
  try {
    await mkdir(work, { recursive: true })
    const hooks = claudeHookMatchers(
      [
        spec({
          matcher: 'Bash',
          timeoutSec: 7,
          command: `cat > '${seen}.json'; printf '%s\\n' "$CLAUDE_PROJECT_DIR" "$(pwd -P)" > '${seen}.env'; echo '{"systemMessage":"checked","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"},"async":true,"extra":1}'`,
        }),
        spec({ event: 'UserPromptSubmit', command: "echo 'Today is a holiday.'" }),
        spec({ event: 'Stop', command: "echo 'Run the tests first.' >&2; exit 2" }),
        spec({ event: 'Notification', command: "echo 'Notifier missing.' >&2; exit 2" }),
        spec({ event: 'PostToolUseFailure', command: "echo 'Retry with sudo.' >&2; exit 2" }),
        spec({ event: 'PostToolUse', command: "echo 'broken' >&2; exit 1" }),
        spec({
          event: 'SubagentStop',
          command: 'sh',
          args: ['-c', 'printf "%s" "$1" > "$2"', 'hook', '${CLAUDE_PROJECT_DIR}', `${seen}.args`],
        }),
      ],
      { projectDir: project, approvals: true },
    )
    assert.equal(hooks.PreToolUse?.[0]?.matcher, 'Bash')
    assert.equal(hooks.PreToolUse?.[0]?.timeout, 7)
    assert.equal(hooks.Stop?.[0]?.matcher, undefined)

    const input = { hook_event_name: 'PreToolUse', cwd: work, tool_name: 'Bash', tool_input: {} }
    assert.deepEqual(await call(hooks, 'PreToolUse', input), {
      systemMessage: 'checked',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    })
    assert.deepEqual(JSON.parse(await readFile(`${seen}.json`, 'utf8')), input)
    assert.equal(await readFile(`${seen}.env`, 'utf8'), `${project}\n${work}\n`)

    assert.deepEqual(await call(hooks, 'UserPromptSubmit', { prompt: 'Hi.' }), {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'Today is a holiday.',
      },
    })
    assert.deepEqual(await call(hooks, 'Stop', {}), {
      decision: 'block',
      reason: 'Run the tests first.',
    })
    assert.deepEqual(await call(hooks, 'Notification', {}), { systemMessage: 'Notifier missing.' })
    assert.deepEqual(await call(hooks, 'PostToolUseFailure', {}), {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: 'Retry with sudo.',
      },
    })
    // Any other exit is a non-blocking error.
    assert.deepEqual(await call(hooks, 'PostToolUse', {}), {})
    // Exec form: no shell, ${CLAUDE_PROJECT_DIR} filled in per argument.
    assert.deepEqual(await call(hooks, 'SubagentStop', {}), {})
    assert.equal(await readFile(`${seen}.args`, 'utf8'), project)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('exit code 2 blocks a tool call and plain output only feeds the events that take it', () => {
  assert.deepEqual(hookOutput('PreToolUse', result(2, '', 'No rm -rf.\n')), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'No rm -rf.',
    },
  })
  assert.deepEqual(hookOutput('PostToolUse', result(2)), {
    decision: 'block',
    reason: 'The PostToolUse hook exited with code 2.',
  })
  assert.deepEqual(hookOutput('PreToolUse', result(0, 'plain text')), {})
  assert.deepEqual(hookOutput('SessionStart', result(0, 'Branch: main\n')), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Branch: main' },
  })
  assert.deepEqual(hookOutput('SessionStart', result(0, '{not json')), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '{not json' },
  })
  // JSON output counts on exit 0 only.
  assert.deepEqual(hookOutput('Stop', result(1, '{"decision":"block","reason":"x"}')), {})
  assert.deepEqual(hookOutput('PreToolUse', { ...result(null), timedOut: true }), {})
  // Where only Codex approves, a hook's approval is dropped and its other
  // answers stay.
  const approving = result(
    0,
    JSON.stringify({
      decision: 'approve',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'trusted',
        additionalContext: 'note',
      },
    }),
  )
  assert.deepEqual(hookOutput('PreToolUse', approving, false), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'note' },
  })
  assert.equal(
    (hookOutput('PreToolUse', approving) as Record<string, any>).hookSpecificOutput
      .permissionDecision,
    'allow',
  )
  assert.deepEqual(
    hookOutput(
      'PreToolUse',
      result(
        0,
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
      ),
      false,
    ),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } },
  )
})

test('hooks time out, run in the background or once, as configured', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-modes-')))
  const count = join(root, 'count')
  const late = join(root, 'late')
  try {
    const hooks = claudeHookMatchers(
      [
        spec({ event: 'Stop', timeoutSec: 0.3, command: "sleep 5; echo 'too late' >&2; exit 2" }),
        spec({ event: 'SessionEnd', async: true, command: `sleep 0.2; echo done > '${late}'` }),
        spec({ event: 'SessionStart', once: true, command: `echo run >> '${count}'; echo ready` }),
      ],
      { projectDir: root, approvals: true },
    )
    const started = Date.now()
    assert.deepEqual(await call(hooks, 'Stop', {}), {})
    assert.ok(Date.now() - started < 3000, 'the timed-out hook was not stopped')

    assert.deepEqual(await call(hooks, 'SessionEnd', {}), {})
    await assert.rejects(readFile(late, 'utf8'))
    for (let i = 0; i < 50; i++) {
      if (
        await readFile(late, 'utf8').then(
          () => true,
          () => false,
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(await readFile(late, 'utf8'), 'done\n')

    const ready = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ready' },
    }
    assert.deepEqual(await call(hooks, 'SessionStart', {}), ready)
    assert.deepEqual(await call(hooks, 'SessionStart', {}), {})
    assert.equal(await readFile(count, 'utf8'), 'run\n')
    // A new session runs it again.
    const next = claudeHookMatchers(
      [spec({ event: 'SessionStart', once: true, command: `echo run >> '${count}'` })],
      {
        projectDir: root,
        approvals: true,
      },
    )
    await call(next, 'SessionStart', {})
    assert.equal(await readFile(count, 'utf8'), 'run\nrun\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hook the CLI gives up on is stopped', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-abort-')))
  try {
    const hooks = claudeHookMatchers([spec({ command: 'sleep 5' })], {
      projectDir: root,
      approvals: true,
    })
    const callback = hooks.PreToolUse?.[0]?.hooks[0]
    assert.ok(callback)
    const controller = new AbortController()
    const started = Date.now()
    const pending = callback({}, undefined, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    assert.deepEqual(await pending, {})
    assert.ok(Date.now() - started < 3000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
