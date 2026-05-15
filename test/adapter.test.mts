import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    proc.stdin.write(json({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null } }))
    const init = await reader.nextResponse(1)
    assert.equal(init.result.platformFamily, process.platform === 'win32' ? 'windows' : 'unix')

    proc.stdin.write(json({ id: 2, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(2)
    const threadId = start.result.thread.id
    assert.equal(start.result.modelProvider, 'claude-code')

    proc.stdin.write(json({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] } }))
    const turnStart = await reader.nextResponse(3)
    assert.equal(turnStart.result.turn.status, 'inProgress')

    const deltas: string[] = []
    let sawAgentCompleted = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') deltas.push(message.params.delta)
      if (message.method === 'item/completed' && message.params.item.type === 'agentMessage') sawAgentCompleted = true
      if (message.method === 'turn/completed') break
    }
    assert.match(deltas.join(''), /Claude Code adapter mock response/)
    assert.equal(sawAgentCompleted, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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

    proc.stdin.write(json({ id: 2, method: 'model/list', params: {} }))
    const models = await reader.nextResponse(2)
    const ids = models.result.data.map((model: any) => model.id)
    assert.equal(ids.includes('sonnet'), true)
    assert.equal(ids.includes('opus'), true)
    assert.equal(ids.includes('sonnet-1m'), true)
    assert.equal(ids.includes('opus-plan'), true)
    const opus = models.result.data.find((model: any) => model.id === 'opus')
    assert.equal(opus.isDefault, true)
    assert.deepEqual(
      opus.supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort),
      ['low', 'medium', 'high', 'xhigh'],
    )
  } finally {
    proc.kill()
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet-1m', effort: 'high', experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'sonnet-1m')
    assert.equal(start.result.reasoningEffort, 'high')

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, model: 'sonnet-1m', effort: 'xhigh', input: [{ type: 'text', text: 'model effort check', text_elements: [] }] } }))
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'gpt-5.4-mini', experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    assert.equal(start.result.model, 'gpt-5.4-mini')

    const outputSchema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    }
    proc.stdin.write(json({
      id: 2,
      method: 'turn/start',
      params: {
        threadId,
        model: 'gpt-5.4-mini',
        outputSchema,
        input: [{ type: 'text', text: 'output schema check', text_elements: [] }],
      },
    }))
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
    await rm(home, { recursive: true, force: true })
  }
})

