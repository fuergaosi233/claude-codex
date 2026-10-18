import assert from 'node:assert/strict'
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Duplex } from 'node:stream'
import test from 'node:test'
import WebSocket from 'ws'
import type { ProviderLoopConfigProjectionResult } from '../src/provider-loop-config.mjs'
import { QUIET_TURN_HEARTBEAT } from '../src/quiet-turns.mjs'
import { SessionStore } from '../src/store.mjs'

const adapter = resolve('dist/src/adapter.mjs')
const shim = resolve('scripts/codex-shim')

test('server dispatch covers current Codex app-server client method surface', async () => {
  const source = await readFile(resolve('src/server.mts'), 'utf8')
  const methods = [
    'initialize',
    'thread/start',
    'thread/resume',
    'thread/fork',
    'thread/archive',
    'thread/unsubscribe',
    'thread/increment_elicitation',
    'thread/decrement_elicitation',
    'thread/name/set',
    'thread/goal/set',
    'thread/goal/get',
    'thread/goal/clear',
    'thread/queue/add',
    'thread/queue/list',
    'thread/queue/update',
    'thread/queue/delete',
    'thread/queue/reorder',
    'thread/queue/start',
    'thread/metadata/update',
    'thread/section/move',
    'threadSection/list',
    'threadSection/create',
    'threadSection/update',
    'threadSection/delete',
    'thread/settings/update',
    'thread/memoryMode/set',
    'memory/reset',
    'thread/unarchive',
    'thread/compact/start',
    'thread/shellCommand',
    'thread/approveGuardianDeniedAction',
    'thread/backgroundTerminals/clean',
    'thread/rollback',
    'thread/list',
    'thread/loaded/list',
    'thread/read',
    'thread/turns/list',
    'thread/turns/items/list',
    'thread/inject_items',
    'skills/list',
    'hooks/list',
    'marketplace/add',
    'marketplace/remove',
    'marketplace/upgrade',
    'plugin/list',
    'plugin/read',
    'plugin/skill/read',
    'plugin/share/save',
    'plugin/share/updateTargets',
    'plugin/share/list',
    'plugin/share/delete',
    'app/list',
    'fs/readFile',
    'fs/writeFile',
    'fs/createDirectory',
    'fs/getMetadata',
    'fs/readDirectory',
    'fs/remove',
    'fs/copy',
    'fs/watch',
    'fs/unwatch',
    'skills/config/write',
    'plugin/install',
    'plugin/uninstall',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'thread/realtime/start',
    'thread/realtime/appendAudio',
    'thread/realtime/appendText',
    'thread/realtime/stop',
    'thread/realtime/listVoices',
    'review/start',
    'model/list',
    'modelProvider/capabilities/read',
    'experimentalFeature/list',
    'permissionProfile/list',
    'experimentalFeature/enablement/set',
    'collaborationMode/list',
    'mock/experimentalMethod',
    'mcpServer/oauth/login',
    'config/mcpServer/reload',
    'mcpServerStatus/list',
    'mcpServer/resource/read',
    'mcpServer/tool/call',
    'windowsSandbox/setupStart',
    'windowsSandbox/readiness',
    'account/login/start',
    'account/login/cancel',
    'account/logout',
    'account/rateLimits/read',
    'account/sendAddCreditsNudgeEmail',
    'feedback/upload',
    'command/exec',
    'command/exec/write',
    'command/exec/terminate',
    'command/exec/resize',
    'process/spawn',
    'process/writeStdin',
    'process/kill',
    'process/resizePty',
    'config/read',
    'externalAgentConfig/detect',
    'externalAgentConfig/import',
    'config/value/write',
    'config/batchWrite',
    'configRequirements/read',
    'account/read',
    'getConversationSummary',
    'gitDiffToRemote',
    'getAuthStatus',
    'fuzzyFileSearch',
    'fuzzyFileSearch/sessionStart',
    'fuzzyFileSearch/sessionUpdate',
    'fuzzyFileSearch/sessionStop',
  ]
  const missing = methods.filter((method) => !source.includes(`case '${method}':`))
  assert.deepEqual(missing, [])
})

