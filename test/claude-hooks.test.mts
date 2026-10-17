import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  type ClaudeHookSpec,
  claudeHookSession,
  claudeHookSpecs,
  hookOutput,
  runHookCommand,
  sessionEndBudgetSec,
} from '../src/claude-hooks.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { HookOutput, SdkHooks } from '../src/sdk-hooks.mjs'
import type { RuntimeEvent, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

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
  shell: 'sh',
  timeoutSec: 30,
  async: false,
  if: null,
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

// Waits for a file a hook writes, for up to `ms`.
async function appears(path: string, ms = 10_000): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
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
        UserPromptSubmit: [{ hooks: [command('context.sh', { async: true, if: ' ' })] }],
        Stop: [
          {
            hooks: [
              command('rewake.sh', { asyncRewake: true, shell: 'bash' }),
              command('never.sh', { if: 'Bash(git *)' }),
            ],
          },
        ],
        SessionEnd: [{ hooks: [command('cleanup.sh'), command('upload.sh', { timeout: 120 })] }],
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
        matcher: 'Bash',
        command: 'filtered.sh',
        if: 'Bash(git *)',
        timeoutSec: 600,
        source: user,
      }),
      // `once` means nothing in a settings file, as in Claude Code.
      spec({ command: 'node', args: ['log.mjs', '--all'], timeoutSec: 600, source: user }),
      // Claude Code's defaults: 30 seconds for a prompt, a second and a half
      // for the end of a session unless the hook says otherwise. A blank
      // `if` is none; one on an event that is not about a tool never runs.
      spec({
        event: 'UserPromptSubmit',
        command: 'context.sh',
        async: true,
        timeoutSec: 30,
        source: user,
      }),
      spec({
        event: 'Stop',
        command: 'rewake.sh',
        shell: 'bash',
        async: true,
        timeoutSec: 600,
        source: user,
      }),
      spec({ event: 'SessionEnd', command: 'cleanup.sh', timeoutSec: 1.5, source: user }),
      spec({ event: 'SessionEnd', command: 'upload.sh', timeoutSec: 120, source: user }),
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
    assert.equal((await read({ CLAUDE_CODEX_CLAUDE_HOOKS: 'user' })).length, 7)
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
    const { hooks } = claudeHookSession(
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
    // Notification hooks cannot block, and exit 2 means nothing for them.
    assert.deepEqual(await call(hooks, 'Notification', {}), {})
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
  // Even when the shell outlived the kill and printed something.
  assert.deepEqual(hookOutput('SessionStart', { ...result(0, 'late'), timedOut: true }), {})
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

test('hooks time out or run in the background, as configured', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-modes-')))
  const late = join(root, 'late')
  try {
    const session = claudeHookSession(
      [
        // Only the timeout ends the loop; were it to end otherwise, the hook
        // would block.
        spec({
          event: 'Stop',
          timeoutSec: 0.5,
          command: "while :; do sleep 1; done; echo 'too late' >&2; exit 2",
        }),
        spec({ event: 'SessionEnd', async: true, command: `sleep 0.2; echo done > '${late}'` }),
      ],
      { projectDir: root, approvals: true },
    )
    const { hooks } = session
    const started = Date.now()
    assert.deepEqual(await call(hooks, 'Stop', {}), {})
    assert.ok(Date.now() - started < 10_000, 'the timed-out hook was not stopped')

    await call(hooks, 'UserPromptSubmit', { session_id: 'session' })
    await session.end?.('other')
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hook is done when its own process exits, and what it started keeps running', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-exit-')))
  const go = join(root, 'go')
  const alive = join(root, 'alive')
  try {
    const { hooks } = claudeHookSession(
      [
        // The background process holds the hook's output open until told to
        // go on, and then proves it was not killed, not even by writing to
        // that output after the hook is done.
        spec({
          event: 'Stop',
          command: `(i=0; while [ ! -f '${go}' ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; echo more; echo more >&2; echo alive > '${alive}') & echo '{"systemMessage":"started"}'`,
        }),
        spec({ event: 'SessionStart', command: 'echo "$0"' }),
        spec({ event: 'UserPromptSubmit', shell: 'bash', command: 'echo "$0"' }),
      ],
      { projectDir: root, approvals: true },
    )
    assert.deepEqual(await call(hooks, 'Stop', {}), { systemMessage: 'started' })
    await assert.rejects(access(alive))
    await writeFile(go, '')
    assert.equal(await appears(alive), true, 'the background process was killed')

    // sh runs a command line, bash when the hook asks for it.
    assert.deepEqual(await call(hooks, 'SessionStart', {}), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '/bin/sh' },
    })
    assert.deepEqual(await call(hooks, 'UserPromptSubmit', {}), {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'bash' },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hook the CLI gives up on is stopped', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-abort-')))
  try {
    const { hooks } = claudeHookSession([spec({ command: 'sleep 5' })], {
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

test("a killed hook's process group is killed once more after its shell is gone", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-group-')))
  // A child the shell forks as the kill comes in cannot be made to miss it
  // on purpose, so this records the group kills: whether the shell was
  // still there (running, or not yet reaped) at each.
  const kill = process.kill
  const groupKills: boolean[] = []
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0 && signal === 'SIGKILL') {
      let shellGone = false
      try {
        kill.call(process, -pid, 0)
      } catch {
        shellGone = true
      }
      groupKills.push(shellGone)
    }
    return kill.call(process, pid, signal)
  }) as typeof process.kill
  try {
    for (const how of ['timeout', 'abort', 'exit']) {
      groupKills.length = 0
      const controller = new AbortController()
      const pending = runHookCommand(
        spec({
          command: how === 'exit' ? 'true' : 'sleep 20',
          timeoutSec: how === 'timeout' ? 0.2 : 30,
        }),
        {},
        root,
        controller.signal,
      )
      if (how === 'abort') setTimeout(() => controller.abort(), 100)
      const result = await pending
      assert.equal(result.timedOut, how === 'timeout', how)
      if (how === 'exit') {
        // A hook that ends by itself leaves what it started alone.
        assert.deepEqual(groupKills, [], how)
        continue
      }
      assert.equal(groupKills[0], false, `${how}: the first kill finds the shell`)
      assert.equal(groupKills.at(-1), true, `${how}: the group goes again once the shell is gone`)
    }
  } finally {
    process.kill = kill
    await rm(root, { recursive: true, force: true })
  }
})

