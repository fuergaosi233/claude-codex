import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ClaudePTranscriptRuntime } from '../src/claude-p-runtime.mjs'
import { HttpAgentRuntime, hasAgentapiTrustPrompt, sanitizeAgentapiTerminalContent } from '../src/http-agent-runtime.mjs'
import { resolveRuntimeConfig } from '../src/runtime-config.mjs'

test('runtime config keeps legacy defaults and accepts explicit backends', () => {
  assert.equal(resolveRuntimeConfig({}).type, 'agent-sdk-sidecar')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_MOCK: '1' }).type, 'mock')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_SOCKET: '/tmp/runtime.sock' }).type, 'agent-sdk-socket')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'channels' }).type, 'agent-http')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'agentapi' }).type, 'agentapi')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'claude-p' }).type, 'claude-p')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_HTTP_MANAGE_BRIDGE: '1' }).http.manageBridge, true)
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_MODE_COMMAND: '/tmp/mode' }).http.modeCommand, '/tmp/mode')
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
        messages = messages.map((message) => message.id === 2 ? { ...message, content: 'hello world' } : message)
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
  async function startServer(label: string): Promise<{ url: string; close: () => Promise<void>; prompts: string[] }> {
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
          messages = [{ id: 1, role: 'assistant', content: `answer from ${label}`, time: new Date().toISOString() }]
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
      `const urls = new Map(${JSON.stringify([[cwdA, a.url], [cwdB, b.url]])});`,
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
        messages = [{ id: 1, role: 'agent', content: 'polling answer', time: new Date().toISOString() }]
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
      messages: [{ role: 'agent', content: 'Welcome back Renee!\nWhat would you like to work on?' }],
    }),
    false,
  )
})

test('agentapi terminal sanitizer removes Claude Code TUI status artifacts', () => {
  assert.equal(
    sanitizeAgentapiTerminalContent('● Hi! What can I help you with today?                                           \n                                                                                \n✻ Worked for 3s                                                                 '),
    'Hi! What can I help you with today?',
  )
  assert.equal(
    sanitizeAgentapiTerminalContent('* Fluttering...\n└ Tip: Run /install-github-app to tag @claude right from your Github issues\nand PRs'),
    '',
  )
})