test('stdio initialize -> thread/start -> turn/start streams mock response', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    const init = await reader.nextResponse(1)
    assert.equal(init.result.platformFamily, process.platform === 'win32' ? 'windows' : 'unix')

    proc.stdin.write(
      json({ id: 4, method: 'permissionProfile/list', params: { limit: 100, cursor: null } }),
    )
    const permissionProfiles = await reader.nextResponse(4)
    assert.deepEqual(permissionProfiles.result.data, [
      { id: ':read-only', description: null, allowed: true },
      { id: ':workspace', description: null, allowed: true },
      { id: ':danger-full-access', description: null, allowed: true },
    ])
    assert.equal(permissionProfiles.result.nextCursor, null)

    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id
    assert.equal(start.result.modelProvider, 'claude-code')
    assert.equal(start.result.thread.isPinned, false)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
      }),
    )
    const turnStart = await reader.nextResponse(3)
    assert.equal(turnStart.result.turn.status, 'inProgress')

    const deltas: string[] = []
    let sawAgentCompleted = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') deltas.push(message.params.delta)
      if (message.method === 'item/completed' && message.params.item.type === 'agentMessage')
        sawAgentCompleted = true
      if (message.method === 'turn/completed') break
    }
    assert.match(deltas.join(''), /Claude Code adapter mock response/)
    assert.equal(sawAgentCompleted, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('permission profile selection applies full access without legacy sandbox fields', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'codex-test', version: '26.818' }, capabilities: null },
      }),
    )
    await reader.nextResponse(1)
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), permissions: ':danger-full-access' },
      }),
    )
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id
    assert.equal(start.result.approvalPolicy, 'never')
    assert.equal(start.result.sandbox.type, 'dangerFullAccess')
    assert.deepEqual(start.result.activePermissionProfile, {
      id: ':danger-full-access',
      extends: null,
    })
    assert.equal(start.result.permissions, ':danger-full-access')

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
          permissions: ':danger-full-access',
        },
      }),
    )
    await reader.nextResponse(3)
    let sawApprovalRequest = false
    let sawCommandOutput = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/commandExecution/requestApproval') sawApprovalRequest = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawCommandOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawApprovalRequest, false)
    assert.equal(sawCommandOutput, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('run registry records thread and turn lifecycle without raw prompt or response text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const runLog = join(home, 'runs.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_RUN_LOG: runLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    await reader.nextResponse(1)
    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'secret prompt token=secret123456789', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(3)
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    const logText = await readFile(runLog, 'utf8')
    const entries = logText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.deepEqual(
      entries.map((entry) => entry.event),
      ['thread.started', 'turn.started', 'turn.completed'],
    )
    assert.equal(logText.includes('secret prompt'), false)
    assert.equal(logText.includes('Claude Code adapter mock response'), false)
    assert.equal(
      entries.every((entry) => entry.threadId === threadId),
      true,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('primary turn lifecycle keeps lightweight notLoaded envelopes', async () => {
  // turn/start and turn/started are metadata-only. Primary-thread completion
  // remains item-stream driven here; subagent completion is covered separately
  // because its terminal envelope must carry the final response for review UI.
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    await reader.nextResponse(1)
    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
      }),
    )
    const turnStart = await reader.nextResponse(3)
    assert.deepEqual(turnStart.result.turn.items, [], 'turn/start response items must be empty')
    assert.equal(turnStart.result.turn.itemsView, 'notLoaded')

    let started = null
    let completed = null
    let userMessageItemEvent = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/started') started = message.params.turn
      if (
        (message.method === 'item/started' || message.method === 'item/completed') &&
        message.params.item?.type === 'userMessage'
      ) {
        userMessageItemEvent = true
      }
      if (message.method === 'turn/completed') {
        completed = message.params.turn
        break
      }
    }
    assert.ok(started, 'expected turn/started')
    assert.deepEqual(started.items, [], 'turn/started items must be empty')
    assert.equal(started.itemsView, 'notLoaded')
    assert.ok(completed, 'expected turn/completed')
    assert.deepEqual(completed.items, [], 'turn/completed items must be empty')
    assert.equal(completed.itemsView, 'notLoaded')
    // Lifecycle turn envelopes must not carry non-schema fields.
    assert.ok(!('apiDurationMs' in completed), 'Turn schema has no apiDurationMs')
    assert.ok(!('costUsd' in completed), 'Turn schema has no costUsd')
    // The real app-server does not emit a userMessage item event during a turn.
    assert.equal(userMessageItemEvent, false, 'userMessage must not be emitted as an item event')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/turns/list honors default summary and explicit itemsView', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    proc.stdin.write(json({ id: 3, method: 'thread/turns/list', params: { threadId } }))
    const summary = await reader.nextResponse(3)
    const summaryTurn = summary.result.data[0]
    assert.equal(summaryTurn.itemsView, 'summary')
    assert.deepEqual(
      summaryTurn.items.map((item: Record<string, unknown>) => item.type),
      ['userMessage', 'agentMessage'],
    )

    proc.stdin.write(
      json({ id: 4, method: 'thread/turns/list', params: { threadId, itemsView: 'notLoaded' } }),
    )
    const notLoaded = await reader.nextResponse(4)
    assert.equal(notLoaded.result.data[0].itemsView, 'notLoaded')
    assert.deepEqual(notLoaded.result.data[0].items, [])

    proc.stdin.write(
      json({ id: 5, method: 'thread/turns/list', params: { threadId, itemsView: 'full' } }),
    )
    const full = await reader.nextResponse(5)
    const fullTurn = full.result.data[0]
    assert.equal(fullTurn.itemsView, 'full')
    assert.ok(fullTurn.items.length >= summaryTurn.items.length)
    assert.ok(fullTurn.items.some((item: Record<string, unknown>) => item.type === 'userMessage'))
    assert.ok(fullTurn.items.some((item: Record<string, unknown>) => item.type === 'agentMessage'))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcpServerStatus/list and startup notifications use conformant Codex v2 shapes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        github: { type: 'stdio', command: 'github-mcp' },
      }),
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    // Boot-time startup notification: correct method + valid McpServerStartupState.
    // The boot notifications are flushed via queueMicrotask, so they can land
    // before the initialize response — scan every message rather than reading
    // (and discarding) the response first.
    let startup = null
    let sawInit = false
    for (let i = 0; i < 50; i += 1) {
      const message = await reader.next()
      if (message.method === 'mcpServer/startupStatus/updated') startup = message.params
      if (message.id === 1 && message.method == null) sawInit = true
      if (startup && sawInit) break
    }
    assert.ok(startup, 'expected mcpServer/startupStatus/updated notification')
    assert.equal(startup.name, 'github')
    assert.ok(
      ['starting', 'ready', 'failed', 'cancelled'].includes(startup.status),
      `invalid startup state ${startup.status}`,
    )

    proc.stdin.write(json({ id: 2, method: 'mcpServerStatus/list', params: {} }))
    const list = await reader.nextResponse(2)
    const entry = list.result.data[0]
    assert.equal(entry.name, 'github')
    // McpServerStatus = { name, tools: map, resources: [], resourceTemplates: [], authStatus }
    assert.deepEqual(entry.tools, {})
    assert.deepEqual(entry.resources, [])
    assert.deepEqual(entry.resourceTemplates, [])
    assert.ok(['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(entry.authStatus))
    assert.ok(!('status' in entry), 'McpServerStatus has no startup status field')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/start with a gpt-* model marks the thread runtimeBackend=codex', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    // Claude model → claude backend.
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const claudeStart = await reader.nextResponse(1)
    assert.equal(claudeStart.result.model, 'sonnet')

    // Codex/OpenAI model → codex backend. The detection lives in
    // thread/start (isCodexOpenAiModel) so the choice round-trips through
    // thread/resume and survives a daemon restart.
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'gpt-5.4-mini' },
      }),
    )
    const codexStart = await reader.nextResponse(2)
    assert.equal(codexStart.result.model, 'gpt-5.4-mini')

    // Cross-backend model change on resume must be refused — the conversation
    // history wouldn't transfer between Claude SDK and codex exec.
    const codexId = codexStart.result.thread.id
    proc.stdin.write(
      json({ id: 3, method: 'thread/resume', params: { threadId: codexId, model: 'opus' } }),
    )
    const resumed = await reader.nextResponse(3)
    assert.equal(
      resumed.result.model,
      'gpt-5.4-mini',
      'resume must reject cross-backend model flip',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('model/list exposes Claude model aliases and Codex-safe reasoning efforts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
      CLAUDE_CODEX_DEFAULT_EFFORT: 'xhigh',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(1)
    assert.equal(config.result.config.model, 'opus')
    assert.equal(config.result.config.model_reasoning_effort, 'xhigh')
    assert.equal(config.result.config.model_provider, 'claude-code')
    assert.equal(config.result.config.model_providers['claude-code'].name, 'Claude Code')
    assert.equal(config.result.config.model_providers['claude-code'].requires_openai_auth, false)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult
    assert.deepEqual(
      providerLoopConfig.providers.map((provider) => provider.id),
      ['claude-code', 'codex'],
    )
    assert.deepEqual(providerLoopConfig.issues, [])
    const claudeCodeProvider = providerLoopConfig.providers.find(
      (provider) => provider.id === 'claude-code',
    )
    assert.ok(claudeCodeProvider)
    assert.equal(claudeCodeProvider.loopId, 'native-claude-code-sdk')
    assert.equal(claudeCodeProvider.providerFamily, 'anthropic')
    assert.equal(claudeCodeProvider.status, 'stable')
    assert.equal(claudeCodeProvider.supportsSteer, true)
    const allowedCredentialSources = new Set<string>(claudeCodeProvider.allowedCredentialSources)
    assert.equal(allowedCredentialSources.has('user-api-key'), true)
    assert.equal(allowedCredentialSources.has('personal-session'), false)
    assert.equal(allowedCredentialSources.has('browser-cookie'), false)

    proc.stdin.write(json({ id: 7, method: 'account/read', params: {} }))
    const account = await reader.nextResponse(7)
    assert.deepEqual(account.result.account, { type: 'amazonBedrock' })
    assert.equal(account.result.requiresOpenaiAuth, false)

    // The App's main process reads its flags only under the auth method it
    // derives from account/read.
    proc.stdin.write(json({ id: 8, method: 'getAuthStatus', params: {} }))
    const authStatus = await reader.nextResponse(8)
    assert.deepEqual(authStatus.result, {
      authMethod: 'amazonBedrock',
      authToken: null,
      requiresOpenaiAuth: false,
    })

    proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
    const models = await reader.nextResponse(2)
    const ids = models.result.data.map((model: any) => model.id)
    assert.equal(ids.includes('sonnet'), true)
    assert.equal(ids.includes('opus'), true)
    assert.equal(ids.includes('fable'), true)
    assert.equal(ids.includes('sonnet-1m'), true)
    assert.equal(ids.includes('opus-plan'), true)
    const fable = models.result.data.find((model: any) => model.id === 'fable')
    assert.equal(fable.displayName, 'Claude Fable')
    const opusPlan = models.result.data.find((model: any) => model.id === 'opus-plan')
    assert.match(opusPlan.displayName, /Opus.*Sonnet/)
    assert.match(opusPlan.description, /plan/i)
    assert.match(opusPlan.description, /Sonnet/)
    assert.equal(
      ids.some((id: string) => id.startsWith('runtime-')),
      false,
    )
    const opus = models.result.data.find((model: any) => model.id === 'opus')
    assert.equal(opus.isDefault, true)
    assert.equal('serviceTiers' in opus, false)
    assert.equal(models.result.data.filter((model: any) => model.isDefault === true).length, 1)
    assert.deepEqual(
      opus.supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort),
      ['low', 'medium', 'high', 'xhigh'],
    )

    proc.stdin.write(
      json({
        id: 3,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'haiku', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await reader.nextResponse(3)
    proc.stdin.write(json({ id: 4, method: 'config/read', params: {} }))
    const updatedConfig = await reader.nextResponse(4)
    assert.equal(updatedConfig.result.config.model, 'haiku')
    assert.equal(updatedConfig.result.config.model_reasoning_effort, 'low')

    proc.stdin.write(
      json({
        id: 5,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'runtime-agent-http', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'medium', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await reader.nextResponse(5)
    proc.stdin.write(json({ id: 6, method: 'config/read', params: {} }))
    const repairedConfig = await reader.nextResponse(6)
    assert.equal(repairedConfig.result.config.model, 'haiku')
    assert.equal(repairedConfig.result.config.model_reasoning_effort, 'medium')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/read exposes sanitized provider loop selection over stdio', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_PROVIDER: 'codex',
      CLAUDE_CODEX_AGENT_LOOP: 'codex-jsonl-proxy',
      CLAUDE_CODEX_RUNTIME_TYPE: '',
      CLAUDE_CODEX_RUNTIME: '',
      CLAUDE_CODEX_BACKEND: '',
      CLAUDE_CODEX_MOCK: '',
      CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(1)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult

    assert.deepEqual(
      providerLoopConfig.providers.map((provider) => provider.id),
      ['claude-code', 'codex'],
    )
    assert.deepEqual(providerLoopConfig.selection, {
      providerId: 'codex',
      loopId: 'codex-jsonl-proxy',
      runtimeType: 'codex-proxy',
      source: 'environment',
    })
    assert.deepEqual(providerLoopConfig.issues, [])
    assert.deepEqual(Object.keys(providerLoopConfig.providers[0] ?? {}).sort(), [
      'allowedCredentialSources',
      'approvalFidelity',
      'complianceNotes',
      'displayName',
      'eventFidelity',
      'gatewayPolicy',
      'id',
      'loopId',
      'providerFamily',
      'status',
      'supportsInterrupt',
      'supportsResume',
      'supportsSteer',
    ])
    assert.equal(JSON.stringify(providerLoopConfig).includes('personal-session'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/read resolves saved provider loop selection without projecting raw keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_PROVIDER: '',
      CLAUDE_CODEX_AGENT_LOOP: '',
      CLAUDE_CODEX_RUNTIME_TYPE: '',
      CLAUDE_CODEX_RUNTIME: '',
      CLAUDE_CODEX_BACKEND: '',
      CLAUDE_CODEX_MOCK: '',
      CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'config/value/write',
        params: { keyPath: 'provider_loop_provider', value: 'codex' },
      }),
    )
    await reader.nextResponse(1)

    proc.stdin.write(json({ id: 2, method: 'config/read', params: {} }))
    const config = await reader.nextResponse(2)
    const providerLoopConfig = config.result.config
      .provider_loop_config as ProviderLoopConfigProjectionResult

    assert.deepEqual(providerLoopConfig.selection, {
      providerId: 'codex',
      loopId: 'codex-jsonl-proxy',
      runtimeType: 'codex-proxy',
      source: 'config',
    })
    assert.equal('provider_loop_provider' in config.result.config, false)

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'sonnet' },
      }),
    )
    const started = await reader.nextResponse(3)
    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/resume',
        params: { threadId: started.result.thread.id, model: 'opus' },
      }),
    )
    const resumed = await reader.nextResponse(4)
    assert.equal(resumed.result.model, 'sonnet')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config writes persist across adapter restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const first = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
        CLAUDE_CODEX_DEFAULT_EFFORT: 'high',
        NODE_NO_WARNINGS: '1',
      },
    })
    const firstReader = new JsonLineReader(first)
    first.stdin.write(
      json({
        id: 1,
        method: 'config/batchWrite',
        params: {
          edits: [
            { keyPath: 'model', value: 'haiku', mergeStrategy: 'upsert' },
            { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'upsert' },
          ],
        },
      }),
    )
    await firstReader.nextResponse(1)
    first.kill()
    await once(first, 'exit')

    const second = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
        CLAUDE_CODEX_DEFAULT_EFFORT: 'high',
        NODE_NO_WARNINGS: '1',
      },
    })
    const secondReader = new JsonLineReader(second)
    try {
      second.stdin.write(json({ id: 2, method: 'config/read', params: {} }))
      const config = await secondReader.nextResponse(2)
      assert.equal(config.result.config.model, 'haiku')
      assert.equal(config.result.config.model_reasoning_effort, 'low')

      second.stdin.write(json({ id: 3, method: 'model/list', params: {} }))
      const models = await secondReader.nextResponse(3)
      const haiku = models.result.data.find((model: any) => model.id === 'haiku')
      assert.equal(haiku.isDefault, true)
      assert.equal(haiku.defaultReasoningEffort, 'low')
    } finally {
      second.kill()
      await once(second, 'exit')
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('invalid persisted model selections are repaired to a selectable model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const adapterConfigDir = join(home, 'claude-codex-adapter')
    await mkdir(adapterConfigDir, { recursive: true })
    await writeFile(
      join(adapterConfigDir, 'config.json'),
      JSON.stringify(
        { model: 'runtime-agent-sdk-sidecar', model_reasoning_effort: 'high' },
        null,
        2,
      ) + '\n',
    )

    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
        NODE_NO_WARNINGS: '1',
      },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
      const config = await reader.nextResponse(1)
      assert.equal(config.result.config.model, 'opus')
      assert.equal(config.result.config.model_reasoning_effort, 'high')

      proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
      const models = await reader.nextResponse(2)
      assert.equal(
        models.result.data.some((model: any) => model.id.startsWith('runtime-')),
        false,
      )
      assert.deepEqual(
        models.result.data
          .filter((model: any) => model.isDefault === true)
          .map((model: any) => model.id),
        ['opus'],
      )
    } finally {
      proc.kill()
      await once(proc, 'exit')
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Fable and Opus picker aliases reach the runtime without changing plan mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    let id = 2
    for (const [model, expected] of [
      ['fable', 'fable'],
      ['claude-fable', 'fable'],
      ['opus', 'opus'],
      ['opus-plan', 'opusplan'],
    ]) {
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: {
            threadId,
            model,
            effort: 'high',
            input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
          },
        }),
      )
      await reader.nextResponse(id++)
      let text = ''
      for (;;) {
        const message = await reader.next()
        if (message.method === 'item/agentMessage/delta') text += message.params.delta
        if (message.method === 'turn/completed') break
      }
      assert.equal(text, `model=${expected} effort=high`)
    }
    proc.stdin.write(
      json({
        id,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'plan mode check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(id)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'planMode=false')
  } finally {
    proc.kill()
    await once(proc, 'exit')
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

for (const configuredModels of ['sonnet', '["sonnet"]', '[{"id":"sonnet"}]']) {
  test(`explicit model list remains authoritative: ${configuredModels}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        CLAUDE_CODEX_MODELS: configuredModels,
        NODE_NO_WARNINGS: '1',
      },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'model/list', params: {} }))
      const models = await reader.nextResponse(1)
      const ids = models.result.data.map((model: any) => model.id)
      assert.equal(ids.includes('sonnet'), true)
      assert.equal(ids.includes('fable'), false)
      assert.equal(ids.includes('opus-plan'), false)
    } finally {
      proc.kill()
      await once(proc, 'exit')
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  })
}

test('Codex++ model and effort selections map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      CLAUDE_CODEX_EFFORT_ALIASES: JSON.stringify({ xhigh: 'max' }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet-1m',
          effort: 'high',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'sonnet-1m')
    assert.equal(start.result.reasoningEffort, 'high')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'sonnet-1m',
          effort: 'xhigh',
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=sonnet[1m] effort=max')

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(3)
    assert.equal(resume.result.model, 'sonnet-1m')
    assert.equal(resume.result.reasoningEffort, 'xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex app config payload model and effort map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          config: { model: 'opus', model_reasoning_effort: 'high' },
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'opus')
    assert.equal(start.result.reasoningEffort, 'high')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          config: { model: 'haiku', model_reasoning_effort: 'xhigh' },
          input: [{ type: 'text', text: 'model effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'model=haiku effort=xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex app model ids and outputSchema map into Claude runtime context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MODELS: '',
      CLAUDE_CODEX_MODEL_ALIASES: '',
      CLAUDE_CODEX_DEFAULT_MODEL: 'claude-opus-4-6',
      CLAUDE_CODEX_SUMMARY_MODEL: 'haiku',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'gpt-5.4-mini',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'gpt-5.4-mini')

    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'gpt-5.4-mini',
          outputSchema,
          input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.deepEqual(JSON.parse(text), {
      model: 'haiku',
      outputFormat: { type: 'json_schema', schema: outputSchema },
    })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// The thread/start the App sends to title a chat, on its own OpenAI model.
function titleThreadStart(id: number): string {
  return json({
    id,
    method: 'thread/start',
    params: {
      model: 'gpt-5.6-luna',
      modelProvider: null,
      allowProviderModelFallback: true,
      cwd: process.cwd(),
      approvalPolicy: 'never',
      permissions: ':read-only',
      config: { web_search: 'disabled', model_reasoning_effort: 'low' },
      personality: null,
      ephemeral: true,
      threadSource: 'thread_title',
      experimentalRawEvents: false,
      dynamicTools: null,
      serviceTier: null,
    },
  })
}

// No Codex proxy; summary turns run on haiku.
const titleAdapterEnv = {
  CLAUDE_CODEX_PROVIDER: '',
  CLAUDE_CODEX_AGENT_LOOP: '',
  CLAUDE_CODEX_RUNTIME_TYPE: '',
  CLAUDE_CODEX_RUNTIME: '',
  CLAUDE_CODEX_BACKEND: '',
  CLAUDE_CODEX_MODELS: '',
  CLAUDE_CODEX_MODEL_ALIASES: '',
  CLAUDE_CODEX_SUMMARY_MODEL: 'haiku',
}

test('with Codex routing off, the App titles a chat on the Claude summary model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, {
    ...titleAdapterEnv,
    CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1',
  })
  const reader = new JsonLineReader(proc)
  const runTurn = async (id: number, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method: 'turn/start', params }))
    assert.equal((await reader.nextResponse(id)).error, undefined)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') return { text, turn: message.params.turn }
    }
  }
  try {
    proc.stdin.write(titleThreadStart(1))
    const start = await reader.nextResponse(1)
    assert.equal(start.error, undefined)
    assert.equal(start.result.model, 'haiku')
    assert.equal(start.result.thread.ephemeral, true)
    const threadId = start.result.thread.id

    // The App's title turn: no model, an outputSchema, JSON back.
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title', 'description'],
      additionalProperties: false,
    }
    const title = await runTurn(2, {
      threadId,
      turnTrigger: 'thread_title',
      input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
      cwd: null,
      approvalPolicy: null,
      permissions: ':read-only',
      model: null,
      effort: null,
      summary: 'none',
      personality: null,
      collaborationMode: null,
      outputSchema,
    })
    assert.equal(title.turn.status, 'completed')
    assert.deepEqual(JSON.parse(title.text), {
      model: 'haiku',
      outputFormat: { type: 'json_schema', schema: outputSchema },
    })

    // A Codex model on a later turn maps the same way.
    const plain = await runTurn(3, {
      threadId,
      model: 'gpt-5.6-luna',
      input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
    })
    assert.equal(plain.turn.status, 'completed')
    assert.equal(JSON.parse(plain.text).model, 'haiku')

    // The App describes a Claude chat in an ephemeral fork, which stays on its model.
    proc.stdin.write(
      json({ id: 4, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet' } }),
    )
    const chat = await reader.nextResponse(4)
    proc.stdin.write(
      json({
        id: 5,
        method: 'thread/fork',
        params: {
          threadId: chat.result.thread.id,
          model: 'gpt-5.6-luna',
          ephemeral: true,
          excludeTurns: true,
          threadSource: 'thread_description',
        },
      }),
    )
    const fork = await reader.nextResponse(5)
    assert.equal(fork.error, undefined)
    assert.equal(fork.result.model, 'sonnet')

    // A chat of the user's own on a Codex model keeps it.
    proc.stdin.write(
      json({
        id: 6,
        method: 'thread/start',
        params: { cwd: process.cwd(), model: 'gpt-5.6-luna' },
      }),
    )
    const own = await reader.nextResponse(6)
    assert.equal(own.error, undefined)
    assert.equal(own.result.model, 'gpt-5.6-luna')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('with Codex routing on, the App title thread keeps its Codex model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { ...titleAdapterEnv, CLAUDE_CODEX_DISABLE_CODEX_PROXY: '' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(titleThreadStart(1))
    const start = await reader.nextResponse(1)
    assert.equal(start.error, undefined)
    assert.equal(start.result.model, 'gpt-5.6-luna')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex title-generation turn runs through the runtime instead of a hardcoded local title', async () => {
  // We used to short-circuit Codex App's title-gen turn with a regex-derived
  // "处理X" string. That was forcing a hardcoded title regardless of what the
  // model would have produced. Now the turn flows through runRuntimeTurn just
  // like any other structured output turn — the model maps to the summary
  // alias (haiku) and the user message is recorded.
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLog = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_DEBUG_LOG: debugLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    const prompt = [
      'You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.',
      'Generate a concise UI title (up to 36 characters) for this task.',
      'Fill the structured title field with plain text.',
      '',
      'User prompt:',
      'output schema check',
    ].join('\n')
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'gpt-5.4-mini',
          effort: 'medium',
          outputSchema,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        },
      }),
    )
    const turnStart = await reader.nextResponse(2)
    // The turn/start response envelope is empty/notLoaded like the real
    // app-server; the user message is recorded in turn history (verified via
    // thread/read below), not echoed back in the turn envelope.
    assert.deepEqual(turnStart.result.turn.items, [])
    assert.equal(turnStart.result.turn.itemsView, 'notLoaded')

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }

    // The user message IS recorded now (we no longer skip the items list) — it
    // shows up in the persisted turn history.
    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const read = await reader.nextResponse(3)
    const historyItems = (read.result.thread.turns as any[]).flatMap((t) => t.items)
    assert.equal(
      historyItems.some((item: any) => item.type === 'userMessage'),
      true,
    )
    // The text is whatever the runtime produced (the mock echoes the resolved
    // model + outputFormat). Importantly it must NOT be the old hardcoded
    // "处理X" string the local short-circuit would have produced.
    assert.doesNotMatch(text, /^\{"title":"处理/)
    const parsed = JSON.parse(text)
    assert.equal(
      parsed.model,
      'haiku',
      'gpt-5.4-mini should map to the summary model (haiku) when an outputSchema is set',
    )
    const logText = await readFile(debugLog, 'utf8')
    assert.doesNotMatch(
      logText,
      /turn\.internalTitle\.shortCircuit/,
      'no local title short-circuit should fire',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stateful HTTP bridge runtimes keep Codex title-generation turns local', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLog = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_RUNTIME_TYPE: 'agent-http',
      CLAUDE_CODEX_HTTP_BASE_URL: 'http://127.0.0.1:9',
      CLAUDE_CODEX_HTTP_MANAGE_BRIDGE: '1',
      CLAUDE_CODEX_DEBUG_LOG: debugLog,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          model: 'sonnet',
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          model: 'gpt-5.4-mini',
          outputSchema,
          input: [{ type: 'text', text: 'User prompt:\nhi', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.deepEqual(JSON.parse(text), { title: 'hi' })
    const logText = await readFile(debugLog, 'utf8')
    assert.match(logText, /"selectedType":"local-structured-summary"/)
    assert.doesNotMatch(logText, /"http\.bridge\.ensure\.start"/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('default runtime tool policy leaves Claude Code tools unrestricted unless env overrides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_ALLOWED_TOOLS: '',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'tool policy check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(text, 'allowedTools=default')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix websocket app-server accepts initialize', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(proc, /listening on/)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    await stopProcess(proc)
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix daemon keeps active turns alive across peer reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_IDLE_EXIT_MS: '40',
      NODE_NO_WARNINGS: '1',
    },
  })
  try {
    await waitForStderr(proc, /listening on/)
    const ws1 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader1 = new WebSocketJsonReader(ws1)
    await once(ws1, 'open')
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    const slowPrompt = `active reconnect check ${'x'.repeat(400)}`
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: slowPrompt, text_elements: [] }] },
      }),
    )
    await reader1.nextResponse(2)

    ws1.close()
    await once(ws1, 'close')
    await delay(120)
    assert.equal(proc.exitCode, null)

    const ws2 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader2 = new WebSocketJsonReader(ws2)
    await once(ws2, 'open')
    ws2.send(
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'thread/resume', params: { threadId } }),
    )
    await reader2.nextResponse(3)

    let text = ''
    let completed = false
    for (let i = 0; i < 1000; i += 1) {
      const message = await reader2.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') {
        completed = true
        break
      }
    }
    assert.equal(completed, true)
    assert.match(text, /reconnect check/)

    ws2.close()
    await once(ws2, 'close')
    assert.equal(await waitForExit(proc, 2000), 0)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('unix daemon recovers stale in-progress turns after process restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  let proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    await waitForStderr(proc, /listening on/)
    const ws1 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader1 = new WebSocketJsonReader(ws1)
    await once(ws1, 'open')
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    ws1.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: `stale restart check ${'x'.repeat(20_000)}`, text_elements: [] },
          ],
        },
      }),
    )
    const turnStart = await reader1.nextResponse(2)
    const turnId = turnStart.result.turn.id

    proc.kill('SIGKILL')
    await Promise.race([
      once(proc, 'exit'),
      delay(2000).then(() => {
        throw new Error('timed out waiting for killed daemon to exit')
      }),
    ])
    ws1.terminate()

    proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    await waitForStderr(proc, /listening on/)

    const ws2 = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    const reader2 = new WebSocketJsonReader(ws2)
    await once(ws2, 'open')
    ws2.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'thread/read',
        params: { threadId, includeTurns: true },
      }),
    )
    const read = await reader2.nextResponse(3)
    assert.equal(read.result.thread.status.type, 'idle')
    const recoveredTurn = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    assert.equal(recoveredTurn.status, 'interrupted')
    assert.match(recoveredTurn.error.message, /server restarted before completing turn/)
    ws2.close()
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stdio app-server recovers stale in-progress turns after process restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  let proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    const reader1 = new JsonLineReader(proc)
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader1.nextResponse(1)
    const threadId = start.result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            {
              type: 'text',
              text: `stdio stale restart check ${'x'.repeat(20_000)}`,
              text_elements: [],
            },
          ],
        },
      }),
    )
    const turnStart = await reader1.nextResponse(2)
    const turnId = turnStart.result.turn.id

    proc.kill('SIGKILL')
    await Promise.race([
      once(proc, 'exit'),
      delay(2000).then(() => {
        throw new Error('timed out waiting for killed stdio adapter to exit')
      }),
    ])

    proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    const reader2 = new JsonLineReader(proc)
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader2.nextResponse(3)
    assert.equal(read.result.thread.status.type, 'idle')
    const recoveredTurn = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    assert.equal(recoveredTurn.status, 'interrupted')
    assert.match(recoveredTurn.error.message, /server restarted before completing turn/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a turn waits out a reader briefly holding the state database', {
  timeout: 20_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_HOME: join(home, 'adapter'),
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  // A hung turn must not keep the test runner alive past the timeout; the
  // adapter defers a plain SIGTERM while it still has an active turn.
  t.signal.addEventListener('abort', () => proc.kill('SIGKILL'))
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startLockTestThread(proc, reader)
    const turnId = await startLockTestTurn(proc, reader, threadId, 2, 'state lock wait check')
    await nextNotification(reader, 'item/agentMessage/delta')
    const release = holdStateDatabase(join(home, 'adapter', 'state.sqlite'))
    await delay(300)
    release()

    const seen = await nextTurnCompleted(reader, turnId)
    assert.equal(seen.completed.status, 'completed')
    assert.equal(seen.methods.includes('error'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a turn the state database refuses still ends and frees the thread', {
  timeout: 30_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLogPath = join(home, 'debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_HOME: join(home, 'adapter'),
      CLAUDE_CODEX_DEBUG_LOG: debugLogPath,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_STATE_DB_TIMEOUT_MS: '50',
      NODE_NO_WARNINGS: '1',
    },
  })
  // A hung turn must not keep the test runner alive past the timeout; the
  // adapter defers a plain SIGTERM while it still has an active turn.
  t.signal.addEventListener('abort', () => proc.kill('SIGKILL'))
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startLockTestThread(proc, reader)
    const turnId = await startLockTestTurn(proc, reader, threadId, 2, 'state lock refusal check')
    await nextNotification(reader, 'item/agentMessage/delta')
    // Held past the adapter's busy timeout: its next write fails, and so does
    // the write that would record the failure.
    const release = holdStateDatabase(join(home, 'adapter', 'state.sqlite'))
    let seen: Awaited<ReturnType<typeof nextTurnCompleted>>
    let status: { params: Record<string, unknown> }
    try {
      seen = await nextTurnCompleted(reader, turnId)
      status = await nextNotification(reader, 'thread/status/changed')
    } finally {
      release()
    }
    assert.equal(seen.completed.status, 'failed')
    assert.match(seen.completed.error.message, /database is locked/)
    assert.equal(seen.methods.includes('error'), true)
    assert.deepEqual(status.params.status, { type: 'idle' })

    const nextTurnId = await startLockTestTurn(proc, reader, threadId, 3, 'after the lock')
    const next = await nextTurnCompleted(reader, nextTurnId)
    assert.equal(next.completed.status, 'completed')

    // The refused write is retried, so the stored turn ends too.
    let stored: any = null
    for (let attempt = 0; attempt < 40 && stored?.status !== 'failed'; attempt += 1) {
      await delay(250)
      const id = 100 + attempt
      proc.stdin?.write(
        json({ id, method: 'thread/read', params: { threadId, includeTurns: true } }),
      )
      const read = await reader.nextResponse(id)
      stored = read.result.thread.turns.find((turn: any) => turn.id === turnId)
    }
    assert.equal(stored?.status, 'failed')

    const events = (await readFile(debugLogPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).event)
    assert.equal(events.includes('turn.persist_failed'), true)
    assert.equal(events.includes('turn.persist_recovered'), true)
    assert.equal(events.includes('adapter.unhandledRejection'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery terminalizes persisted in-progress item liveness', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const childThreadId = randomUUID()
  const turnId = randomUUID()
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: 'stale item recovery',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: Math.floor(Date.now() / 1000) - 2,
      updatedAt: Math.floor(Date.now() / 1000) - 2,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: Math.floor(Date.now() / 1000) - 2,
      completedAt: null,
      durationMs: null,
      items: [
        {
          type: 'userMessage',
          id: randomUUID(),
          content: [{ type: 'text', text: 'stale item recovery', text_elements: [] }],
        },
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'started',
          agentThreadId: childThreadId,
          agentPath: '/root/agent-stale',
        },
        {
          type: 'collabAgentToolCall',
          id: randomUUID(),
          tool: 'wait',
          status: 'inProgress',
          senderThreadId: threadId,
          receiverThreadIds: [childThreadId],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { [childThreadId]: { status: 'running', message: null } },
        },
        {
          type: 'commandExecution',
          id: randomUUID(),
          command: 'echo stale',
          cwd: process.cwd(),
          processId: null,
          source: 'shell',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
      diff: '',
      error: null,
    })

    assert.equal(store.recoverStaleInProgressTurns(), 1)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(store.getThread(threadId)?.status.type, 'idle')
    const activity = recovered.items.find((item) => item.type === 'subAgentActivity')
    assert.equal(activity?.type === 'subAgentActivity' ? activity.kind : null, 'interrupted')
    const wait = recovered.items.find(
      (item) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(wait?.type === 'collabAgentToolCall' ? wait.status : null, 'failed')
    assert.equal(
      wait?.type === 'collabAgentToolCall' ? wait.agentsStates[childThreadId]?.status : null,
      'errored',
    )
    const command = recovered.items.find((item) => item.type === 'commandExecution')
    assert.equal(command?.type === 'commandExecution' ? command.status : null, 'failed')
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery repairs stale items on already-terminal turns and is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const turnId = randomUUID()
  try {
    store.upsertThread({
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      preview: 'terminal item recovery',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: Math.floor(Date.now() / 1000) - 2,
      updatedAt: Math.floor(Date.now() / 1000) - 2,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'interrupted',
      startedAt: Math.floor(Date.now() / 1000) - 2,
      completedAt: Math.floor(Date.now() / 1000) - 1,
      durationMs: 1000,
      items: [
        {
          type: 'subAgentActivity',
          id: randomUUID(),
          kind: 'started',
          agentThreadId: randomUUID(),
          agentPath: '/root/stale',
        },
        {
          type: 'commandExecution',
          id: randomUUID(),
          command: 'echo stale',
          cwd: process.cwd(),
          processId: null,
          source: 'shell',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
      diff: '',
      error: { message: 'already interrupted' },
    })

    assert.equal(store.recoverStaleInProgressTurns(), 1)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    assert.equal(
      recovered.items.find((item) => item.type === 'subAgentActivity')?.kind,
      'interrupted',
    )
    assert.equal(recovered.items.find((item) => item.type === 'commandExecution')?.status, 'failed')
    assert.equal(store.recoverStaleInProgressTurns(), 0)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('startup recovery keeps markers of finished agents and ends the ones it cut off', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const threadId = randomUUID()
  const turnId = randomUUID()
  const finished = randomUUID()
  const cutOff = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const thread = (id: string, preview: string) =>
    store.upsertThread({
      id,
      sessionId: id,
      forkedFromId: id === threadId ? null : threadId,
      preview,
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: now - 5,
      updatedAt: now - 5,
      status: { type: 'active', activeFlags: [] },
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ephemeral: id !== threadId,
      threadSource: id === threadId ? 'user' : 'subagent',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    })
  const childTurn = (id: string, status: 'completed' | 'inProgress') =>
    store.upsertTurn({
      id: randomUUID(),
      threadId: id,
      status,
      startedAt: now - 4,
      completedAt: status === 'completed' ? now - 1 : null,
      durationMs: status === 'completed' ? 3000 : null,
      items: [],
      diff: '',
      error: null,
    })
  const spawn = (id: string) => ({
    type: 'collabAgentToolCall' as const,
    id: randomUUID(),
    tool: 'spawnAgent' as const,
    status: 'completed' as const,
    senderThreadId: threadId,
    receiverThreadIds: [id],
    prompt: 'work',
    model: null,
    reasoningEffort: null,
    agentsStates: { [id]: { status: 'running' as const, message: null } },
  })
  const activity = (id: string, kind: 'started' | 'completed') => ({
    type: 'subAgentActivity' as const,
    id: randomUUID(),
    kind,
    agentThreadId: id,
    agentPath: `/root/${id.slice(0, 8)}`,
  })
  try {
    thread(threadId, 'background agents across a restart')
    thread(finished, 'finished')
    thread(cutOff, 'cut off')
    childTurn(finished, 'completed')
    childTurn(cutOff, 'inProgress')
    store.upsertTurn({
      id: turnId,
      threadId,
      status: 'completed',
      startedAt: now - 5,
      completedAt: now - 4,
      durationMs: 1000,
      items: [
        spawn(finished),
        activity(finished, 'started'),
        spawn(cutOff),
        activity(cutOff, 'started'),
        {
          type: 'collabAgentToolCall',
          id: randomUUID(),
          tool: 'wait',
          status: 'failed',
          senderThreadId: threadId,
          receiverThreadIds: [cutOff],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { [cutOff]: { status: 'running', message: null } },
        },
        activity(finished, 'completed'),
      ],
      diff: '',
      error: null,
    })

    assert.ok(store.recoverStaleInProgressTurns() >= 2)
    const recovered = store.getTurn(turnId)
    assert.ok(recovered)
    const marks = recovered.items.map((item) =>
      item.type === 'subAgentActivity'
        ? `${item.agentThreadId === finished ? 'finished' : 'cutOff'}:${item.kind}`
        : item.type === 'collabAgentToolCall'
          ? `${item.tool}:${item.status}:${Object.entries(item.agentsStates)
              .map(([id, state]) => `${id === finished ? 'finished' : 'cutOff'}=${state?.status}`)
              .join(',')}`
          : item.type,
    )
    assert.deepEqual(marks, [
      'spawnAgent:completed:finished=running',
      'finished:started',
      'spawnAgent:completed:cutOff=errored',
      'cutOff:interrupted',
      'wait:failed:cutOff=errored',
      'finished:completed',
    ])
    assert.equal(store.getThread(threadId)?.status.type, 'idle')
    assert.equal(store.recoverStaleInProgressTurns(), 0)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server proxy forwards websocket handshake bytes to unix daemon', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const proxy = spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    await waitForStderr(daemon, /listening on/)
    const stdout = new TextCollector(proxy)
    proxy.stdin?.write(
      [
        'GET / HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )
    await stdout.waitFor(/101 Switching Protocols/)
  } finally {
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server proxy carries websocket JSON-RPC traffic over stdio', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const proxy = spawn(process.execPath, [adapter, 'app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'proxy-test', title: 'Proxy Test', version: '0' },
          capabilities: null,
        },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('remote shim launches daemon and proxy with Codex-compatible commands', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      // The shim sources a runtime env; keep the developer's own out of it.
      CLAUDE_CODEX_RUNTIME_ENV: join(home, 'runtime.env'),
      CLAUDE_CODEX_ADAPTER: adapter,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const proxy = spawn(shim, ['app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      // The shim sources a runtime env; keep the developer's own out of it.
      CLAUDE_CODEX_RUNTIME_ENV: join(home, 'runtime.env'),
      CLAUDE_CODEX_ADAPTER: adapter,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  let ws: WebSocket | null = null
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
    const reader = new WebSocketJsonReader(ws)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'shim-test', title: 'Shim Test', version: '0' },
          capabilities: null,
        },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.equal(response?.result?.codexHome, home)
  } finally {
    terminateWebSocket(ws)
    proxy.stdin?.end()
    await Promise.all([stopProcess(proxy), stopProcess(daemon)])
    await rm(sock, { force: true })
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('remote utility methods use v2 response shapes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'fs/readFile', params: { path: resolve('README.md') } }))
    const file = await reader.nextResponse(1)
    assert.match(
      Buffer.from(file.result.dataBase64, 'base64').toString('utf8'),
      /Claude Codex Adapter/,
    )

    proc.stdin.write(
      json({ id: 2, method: 'fs/getMetadata', params: { path: resolve('README.md') } }),
    )
    const metadata = await reader.nextResponse(2)
    assert.equal(metadata.result.isFile, true)
    assert.equal(metadata.result.isDirectory, false)

    proc.stdin.write(json({ id: 3, method: 'fs/readDirectory', params: { path: process.cwd() } }))
    const directory = await reader.nextResponse(3)
    assert.equal(
      directory.result.entries.some(
        (entry: any) => entry.fileName === 'package.json' && entry.isFile,
      ),
      true,
    )

    proc.stdin.write(
      json({
        id: 4,
        method: 'command/exec',
        params: {
          command: [process.execPath, '-e', 'process.stdout.write("ok")'],
          cwd: process.cwd(),
        },
      }),
    )
    const command = await reader.nextResponse(4)
    assert.deepEqual(command.result, { exitCode: 0, stdout: 'ok', stderr: '' })

    proc.stdin.write(json({ id: 5, method: 'plugin/read', params: { pluginName: 'browser-use' } }))
    const plugin = (await reader.nextResponse(5)).result.plugin
    for (const field of ['appTemplates', 'apps', 'hooks', 'mcpServers', 'skills']) {
      assert.deepEqual(plugin[field], [], field)
    }
    assert.equal(plugin.summary.name, 'browser-use')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('process/spawn supports shell strings, errors, and debug logs terminal lifecycle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLog = join(home, 'adapter-debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_DEBUG_LOG: debugLog,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'process/spawn',
        params: {
          processHandle: 'shell-process',
          command: 'printf shell-ok',
          cwd: process.cwd(),
          streamStdoutStderr: false,
        },
      }),
    )
    await reader.nextResponse(1)
    let exited: any = null
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'process/exited') {
        exited = message.params
        break
      }
    }
    assert.equal(exited.exitCode, 0)
    assert.equal(exited.stdout, 'shell-ok')

    proc.stdin.write(
      json({
        id: 2,
        method: 'process/spawn',
        params: {
          processHandle: 'missing-process',
          command: ['/definitely/missing/claude-codex-test'],
          cwd: process.cwd(),
        },
      }),
    )
    await reader.nextResponse(2)
    let errorExit: any = null
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (
        message.method === 'process/exited' &&
        message.params.processHandle === 'missing-process'
      ) {
        errorExit = message.params
        break
      }
    }
    assert.equal(errorExit.exitCode, 1)
    assert.match(errorExit.stderr, /ENOENT|no such file/i)

    const logText = await readFile(debugLog, 'utf8')
    assert.match(logText, /"event":"process.spawn.start"/)
    assert.match(logText, /"event":"process.spawn.close"/)
    assert.match(logText, /"event":"process.spawn.error"/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('review/start and thread/compact/start emit real turn items', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'thread/compact/start', params: { threadId } }))
    await reader.nextResponse(2)
    let sawCompaction = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'contextCompaction')
        sawCompaction = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawCompaction, true)

    proc.stdin.write(
      json({
        id: 3,
        method: 'review/start',
        params: {
          threadId,
          delivery: 'inline',
          target: { type: 'custom', instructions: 'notice event' },
        },
      }),
    )
    const review = await reader.nextResponse(3)
    assert.equal(review.result.reviewThreadId, threadId)
    assert.equal(review.result.turn.status, 'inProgress')
    // Like the real app-server's build_review_turn, the review/start RESPONSE
    // carries the synthesized userMessage (review label) with itemsView
    // notLoaded; enteredReviewMode arrives via the item/started event stream.
    assert.equal(review.result.turn.itemsView, 'notLoaded')
    assert.equal(
      review.result.turn.items.some((item: any) => item.type === 'userMessage'),
      true,
    )
    assert.equal(
      review.result.turn.items.some((item: any) => item.type === 'enteredReviewMode'),
      false,
    )

    let reviewText = ''
    let reviewWarning: any = null
    let sawEnteredReviewMode = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'enteredReviewMode')
        sawEnteredReviewMode = true
      if (message.method === 'item/agentMessage/delta') reviewText += message.params.delta
      if (message.method === 'warning') reviewWarning = message.params
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawEnteredReviewMode, true)
    assert.equal(reviewText, '')
    assert.deepEqual(reviewWarning, { threadId, message: 'mock rate limit notice' })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude thinking maps to Codex reasoning content without a duplicate summary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'thinking check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    let sawSummary = false
    let sawContent = false
    let completedReasoning: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/reasoning/summaryTextDelta') sawSummary = true
      if (message.method === 'item/reasoning/textDelta') sawContent = true
      if (message.method === 'item/completed' && message.params.item.type === 'reasoning')
        completedReasoning = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawSummary, false)
    assert.equal(sawContent, true)
    assert.deepEqual(completedReasoning.summary, [])
    assert.deepEqual(completedReasoning.content, ['mock thinking'])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the context gauge follows the last API call and child tokens add to the total', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('context usage check') },
      }),
    )
    await reader.nextResponse(2)
    const turn = await readUntil(
      reader,
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    )
    const updates = turn
      .filter((m) => m.method === 'thread/tokenUsage/updated')
      .map((m) => m.params.tokenUsage)
    const lastCall = {
      inputTokens: 30,
      cachedInputTokens: 120,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      totalTokens: 200,
    }
    assert.equal(updates.length, 2)
    // Codex's last_token_usage is one response, which is what fills the
    // context; the result's sum over both calls would not be.
    assert.deepEqual(updates[0].last, lastCall)
    assert.equal(updates[0].total.totalTokens, 320)
    assert.equal(updates[0].modelContextWindow, 200_000)
    assert.deepEqual(updates[1].last, lastCall, 'child tokens leave the gauge alone')
    assert.equal(updates[1].total.totalTokens, 1320)
    assert.equal(updates[1].modelContextWindow, 200_000)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude token usage maps to thread/tokenUsage/updated notifications', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'usage check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    let tokenUsage: any = null
    let completedTurn: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/tokenUsage/updated') tokenUsage = message.params
      if (message.method === 'turn/completed') {
        completedTurn = message.params.turn
        break
      }
    }
    assert.ok(tokenUsage, 'expected a thread/tokenUsage/updated notification')
    assert.equal(tokenUsage.threadId, threadId)
    // The Codex v2 Turn schema has no api/cost metadata fields, so turn/completed
    // must not carry the adapter's internal apiDurationMs/numTurns/costUsd; token
    // metrics are surfaced through thread/tokenUsage/updated instead.
    assert.ok(completedTurn, 'turn/completed must arrive')
    assert.ok(!('apiDurationMs' in completedTurn))
    assert.ok(!('numTurns' in completedTurn))
    assert.ok(!('costUsd' in completedTurn))
    // input_tokens 100 + cache_creation 5 = 105 input; cache_read 10; output 40.
    assert.deepEqual(tokenUsage.tokenUsage.last, {
      inputTokens: 105,
      cachedInputTokens: 10,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 155,
    })
    assert.deepEqual(tokenUsage.tokenUsage.total, tokenUsage.tokenUsage.last)
    assert.equal(tokenUsage.tokenUsage.modelContextWindow, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('baseInstructions / developerInstructions / personality flow into the system prompt addendum', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          baseInstructions: 'Always write SQL in lowercase.',
          developerInstructions: 'Avoid SELECT *.',
          personality: 'pragmatic',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'system prompt check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    const addendumLine = text.replace(/^systemPromptAddendum=/, '')
    const addendum = JSON.parse(addendumLine)
    assert.ok(typeof addendum === 'string', 'systemPromptAddendum should be a non-null string')
    assert.match(addendum, /Always write SQL in lowercase\./)
    assert.match(addendum, /Avoid SELECT \*/)
    assert.match(addendum, /Personality: pragmatic/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude hook runs are reported as Codex hook/started and hook/completed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const project = await mkdtemp(join(tmpdir(), 'claude-codex-hooks-'))
  const settings = join(project, '.claude', 'settings.json')
  await mkdir(join(project, '.claude'), { recursive: true })
  await writeFile(
    settings,
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'true' }] }] } }),
  )
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: project } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hook check', text_elements: [] }] },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id

    const hookMessages: any[] = []
    const itemTypes: string[] = []
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'hook/started' || message.method === 'hook/completed')
        hookMessages.push(message)
      if (message.method === 'item/started') itemTypes.push(message.params.item.type)
      if (message.method === 'turn/completed') break
    }
    // The Notification hook has no Codex event name and is dropped.
    assert.deepEqual(
      hookMessages.map((message) => message.method),
      ['hook/started', 'hook/completed'],
    )
    const [started, completed] = hookMessages
    assert.equal(started.params.threadId, threadId)
    assert.equal(started.params.turnId, turnId)
    assert.deepEqual(
      {
        id: started.params.run.id,
        eventName: started.params.run.eventName,
        status: started.params.run.status,
        source: started.params.run.source,
        sourcePath: started.params.run.sourcePath,
        scope: started.params.run.scope,
        completedAt: started.params.run.completedAt,
      },
      {
        id: 'mock-hook',
        eventName: 'preToolUse',
        status: 'running',
        source: 'project',
        sourcePath: settings,
        scope: 'turn',
        completedAt: null,
      },
    )
    assert.equal(completed.params.run.id, 'mock-hook')
    assert.equal(completed.params.run.status, 'blocked')
    assert.deepEqual(completed.params.run.entries, [
      { kind: 'feedback', text: 'Bash about to run echo hi' },
    ])
    assert.equal(typeof completed.params.run.completedAt, 'number')
    assert.equal(typeof completed.params.run.durationMs, 'number')
    // Hook runs are not transcript items.
    assert.equal(itemTypes.includes('hookPrompt'), false)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

for (const mode of ['form', 'url'] as const) {
  test(`MCP ${mode} elicitations are bridged to mcpServer/elicitation/request`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
      const threadId = (await reader.nextResponse(1)).result.thread.id
      const prompt = mode === 'url' ? 'elicitation check url' : 'elicitation check'
      proc.stdin.write(
        json({
          id: 2,
          method: 'turn/start',
          params: { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] },
        }),
      )
      const turnId = (await reader.nextResponse(2)).result.turn.id

      let request: any = null
      let waiting = false
      while (request == null) {
        const message = await reader.next()
        if (
          message.method === 'thread/status/changed' &&
          message.params.status.activeFlags?.includes('waitingOnUserInput')
        )
          waiting = true
        if (message.method === 'mcpServer/elicitation/request') request = message
      }
      assert.equal(waiting, true)
      const expected =
        mode === 'url'
          ? {
              threadId,
              turnId,
              serverName: 'mock-mcp',
              message: 'Sign in to continue',
              mode: 'url',
              url: 'https://example.com/auth',
              elicitationId: 'mock-elicitation',
            }
          : {
              threadId,
              turnId,
              serverName: 'mock-mcp',
              message: 'Pick a region',
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: { region: { type: 'string' } },
                required: ['region'],
              },
            }
      assert.deepEqual(request.params, expected)

      const result =
        mode === 'url'
          ? { action: 'decline', content: null, _meta: null }
          : { action: 'accept', content: { region: 'eu' }, _meta: null }
      proc.stdin.write(json({ jsonrpc: '2.0', id: request.id, result }))

      let resolved = false
      let text = ''
      for (let i = 0; i < 200; i += 1) {
        const message = await reader.next()
        if (message.method === 'serverRequest/resolved' && message.params.requestId === request.id)
          resolved = true
        if (message.method === 'item/agentMessage/delta') text += message.params.delta
        if (message.method === 'turn/completed') break
      }
      assert.equal(resolved, true)
      assert.equal(
        text,
        mode === 'url'
          ? 'elicitation={"action":"decline"}'
          : 'elicitation={"action":"accept","content":{"region":"eu"}}',
      )
    } finally {
      proc.kill()
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  })
}

test('thread/compact/start drives Claude (summary model) instead of the local stringified summary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    // Need a turn or two of content for compactSummary to have snippets.
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello world', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    let firstTurnDone = false
    for (let i = 0; i < 200 && !firstTurnDone; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') firstTurnDone = true
    }

    proc.stdin.write(json({ id: 3, method: 'thread/compact/start', params: { threadId } }))
    await reader.nextResponse(3)

    let agentText = ''
    let sawCompacted = false
    let sawTurnCompleted = false
    for (let i = 0; i < 300 && !(sawCompacted && sawTurnCompleted); i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta')
        agentText += String(message.params.delta ?? '')
      if (message.method === 'thread/compacted') sawCompacted = true
      if (message.method === 'turn/completed') sawTurnCompleted = true
    }
    assert.match(
      agentText,
      /MOCK_COMPACT_SUMMARY/,
      'compact turn should stream the runtime-produced summary, not the local template',
    )
    assert.doesNotMatch(
      agentText,
      /Context compacted for thread/,
      'local fallback should not have fired when the runtime succeeded',
    )
    assert.equal(
      sawCompacted,
      true,
      'thread/compacted notification should still fire after compaction',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('localImage user input becomes a multimodal Claude prompt + an imageView ThreadItem', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Tiny 1x1 PNG to avoid pulling a real image binary.
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  )
  const imgPath = join(home, 'pixel.png')
  const fs = await import('node:fs/promises')
  await fs.writeFile(imgPath, png1x1)

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: 'image input check', text_elements: [] },
            { type: 'localImage', path: imgPath },
          ],
        },
      }),
    )
    await reader.nextResponse(2)

    let text = ''
    let imageView: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'imageView')
        imageView = message.params.item
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    // imageView is surfaced live via the item/* event stream (the turn envelope
    // itself stays empty/notLoaded, matching the real app-server).
    assert.ok(imageView, 'turn should emit an imageView item for the user-uploaded image')
    assert.equal(imageView.path, imgPath)
    // Mock echoes the parsed image inputs; assert kind=base64 + media type +
    // a non-trivial payload landed in the runtime context.
    assert.match(
      text,
      /^images=base64:image\/png:\d+/,
      'runtime should receive base64 image input — got: ' + text,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude WebSearch tool maps to native Codex webSearch ThreadItem with action', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'web search check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let webSearchItem: any = null
    let completedWebSearch: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'webSearch')
        webSearchItem = message.params.item
      if (
        message.method === 'item/completed' &&
        webSearchItem &&
        message.params.item.id === webSearchItem.id
      )
        completedWebSearch = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.ok(webSearchItem, 'WebSearch tool_use should emit a native webSearch ThreadItem')
    assert.equal(webSearchItem.query, 'mock query')
    // Protocol-correct action shape: 'search' variant has required query/queries
    // (Option<...> with no serde default) — bare {type:'search'} would crash App.
    assert.deepEqual(webSearchItem.action, { type: 'search', query: 'mock query', queries: null })
    assert.ok(completedWebSearch, 'webSearch item should complete')
    assert.equal(
      completedWebSearch.action.type,
      'openPage',
      'tool_result with a URL should upgrade action to openPage',
    )
    assert.equal(completedWebSearch.action.url, 'https://example.com/article')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('modelProvider/capabilities/read advertises webSearch=true unless CLAUDE_CODEX_WEBSEARCH=0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'modelProvider/capabilities/read', params: {} }))
    const cap = await reader.nextResponse(1)
    assert.equal(cap.result.webSearch, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('config/value/write persists arbitrary settings keys across restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const env = { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' }
  // Round 1: write a custom key + a known typed key.
  const proc1 = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  let reader = new JsonLineReader(proc1)
  try {
    proc1.stdin.write(
      json({
        id: 1,
        method: 'config/value/write',
        params: { keyPath: 'approval_policy', value: 'never' },
      }),
    )
    await reader.nextResponse(1)
    proc1.stdin.write(
      json({
        id: 2,
        method: 'config/value/write',
        params: { keyPath: 'sandbox_mode', value: 'danger-full-access' },
      }),
    )
    await reader.nextResponse(2)
    proc1.stdin.write(json({ id: 3, method: 'config/read', params: {} }))
    const r = await reader.nextResponse(3)
    assert.equal(
      r.result.config.approval_policy,
      'never',
      'override should appear in config/read on the same process',
    )
    assert.equal(r.result.config.sandbox_mode, 'danger-full-access')
  } finally {
    proc1.kill()
    await once(proc1, 'exit')
  }

  // Round 2: a fresh adapter process re-reads from disk — overrides survive.
  const proc2 = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  reader = new JsonLineReader(proc2)
  try {
    proc2.stdin.write(json({ id: 1, method: 'config/read', params: {} }))
    const r = await reader.nextResponse(1)
    assert.equal(
      r.result.config.approval_policy,
      'never',
      'override must survive restart via persisted overrides bag',
    )
    assert.equal(r.result.config.sandbox_mode, 'danger-full-access')
  } finally {
    proc2.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/inject_items appends a synthetic turn carrying the injected text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    // Codex App's actual payload shape: items[] of free-form Responses entries.
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/inject_items',
        params: {
          threadId,
          items: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Here is some pinned context.' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'Got it, remembered.' }],
            },
          ],
        },
      }),
    )

    // The response + 3 notifications (turn/started, item/completed, turn/completed)
    // arrive in some order. Drain everything until we've seen all four signals
    // — don't pre-filter via nextResponse(2) because that would discard the
    // notifications which are exactly what we want to assert.
    let sawResponse = false
    let injectedText = ''
    for (let i = 0; i < 100; i += 1) {
      const m = await reader.next()
      if (m.id === 2 && m.method == null) sawResponse = true
      if (m.method === 'item/completed' && m.params?.item?.type === 'agentMessage') {
        injectedText = m.params.item.text
      }
      if (sawResponse && injectedText) break
    }
    assert.equal(sawResponse, true, 'thread/inject_items response must arrive')
    assert.match(
      injectedText,
      /pinned context/,
      'injected text must round-trip into the synthetic agentMessage',
    )
    assert.match(injectedText, /Got it, remembered/)

    // thread/read should show the synthetic turn so reload preserves it.
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(3)
    const turns = read.result.thread.turns
    assert.ok(turns.length >= 1, 'thread/read should include the injected turn')
    assert.equal(turns.at(-1).items[0].type, 'agentMessage')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn/start planMode=true flows into Claude SDK permission_mode plan', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          planMode: true,
          input: [{ type: 'text', text: 'plan mode check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    // Plan-mode text routes to a Plan ThreadItem via item/plan/delta so the
    // App's Plan UI lights up. turn/plan/updated is NOT used for plan-mode text;
    // it is reserved for the update_plan/TodoWrite checklist tool.
    let planText = ''
    let sawPlanUpdated = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/plan/delta') planText += message.params.delta
      if (message.method === 'turn/plan/updated') sawPlanUpdated = true
      if (message.method === 'turn/completed') break
    }
    assert.match(planText, /planMode=true/, 'plan deltas should carry the runtime context')
    assert.equal(sawPlanUpdated, false, 'plan-mode text must not emit turn/plan/updated')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('TodoWrite maps to a Codex v2 turn/plan/updated notification, not a timeline item', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'update the todo list', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let planUpdate: any = null
    let sawTodoItem = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/plan/updated') planUpdate = message.params
      if (
        (message.method === 'item/started' || message.method === 'item/completed') &&
        /todo/i.test(message.params.item?.tool ?? '')
      )
        sawTodoItem = true
      if (message.method === 'turn/completed') break
    }
    assert.ok(planUpdate, 'expected a turn/plan/updated notification')
    // Codex v2 TurnPlanUpdatedNotification = { threadId, turnId, explanation, plan }.
    assert.equal(planUpdate.threadId, threadId)
    assert.equal(planUpdate.explanation, null)
    assert.deepEqual(planUpdate.plan, [
      { step: 'Investigate', status: 'completed' },
      { step: 'Implement', status: 'inProgress' },
      { step: 'Verify', status: 'pending' },
    ])
    // The checklist tool itself is not surfaced as a separate timeline item.
    assert.equal(sawTodoItem, false, 'TodoWrite must not produce a timeline tool item')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex App approvalPolicy=never + sandbox=danger-full-access auto-accepts tool calls', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    // Envelope reflects the App's chosen policy/sandbox instead of the previous hardcoded `on-request` + workspaceWrite.
    assert.equal(start.result.approvalPolicy, 'never')
    assert.equal((start.result.sandbox as any).type, 'dangerFullAccess')

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let sawApprovalRequest = false
    let sawCommandOutput = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/commandExecution/requestApproval') sawApprovalRequest = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawCommandOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(
      sawApprovalRequest,
      false,
      'expected no requestApproval round-trip when approvalPolicy=never',
    )
    assert.equal(sawCommandOutput, true, 'tool should still execute and stream output')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Task subagent emits the canonical activity lifecycle and leaves wait as the terminal display state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_SUBAGENT_COMPLETED: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: { name: 'codex-test-modern', title: 'Codex test', version: 'modern' },
          capabilities: { subAgentActivityCompleted: true },
        },
      }),
    )
    await reader.nextResponse(0)
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'subagent check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    type Lifecycle = { started?: any; completed?: any }
    const collabByTool: Record<string, Lifecycle> = {}
    let agentMessageText = ''
    let childThreadStarted: any = null
    let childTurnStarted: any = null
    let childPromptStarted: any = null
    let childPromptCompleted: any = null
    let childAgentStarted: any = null
    let childAgentCompleted: any = null
    let childAgentMessageText = ''
    let childTurnCompleted: any = null
    let liveChildRead: any = null
    let childTokenUsage: any = null
    let leakedInnerItems = 0
    const subagentActivityStarted = new Map<string, any>()
    const subagentActivities: any[] = []
    const parentCompletedOrder: string[] = []
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.id === 50) liveChildRead = message.result.thread
      if (
        message.method === 'thread/started' &&
        message.params.thread?.threadSource === 'subagent'
      ) {
        childThreadStarted = message.params.thread
      }
      if (message.method === 'turn/started' && message.params.threadId !== threadId) {
        childTurnStarted = message.params.turn
        proc.stdin.write(
          json({
            id: 50,
            method: 'thread/read',
            // The bundled Codex App panel uses includeTurns:false while it
            // opens a child. The adapter must still hydrate this subagent.
            params: { threadId: message.params.threadId, includeTurns: false },
          }),
        )
      }
      if (message.method === 'item/started') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptStarted = item
        } else if (message.params.threadId !== threadId && item.type === 'agentMessage') {
          childAgentStarted = item
        } else if (item.type === 'subAgentActivity') {
          subagentActivityStarted.set(item.id, item)
        } else if (item.type === 'collabAgentToolCall') {
          const bucket = (collabByTool[item.tool] ??= {})
          bucket.started = item
        } else if (
          item.type === 'commandExecution' ||
          (item.type === 'mcpToolCall' && item.tool !== 'Task')
        ) {
          leakedInnerItems += 1
        }
      }
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptCompleted = item
        } else if (message.params.threadId !== threadId && item.type === 'agentMessage') {
          childAgentCompleted = item
        } else if (item.type === 'subAgentActivity') {
          subagentActivities.push(item)
          parentCompletedOrder.push(`activity:${item.kind}`)
        } else if (item.type === 'collabAgentToolCall') {
          const bucket = (collabByTool[item.tool] ??= {})
          bucket.completed = item
          parentCompletedOrder.push(`collab:${item.tool}`)
        }
      }
      if (message.method === 'item/agentMessage/delta') {
        if (message.params.threadId === threadId) {
          agentMessageText += String(message.params.delta ?? '')
        } else {
          childAgentMessageText += String(message.params.delta ?? '')
        }
      }
      if (message.method === 'turn/completed') {
        if (message.params.threadId === threadId) break
        childTurnCompleted = message.params.turn
      }
      if (message.method === 'thread/tokenUsage/updated' && message.params.threadId !== threadId)
        childTokenUsage = message.params.tokenUsage
    }
    // The `<usage>subagent_tokens: N` trailer becomes the child's usage.
    assert.equal(childTokenUsage?.total.totalTokens, 4242)
    // Native V2 uses activity items for liveness and leaves wait/completed as
    // the final parent item. Closing an already-finished child makes older App
    // reducers discard that completed state and fall back to "started".
    for (const tool of ['spawnAgent', 'wait']) {
      const lc = collabByTool[tool]
      assert.ok(lc?.started, `expected item/started for ${tool}`)
      assert.ok(lc?.completed, `expected item/completed for ${tool}`)
      assert.equal(lc.started.id, lc.completed.id, `${tool} begin/end must share a single item id`)
      assert.equal(
        lc.completed.status,
        'completed',
        `${tool} should complete with status=completed`,
      )
    }
    const spawnEnd = collabByTool.spawnAgent!.completed!
    assert.equal(spawnEnd.senderThreadId, threadId)
    assert.equal(
      spawnEnd.receiverThreadIds.length,
      1,
      'spawnAgent end should reference exactly one child thread',
    )
    const childThreadId = spawnEnd.receiverThreadIds[0]!
    assert.deepEqual(
      subagentActivities.map((item) => item.kind),
      ['started', 'completed'],
      'subagent activity must transition from started to completed',
    )
    assert.equal(subagentActivities[0].agentThreadId, childThreadId)
    assert.equal(subagentActivities[1].agentThreadId, childThreadId)
    assert.equal(subagentActivities[0].agentPath, subagentActivities[1].agentPath)
    assert.match(subagentActivities[0].agentPath, /^\/root\/[A-Za-z0-9_-]+$/)
    assert.equal(subagentActivityStarted.size, 2)
    for (const completedActivity of subagentActivities) {
      assert.deepEqual(
        subagentActivityStarted.get(completedActivity.id),
        completedActivity,
        `${completedActivity.kind} activity must emit item/started and item/completed with the same id`,
      )
    }
    assert.ok(
      parentCompletedOrder.indexOf('activity:completed') <
        parentCompletedOrder.indexOf('collab:wait'),
      'completed activity must arrive before wait/completed so the bundled App keeps the final done state',
    )
    assert.equal(
      collabByTool.closeAgent,
      undefined,
      'a naturally completed child must not receive a synthetic closeAgent lifecycle',
    )
    assert.ok(childThreadStarted, 'subagent must emit child thread/started for live navigation')
    assert.equal(childThreadStarted.id, childThreadId)
    assert.equal(
      childThreadStarted.parentThreadId,
      threadId,
      'subagent thread metadata must identify its parent thread',
    )
    assert.equal(childThreadStarted.recencyAt, childThreadStarted.updatedAt)
    assert.deepEqual(childThreadStarted.source, {
      subAgent: {
        thread_spawn: {
          parent_thread_id: threadId,
          depth: 1,
          agent_path: null,
          agent_nickname: childThreadStarted.agentNickname,
          agent_role: 'general-purpose',
        },
      },
    })
    assert.ok(childTurnStarted, 'subagent must emit child turn/started before its result')
    assert.equal(childTurnStarted.status, 'inProgress')
    assert.equal(childTurnStarted.itemsView, 'notLoaded')
    assert.deepEqual(childTurnStarted.items, [])
    assert.ok(childPromptStarted, 'subagent prompt must emit child userMessage item/started')
    assert.ok(childPromptCompleted, 'subagent prompt must emit child userMessage item/completed')
    assert.equal(childPromptStarted.id, childPromptCompleted.id)
    assert.equal(childPromptCompleted.content[0].text, 'investigate')
    assert.ok(liveChildRead, 'opening a running subagent must return its child turn')
    assert.equal(liveChildRead.turns.length, 1)
    assert.equal(liveChildRead.turns[0].status, 'inProgress')
    const liveItems = liveChildRead.turns[0].items
    assert.equal(
      liveItems.find((item: any) => item.type === 'userMessage').content[0].text,
      'investigate',
    )
    assert.equal(
      liveItems.some((item: any) => item.type === 'agentMessage'),
      false,
    )
    assert.ok(childAgentStarted, 'subagent result must emit child agentMessage item/started')
    assert.equal(childAgentStarted.text, '')
    assert.match(childAgentMessageText, /subagent final summary/)
    assert.ok(childAgentCompleted, 'subagent result must emit child agentMessage item/completed')
    assert.equal(childAgentCompleted.id, childAgentStarted.id)
    assert.match(childAgentCompleted.text, /subagent final summary/)
    assert.ok(
      childTurnCompleted,
      'subagent must emit child turn/completed before parent completion',
    )
    assert.equal(childTurnCompleted.id, childTurnStarted.id)
    assert.equal(childTurnCompleted.status, 'completed')
    assert.equal(
      childTurnCompleted.itemsView,
      'summary',
      'completed subagent turns must carry their final response in the terminal envelope',
    )
    assert.equal(childTurnCompleted.items.length, 1)
    assert.equal(childTurnCompleted.items[0].type, 'agentMessage')
    assert.equal(childTurnCompleted.items[0].id, childAgentCompleted.id)
    assert.match(childTurnCompleted.items[0].text, /subagent final summary/)
    // After spawnAgent ends the subagent is now running; wait/completed is the
    // terminal display snapshot after the activity completion event.
    assert.equal(spawnEnd.agentsStates[childThreadId]!.status, 'running')
    assert.equal(collabByTool.wait!.started!.receiverThreadIds[0], childThreadId)
    assert.equal(collabByTool.wait!.completed!.agentsStates[childThreadId]!.status, 'completed')
    // collabAgentToolCall.model carries the SDK model the subagent runs on,
    // NOT Claude's subagent_type — the App's "Agent · model" badge depends
    // on this. The mock runs without a subagent_type so the parent's model
    // (default 'sonnet') flows through unchanged.
    assert.equal(
      spawnEnd.model,
      'sonnet',
      'collabAgentToolCall.model should be the parent thread model when no Task input.model is set',
    )

    // Codex App reads agentRole/agentNickname off the child thread to render
    // its native subagent identity. The mock has no subagent_type so we fall
    // back to "general-purpose"; agentNickname mirrors Claude's `agent-{hex}`
    // shape so the App can show a stable handle for this subagent instance.
    proc.stdin.write(json({ id: 5, method: 'thread/read', params: { threadId: childThreadId } }))
    const childRead = await reader.nextResponse(5)
    const childThread = childRead.result.thread
    assert.equal(childThread.threadSource, 'subagent')
    assert.equal(childThread.ephemeral, true)
    assert.equal(childThread.agentRole, 'general-purpose')
    // The Task tool_result carried an `agentId: deadbeefcafef00d` trailer
    // (mock mirrors the real claude-agent-sdk format). The server should
    // strip it from the visible text and overwrite the synthetic
    // `agent-{hex}` nickname with the SDK-assigned id.
    assert.equal(childThread.agentNickname, 'deadbeefcafef00d')
    assert.equal(
      childThread.forkedFromId,
      threadId,
      'subagent thread should be forked from the parent user thread',
    )

    // Trailer is stripped from the child thread's visible agentMessage.
    proc.stdin.write(
      json({ id: 6, method: 'thread/turns/list', params: { threadId: childThreadId } }),
    )
    const childTurns = await reader.nextResponse(6)
    assert.equal(childTurns.result.data.length, 1, 'subagent should use one live child turn')
    const childTurnItems = (childTurns.result.data[0] as any).items
    const childPrompt = childTurnItems.find((i: any) => i.type === 'userMessage')
    assert.equal(childPrompt.content[0].text, 'investigate')
    const childAgent = childTurnItems.find((i: any) => i.type === 'agentMessage')
    assert.ok(childAgent, 'child thread should have an agentMessage with the subagent result')
    assert.doesNotMatch(
      childAgent.text,
      /agentId:/,
      '`agentId:` trailer should be stripped from the visible body',
    )
    assert.doesNotMatch(
      childAgent.text,
      /<usage>/,
      '`<usage>` block should be stripped from the visible body',
    )
    assert.match(
      childAgent.text,
      /subagent final summary/,
      'the real subagent body must still be there',
    )
    assert.equal(
      childAgent.text,
      'subagent final summary\n\n```\nindented detail\n```',
      'the hand-back frame and its indentation should be gone',
    )

    // A reload replays the activity cards this client saw live, in order, so
    // the completed marker still lands before wait/completed.
    proc.stdin.write(
      json({ id: 8, method: 'thread/turns/list', params: { threadId, itemsView: 'full' } }),
    )
    const liveParentTurns = await reader.nextResponse(8)
    const replayed = (liveParentTurns.result.data as any[])
      .flatMap((turn: any) => turn.items ?? [])
      .filter(
        (item: any) => item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall',
      )
      .map((item: any) =>
        item.type === 'subAgentActivity' ? `activity:${item.kind}` : `collab:${item.tool}`,
      )
    assert.deepEqual(
      replayed.filter((entry: string) => entry.startsWith('activity:')),
      ['activity:started', 'activity:completed'],
      'parent history must keep the activity cards the client saw live',
    )
    assert.ok(replayed.indexOf('activity:completed') < replayed.indexOf('collab:wait'))

    assert.equal(leakedInnerItems, 0, 'inner Bash tool calls should not appear at the parent level')
    assert.doesNotMatch(
      agentMessageText,
      /subagent thinking aloud/,
      'subagent text should not bleed into the main agent message',
    )
    assert.match(
      agentMessageText,
      /main agent summary/,
      'main agent text after subagent should still appear',
    )

    // Ephemeral child thread is hidden from the default list, exposed with includeEphemeral.
    proc.stdin.write(json({ id: 3, method: 'thread/list', params: {} }))
    const list = await reader.nextResponse(3)
    const ids = (list.result.data as any[]).map((t) => t.id)
    assert.ok(
      !ids.includes(childThreadId),
      'subagent child thread should be hidden from thread/list',
    )
    assert.ok(ids.includes(threadId), 'parent user thread should remain visible')

    proc.stdin.write(json({ id: 4, method: 'thread/list', params: { includeEphemeral: true } }))
    const listAll = await reader.nextResponse(4)
    const allIds = (listAll.result.data as any[]).map((t) => t.id)
    assert.ok(
      allIds.includes(childThreadId),
      'includeEphemeral=true should surface the subagent child thread',
    )

    // Codex App discovers subagents after reconnect through the standard
    // parent/source filters, without setting includeEphemeral explicitly.
    proc.stdin.write(
      json({
        id: 7,
        method: 'thread/list',
        params: {
          parentThreadId: threadId,
          sourceKinds: ['subAgentThreadSpawn'],
          sortDirection: 'desc',
          sortKey: 'created_at',
          useStateDbOnly: true,
          limit: 200,
        },
      }),
    )
    const discovered = await reader.nextResponse(7)
    assert.deepEqual(
      discovered.result.data.map((thread: any) => thread.id),
      [childThreadId],
      'standard subagent discovery must return the child for its parent',
    )

    // Generic and thread-spawn source kinds are representable by this
    // adapter. The omitted sortKey also exercises the protocol default
    // (created_at). Other variants are intentionally unsupported because the
    // persisted schema has no discriminator for them.
    for (const [index, sourceKind] of ['subAgent', 'subAgentThreadSpawn'].entries()) {
      const id = 80 + index
      proc.stdin.write(
        json({
          id,
          method: 'thread/list',
          params: {
            parentThreadId: threadId,
            sourceKinds: [sourceKind],
            limit: 200,
          },
        }),
      )
      const variant = await reader.nextResponse(id)
      assert.deepEqual(
        variant.result.data.map((thread: any) => thread.id),
        [childThreadId],
        `${sourceKind} should discover the subagent child`,
      )
    }
    for (const [index, sourceKind] of [
      'subAgentReview',
      'subAgentCompact',
      'subAgentOther',
    ].entries()) {
      const id = 90 + index
      proc.stdin.write(
        json({
          id,
          method: 'thread/list',
          params: { parentThreadId: threadId, sourceKinds: [sourceKind], limit: 200 },
        }),
      )
      const variant = await reader.nextResponse(id)
      assert.deepEqual(
        variant.result.data.map((thread: any) => thread.id),
        [],
        `${sourceKind} should not mislabel a thread-spawn child`,
      )
    }

    // Restart the adapter and replay the parent turn from SQLite. The bundled
    // App reduces items in persisted order, so wait/completed must still be
    // the last subagent state after a cold restart. This connection never
    // initializes, so it reads like a legacy client and gets no started or
    // completed activity markers it could not have been sent live.
    const exited = once(proc, 'exit')
    proc.kill()
    await exited
    const restarted = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    const restartedReader = new JsonLineReader(restarted)
    try {
      restarted.stdin.write(
        json({
          id: 1,
          method: 'thread/turns/list',
          params: { threadId, itemsView: 'full' },
        }),
      )
      const persistedTurns = await restartedReader.nextResponse(1)
      const persistedItems = persistedTurns.result.data[0].items.filter(
        (item: any) => item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall',
      )
      assert.deepEqual(
        persistedItems.map((item: any) =>
          item.type === 'subAgentActivity'
            ? `activity:${item.kind}`
            : `collab:${item.tool}:${item.status}`,
        ),
        ['collab:spawnAgent:completed', 'collab:wait:completed'],
        'cold-open history must not retain a started activity marker after wait/completed',
      )

      restarted.stdin.write(
        json({
          id: 2,
          method: 'thread/list',
          params: {
            parentThreadId: threadId,
            sourceKinds: ['subAgentThreadSpawn'],
            sortDirection: 'desc',
            sortKey: 'created_at',
            useStateDbOnly: true,
            limit: 200,
          },
        }),
      )
      const rediscovered = await restartedReader.nextResponse(2)
      assert.deepEqual(
        rediscovered.result.data.map((thread: any) => thread.id),
        [childThreadId],
        'a cold App connection must rediscover the persisted subagent child',
      )
      assert.equal(rediscovered.result.data[0].status.type, 'idle')
      assert.equal(rediscovered.result.data[0].isPinned, false)

      restarted.stdin.write(
        json({
          id: 3,
          method: 'thread/read',
          // Cold-open follows the same metadata-only request as the Codex App.
          params: { threadId: childThreadId, includeTurns: false },
        }),
      )
      const coldChild = (await restartedReader.nextResponse(3)).result.thread
      assert.equal(coldChild.turns.length, 1)
      assert.equal(coldChild.turns[0].status, 'completed')
      assert.equal(coldChild.turns[0].itemsView, 'full')
      assert.equal(
        coldChild.turns[0].items.find((item: any) => item.type === 'userMessage').content[0].text,
        'investigate',
      )
      assert.match(
        coldChild.turns[0].items.find((item: any) => item.type === 'agentMessage').text,
        /subagent final summary/,
      )

      restarted.stdin.write(
        json({
          id: 4,
          method: 'thread/read',
          params: { threadId, includeTurns: false },
        }),
      )
      const metadataOnlyParent = (await restartedReader.nextResponse(4)).result.thread
      assert.equal(
        metadataOnlyParent.turns.length,
        0,
        'ordinary thread/read includeTurns:false must remain metadata-only',
      )
    } finally {
      restarted.kill()
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex App 26.818 settles subagents without the unsupported completed activity kind', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'Codex Desktop',
            title: 'Codex Desktop',
            version: '26.818.61809',
          },
          capabilities: { experimentalApi: true },
        },
      }),
    )
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    const activityKinds: string[] = []
    let childThreadId = ''
    let childPromptStarted: any = null
    let childPromptCompleted: any = null
    let waitCompleted: any = null
    let sawCloseAgent = false
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptStarted = item
        }
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawCloseAgent = true
      }
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptCompleted = item
        }
        if (item.type === 'subAgentActivity') activityKinds.push(item.kind)
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
          childThreadId = String(item.receiverThreadIds[0] ?? '')
        }
        if (item.type === 'collabAgentToolCall' && item.tool === 'wait') waitCompleted = item
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawCloseAgent = true
      }
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    assert.deepEqual(
      activityKinds,
      [],
      'Codex App 26.818 must use spawnAgent/wait lifecycle instead of an unsupported started marker',
    )
    assert.ok(childPromptStarted)
    assert.ok(childPromptCompleted)
    assert.equal(childPromptStarted.id, childPromptCompleted.id)
    assert.equal(childPromptCompleted.content[0].text, 'investigate')
    assert.ok(childThreadId)
    assert.ok(waitCompleted)
    assert.equal(waitCompleted.status, 'completed')
    assert.equal(waitCompleted.agentsStates[childThreadId].status, 'completed')
    assert.equal(
      sawCloseAgent,
      false,
      'successful legacy subagents must keep wait/completed as the visible terminal state',
    )

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/read',
        params: { threadId: childThreadId, includeTurns: false },
      }),
    )
    const legacyChild = (await reader.nextResponse(3)).result.thread
    assert.equal(legacyChild.turns.length, 1)
    assert.equal(legacyChild.turns[0].status, 'completed')
    assert.equal(legacyChild.turns[0].itemsView, 'full')
    assert.equal(
      legacyChild.turns[0].items.find((item: any) => item.type === 'userMessage').content[0].text,
      'investigate',
    )
    assert.match(
      legacyChild.turns[0].items.find((item: any) => item.type === 'agentMessage').text,
      /subagent final summary/,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('subagent without a terminal result emits interrupted activity and failed wait', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'orphan subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let childThreadId = ''
    let waitStatus = ''
    let sawClose = false
    const activityKinds: string[] = []
    let childTurnCompleted: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent')
          childThreadId = String(item.receiverThreadIds[0] ?? '')
        if (item.type === 'collabAgentToolCall' && item.tool === 'wait') waitStatus = item.status
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawClose = true
        if (item.type === 'subAgentActivity') activityKinds.push(item.kind)
      }
      if (message.method === 'turn/completed' && message.params.threadId !== threadId)
        childTurnCompleted = message.params.turn
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    assert.ok(childThreadId)
    assert.equal(waitStatus, 'failed')
    assert.equal(
      sawClose,
      true,
      'legacy Codex App needs closeAgent to clear an orphaned child spinner',
    )
    assert.deepEqual(activityKinds, ['interrupted'])
    assert.ok(childTurnCompleted)
    assert.equal(childTurnCompleted.status, 'failed')
    assert.equal(childTurnCompleted.itemsView, 'notLoaded')
    assert.deepEqual(childTurnCompleted.items, [])
    proc.stdin.write(
      json({ id: 3, method: 'thread/turns/list', params: { threadId: childThreadId } }),
    )
    const childTurns = await reader.nextResponse(3)
    assert.equal(childTurns.result.data[0].status, 'failed')

    // Read back, each client gets what it got live: the closeAgent kept for
    // the legacy App would hide the child from a current one.
    const isClose = (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'closeAgent'
    const closesIn = async (
      client: ChildProcessWithoutNullStreams,
      clientReader: JsonLineReader,
      firstId: number,
    ) => {
      const request = async (id: number, method: string, params: unknown) => {
        client.stdin.write(json({ id, method, params }))
        return (await clientReader.nextResponse(id)).result
      }
      const items = (thread: any) => thread.turns.flatMap((turn: any) => turn.items)
      const read = await request(firstId, 'thread/read', { threadId, includeTurns: true })
      const listed = await request(firstId + 1, 'thread/items/list', { threadId })
      const updated = await request(firstId + 2, 'thread/metadata/update', { threadId })
      return {
        read: items(read.thread).filter(isClose),
        listed: listed.data.map((entry: any) => entry.item).filter(isClose),
        updated: items(updated.thread).filter(isClose),
      }
    }
    const kept = await closesIn(proc, reader, 4)
    assert.equal(kept.read.length, 1)
    assert.deepEqual(kept.listed, kept.read)
    assert.deepEqual(kept.updated, kept.read)
    assert.equal('legacyOnly' in kept.read[0], false)

    // The same thread read by a current App, after a restart.
    const exited = once(proc, 'exit')
    proc.kill()
    await exited
    const current = spawnMockAdapter(home)
    try {
      const currentReader = new JsonLineReader(current)
      current.stdin.write(json(codex930Initialize(0)))
      await currentReader.nextResponse(0)
      assert.deepEqual(await closesIn(current, currentReader, 1), {
        read: [],
        listed: [],
        updated: [],
      })
    } finally {
      const currentExited = once(current, 'exit')
      current.kill()
      await currentExited
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop keeps a background report from opening a parent turn after it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const result = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      let listener
      let launches = 0
      const server = new CodexClaudeAppServer(
        new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite')),
        {
          setBackgroundListener: (value) => {
            listener = value
          },
          hasPendingContinuation: () => true,
          runTurn: async (context) => {
            launches += 1
            if (launches > 1) return new Promise(() => {})
            // A background agent reports while this turn runs, so its
            // continuation waits for the turn to clear.
            listener.onAutonomousTurn(context.threadId)
            throw new Error('turn failed')
          },
          async steer() {},
          async interrupt() {},
          async stop() {},
        },
      )
      const messages = []
      let stopping
      const peer = {
        id: 'peer',
        send: (message) => {
          messages.push(message)
          // The adapter stops the moment the turn ends, before the
          // continuation's tick.
          if (message.method === 'turn/completed') stopping ??= server.stop()
        },
        close() {},
      }
      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = messages.find((message) => message.id === 1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'go', text_elements: [] }] },
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await stopping
      process.stdout.write(JSON.stringify({ stopped: Boolean(stopping), launches }))
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe' },
    )
    assert.deepEqual(JSON.parse(result), { stopped: true, launches: 1 })
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('background Agent outlives the parent turn, wakes the parent, and resumes on SendMessage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  const parentTurnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'background subagent check delay=600', text_elements: [] }],
        },
      }),
    )
    const firstTurnId = (await reader.nextResponse(2)).result.turn.id

    // The launching turn settles while the child keeps running.
    const launch = await readUntil(reader, parentTurnCompleted(threadId))
    const spawned = launch.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent',
    )
    const childThreadId = String(spawned?.params.item.receiverThreadIds[0] ?? '')
    assert.ok(childThreadId)
    assert.equal(
      launch.some(
        (m) =>
          (m.method === 'item/started' || m.method === 'item/completed') &&
          m.params.item.tool === 'wait',
      ),
      false,
      'a run_in_background agent gets no wait: nothing waits on it, and closing one marks it done',
    )
    assert.equal(launch.some(parentTurnCompleted(childThreadId)), false)
    assert.deepEqual(activityKinds(launch, threadId), ['started'])

    // The report completes the child, then Claude answers in a turn of its own.
    const report = await readUntil(reader, parentTurnCompleted(threadId))
    const childDone = report.findIndex(parentTurnCompleted(childThreadId))
    assert.ok(childDone >= 0)
    assert.equal(report[childDone].params.turn.status, 'completed')
    assert.ok(
      report.some(
        (m) =>
          m.method === 'item/agentMessage/delta' &&
          m.params.threadId === childThreadId &&
          m.params.delta === 'background report body',
      ),
    )
    const wake = report.findIndex(
      (m) => m.method === 'turn/started' && m.params.threadId === threadId,
    )
    assert.ok(wake > childDone, 'Claude answering the report opens a new parent turn')
    const wakeTurnId = report[wake].params.turn.id
    assert.notEqual(wakeTurnId, firstTurnId)
    const wakeItems = report
      .filter(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === threadId &&
          m.params.turnId === wakeTurnId,
      )
      .map((m) => m.params.item)
    assert.ok(
      wakeItems.some(
        (item) =>
          item.type === 'subAgentActivity' &&
          item.kind === 'completed' &&
          item.agentThreadId === childThreadId,
      ),
    )
    assert.ok(
      wakeItems.some(
        (item) =>
          item.type === 'agentMessage' &&
          /Background agent reported: background report body/.test(item.text),
      ),
    )
    assert.equal(report.at(-1).params.turn.status, 'completed')

    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const parent = (await reader.nextResponse(3)).result.thread
    assert.equal(parent.turns.length, 2)
    assert.equal(
      parent.turns[0].items.some(
        (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
      ),
      false,
      'no dangling wait in persisted history',
    )
    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId: childThreadId } }))
    const child = (await reader.nextResponse(4)).result.thread
    assert.equal(child.agentNickname, 'a0b1c2d3e4f5a6b7')
    assert.equal(child.turns[0].status, 'completed')

    // SendMessage to the agent is Codex's sendInput and reopens the child.
    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'background message check delay=600', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(5)
    const sent = await readUntil(reader, parentTurnCompleted(threadId))
    const sendInput = sent.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'sendInput',
    )?.params.item
    assert.ok(sendInput)
    assert.deepEqual(sendInput.receiverThreadIds, [childThreadId])
    assert.equal(sendInput.prompt, 'dig deeper')
    assert.equal(sendInput.agentsStates[childThreadId].status, 'running')
    assert.equal(
      sent.some((m) => m.method === 'item/started' && m.params.item.type === 'mcpToolCall'),
      false,
      'SendMessage must not render as a generic tool call',
    )
    const resumed = sent.find(
      (m) => m.method === 'turn/started' && m.params.threadId === childThreadId,
    )
    assert.ok(resumed)
    assert.ok(
      sent.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === childThreadId &&
          m.params.item.type === 'userMessage' &&
          m.params.item.content[0].text === 'dig deeper',
      ),
    )
    assert.deepEqual(activityKinds(sent, threadId), ['interacted'])

    const followUp = await readUntil(reader, parentTurnCompleted(threadId))
    const resumedDone = followUp.find(parentTurnCompleted(childThreadId))
    assert.equal(resumedDone?.params.turn.id, resumed.params.turn.id)
    assert.equal(resumedDone?.params.turn.status, 'completed')
    assert.ok(
      followUp.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === threadId &&
          m.params.item.type === 'agentMessage' &&
          /follow-up report/.test(m.params.item.text),
      ),
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// The agent messages a thread's turn published, as their item/completed carried them.
function completedAgentMessages(messages: any[], threadId: string): any[] {
  return messages
    .filter(
      (m) =>
        m.method === 'item/completed' &&
        m.params.threadId === threadId &&
        m.params.item.type === 'agentMessage',
    )
    .map((m) => m.params.item)
}

function heartbeatDeltas(messages: any[]): any[] {
  return messages.filter(
    (m) => m.method === 'item/agentMessage/delta' && /heartbeat/.test(m.params.delta),
  )
}

test('a turn that leaves a background agent running ends quiet, and the report does not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '' })
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('background subagent check delay=600') },
      }),
    )
    await reader.nextResponse(2)

    // The launching turn's answer ends with the App's DONT_NOTIFY heartbeat,
    // sent only in the completed item: the App shows a streaming message raw.
    const launch = await readUntil(reader, turnCompleted(threadId))
    const launched = completedAgentMessages(launch, threadId)
    assert.equal(launched.length, 1)
    assert.equal(launched[0].text, `agent launched in background\n\n${QUIET_TURN_HEARTBEAT}`)
    assert.equal(launched[0].phase, 'final_answer')
    assert.deepEqual(heartbeatDeltas(launch), [])

    // Nothing runs once the agent reported, so its turn lights the dot; the
    // child's own message never carries the block either.
    const report = await readUntil(reader, turnCompleted(threadId))
    const reported = completedAgentMessages(report, threadId)
    assert.ok(reported.some((item) => /Background agent reported/.test(item.text)))
    assert.equal(
      report.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.item.type === 'agentMessage' &&
          /heartbeat/.test(m.params.item.text),
      ),
      false,
    )
    assert.deepEqual(heartbeatDeltas(report), [])

    // History keeps what the App was sent.
    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const turns = (await reader.nextResponse(3)).result.thread.turns
    assert.equal(turns.length, 2)
    const lastText = (turn: any) =>
      turn.items.findLast((item: any) => item.type === 'agentMessage')?.text
    assert.equal(lastText(turns[0]), launched[0].text)
    assert.doesNotMatch(lastText(turns[1]), /heartbeat/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Starts a turn and returns its id with the agent messages it completed.
async function runQuietCheckTurn(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
  threadId: string,
  id: number,
  text: string,
): Promise<{ turnId: string; messages: any[] }> {
  proc.stdin.write(json({ id, method: 'turn/start', params: { threadId, input: textInput(text) } }))
  const turnId = (await reader.nextResponse(id)).result.turn.id
  const seen = await readUntil(
    reader,
    (m) => m.method === 'turn/completed' && m.params.turn.id === turnId,
  )
  assert.equal(seen.at(-1).params.turn.status, 'completed')
  assert.deepEqual(heartbeatDeltas(seen), [])
  return { turnId, messages: completedAgentMessages(seen, threadId) }
}

test('quiet turns follow the background workflows of the thread', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    let nextId = 10
    const runTurn = (text: string) => runQuietCheckTurn(reader, proc, threadId, nextId++, text)

    // Nothing runs: the turn lights the dot.
    const plain = await runTurn('hello')
    assert.equal(plain.messages.length, 1)
    assert.doesNotMatch(plain.messages[0].text, /heartbeat/)

    // Claude's only text came before the Workflow call and completed as
    // commentary; it is completed again, same item, with the heartbeat.
    const textFirst = await runTurn('background workflow check text first')
    assert.deepEqual(
      textFirst.messages.map((item) => [item.id, item.phase, item.text]),
      [
        [textFirst.messages[0].id, 'commentary', 'starting the review workflow'],
        [
          textFirst.messages[0].id,
          'commentary',
          `starting the review workflow\n\n${QUIET_TURN_HEARTBEAT}`,
        ],
      ],
    )

    // The workflow still runs, so the next turn is quiet as well.
    const meanwhile = await runTurn('hello again')
    assert.equal(meanwhile.messages.length, 1)
    assert.ok(meanwhile.messages[0].text.endsWith(`\n\n${QUIET_TURN_HEARTBEAT}`))

    // A turn without a message has nothing to carry the block, and a
    // message of the heartbeat alone would show as a bubble of its own.
    const silent = await runTurn('background workflow check silent')
    assert.deepEqual(silent.messages, [])

    // Once the workflows stop, the turn lights the dot again.
    const stopped = await runTurn('workflow stop check')
    assert.deepEqual(
      stopped.messages.map((item) => item.text),
      ['workflows stopped'],
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a background shell alone never keeps a turn quiet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)

    // A dev server can run for the rest of the chat: the turn that starts it,
    // and every turn while it runs, light the dot.
    const started = await runQuietCheckTurn(reader, proc, threadId, 10, 'background shell check')
    assert.deepEqual(
      started.messages.map((item) => item.text),
      ['dev server started'],
    )
    const meanwhile = await runQuietCheckTurn(reader, proc, threadId, 11, 'hello')
    assert.equal(meanwhile.messages.length, 1)
    assert.doesNotMatch(meanwhile.messages[0].text, /heartbeat/)
    proc.stdin.write(
      json({ id: 12, method: 'thread/backgroundTerminals/list', params: { threadId } }),
    )
    assert.equal((await reader.nextResponse(12)).result.data.length, 1)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0 lets every turn light the dot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '0' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    const started = await runQuietCheckTurn(reader, proc, threadId, 2, 'background workflow check')
    assert.deepEqual(
      started.messages.map((item) => item.text),
      ['review workflow started'],
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('SendMessage to a finished foreground agent reopens it like a background one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'subagent check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    const ran = await readUntil(reader, turnCompleted(threadId))
    const childThreadId = String(
      ran.find((m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent')?.params
        .item.receiverThreadIds[0] ?? '',
    )
    assert.ok(childThreadId)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'foreground message check delay=300', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(3)
    const sent = await readUntil(reader, turnCompleted(threadId))
    const sendInput = sent.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'sendInput',
    )?.params.item
    assert.ok(sendInput, 'SendMessage to a foreground agent is a sendInput, not a plain card')
    assert.deepEqual(sendInput.receiverThreadIds, [childThreadId])
    assert.equal(
      sent.some((m) => m.method === 'item/started' && m.params.item.type === 'mcpToolCall'),
      false,
    )
    const reopened = sent.find(
      (m) => m.method === 'turn/started' && m.params.threadId === childThreadId,
    )
    assert.ok(reopened, 'the child gets a new turn for the message')
    assert.deepEqual(activityKinds(sent, threadId), ['interacted'])

    // The report settles the reopened turn and wakes the parent.
    const report = await readUntil(reader, turnCompleted(threadId))
    const reopenedDone = report.find(turnCompleted(childThreadId))
    assert.equal(reopenedDone?.params.turn.id, reopened.params.turn.id)
    assert.equal(reopenedDone?.params.turn.status, 'completed')
    assert.ok(
      report.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === threadId &&
          m.params.item.type === 'subAgentActivity' &&
          m.params.item.kind === 'completed' &&
          m.params.item.agentThreadId === childThreadId,
      ),
    )

    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId: childThreadId } }))
    const child = (await reader.nextResponse(4)).result.thread
    assert.deepEqual(
      child.turns.map((turn: any) => turn.status),
      ['completed', 'completed'],
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('TaskStop on a background agent is a closeAgent that ends the child as interrupted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    const startTurn = (id: number, text: string) =>
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: { threadId, input: [{ type: 'text', text, text_elements: [] }] },
        }),
      )
    startTurn(2, 'background subagent check delay=5000')
    await reader.nextResponse(2)
    const launch = await readUntil(reader, turnCompleted(threadId))
    const childThreadId = String(
      launch.find((m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent')
        ?.params.item.receiverThreadIds[0] ?? '',
    )
    assert.ok(childThreadId)

    startTurn(3, 'background close check')
    await reader.nextResponse(3)
    const stopped = await readUntil(reader, turnCompleted(threadId))
    const close = stopped.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'closeAgent',
    )?.params.item
    assert.ok(close, 'TaskStop on an agent is a closeAgent, not a plain card')
    assert.equal(close.status, 'completed')
    assert.deepEqual(close.receiverThreadIds, [childThreadId])
    assert.equal(close.agentsStates[childThreadId].status, 'interrupted')
    assert.equal(
      stopped.some((m) => m.method === 'item/started' && m.params.item.type === 'mcpToolCall'),
      false,
    )
    assert.equal(stopped.find(turnCompleted(childThreadId))?.params.turn.status, 'interrupted')
    assert.deepEqual(activityKinds(stopped, threadId), ['interrupted'])
    assert.equal(stopped.at(-1).params.turn.status, 'completed')

    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId: childThreadId } }))
    const child = (await reader.nextResponse(4)).result.thread
    assert.equal(child.turns.at(-1).status, 'interrupted')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a tool Claude runs beside an Agent call keeps its own card', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('parallel agent tool check') },
      }),
    )
    await reader.nextResponse(2)
    const turn = await readUntil(
      reader,
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    )
    const parentItems = turn
      .filter((m) => m.method === 'item/completed' && m.params.threadId === threadId)
      .map((m) => m.params.item)
    const shell = parentItems.find((item) => item.type === 'commandExecution')
    assert.equal(shell?.status, 'completed', 'the parallel Bash call must not be swallowed')
    assert.ok(parentItems.some((item) => item.tool === 'spawnAgent'))
    assert.ok(parentItems.some((item) => item.tool === 'wait' && item.status === 'completed'))
    assert.ok(
      parentItems.some((item) => item.type === 'agentMessage' && item.text === 'both finished'),
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('an agent backgrounded mid-wait closes the wait without marking the child done', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'auto background check delay=600', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(reader, turnCompleted(threadId))
    const waits = launch.filter(
      (m) =>
        (m.method === 'item/started' || m.method === 'item/completed') &&
        m.params.item.tool === 'wait',
    )
    assert.deepEqual(
      waits.map((m) => `${m.method}:${m.params.item.status}`),
      ['item/started:inProgress', 'item/completed:failed'],
      'the wait began and must end, not vanish',
    )
    const waitEnd = waits[1].params.item
    const childThreadId = waitEnd.receiverThreadIds[0]
    // A completed wait would mark every working agent done in the App roster.
    assert.equal(waitEnd.agentsStates[childThreadId].status, 'running')
    assert.equal(launch.some(turnCompleted(childThreadId)), false)

    const report = await readUntil(reader, turnCompleted(threadId))
    assert.equal(report.find(turnCompleted(childThreadId))?.params.turn.status, 'completed')

    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const parent = (await reader.nextResponse(3)).result.thread
    const persistedWait = parent.turns[0].items.find(
      (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(persistedWait?.status, 'failed', 'reload shows the wait the App saw close')
    assert.equal(persistedWait?.agentsStates[childThreadId].status, 'running')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stopping a background child interrupts it without waking the parent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: 'background subagent check delay=30000', text_elements: [] },
          ],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const childStarted = launch.find(
      (m) => m.method === 'turn/started' && m.params.threadId !== threadId,
    )
    const childThreadId = childStarted.params.threadId

    // Codex sends turn/interrupt to every child with an in-progress turn.
    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/interrupt',
        params: { threadId: childThreadId, turnId: childStarted.params.turn.id },
      }),
    )
    const stopped = await readUntil(reader, (m) => m.id === 3 && m.method == null)
    const childDone = stopped.find(
      (m) => m.method === 'turn/completed' && m.params.threadId === childThreadId,
    )
    assert.equal(childDone?.params.turn.status, 'interrupted')

    // The parent had no turn to carry the activity; the next one does.
    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(4)
    const next = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    assert.deepEqual(activityKinds(next, threadId), ['interrupted'])
    assert.equal(
      next.filter((m) => m.method === 'turn/started' && m.params.threadId === threadId).length,
      1,
      'only the user turn runs; a stopped agent does not wake Claude',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('deleting a thread stops its running background child and ends the child turn first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: 'background subagent check delay=30000', text_elements: [] },
          ],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const childThreadId = launch.find(
      (m) => m.method === 'turn/started' && m.params.threadId !== threadId,
    ).params.threadId

    proc.stdin.write(json({ id: 3, method: 'thread/delete', params: { threadId } }))
    const deleted = await readUntil(reader, (m) => m.id === 3 && m.method == null)
    assert.equal(deleted.at(-1).error, undefined)
    const childDone = deleted.findIndex(
      (m) => m.method === 'turn/completed' && m.params.threadId === childThreadId,
    )
    const childGone = deleted.findIndex(
      (m) => m.method === 'thread/deleted' && m.params.threadId === childThreadId,
    )
    assert.notEqual(childDone, -1, 'the running child turn must end')
    assert.equal(deleted[childDone].params.turn.status, 'interrupted')
    assert.ok(childDone < childGone, 'the child turn ends before its thread goes')
    assert.ok(deleted.some((m) => m.method === 'thread/deleted' && m.params.threadId === threadId))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stopping a foreground child ends it as interrupted and the parent carries on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('foreground stop check') },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(
      reader,
      (m) => m.method === 'item/started' && m.params.item?.tool === 'wait',
    )
    const childStarted = launch.find(
      (m) => m.method === 'turn/started' && m.params.threadId !== threadId,
    )
    const childThreadId = childStarted.params.threadId

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/interrupt',
        params: { threadId: childThreadId, turnId: childStarted.params.turn.id },
      }),
    )
    const rest = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const childDone = rest.filter(
      (m) => m.method === 'turn/completed' && m.params.threadId === childThreadId,
    )
    assert.deepEqual(
      childDone.map((m) => m.params.turn.status),
      ['interrupted'],
      'the child ends once, as interrupted, and its late result does not overwrite it',
    )
    const parentDone = rest.find(
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    assert.equal(parentDone.params.turn.status, 'completed', 'the parent turn keeps going')
    const waitEnd = rest.find(
      (m) => m.method === 'item/completed' && m.params.item?.tool === 'wait',
    ).params.item
    assert.equal(waitEnd.agentsStates[childThreadId].status, 'interrupted')
    assert.deepEqual(activityKinds(rest, threadId), ['interrupted'])

    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/read',
        params: { threadId: childThreadId, includeTurns: true },
      }),
    )
    const child = (await reader.nextResponse(4)).result.thread
    assert.equal(child.turns.at(-1).status, 'interrupted')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Codex App 26.930's subagent roster reducer (app-initial I5t), reduced to the
// status it shows per agent for one parent turn's items.
function appRoster(items: any[], isTurnLive: boolean): Map<string, string> {
  const fromState: Record<string, string> = {
    pendingInit: 'waiting',
    running: 'working',
    completed: 'done',
    interrupted: 'done',
    shutdown: 'done',
    errored: 'failed',
    notFound: 'failed',
  }
  const busy = (status: string) => status === 'waiting' || status === 'working'
  const roster = new Map<string, string>()
  const status = (id: string) => roster.get(id) ?? 'working'
  for (const item of items) {
    if (item.type === 'subAgentActivity') {
      const ended = item.kind === 'completed' || item.kind === 'interrupted'
      roster.set(item.agentThreadId, ended ? 'done' : 'working')
      continue
    }
    if (item.type !== 'collabAgentToolCall') continue
    const spawning = ['spawnAgent', 'sendInput', 'resumeAgent'].includes(item.tool)
    for (const id of item.receiverThreadIds)
      roster.set(id, item.status !== 'failed' && spawning ? 'working' : status(id))
    for (const [id, state] of Object.entries<any>(item.agentsStates ?? {}))
      roster.set(id, fromState[state.status] ?? status(id))
    if (item.tool === 'wait' && item.status === 'completed')
      for (const [id, value] of roster) if (busy(value)) roster.set(id, 'done')
  }
  if (!isTurnLive) for (const [id, value] of roster) if (busy(value)) roster.set(id, 'done')
  return roster
}

// The parent thread's items as the App holds them: first appearance order,
// latest state.
function liveItems(messages: any[], threadId: string): any[] {
  const items = new Map<string, any>()
  for (const m of messages)
    if (
      (m.method === 'item/started' || m.method === 'item/completed') &&
      m.params.threadId === threadId
    )
      items.set(m.params.item.id, m.params.item)
  return [...items.values()]
}

test('a foreground agent finishing beside a background one leaves the background agent working', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'mixed agents check delay=400', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(reader, turnCompleted(threadId))
    const spawned = launch
      .filter((m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent')
      .map((m) => m.params.item)
    const bgChild = String(
      spawned.find((item) => item.prompt === 'sleep then report')?.receiverThreadIds[0],
    )
    const fgChild = String(
      spawned.find((item) => item.prompt === 'answer now')?.receiverThreadIds[0],
    )
    const waitEnd = launch.findIndex(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'wait',
    )
    assert.ok(waitEnd >= 0, 'the foreground agent is waited on')
    const wait = launch[waitEnd].params.item
    assert.deepEqual(wait.receiverThreadIds, [fgChild])
    assert.equal(wait.agentsStates[fgChild].status, 'completed')
    assert.equal(wait.status, 'failed', 'a completed wait would end the background agent too')
    assert.equal(launch.some(turnCompleted(bgChild)), false)

    const roster = appRoster(liveItems(launch.slice(0, waitEnd + 1), threadId), true)
    assert.equal(roster.get(fgChild), 'done')
    assert.equal(roster.get(bgChild), 'working')

    const report = await readUntil(reader, turnCompleted(threadId))
    const childDone = report.find(turnCompleted(bgChild))
    assert.equal(childDone?.params.turn.status, 'completed')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the first of two foreground agents to finish does not end the other in the App roster', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'sibling agents check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    const turn = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const child = (prompt: string) =>
      String(
        turn.find(
          (m) =>
            m.method === 'item/completed' &&
            m.params.item.tool === 'spawnAgent' &&
            m.params.item.prompt === prompt,
        )?.params.item.receiverThreadIds[0],
      )
    const quick = child('quick agent')
    const slow = child('slow agent')
    const waitEnds = turn
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.method === 'item/completed' && m.params.item.tool === 'wait')
    assert.equal(waitEnds.length, 2)
    const [first, second] = waitEnds
    assert.deepEqual(first?.m.params.item.receiverThreadIds, [quick])
    assert.equal(first?.m.params.item.status, 'failed')
    assert.equal(first?.m.params.item.agentsStates[quick].status, 'completed')
    const midway = appRoster(liveItems(turn.slice(0, (first?.index ?? 0) + 1), threadId), true)
    assert.equal(midway.get(quick), 'done')
    assert.equal(midway.get(slow), 'working')

    assert.deepEqual(second?.m.params.item.receiverThreadIds, [slow])
    assert.equal(second?.m.params.item.status, 'completed', 'the last agent closes normally')
    const settled = appRoster(liveItems(turn, threadId), false)
    assert.deepEqual([settled.get(quick), settled.get(slow)], ['done', 'done'])

    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const persisted = (await reader.nextResponse(3)).result.thread.turns[0].items
    const persistedWaits = persisted.filter((item: any) => item.tool === 'wait')
    assert.deepEqual(
      persistedWaits.map((item: any) => item.status).sort(),
      ['completed', 'failed'],
      'reload shows the same wait states the App saw live',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('initialize reports an unverified desktop App build as a config warning', async () => {
  const warningsFor = async (version: string): Promise<any[]> => {
    const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
    const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    const reader = new JsonLineReader(proc)
    try {
      proc.stdin.write(
        json({
          id: 0,
          method: 'initialize',
          params: {
            clientInfo: { name: 'codex_desktop', title: 'Codex Desktop', version },
            capabilities: { experimentalApi: true },
          },
        }),
      )
      proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
      const seen = await readUntil(reader, (message) => message.id === 1 && message.method == null)
      return seen.filter((message) => message.method === 'configWarning')
    } finally {
      proc.kill()
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  }

  assert.deepEqual(await warningsFor('26.930.21537'), [])
  const [warning, ...rest] = await warningsFor('26.1015.100')
  assert.equal(rest.length, 0)
  assert.match(warning.params.summary, /Codex App 26\.1015\.100/)
  assert.match(warning.params.details, /26\.930\.21537/)
})

function codex930Initialize(id: number) {
  return {
    id,
    method: 'initialize',
    params: {
      clientInfo: { name: 'Codex Desktop', title: 'Codex Desktop', version: '26.930.21537' },
      capabilities: { experimentalApi: true },
    },
  }
}

async function readUntil(
  reader: JsonLineReader,
  stop: (message: any) => boolean,
  limit = 800,
): Promise<any[]> {
  const seen: any[] = []
  for (let i = 0; i < limit; i += 1) {
    const message = await reader.next()
    seen.push(message)
    if (stop(message)) return seen
  }
  throw new Error('readUntil: condition not met')
}

function activityKinds(messages: any[], threadId: string): string[] {
  return messages
    .filter(
      (m) =>
        m.method === 'item/completed' &&
        m.params.threadId === threadId &&
        m.params.item.type === 'subAgentActivity',
    )
    .map((m) => m.params.item.kind)
}

test('bare /workflows lists prior workflow runs without invoking the model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: '/workflows subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(3)
    let listText = ''
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') listText += message.params.delta
      if (message.method === 'turn/completed') break
    }

    assert.match(listText, /Workflow runs in this task:/)
    assert.match(listText, /1 agent\(s\)/)
    assert.match(listText, /subagent check/)
    assert.doesNotMatch(listText, /Claude Code adapter mock response/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('/workflows also lists the workflows Claude ran without the command', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    const prompts = ['run the model workflow check', 'plain question', '/workflows']
    let listText = ''
    for (const [index, text] of prompts.entries()) {
      const id = index + 2
      proc.stdin.write(
        json({ id, method: 'turn/start', params: { threadId, input: textInput(text) } }),
      )
      await reader.nextResponse(id)
      const messages = await readUntil(
        reader,
        (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
      )
      listText = messages
        .filter((m) => m.method === 'item/agentMessage/delta' && m.params.threadId === threadId)
        .map((m) => m.params.delta)
        .join('')
    }

    assert.match(listText, /Workflow runs in this task:/)
    assert.match(listText, /completed · 1 agent\(s\) · run the model workflow check/)
    assert.match(listText, /\(workflow, completed\)/)
    assert.doesNotMatch(listText, /plain question/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/start picks up effort from config.model_reasoning_effort when top-level effort is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    // Codex App's settings sheet writes the persistent effort under
    // params.config.model_reasoning_effort (snake_case, just like the CLI's
    // config.toml). Make sure we accept it from there even when the top-level
    // `effort` field is absent — without this fix the user's "high" pick
    // gets silently dropped and Claude runs at the env default.
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), config: { model_reasoning_effort: 'high' } },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    // Drive a turn with effort=null on the wire (mimicking what Codex App
    // actually sends — top-level effort is null, the real value came in via
    // thread/start.config). Mock echoes the effort the runtime received.
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'effort echo', text_elements: [] }],
          effort: null,
          model: null,
        },
      }),
    )
    await reader.nextResponse(2)
    let echoed = ''
    for (let i = 0; i < 500; i += 1) {
      const message: any = await reader.next()
      if (message.method === 'item/agentMessage/delta') echoed += String(message.params.delta ?? '')
      if (message.method === 'turn/completed') break
    }
    assert.equal(
      echoed,
      'effort=high',
      'config.model_reasoning_effort should flow through to the runtime',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/start coerces invalid threadSource / source values so Codex App never sees a non-enum', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    // Empty string and bogus enum values must round-trip as null, not as the
    // literal "" / "totally-bogus" — otherwise App ts-rs deserializer panics
    // on reopen and shows "Oops, an error has occurred".
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), threadSource: '' } }),
    )
    const empty = await reader.nextResponse(1)
    assert.equal(
      empty.result.thread.threadSource,
      null,
      'empty threadSource must serialize as null',
    )
    assert.equal(empty.result.thread.source, 'appServer', 'source must use camelCase wire form')

    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), threadSource: 'totally-bogus' },
      }),
    )
    const bogus = await reader.nextResponse(2)
    assert.equal(
      bogus.result.thread.threadSource,
      null,
      'unknown threadSource enum must serialize as null',
    )

    // Valid enum values still pass through unchanged.
    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/start',
        params: { cwd: process.cwd(), threadSource: 'subagent' },
      }),
    )
    const valid = await reader.nextResponse(3)
    assert.equal(valid.result.thread.threadSource, 'subagent')

    // Empty string for agentRole / agentNickname collapses to null on the wire.
    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/start',
        params: { cwd: process.cwd(), agentRole: '', agentNickname: '' },
      }),
    )
    const empties = await reader.nextResponse(4)
    assert.equal(empties.result.thread.agentRole, null)
    assert.equal(empties.result.thread.agentNickname, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('legacy DB rows with invalid thread_source / source are sanitized on startup', async () => {
  const { SessionStore } = await import(resolve('dist/src/store.mjs'))
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-migrate-'))
  const dbPath = join(home, 'state.sqlite')
  try {
    // First open: create schema, then poison the rows directly via raw SQL
    // to mimic what an older adapter version would have written.
    const initial = new SessionStore(dbPath)
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => any }
    initial.upsertThread({
      id: 'th-bad',
      sessionId: 'th-bad',
      forkedFromId: null,
      preview: '',
      name: null,
      archived: false,
      cwd: process.cwd(),
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'app_server',
      createdAt: 0,
      updatedAt: 0,
      status: { type: 'idle' },
      approvalPolicy: null,
      sandboxMode: null,
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    } as any)
    // Now directly corrupt the columns the way the old adapter did.
    const raw = new DatabaseSync(dbPath)
    raw
      .prepare(
        `UPDATE threads SET source = 'app_server', thread_source = '', agent_role = '', agent_nickname = '' WHERE id = 'th-bad'`,
      )
      .run()
    raw.close()

    // Second open: migration must rewrite the bad values.
    const repaired = new SessionStore(dbPath)
    const row = repaired.getThread('th-bad')
    assert.equal(row.source, 'appServer', 'legacy app_server should be rewritten to appServer')
    assert.equal(row.threadSource, null, 'invalid threadSource should be NULLed out')
    assert.equal(row.agentRole, null)
    assert.equal(row.agentNickname, null)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/start with ephemeral=true is hidden from thread/list and surfaces threadSource', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          ephemeral: true,
          threadSource: 'memory_consolidation',
          model: 'gpt-5.4-mini',
        },
      }),
    )
    const ephemeralStart = await reader.nextResponse(1)
    const ephemeralId = ephemeralStart.result.thread.id
    assert.equal(
      ephemeralStart.result.thread.ephemeral,
      true,
      'envelope should reflect ephemeral=true',
    )
    assert.equal(ephemeralStart.result.thread.threadSource, 'memory_consolidation')

    proc.stdin.write(
      json({ id: 2, method: 'thread/start', params: { cwd: process.cwd(), threadSource: 'user' } }),
    )
    const userStart = await reader.nextResponse(2)
    const userId = userStart.result.thread.id
    proc.stdin.write(
      json({ id: 10, method: 'turn/start', params: { threadId: userId, input: textInput('hi') } }),
    )
    await awaitMessage(reader, (message) => message.method === 'turn/completed')

    proc.stdin.write(json({ id: 3, method: 'thread/list', params: {} }))
    const list = await reader.nextResponse(3)
    const ids = (list.result.data as any[]).map((t) => t.id)
    assert.ok(ids.includes(userId), 'normal user thread should appear')
    assert.ok(!ids.includes(ephemeralId), 'ephemeral title/summary thread should be filtered out')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('debug.jsonl rotates once it crosses CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES', async () => {
  const util = await import(resolve('dist/src/util.mjs'))
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-rotate-'))
  const logPath = join(home, 'debug.jsonl')
  const prevPath = process.env.CLAUDE_CODEX_DEBUG_LOG
  const prevMax = process.env.CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES
  const prevKeep = process.env.CLAUDE_CODEX_DEBUG_LOG_KEEP
  process.env.CLAUDE_CODEX_DEBUG_LOG = logPath
  process.env.CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES = '512'
  process.env.CLAUDE_CODEX_DEBUG_LOG_KEEP = '2'
  try {
    // Each line is ~150 bytes; write enough to cross 512 bytes twice.
    for (let i = 0; i < 30; i += 1) util.debugLog('test.rotate', { i, payload: 'x'.repeat(120) })
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(home)
    assert.ok(entries.includes('debug.jsonl'), 'active log should exist')
    assert.ok(entries.includes('debug.jsonl.1'), 'rotation should have produced a .1 slot')
    // KEEP=2 means at most .1 + .2; .3 must never appear.
    assert.ok(
      !entries.includes('debug.jsonl.3'),
      'rotation should respect CLAUDE_CODEX_DEBUG_LOG_KEEP',
    )
    const activeSize = (await fs.stat(logPath)).size
    assert.ok(activeSize < 512 * 4, 'active log should have been freshly started after rotation')
  } finally {
    if (prevPath == null) delete process.env.CLAUDE_CODEX_DEBUG_LOG
    else process.env.CLAUDE_CODEX_DEBUG_LOG = prevPath
    if (prevMax == null) delete process.env.CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES
    else process.env.CLAUDE_CODEX_DEBUG_LOG_MAX_BYTES = prevMax
    if (prevKeep == null) delete process.env.CLAUDE_CODEX_DEBUG_LOG_KEEP
    else process.env.CLAUDE_CODEX_DEBUG_LOG_KEEP = prevKeep
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('defaultSocketPath stays within the platform sun_path limit', async () => {
  const util = await import(resolve('dist/src/util.mjs'))
  const prev = process.env.CODEX_HOME
  process.env.CODEX_HOME = '/' + 'very-long-codex-home-segment'.repeat(8)
  try {
    const socketPath = util.defaultSocketPath()
    assert.ok(
      socketPath.length <= util.socketPathLimit(),
      `socket path ${socketPath.length} exceeds limit ${util.socketPathLimit()}`,
    )
  } finally {
    if (prev == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
  }
})

test('approval requests round-trip through Codex server requests', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: process.cwd(),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          permissions: ':workspace',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let approvalRequest: any = null
    let sawWaitingOnApproval = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (
        message.method === 'thread/status/changed' &&
        message.params.status.activeFlags?.includes('waitingOnApproval')
      ) {
        sawWaitingOnApproval = true
      }
      if (message.method === 'item/commandExecution/requestApproval') {
        approvalRequest = message
        break
      }
    }
    assert.equal(approvalRequest?.params.command, 'echo mock approval')
    assert.equal(sawWaitingOnApproval, true)
    proc.stdin.write(json({ id: approvalRequest.id, result: { decision: 'accept' } }))

    let sawResolved = false
    let sawOutput = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'serverRequest/resolved') sawResolved = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawResolved, true)
    assert.equal(sawOutput, true)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('generic Claude tools complete as Codex mcpToolCall items', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please use generic tool', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let completedTool: any = null
    let sawIdle = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/status/changed' && message.params.status.type === 'idle')
        sawIdle = true
      if (message.method === 'item/completed' && message.params.item.type === 'mcpToolCall')
        completedTool = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.equal(completedTool?.tool, 'Read README.md')
    assert.equal(completedTool?.status, 'completed')
    // Result must be wrapped in Codex v2 McpToolCallResult shape — {content[], structuredContent, _meta}.
    // The mock runtime returns {text:'mock read result'} as the raw content, which we wrap as:
    //   content: [{type:'text', text:'<json>'}], structuredContent: <object>, _meta: null.
    assert.deepEqual(completedTool?.result, {
      content: [{ type: 'text', text: JSON.stringify({ text: 'mock read result' }) }],
      structuredContent: { text: 'mock read result' },
      _meta: null,
    })
    assert.equal(sawIdle, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

function spawnMockAdapter(
  home: string,
  env: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  })
}

async function awaitMessage(
  reader: JsonLineReader,
  done: (message: any) => boolean,
  seen: any[] = [],
): Promise<any> {
  for (let i = 0; i < 5000; i += 1) {
    const message = await reader.next()
    seen.push(message)
    if (done(message)) return message
  }
  throw new Error('expected message never arrived')
}

// Collects everything that arrives until the adapter stays quiet for `ms`.
async function readQuiet(reader: JsonLineReader, ms: number): Promise<any[]> {
  const seen: any[] = []
  for (;;) {
    const message = await reader.nextWithin(ms)
    if (message == null) return seen
    seen.push(message)
  }
}

// Waits for `turns` turns to complete, then reads until the adapter stays quiet
// for `ms`: a slow runner still sees every expected turn, and a turn too many
// still shows up.
async function readTurns(reader: JsonLineReader, turns: number, ms: number): Promise<any[]> {
  const seen: any[] = []
  for (let i = 0; i < turns; i += 1) {
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
  }
  seen.push(...(await readQuiet(reader, ms)))
  return seen
}

async function startMockThread(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
): Promise<string> {
  proc.stdin.write(
    json({
      id: 1,
      method: 'thread/start',
      params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
    }),
  )
  const start = await reader.nextResponse(1)
  return start.result.thread.id
}

function textInput(text: string): unknown[] {
  return [{ type: 'text', text, text_elements: [] }]
}

function isUserMessageItem(message: any, method: string, clientId: string): boolean {
  return (
    message.method === method &&
    message.params.item.type === 'userMessage' &&
    message.params.item.clientId === clientId
  )
}

test('turn/steer appends user input to an active Claude turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)

    proc.stdin.write(
      json({ id: 2, method: 'turn/steer', params: { threadId, input: textInput('too early') } }),
    )
    const early = await reader.nextResponse(2)
    assert.equal(early.error.message, 'no active turn to steer')

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: textInput('slow turn for steering') },
      }),
    )
    const turnId = (await reader.nextResponse(3)).result.turn.id
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta')

    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: 'stale-turn', input: textInput('mismatch') },
      }),
    )
    const mismatch = await reader.nextResponse(4)
    assert.equal(
      mismatch.error.message,
      `expected active turn id \`stale-turn\` but found \`${turnId}\``,
    )

    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/steer',
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: 'client-steer-1',
          input: textInput('steered input'),
        },
      }),
    )
    const seen: any[] = []
    const steer = await awaitMessage(reader, (message) => message.id === 5, seen)
    assert.equal(steer.result.turnId, turnId)
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    // The accepted steer surfaces as a userMessage carrying the App's id, so
    // the App can settle its pending steering bubble.
    const started = seen.find((message) =>
      isUserMessageItem(message, 'item/started', 'client-steer-1'),
    )
    assert.equal(started?.params.turnId, turnId)
    assert.equal(started?.params.item.content[0].text, 'steered input')
    assert.ok(
      seen.some((message) => isUserMessageItem(message, 'item/completed', 'client-steer-1')),
    )

    proc.stdin.write(
      json({ id: 6, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    const items = await reader.nextResponse(6)
    assert.equal(
      items.result.data.some(
        (item: any) => item.type === 'userMessage' && item.content?.[0]?.text === 'steered input',
      ),
      true,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn/start during a running turn joins that turn instead of orphaning it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: textInput('hold this turn until released while another turn/start arrives'),
        },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta', seen)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, clientUserMessageId: 'client-late-1', input: textInput('late input') },
      }),
    )
    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/start',
        params: { threadId, input: textInput('/workflows') },
      }),
    )
    // The refusal can answer first: the joined input waits for Claude to take
    // it in.
    const replies = new Map<number, any>()
    await awaitMessage(
      reader,
      (message) => {
        if (message.id === 3 || message.id === 4) replies.set(message.id, message)
        return replies.size === 2
      },
      seen,
    )
    assert.equal(replies.get(3).result.turn.id, turnId)
    assert.equal(
      replies.get(4).error.message,
      '/workflows list can run once the current turn finishes',
    )
    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: turnId, input: textInput('release') },
      }),
    )
    const completed = await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed',
      seen,
    )
    assert.equal(completed.params.turn.id, turnId)
    seen.push(...(await readQuiet(reader, 200)))
    assert.deepEqual(
      seen
        .filter((message) => message.method === 'turn/started' && message.params.turn.id !== turnId)
        .map((message) => message.params.turn.id),
      [],
      'no second turn starts',
    )
    const joined = seen.find((message) =>
      isUserMessageItem(message, 'item/started', 'client-late-1'),
    )
    assert.equal(joined?.params.turnId, turnId)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('input for a turn whose session is still coming up waits for it instead of failing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('slow start, then hold this turn until released') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    // The runtime has no turn to steer into yet. Refusing the input here
    // would leave the App showing an error for a turn that runs fine.
    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, clientUserMessageId: 'client-early-1', input: textInput('release') },
      }),
    )
    const seen: any[] = []
    const reply = await awaitMessage(reader, (message) => message.id === 3, seen)
    assert.equal(reply.error, undefined)
    assert.equal(reply.result.turn.id, turnId)
    const completed = await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed',
      seen,
    )
    assert.equal(completed.params.turn.id, turnId)
    assert.equal(completed.params.turn.status, 'completed')
    const joined = seen.find((message) =>
      isUserMessageItem(message, 'item/started', 'client-early-1'),
    )
    assert.equal(joined?.params.turnId, turnId)
    seen.push(...(await readQuiet(reader, 200)))
    assert.deepEqual(
      seen
        .filter((message) => message.method === 'turn/started' && message.params.turn.id !== turnId)
        .map((message) => message.params.turn.id),
      [],
      'no second turn starts',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/queue holds follow-ups during a turn and dispatches them in order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('slow turn before the queue drains') },
      }),
    )
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta')

    const add = (id: number, text: string, clientUserMessageId: string) =>
      call(id, 'thread/queue/add', { threadId, input: textInput(text), clientUserMessageId })
    const first = (await add(3, 'queued one', 'client-1')).result.queuedSubmission
    const second = (await add(4, 'queued two', 'client-2')).result.queuedSubmission
    const third = (await add(5, 'queued three', 'client-3')).result.queuedSubmission
    assert.equal(first.clientUserMessageId, 'client-1')
    assert.deepEqual(first.input, textInput('queued one'))

    const empty = await call(6, 'thread/queue/add', { threadId, input: [] })
    assert.match(empty.error.message, /must not be empty/)

    await call(7, 'thread/queue/reorder', { threadId, queuedSubmissionIds: [second.id] })
    const edited = await call(8, 'thread/queue/update', {
      threadId,
      queuedSubmissionId: third.id,
      input: textInput('queued three edited'),
    })
    assert.deepEqual(edited.result.queuedSubmission.input, textInput('queued three edited'))
    const list = await call(9, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(
      list.result.data.map((entry: any) => entry.id),
      [second.id, first.id, third.id],
    )
    assert.equal(list.result.nextCursor, null)
    assert.equal(
      (await call(10, 'thread/queue/delete', { threadId, queuedSubmissionId: third.id })).result
        .deleted,
      true,
    )
    assert.equal(
      (await call(11, 'thread/queue/delete', { threadId, queuedSubmissionId: third.id })).result
        .deleted,
      false,
    )

    // The queue drains head first once the running turn settles: one user
    // turn per submission, each publishing its message with the client id.
    const seen: any[] = []
    let completedTurns = 0
    await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed' && ++completedTurns === 3,
      seen,
    )
    const userMessages = seen
      .filter(
        (message) =>
          message.method === 'item/started' && message.params.item.type === 'userMessage',
      )
      .map((message) => message.params.item.clientId)
    assert.deepEqual(userMessages, ['client-2', 'client-1'])
    assert.ok(seen.some((message) => message.method === 'thread/queue/changed'))

    const drained = await call(12, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(drained.result.data, [])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/queue pauses after an interrupt until thread/queue/start', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('slow turn that the user stops') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta')
    const queued = (
      await call(3, 'thread/queue/add', {
        threadId,
        input: textInput('held message'),
        clientUserMessageId: 'client-held',
      })
    ).result.queuedSubmission
    await call(4, 'turn/interrupt', { threadId, turnId })

    const quiet = await readQuiet(reader, 400)
    assert.equal(
      quiet.some((message) => message.method === 'turn/started'),
      false,
    )
    const held = await call(5, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(
      held.result.data.map((entry: any) => entry.id),
      [queued.id],
    )

    const started = await call(6, 'thread/queue/start', {
      threadId,
      queuedSubmissionId: queued.id,
    })
    assert.equal(typeof started.result.turn.id, 'string')
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.ok(seen.some((message) => isUserMessageItem(message, 'item/started', 'client-held')))
    const drained = await call(7, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(drained.result.data, [])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/goal/set keeps the thread working until the model completes the goal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    const missing = await call(2, 'thread/goal/set', { threadId, status: 'paused' })
    assert.match(missing.error.message, /no goal exists/)

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/goal/set',
        params: { threadId, objective: 'goal complete check', status: 'active' },
      }),
    )
    const seen: any[] = []
    const set = await awaitMessage(reader, (message) => message.id === 3, seen)
    assert.equal(set.result.goal.status, 'active')
    assert.equal(set.result.goal.tokenBudget, null)
    const started = await awaitMessage(reader, (message) => message.method === 'turn/started', seen)
    const turnId = started.params.turn.id
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    const updates = seen
      .filter((message) => message.method === 'thread/goal/updated')
      .map((message) => message.params)
    const finished = updates.at(-1)
    assert.equal(finished.goal.status, 'complete')
    assert.equal(finished.goal.tokensUsed, 145)
    assert.equal(finished.turnId, turnId)
    // Claude reports usage with the result, after update_goal already marked
    // the goal complete; the turn's tokens still land on the goal.
    assert.equal(
      updates.filter((update) => update.goal.status === 'complete')[0].goal.tokensUsed,
      0,
    )

    // A completed goal ends the run; nothing else starts.
    const quiet = await readQuiet(reader, 400)
    assert.equal(
      quiet.some((message) => message.method === 'turn/started'),
      false,
    )
    // The continuation prompt is hidden: no user message on the turn.
    const items = await call(4, 'thread/turns/items/list', { threadId, turnId })
    assert.equal(
      items.result.data.some((item: any) => item.type === 'userMessage'),
      false,
    )
    const get = await call(5, 'thread/goal/get', { threadId })
    assert.equal(get.result.goal.status, 'complete')
    const clear = await call(6, 'thread/goal/clear', { threadId })
    assert.equal(clear.result.cleared, true)
    assert.equal((await call(7, 'thread/goal/get', { threadId })).result.goal, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('goal continuation stops when a hidden turn makes no progress or exhausts the budget', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  const countTurns = (messages: any[]) =>
    messages.filter((message) => message.method === 'turn/started').length
  try {
    const threadId = await startMockThread(reader, proc)
    await call(2, 'thread/goal/set', { threadId, objective: 'keep going', status: 'active' })
    // One hidden continuation with no tool work, then the run stops.
    const first = await readTurns(reader, 1, 500)
    assert.equal(countTurns(first), 1)
    assert.equal((await call(3, 'thread/goal/get', { threadId })).result.goal.status, 'active')

    // A user turn gives the goal another continuation.
    proc.stdin.write(
      json({ id: 4, method: 'turn/start', params: { threadId, input: textInput('nudge') } }),
    )
    const nudged = await readTurns(reader, 2, 500)
    assert.equal(countTurns(nudged), 2)

    // A budget the continuation overruns stops the goal.
    await call(5, 'thread/goal/set', { threadId, tokenBudget: 300, status: 'active' })
    const budgeted = await readTurns(reader, 1, 500)
    assert.equal(countTurns(budgeted), 1)
    const goal = (await call(6, 'thread/goal/get', { threadId })).result.goal
    assert.equal(goal.status, 'budgetLimited')
    assert.equal(goal.tokensUsed, 435)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a goal budget that runs out mid-turn steers the model to wrap up and ends the run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    await call(2, 'thread/goal/set', {
      threadId,
      objective: 'goal budget steer check',
      tokenBudget: 300,
      status: 'active',
    })
    const run = await readTurns(reader, 1, 600)
    assert.equal(run.filter((message) => message.method === 'turn/started').length, 1)
    const limitedAt = run.findIndex(
      (message) =>
        message.method === 'thread/goal/updated' && message.params.goal.status === 'budgetLimited',
    )
    const completedAt = run.findIndex((message) => message.method === 'turn/completed')
    assert.ok(limitedAt >= 0 && limitedAt < completedAt, 'the budget runs out inside the turn')
    assert.ok(
      run.some(
        (message) =>
          message.method === 'item/agentMessage/delta' &&
          message.params.delta === 'wrapping up on budget',
      ),
      'the running turn got the budget-limit steer',
    )
    const goal = (await call(3, 'thread/goal/get', { threadId })).result.goal
    assert.equal(goal.status, 'budgetLimited')
    // 420 streamed, then the result settles the turn at 510.
    assert.equal(goal.tokensUsed, 510)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('editing the goal objective mid-turn steers the running turn instead of starting another', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    const seen: any[] = []
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/goal/set',
        params: { threadId, objective: 'goal objective steer check', status: 'active' },
      }),
    )
    await awaitMessage(reader, (message) => message.method === 'turn/started', seen)
    const objective = 'goal objective steer check: revised objective'
    proc.stdin.write(json({ id: 3, method: 'thread/goal/set', params: { threadId, objective } }))
    const edit = await awaitMessage(
      reader,
      (message) => message.id === 3 && message.method == null,
      seen,
    )
    assert.equal(edit.result.goal.objective, objective)
    assert.equal(edit.result.goal.status, 'active')
    const ended = seen.some((message) => message.method === 'turn/completed')
    seen.push(...(await readTurns(reader, ended ? 0 : 1, 600)))

    assert.ok(
      seen.some(
        (message) =>
          message.method === 'item/agentMessage/delta' &&
          message.params.delta === 'now on the revised objective',
      ),
      'the running turn got the edited objective',
    )
    assert.equal(seen.filter((message) => message.method === 'turn/started').length, 1)
    assert.equal(seen.filter((message) => message.method === 'turn/completed').length, 1)
    assert.ok(
      !seen.some(
        (message) =>
          message.method === 'item/started' && message.params.item.type === 'userMessage',
      ),
      'the steer stays hidden',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('AskUserQuestion is bridged to Codex item/tool/requestUserInput', async () => {
  // Bug repro: Claude's AskUserQuestion tool calls weren't surfaced in the
  // App UI — they fell through as generic mcpToolCall items with no choice
  // card. We bridge them to Codex's native request_user_input reverse RPC
  // so the App pops its structured picker, then route the user's answer
  // back to the model.
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'ask user question check', text_elements: [] }],
        },
      }),
    )
    const started = await reader.nextResponse(2)
    const turnId = started.result.turn.id

    // Wait for the server's reverse-RPC asking us to answer. Real Codex
    // protocol: request id is numeric/server-side, params carry the
    // structured questions.
    let askRequest: any | null = null
    while (askRequest == null) {
      const message = await reader.next()
      if (message.method === 'item/tool/requestUserInput') {
        askRequest = message
      }
    }
    assert.equal(askRequest.params.threadId, threadId)
    assert.equal(askRequest.params.turnId, turnId)
    assert.equal(Array.isArray(askRequest.params.questions), true)
    assert.equal(askRequest.params.questions[0].header, 'Auth')
    assert.equal(askRequest.params.questions[0].question, 'Which auth method do you want?')
    // The bridge auto-appends an "Other" option so the App's free-text
    // affordance lights up even when Claude didn't model one explicitly.
    assert.equal(
      askRequest.params.questions[0].options.some((o: any) => o.label === 'Other'),
      true,
    )

    // Answer as the App would.
    proc.stdin.write(
      json({
        jsonrpc: '2.0',
        id: askRequest.id,
        result: { answers: { q0: { answers: ['OAuth'] } } },
      }),
    )

    let completed = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') {
        completed = true
        break
      }
    }
    assert.equal(completed, true)

    proc.stdin.write(
      json({ id: 4, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    const items = await reader.nextResponse(4)
    const itemsList = items.result.data as Array<any>
    const dynamic = itemsList.find((item) => item.type === 'dynamicToolCall')
    assert.ok(dynamic, 'expected a dynamicToolCall item in the turn')
    assert.equal(dynamic.tool, 'AskUserQuestion')
    assert.equal(dynamic.status, 'completed')
    assert.equal(dynamic.success, true)
    assert.equal(Array.isArray(dynamic.contentItems), true)
    assert.match(dynamic.contentItems[0].text, /OAuth/)
    // No stray mcpToolCall for AskUserQuestion (otherwise the App would
    // draw a duplicate generic card alongside the choice picker).
    assert.equal(
      itemsList.some((item) => item.type === 'mcpToolCall' && item.tool === 'AskUserQuestion'),
      false,
    )
    // The chosen answer also reached the mock through onUserInputRequest's
    // return value (and got echoed back as the final agent message text).
    const agent = itemsList.find((item) => item.type === 'agentMessage')
    assert.ok(
      agent && /picked=OAuth/.test(agent.text),
      'expected the agent message to echo the picked answer',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('compatibility-only UI methods return schema-shaped responses', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'thread/increment_elicitation', params: { threadId } }))
    assert.deepEqual((await reader.nextResponse(2)).result, { count: 1, paused: true })

    proc.stdin.write(json({ id: 3, method: 'thread/decrement_elicitation', params: { threadId } }))
    assert.deepEqual((await reader.nextResponse(3)).result, { count: 0, paused: false })

    proc.stdin.write(
      json({
        id: 4,
        method: 'experimentalFeature/enablement/set',
        params: { enablement: { demo: true } },
      }),
    )
    assert.deepEqual((await reader.nextResponse(4)).result, { enablement: { demo: true } })

    proc.stdin.write(json({ id: 5, method: 'mock/experimentalMethod', params: { value: 'ok' } }))
    assert.deepEqual((await reader.nextResponse(5)).result, { echoed: 'ok' })

    proc.stdin.write(json({ id: 6, method: 'permissionProfile/list', params: {} }))
    assert.deepEqual((await reader.nextResponse(6)).result, {
      data: [
        { id: ':read-only', description: null, allowed: true },
        { id: ':workspace', description: null, allowed: true },
        { id: ':danger-full-access', description: null, allowed: true },
      ],
      nextCursor: null,
    })

    proc.stdin.write(json({ id: 7, method: 'windowsSandbox/readiness', params: {} }))
    assert.deepEqual((await reader.nextResponse(7)).result, { status: 'notConfigured' })

    proc.stdin.write(json({ id: 7, method: 'plugin/install', params: { pluginName: 'demo' } }))
    assert.deepEqual((await reader.nextResponse(7)).result, {
      authPolicy: 'ON_USE',
      appsNeedingAuth: [],
    })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('file change approval emits patch and git diff updates', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: {
          cwd: repo,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          permissions: ':workspace',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please edit file', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let approvalRequest: any = null
    let sawPatch = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/fileChange/patchUpdated') sawPatch = true
      if (message.method === 'item/fileChange/requestApproval') {
        approvalRequest = message
        break
      }
    }
    assert.equal(sawPatch, true)
    assert.equal(approvalRequest?.params.threadId, threadId)
    proc.stdin.write(json({ id: approvalRequest.id, result: { decision: 'accept' } }))

    let diff = ''
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/diff/updated') diff = message.params.diff
      if (message.method === 'turn/completed') break
    }
    assert.match(diff, /README.md/)
    assert.match(diff, /changed by mock runtime/)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('gitDiffToRemote includes untracked files for Codex diff review', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )
  await writeFile(join(repo, 'new-file.txt'), 'new content\n')

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'gitDiffToRemote', params: { cwd: repo } }))
    const response = await reader.nextResponse(1)
    assert.match(response.result.diff, /new-file\.txt/)
    assert.match(response.result.diff, /\+new content/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread resume, fork, and interrupt lifecycle methods are stable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'session check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(3)
    assert.equal(resume.result.thread.id, threadId)
    assert.equal(resume.result.thread.turns.length, 1)

    proc.stdin.write(
      json({ id: 4, method: 'thread/fork', params: { threadId, persistExtendedHistory: false } }),
    )
    const fork = await reader.nextResponse(4)
    assert.equal(fork.result.thread.forkedFromId, threadId)
    assert.equal(fork.result.thread.sessionId, resume.result.thread.sessionId)

    proc.stdin.write(json({ id: 5, method: 'turn/interrupt', params: { threadId } }))
    const interrupt = await reader.nextResponse(5)
    assert.deepEqual(interrupt.result, {})
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn interrupt completes requested in-progress turn after reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { randomUUID } from 'node:crypto'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const threadId = randomUUID()
      const turnId = randomUUID()
      const now = Math.floor(Date.now() / 1000)
      store.upsertThread({
        id: threadId,
        sessionId: randomUUID(),
        forkedFromId: null,
        preview: 'interrupt me',
        name: null,
        archived: false,
        cwd: process.cwd(),
        model: 'opus',
        reasoningEffort: 'medium',
        modelProvider: 'claude-code',
        claudeSessionId: null,
        source: 'user',
        createdAt: now,
        updatedAt: now,
        status: { type: 'active', activeFlags: [] },
        approvalPolicy: null,
        sandboxMode: null,
        ephemeral: false,
        threadSource: 'user',
        agentRole: null,
        agentNickname: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        runtimeBackend: 'claude',
        codexSessionId: null,
      })
      store.upsertTurn({
        id: turnId,
        threadId,
        status: 'inProgress',
        startedAt: now,
        completedAt: null,
        durationMs: null,
        items: [],
        diff: '',
        error: null,
      })
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt(id) {
          interrupted.push(id)
        },
        async stop() {},
      })
      const messages = []
      const peer = {
        id: 'peer',
        send(message) {
          messages.push(message)
        },
        close() {},
      }
      await server.handle(peer, { id: 1, method: 'turn/interrupt', params: { threadId, turnId } })
      assert.deepEqual(interrupted, [threadId])
      assert.equal(store.getTurn(turnId)?.status, 'interrupted')
      assert.equal(store.getThread(threadId)?.status.type, 'idle')
      const completed = messages.find((message) => 'method' in message && message.method === 'turn/completed')
      assert.equal(completed?.params.turn.id, turnId)
      assert.equal(completed?.params.turn.status, 'interrupted')
      const status = messages.find((message) => 'method' in message && message.method === 'thread/status/changed')
      assert.deepEqual(status?.params.status, { type: 'idle' })
      const response = messages.find((message) => 'id' in message && message.id === 1)
      assert.deepEqual(response?.result, {})
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('runtime settlement cannot overwrite an interrupted turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const controls = new Map()
      const controlsByThread = new Map()
      const outcomes = new Map()
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'active-' + context.turnId,
            toolName: 'Task',
            input: { description: 'active subagent', prompt: 'wait for interruption' },
          })
          return new Promise((resolve, reject) => {
            const control = { resolve, reject }
            controls.set(context.turnId, control)
            controlsByThread.set(context.threadId, control)
          })
        },
        async steer() {},
        async interrupt(threadId) {
          const control = controlsByThread.get(threadId)
          if (outcomes.get(threadId) === 'resolve') control.resolve()
          else control.reject(new Error('runtime rejected during interrupt'))
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
        async stop() {},
      })
      const messages = []
      const peer = {
        id: 'peer',
        send(message) {
          messages.push({ ...message, deliveredTo: 'peer' })
        },
        close() {},
      }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for runtime control')
      }

      let requestId = 0
      for (const outcome of ['resolve', 'reject']) {
        await server.handle(peer, {
          id: ++requestId,
          method: 'thread/start',
          params: { cwd: process.cwd(), persistExtendedHistory: false },
        })
        const threadId = response(requestId).result.thread.id
        await server.handle(peer, {
          id: ++requestId,
          method: 'turn/start',
          params: {
            threadId,
            input: [{ type: 'text', text: 'interrupt workflow', text_elements: [] }],
          },
        })
        const turnId = response(requestId).result.turn.id
        await waitFor(() => controls.has(turnId))
        outcomes.set(threadId, outcome)
        const interruptPeer = {
          id: 'peer-reconnected',
          send(message) {
            messages.push({ ...message, deliveredTo: 'peer-reconnected' })
          },
          close() {},
        }
        server.closePeer(peer)
        await server.handle(interruptPeer, {
          id: ++requestId,
          method: 'thread/resume',
          params: { threadId },
        })
        await server.handle(interruptPeer, {
          id: ++requestId,
          method: 'turn/interrupt',
          params: { threadId, turnId },
        })
        await new Promise((resolve) => setTimeout(resolve, 25))

        assert.equal(store.getTurn(turnId)?.status, 'interrupted')
        const completions = messages.filter(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        )
        assert.equal(completions.length, 1)
        assert.equal(completions[0].params.turn.status, 'interrupted')
        const interruptedActivityIndex = messages.findIndex(
          (message) =>
            'method' in message &&
            message.method === 'item/completed' &&
            message.params.turnId === turnId &&
            message.params.item.type === 'subAgentActivity' &&
            message.params.item.kind === 'interrupted',
        )
        const terminalIndex = messages.findIndex(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        )
        assert.ok(interruptedActivityIndex >= 0)
        assert.ok(interruptedActivityIndex < terminalIndex)
        assert.equal(messages[interruptedActivityIndex].deliveredTo, 'peer-reconnected')
        assert.equal(messages[terminalIndex].deliveredTo, 'peer-reconnected')
        assert.equal(
          messages
            .filter(
              (message) =>
                'method' in message &&
                message.method === 'item/completed' &&
                message.params.turnId === turnId &&
                message.params.item.type === 'collabAgentToolCall' &&
                message.params.item.tool === 'wait',
            )
            .every((message) => message.deliveredTo === 'peer-reconnected'),
          true,
        )
        assert.equal(
          messages.some(
            (message) =>
              'method' in message &&
              message.method === 'error' &&
              message.params.turnId === turnId,
          ),
          false,
        )
      }
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('subagent watchdog terminalizes a runtime that never returns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'stuck-' + context.turnId,
            toolName: 'Task',
            input: { description: 'stuck subagent', prompt: 'never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for watchdog')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hang', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )

      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /terminal result within 1 second/)
      assert.equal(interrupted.length, 1)
      const child = store
        .listThreads({ includeEphemeral: true })
        .find((candidate) => candidate.threadSource === 'subagent')
      assert.ok(child)
      assert.equal(store.listTurns(child.id)[0].status, 'failed')
      assert.equal(store.listTurns(threadId)[0].items.at(-1).status, 'failed')
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('workflow watchdog terminalizes a launch that never publishes a result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'workflow-' + context.turnId,
            toolName: 'Workflow',
            input: { command: '/workflows never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for workflow watchdog')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows hang', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )
      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /terminal result within 1 second/)
      assert.equal(interrupted.length, 1)
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'item/started' &&
            message.params.item.type === 'collabAgentToolCall',
        ),
        false,
        'a Workflow launch without projected agents must not fabricate a child card',
      )
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('workflow watchdog disarms when the original Workflow tool result arrives', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          const toolUseId = 'workflow-launch-' + context.turnId
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Workflow',
            input: { command: '/workflows slow result' },
          })
          await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'launch accepted' })
          await new Promise((resolve) => setTimeout(resolve, 250))
          await handlers.onEvent({ type: 'completed', success: true, result: 'workflow done' })
        },
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for original Workflow result')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows slow', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )
      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'completed')
      assert.equal(completed.params.turn.error, null)
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server shutdown terminalizes active child turns before closing the store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const database = join(home, 'state.sqlite')
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(${JSON.stringify(database)})
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'shutdown-child-' + context.turnId,
            toolName: 'Task',
            input: { description: 'child survives shutdown', prompt: 'investigate shutdown' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for child creation')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const parentThreadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId: parentThreadId, input: [{ type: 'text', text: 'hang', text_elements: [] }] },
      })
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'item/completed' &&
            message.params.item?.tool === 'spawnAgent',
        ),
      )
      await server.stop()

      const reopened = new SessionStore(${JSON.stringify(database)})
      try {
        const child = reopened
          .listThreads({ includeEphemeral: true })
          .find((candidate) => candidate.threadSource === 'subagent')
        assert.ok(child)
        assert.equal(reopened.listTurns(child.id)[0].status, 'failed')
        assert.equal(reopened.listTurns(parentThreadId)[0].status, 'interrupted')
        assert.equal(reopened.listTurns(parentThreadId)[0].items.at(-1).status, 'failed')
        assert.equal(
          reopened.listThreads({ includeEphemeral: true }).flatMap((thread) => reopened.listTurns(thread.id)).some((turn) => turn.status === 'inProgress'),
          false,
        )
      } finally {
        reopened.close()
      }
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// A repo whose `git diff` blocks until the release file exists, so a test can
// act while the adapter waits on a turn's diff. The done file marks its return.
async function blockingGitDiff(home: string): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
  const repo = join(home, 'repo')
  const bin = join(home, 'bin')
  await mkdir(repo, { recursive: true })
  await mkdir(bin, { recursive: true })
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const fakeGit = join(bin, 'git')
  await writeFile(
    fakeGit,
    [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then',
      "  printf 'true\\n'",
      '  exit 0',
      'fi',
      'if [ "$1" = "diff" ]; then',
      '  : > "$CLAUDE_CODEX_TEST_GIT_DIFF_STARTED"',
      '  while [ ! -f "$CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE" ]; do sleep 0.01; done',
      "  printf 'diff --git a/file b/file\\n--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-old\\n+new\\n'",
      '  : > "$CLAUDE_CODEX_TEST_GIT_DIFF_DONE"',
      '  exit 0',
      'fi',
      'exec "$CLAUDE_CODEX_REAL_GIT" "$@"',
      '',
    ].join('\n'),
  )
  await chmod(fakeGit, 0o755)
  return {
    repo,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CLAUDE_CODEX_REAL_GIT: realGit,
      CLAUDE_CODEX_TEST_GIT_DIFF_STARTED: join(home, 'git-diff-started'),
      CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE: join(home, 'git-diff-release'),
      CLAUDE_CODEX_TEST_GIT_DIFF_DONE: join(home, 'git-diff-done'),
    },
  }
}

