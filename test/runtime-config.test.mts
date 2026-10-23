import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import * as z from 'zod'
import { ClaudePTranscriptRuntime } from '../src/claude-p-runtime.mjs'
import {
  HttpAgentRuntime,
  hasAgentapiTrustPrompt,
  sanitizeAgentapiTerminalContent,
} from '../src/http-agent-runtime.mjs'
import {
  NativeClaudeRuntime,
  sdkResumeSessionId,
  sessionSignature,
} from '../src/native-runtime.mjs'
import { TurnInput } from '../src/native-turn-input.mjs'
import { resolveRuntimeConfig } from '../src/runtime-config.mjs'
import { buildSystemPromptAddendum } from '../src/server-helpers.mjs'
import type { DynamicToolServer, RuntimeTurnContext } from '../src/types.mjs'
import { parseWorkflowCommand, workflowRuntimePrompt } from '../src/workflow-command.mjs'
import {
  defaultWorkflowTranscriptRoots,
  WorkflowJournalMonitor,
} from '../src/workflow-subagents.mjs'

function nativeTurnContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread',
    turnId: 'turn',
    prompt: 'hello',
    cwd: process.cwd(),
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
    approvalPolicy: null,
    sandboxMode: null,
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

test('runtime config keeps legacy defaults and accepts explicit backends', () => {
  assert.equal(resolveRuntimeConfig({}).type, 'agent-sdk-sidecar')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_MOCK: '1' }).type, 'mock')
  assert.equal(
    resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_SOCKET: '/tmp/runtime.sock' }).type,
    'agent-sdk-sidecar',
  )
  assert.equal(
    resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'agent-sdk-socket' }).type,
    'agent-sdk-sidecar',
  )
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'channels' }).type, 'agent-http')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'agentapi' }).type, 'agentapi')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'claude-p' }).type, 'claude-p')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_PROVIDER: 'codex' }).type, 'codex-proxy')
  assert.equal(
    resolveRuntimeConfig({
      CLAUDE_CODEX_PROVIDER: 'codex',
      CLAUDE_CODEX_RUNTIME_TYPE: 'agent-http',
    }).type,
    'agent-http',
  )
  assert.equal(
    resolveRuntimeConfig({ CLAUDE_CODEX_HTTP_MANAGE_BRIDGE: '1' }).http.manageBridge,
    true,
  )
  assert.equal(
    resolveRuntimeConfig({ CLAUDE_CODEX_MODE_COMMAND: '/tmp/mode' }).http.modeCommand,
    '/tmp/mode',
  )
  assert.equal(resolveRuntimeConfig({}).claudeP.stopTimeoutRetries, 1)
  assert.equal(
    resolveRuntimeConfig({ CLAUDE_CODEX_CLAUDE_P_STOP_TIMEOUT_RETRIES: '0' }).claudeP
      .stopTimeoutRetries,
    0,
  )
})

test('native SDK runtime ignores bridge session markers when resuming SDK turns', () => {
  assert.equal(sdkResumeSessionId(null), null)
  assert.equal(sdkResumeSessionId('agent-http:http://127.0.0.1:3284'), null)
  assert.equal(sdkResumeSessionId('agentapi:http://127.0.0.1:3284'), null)
  assert.equal(sdkResumeSessionId('claude-p:session'), null)
  assert.equal(sdkResumeSessionId('sdk-session'), 'sdk-session')
})