test("a hook's if is matched as an ask rule is, against the tool call", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-if-')))
  const log = join(root, 'log')
  try {
    const { hooks } = claudeHookSession(
      [
        spec({ if: 'Bash(git push:*)', command: `echo push >> '${log}'` }),
        spec({ event: 'PostToolUse', if: 'Edit(src/**)', command: `echo edit >> '${log}'` }),
      ],
      { projectDir: root, approvals: true },
    )
    const ran = () =>
      readFile(log, 'utf8').then(
        (text) => text.trim().split('\n'),
        () => [],
      )
    const bash = (command: string) =>
      call(hooks, 'PreToolUse', { cwd: root, tool_name: 'Bash', tool_input: { command } })
    await bash('git status')
    await bash('git pull')
    await call(hooks, 'PreToolUse', { cwd: root, tool_name: 'Read', tool_input: {} })
    assert.deepEqual(await ran(), [])
    await bash('npm test && git push origin main')
    // A command line it cannot take apart runs the hook, as it asks.
    await bash('git push origin "$(git branch --show-current)"')
    assert.deepEqual(await ran(), ['push', 'push'])

    const edit = (file: string) =>
      call(hooks, 'PostToolUse', { cwd: root, tool_name: 'Edit', tool_input: { file_path: file } })
    await edit(join(root, 'test', 'a.ts'))
    await edit(join(root, 'src', 'deep', 'a.ts'))
    assert.deepEqual(await ran(), ['push', 'push', 'edit'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the SessionEnd hooks of a session share one budget', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-end-budget-')))
  const sessionEnd = (timeoutSec: number) => spec({ event: 'SessionEnd', timeoutSec })
  const budget = (specs: ClaudeHookSpec[], override?: string) =>
    withEnv({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: override }, () => sessionEndBudgetSec(specs))
  try {
    // The longest timeout, from a second and a half up to a minute, or what
    // CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS says.
    assert.equal(await budget([]), 1.5)
    assert.equal(await budget([sessionEnd(1.5), sessionEnd(1)]), 1.5)
    assert.equal(await budget([sessionEnd(10), sessionEnd(1.5), spec({ timeoutSec: 600 })]), 10)
    assert.equal(await budget([sessionEnd(120), sessionEnd(30)]), 60)
    assert.equal(await budget([sessionEnd(120)], '400'), 0.4)
    assert.equal(await budget([sessionEnd(10)], 'soon'), 10)

    // Each hook may wait half a minute, but not all together past the
    // budget.
    const session = claudeHookSession(
      [
        spec({ event: 'SessionEnd', timeoutSec: 30, command: 'sleep 20' }),
        spec({ event: 'SessionEnd', timeoutSec: 30, command: 'sleep 20' }),
      ],
      { projectDir: root, approvals: true },
    )
    await call(session.hooks, 'UserPromptSubmit', { session_id: 'session' })
    const started = Date.now()
    await withEnv({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '400' }, () => session.end?.('other'))
    assert.ok(Date.now() - started < 5000, 'the SessionEnd hooks outlived their budget')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// What a UserPromptSubmit hook gets for a session's prompt.
const prompt = (cwd: string) => ({
  session_id: 'session-1',
  transcript_path: '/transcripts/session-1.jsonl',
  cwd,
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'Hi.',
})

test('SessionStart hooks run with the first prompt and SessionEnd hooks when the session is over', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-session-')))
  const at = (name: string) => join(root, name)
  try {
    const session = claudeHookSession(
      [
        spec({
          event: 'SessionStart',
          matcher: 'startup|resume',
          command: `cat > '${at('start.json')}'; echo 'Branch: main'`,
        }),
        spec({
          event: 'SessionStart',
          matcher: 'compact',
          command: `echo compact >> '${at('compact')}'; echo 'Compacted.'`,
        }),
        spec({
          event: 'SessionStart',
          command: `echo '{"systemMessage":"Welcome back.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Read TODO.md."}}'`,
        }),
        spec({
          event: 'SessionStart',
          async: true,
          command: `sleep 0.2; echo late > '${at('late')}'`,
        }),
        spec({
          event: 'SessionStart',
          matcher: 'startup',
          command: "echo 'Index stale.' >&2; exit 2",
        }),
        spec({ event: 'UserPromptSubmit', command: "echo 'Today is a holiday.'" }),
        spec({ event: 'SessionEnd', command: `cat > '${at('end.json')}'` }),
        spec({ event: 'SessionEnd', matcher: 'clear', command: `touch '${at('clear')}'` }),
      ],
      { projectDir: root, approvals: true, origin: 'startup', model: 'claude-test' },
    )
    const { hooks, end } = session
    assert.ok(end)
    // The first prompt's hook comes before the user's own; SessionEnd is no
    // callback, since the CLI could not reach it.
    assert.equal(hooks.UserPromptSubmit?.length, 2)
    assert.equal(hooks.SessionStart?.length, 5)
    assert.equal(hooks.SessionEnd, undefined)
    // A session that never took a prompt has nothing to end.
    await end('other')
    await assert.rejects(access(at('end.json')))
    // Should the CLI call them for how the session began, the adapter has
    // that covered.
    assert.deepEqual(await call(hooks, 'SessionStart', { source: 'startup' }), {})
    await assert.rejects(access(at('start.json')))

    const first = await call(hooks, 'UserPromptSubmit', prompt(root))
    assert.deepEqual(first, {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'Branch: main\n\nRead TODO.md.',
      },
      systemMessage: 'Welcome back.\nIndex stale.',
    })
    assert.deepEqual(JSON.parse(await readFile(at('start.json'), 'utf8')), {
      session_id: 'session-1',
      transcript_path: '/transcripts/session-1.jsonl',
      cwd: root,
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-test',
    })
    assert.equal(await appears(at('late')), true, 'the async SessionStart hook did not run')
    // Once per session.
    await rm(at('start.json'))
    assert.deepEqual(await call(hooks, 'UserPromptSubmit', prompt(root)), {})
    await assert.rejects(access(at('start.json')))
    // The CLI still calls them for compact, matching them itself.
    const compact = hooks.SessionStart?.[1]?.hooks[0]
    assert.equal(hooks.SessionStart?.[1]?.matcher, 'compact')
    assert.ok(compact)
    const signal = new AbortController().signal
    assert.deepEqual(await compact({ source: 'compact' }, undefined, { signal }), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Compacted.' },
    })

    await end('other')
    assert.deepEqual(JSON.parse(await readFile(at('end.json'), 'utf8')), {
      session_id: 'session-1',
      transcript_path: '/transcripts/session-1.jsonl',
      cwd: root,
      permission_mode: 'default',
      hook_event_name: 'SessionEnd',
      reason: 'other',
    })
    await assert.rejects(access(at('clear')))
    await rm(at('end.json'))
    await end('other')
    await assert.rejects(access(at('end.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SessionStart hooks match how the session began and keep to their timeout', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-origin-')))
  try {
    const specs = [
      spec({ event: 'SessionStart', matcher: 'startup', command: 'echo started' }),
      spec({ event: 'SessionStart', matcher: 'resume', command: 'echo resumed' }),
      spec({ event: 'SessionStart', matcher: '^(resume|fork)$', command: 'echo continued' }),
      spec({ event: 'SessionStart', matcher: 'clear|compact', command: 'echo cleared' }),
    ]
    const context = async (origin?: 'startup' | 'resume' | 'fork') => {
      const { hooks } = claudeHookSession(specs, {
        projectDir: root,
        approvals: true,
        ...(origin ? { origin } : {}),
      })
      if (!hooks.UserPromptSubmit) return null
      const output = await call(hooks, 'UserPromptSubmit', prompt(root))
      return (output.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext
    }
    assert.equal(await context('startup'), 'started')
    assert.equal(await context('resume'), 'resumed\n\ncontinued')
    assert.equal(await context('fork'), 'continued')
    // Without a beginning, only the CLI calls them.
    assert.equal(await context(), null)

    const { hooks } = claudeHookSession(
      [
        spec({ event: 'SessionStart', timeoutSec: 0.5, command: 'sleep 5; echo never' }),
        spec({ event: 'SessionStart', timeoutSec: 40, async: true, command: 'true' }),
      ],
      { projectDir: root, approvals: true, origin: 'startup' },
    )
    // Room for the slowest hook that is waited for.
    assert.equal(hooks.UserPromptSubmit?.[0]?.timeout, 31)
    const started = Date.now()
    assert.deepEqual(await call(hooks, 'UserPromptSubmit', prompt(root)), {})
    assert.ok(Date.now() - started < 4000, 'the SessionStart hook outlived its timeout')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// A Claude session the runtime opens: it keeps the SDK options and yields what
// the test pushes until closed.
class FakeSession implements AsyncIterable<Record<string, unknown>> {
  closed = false
  private queue: Record<string, unknown>[] = []
  private wake: (() => void) | null = null

  readonly options: Record<string, unknown>

  constructor(options: Record<string, unknown>, prompt: AsyncIterable<unknown>) {
    this.options = options
    void (async () => {
      for await (const _ of prompt);
    })()
  }

  push(message: Record<string, unknown>): void {
    this.queue.push(message)
    this.notify()
  }

  async interrupt(): Promise<void> {}

  async setModel(): Promise<void> {}

  async setPermissionMode(): Promise<void> {}

  close(): void {
    this.closed = true
    this.notify()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

test('the runtime runs SessionStart for how the CLI session begins and SessionEnd once it ends', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-runtime-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const log = join(root, 'log')
  try {
    await mkdir(project, { recursive: true })
    // A transcript to resume, in a home of the test's own.
    const slug = project.replace(/[^a-zA-Z0-9-]/g, '-')
    await write(join(home, '.claude', 'projects', slug, 'session-1.jsonl'), '{}\n')
    const runtime = new NativeClaudeRuntime()
    const sessions: FakeSession[] = []
    Reflect.set(runtime, 'sdk', {
      query: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
        const session = new FakeSession(args.options, args.prompt)
        sessions.push(session)
        return session
      },
    })
    const handlers: RuntimeHandlers = {
      onEvent: async (_event: RuntimeEvent) => {},
      onPermissionRequest: async () => ({ decision: 'accept' }),
      onUserInputRequest: async () => ({ answers: {} }),
    }
    const context: RuntimeTurnContext = {
      threadId: 'thread',
      turnId: 'turn-1',
      prompt: 'Hi.',
      cwd: project,
      runtimeType: null,
      model: null,
      effort: null,
      claudeSessionId: null,
      forkSession: false,
      mcpServers: null,
      allowedTools: null,
      addDirs: [],
      enableFileCheckpointing: false,
      outputFormat: null,
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      systemPromptAddendum: null,
      planMode: false,
      imageInputs: [],
      claudeHooks: [
        spec({ event: 'SessionStart', command: `printf '%s\\n' "$(cat)" >> '${log}'` }),
        spec({ event: 'SessionEnd', command: `printf '%s\\n' "$(cat)" >> '${log}'` }),
      ],
    }
    const turn = async (index: number, overrides: Partial<RuntimeTurnContext>) => {
      const done = runtime.runTurn({ ...context, turnId: `turn-${index}`, ...overrides }, handlers)
      for (let i = 0; i < 400 && !sessions[index]; i++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      const session = sessions[index]
      assert.ok(session, 'no session opened')
      const hooks = session.options.hooks as SdkHooks
      await call(hooks, 'UserPromptSubmit', prompt(project))
      session.push({ type: 'result', subtype: 'success', result: 'Hello.' })
      await done
      return session
    }
    const lines = async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .map((input) => [input.hook_event_name, input.source ?? input.reason])
    const settled = async (count: number) => {
      for (let i = 0; i < 400 && (await lines().catch(() => [])).length < count; i++)
        await new Promise((resolve) => setTimeout(resolve, 25))
      return lines()
    }
    await withEnv(
      {
        HOME: home,
        CLAUDE_CONFIG_DIR: undefined,
        CLAUDE_CONFIG_DIRS: undefined,
        CLAUDE_ROUTER_DIR: undefined,
      },
      async () => {
        const first = await turn(0, {})
        // Nothing reuses it, so it closes once its turn is done.
        for (let i = 0; i < 400 && !first.closed; i++)
          await new Promise((resolve) => setTimeout(resolve, 5))
        assert.equal(first.closed, true)
        assert.deepEqual(await settled(2), [
          ['SessionStart', 'startup'],
          ['SessionEnd', 'other'],
        ])
        const resumed = await turn(1, { claudeSessionId: 'session-1' })
        assert.equal(resumed.options.resume, 'session-1')
        assert.deepEqual((await settled(4)).slice(2), [
          ['SessionStart', 'resume'],
          ['SessionEnd', 'other'],
        ])
        await turn(2, { claudeSessionId: 'session-1', forkSession: true })
        assert.deepEqual((await settled(6)).slice(4), [
          ['SessionStart', 'fork'],
          ['SessionEnd', 'other'],
        ])
      },
    )
    await runtime.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SessionEnd hooks of the sessions still open run once as the runtime stops, within one budget', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-hooks-stop-')))
  const project = join(root, 'project')
  const log = join(root, 'log')
  const pids = join(root, 'pids')
  try {
    await mkdir(project, { recursive: true })
    const runtime = new NativeClaudeRuntime()
    const sessions: FakeSession[] = []
    Reflect.set(runtime, 'sdk', {
      query: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
        const session = new FakeSession(args.options, args.prompt)
        // The CLI exits once the SDK aborts it, and the session winds down.
        const abort = args.options.abortController as AbortController
        abort.signal.addEventListener('abort', () => session.close())
        sessions.push(session)
        return session
      },
    })
    // With a listener, a session outlives its turn while it has work.
    runtime.setBackgroundListener({
      onTaskEvent: () => {},
      onAutonomousTurn: () => {},
      onSessionReleased: () => {},
    })
    const handlers: RuntimeHandlers = {
      onEvent: async (_event: RuntimeEvent) => {},
      onPermissionRequest: async () => ({ decision: 'accept' }),
      onUserInputRequest: async () => ({ answers: {} }),
    }
    const context: RuntimeTurnContext = {
      threadId: 'thread',
      turnId: 'turn',
      prompt: 'Hi.',
      cwd: project,
      runtimeType: null,
      model: null,
      effort: null,
      claudeSessionId: null,
      forkSession: false,
      mcpServers: null,
      allowedTools: null,
      addDirs: [],
      enableFileCheckpointing: false,
      outputFormat: null,
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
      systemPromptAddendum: null,
      planMode: false,
      imageInputs: [],
      // Records the session it ends, then outstays the 1.5 seconds a
      // SessionEnd hook gets by default.
      claudeHooks: [
        spec({
          event: 'SessionEnd',
          timeoutSec: 1.5,
          command: `printf '%s\\n' "$(cat)" >> '${log}'; echo $$ >> '${pids}'; sleep 20`,
        }),
      ],
    }
    const turn = async (index: number, threadId: string, frames: Record<string, unknown>[]) => {
      const done = runtime.runTurn({ ...context, threadId, turnId: `turn-${index}` }, handlers)
      for (let i = 0; i < 400 && !sessions[index]; i++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      const session = sessions[index]
      assert.ok(session, 'no session opened')
      await call(session.options.hooks as SdkHooks, 'UserPromptSubmit', {
        ...prompt(project),
        session_id: threadId,
      })
      for (const frame of frames) session.push(frame)
      session.push({ type: 'result', subtype: 'success', result: 'Hello.' })
      await done
      return session
    }
    const lines = async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((input) => [input.session_id, input.hook_event_name, input.reason])
        .sort()
    await withEnv({ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: undefined }, async () => {
      // A background task keeps this session open after its turn.
      const live = await turn(0, 'live', [
        { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-1' }] },
      ])
      assert.equal(live.closed, false)
      // This one has nothing left to do: it closes, and its hook starts.
      const ended = await turn(1, 'ended', [])
      for (let i = 0; i < 400 && (await lines()).length < 1; i++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.equal(ended.closed, true)
      assert.deepEqual(await lines(), [['ended', 'SessionEnd', 'other']])

      const started = Date.now()
      await runtime.stop()
      const took = Date.now() - started
      // The open session's hook ran, and stopping waited for both hooks, but
      // not past their budget.
      assert.deepEqual(await lines(), [
        ['ended', 'SessionEnd', 'other'],
        ['live', 'SessionEnd', 'other'],
      ])
      assert.ok(took >= 1000, `stopping did not wait for the hooks (${took} ms)`)
      assert.ok(took < 4000, `stopping outlasted the SessionEnd budget (${took} ms)`)
      for (const pid of (await readFile(pids, 'utf8')).trim().split('\n').map(Number))
        assert.throws(() => process.kill(pid, 0), 'a SessionEnd hook outlived the budget')
      // The open session wound down as the runtime stopped; its hook does not
      // run again.
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(live.closed, true)
      assert.equal((await lines()).length, 2)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