test('interrupt during final git diff cannot overwrite an interrupted turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const { repo, env } = await blockingGitDiff(home)

  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { existsSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for final git diff')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: ${JSON.stringify(repo)}, persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'interrupt during final diff', text_elements: [] }],
        },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() => existsSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_STARTED))

      await server.handle(peer, {
        id: 3,
        method: 'turn/interrupt',
        params: { threadId, turnId },
      })
      writeFileSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE, 'continue')
      // Assert only once the diff has returned, so its late result is what
      // gets checked rather than a loaded machine's slow fake git.
      await waitFor(() => existsSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_DONE))
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(store.getTurn(turnId)?.status, 'interrupted')
      const completions = messages.filter(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completions.length, 1)
      assert.equal(completions[0].params.turn.status, 'interrupted')
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/diff/updated' &&
            message.params.turnId === turnId,
        ),
        false,
      )
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'error' &&
            message.params.turnId === turnId,
        ),
        false,
      )
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe', env },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop during final git diff leaves the closed store alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const { repo, env } = await blockingGitDiff(home)

  try {
    // The diff finishes after stop() closed SQLite. A turn that touched the
    // store then would throw from its failure path and crash the process.
    const turnId = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { existsSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for final git diff')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: ${JSON.stringify(repo)}, persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'stop during final diff', text_elements: [] }],
        },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() => existsSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_STARTED))

      await server.stop()
      writeFileSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE, 'continue')
      process.stdout.write(turnId)
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe', env },
    )

    const store = new SessionStore(join(home, 'state.sqlite'))
    try {
      const turn = store.getTurn(turnId)
      assert.equal(turn?.status, 'interrupted')
      assert.equal(turn?.diff, '')
    } finally {
      store.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('adapter exits on SIGTERM even when stopping fails to record the running turn', {
  timeout: 30_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false, permissions: ':workspace' },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    // The turn stays in progress until its approval is answered.
    await nextNotification(reader, 'item/commandExecution/requestApproval')

    // With its database deleted, stop() cannot record the interrupted turn,
    // as when a test removes the adapter's home before the signal lands.
    await rm(join(home, 'claude-codex-adapter', 'state.sqlite'))
    proc.kill('SIGTERM')
    assert.equal(await waitForExit(proc, 20_000), 1, 'the adapter must not linger')
    assert.match(stderr, /\[claude-codex-adapter\] shutdown failed: /)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop still stops the runtime when the running turn cannot be recorded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const result = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { rmSync } from 'node:fs'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const dbPath = join(${JSON.stringify(home)}, 'state.sqlite')
      let runtimeStopped = false
      const server = new CodexClaudeAppServer(new SessionStore(dbPath), {
        runTurn: () => new Promise(() => {}),
        async steer() {},
        async interrupt() {},
        async stop() {
          runtimeStopped = true
        },
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: {
          threadId: response(1).result.thread.id,
          input: [{ type: 'text', text: 'never finishes', text_elements: [] }],
        },
      })
      rmSync(dbPath)
      const error = await server.stop().then(
        () => null,
        (error) => error.message,
      )
      process.stdout.write(JSON.stringify({ error, runtimeStopped }))
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe' },
    )
    const { error, runtimeStopped } = JSON.parse(result)
    assert.notEqual(error, null, 'recording the interrupted turn fails without its database')
    assert.equal(runtimeStopped, true)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop keeps a queued turn, review or compaction from starting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const result = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const launches = []
      const server = new CodexClaudeAppServer(
        new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite')),
        {
          runTurn: (context) => {
            launches.push(context.purpose)
            return new Promise(() => {})
          },
          async steer() {},
          async interrupt() {},
          async stop() {},
        },
      )
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)

      const threadIds = []
      for (const id of [1, 2, 3]) {
        await server.handle(peer, {
          id,
          method: 'thread/start',
          params: { cwd: process.cwd(), persistExtendedHistory: false },
        })
        threadIds.push(response(id).result.thread.id)
      }
      // Each of these answers first and starts on the next tick, after stop().
      await server.handle(peer, {
        id: 4,
        method: 'turn/start',
        params: {
          threadId: threadIds[0],
          input: [{ type: 'text', text: 'never starts', text_elements: [] }],
        },
      })
      await server.handle(peer, {
        id: 5,
        method: 'review/start',
        params: {
          threadId: threadIds[1],
          delivery: 'inline',
          target: { type: 'custom', instructions: 'never starts' },
        },
      })
      await server.handle(peer, {
        id: 6,
        method: 'thread/compact/start',
        params: { threadId: threadIds[2] },
      })
      await server.stop()
      await new Promise((resolve) => setTimeout(resolve, 100))
      process.stdout.write(JSON.stringify({ launches }))
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe' },
    )
    assert.deepEqual(JSON.parse(result).launches, [], 'nothing reaches Claude after stop')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcp status list reflects configured Claude SDK MCP servers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        demo: { type: 'stdio', command: 'node', args: ['mcp.js'] },
        other: { type: 'stdio', command: 'node', args: ['other.js'] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    // Codex v2 McpServerStatus shape: { name, tools, resources, resourceTemplates, authStatus }.
    assert.deepEqual(
      response.result.data.map((server: any) => server.name),
      ['demo', 'other'],
    )
    assert.deepEqual(response.result.data[0].tools, {})
    assert.deepEqual(response.result.data[0].resources, [])
    assert.deepEqual(response.result.data[0].resourceTemplates, [])
    assert.ok(
      ['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(
        response.result.data[0].authStatus,
      ),
    )
    // serverName narrows the list to that server.
    proc.stdin.write(
      json({ id: 2, method: 'mcpServerStatus/list', params: { serverName: 'other' } }),
    )
    const one = await reader.nextResponse(2)
    assert.deepEqual(
      one.result.data.map((server: any) => server.name),
      ['other'],
    )
    assert.equal(one.result.nextCursor, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('direct MCP stdio resource and tool calls work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        fixture: { type: 'stdio', command: process.execPath, args: [fixture] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'mcpServer/tool/call',
        params: { threadId: 't', server: 'fixture', tool: 'echo', arguments: { value: 'ok' } },
      }),
    )
    const tool = await reader.nextResponse(1)
    assert.equal(tool.result.content[0].text, 'tool:echo:ok')
    assert.equal(tool.result.structuredContent.ok, true)

    proc.stdin.write(
      json({
        id: 2,
        method: 'mcpServer/resource/read',
        params: {
          threadId: 't',
          server: 'fixture',
          uri: 'fixture://resource',
          originCallId: 'call-1',
        },
      }),
    )
    const resource = await reader.nextResponse(2)
    assert.equal(resource.result.contents[0].uri, 'fixture://resource')
    assert.equal(resource.result.contents[0].text, 'resource-ok')
    // No hosted app scoped the read.
    assert.equal(resource.result.originCallId, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('mcpServerStatus/list enumerates tools and resources from the server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const fixture = resolve('test/fixtures/mcp-stdio-server.mjs')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({
        fixture: { type: 'stdio', command: process.execPath, args: [fixture] },
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    const entry = response.result.data[0]
    assert.equal(entry.name, 'fixture')
    assert.ok(entry.tools.echo, 'expected the echo tool enumerated into the map')
    assert.equal(entry.tools.echo.name, 'echo')
    assert.ok(entry.tools.echo.inputSchema, 'tool must carry its inputSchema')
    assert.equal(entry.resources[0].uri, 'fixture://resource')
    assert.ok(['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(entry.authStatus))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('fuzzyFileSearch session streams updated and completed notifications', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  await writeFile(join(home, 'findme-fixture.txt'), 'x')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'fuzzyFileSearch/sessionStart',
        params: { sessionId: 's1', roots: [home] },
      }),
    )
    await reader.nextResponse(1)

    proc.stdin.write(
      json({
        id: 2,
        method: 'fuzzyFileSearch/sessionUpdate',
        params: { sessionId: 's1', query: 'findme' },
      }),
    )
    const updated = await nextNotification(reader, 'fuzzyFileSearch/sessionUpdated')
    assert.equal(updated.params.sessionId, 's1')
    assert.equal(updated.params.query, 'findme')
    const files = Array.isArray(updated.params.files) ? updated.params.files : []
    assert.ok(
      files.some((file: Record<string, unknown>) =>
        String(file.path).endsWith('findme-fixture.txt'),
      ),
    )
    await reader.nextResponse(2)

    proc.stdin.write(
      json({ id: 3, method: 'fuzzyFileSearch/sessionStop', params: { sessionId: 's1' } }),
    )
    const completed = await nextNotification(reader, 'fuzzyFileSearch/sessionCompleted')
    assert.equal(completed.params.sessionId, 's1')
    await reader.nextResponse(3)

    proc.stdin.write(
      json({
        id: 4,
        method: 'fuzzyFileSearch/sessionUpdate',
        params: { sessionId: 's1', query: 'findme' },
      }),
    )
    const afterStop = await reader.next()
    assert.equal(afterStop.id, 4)
    assert.equal(afterStop.method, undefined)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('skills/list and hooks/list surface Claude Code skills and settings hooks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const workspace = join(home, 'ws')
  await mkdir(join(home, '.claude', 'skills', 'user-skill'), { recursive: true })
  await writeFile(
    join(home, '.claude', 'skills', 'user-skill', 'SKILL.md'),
    '---\nname: user-skill\ndescription: A user skill for tests\n---\nbody\n',
  )
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    }),
  )
  await mkdir(join(workspace, '.claude', 'skills', 'demo-skill'), { recursive: true })
  await writeFile(
    join(workspace, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for tests\n---\nbody\n',
  )
  await writeFile(
    join(workspace, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'ignored' }] }],
      },
    }),
  )
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'skills/list', params: { cwds: [workspace] } }))
    const skills = await reader.nextResponse(1)
    const entry = skills.result.data.find((item: Record<string, unknown>) => item.cwd === workspace)
    assert.ok(entry, 'expected a skills entry for the workspace cwd')
    const skillList = Array.isArray(entry.skills) ? entry.skills : []
    const demo = skillList.find((skill: Record<string, unknown>) => skill.name === 'demo-skill')
    assert.ok(demo, 'expected the demo skill enumerated from .claude/skills')
    assert.equal(demo.description, 'A demo skill for tests')
    assert.equal(demo.scope, 'repo')
    assert.equal(demo.enabled, true)
    const userSkill = skillList.find(
      (skill: Record<string, unknown>) => skill.name === 'user-skill',
    )
    assert.ok(userSkill, 'expected the user skill enumerated from HOME/.claude/skills')
    assert.equal(userSkill.description, 'A user skill for tests')
    assert.equal(userSkill.scope, 'user')
    assert.equal(userSkill.enabled, true)

    proc.stdin.write(json({ id: 2, method: 'hooks/list', params: { cwds: [workspace] } }))
    const hooks = await reader.nextResponse(2)
    const hooksEntry = hooks.result.data.find(
      (item: Record<string, unknown>) => item.cwd === workspace,
    )
    assert.ok(hooksEntry, 'expected a hooks entry for the workspace cwd')
    const hookList = Array.isArray(hooksEntry.hooks) ? hooksEntry.hooks : []
    const pre = hookList.find(
      (hook: Record<string, unknown>) => hook.source === 'project' && hook.command === 'echo hi',
    )
    assert.ok(pre, 'expected the project PreToolUse hook mapped to preToolUse')
    assert.equal(pre.eventName, 'preToolUse')
    assert.equal(pre.matcher, 'Bash')
    assert.equal(pre.handlerType, 'command')
    assert.ok(typeof pre.currentHash === 'string' && pre.currentHash.length > 0)
    const userHook = hookList.find(
      (hook: Record<string, unknown>) => hook.source === 'user' && hook.command === 'echo user',
    )
    assert.ok(userHook, 'expected the user settings hook mapped from HOME/.claude/settings.json')
    assert.equal(userHook.eventName, 'postToolUse')
    assert.equal(userHook.matcher, 'Edit')
    assert.equal(userHook.handlerType, 'command')
    assert.ok(!hookList.some((hook: Record<string, unknown>) => hook.eventName === 'notification'))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude Code built-in commands are listed as skills and run as slash commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const adapterDir = join(home, 'adapter')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      HOME: home,
      CLAUDE_CODEX_HOME: adapterDir,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'skills/list', params: { cwds: [home] } }))
    const skills = await reader.nextResponse(1)
    const simplify = skills.result.data[0].skills.find(
      (skill: Record<string, unknown>) => skill.name === 'simplify',
    )
    assert.ok(simplify, 'expected /simplify in the App skill list')
    assert.equal(simplify.scope, 'system')
    assert.equal(simplify.enabled, true)
    assert.match(simplify.shortDescription, /^Review the changed code for reuse/)
    assert.equal(simplify.path, join(adapterDir, 'claude-commands', 'simplify', 'SKILL.md'))
    // The App opens `path` when the chip is clicked.
    assert.match(await readFile(simplify.path, 'utf8'), /runs `\/simplify \[<target>\]`/)

    proc.stdin.write(
      json({
        id: 2,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    await reader.nextResponse(2)
    proc.stdin.write(json({ id: 3, method: 'thread/start', params: { cwd: home } }))
    const threadId = (await reader.nextResponse(3)).result.thread.id
    // What the composer sends after the user picks /simplify and types.
    const text = `[$simplify](${simplify.path}) focus on the parser`
    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text, text_elements: [] }] },
      }),
    )
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    const reply = seen
      .filter((message) => message.method === 'item/agentMessage/delta')
      .map((message) => message.params.delta)
      .join('')
    assert.match(reply, /mock response for: \/simplify focus on the parser$/)
    // The transcript keeps what the user sent.
    proc.stdin.write(
      json({ id: 5, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(5)
    const userMessage = read.result.thread.turns[0].items.find(
      (item: Record<string, unknown>) => item.type === 'userMessage',
    )
    assert.equal(userMessage?.content[0].text, text)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('direct MCP HTTP tool calls work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const httpServer = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const message = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      if (message.method === 'initialize') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'http-fixture', version: '1' },
            },
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: `http:${message.params.name}` }],
            structuredContent: { http: true },
            isError: false,
          },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  assert.equal(typeof address, 'object')
  const url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({ fixture: { type: 'http', url } }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'mcpServer/tool/call',
        params: { threadId: 't', server: 'fixture', tool: 'echo', arguments: {} },
      }),
    )
    const tool = await reader.nextResponse(1)
    assert.equal(tool.result.content[0].text, 'http:echo')
    assert.equal(tool.result.structuredContent.http, true)
  } finally {
    proc.kill()
    httpServer.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('optional auto worktree binds new threads to isolated git worktrees', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const repo = join(home, 'repo')
  const worktrees = join(home, 'worktrees')
  await writeFile(join(home, 'placeholder'), '')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_AUTO_WORKTREE: '1',
      CLAUDE_CODEX_WORKTREE_ROOT: worktrees,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: repo, experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const response = await reader.nextResponse(1)
    assert.match(response.result.cwd, /worktrees/)
    assert.match(response.result.thread.cwd, /worktrees/)
    assert.notEqual(response.result.cwd, repo)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

class JsonLineReader {
  private buffer = ''
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(proc: ChildProcess) {
    if (!proc.stdout) throw new Error('test process has no stdout')
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.push(chunk))
  }

  next(): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async nextResponse(id: number): Promise<any> {
    for (;;) {
      const msg = await this.next()
      if (msg.id === id && msg.method == null) return msg
    }
  }

  // Resolves null when nothing arrives within `ms`.
  nextWithin(ms: number): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const waiter = (value: any): void => {
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter)
        resolve(null)
      }, ms)
      this.waiters.push(waiter)
    })
  }

  private push(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    }
  }
}