test('a resumed transcript is copied only into the config dir its session runs from', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-codex-transcripts-')))
  const cwd = join(root, 'work')
  const slug = cwd.replace(/[^a-zA-Z0-9-]/g, '-')
  const transcript = (configDir: string) => join(configDir, 'projects', slug, 'session.jsonl')
  const ownRoot = join(root, '.claude')
  const routers = join(root, '.cache', 'router-tool', 'claude-router')
  const routerRoot = join(routers, 'router-model')
  const otherRouterRoot = join(routers, 'other-model')
  const extraRoot = join(root, 'extra', 'extra-model')
  const keys = [
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CONFIG_DIRS',
    'CLAUDE_ROUTER_DIR',
    'CLAUDE_CODEX_CLI',
  ]
  const saved = keys.map((key) => [key, process.env[key]] as const)
  for (const key of keys) delete process.env[key]
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIRS = join(root, 'extra')
  try {
    await mkdir(cwd, { recursive: true })
    await mkdir(otherRouterRoot, { recursive: true })
    await mkdir(extraRoot, { recursive: true })
    await mkdir(dirname(transcript(routerRoot)), { recursive: true })
    await writeFile(transcript(routerRoot), '{"n":1}\n', { mode: 0o600 })
    const sourceTime = new Date(Date.now() - 60_000)
    await utimes(transcript(routerRoot), sourceTime, sourceTime)

    // The SDK's own Claude Code runs from ~/.claude: the transcript goes there
    // and nowhere else, with its owner-only mode and its mtime.
    assert.equal(sdkResumeSessionId('session', cwd, undefined, 'router-model'), 'session')
    const copied = await stat(transcript(ownRoot))
    assert.equal(await readFile(transcript(ownRoot), 'utf8'), '{"n":1}\n')
    assert.equal(copied.mode & 0o777, 0o600)
    assert.equal((await stat(dirname(transcript(ownRoot)))).mode & 0o777, 0o700)
    assert.equal(Math.round(copied.mtimeMs), Math.round(sourceTime.getTime()))
    assert.equal(existsSync(transcript(otherRouterRoot)), false)
    assert.equal(existsSync(transcript(extraRoot)), false)
    assert.equal(existsSync(transcript(join(root, 'extra'))), false)
    assert.deepEqual(
      (await readdir(dirname(transcript(ownRoot)))).filter((name) => name.endsWith('.tmp')),
      [],
    )

    // An up-to-date copy is not copied again.
    assert.equal(sdkResumeSessionId('session', cwd, undefined, 'router-model'), 'session')
    assert.equal((await stat(transcript(ownRoot))).ino, copied.ino)

    // A newer source replaces a stale copy.
    await appendFile(transcript(routerRoot), '{"n":2}\n')
    assert.equal(sdkResumeSessionId('session', cwd, undefined, 'router-model'), 'session')
    assert.equal(await readFile(transcript(ownRoot), 'utf8'), '{"n":1}\n{"n":2}\n')
    const refreshed = await stat(transcript(ownRoot))
    assert.notEqual(refreshed.ino, copied.ino)
    assert.equal(refreshed.mode & 0o777, 0o600)

    // Once the session went on where it runs, that copy is the newest: it is
    // resumed as it is, and nothing is copied back.
    await appendFile(transcript(ownRoot), '{"n":3}\n')
    const later = new Date(Date.now() + 60_000)
    await utimes(transcript(ownRoot), later, later)
    assert.equal(sdkResumeSessionId('session', cwd, undefined, 'router-model'), 'session')
    assert.equal((await stat(transcript(ownRoot))).ino, refreshed.ino)
    assert.equal(await readFile(transcript(routerRoot), 'utf8'), '{"n":1}\n{"n":2}\n')

    // Nor does a shorter copy replace it, however new its mtime (another file
    // system's clock, a stale copy touched since): that would drop turns.
    const skewed = new Date(Date.now() + 120_000)
    await utimes(transcript(routerRoot), skewed, skewed)
    assert.equal(sdkResumeSessionId('session', cwd, undefined, 'router-model'), 'session')
    assert.equal((await stat(transcript(ownRoot))).ino, refreshed.ino)
    assert.equal(await readFile(transcript(ownRoot), 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n')
    await utimes(transcript(routerRoot), sourceTime, sourceTime)

    // A custom Claude Code, such as a model router, runs a model from the
    // router config dir named after it.
    process.env.CLAUDE_CODEX_CLI = join(root, 'router-claude')
    assert.equal(sdkResumeSessionId('session', cwd, undefined, 'other-model'), 'session')
    assert.equal(await readFile(transcript(otherRouterRoot), 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n')
    assert.equal(existsSync(transcript(extraRoot)), false)
    assert.equal(sdkResumeSessionId('session', cwd, undefined, 'extra-model'), 'session')
    assert.equal(existsSync(transcript(extraRoot)), true)
    // A model it has no config dir for, or no plain name, runs from ~/.claude.
    const own = (await stat(transcript(ownRoot))).ino
    assert.equal(sdkResumeSessionId('session', cwd, undefined, '../other-model'), 'session')
    assert.equal((await stat(transcript(ownRoot))).ino, own)

    // A session no config dir has is not resumed.
    assert.equal(sdkResumeSessionId('missing', cwd, undefined, 'router-model'), null)
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime maps manual /workflows prompts to the human workflow trigger', async () => {
  const runtime = new NativeClaudeRuntime()
  const context = nativeTurnContext({
    prompt: '/workflows open three subagents, reply ok',
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  })
  const buildPromptMessage = Reflect.get(runtime, 'buildPromptMessage')
  const messages: any[] = [buildPromptMessage.call(runtime, context)]

  assert.equal(
    messages[0].message.content,
    [
      'ultracode: open three subagents, reply ok',
      '',
      'Keep the launched workflow attached to this turn: wait for every workflow task to finish before returning the final response.',
    ].join('\n'),
  )
  assert.deepEqual(messages[0].origin, { kind: 'human' })

  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const session = { current: { context, handlers: {}, resolved: false }, lastContext: context }
  const options = buildOptions.call(runtime, {}, context, new AbortController(), () => session)
  // Pinned launchers reject --settings, so workflows are enabled by env alone.
  assert.equal(options.settings, undefined)
  assert.equal(options.env.CLAUDE_CODE_WORKFLOWS, '1')
  assert.equal(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1')
  assert.equal(options.permissionMode, 'default')
  assert.equal(options.allowDangerouslySkipPermissions, undefined)
  assert.equal(typeof options.canUseTool, 'function')
  assert.deepEqual(
    await options.canUseTool(
      'Bash',
      { command: 'true' },
      {
        toolUseID: 'tool',
        signal: new AbortController().signal,
      },
    ),
    { behavior: 'allow' },
  )
})

test('native SDK runtime switches auto-memory off only for threads the memories mapping keeps from it', () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const envFor = (overrides: Partial<RuntimeTurnContext>) => {
    const context = nativeTurnContext(overrides)
    const session = { current: { context, handlers: {}, resolved: false }, lastContext: context }
    return buildOptions.call(runtime, {}, context, new AbortController(), () => session)
      .env as NodeJS.ProcessEnv
  }
  const previous = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  try {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    // Without the memories mapping (no autoMemory) the launch adds nothing,
    // and Claude Code's own settings decide.
    assert.equal(envFor({}).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined)
    assert.equal(envFor({}).CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1')
    // With it, a thread kept from auto-memory gets the CLI's own switch, not
    // --settings.
    assert.equal(envFor({ autoMemory: false }).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
    assert.equal(envFor({ autoMemory: true }).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined)

    // A value the user exported passes through without the mapping. With it,
    // one that forces auto-memory on does not override a thread without
    // memories, and one that turns it off still wins.
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
    assert.equal(envFor({}).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '0')
    assert.equal(envFor({ autoMemory: false }).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
    assert.equal(envFor({ autoMemory: true }).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '0')
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    assert.equal(envFor({}).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
    assert.equal(envFor({ autoMemory: true }).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previous
  }
})

test('native SDK runtime sets the auto-compact window only when the thread has one', () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const envFor = (overrides: Partial<RuntimeTurnContext>) => {
    const context = nativeTurnContext(overrides)
    const session = { current: { context, handlers: {}, resolved: false }, lastContext: context }
    return buildOptions.call(runtime, {}, context, new AbortController(), () => session)
      .env as NodeJS.ProcessEnv
  }
  const previous = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  try {
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    // Without Codex's limit the launch adds nothing: Claude Code's own window.
    assert.equal(envFor({}).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined)
    assert.equal(envFor({ autoCompactWindow: null }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined)
    assert.equal(envFor({ autoCompactWindow: 250_000 }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '250000')
    // A window the user exported stays unless the thread has its own.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '400000'
    assert.equal(envFor({}).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000')
    assert.equal(envFor({ autoCompactWindow: 250_000 }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '250000')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previous
  }
})

test('a new auto-compact window starts a new native session', () => {
  // The window is fixed when the CLI starts, so a session started with
  // another one cannot carry the turn.
  const base = sessionSignature(nativeTurnContext())
  assert.equal(sessionSignature(nativeTurnContext({ autoCompactWindow: null })), base)
  const window = sessionSignature(nativeTurnContext({ autoCompactWindow: 300_000 }))
  assert.notEqual(window, base)
  assert.equal(sessionSignature(nativeTurnContext({ autoCompactWindow: 300_000 })), window)
  assert.notEqual(sessionSignature(nativeTurnContext({ autoCompactWindow: 500_000 })), window)
})

test('native SDK runtime asks Claude Code to report every startup failure as a result, unless the environment says otherwise', () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const context = nativeTurnContext({})
  const session = { current: { context, handlers: {}, resolved: false }, lastContext: context }
  const env = () =>
    buildOptions.call(runtime, {}, context, new AbortController(), () => session)
      .env as NodeJS.ProcessEnv
  const previous = process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS
  try {
    delete process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS
    assert.equal(env().CLAUDE_CODE_STARTUP_FAILURE_RESULTS, '1')
    process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = '0'
    assert.equal(env().CLAUDE_CODE_STARTUP_FAILURE_RESULTS, '0')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS
    else process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = previous
  }
})

test("native SDK runtime leaves fork subagents to Claude Code and the adapter's environment", () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const context = nativeTurnContext({ planMode: true })
  const session = { current: { context, handlers: {}, resolved: false }, lastContext: context }
  const env = () =>
    buildOptions.call(runtime, {}, context, new AbortController(), () => session)
      .env as NodeJS.ProcessEnv
  const previous = process.env.CLAUDE_CODE_FORK_SUBAGENT
  try {
    // Unset, the adapter adds nothing and Claude Code's default applies.
    delete process.env.CLAUDE_CODE_FORK_SUBAGENT
    assert.equal(env().CLAUDE_CODE_FORK_SUBAGENT, undefined)
    // A value the user exported reaches the CLI as it is.
    for (const value of ['0', '1']) {
      process.env.CLAUDE_CODE_FORK_SUBAGENT = value
      assert.equal(env().CLAUDE_CODE_FORK_SUBAGENT, value)
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_FORK_SUBAGENT
    else process.env.CLAUDE_CODE_FORK_SUBAGENT = previous
  }
})

test('native SDK runtime approves goal tools without shadowing canUseTool', async () => {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'zod', z)
  const sdk = {
    tool: (...args: unknown[]) => args,
    createSdkMcpServer: (config: Record<string, unknown>) => ({ type: 'sdk', ...config }),
  }
  const goalTools = {
    getGoal: async () => '{}',
    createGoal: async () => '{}',
    updateGoal: async () => '{}',
  }
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const build = (overrides: Partial<RuntimeTurnContext>) =>
    buildOptions.call(
      runtime,
      sdk,
      nativeTurnContext({ prompt: 'work on the goal', goalTools, ...overrides }),
      new AbortController(),
      () => null,
    )

  const options = build({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write' })
  assert.ok(options.mcpServers.codex_goal)
  assert.equal(options.allowedTools?.includes('mcp__codex_goal') ?? false, false)
  const signal = new AbortController().signal
  // Even with no turn to ask in, goal bookkeeping is allowed while other
  // tools still need the user.
  assert.deepEqual(
    await options.canUseTool('mcp__codex_goal__update_goal', { status: 'complete' }, { signal }),
    { behavior: 'allow' },
  )
  assert.equal((await options.canUseTool('Bash', { command: 'true' }, { signal })).behavior, 'deny')
  // Only the goal server's own tools: a server whose name starts with it asks.
  assert.equal(
    (await options.canUseTool('mcp__codex_goal__x__update_goal', {}, { signal })).behavior,
    'deny',
  )

  // Plan mode keeps the callback too, and it allows goal bookkeeping there.
  const plan = build({ planMode: true, approvalPolicy: 'never' })
  assert.equal(plan.permissionMode, 'plan')
  assert.equal(typeof plan.canUseTool, 'function')
  assert.equal(plan.allowedTools?.includes('mcp__codex_goal') ?? false, false)
  assert.deepEqual(
    await plan.canUseTool('mcp__codex_goal__update_goal', { status: 'complete' }, { signal }),
    { behavior: 'allow' },
  )
  // Between turns, plan mode's read-only promise outranks Full Access.
  assert.equal((await plan.canUseTool('Bash', { command: 'true' }, { signal })).behavior, 'deny')
})

test('native SDK runtime offers dynamic tools as MCP servers and routes calls to the turn', async () => {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'zod', z)
  const sdk = {
    tool: (
      name: string,
      description: string,
      schema: { meta: () => unknown },
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
      extras: unknown,
    ) => ({ name, description, schema, handler, extras }),
    createSdkMcpServer: (config: Record<string, unknown>) => ({ type: 'sdk', ...config }),
  }
  const listSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  }
  const dynamicTools: DynamicToolServer[] = [
    {
      server: 'codex_app',
      namespace: 'codex_app',
      description: 'Tools provided by the app.',
      tools: [
        {
          name: 'list_artifacts',
          description: 'List artifacts.',
          inputSchema: listSchema,
          deferLoading: false,
        },
        {
          name: 'restore_worktree',
          description: 'Restore a worktree.',
          inputSchema: { type: 'object' },
          deferLoading: true,
        },
      ],
    },
    {
      server: 'dynamic_tools',
      namespace: null,
      description: '',
      tools: [
        {
          name: 'echo',
          description: 'Echo.',
          inputSchema: { type: 'object' },
          deferLoading: false,
        },
      ],
    },
    // A server the adapter already runs keeps its name.
    {
      server: 'codex_goal',
      namespace: 'codex_goal',
      description: '',
      tools: [
        { name: 'shadow', description: '', inputSchema: { type: 'object' }, deferLoading: false },
      ],
    },
  ]
  const context = nativeTurnContext({
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    dynamicTools,
  })
  const calls: unknown[] = []
  const pending = {
    context,
    resolved: false,
    handlers: {
      onDynamicToolCall: async (request: unknown, signal: AbortSignal) => {
        calls.push({ request, aborted: signal.aborted })
        return {
          contentItems: [
            { type: 'inputText', text: '2 artifacts' },
            { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
            { type: 'inputImage', imageUrl: 'data:image/svg+xml;base64,AAAA' },
          ],
          success: true,
        }
      },
    },
  }
  const session: { current: typeof pending | null; lastContext: RuntimeTurnContext } = {
    current: pending,
    lastContext: context,
  }
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const options = buildOptions.call(runtime, sdk, context, new AbortController(), () => session)
  assert.deepEqual(Object.keys(options.mcpServers), ['codex_app', 'dynamic_tools'])
  const app = options.mcpServers.codex_app
  assert.equal(app.name, 'codex_app')
  assert.equal(app.instructions, 'Tools provided by the app.')
  assert.equal('instructions' in options.mcpServers.dynamic_tools, false)
  assert.deepEqual(
    app.tools.map((tool: any) => [tool.name, tool.description, tool.extras]),
    [
      ['list_artifacts', 'List artifacts.', { alwaysLoad: true }],
      // Deferred tools wait for Claude Code's tool search.
      ['restore_worktree', 'Restore a worktree.', undefined],
    ],
  )
  // The client's schema is what the server lists.
  assert.deepEqual(app.tools[0].schema.meta(), listSchema)

  // The tools run without an approval prompt, even where other tools ask.
  const signal = new AbortController().signal
  assert.deepEqual(await options.canUseTool('mcp__codex_app__list_artifacts', {}, { signal }), {
    behavior: 'allow',
  })
  assert.deepEqual(await options.canUseTool('mcp__dynamic_tools__echo', {}, { signal }), {
    behavior: 'allow',
  })

  // Claude Code's tool use id becomes the call id.
  const result = await app.tools[0].handler(
    { query: 'reports' },
    { signal, _meta: { 'claudecode/toolUseId': 'toolu_1' } },
  )
  assert.deepEqual(result, {
    content: [
      { type: 'text', text: '2 artifacts' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: '[image omitted]' },
    ],
  })
  await options.mcpServers.dynamic_tools.tools[0].handler({}, { signal })
  assert.deepEqual(calls[0], {
    request: {
      callId: 'toolu_1',
      namespace: 'codex_app',
      tool: 'list_artifacts',
      arguments: { query: 'reports' },
    },
    aborted: false,
  })
  const loose = (calls[1] as { request: Record<string, unknown> }).request
  assert.match(String(loose.callId), /^call-/)
  assert.equal(loose.namespace, null)
  assert.equal(loose.tool, 'echo')

  // A failed call is an error result; between turns nothing can answer.
  pending.handlers.onDynamicToolCall = async () => ({
    contentItems: [{ type: 'inputText', text: 'dynamic tool request failed' }],
    success: false,
  })
  assert.deepEqual(await app.tools[0].handler({ query: 'x' }, { signal }), {
    content: [{ type: 'text', text: 'dynamic tool request failed' }],
    isError: true,
  })
  session.current = null
  assert.deepEqual(await app.tools[0].handler({ query: 'x' }, { signal }), {
    content: [
      {
        type: 'text',
        text: 'list_artifacts was not run because no user turn was active to answer it; the user can re-run it in a turn.',
      },
    ],
    isError: true,
  })
  assert.equal(calls.length, 2)

  // Plan mode offers none of them.
  const plan = buildOptions.call(
    runtime,
    sdk,
    { ...context, planMode: true },
    new AbortController(),
    () => session,
  )
  assert.equal(plan.mcpServers, undefined)
})

test('native SDK runtime serves the leader tools, and only the looking ones in plan mode', async () => {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'zod', z)
  const sdk = {
    tool: (...args: unknown[]) => args,
    createSdkMcpServer: (config: Record<string, unknown>) => ({ type: 'sdk', ...config }),
  }
  const calls: Array<{ tool: string; input: unknown; signal: unknown }> = []
  const record =
    (tool: string) =>
    async (input: unknown, signal?: AbortSignal): Promise<string> => {
      calls.push({ tool, input, signal })
      return `${tool} ok`
    }
  const leaderTools = {
    list: record('list'),
    start: record('start'),
    prompt: record('prompt'),
    wait: record('wait'),
    read: record('read'),
  }
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const build = (overrides: Partial<RuntimeTurnContext>) =>
    buildOptions.call(runtime, sdk, nativeTurnContext(overrides), new AbortController(), () => null)

  assert.equal(build({}).mcpServers, undefined)
  const options = build({
    leaderTools,
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
  })
  const server = options.mcpServers.codex_leader
  const tools = new Map<string, any[]>(server.tools.map((tool: any[]) => [tool[0], tool]))
  assert.deepEqual(
    [...tools.keys()],
    ['thread_list', 'thread_start', 'thread_prompt', 'thread_wait', 'thread_read'],
  )
  assert.match(tools.get('thread_start')?.[1], /Agent tool/)
  assert.match(tools.get('thread_start')?.[1], /::created-thread line[^\n]*final response/)
  assert.deepEqual(
    [...tools.values()].filter((tool) => tool[4]?.annotations?.readOnlyHint).map((tool) => tool[0]),
    ['thread_list', 'thread_wait', 'thread_read'],
  )
  // The SDK's abort signal reaches the waiting handlers; a thrown error
  // becomes an error result.
  const signal = new AbortController().signal
  const result = await tools.get('thread_wait')?.[3]({ threadIds: ['a'] }, { signal })
  assert.deepEqual(result, { content: [{ type: 'text', text: 'wait ok' }] })
  assert.deepEqual(calls.at(-1), { tool: 'wait', input: { threadIds: ['a'] }, signal })
  leaderTools.read = async () => {
    throw new Error('unknown thread: gone')
  }
  const failed = await build({ leaderTools }).mcpServers.codex_leader.tools[4][3]({
    threadId: 'gone',
  })
  assert.deepEqual(failed, {
    content: [{ type: 'text', text: 'unknown thread: gone' }],
    isError: true,
  })
  // Allowed without asking, like the goal tools, while other tools still ask.
  assert.deepEqual(
    await options.canUseTool('mcp__codex_leader__thread_start', { prompt: 'x' }, { signal }),
    { behavior: 'allow' },
  )
  assert.equal((await options.canUseTool('Bash', { command: 'true' }, { signal })).behavior, 'deny')

  // A plan only looks: plan mode lets the looking tools through and turns
  // away starting or prompting another chat.
  const planContext = nativeTurnContext({ leaderTools, planMode: true })
  const planSession = {
    current: { context: planContext, resolved: false, handlers: { onEvent: async () => {} } },
    lastContext: planContext,
  }
  const plan = buildOptions.call(
    runtime,
    sdk,
    planContext,
    new AbortController(),
    () => planSession,
  )
  assert.ok(plan.mcpServers.codex_leader)
  const decisions: Record<string, string> = {}
  for (const tool of tools.keys())
    decisions[tool] = (
      await plan.canUseTool(`mcp__codex_leader__${tool}`, {}, { toolUseID: tool, signal })
    ).behavior
  assert.deepEqual(decisions, {
    thread_list: 'allow',
    thread_start: 'deny',
    thread_prompt: 'deny',
    thread_wait: 'allow',
    thread_read: 'allow',
  })
})

test('explicit native SDK bypass includes the required dangerous opt-in flag', () => {
  const previous = process.env.CLAUDE_CODEX_PERMISSION_MODE
  process.env.CLAUDE_CODEX_PERMISSION_MODE = 'bypassPermissions'
  try {
    const runtime = new NativeClaudeRuntime()
    const buildOptions = Reflect.get(runtime, 'buildOptions')
    const options = buildOptions.call(
      runtime,
      {},
      nativeTurnContext({ prompt: '/workflows inspect permissions' }),
      new AbortController(),
    )
    assert.equal(options.permissionMode, 'bypassPermissions')
    assert.equal(options.allowDangerouslySkipPermissions, true)
    assert.equal(options.canUseTool, undefined)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_PERMISSION_MODE
    else process.env.CLAUDE_CODEX_PERMISSION_MODE = previous
  }
})

test('workflow command parser keeps list and run semantics distinct', () => {
  assert.deepEqual(parseWorkflowCommand('/workflows'), { type: 'list' })
  assert.deepEqual(parseWorkflowCommand('  /workflows inspect the adapter'), {
    type: 'run',
    prompt: 'inspect the adapter',
  })
  assert.equal(parseWorkflowCommand('/workflowsx inspect'), null)
  assert.deepEqual(parseWorkflowCommand('/workflows list'), { type: 'list' })
  assert.deepEqual(parseWorkflowCommand('/workflows list the open bugs'), {
    type: 'run',
    prompt: 'list the open bugs',
  })
  assert.equal(workflowRuntimePrompt('/workflows'), '/workflows')

  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const options = buildOptions.call(
    runtime,
    {},
    nativeTurnContext({ prompt: '/workflows' }),
    new AbortController(),
  )
  assert.equal(options.settings, undefined)
  assert.equal(options.env?.CLAUDE_CODE_WORKFLOWS, undefined)
})

test('workflow transcript roots follow CLAUDE_CONFIG_DIR and HOME deterministically', () => {
  assert.deepEqual(
    defaultWorkflowTranscriptRoots(
      { CLAUDE_CONFIG_DIR: 'profiles/claude', HOME: '/ignored-home' },
      '/workspace',
    ),
    ['/workspace/profiles/claude'],
  )
  assert.deepEqual(defaultWorkflowTranscriptRoots({ HOME: '/users/tester' }, '/workspace'), [
    '/users/tester/.claude',
  ])
})

test('manual workflow normalization preserves attached image blocks', async () => {
  const runtime = new NativeClaudeRuntime()
  const buildPromptMessage = Reflect.get(runtime, 'buildPromptMessage')
  const context = nativeTurnContext({
    prompt: '/workflows inspect this image',
    imageInputs: [
      {
        kind: 'url',
        mediaType: 'image/png',
        data: 'https://example.com/image.png',
        displayPath: 'https://example.com/image.png',
      },
    ],
  })
  const messages: any[] = [buildPromptMessage.call(runtime, context)]
  assert.match(messages[0].message.content[0].text, /^ultracode: inspect this image/)
  assert.deepEqual(messages[0].message.content[1], {
    type: 'image',
    source: { type: 'url', url: 'https://example.com/image.png' },
  })
})

test('native SDK runtime projects workflow journal agents into separate live Agent lifecycles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-journal-'))
  const runId = 'wf_test_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  await mkdir(transcriptDir, { recursive: true })
  const agents = [
    { id: 'aaaaaaaa111111111', name: 'alpha', prompt: 'Review module alpha' },
    { id: 'bbbbbbbb222222222', name: 'beta', prompt: 'Review module beta' },
    { id: 'cccccccc333333333', name: 'gamma', prompt: 'Review module gamma' },
  ]
  for (const agent of agents) {
    await writeFile(
      join(transcriptDir, `agent-${agent.id}.jsonl`),
      `${JSON.stringify({ message: { role: 'user', content: agent.prompt } })}\n`,
    )
  }

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set<string>(),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleAssistant = Reflect.get(runtime, 'handleAssistant')
  const handleUser = Reflect.get(runtime, 'handleUser')
  let notified = false

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'workflow-task-id',
      tool_use_id: 'workflow-launch-tool',
      task_type: 'local_workflow',
      workflow_name: 'parallel-review',
      description: 'Review three modules',
    })
    await handleAssistant.call(runtime, pending, {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'workflow-launch-tool',
            name: 'Workflow',
            input: { command: 'parallel-review' },
          },
        ],
      },
    })
    assert.equal(pending.workflowToolUseIds.has('workflow-launch-tool'), true)
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'workflow-task-id',
        taskType: 'local_workflow',
        workflowName: 'parallel-review',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'workflow-launch-tool',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    assert.equal(pending.workflowToolUseIds.size, 0)

    await appendFile(
      join(transcriptDir, 'journal.jsonl'),
      `${agents
        .map((agent, index) =>
          JSON.stringify({ type: 'started', key: `key-${index}`, agentId: agent.id }),
        )
        .join('\n')}\n`,
    )
    await waitForCondition(
      () =>
        events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      3,
    )

    const starts = events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent')
    assert.equal(starts.length, 3)
    assert.deepEqual(
      starts.map((event) => event.input.prompt).sort(),
      agents.map((agent) => agent.prompt).sort(),
    )
    assert.equal(
      events.filter(
        (event) =>
          event.type === 'tool_result' && String(event.toolUseId).startsWith('workflow-agent:'),
      ).length,
      0,
      'workflow agents should remain visibly running before journal results arrive',
    )

    await appendFile(
      join(transcriptDir, 'journal.jsonl'),
      `${agents
        .map((agent, index) =>
          JSON.stringify({
            type: 'result',
            key: `key-${index}`,
            agentId: agent.id,
            result: {
              agentId: agent.id,
              agentName: agent.name,
              status: 'ok',
              reply: 'ok',
              details: 'Observed Claude Code workflow journal result shape',
            },
          }),
        )
        .join('\n')}\n`,
    )
    await waitForCondition(
      () =>
        events.filter(
          (event) =>
            event.type === 'tool_result' && String(event.toolUseId).startsWith('workflow-agent:'),
        ).length,
      3,
    )

    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'workflow-task-id',
      status: 'completed',
      summary: 'All reviewers completed',
      usage: { total_tokens: 100, tool_uses: 3, duration_ms: 2500 },
    })
    notified = true

    const results = events.filter(
      (event) =>
        event.type === 'tool_result' && String(event.toolUseId).startsWith('workflow-agent:'),
    )
    assert.equal(results.length, 3)
    assert.equal(
      results.every((event) => event.isError === false),
      true,
    )
    assert.equal(
      results.every((event) => /"reply": "ok"/.test(event.content)),
      true,
    )
    assert.equal(
      events.some((event) => String(event.toolUseId).startsWith('workflow-task:')),
      false,
      'the aggregate workflow card should not replace individual journal agents',
    )
    const summaryEvent = events.find((event) => event.type === 'notice')
    assert.match(summaryEvent?.message ?? '', /All reviewers completed/)
    assert.match(summaryEvent?.message ?? '', /total_tokens: 100/)
  } finally {
    if (!notified) {
      await handleSystem.call(runtime, pending, {
        subtype: 'task_notification',
        task_id: 'workflow-task-id',
        status: 'stopped',
        summary: 'test cleanup',
      })
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime waits for a slightly delayed workflow journal result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-delayed-workflow-result-'))
  const runId = 'wf_delayed_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'dddddddd44444444'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Review delayed module' } })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['delayed-workflow-launch']),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'delayed-workflow-task',
      tool_use_id: 'delayed-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'delayed-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'delayed-workflow-task',
        taskType: 'local_workflow',
        workflowName: 'delayed-workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'delayed-workflow-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await appendFile(
      join(transcriptDir, 'journal.jsonl'),
      `${JSON.stringify({ type: 'started', key: 'delayed-key', agentId })}\n`,
    )
    await waitForCondition(
      () =>
        events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      1,
    )

    const delayedWrite = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void appendFile(
          join(transcriptDir, 'journal.jsonl'),
          `${JSON.stringify({
            type: 'result',
            key: 'delayed-key',
            agentId,
            result: { status: 'ok', reply: 'ok' },
          })}\n`,
        ).then(resolve, reject)
      }, 700)
    })
    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'delayed-workflow-task',
      status: 'completed',
      summary: 'Delayed workflow completed',
    })
    await delayedWrite

    const results = events.filter(
      (event) =>
        event.type === 'tool_result' && String(event.toolUseId).startsWith('workflow-agent:'),
    )
    assert.equal(results.length, 1)
    assert.equal(results[0].isError, false)
    assert.match(results[0].content, /"reply": "ok"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK parent result does not cap workflow runtime at three seconds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-parent-result-workflow-'))
  const runId = 'wf_parent_result_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'fafafafa191919191'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Parent result race prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'parent-result-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  let resolved = false
  const pending = {
    context: nativeTurnContext({ turnId: 'parent-result-workflow-turn' }),
    input: new TurnInput(),
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['parent-result-workflow-launch']),
    workflowTranscriptRoots: [root],
    workflowTasks: new Map(),
    skippedWorkflowTaskIds: new Set<string>(),
    structuredBuffer: '',
    resolved: false,
    resolve: () => {
      resolved = true
    },
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const handleResult = Reflect.get(runtime, 'handleResult')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'parent-result-workflow-task',
      tool_use_id: 'parent-result-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'parent-result-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'parent-result-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'parent-result-workflow-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await waitForCondition(
      () =>
        events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      1,
    )

    const parentResult = handleResult.call(runtime, pending, {
      subtype: 'success',
      is_error: false,
      result: 'Parent turn completed',
      usage: {},
    })

    await new Promise((resolve) => setTimeout(resolve, 3_200))
    assert.equal(resolved, false, 'parent turn must remain open while Workflow is still running')
    assert.equal(
      events.some((event) => event.type === 'completed'),
      false,
      'turn/completed must not be emitted before the Workflow terminal notification',
    )
    assert.equal(
      pending.activeSubagents.has(`workflow-agent:parent-result-workflow-task:${agentId}`),
      true,
      'the projected Agent must remain running beyond three seconds',
    )

    await appendFile(
      join(transcriptDir, 'journal.jsonl'),
      `${JSON.stringify({
        type: 'result',
        key: 'parent-result-key',
        agentId,
        result: { status: 'ok', reply: 'ok' },
      })}\n`,
    )
    await waitForCondition(
      () =>
        events.filter(
          (event) =>
            event.type === 'tool_result' && String(event.toolUseId).startsWith('workflow-agent:'),
        ).length,
      1,
    )
    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'parent-result-workflow-task',
      status: 'completed',
      summary: 'Long-running workflow completed',
    })
    await parentResult

    const result = events.find(
      (event) =>
        event.type === 'tool_result' && String(event.toolUseId).startsWith('workflow-agent:'),
    )
    assert.equal(result?.isError, false)
    assert.equal(resolved, true)
    assert.ok(
      events.findIndex((event) => event.type === 'tool_result') <
        events.findIndex((event) => event.type === 'completed'),
      'Agent result must be emitted before turn/completed',
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime waits for the workflow agent prompt file before projecting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-delayed-workflow-prompt-'))
  const runId = 'wf_delayed_prompt_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'dadadada131313131'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'delayed-prompt-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['delayed-prompt-launch']),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'delayed-prompt-task',
      tool_use_id: 'delayed-prompt-launch',
      task_type: 'local_workflow',
      workflow_name: 'delayed-prompt-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'delayed-prompt-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'delayed-prompt-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )

    await writeFile(
      join(transcriptDir, `agent-${agentId}.jsonl`),
      `${JSON.stringify({ message: { role: 'user', content: 'Delayed prompt content' } })}\n`,
    )
    await waitForCondition(
      () =>
        events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      1,
    )
    const start = events.find((event) => event.type === 'tool_use' && event.toolName === 'Agent')
    assert.equal(start.input.prompt, 'Delayed prompt content')
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime attaches a deferred Workflow launch after task_started arrives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-deferred-workflow-launch-'))
  const runId = 'wf_deferred_launch_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'dededede171717171'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Deferred launch prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'deferred-launch-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['deferred-workflow-launch']),
    workflowTranscriptRoots: [root],
    workflowTasks: new Map(),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'deferred-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'deferred-workflow-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )

    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'deferred-workflow-task',
      tool_use_id: 'deferred-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'deferred-workflow',
    })
    await waitForCondition(
      () =>
        events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      1,
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime falls back to aggregate Agent when workflow journal stays empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-empty-workflow-journal-'))
  const runId = 'wf_empty_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(join(transcriptDir, 'journal.jsonl'), '')

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['empty-workflow-launch']),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'empty-workflow-task',
      tool_use_id: 'empty-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'empty-workflow',
      description: 'Workflow with no agent journal entries',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'empty-workflow-task',
        taskType: 'local_workflow',
        workflowName: 'empty-workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'empty-workflow-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'empty-workflow-task',
      status: 'completed',
      summary: 'Workflow completed without journal agents',
    })

    const aggregate = events.filter(
      (event) =>
        event.toolUseId === 'workflow-task:empty-workflow-task' &&
        (event.type === 'tool_use' || event.type === 'tool_result'),
    )
    assert.equal(aggregate.length, 2)
    assert.equal(aggregate[0].toolName, 'Agent')
    assert.equal(aggregate[1].isError, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime settles an out-of-order workflow task notification', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set<string>(),
    workflowTranscriptRoots: [process.cwd()],
    workflowTasks: new Map(),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  await handleSystem.call(runtime, pending, {
    // The SDK may batch or reorder these system messages after a reconnect.
    // There is no preceding task_started marker in this case.
    subtype: 'task_notification',
    task_id: 'out-of-order-workflow-task',
    status: 'completed',
    workflow_name: 'out-of-order-workflow',
    summary: 'Workflow completed after reconnect',
  })

  const aggregate = events.filter(
    (event) =>
      event.toolUseId === 'workflow-task:out-of-order-workflow-task' &&
      (event.type === 'tool_use' || event.type === 'tool_result'),
  )
  assert.equal(aggregate.length, 2)
  assert.equal(aggregate[0].toolName, 'Agent')
  assert.equal(aggregate[1].isError, false)
  assert.match(aggregate[1].content, /Workflow completed after reconnect/)
})

