import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ClaudePTranscriptRuntime } from '../src/claude-p-runtime.mjs'
import {
  HttpAgentRuntime,
  hasAgentapiTrustPrompt,
  sanitizeAgentapiTerminalContent,
} from '../src/http-agent-runtime.mjs'
import { NativeClaudeRuntime, sdkResumeSessionId } from '../src/native-runtime.mjs'
import { resolveRuntimeConfig } from '../src/runtime-config.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'
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

test('native SDK runtime maps manual /workflows prompts to the human workflow trigger', async () => {
  const runtime = new NativeClaudeRuntime()
  const context = nativeTurnContext({
    prompt: '/workflows open three subagents, reply ok',
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  })
  const buildPromptIterable = Reflect.get(runtime, 'buildPromptIterable')
  const messages: any[] = []
  for await (const message of buildPromptIterable.call(runtime, context)) messages.push(message)

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
  const options = buildOptions.call(runtime, {}, context, new AbortController())
  assert.deepEqual(options.settings, {
    enableWorkflows: true,
    workflowKeywordTriggerEnabled: true,
  })
  assert.equal(options.permissionMode, 'default')
  assert.equal(options.allowDangerouslySkipPermissions, undefined)
  assert.equal(typeof options.canUseTool, 'function')
  const turns = Reflect.get(runtime, 'turns') as Map<string, unknown>
  turns.set(context.turnId, { handlers: {} })
  try {
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
  } finally {
    turns.delete(context.turnId)
  }
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
  const buildPromptIterable = Reflect.get(runtime, 'buildPromptIterable')
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
  const messages: any[] = []
  for await (const message of buildPromptIterable.call(runtime, context)) messages.push(message)
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
    activeSubagents: new Set<string>(),
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
  const turns = Reflect.get(runtime, 'turns')
  assert.ok(turns instanceof Map)
  const input = { command: 'printf ok' }
  const requests: unknown[] = []
  turns.set('turn', {
    handlers: {
      onPermissionRequest: async (event: unknown) => {
        requests.push(event)
        return { decision: 'accept' }
      },
    },
  })

  try {
    const makeCanUseTool = Reflect.get(runtime, 'makeCanUseTool')
    assert.equal(typeof makeCanUseTool, 'function')
    const canUseTool = makeCanUseTool.call(runtime, { threadId: 'thread', turnId: 'turn' }, false)
    const result = await canUseTool('Bash', input, {
      toolUseID: 'tool',
      signal: new AbortController().signal,
    })
    assert.deepEqual(result, { behavior: 'allow', updatedInput: input })
    assert.equal(requests.length, 1)
  } finally {
    turns.delete('turn')
  }
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
    timeoutMs: 2_000,
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
    timeoutMs: 1_000,
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
    if (req.method === 'POST' && req.url === '/message') {
      req.resume()
      status = 'running'
      setTimeout(() => {
        messages = [
          {
            id: 1,
            role: 'agent',
            content: 'TOKEN_FROM_RUNNING_SCREEN',
            time: new Date().toISOString(),
          },
        ]
      }, 20)
      setTimeout(() => {
        messages = [
          { id: 1, role: 'agent', content: '✻ Cooked for 1s', time: new Date().toISOString() },
        ]
        status = 'stable'
      }, 80)
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