class WebSocketJsonReader {
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
  }

  next(): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async nextResponse(id: number): Promise<any> {
    for (;;) {
      const msg = await this.next()
      if (msg.id === id && msg.method == null) return msg
    }
  }
}

class TextCollector {
  private text = ''
  private waiters: Array<() => void> = []

  constructor(proc: ChildProcess) {
    if (!proc.stdout) throw new Error('test process has no stdout')
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.text += chunk
      for (const waiter of this.waiters.splice(0)) waiter()
    })
  }

  async waitFor(pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 5000
    while (!pattern.test(this.text)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${pattern}; saw: ${this.text}`)
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error(`timed out waiting for ${pattern}; saw: ${this.text}`))
        }, remaining)
        this.waiters.push(waiter)
      })
    }
  }
}

class ChildProcessDuplex extends Duplex {
  private readonly proc: ChildProcess

  constructor(proc: ChildProcess) {
    super()
    this.proc = proc
    if (!proc.stdin || !proc.stdout) throw new Error('proxy process needs stdin/stdout')
    proc.stdout.on('data', (chunk) => this.push(chunk))
    proc.stdout.on('end', () => this.push(null))
    proc.on('exit', () => this.push(null))
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.proc.stdin?.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.proc.stdin?.end()
    callback()
  }
}

function json(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`
}

async function nextNotification(
  reader: JsonLineReader,
  method: string,
): Promise<{ params: Record<string, unknown> }> {
  for (let i = 0; i < 50; i += 1) {
    const message = await reader.next()
    if (message.method === method) return { params: asTestRecord(message.params) }
  }
  throw new Error(`missing notification: ${method}`)
}

function asTestRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Opens a read transaction on the adapter's state database, the way a backup
// or a sqlite3 shell would. Until the returned release runs, the adapter
// cannot commit a write.
function holdStateDatabase(path: string): () => void {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 2_000 })
  db.exec('BEGIN')
  db.prepare('SELECT count(*) FROM turns').get()
  return () => {
    db.exec('COMMIT')
    db.close()
  }
}