test('internal Codex title prompts are handled locally without Claude turn leakage', async () => {
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), model: 'sonnet', experimentalRawEvents: false, persistExtendedHistory: false } }))
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
      '看看当前项目情况呢?',
      '',
      'Show more',
      '11:17 PM',
    ].join('\n')
    proc.stdin.write(json({
      id: 2,
      method: 'turn/start',
      params: {
        threadId,
        model: 'gpt-5.4-mini',
        effort: 'medium',
        outputSchema,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      },
    }))
    const turnStart = await reader.nextResponse(2)
    assert.equal(turnStart.result.turn.items.some((item: any) => item.type === 'userMessage'), false)

    let text = ''
    let completedTurn: any = null
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'turn/completed') {
        completedTurn = message.params.turn
        break
      }
    }
    assert.deepEqual(JSON.parse(text), { title: '处理看看当前项目情况呢' })
    assert.equal(completedTurn.items.some((item: any) => item.type === 'userMessage'), false)
    const logText = await readFile(debugLog, 'utf8')
    assert.match(logText, /turn\.internalTitle\.shortCircuit/)
    assert.doesNotMatch(logText, /model=haiku|output schema check/)
    assert.doesNotMatch(logText, /helpful assistant|看看当前项目情况/)
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'tool policy check', text_elements: [] }] } }))
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
    await rm(home, { recursive: true, force: true })
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
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'test', title: 'Test', version: '0' }, capabilities: null } }))
    const [data] = (await once(ws, 'message')) as [Buffer]
    const response = JSON.parse(data.toString('utf8'))
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
    ws.close()
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
    await rm(home, { recursive: true, force: true })
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
      createConnection: ((() => stream) as unknown) as typeof net.createConnection,
    })
    await once(ws, 'open')
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'proxy-test', title: 'Proxy Test', version: '0' }, capabilities: null } }))
    const [data] = (await once(ws, 'message')) as [Buffer]
    const response = JSON.parse(data.toString('utf8'))
    assert.equal(response.id, 1)
    assert.equal(response.result.codexHome, home)
    ws.close()
  } finally {
    proxy.kill()
    daemon.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test('remote shim launches daemon and proxy with Codex-compatible commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  // Keep the socket path short — a mkdtemp dir nested under macOS tmpdir blows
  // past the ~104-byte sockaddr_un limit, which surfaced as a bind EINVAL.
  const sock = join(tmpdir(), `ccx-test-${randomUUID().slice(0, 8)}.sock`)
  const daemon = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_ADAPTER: adapter, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const proxy = spawn(shim, ['app-server', 'proxy', '--sock', sock], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_ADAPTER: adapter, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  try {
    await waitForStderr(daemon, /listening on/)
    const stream = new ChildProcessDuplex(proxy)
    const ws = new WebSocket('ws://localhost/', {
      createConnection: ((() => stream) as unknown) as typeof net.createConnection,
    })
    await once(ws, 'open')
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'shim-test', title: 'Shim Test', version: '0' }, capabilities: null } }))
    const [data] = (await once(ws, 'message')) as [Buffer]
    const response = JSON.parse(data.toString('utf8'))
    assert.equal(response.result.codexHome, home)
    ws.close()
  } finally {
    proxy.kill()
    daemon.kill()
    await rm(home, { recursive: true, force: true })
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
    assert.match(Buffer.from(file.result.dataBase64, 'base64').toString('utf8'), /Claude Codex Adapter/)

    proc.stdin.write(json({ id: 2, method: 'fs/getMetadata', params: { path: resolve('README.md') } }))
    const metadata = await reader.nextResponse(2)
    assert.equal(metadata.result.isFile, true)
    assert.equal(metadata.result.isDirectory, false)

    proc.stdin.write(json({ id: 3, method: 'fs/readDirectory', params: { path: process.cwd() } }))
    const directory = await reader.nextResponse(3)
    assert.equal(directory.result.entries.some((entry: any) => entry.fileName === 'package.json' && entry.isFile), true)

    proc.stdin.write(json({ id: 4, method: 'command/exec', params: { command: [process.execPath, '-e', 'process.stdout.write("ok")'], cwd: process.cwd() } }))
    const command = await reader.nextResponse(4)
    assert.deepEqual(command.result, { exitCode: 0, stdout: 'ok', stderr: '' })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test('process/spawn supports shell strings, errors, and debug logs terminal lifecycle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const debugLog = join(home, 'adapter-debug.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_DEBUG_LOG: debugLog, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'process/spawn', params: { processHandle: 'shell-process', command: 'printf shell-ok', cwd: process.cwd(), streamStdoutStderr: false } }))
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

    proc.stdin.write(json({ id: 2, method: 'process/spawn', params: { processHandle: 'missing-process', command: ['/definitely/missing/claude-codex-test'], cwd: process.cwd() } }))
    await reader.nextResponse(2)
    let errorExit: any = null
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'process/exited' && message.params.processHandle === 'missing-process') {
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
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'thread/compact/start', params: { threadId } }))
    await reader.nextResponse(2)
    let sawCompaction = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed' && message.params.item.type === 'contextCompaction') sawCompaction = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawCompaction, true)

    proc.stdin.write(json({ id: 3, method: 'review/start', params: { threadId, delivery: 'inline', target: { type: 'custom', instructions: 'notice event' } } }))
    const review = await reader.nextResponse(3)
    assert.equal(review.result.reviewThreadId, threadId)
    assert.equal(review.result.turn.status, 'inProgress')
    assert.equal(review.result.turn.items.some((item: any) => item.type === 'enteredReviewMode'), true)

    let reviewText = ''
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') reviewText += message.params.delta
      if (message.method === 'turn/completed') break
    }
    assert.match(reviewText, /Claude Code adapter mock response|Claude warning/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'thinking check', text_elements: [] }] } }))
    await reader.nextResponse(2)

    let sawSummary = false
    let sawContent = false
    let completedReasoning: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/reasoning/summaryTextDelta') sawSummary = true
      if (message.method === 'item/reasoning/textDelta') sawContent = true
      if (message.method === 'item/completed' && message.params.item.type === 'reasoning') completedReasoning = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawSummary, true)
    assert.equal(sawContent, true)
    assert.deepEqual(completedReasoning.summary, ['mock thinking'])
    assert.deepEqual(completedReasoning.content, ['mock thinking'])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'usage check', text_elements: [] }] } }))
    await reader.nextResponse(2)

    let tokenUsage: any = null
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/tokenUsage/updated') tokenUsage = message.params
      if (message.method === 'turn/completed') break
    }
    assert.ok(tokenUsage, 'expected a thread/tokenUsage/updated notification')
    assert.equal(tokenUsage.threadId, threadId)
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
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'danger-full-access', experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id
    // Envelope reflects the App's chosen policy/sandbox instead of the previous hardcoded `on-request` + workspaceWrite.
    assert.equal(start.result.approvalPolicy, 'never')
    assert.equal((start.result.sandbox as any).type, 'dangerFullAccess')

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }] } }))
    await reader.nextResponse(2)

    let sawApprovalRequest = false
    let sawCommandOutput = false
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/commandExecution/requestApproval') sawApprovalRequest = true
      if (message.method === 'item/commandExecution/outputDelta' && /mock approval/.test(message.params.delta)) sawCommandOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawApprovalRequest, false, 'expected no requestApproval round-trip when approvalPolicy=never')
    assert.equal(sawCommandOutput, true, 'tool should still execute and stream output')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test('Task subagent inner events are hidden; only the Agent item completes with the final result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'subagent check', text_elements: [] }] } }))
    await reader.nextResponse(2)

    let taskItemId: string | null = null
    let taskCompleted = false
    let agentMessageText = ''
    let leakedInnerItems = 0
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started') {
        const item = message.params.item
        if (item.type === 'mcpToolCall' && item.tool === 'Task') taskItemId = item.id
        else if (item.type === 'commandExecution' || (item.type === 'mcpToolCall' && item.tool !== 'Task')) leakedInnerItems += 1
      }
      if (message.method === 'item/completed' && message.params.item.id === taskItemId) taskCompleted = true
      if (message.method === 'item/agentMessage/delta') agentMessageText += String(message.params.delta ?? '')
      if (message.method === 'turn/completed') break
    }
    assert.ok(taskItemId, 'Task tool should appear as a single mcpToolCall item')
    assert.equal(taskCompleted, true, 'Task item should complete on its matching tool_result')
    assert.equal(leakedInnerItems, 0, 'inner Bash tool calls should be suppressed while subagent runs')
    assert.doesNotMatch(agentMessageText, /subagent thinking aloud/, 'subagent text should not bleed into the main agent message')
    assert.match(agentMessageText, /main agent summary/, 'main agent text after subagent should still appear')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }] } }))
    await reader.nextResponse(2)

    let approvalRequest: any = null
    let sawWaitingOnApproval = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/status/changed' && message.params.status.activeFlags?.includes('waitingOnApproval')) {
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
      if (message.method === 'item/commandExecution/outputDelta' && /mock approval/.test(message.params.delta)) sawOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawResolved, true)
    assert.equal(sawOutput, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'please use generic tool', text_elements: [] }] } }))
    await reader.nextResponse(2)

    let completedTool: any = null
    let sawIdle = false
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'thread/status/changed' && message.params.status.type === 'idle') sawIdle = true
      if (message.method === 'item/completed' && message.params.item.type === 'mcpToolCall') completedTool = message.params.item
      if (message.method === 'turn/completed') break
    }
    assert.equal(completedTool?.tool, 'Read')
    assert.equal(completedTool?.status, 'completed')
    assert.deepEqual(completedTool?.result, { text: 'mock read result' })
    assert.equal(sawIdle, true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'slow turn for steering', text_elements: [] }] } }))
    const started = await reader.nextResponse(2)
    const turnId = started.result.turn.id

    proc.stdin.write(json({ id: 3, method: 'turn/steer', params: { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'steered input', text_elements: [] }] } }))
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

    proc.stdin.write(json({ id: 4, method: 'thread/turns/items/list', params: { threadId, turnId } }))
    const items = await reader.nextResponse(4)
    assert.equal(items.result.data.some((item: any) => item.type === 'userMessage' && item.content?.[0]?.text === 'steered input'), true)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'thread/increment_elicitation', params: { threadId } }))
    assert.deepEqual((await reader.nextResponse(2)).result, { count: 1, paused: true })

    proc.stdin.write(json({ id: 3, method: 'thread/decrement_elicitation', params: { threadId } }))
    assert.deepEqual((await reader.nextResponse(3)).result, { count: 0, paused: false })

    proc.stdin.write(json({ id: 4, method: 'experimentalFeature/enablement/set', params: { enablement: { demo: true } } }))
    assert.deepEqual((await reader.nextResponse(4)).result, { enablement: { demo: true } })

    proc.stdin.write(json({ id: 5, method: 'mock/experimentalMethod', params: { value: 'ok' } }))
    assert.deepEqual((await reader.nextResponse(5)).result, { echoed: 'ok' })

    proc.stdin.write(json({ id: 6, method: 'windowsSandbox/readiness', params: {} }))
    assert.deepEqual((await reader.nextResponse(6)).result, { status: 'notConfigured' })

    proc.stdin.write(json({ id: 7, method: 'plugin/install', params: { pluginName: 'demo' } }))
    assert.deepEqual((await reader.nextResponse(7)).result, { authPolicy: 'ON_USE', appsNeedingAuth: [] })
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test('file change approval emits patch and git diff updates', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })

  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: repo, experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'please edit file', text_elements: [] }] } }))
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
    await rm(home, { recursive: true, force: true })
  }
})