test('native SDK runtime accepts the declared SDK task_notification shape', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    // The real SDK notification may omit task_type/workflow_name. The
    // tool_use_id is the stable correlation key when the Workflow launch is
    // still pending.
    workflowToolUseIds: new Set(['sdk-workflow-launch']),
    workflowLaunches: new Map(),
    workflowTranscriptRoots: [process.cwd()],
    workflowTasks: new Map(),
    skippedWorkflowTaskIds: new Set<string>(),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  await handleSystem.call(runtime, pending, {
    subtype: 'task_notification',
    task_id: 'sdk-shaped-workflow-task',
    tool_use_id: 'sdk-workflow-launch',
    status: 'completed',
    output_file: '/tmp/claude-workflow-output.jsonl',
    summary: 'SDK-shaped workflow completed',
    usage: { total_tokens: 12, tool_uses: 1, duration_ms: 20 },
  })

  const aggregate = events.filter(
    (event) =>
      event.toolUseId === 'workflow-task:sdk-shaped-workflow-task' &&
      (event.type === 'tool_use' || event.type === 'tool_result'),
  )
  assert.equal(aggregate.length, 2)
  assert.equal(aggregate[0].toolName, 'Agent')
  assert.equal(aggregate[1].isError, false)
  assert.match(aggregate[1].content, /SDK-shaped workflow completed/)
})