async function startLockTestThread(proc: ChildProcess, reader: JsonLineReader): Promise<string> {
  proc.stdin?.write(
    json({
      id: 1,
      method: 'thread/start',
      params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
    }),
  )
  const start = await reader.nextResponse(1)
  return start.result.thread.id
}

// The mock streams the echoed prompt one character at a time, so a long
// prompt keeps the turn writing for a while.
async function startLockTestTurn(
  proc: ChildProcess,
  reader: JsonLineReader,
  threadId: string,
  id: number,
  text: string,
): Promise<string> {
  proc.stdin?.write(
    json({
      id,
      method: 'turn/start',
      params: {
        threadId,
        input: [{ type: 'text', text: `${text} ${'x'.repeat(300)}`, text_elements: [] }],
      },
    }),
  )
  const started = await reader.nextResponse(id)
  assert.equal(started.error, undefined)
  return started.result.turn.id
}

async function nextTurnCompleted(
  reader: JsonLineReader,
  turnId: string,
): Promise<{ completed: any; methods: string[] }> {
  const methods: string[] = []
  for (let i = 0; i < 5_000; i += 1) {
    const message = await reader.next()
    if (message.method == null) continue
    methods.push(message.method)
    if (message.method === 'turn/completed' && message.params.turn.id === turnId)
      return { completed: message.params.turn, methods }
  }
  throw new Error(`turn/completed never arrived for ${turnId}`)
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode
  return await Promise.race([
    once(proc, 'exit').then(([code]) => code as number | null),
    delay(timeoutMs).then(() => null),
  ])
}

