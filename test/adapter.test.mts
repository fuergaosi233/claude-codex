import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import test from 'node:test'
import WebSocket from 'ws'

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
    'thread/metadata/update',
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
      json({
        id: 2,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id
    assert.equal(start.result.modelProvider, 'claude-code')

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

test('turn lifecycle envelopes carry empty notLoaded items like the real app-server', async () => {
  // The real codex app-server ships `items: [], itemsView: "notLoaded"` in the
  // turn/start response and the turn/started + turn/completed notifications; the
  // timeline is driven by the item/* event stream. See codex-rs
  // bespoke_event_handling.rs (turn started clears items; turn completed builds
  // items: vec![]) and turn_processor.rs (TurnStartResponse turn is empty).
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

    proc.stdin.write(json({ id: 7, method: 'account/read', params: {} }))
    const account = await reader.nextResponse(7)
    assert.deepEqual(account.result.account, { type: 'amazonBedrock' })
    assert.equal(account.result.requiresOpenaiAuth, false)

    proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
    const models = await reader.nextResponse(2)
    const ids = models.result.data.map((model: any) => model.id)
    assert.equal(ids.includes('sonnet'), true)
    assert.equal(ids.includes('opus'), true)
    assert.equal(ids.includes('sonnet-1m'), true)
    assert.equal(ids.includes('opus-plan'), true)
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
    await rm(home, { recursive: true, force: true })
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
    await rm(home, { recursive: true, force: true })
  }
})

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
    await rm(home, { recursive: true, force: true })
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
    await rm(home, { recursive: true, force: true })
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

test('unix websocket app-server accepts initialize', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    await waitForStderr(proc, /listening on/)
    const ws = new WebSocket('ws://localhost/', {
      createConnection: (() => net.createConnection(sock)) as typeof net.createConnection,
    })
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null },
      }),
    )
    // adapter now also pushes account/updated + mcpServer/startupStatus/updated
    // notifications after handshake; filter by id rather than grabbing the
    // first frame off the wire.
    let response: any = null
    for (let i = 0; i < 5; i += 1) {
      const [data] = (await once(ws, 'message')) as [Buffer]
      const msg = JSON.parse(data.toString('utf8'))
      if (msg.id === 1) {
        response = msg
        break
      }
    }
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
    ws.close()
  } finally {
    proc.kill()
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
    await rm(home, { recursive: true, force: true })
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
    await rm(home, { recursive: true, force: true })
  }
})

