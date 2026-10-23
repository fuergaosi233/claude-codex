import assert from 'node:assert/strict'
import test from 'node:test'
import * as z from 'zod'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeBackgroundListener, RuntimeTurnContext } from '../src/types.mjs'

function turnContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
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
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

const sdk = {
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: unknown, extra: unknown) => Promise<unknown>,
    extras: unknown,
  ) => ({ name, description, schema, handler, extras }),
  createSdkMcpServer: (config: Record<string, unknown>) => ({ type: 'sdk', ...config }),
}

// A runtime whose thread has no turn running, as when a background agent,
// a workflow or a cron job of the thread calls a tool after the turn ended.
function betweenTurns(overrides: Partial<RuntimeTurnContext> = {}) {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'zod', z)
  const notices: Array<{ threadId: string; message: string }> = []
  const listener: RuntimeBackgroundListener = {
    onTaskEvent: () => {},
    onAutonomousTurn: () => {},
    onSessionReleased: () => {},
    onNotice: (threadId, message) => notices.push({ threadId, message }),
  }
  runtime.setBackgroundListener(listener)
  const context = turnContext(overrides)
  const session = { threadId: context.threadId, current: null, lastContext: context }
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const options = buildOptions.call(runtime, sdk, context, new AbortController(), () => session)
  return { options, notices, session }
}

test('a tool call between turns is denied with the reason, and the user hears of it', async () => {
  const { options, notices } = betweenTurns()
  const signal = new AbortController().signal
  const decision = await options.canUseTool('Bash', { command: 'make' }, { signal })
  // Claude reads why, and that the user can run it in a turn; nothing waits.
  assert.deepEqual(decision, {
    behavior: 'deny',
    message:
      'Bash was denied because no user turn was active to ask the user for approval; the user can re-run it in a turn.',
  })
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.threadId, 'thread-1')
  assert.match(notices[0]?.message ?? '', /^Bash was denied: background work asked for it/)
  assert.match(notices[0]?.message ?? '', /new message/)
})

test('a thread whose policy answers for it allows between turns without a notice', async () => {
  const { options, notices } = betweenTurns({
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  })
  const signal = new AbortController().signal
  assert.deepEqual(await options.canUseTool('Bash', { command: 'make' }, { signal }), {
    behavior: 'allow',
  })
  // The goal tools never ask either.
  assert.deepEqual(await options.canUseTool('mcp__codex_goal__get_goal', {}, { signal }), {
    behavior: 'allow',
  })
  assert.deepEqual(notices, [])
})

test('a question between turns still has no answer: the call is denied and noticed', async () => {
  // Full access answers tools, but not a question for the user.
  const { options, notices } = betweenTurns({
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  })
  const signal = new AbortController().signal
  const decision = await options.canUseTool('AskUserQuestion', { questions: [] }, { signal })
  assert.equal(decision.behavior, 'deny')
  assert.match(decision.message, /^AskUserQuestion was denied because no user turn was active/)
  assert.equal(notices.length, 1)
})

test('an MCP elicitation between turns is declined, and the user hears of it', async () => {
  const { options, notices } = betweenTurns()
  const signal = new AbortController().signal
  assert.deepEqual(
    await options.onElicitation({ serverName: 'tracker', message: 'Pick a project' }, { signal }),
    { action: 'decline' },
  )
  assert.deepEqual(notices, [
    {
      threadId: 'thread-1',
      message:
        'tracker asked for your input while no turn was running, so the request was declined. Ask Claude to try again in a new message.',
    },
  ])
})

test('a dynamic tool call between turns is not run, and the user hears of it', async () => {
  const { options, notices } = betweenTurns({
    dynamicTools: [
      {
        server: 'codex_app',
        namespace: 'codex_app',
        description: '',
        tools: [
          {
            name: 'list_artifacts',
            description: 'List artifacts.',
            inputSchema: { type: 'object' },
            deferLoading: false,
          },
        ],
      },
    ],
  })
  const tool = options.mcpServers.codex_app.tools[0]
  const result = await tool.handler({}, { signal: new AbortController().signal })
  assert.deepEqual(result, {
    content: [
      {
        type: 'text',
        text: 'list_artifacts was not run because no user turn was active to answer it; the user can re-run it in a turn.',
      },
    ],
    isError: true,
  })
  assert.equal(notices.length, 1)
  assert.match(notices[0]?.message ?? '', /^list_artifacts was not run: background work called it/)
})

test('the goal and leader tools load up front, never behind tool search', () => {
  const { options } = betweenTurns({
    goalTools: {
      getGoal: async () => '{}',
      createGoal: async () => '{}',
      updateGoal: async () => '{}',
    },
    leaderTools: {
      list: async () => '',
      start: async () => '',
      prompt: async () => '',
      wait: async () => '',
      read: async () => '',
    },
  })
  assert.equal(options.mcpServers.codex_goal.alwaysLoad, true)
  assert.equal(options.mcpServers.codex_leader.alwaysLoad, true)
})