function terminateWebSocket(ws: WebSocket | null): void {
  if (!ws || ws.readyState === WebSocket.CLOSED) return
  ws.on('error', () => {})
  ws.terminate()
}

async function stopProcess(proc: ChildProcess, timeoutMs = 2000): Promise<void> {
  const exited = (): boolean => proc.exitCode !== null || proc.signalCode !== null
  const wait = async (): Promise<boolean> => {
    if (exited()) return true
    return await Promise.race([
      once(proc, 'exit').then(() => true),
      delay(timeoutMs).then(() => false),
    ])
  }
  if (exited()) return
  proc.kill()
  if (await wait()) return
  proc.kill('SIGKILL')
  await wait()
}

async function waitForStderr(proc: ChildProcess, pattern: RegExp): Promise<void> {
  if (!proc.stderr) throw new Error('test process has no stderr')
  proc.stderr.setEncoding('utf8')
  let acc = ''
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
    }
    const onData = (chunk: string) => {
      acc += String(chunk)
      if (pattern.test(acc)) {
        cleanup()
        resolve()
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`process exited before stderr matched ${pattern}; saw: ${acc}`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      proc.kill()
      reject(new Error(`timed out waiting for stderr ${pattern}; saw: ${acc}`))
    }, 5000)
    proc.stderr?.on('data', onData)
    proc.once('exit', onExit)
  })
}