test('native SDK runtime accepts Workflow launch metadata after the old fallback window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-late-workflow-launch-'))
  const runId = 'wf_late_launch_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'acacacac999999999'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Late launch prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'late-launch-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['late-workflow-launch']),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'late-workflow-task',
      tool_use_id: 'late-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'late-workflow',
    })
    await new Promise((resolve) => setTimeout(resolve, 850))
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'late-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'late-workflow-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(
      events.filter(
        (event) =>
          event.type === 'tool_use' && String(event.toolUseId).startsWith('workflow-agent:'),
      ).length,
      1,
    )
    assert.equal(
      events.some((event) => event.toolUseId === 'workflow-task:late-workflow-task'),
      false,
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime hides skip_transcript workflow journals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-hidden-workflow-'))
  const runId = 'wf_hidden_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'bcbcbcbc101010101'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Hidden workflow prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'hidden-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['hidden-workflow-launch']),
    workflowTranscriptRoots: [root],
    skippedWorkflowTaskIds: new Set<string>(),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'hidden-workflow-task',
      tool_use_id: 'hidden-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'hidden-workflow',
      skip_transcript: true,
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'hidden-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'hidden-workflow-launch',
            content: 'Hidden workflow launched.',
          },
        ],
      },
    })
    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'hidden-workflow-task',
      status: 'completed',
      summary: 'Hidden workflow completed',
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )
    assert.equal(
      events.some((event) => String(event.toolUseId).startsWith('workflow-task:')),
      false,
    )
    assert.equal(
      events.some((event) => event.type === 'notice'),
      false,
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime ignores workflow-shaped metadata from a non-Workflow tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-untrusted-workflow-result-'))
  const runId = 'wf_untrusted_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'eeeeeeee55555555'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Untrusted prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'untrusted-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set<string>(),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'untrusted-workflow-task',
      tool_use_id: 'ordinary-tool',
      task_type: 'local_workflow',
      workflow_name: 'untrusted-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'untrusted-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'ordinary-tool',
            content: 'Lookalike workflow metadata',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )
    assert.equal(pending.workflowToolUseIds.size, 0)
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime rejects Workflow launch metadata bound to a different task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-mismatched-workflow-task-'))
  const runId = 'wf_mismatched_task_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'abababab151515151'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Mismatched workflow prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'mismatched-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['mismatched-workflow-launch']),
    workflowTranscriptRoots: [root],
    workflowTasks: new Map(),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'expected-workflow-task',
      tool_use_id: 'mismatched-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'mismatched-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'different-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'mismatched-workflow-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime rejects ambiguous batched Workflow tool results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-ambiguous-workflow-result-'))
  const runId = 'wf_ambiguous_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'edededed888888888'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Ambiguous prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'ambiguous-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['workflow-launch']),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'ambiguous-workflow-task',
      tool_use_id: 'workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'ambiguous-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'ambiguous-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'workflow-launch',
            content: 'Workflow launched in background.',
          },
          {
            type: 'tool_result',
            tool_use_id: 'ordinary-tool',
            content: 'Another result in the same SDK message.',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )
    assert.equal(pending.workflowToolUseIds.size, 0)
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime rejects a symlinked workflow journal file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-journal-symlink-'))
  const runId = 'wf_journal_symlink_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const outsideJournal = join(root, 'outside-journal.jsonl')
  const agentId = 'abababab77777777'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Journal symlink prompt' } })}\n`,
  )
  await writeFile(
    outsideJournal,
    `${JSON.stringify({ type: 'started', key: 'outside-journal-key', agentId })}\n`,
  )
  await symlink(outsideJournal, join(transcriptDir, 'journal.jsonl'), 'file')

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['journal-symlink-launch']),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'journal-symlink-task',
      tool_use_id: 'journal-symlink-launch',
      task_type: 'local_workflow',
      workflow_name: 'journal-symlink-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'journal-symlink-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'journal-symlink-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )
    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'journal-symlink-task',
      status: 'completed',
      summary: 'Journal symlink workflow completed',
    })
    assert.equal(
      events.filter((event) => event.toolUseId === 'workflow-task:journal-symlink-task').length,
      0,
      'a rejected journal must not be revived as a successful aggregate Agent',
    )
    assert.match(String((pending as any).workflowFailure ?? ''), /monitoring failed/i)
    assert.equal(
      events.some(
        (event) => event.type === 'notice' && /monitoring failed/i.test(String(event.message)),
      ),
      true,
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime rejects workflow transcript symlinks that escape the trusted root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-symlink-'))
  const trustedRoot = join(root, 'trusted')
  const runId = 'wf_symlink_run'
  const transcriptDir = join(trustedRoot, 'projects', 'project', 'subagents', 'workflows', runId)
  const outsideDir = join(root, 'outside', 'subagents', 'workflows', runId)
  const agentId = 'ffffffff66666666'
  await mkdir(join(transcriptDir, '..'), { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(
    join(outsideDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Outside prompt' } })}\n`,
  )
  await writeFile(
    join(outsideDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'outside-key', agentId })}\n`,
  )
  await symlink(outsideDir, transcriptDir, 'dir')

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['trusted-workflow-launch']),
    workflowTranscriptRoots: [trustedRoot],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleUser = Reflect.get(runtime, 'handleUser')
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'trusted-workflow-task',
      tool_use_id: 'trusted-workflow-launch',
      task_type: 'local_workflow',
      workflow_name: 'symlink-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'trusted-workflow-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'trusted-workflow-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter((event) => event.type === 'tool_use' && event.toolName === 'Agent').length,
      0,
    )
    await handleSystem.call(runtime, pending, {
      subtype: 'task_notification',
      task_id: 'trusted-workflow-task',
      status: 'completed',
      summary: 'Symlink workflow completed',
    })
    assert.equal(
      events.filter((event) => event.toolUseId === 'workflow-task:trusted-workflow-task').length,
      0,
      'an escaped transcript must not be revived as a successful aggregate Agent',
    )
    assert.match(String((pending as any).workflowFailure ?? ''), /monitoring failed/i)
    assert.equal(
      events.some(
        (event) => event.type === 'notice' && /monitoring failed/i.test(String(event.message)),
      ),
      true,
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime rejects a workflow directory replaced after canonical validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-directory-swap-'))
  const runId = 'wf_directory_swap_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const archivedDir = join(root, 'archived-transcript')
  const outsideDir = join(root, 'outside-replacement')
  const agentId = 'cdcdcdcd121212121'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(join(transcriptDir, 'journal.jsonl'), '')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(
    join(outsideDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Replacement prompt' } })}\n`,
  )
  await writeFile(
    join(outsideDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'replacement-key', agentId })}\n`,
  )

  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowToolUseIds: new Set(['directory-swap-launch']),
    workflowTranscriptRoots: [root],
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')
  const handleUser = Reflect.get(runtime, 'handleUser')
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  try {
    await handleSystem.call(runtime, pending, {
      subtype: 'task_started',
      task_id: 'directory-swap-task',
      tool_use_id: 'directory-swap-launch',
      task_type: 'local_workflow',
      workflow_name: 'directory-swap-workflow',
    })
    await handleUser.call(runtime, pending, {
      type: 'user',
      tool_use_result: {
        status: 'async_launched',
        taskId: 'directory-swap-task',
        taskType: 'local_workflow',
        runId,
        transcriptDir,
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'directory-swap-launch',
            content: 'Workflow launched in background.',
          },
        ],
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rename(transcriptDir, archivedDir)
    await symlink(outsideDir, transcriptDir, 'dir')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      events.filter(
        (event) =>
          event.type === 'tool_use' && String(event.toolUseId).startsWith('workflow-agent:'),
      ).length,
      0,
    )
  } finally {
    await stopWorkflowTasks.call(runtime, pending)
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK runtime falls back to one Agent lifecycle without workflow journal metadata', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  await handleSystem.call(runtime, pending, {
    subtype: 'task_started',
    task_id: 'wf-123',
    task_type: 'local_workflow',
    workflow_name: 'parallel-review',
    description: 'Review three modules',
  })
  await handleSystem.call(runtime, pending, {
    subtype: 'task_notification',
    task_id: 'wf-123',
    status: 'completed',
    summary: 'All reviewers completed',
    usage: { total_tokens: 100, tool_uses: 3, duration_ms: 2500 },
  })
  await handleSystem.call(runtime, pending, {
    subtype: 'task_started',
    task_id: 'wf-123',
    task_type: 'local_workflow',
  })

  assert.equal(events.length, 2)
  assert.equal(events[0].toolName, 'Agent')
  assert.equal(events[0].input.subagent_type, 'workflow')
  assert.equal(events[1].toolUseId, 'workflow-task:wf-123')
  assert.match(events[1].content, /total_tokens: 100/)
  assert.equal(events[1].isError, false)
})

test('native SDK runtime ignores non-workflow task notifications', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowTasks: new Map(),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  await handleSystem.call(runtime, pending, {
    subtype: 'task_notification',
    task_id: 'ordinary-background-task',
    status: 'completed',
    summary: 'Ordinary task completed',
  })

  assert.deepEqual(events, [])
})

test('native SDK runtime closes lagged workflow agents using the terminal task status', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const taskId = 'lagged-workflow-task'
  const agentId = 'efefefef141414141'
  const agentToolUseId = `workflow-agent:${taskId}:${agentId}`
  const pending = {
    activeSubagents: new Set<string>([agentToolUseId]),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowTasks: new Map([
      [
        taskId,
        {
          taskId,
          workflowName: 'lagged-workflow',
          description: '',
          prompt: '',
          monitor: {
            startedCount: 0,
            flush: async () => undefined,
            drain: async () => undefined,
            stop: async () => undefined,
            activeAgentIds: () => [],
          },
          aggregateStarted: false,
          terminal: false,
        },
      ],
    ]),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  await handleSystem.call(runtime, pending, {
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    summary: 'Lagged workflow completed',
  })

  const result = events.find(
    (event) => event.type === 'tool_result' && event.toolUseId === agentToolUseId,
  )
  assert.equal(result?.isError, false)
  assert.equal(pending.activeSubagents.has(agentToolUseId), false)
  assert.equal(
    events.some((event) => event.toolUseId === `workflow-task:${taskId}`),
    false,
  )
})

test('native SDK runtime bounds terminal workflow monitor flushes', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  let stopCalls = 0
  const taskId = 'blocked-flush-workflow-task'
  const pending = {
    activeSubagents: new Set<string>(),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowTasks: new Map([
      [
        taskId,
        {
          taskId,
          toolUseId: 'blocked-flush-workflow-launch',
          workflowName: 'blocked-flush-workflow',
          description: '',
          prompt: '',
          monitor: {
            startedCount: 0,
            flush: async () => await new Promise<void>(() => {}),
            drain: async () => undefined,
            stop: async () => {
              stopCalls += 1
            },
            activeAgentIds: () => [],
          },
          aggregateStarted: false,
          terminal: false,
        },
      ],
    ]),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  const completed = await Promise.race([
    handleSystem
      .call(runtime, pending, {
        subtype: 'task_notification',
        task_id: taskId,
        status: 'completed',
        summary: 'Blocked flush workflow completed',
      })
      .then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ])

  assert.equal(completed, true)
  assert.equal(events.filter((event) => event.toolUseId === `workflow-task:${taskId}`).length, 2)
  assert.equal(stopCalls, 1, 'terminal fallback must stop its journal monitor before aggregation')
})

test('native SDK runtime closes projected workflow agents when workflow monitoring stops', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const taskId = 'stopped-workflow-task'
  const agentId = 'efefefef181818181'
  const agentToolUseId = `workflow-agent:${taskId}:${agentId}`
  const pending = {
    activeSubagents: new Set<string>([agentToolUseId]),
    failedSubagentCalls: new Set<string>(),
    completedWorkflowTasks: new Set<string>(),
    workflowTasks: new Map([
      [
        taskId,
        {
          taskId,
          toolUseId: 'stopped-workflow-launch',
          workflowName: 'stopped-workflow',
          description: '',
          prompt: '',
          monitor: {
            startedCount: 0,
            flush: async () => undefined,
            drain: async () => undefined,
            stop: async () => undefined,
            activeAgentIds: () => [],
          },
          aggregateStarted: false,
          terminal: false,
        },
      ],
    ]),
    handlers: { onEvent: async (event: unknown) => events.push(event) },
  }
  const stopWorkflowTasks = Reflect.get(runtime, 'stopWorkflowTasks')

  await stopWorkflowTasks.call(runtime, pending)

  const result = events.find(
    (event) => event.type === 'tool_result' && event.toolUseId === agentToolUseId,
  )
  assert.equal(result?.isError, true)
  assert.equal(pending.activeSubagents.has(agentToolUseId), false)
})

test('workflow journal monitor reads the final assistant transcript when result is empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-empty-workflow-result-'))
  const runId = 'wf_empty_result_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'abababab202020202'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    [
      JSON.stringify({ message: { role: 'user', content: 'Reply ok' } }),
      JSON.stringify({
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      }),
      '',
    ].join('\n'),
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    [
      JSON.stringify({ type: 'started', key: 'empty-result-key', agentId }),
      JSON.stringify({ type: 'result', key: 'empty-result-key', agentId, result: '' }),
      '',
    ].join('\n'),
  )

  const results: Array<{ content: string; isError: boolean }> = []
  const monitor = new WorkflowJournalMonitor({
    launch: {
      taskId: 'empty-result-task',
      workflowName: 'empty-result-workflow',
      runId,
      transcriptDir,
      transcriptRoot: root,
      summary: '',
    },
    onStarted: async () => {},
    onResult: async (result) => {
      results.push(result)
    },
  })

  try {
    await monitor.flush()
    assert.equal(results.length, 1)
    assert.equal(results[0]?.content, `ok\nagentId: ${agentId}`)
    assert.equal(results[0]?.isError, false)
  } finally {
    await monitor.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('workflow journal monitor does not commit started bookkeeping after stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-stopped-workflow-monitor-'))
  const runId = 'wf_stopped_monitor_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  const agentId = 'cdcdcdcd161616161'
  await mkdir(transcriptDir, { recursive: true })
  await writeFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    `${JSON.stringify({ message: { role: 'user', content: 'Stop race prompt' } })}\n`,
  )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'stop-race-key', agentId })}\n`,
  )

  let enterStarted!: () => void
  let releaseStarted!: () => void
  const entered = new Promise<void>((resolve) => {
    enterStarted = resolve
  })
  const release = new Promise<void>((resolve) => {
    releaseStarted = resolve
  })
  const monitor = new WorkflowJournalMonitor({
    launch: {
      taskId: 'stopped-monitor-task',
      workflowName: 'stopped-monitor-workflow',
      runId,
      transcriptDir,
      transcriptRoot: root,
      summary: '',
    },
    onStarted: async () => {
      enterStarted()
      await release
    },
    onResult: async () => {},
  })

  try {
    const flush = monitor.flush()
    await entered
    await monitor.stop(10)
    releaseStarted()
    await flush
    assert.equal(monitor.startedCount, 0)
  } finally {
    releaseStarted()
    await monitor.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('native SDK permission allow result carries original input for SDK validation', async () => {
  const runtime = new NativeClaudeRuntime()
  const input = { command: 'printf ok' }
  const requests: unknown[] = []
  const context = { threadId: 'thread', turnId: 'turn' }
  const current = {
    context,
    resolved: false,
    handlers: {
      onPermissionRequest: async (event: unknown) => {
        requests.push(event)
        return { decision: 'accept' }
      },
    },
  }

  const makeCanUseTool = Reflect.get(runtime, 'makeCanUseTool')
  assert.equal(typeof makeCanUseTool, 'function')
  const canUseTool = makeCanUseTool.call(runtime, () => ({ current, lastContext: context }))
  const result = await canUseTool('Bash', input, {
    toolUseID: 'tool',
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { behavior: 'allow', updatedInput: input })
  assert.equal(requests.length, 1)
})

test('native SDK approvals carry why Claude asks and how the user answered', async () => {
  const runtime = new NativeClaudeRuntime()
  const requests: any[] = []
  const decisions: string[] = []
  const context = { threadId: 'thread', turnId: 'turn' }
  const current = {
    context,
    resolved: false,
    handlers: {
      onPermissionRequest: async (event: unknown) => {
        requests.push(event)
        return { decision: decisions.shift() }
      },
    },
  }
  const makeCanUseTool = Reflect.get(runtime, 'makeCanUseTool')
  const canUseTool = makeCanUseTool.call(runtime, () => ({ current, lastContext: context }))
  const signal = new AbortController().signal

  // Decline refuses only this call; cancel also stops the turn.
  decisions.push('decline', 'cancel')
  assert.deepEqual(
    await canUseTool('Bash', { command: 'rm -rf build' }, { toolUseID: 'tool-1', signal }),
    { behavior: 'deny', message: 'declined by user' },
  )
  assert.deepEqual(
    await canUseTool('Bash', { command: 'rm -rf build' }, { toolUseID: 'tool-2', signal }),
    { behavior: 'deny', message: 'cancelled by user', interrupt: true },
  )
  assert.equal(requests[0].reason, null)
  assert.equal(requests[0].mcpServer, null)
  assert.equal(requests[0].suppressSessionApproval, undefined)

  decisions.push('accept')
  await canUseTool(
    'mcp__docs__lookup',
    { query: 'claude codex' },
    {
      toolUseID: 'tool-3',
      signal,
      decisionReason: ' Matches an ask rule ',
      title: 'Claude wants to use lookup',
      blockedPath: '/repo/notes.md',
      mcpServer: { name: 'Docs Server', source: 'project' },
      suppressAlwaysAllowRule: true,
    },
  )
  assert.equal(requests[2].toolUseId, 'tool-3')
  assert.equal(requests[2].reason, 'Matches an ask rule')
  assert.equal(requests[2].title, 'Claude wants to use lookup')
  assert.equal(requests[2].blockedPath, '/repo/notes.md')
  assert.equal(requests[2].mcpServer, 'Docs Server')
  assert.equal(requests[2].suppressSessionApproval, true)
})

test('native SDK approvals pass on Claude suggestions and apply the changes the user chose', async () => {
  const runtime = new NativeClaudeRuntime()
  const requests: any[] = []
  const decisions: unknown[] = []
  const context = { threadId: 'thread', turnId: 'turn' }
  const current = {
    context,
    resolved: false,
    handlers: {
      onPermissionRequest: async (event: unknown) => {
        requests.push(event)
        return decisions.shift()
      },
    },
  }
  const makeCanUseTool = Reflect.get(runtime, 'makeCanUseTool')
  const canUseTool = makeCanUseTool.call(runtime, () => ({ current, lastContext: context }))
  const signal = new AbortController().signal
  const input = { command: 'npm test' }
  const local = {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
    behavior: 'allow',
    destination: 'localSettings',
  }
  const session = { type: 'addDirectories', directories: ['/repo/docs'], destination: 'session' }
  const user = { ...local, destination: 'userSettings' }
  const project = { ...local, destination: 'projectSettings' }

  // The well-formed suggestions reach the approval; a call without any has
  // none.
  decisions.push({ decision: 'accept' })
  await canUseTool('Bash', input, {
    toolUseID: 'tool-1',
    signal,
    suggestions: [local, null, { type: 'addRules' }, session],
  })
  assert.deepEqual(requests[0].suggestions, [local, session])
  decisions.push({ decision: 'accept' })
  await canUseTool('Bash', input, { toolUseID: 'tool-2', signal })
  assert.equal('suggestions' in requests[1], false)

  // Claude Code applies what the user chose, to the project's local settings
  // and the session only; a plain approval applies nothing.
  decisions.push({
    decision: 'acceptForSession',
    updatedPermissions: [local, user, project, session],
  })
  assert.deepEqual(
    await canUseTool('Bash', input, { toolUseID: 'tool-3', signal, suggestions: [local] }),
    { behavior: 'allow', updatedInput: input, updatedPermissions: [local, session] },
  )
  decisions.push({ decision: 'accept', updatedPermissions: [user] })
  assert.deepEqual(await canUseTool('Bash', input, { toolUseID: 'tool-4', signal }), {
    behavior: 'allow',
    updatedInput: input,
  })

  // A call only the user may answer grants no more than itself.
  decisions.push({ decision: 'accept', updatedPermissions: [local] })
  assert.deepEqual(
    await canUseTool('Bash', input, {
      toolUseID: 'tool-5',
      signal,
      requiresUserInteraction: true,
      suggestions: [local],
    }),
    { behavior: 'allow', updatedInput: input },
  )
})

test('native SDK auto-denials decline the call and say why', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = { handlers: { onEvent: async (event: unknown) => events.push(event) } }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  await handleSystem.call(runtime, pending, {
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    decision_reason_type: 'rule',
    decision_reason: 'matches a deny rule',
    message: 'Permission to use Bash has been denied.',
  })
  await handleSystem.call(runtime, pending, { subtype: 'permission_denied', tool_name: 'Write' })

  assert.deepEqual(events, [
    { type: 'tool_denied', toolUseId: 'tool-1' },
    {
      type: 'notice',
      level: 'warning',
      message: 'Permission denied for Bash: matches a deny rule',
    },
    { type: 'notice', level: 'warning', message: 'Permission denied for Write' },
  ])
})

test('native SDK classifier denials become a denied auto review of the call', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: any[] = []
  const pending = { handlers: { onEvent: async (event: unknown) => events.push(event) } }
  const handleSystem = Reflect.get(runtime, 'handleSystem')

  await handleSystem.call(runtime, pending, {
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'tool-1',
    decision_reason_type: 'classifier',
    decision_reason: ' Deleting the build directory was not requested. ',
    message: 'Permission to use Bash has been denied.',
  })
  await handleSystem.call(runtime, pending, {
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'tool-2',
    decision_reason_type: 'classifier',
    message: 'Permission to use Bash has been denied.',
  })

  // No notice: the review card says why.
  assert.deepEqual(events, [
    {
      type: 'tool_denied',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      autoReview: { rationale: 'Deleting the build directory was not requested.' },
    },
    {
      type: 'tool_denied',
      toolUseId: 'tool-2',
      toolName: 'Bash',
      autoReview: { rationale: 'Permission to use Bash has been denied.' },
    },
  ])
})

