#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import WebSocket from 'ws'

const root = resolve('.')
const adapter = resolve('dist/src/adapter.mjs')
const shimSource = resolve('scripts/codex-shim')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const base = resolve('.claude-codex', `local-remote-acceptance-${stamp}`)
const home = join(base, 'codex-home')
const bin = join(base, 'bin')
const workspace = join(base, 'workspace')
const shim = join(bin, 'codex')
const socketPath = join(home, 'app-server-control', 'app-server-control.sock')
const targetFile = join(workspace, 'claude-codex-remote-acceptance.txt')
const expectedText = 'claude-codex-remote-file-ok'

let daemon = null
let proxy = null
let daemonStderr = ''
let proxyStderr = ''

async function main() {
await mkdir(bin, { recursive: true })
await mkdir(home, { recursive: true })
await mkdir(workspace, { recursive: true })
await copyFile(shimSource, shim)
await chmod(shim, 0o755)
await writeFile(join(workspace, 'README.md'), 'local remote acceptance workspace\n')
initGitWorkspace(workspace)

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH ?? ''}`,
  CODEX_HOME: home,
  CLAUDE_CODEX_ADAPTER: adapter,
  NODE_NO_WARNINGS: '1',
}
delete env.CLAUDE_CODEX_MOCK

const version = run('codex', ['--version'], env)
assert.match(version.stdout, /codex-cli/)

daemon = spawn('codex', ['app-server', '--listen', 'unix://'], {
  cwd: root,
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
})
daemon.stderr.setEncoding('utf8')
daemon.stderr.on('data', (chunk) => {
  daemonStderr += chunk
})

proxy = spawn('codex', ['app-server', 'proxy'], {
  cwd: root,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})
proxy.stderr.setEncoding('utf8')
proxy.stderr.on('data', (chunk) => {
  proxyStderr += chunk
})

const timeout = setTimeout(() => {
  console.error('local remote acceptance timed out')
  cleanup()
  process.exit(1)
}, 180_000)

try {
  await waitForSocket(socketPath)
  const rpc = await JsonRpcWebSocket.open(proxy)

  const init = await rpc.request('initialize', {
    clientInfo: { name: 'local-remote-acceptance', title: 'Local Remote Acceptance', version: '0' },
    capabilities: null,
  })
  assert.equal(init.platformFamily, process.platform === 'win32' ? 'windows' : 'unix')

  const started = await rpc.request('thread/start', {
    cwd: workspace,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  const threadId = started.thread.id

  const turn = await rpc.request('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: [
          'Use Claude Code tools in the current working directory.',
          `Create or overwrite a file named claude-codex-remote-acceptance.txt with exactly this content and no extra whitespace: ${expectedText}`,
          `After the file is written, reply with exactly: ${expectedText}`,
        ].join('\n'),
        text_elements: [],
      },
    ],
  })
  assert.equal(turn.turn.status, 'inProgress')

  const approvals = { command: 0, file: 0 }
  let text = ''
  let diff = ''
  let sawRemoteStatus = false
  let completed = null

  while (!completed) {
    const message = await rpc.nextNotification()
    if (message.method === 'thread/status/changed') sawRemoteStatus = true
    if (message.method === 'item/agentMessage/delta') text += message.params.delta
    if (message.method === 'turn/diff/updated') diff = message.params.diff
    if (message.method === 'item/commandExecution/requestApproval') {
      approvals.command += 1
      rpc.respond(message.id, { decision: 'accept' })
    }
    if (message.method === 'item/fileChange/requestApproval') {
      approvals.file += 1
      rpc.respond(message.id, { decision: 'accept' })
    }
    if (message.method === 'error') {
      throw new Error(JSON.stringify(message.params))
    }
    if (message.method === 'turn/completed') {
      completed = message.params.turn
    }
  }

  assert.equal(completed.status, 'completed')
  assert.equal(sawRemoteStatus, true)
  assert.match(text, new RegExp(expectedText, 'i'))
  const fileText = await readFile(targetFile, 'utf8')
  assert.equal(fileText.trim(), expectedText)

  rpc.close()
  clearTimeout(timeout)
  cleanup()

  console.log('local Codex Remote -> shim -> app-server proxy -> Claude Code acceptance passed')
  console.log(`shim: ${shim}`)
  console.log(`CODEX_HOME: ${home}`)
  console.log(`workspace: ${workspace}`)
  console.log(`thread: ${threadId}`)
  console.log(`approvals: command=${approvals.command} file=${approvals.file}`)
  console.log(`diffUpdated: ${diff.length > 0}`)
  console.log(`created: ${targetFile}`)
} catch (error) {
  clearTimeout(timeout)
  cleanup()
  console.error(`acceptance artifacts kept at: ${base}`)
  if (daemonStderr) console.error(`[daemon stderr]\n${daemonStderr}`)
  if (proxyStderr) console.error(`[proxy stderr]\n${proxyStderr}`)
  throw error
}
}

function cleanup() {
  proxy?.kill()
  daemon?.kill()
}

function run(command, args, runEnv) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: runEnv,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim())
  }
  return result
}

function initGitWorkspace(cwd) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  const init = git(['init'])
  if (init.status !== 0) throw new Error((init.stderr || init.stdout || 'git init failed').trim())
  git(['add', 'README.md'])
  git(['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.com', 'commit', '-m', 'init'])
}

async function waitForSocket(path) {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    if (existsSync(path) || daemonStderr.includes(`listening on ${path}`)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class ChildProcessDuplex extends Duplex {
  constructor(proc) {
    super()
    if (!proc.stdin || !proc.stdout) throw new Error('proxy process needs stdin/stdout')
    this.proc = proc
    proc.stdout.on('data', (chunk) => this.push(chunk))
    proc.stdout.on('end', () => this.push(null))
    proc.on('exit', () => this.push(null))
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.proc.stdin.write(chunk, callback)
  }

  _final(callback) {
    this.proc.stdin.end()
    callback()
  }
}

class JsonRpcWebSocket {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.waiters = []
    ws.on('message', (data) => this.handleMessage(data))
  }

  static async open(proxyProc) {
    const stream = new ChildProcessDuplex(proxyProc)
    const ws = new WebSocket('ws://localhost/', {
      createConnection: (() => stream),
    })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return new JsonRpcWebSocket(ws)
  }

  request(method, params) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  respond(id, result) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }

  nextNotification() {
    const existing = this.notifications.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close() {
    this.ws.close()
  }

  handleMessage(data) {
    const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
    if (message.id != null && message.method == null) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter(message)
    else this.notifications.push(message)
  }
}

await main()
