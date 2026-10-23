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

// A runtime whose thread has no turn running.
function betweenTurns(overrides: Partial<RuntimeTurnContext> = {}) {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'zod', z)
  const listener: RuntimeBackgroundListener = {
    onTaskEvent: () => {},
    onAutonomousTurn: () => {},
    onSessionReleased: () => {},
  }
  runtime.setBackgroundListener(listener)
  const context = turnContext(overrides)
  const session = { threadId: context.threadId, current: null, lastContext: context }
  const buildOptions = Reflect.get(runtime, 'buildOptions')
  const options = buildOptions.call(runtime, sdk, context, new AbortController(), () => session)
  return { options, session }
}

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