test('gitDiffToRemote includes untracked files for Codex diff review', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
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
    await rm(home, { recursive: true, force: true })
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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false } }))
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(json({ id: 2, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: 'session check', text_elements: [] }] } }))
    await reader.nextResponse(2)
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(3)
    assert.equal(resume.result.thread.id, threadId)
    assert.equal(resume.result.thread.turns.length, 1)

    proc.stdin.write(json({ id: 4, method: 'thread/fork', params: { threadId, persistExtendedHistory: false } }))
    const fork = await reader.nextResponse(4)
    assert.equal(fork.result.thread.forkedFromId, threadId)
    assert.equal(fork.result.thread.sessionId, resume.result.thread.sessionId)

    proc.stdin.write(json({ id: 5, method: 'turn/interrupt', params: { threadId } }))
    const interrupt = await reader.nextResponse(5)
    assert.deepEqual(interrupt.result, {})
  } finally {
    proc.kill()
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
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({ demo: { type: 'stdio', command: 'node', args: ['mcp.js'] } }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServerStatus/list', params: {} }))
    const response = await reader.nextResponse(1)
    assert.equal(response.result.data[0].name, 'demo')
    assert.equal(response.result.data[0].status, 'pending')
    assert.equal(response.result.data[0].config.command, 'node')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
      CLAUDE_CODEX_MCP_SERVERS: JSON.stringify({ fixture: { type: 'stdio', command: process.execPath, args: [fixture] } }),
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json({ id: 1, method: 'mcpServer/tool/call', params: { threadId: 't', server: 'fixture', tool: 'echo', arguments: { value: 'ok' } } }))
    const tool = await reader.nextResponse(1)
    assert.equal(tool.result.content[0].text, 'tool:echo:ok')
    assert.equal(tool.result.structuredContent.ok, true)

    proc.stdin.write(json({ id: 2, method: 'mcpServer/resource/read', params: { threadId: 't', server: 'fixture', uri: 'fixture://resource' } }))
    const resource = await reader.nextResponse(2)
    assert.equal(resource.result.contents[0].uri, 'fixture://resource')
    assert.equal(resource.result.contents[0].text, 'resource-ok')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'http-fixture', version: '1' } } }))
        return
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `http:${message.params.name}` }], structuredContent: { http: true }, isError: false } }))
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
    proc.stdin.write(json({ id: 1, method: 'mcpServer/tool/call', params: { threadId: 't', server: 'fixture', tool: 'echo', arguments: {} } }))
    const tool = await reader.nextResponse(1)
    assert.equal(tool.result.content[0].text, 'http:echo')
    assert.equal(tool.result.structuredContent.http, true)
  } finally {
    proc.kill()
    httpServer.close()
    await rm(home, { recursive: true, force: true })
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
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' })

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
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: repo, experimentalRawEvents: false, persistExtendedHistory: false } }))
    const response = await reader.nextResponse(1)
    assert.match(response.result.cwd, /worktrees/)
    assert.match(response.result.thread.cwd, /worktrees/)
    assert.notEqual(response.result.cwd, repo)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true })
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
    let idx
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
  constructor(private proc: ChildProcess) {
    super()
    if (!proc.stdin || !proc.stdout) throw new Error('proxy process needs stdin/stdout')
    proc.stdout.on('data', (chunk) => this.push(chunk))
    proc.stdout.on('end', () => this.push(null))
    proc.on('exit', () => this.push(null))
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.proc.stdin?.write(chunk, callback)
  }

  _final(callback: (error?: Error | null) => void): void {
    this.proc.stdin?.end()
    callback()
  }
}

function json(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`
}

async function waitForStderr(proc: ChildProcess, pattern: RegExp): Promise<void> {
  if (!proc.stderr) throw new Error('test process has no stderr')
  proc.stderr.setEncoding('utf8')
  let acc = ''
  const timeout = setTimeout(() => {
    proc.kill()
  }, 5000)
  try {
    for await (const chunk of proc.stderr) {
      acc += String(chunk)
      if (pattern.test(acc)) return
    }
  } finally {
    clearTimeout(timeout)
  }
}