test('thread/list honors isPinned and metadata updates persist the pin state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const env = { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' }
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const first = await reader.nextResponse(1)
    const firstId = first.result.thread.id
    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } }))
    const second = await reader.nextResponse(2)
    const secondId = second.result.thread.id
    for (const [id, threadId] of [
      [10, firstId],
      [11, secondId],
    ]) {
      proc.stdin.write(
        json({ id, method: 'turn/start', params: { threadId, input: textInput('hi') } }),
      )
      await awaitMessage(reader, (message) => message.method === 'turn/completed')
    }

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/metadata/update',
        params: { threadId: firstId, isPinned: true },
      }),
    )
    const updated = await reader.nextResponse(3)
    assert.equal(updated.result.thread.isPinned, true)

    proc.stdin.write(json({ id: 4, method: 'thread/list', params: { isPinned: true } }))
    const pinned = await reader.nextResponse(4)
    assert.deepEqual(
      pinned.result.data.map((thread: any) => thread.id),
      [firstId],
    )

    proc.stdin.write(json({ id: 5, method: 'thread/list', params: { isPinned: false } }))
    const unpinned = await reader.nextResponse(5)
    assert.deepEqual(
      unpinned.result.data.map((thread: any) => thread.id),
      [secondId],
    )

    proc.stdin.write(json({ id: 6, method: 'thread/list', params: {} }))
    const all = await reader.nextResponse(6)
    assert.deepEqual(
      new Set(all.result.data.map((thread: any) => thread.id)),
      new Set([firstId, secondId]),
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex section pin RPC moves a thread into and out of the reserved pinned section', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'threadSection/list', params: { limit: 100 } }))
    const sections = await reader.nextResponse(2)
    assert.equal(sections.error, undefined)
    const pinnedSection = sections.result.data.find(
      (section: any) => section.id === '01984de2-8f74-7c91-a3b2-5c5e937cf318',
    )
    assert.ok(pinnedSection)

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/section/move',
        params: { threadId, sectionId: pinnedSection.id, beforeThreadId: null },
      }),
    )
    const moved = await reader.nextResponse(3)
    assert.equal(moved.error, undefined)
    assert.deepEqual(moved.result, {})

    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId } }))
    const pinned = await reader.nextResponse(4)
    assert.equal(pinned.result.thread.isPinned, true)
    assert.equal(pinned.result.thread.section.id, pinnedSection.id)

    proc.stdin.write(
      json({
        id: 5,
        method: 'thread/list',
        params: { sectionId: pinnedSection.id, sortKey: 'section_position' },
      }),
    )
    const pinnedList = await reader.nextResponse(5)
    assert.deepEqual(
      pinnedList.result.data.map((thread: any) => thread.id),
      [threadId],
    )

    proc.stdin.write(
      json({ id: 6, method: 'thread/section/move', params: { threadId, sectionId: null } }),
    )
    const unpinned = await reader.nextResponse(6)
    assert.equal(unpinned.error, undefined)

    proc.stdin.write(json({ id: 7, method: 'thread/read', params: { threadId } }))
    const afterUnpin = await reader.nextResponse(7)
    assert.equal(afterUnpin.result.thread.isPinned, false)
    assert.equal(afterUnpin.result.thread.section, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/settings/update preserves model and effort compatibility', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const started = await reader.nextResponse(1)
    const threadId = started.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/settings/update',
        params: {
          threadId,
          model: 'haiku',
          effort: 'xhigh',
          personality: 'friendly',
          collaborationMode: {
            mode: 'default',
            settings: { developer_instructions: 'keep settings compatibility' },
          },
        },
      }),
    )
    let updated: any = null
    let settingsNotification: any = null
    for (let attempt = 0; attempt < 20 && (!updated || !settingsNotification); attempt += 1) {
      const message = await reader.next()
      if (message.id === 2 && message.method == null) updated = message
      if (message.method === 'thread/settings/updated') settingsNotification = message
    }
    assert.ok(updated)
    assert.deepEqual(updated.result, {})
    assert.ok(settingsNotification)
    assert.equal(settingsNotification.params.threadSettings.model, 'haiku')
    assert.equal(settingsNotification.params.threadSettings.effort, 'xhigh')
    assert.equal(settingsNotification.params.threadSettings.personality, 'friendly')

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const read = await reader.nextResponse(3)
    assert.equal(read.result.model, 'haiku')
    assert.equal(read.result.reasoningEffort, 'xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread sections paginate without losing entries at page boundaries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  let id = 0
  const request = async (method: string, params: unknown) => {
    proc.stdin.write(json({ id: ++id, method, params }))
    const response = await reader.nextResponse(id)
    assert.equal(response.error, undefined)
    return response.result
  }
  try {
    for (let i = 0; i < 201; i++) await request('threadSection/create', { name: `Section ${i}` })
    for (const limit of [1, 100, 200, 500]) {
      const seen = new Set<string>()
      let cursor: string | null = null
      let pages = 0
      do {
        assert.ok(++pages <= 202, 'pagination must make progress')
        const result = await request('threadSection/list', { limit, cursor })
        for (const section of result.data) {
          assert.equal(seen.has(section.id), false)
          seen.add(section.id)
        }
        cursor = result.nextCursor
      } while (cursor !== null)
      assert.equal(seen.size, 202)
    }
  } finally {
    proc.kill()
    await once(proc, 'exit')
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