test('native SDK sessions always launch in an explicit permission mode', () => {
  const previous = process.env.CLAUDE_CODEX_PERMISSION_MODE
  delete process.env.CLAUDE_CODEX_PERMISSION_MODE
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const launch = (overrides: Partial<RuntimeTurnContext>): unknown =>
    buildOptions.call(runtime, {}, nativeTurnContext(overrides), new AbortController(), () => null)
      .permissionMode
  try {
    assert.equal(launch({}), 'default')
    assert.equal(launch({ approvalPolicy: 'untrusted', sandboxMode: 'read-only' }), 'default')
    assert.equal(
      launch({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }),
      'default',
    )
    assert.equal(
      launch({ approvalPolicy: 'on-failure', sandboxMode: 'workspace-write' }),
      'acceptEdits',
    )
    assert.equal(launch({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' }), 'default')
    assert.equal(launch({ planMode: true, approvalPolicy: 'never' }), 'plan')
    // Auto review switches to auto mode after launch, once the session knows
    // its model supports it.
    assert.equal(
      launch({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write', autoReview: true }),
      'default',
    )
    process.env.CLAUDE_CODEX_PERMISSION_MODE = 'auto'
    assert.equal(launch({ approvalPolicy: 'on-request' }), 'auto')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_PERMISSION_MODE
    else process.env.CLAUDE_CODEX_PERMISSION_MODE = previous
  }
})

test('native SDK asks only the user may answer reach the App in every mode', async () => {
  const runtime = new NativeClaudeRuntime()
  const makeCanUseTool = Reflect.get(runtime, 'makeCanUseTool')
  const requests: any[] = []
  const signal = new AbortController().signal
  const plain = { toolUseID: 'tool', signal }
  const userOnly = { toolUseID: 'tool', signal, requiresUserInteraction: true }
  const ask = (context: RuntimeTurnContext) =>
    makeCanUseTool.call(runtime, () => ({
      current: {
        context,
        resolved: false,
        handlers: {
          onPermissionRequest: async (event: unknown) => {
            requests.push(event)
            return { decision: 'accept' }
          },
        },
      },
      lastContext: context,
    }))

  // Full access answers any other call itself.
  const fullAccess = nativeTurnContext({
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  })
  assert.deepEqual(await ask(fullAccess)('Bash', { command: 'true' }, plain), { behavior: 'allow' })
  assert.equal(requests.length, 0)
  assert.deepEqual(await ask(fullAccess)('Bash', { command: 'git push' }, userOnly), {
    behavior: 'allow',
    updatedInput: { command: 'git push' },
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].requiresUser, true)

  // A read of a readable root needs no approval, unless only the user may
  // answer it.
  const readable = nativeTurnContext({
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    readableRoots: [process.cwd()],
  })
  const file = { file_path: join(process.cwd(), 'package.json') }
  assert.deepEqual(await ask(readable)('Read', file, plain), { behavior: 'allow' })
  assert.equal(requests.length, 1)
  await ask(readable)('Read', file, userOnly)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].requiresUser, true)

  // Between turns no standing policy answers it.
  const between = makeCanUseTool.call(runtime, () => ({ current: null, lastContext: fullAccess }))
  assert.deepEqual(await between('Bash', { command: 'true' }, plain), { behavior: 'allow' })
  assert.equal((await between('Bash', { command: 'git push' }, userOnly)).behavior, 'deny')
  assert.equal(requests.length, 2)
})

test('native SDK permission request between turns falls back to the standing policy', async () => {
  const runtime = new NativeClaudeRuntime()
  const makeCanUseTool = Reflect.get(runtime, 'makeCanUseTool')
  const options = { toolUseID: 'tool', signal: new AbortController().signal }
  const ask = (lastContext: RuntimeTurnContext) =>
    makeCanUseTool.call(runtime, () => ({ current: null, lastContext }))
  assert.deepEqual(
    await ask(nativeTurnContext({ approvalPolicy: 'never' }))('Bash', { command: 'true' }, options),
    { behavior: 'allow' },
  )
  assert.equal(
    (
      await ask(
        nativeTurnContext({ approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }),
      )('Bash', { command: 'true' }, options)
    ).behavior,
    'deny',
  )
  assert.equal(
    (await ask(nativeTurnContext({ approvalPolicy: 'never' }))('AskUserQuestion', {}, options))
      .behavior,
    'deny',
  )
})

test('native SDK plan mode carries ExitPlanMode and AskUserQuestion to the App', async () => {
  const runtime = new NativeClaudeRuntime()
  const makeCanUseTool = Reflect.get(runtime, 'makeCanUseTool')
  const options = { toolUseID: 'exit-1', signal: new AbortController().signal }
  // Full Access must not loosen plan mode.
  const context = nativeTurnContext({
    planMode: true,
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  })
  const events: unknown[] = []
  const questions: unknown[] = []
  const approvals: unknown[] = []
  const current = {
    context,
    resolved: false,
    handlers: {
      onEvent: async (event: unknown) => {
        events.push(event)
      },
      onPermissionRequest: async (event: unknown) => {
        approvals.push(event)
        return { decision: 'accept' }
      },
      onUserInputRequest: async (event: any) => {
        questions.push(event)
        return { answers: { [event.questions[0].id]: { answers: ['API Key'] } } }
      },
    },
  }
  const canUseTool = makeCanUseTool.call(runtime, () => ({ current, lastContext: context }))

  // The finished plan becomes one proposed_plan event; the refusal, without
  // an interrupt, lets the turn complete so the App can offer to implement.
  const plan = '## Plan\n\n1. Inspect\n2. Implement'
  const exit = await canUseTool(
    'ExitPlanMode',
    { plan: `${plan}\n`, planFilePath: '/tmp/plan.md' },
    options,
  )
  assert.equal(exit.behavior, 'deny')
  assert.equal(exit.interrupt, undefined)
  assert.match(exit.message, /delivered to the user/)
  assert.deepEqual(events, [{ type: 'proposed_plan', toolUseId: 'exit-1', text: plan }])

  // No plan text yet: nothing reaches the App.
  const empty = await canUseTool('ExitPlanMode', { plan: '  ' }, options)
  assert.equal(empty.behavior, 'deny')
  assert.match(empty.message, /plan file/)
  assert.equal(events.length, 1)

  // AskUserQuestion still reaches the user.
  const asked = await canUseTool(
    'AskUserQuestion',
    {
      questions: [
        {
          question: 'Which auth?',
          header: 'Auth',
          options: [
            { label: 'OAuth', description: 'Browser sign-in' },
            { label: 'API Key', description: 'Static key' },
          ],
          multiSelect: false,
        },
      ],
    },
    { ...options, toolUseID: 'ask-1' },
  )
  assert.equal(questions.length, 1)
  assert.equal(asked.behavior, 'deny')
  assert.match(asked.message, /API Key/)

  // Anything else that needs an approval is refused without asking.
  const bash = await canUseTool('Bash', { command: 'rm -rf build' }, options)
  assert.equal(bash.behavior, 'deny')
  assert.match(bash.message, /plan mode/)
  assert.equal(approvals.length, 0)

  // Outside plan mode ExitPlanMode is an ordinary approval.
  const plain = { ...current, context: nativeTurnContext({ approvalPolicy: 'on-request' }) }
  const outside = makeCanUseTool.call(runtime, () => ({ current: plain, lastContext: context }))
  assert.equal((await outside('ExitPlanMode', { plan }, options)).behavior, 'allow')
  assert.equal(approvals.length, 1)
  assert.equal(events.length, 1)
})

test('HTTP agent runtime streams agentapi-compatible message updates', async () => {
  let status: 'running' | 'stable' = 'stable'
  let messages: Array<{ id: number; role: 'user' | 'agent'; content: string; time: string }> = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/messages') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ messages }))
      return
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status, agent_type: 'claude' }))
      return
    }
    if (req.method === 'POST' && req.url === '/message') {
      req.resume()
      status = 'running'
      messages.push({ id: 1, role: 'user', content: 'hello', time: new Date().toISOString() })
      setTimeout(() => {
        messages.push({ id: 2, role: 'agent', content: 'hello', time: new Date().toISOString() })
      }, 20)
      setTimeout(() => {
        messages = messages.map((message) =>
          message.id === 2 ? { ...message, content: 'hello world' } : message,
        )
        status = 'stable'
      }, 60)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const runtime = new HttpAgentRuntime({
    kind: 'agentapi',
    baseUrl: `http://127.0.0.1:${address.port}`,
    useSse: false,
    pollIntervalMs: 20,
    timeoutMs: 2_000,
    sendInterruptRaw: false,
    manageBridge: false,
    modeCommand: 'claude-codex-mode',
  })
  const deltas: string[] = []
  try {
    await runtime.runTurn(
      {
        threadId: 'thread',
        turnId: 'turn',
        prompt: 'hello',
        cwd: process.cwd(),
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
        approvalPolicy: null,
        sandboxMode: null,
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') deltas.push(event.delta)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  assert.equal(deltas.join(''), 'hello world')
})

test('HTTP agent runtime uses one managed bridge URL per cwd/model key', async () => {
  async function startServer(
    label: string,
  ): Promise<{ url: string; close: () => Promise<void>; prompts: string[] }> {
    const prompts: string[] = []
    let messages: Array<{ id: number; role: 'assistant'; content: string; time: string }> = []
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/messages') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(messages))
        return
      }
      if (req.method === 'GET' && req.url === '/status') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ status: 'stable' }))
        return
      }
      if (req.method === 'POST' && req.url === '/message') {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          prompts.push(body)
          messages = [
            {
              id: 1,
              role: 'assistant',
              content: `answer from ${label}`,
              time: new Date().toISOString(),
            },
          ]
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.statusCode = 404
      res.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    return {
      url: `http://127.0.0.1:${address.port}`,
      prompts,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  const a = await startServer('a')
  const b = await startServer('b')
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-bridge-test-'))
  const cwdA = join(tmp, 'a')
  const cwdB = join(tmp, 'b')
  await mkdir(cwdA)
  await mkdir(cwdB)
  const modeCommand = join(tmp, 'mode-command.mjs')
  await writeFile(
    modeCommand,
    [
      '#!/usr/bin/env node',
      `const urls = new Map(${JSON.stringify([
        [cwdA, a.url],
        [cwdB, b.url],
      ])});`,
      'const cwd = process.argv[5];',
      'const url = urls.get(cwd);',
      'if (!url) { console.error(`unknown cwd: ${cwd}`); process.exit(2); }',
      'console.log(`CLAUDE_CODEX_BRIDGE_URL=${url}`);',
    ].join('\n'),
  )
  await chmod(modeCommand, 0o755)

  const runtime = new HttpAgentRuntime({
    kind: 'agent-http',
    baseUrl: 'http://127.0.0.1:9',
    useSse: false,
    pollIntervalMs: 20,
    timeoutMs: 2_000,
    sendInterruptRaw: false,
    manageBridge: true,
    modeCommand,
  })
  const run = async (cwd: string, prompt: string): Promise<string> => {
    const deltas: string[] = []
    await runtime.runTurn(
      {
        threadId: `thread-${prompt}`,
        turnId: `turn-${prompt}`,
        prompt,
        cwd,
        runtimeType: null,
        model: 'opus',
        effort: null,
        claudeSessionId: null,
        forkSession: false,
        mcpServers: null,
        allowedTools: null,
        addDirs: [],
        enableFileCheckpointing: false,
        outputFormat: null,
        approvalPolicy: null,
        sandboxMode: null,
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') deltas.push(event.delta)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    return deltas.join('')
  }

  try {
    const [answerA, answerB] = await Promise.all([run(cwdA, 'a'), run(cwdB, 'b')])
    assert.equal(answerA, 'answer from a')
    assert.equal(answerB, 'answer from b')
    assert.equal(a.prompts.length, 1)
    assert.equal(b.prompts.length, 1)
  } finally {
    await a.close()
    await b.close()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('claude-p runtime runs each turn in its own cwd', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-test-'))
  const cwdA = join(tmp, 'a')
  const cwdB = join(tmp, 'b')
  await mkdir(cwdA)
  await mkdir(cwdB)
  const command = join(tmp, 'fake-claude-p.mjs')
  await writeFile(
    command,
    [
      '#!/usr/bin/env node',
      'import { readFileSync } from "node:fs";',
      'const args = process.argv.slice(2);',
      'const input = args[args.indexOf("--input-file") + 1];',
      'const cwdArg = args[args.indexOf("--cwd") + 1];',
      'const prompt = input ? readFileSync(input, "utf8") : "";',
      'console.log(JSON.stringify({ result: `${process.cwd()}|${cwdArg}|${prompt}`, session_id: null, is_error: false }));',
    ].join('\n'),
  )
  await chmod(command, 0o755)
  const runtime = new ClaudePTranscriptRuntime({
    command,
    extraArgs: [],
    // Generous: node cold starts can take seconds when the suite runs in
    // parallel, and the fake answers as soon as it is up.
    timeoutMs: 20_000,
    skipPermissions: false,
    resume: false,
  })
  const run = async (cwd: string, prompt: string): Promise<string> => {
    let text = ''
    await runtime.runTurn(
      {
        threadId: `thread-${prompt}`,
        turnId: `turn-${prompt}`,
        prompt,
        cwd,
        runtimeType: null,
        model: 'opus',
        effort: null,
        claudeSessionId: null,
        forkSession: false,
        mcpServers: null,
        allowedTools: null,
        addDirs: [],
        enableFileCheckpointing: false,
        outputFormat: null,
        approvalPolicy: null,
        sandboxMode: null,
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') text += event.delta
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    return text
  }

  try {
    const [answerA, answerB] = await Promise.all([run(cwdA, 'prompt-a'), run(cwdB, 'prompt-b')])
    const [procCwdA, argCwdA, promptA] = answerA.split('|')
    const [procCwdB, argCwdB, promptB] = answerB.split('|')
    assert.equal(await realpath(procCwdA!), await realpath(cwdA))
    assert.equal(await realpath(argCwdA!), await realpath(cwdA))
    assert.equal(promptA, 'prompt-a')
    assert.equal(await realpath(procCwdB!), await realpath(cwdB))
    assert.equal(await realpath(argCwdB!), await realpath(cwdB))
    assert.equal(promptB, 'prompt-b')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('claude-p runtime turns auto-memory off only for threads the memories mapping keeps from it', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-memory-test-'))
  const command = join(tmp, 'fake-claude-p.mjs')
  await writeFile(
    command,
    [
      '#!/usr/bin/env node',
      'const value = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? "unset";',
      'console.log(JSON.stringify({ result: value, session_id: null, is_error: false }));',
    ].join('\n'),
  )
  await chmod(command, 0o755)
  const runtime = new ClaudePTranscriptRuntime({
    command,
    extraArgs: [],
    timeoutMs: 20_000,
    skipPermissions: false,
    resume: false,
  })
  const run = async (autoMemory: boolean | undefined): Promise<string> => {
    let text = ''
    await runtime.runTurn(
      nativeTurnContext({
        threadId: `thread-${String(autoMemory)}`,
        cwd: tmp,
        ...(autoMemory === undefined ? {} : { autoMemory }),
      }),
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') text += event.delta
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    return text
  }
  const previous = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  try {
    // Without the mapping (undefined) the CLI gets nothing extra.
    assert.deepEqual(await Promise.all([run(undefined), run(false), run(true)]), [
      'unset',
      '1',
      'unset',
    ])
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previous
    await rm(tmp, { recursive: true, force: true })
  }
})

test('claude-p runtime passes the auto-compact window only when the thread has one', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-compact-test-'))
  const command = join(tmp, 'fake-claude-p.mjs')
  await writeFile(
    command,
    [
      '#!/usr/bin/env node',
      'const value = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "unset";',
      'console.log(JSON.stringify({ result: value, session_id: null, is_error: false }));',
    ].join('\n'),
  )
  await chmod(command, 0o755)
  const runtime = new ClaudePTranscriptRuntime({
    command,
    extraArgs: [],
    timeoutMs: 20_000,
    skipPermissions: false,
    resume: false,
  })
  const run = async (autoCompactWindow: number | null): Promise<string> => {
    let text = ''
    await runtime.runTurn(
      nativeTurnContext({
        threadId: `thread-${String(autoCompactWindow)}`,
        cwd: tmp,
        autoCompactWindow,
      }),
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') text += event.delta
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    return text
  }
  const previous = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  try {
    assert.deepEqual(await Promise.all([run(null), run(180_000)]), ['unset', '180000'])
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previous
    await rm(tmp, { recursive: true, force: true })
  }
})

test('claude-p runtime keeps the tools a thread must not have from Claude', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-tools-test-'))
  const command = join(tmp, 'fake-claude-p.mjs')
  await writeFile(
    command,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);',
      'const result = JSON.stringify({ allowed: flag("--allowedTools"), disallowed: flag("--disallowedTools") });',
      'console.log(JSON.stringify({ result, session_id: null, is_error: false }));',
    ].join('\n'),
  )
  await chmod(command, 0o755)
  const runtime = new ClaudePTranscriptRuntime({
    command,
    extraArgs: [],
    timeoutMs: 20_000,
    skipPermissions: false,
    resume: false,
  })
  const run = async (
    name: string,
    overrides: Partial<RuntimeTurnContext>,
  ): Promise<{ allowed: string | null; disallowed: string | null }> => {
    let text = ''
    await runtime.runTurn(
      nativeTurnContext({ threadId: `thread-${name}`, cwd: tmp, ...overrides }),
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') text += event.delta
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
    return JSON.parse(text)
  }
  try {
    const [readOnly, readOnlyOff, allowList, onlyDenied] = await Promise.all([
      run('read-only', { sandboxMode: 'read-only' }),
      // Web search off on a read-only thread: WebSearch is neither
      // pre-approved nor left to Claude.
      run('read-only-off', {
        sandboxMode: 'read-only',
        disallowedTools: ['WebSearch', 'mcp__docs__search'],
      }),
      run('allow-list', {
        allowedTools: ['WebSearch', 'Bash(git status:*)'],
        disallowedTools: ['WebSearch'],
      }),
      run('only-denied', { allowedTools: ['WebSearch'], disallowedTools: ['WebSearch'] }),
    ])
    assert.deepEqual(readOnly, {
      allowed: 'Read,Glob,Grep,WebSearch,WebFetch,TodoWrite,Task',
      disallowed: null,
    })
    assert.deepEqual(readOnlyOff, {
      allowed: 'Read,Glob,Grep,WebFetch,TodoWrite,Task',
      disallowed: 'WebSearch,mcp__docs__search',
    })
    assert.deepEqual(allowList, { allowed: 'Bash(git status:*)', disallowed: 'WebSearch' })
    assert.deepEqual(onlyDenied, { allowed: null, disallowed: 'WebSearch' })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('claude-p runtime timeout terminates spawned process tree', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-timeout-test-'))
  const command = join(tmp, 'hanging-claude-p.mjs')
  const childPidFile = join(tmp, 'child.pid')
  await writeFile(
    command,
    [
      '#!/usr/bin/env node',
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });`,
      `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  )
  await chmod(command, 0o755)
  const runtime = new ClaudePTranscriptRuntime({
    command,
    extraArgs: [],
    // Long enough for a loaded machine to start the fake and its grandchild.
    timeoutMs: 3_000,
    skipPermissions: false,
    resume: false,
  })
  try {
    await assert.rejects(
      runtime.runTurn(
        {
          threadId: 'thread-timeout',
          turnId: 'turn-timeout',
          prompt: 'prompt',
          cwd: tmp,
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
          approvalPolicy: null,
          sandboxMode: null,
          systemPromptAddendum: null,
          planMode: false,
          imageInputs: [],
        },
        {
          onEvent: async () => {},
          onPermissionRequest: async () => ({ decision: 'accept' }),
        },
      ),
      /timed out/,
    )

    const childPid = Number(await readFile(childPidFile, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(processIsAlive(childPid), false)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('claude-p runtime retries an empty StopTimeout once', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-retry-test-'))
  const command = join(tmp, 'flaky-claude-p.mjs')
  const countFile = join(tmp, 'count.txt')
  await writeFile(
    command,
    [
      '#!/usr/bin/env node',
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const countFile = ${JSON.stringify(countFile)};`,
      'const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;',
      'writeFileSync(countFile, String(count + 1));',
      'if (count === 0) { console.error("claude-p: StopTimeout"); process.exit(2); }',
      'console.log(JSON.stringify({ result: "retry-ok", session_id: "session", is_error: false }));',
    ].join('\n'),
  )
  await chmod(command, 0o755)
  const runtime = new ClaudePTranscriptRuntime({
    command,
    extraArgs: [],
    timeoutMs: 2_000,
    skipPermissions: false,
    resume: false,
    stopTimeoutRetries: 1,
  })
  const events: string[] = []
  try {
    await runtime.runTurn(
      {
        threadId: 'thread-retry',
        turnId: 'turn-retry',
        prompt: 'prompt',
        cwd: tmp,
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
        approvalPolicy: null,
        sandboxMode: null,
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: async (event) => {
          if (event.type === 'notice') events.push(event.message)
          if (event.type === 'text_delta') events.push(event.delta)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )

    assert.deepEqual(events, [
      'claude-p did not emit its Stop hook before timing out; retrying attempt 2/2.',
      'retry-ok',
    ])
    assert.equal(await readFile(countFile, 'utf8'), '2')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('claude-p runtime retries a process timeout once', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'claude-codex-claude-p-timeout-retry-test-'))
  const command = join(tmp, 'timeout-then-ok-claude-p.mjs')
  const countFile = join(tmp, 'count.txt')
  await writeFile(
    command,
    [
      '#!/usr/bin/env node',
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const countFile = ${JSON.stringify(countFile)};`,
      'const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;',
      'writeFileSync(countFile, String(count + 1));',
      'if (count === 0) setInterval(() => {}, 1000);',
      'else console.log(JSON.stringify({ result: "timeout-retry-ok", session_id: "session", is_error: false }));',
    ].join('\n'),
  )
  await chmod(command, 0o755)
  const runtime = new ClaudePTranscriptRuntime({
    command,
    extraArgs: [],
    timeoutMs: 2_000,
    skipPermissions: false,
    resume: false,
    stopTimeoutRetries: 1,
  })
  const events: string[] = []
  try {
    await runtime.runTurn(
      {
        threadId: 'thread-timeout-retry',
        turnId: 'turn-timeout-retry',
        prompt: 'prompt',
        cwd: tmp,
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
        approvalPolicy: null,
        sandboxMode: null,
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: async (event) => {
          if (event.type === 'notice') events.push(event.message)
          if (event.type === 'text_delta') events.push(event.delta)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )

    assert.deepEqual(events, [
      'claude-p process timed out; retrying attempt 2/2.',
      'timeout-retry-ok',
    ])
    assert.equal(await readFile(countFile, 'utf8'), '2')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('HTTP agent runtime keeps recoverable SSE fallback out of the conversation', async () => {
  let status: 'running' | 'stable' = 'stable'
  let messages: Array<{ id: number; role: 'agent'; content: string; time: string }> = []
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/messages') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ messages }))
      return
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status }))
      return
    }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message\n')
      res.destroy()
      return
    }
    if (req.method === 'POST' && req.url === '/message') {
      req.resume()
      status = 'running'
      setTimeout(() => {
        messages = [
          { id: 1, role: 'agent', content: 'polling answer', time: new Date().toISOString() },
        ]
        status = 'stable'
      }, 20)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const runtime = new HttpAgentRuntime({
    kind: 'agent-http',
    baseUrl: `http://127.0.0.1:${address.port}`,
    useSse: true,
    pollIntervalMs: 20,
    timeoutMs: 2_000,
    sendInterruptRaw: false,
    manageBridge: false,
    modeCommand: 'claude-codex-mode',
  })
  const deltas: string[] = []
  const notices: string[] = []
  try {
    await runtime.runTurn(
      {
        threadId: 'thread',
        turnId: 'turn',
        prompt: 'hello',
        cwd: process.cwd(),
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
        approvalPolicy: null,
        sandboxMode: null,
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') deltas.push(event.delta)
          if (event.type === 'notice') notices.push(event.message)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  assert.equal(deltas.join(''), 'polling answer')
  assert.deepEqual(notices, [])
})

test('agentapi runtime polls running terminal output before final status-only screen', async () => {
  let status: 'running' | 'stable' = 'stable'
  let messages: Array<{ id: number; role: 'agent'; content: string; time: string }> = []
  let sawRunningScreen = false
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/messages') {
      // The screen settles to a status-only line once the runtime has read
      // the running screen, whatever its poll timing.
      if (status === 'running' && messages.length > 0) sawRunningScreen = true
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ messages }))
      return
    }
    if (req.method === 'GET' && req.url === '/status') {
      if (sawRunningScreen) {
        messages = [
          { id: 1, role: 'agent', content: '✻ Cooked for 1s', time: new Date().toISOString() },
        ]
        status = 'stable'
      } else if (status === 'running') {
        messages = [
          {
            id: 1,
            role: 'agent',
            content: 'TOKEN_FROM_RUNNING_SCREEN',
            time: new Date().toISOString(),
          },
        ]
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status }))
      return
    }
    if (req.method === 'POST' && req.url === '/message') {
      req.resume()
      status = 'running'
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const runtime = new HttpAgentRuntime({
    kind: 'agentapi',
    baseUrl: `http://127.0.0.1:${address.port}`,
    useSse: false,
    pollIntervalMs: 20,
    timeoutMs: 2_000,
    sendInterruptRaw: false,
    manageBridge: false,
    modeCommand: 'claude-codex-mode',
  })
  const deltas: string[] = []
  try {
    await runtime.runTurn(
      {
        threadId: 'thread',
        turnId: 'turn',
        prompt: 'hello',
        cwd: process.cwd(),
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
        approvalPolicy: null,
        sandboxMode: null,
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: (event) => {
          if (event.type === 'text_delta') deltas.push(event.delta)
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  assert.equal(deltas.join(''), 'TOKEN_FROM_RUNNING_SCREEN')
})

test('HTTP agent runtime detects Claude Code trust prompt in agentapi screen output', () => {
  assert.equal(
    hasAgentapiTrustPrompt({
      messages: [
        {
          role: 'agent',
          content:
            'Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\nClaude Code will be able to read, edit, and execute files here.',
        },
      ],
    }),
    true,
  )
  assert.equal(
    hasAgentapiTrustPrompt({
      messages: [
        { role: 'agent', content: 'Welcome back Renee!\nWhat would you like to work on?' },
      ],
    }),
    false,
  )
})

test('agentapi terminal sanitizer removes Claude Code TUI status artifacts', () => {
  assert.equal(
    sanitizeAgentapiTerminalContent(
      '● Hi! What can I help you with today?                                           \n                                                                                \n✻ Worked for 3s                                                                 ',
    ),
    'Hi! What can I help you with today?',
  )
  assert.equal(
    sanitizeAgentapiTerminalContent(
      '* Fluttering...\n└ Tip: Run /install-github-app to tag @claude right from your Github issues\nand PRs',
    ),
    '',
  )
  assert.equal(sanitizeAgentapiTerminalContent('✻ Cooked for 1s'), '')
  assert.equal(sanitizeAgentapiTerminalContent('✻ Crunched for 3s'), '')
  assert.equal(sanitizeAgentapiTerminalContent('✻ Churned for 1s'), '')
  assert.equal(sanitizeAgentapiTerminalContent('✶ Processing…'), '')
  assert.equal(
    sanitizeAgentapiTerminalContent('* Caramelizing… (3s · ↓ 201 tokens · thinking)'),
    '',
  )
  assert.equal(sanitizeAgentapiTerminalContent('· Slithering…'), '')
})

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForCondition(read: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (read() === expected) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(read(), expected)
}

test('native SDK keeps changed and cleared system instructions live on resume', () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  for (const append of ['First instructions', 'Changed instructions', '']) {
    const options = buildOptions.call(
      runtime,
      {},
      nativeTurnContext({ cwd: '', claudeSessionId: 'sdk-session', systemPromptAddendum: append }),
      new AbortController(),
    )
    assert.equal(options.resume, 'sdk-session')
    assert.deepEqual(options.systemPrompt, {
      type: 'preset',
      preset: 'claude_code',
      snapshot: false,
      ...(append ? { append } : {}),
    })
  }
})

test('native SDK sends desktop presentation guidance on fresh and resumed turns', () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const append = buildSystemPromptAddendum({
    baseInstructions: 'Answer in Chinese.',
    developerInstructions: null,
    personality: null,
    desktopPresentation: true,
  })
  assert.ok(append)
  for (const claudeSessionId of [null, 'sdk-session']) {
    const options: { systemPrompt: { append: string } } = buildOptions.call(
      runtime,
      {},
      nativeTurnContext({ cwd: '', claudeSessionId, systemPromptAddendum: append }),
      new AbortController(),
    )
    assert.deepEqual(options.systemPrompt, {
      type: 'preset',
      preset: 'claude_code',
      snapshot: false,
      append,
    })
    assert.match(options.systemPrompt.append, /fenced Mermaid diagrams/)
    assert.match(options.systemPrompt.append, /Answer in Chinese\./)
  }
})