test('app-server proxy forwards websocket handshake bytes to unix daemon', async () => {
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
    proxy.kill()
    daemon.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('app-server proxy carries websocket JSON-RPC traffic over stdio', async () => {
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
    const stream = new ChildProcessDuplex(proxy)
    const ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
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
    // adapter pushes notifications post-handshake; filter for the response.
    let response: any = null
    for (let i = 0; i < 5; i += 1) {
      const [data] = (await once(ws, 'message')) as [Buffer]
      const msg = JSON.parse(data.toString('utf8'))
      if (msg.id === 1) {
        response = msg
        break
      }
    }
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
    ws.close()
  } finally {
    proxy.kill()
    daemon.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('remote shim launches daemon and proxy with Codex-compatible commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
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
      CLAUDE_CODEX_ADAPTER: adapter,
      CLAUDE_CODEX_MOCK: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    const ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof net.createConnection,
    })
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
    // The adapter now also pushes account/updated + mcpServer/startupStatus/updated
    // notifications right after handshake; the response can land in any order
    // relative to those. Filter for the matching id rather than grabbing the
    // first frame off the wire.
    let response: any = null
    for (let i = 0; i < 5; i += 1) {
      const [data] = (await once(ws, 'message')) as [Buffer]
      const msg = JSON.parse(data.toString('utf8'))
      if (msg.id === 1) {
        response = msg
        break
      }
    }
    assert.equal(response?.result?.codexHome, home)
    ws.close()
  } finally {
    proxy.kill()
    daemon.kill()
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
    let sawEnteredReviewMode = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'enteredReviewMode')
        sawEnteredReviewMode = true
      if (message.method === 'item/agentMessage/delta') reviewText += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawEnteredReviewMode, true)
    assert.match(reviewText, /Claude Code adapter mock response|Claude warning/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Claude thinking maps to Codex reasoning summary and content deltas', async () => {
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
    assert.equal(sawSummary, true)
    assert.equal(sawContent, true)
    assert.deepEqual(completedReasoning.summary, ['mock thinking'])
    assert.deepEqual(completedReasoning.content, ['mock thinking'])
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

test('Claude hook events are rendered as Codex hookPrompt ThreadItems', async () => {
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
        params: { threadId, input: [{ type: 'text', text: 'hook check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    let hookItem: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started' && message.params.item.type === 'hookPrompt')
        hookItem = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.ok(hookItem, 'hook event should produce a hookPrompt ThreadItem')
    const fragmentTexts = (hookItem.fragments as Array<{ text: string }>).map((f) => f.text)
    assert.ok(
      fragmentTexts.some((t) => /Hook · PreToolUse/.test(t)),
      'fragments should include the hook name',
    )
    assert.ok(
      fragmentTexts.some((t) => /status: started/.test(t)),
      'fragments should include the status',
    )
    assert.ok(
      fragmentTexts.some((t) => /decision: allow/.test(t)),
      'fragments should include the decision',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

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
  let proc1 = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
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

    // Plan-mode text now routes to a Plan ThreadItem via item/plan/delta
    // (and a final turn/plan/updated) so the App's Plan UI lights up.
    // agentMessage is reserved for non-plan turns.
    let planText = ''
    let sawPlanUpdated = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/plan/delta') planText += message.params.delta
      if (message.method === 'turn/plan/updated') sawPlanUpdated = true
      if (message.method === 'turn/completed') break
    }
    assert.match(planText, /planMode=true/, 'plan deltas should carry the runtime context')
    assert.equal(sawPlanUpdated, true, 'turn/plan/updated must fire at end of plan turn')
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

test('Task subagent emits Codex native spawnAgent → wait → closeAgent timeline with hidden inner events', async () => {
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
        params: { threadId, input: [{ type: 'text', text: 'subagent check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    type Lifecycle = { started?: any; completed?: any }
    const collabByTool: Record<string, Lifecycle> = {}
    let agentMessageText = ''
    let leakedInnerItems = 0
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started') {
        const item = message.params.item
        if (item.type === 'collabAgentToolCall') {
          collabByTool[item.tool] = collabByTool[item.tool] ?? {}
          collabByTool[item.tool].started = item
        } else if (
          item.type === 'commandExecution' ||
          (item.type === 'mcpToolCall' && item.tool !== 'Task')
        ) {
          leakedInnerItems += 1
        }
      }
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (item.type === 'collabAgentToolCall') {
          collabByTool[item.tool] = collabByTool[item.tool] ?? {}
          collabByTool[item.tool].completed = item
        }
      }
      if (message.method === 'item/agentMessage/delta')
        agentMessageText += String(message.params.delta ?? '')
      if (message.method === 'turn/completed') break
    }

    // All three native lifecycle pairs must appear, each with a started AND
    // a completed for the same id, so Codex App can render the timeline.
    for (const tool of ['spawnAgent', 'wait', 'closeAgent']) {
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
    const spawnEnd = collabByTool.spawnAgent.completed
    assert.equal(spawnEnd.senderThreadId, threadId)
    assert.equal(
      spawnEnd.receiverThreadIds.length,
      1,
      'spawnAgent end should reference exactly one child thread',
    )
    const childThreadId = spawnEnd.receiverThreadIds[0]
    // After spawnAgent ends the subagent is now running; only wait/closeAgent
    // ends report the agent as completed.
    assert.equal(spawnEnd.agentsStates[childThreadId].status, 'running')
    assert.equal(collabByTool.wait.started.receiverThreadIds[0], childThreadId)
    assert.equal(collabByTool.wait.completed.agentsStates[childThreadId].status, 'completed')
    assert.equal(collabByTool.closeAgent.completed.agentsStates[childThreadId].status, 'completed')
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
    const childTurnItems = (childTurns.result.data[0] as any).items
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

test('approval requests round-trip through Codex server requests', async () => {
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
    proc.kill()
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
    assert.equal(completedTool?.tool, 'Read')
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

test('turn/steer appends user input to an active Claude turn', async () => {
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
          input: [{ type: 'text', text: 'slow turn for steering', text_elements: [] }],
        },
      }),
    )
    const started = await reader.nextResponse(2)
    const turnId = started.result.turn.id

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/steer',
        params: {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: 'text', text: 'steered input', text_elements: [] }],
        },
      }),
    )
    const steer = await reader.nextResponse(3)
    assert.equal(steer.result.turnId, turnId)

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

    proc.stdin.write(json({ id: 6, method: 'windowsSandbox/readiness', params: {} }))
    assert.deepEqual((await reader.nextResponse(6)).result, { status: 'notConfigured' })

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

test('file change approval emits patch and git diff updates', async () => {
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
        params: { cwd: repo, experimentalRawEvents: false, persistExtendedHistory: false },
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
    proc.kill()
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
    await rm(home, { recursive: true, force: true })
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
      }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    // Codex v2 McpServerStatus shape: { name, tools, resources, resourceTemplates, authStatus }.
    assert.equal(response.result.data[0].name, 'demo')
    assert.deepEqual(response.result.data[0].tools, {})
    assert.deepEqual(response.result.data[0].resources, [])
    assert.deepEqual(response.result.data[0].resourceTemplates, [])
    assert.ok(
      ['unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(
        response.result.data[0].authStatus,
      ),
    )
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
        params: { threadId: 't', server: 'fixture', uri: 'fixture://resource' },
      }),
    )
    const resource = await reader.nextResponse(2)
    assert.equal(resource.result.contents[0].uri, 'fixture://resource')
    assert.equal(resource.result.contents[0].text, 'resource-ok')
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
    const started = Date.now()
    while (!pattern.test(this.text)) {
      if (Date.now() - started > 5000) {
        throw new Error(`timed out waiting for ${pattern}; saw: ${this.text}`)
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode
  return await Promise.race([
    once(proc, 'exit').then(([code]) => code as number | null),
    delay(timeoutMs).then(() => null),
  ])
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
