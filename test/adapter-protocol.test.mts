import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  adapter,
  awaitMessage,
  JsonLineReader,
  json,
  readUntil,
  sendTurn,
  spawnMockAdapter,
  stopProcess,
  textInput,
} from './support/adapter-harness.mjs'

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

test('memories Claude recalls are cited on the answer of the turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const memory = join(home, 'short-answers.md')
  await writeFile(
    memory,
    '---\nname: Short answers\ndescription: The user wants short answers\ntype: feedback\n---\n\nKeep replies brief.\n',
  )
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: `memory recall check ${memory}`, text_elements: [] }],
        },
      }),
    )
    const messages: any[] = []
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'agentMessage')
        messages.push(message.params.item)
      if (message.method === 'turn/completed') break
    }
    // Recalled twice, cited once; the summary Claude was given is cited by
    // its first line, and only the answer carries the citation.
    const citation = {
      entries: [
        { path: memory, lineStart: 1, lineEnd: 7, note: 'The user wants short answers' },
        {
          path: '<synthesis:/memories>',
          lineStart: 1,
          lineEnd: 2,
          note: 'The team ships on Fridays.',
        },
      ],
      threadIds: [],
    }
    assert.deepEqual(
      messages.map((item) => [item.text, item.phase, item.memoryCitation]),
      [
        ['Checking what I remember.', 'commentary', null],
        ['You prefer short answers.', 'final_answer', citation],
      ],
    )

    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    const read = await reader.nextResponse(3)
    const answer = read.result.thread.turns[0].items.findLast(
      (item: any) => item.type === 'agentMessage',
    )
    assert.deepEqual(answer.memoryCitation, citation)
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

test('thread/inject_items keeps the items out of the transcript', async () => {
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

    // The state of an inline visualization, as the App injects it before a turn.
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/inject_items',
        params: {
          threadId,
          items: [
            {
              type: 'function_call',
              name: 'untrusted_input',
              call_id: 'visualization_state_1',
              arguments: '{}',
            },
            {
              type: 'function_call_output',
              call_id: 'visualization_state_1',
              output: [{ type: 'input_text', text: '{"path":"/v/chart.html","state":{}}' }],
            },
          ],
        },
      }),
    )
    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId, includeTurns: true } }),
    )
    // Like Codex, the adapter answers with no turn and no item to show.
    const seen: string[] = []
    let response: any
    let read: any
    while (!read) {
      const message = await reader.next()
      if (message.method) seen.push(message.method)
      else if (message.id === 2) response = message
      else if (message.id === 3) read = message
    }
    assert.deepEqual(response?.result, {})
    assert.deepEqual(
      seen.filter((method) => method.startsWith('turn/') || method.startsWith('item/')),
      [],
    )
    assert.deepEqual(read.result.thread.turns, [])

    proc.stdin.write(
      json({ id: 4, method: 'thread/inject_items', params: { threadId: 'missing', items: [] } }),
    )
    assert.ok((await reader.nextResponse(4)).error)
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
  const prevSocket = process.env.CLAUDE_CODEX_SOCKET_PATH
  process.env.CODEX_HOME = '/' + 'very-long-codex-home-segment'.repeat(8)
  delete process.env.CLAUDE_CODEX_SOCKET_PATH
  try {
    const socketPath = util.defaultSocketPath()
    assert.ok(
      socketPath.length <= util.socketPathLimit(),
      `socket path ${socketPath.length} exceeds limit ${util.socketPathLimit()}`,
    )
  } finally {
    if (prev == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
    if (prevSocket != null) process.env.CLAUDE_CODEX_SOCKET_PATH = prevSocket
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
    assert.equal(settingsNotification.params.threadSettings.collaborationMode.mode, 'default')

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const read = await reader.nextResponse(3)
    assert.equal(read.result.model, 'haiku')
    assert.equal(read.result.reasoningEffort, 'xhigh')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/settings/update keeps the Plan toggle and thread/resume reports it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  // Sends a settings update and returns the mode thread/settings/updated echoed.
  const update = async (id: number, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method: 'thread/settings/update', params }))
    let echoed: any = null
    let answered = false
    for (let attempt = 0; attempt < 20 && (!answered || !echoed); attempt += 1) {
      const message = await reader.next()
      if (message.id === id && message.method == null) answered = true
      if (message.method === 'thread/settings/updated')
        echoed = message.params.threadSettings.collaborationMode
    }
    assert.ok(echoed)
    return echoed
  }
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id

    // The App adopts the echoed mode, so it must be the thread's real one.
    const planned = await update(2, {
      threadId,
      collaborationMode: {
        mode: 'plan',
        settings: { model: '', reasoning_effort: null, developer_instructions: null },
      },
    })
    assert.equal(planned.mode, 'plan')
    // An update that names no mode leaves it alone.
    assert.equal((await update(3, { threadId, personality: 'friendly' })).mode, 'plan')

    proc.stdin.write(json({ id: 4, method: 'thread/resume', params: { threadId } }))
    const resumed = await reader.nextResponse(4)
    assert.equal(resumed.result.collaborationMode.mode, 'plan')
    assert.equal(resumed.result.collaborationMode.settings.model, resumed.result.model)

    // The stored mode drives the next turn that names none.
    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'plan mode check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(5)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.match(text, /^planMode=true/)

    assert.equal(
      (
        await update(6, {
          threadId,
          collaborationMode: { mode: 'default', settings: { developer_instructions: null } },
        })
      ).mode,
      'default',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a Plan thread comes back in Plan after a restart, and its fork starts in Default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  let proc = spawnMockAdapter(home)
  let reader = new JsonLineReader(proc)
  // Runs a turn that names no mode and returns whether it ran in plan mode.
  const planTurn = async (id: number, threadId: string) => {
    sendTurn(proc, id, threadId, 'plan mode check')
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') break
    }
    return /^planMode=true/.test(text)
  }
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/settings/update',
        params: { threadId, collaborationMode: { mode: 'plan', settings: {} } },
      }),
    )
    await reader.nextResponse(2)
    await stopProcess(proc)

    proc = spawnMockAdapter(home)
    reader = new JsonLineReader(proc)
    proc.stdin.write(json({ id: 1, method: 'thread/resume', params: { threadId } }))
    assert.equal((await reader.nextResponse(1)).result.collaborationMode.mode, 'plan')
    assert.equal(await planTurn(2, threadId), true)

    // As a Codex fork does, the fork starts in the default mode; the App
    // sends the mode it shows for the fork with the fork's turns.
    proc.stdin.write(json({ id: 3, method: 'thread/fork', params: { threadId } }))
    const forkId = (await reader.nextResponse(3)).result.thread.id
    proc.stdin.write(json({ id: 4, method: 'thread/resume', params: { threadId: forkId } }))
    assert.equal((await reader.nextResponse(4)).result.collaborationMode.mode, 'default')
    assert.equal(await planTurn(5, forkId), false)
    // The parent keeps its own.
    assert.equal(await planTurn(6, threadId), true)
  } finally {
    await stopProcess(proc)
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
