#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { accessSync, constants, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Duplex } from 'node:stream'
import WebSocket from 'ws'

const root = resolve('.')
const adapter = resolve('dist/src/adapter.mjs')
const nodeBin = process.execPath
const remotePath = process.env.PATH ?? ''
const claudeCli = process.env.CLAUDE_CODEX_CLI ?? findExecutable('claude')
const host = process.env.CLAUDE_CODEX_GUI_SSH_HOST || 'localhost'
const requireRealRuntime = process.env.CLAUDE_CODEX_GUI_SSH_REQUIRE_REAL === '1'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const base = resolve('.claude-codex', `gui-ssh-localhost-${stamp}`)
const home = join(base, 'codex-home')
const workspace = join(base, 'workspace')
const socketPath = join(home, 'app-server-control', 'app-server-control.sock')
const targetFile = join(workspace, 'claude-codex-gui-ssh-acceptance.txt')
const expectedText = 'claude-codex-gui-ssh-ok'

let daemon = null
let proxy = null
let daemonStderr = ''
let proxyStderr = ''
let daemonSocketPath = socketPath
let useMockRuntime = false
let remoteAuthPreflight = 'not run'

const sshBaseArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host]

async function main() {
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'README.md'), 'gui ssh localhost acceptance workspace\n')
  initGitWorkspace(workspace)

  try {
    const expectedCodex = join(process.env.HOME || '', 'bin', 'codex')
    const rawProbe = runSsh('printf "codex=%s\\n" "$(command -v codex)"; codex --version')
    assert.match(
      rawProbe.stdout,
      new RegExp(`codex=${expectedCodex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )

    // Native TS runtime — @anthropic-ai/claude-agent-sdk lives in the adapter's
    // node_modules, no Python sidecar to probe anymore.
    const probe = runSsh(
      remoteShell(
        `${remoteEnv()}; cd ${shQuote(root)}; printf "codex=%s\\n" "$(command -v codex)"; codex --version; printf "adapter=%s\\n" "$CLAUDE_CODEX_ADAPTER"; "$CLAUDE_CODEX_NODE" -e "import(\\"@anthropic-ai/claude-agent-sdk\\").then(()=>console.log(\\"sdk-ok\\"))"`,
      ),
    )
    assert.match(
      probe.stdout,
      new RegExp(`codex=${expectedCodex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
    assert.match(probe.stdout, /codex-cli/)
    assert.match(probe.stdout, /sdk-ok/)

    const authProbe = probeRemoteClaudeAuth()
    remoteAuthPreflight = authProbe.message
    if (!authProbe.ok) {
      if (requireRealRuntime || !authProbe.canFallback) {
        throw new Error(`remote Claude auth preflight failed: ${authProbe.message}`)
      }
      useMockRuntime = true
      console.warn(
        `Remote Claude auth unavailable over SSH; using CLAUDE_CODEX_MOCK=1 (${authProbe.message})`,
      )
    }

    daemon = spawn(
      'ssh',
      [
        ...sshBaseArgs,
        remoteShell(`${remoteEnv({ mock: useMockRuntime })}; codex app-server --listen unix://`),
      ],
      {
        cwd: root,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    daemon.stderr.setEncoding('utf8')
    daemon.stderr.on('data', (chunk) => {
      daemonStderr += chunk
    })

    daemonSocketPath = await waitForSocket(socketPath)

    proxy = spawn(
      'ssh',
      [
        ...sshBaseArgs,
        remoteShell(`${remoteEnv({ mock: useMockRuntime })}; codex app-server proxy`),
      ],
      {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    proxy.stderr.setEncoding('utf8')
    proxy.stderr.on('data', (chunk) => {
      proxyStderr += chunk
    })

    const timeout = setTimeout(() => {
      cleanup()
      console.error('gui ssh localhost acceptance timed out')
      process.exit(1)
    }, 180_000)

    try {
      const rpc = await JsonRpcWebSocket.open(proxy)
      const init = await rpc.request('initialize', {
        clientInfo: {
          name: 'codex-app-gui-ssh-acceptance',
          title: 'Codex App GUI SSH Acceptance',
          version: '0',
        },
        capabilities: null,
      })
      assert.match(init.userAgent, /^codex-app-gui-ssh-acceptance\/0\.130\.0 /)

      const started = await rpc.request('thread/start', {
        cwd: workspace,
        model: 'sonnet',
        effort: 'medium',
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      })
      const threadId = started.thread.id

      await rpc.request('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: [
              'Use Claude Code tools in the current working directory.',
              `Create or overwrite a file named claude-codex-gui-ssh-acceptance.txt with exactly this content and no extra whitespace: ${expectedText}`,
              `After the file is written, reply with exactly: ${expectedText}`,
            ].join('\n'),
            text_elements: [],
          },
        ],
      })

      const approvals = { command: 0, file: 0 }
      let text = ''
      let diff = ''
      let completed = null

      while (!completed) {
        const message = await rpc.nextNotification()
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
        if (message.method === 'error') throw new Error(JSON.stringify(message.params))
        if (message.method === 'turn/completed') completed = message.params.turn
      }

      assert.equal(completed.status, 'completed')
      assert.ok(text.length > 0, 'expected streamed agent message deltas')
      assert.match(text, new RegExp(expectedText, 'i'))
      assert.ok(
        approvals.file > 0,
        'expected at least one file-change approval bridged through Codex',
      )
      assert.ok(diff.length > 0, 'expected a turn/diff/updated event')
      assert.match(diff, /claude-codex-gui-ssh-acceptance\.txt/)
      assert.equal((await readFile(targetFile, 'utf8')).trim(), expectedText)

      rpc.close()
      clearTimeout(timeout)
      cleanup()

      console.log('Codex App GUI-style SSH localhost acceptance passed')
      console.log(`host: ${host}`)
      console.log(`CODEX_HOME: ${home}`)
      console.log(`socket: ${daemonSocketPath}`)
      console.log(
        `runtime: ${useMockRuntime ? 'mock (SSH Claude auth unavailable)' : 'agent-sdk-sidecar'}`,
      )
      console.log(`remoteAuthPreflight: ${remoteAuthPreflight}`)
      console.log(`workspace: ${workspace}`)
      console.log(`thread: ${threadId}`)
      console.log(`approvals: command=${approvals.command} file=${approvals.file}`)
      console.log(`diffUpdated: ${diff.length > 0}`)
      console.log(`created: ${targetFile}`)
      console.log(`--- streamed agent message ---\n${text.trim()}`)
      console.log(`--- turn diff ---\n${diff.trim()}`)
    } catch (error) {
      clearTimeout(timeout)
      cleanup()
      throw error
    }
  } catch (error) {
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
  // SSH does not reliably propagate signals to the remote `app-server --listen`
  // process, so reclaim it deterministically via its pidfile.
  try {
    spawnSync(
      'ssh',
      [
        ...sshBaseArgs,
        `pidfile=${shQuote(`${daemonSocketPath}.pid`)}; [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null; rm -f "$pidfile"`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    )
  } catch {}
}

function remoteShell(command) {
  return `zsh -lc ${shQuote(command)}`
}

function remoteEnv(options = {}) {
  const exports = [
    `export PATH=${shQuote(remotePath)}`,
    `export CODEX_HOME=${shQuote(home)}`,
    `export CLAUDE_CODEX_ADAPTER=${shQuote(adapter)}`,
    `export CLAUDE_CODEX_NODE=${shQuote(nodeBin)}`,
  ]
  if (claudeCli) exports.push(`export CLAUDE_CODEX_CLI=${shQuote(claudeCli)}`)
  if (options.mock) exports.push('export CLAUDE_CODEX_MOCK=1')
  return exports.join('; ')
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function findExecutable(name) {
  for (const dir of remotePath.split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function runSsh(command) {
  const result = spawnSync('ssh', [...sshBaseArgs, command], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `ssh exited ${result.status}`).trim())
  }
  return result
}

function probeRemoteClaudeAuth() {
  if (!claudeCli) {
    return {
      ok: false,
      canFallback: true,
      message: 'claude CLI not found on local PATH for remote auth preflight',
    }
  }
  const marker = 'claude-codex-auth-ok'
  const result = spawnSync(
    'ssh',
    [
      ...sshBaseArgs,
      remoteShell(
        `${remoteEnv()}; ${shQuote(claudeCli)} -p ${shQuote(`Reply with exactly: ${marker}`)}`,
      ),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 45_000,
    },
  )
  const message = summarizeProbeResult(result)
  if (result.status === 0 && result.stdout.includes(marker)) {
    return { ok: true, canFallback: false, message: 'ok' }
  }
  return { ok: false, canFallback: isRemoteAuthUnavailable(message), message }
}

function summarizeProbeResult(result) {
  if (result.error) return result.error.message
  const combined = `${result.stderr || ''}\n${result.stdout || ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ')
  return combined.slice(0, 500) || `claude auth probe exited ${result.status ?? 'unknown'}`
}

function isRemoteAuthUnavailable(message) {
  return /not logged in|please run\s+\/login|authentication|oauth|api key|claude cli not found/i.test(
    message,
  )
}

function initGitWorkspace(cwd) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
  const init = git(['init'])
  if (init.status !== 0) throw new Error((init.stderr || init.stdout || 'git init failed').trim())
  git(['add', 'README.md'])
  git([
    '-c',
    'user.name=GUI SSH Acceptance',
    '-c',
    'user.email=gui-ssh@example.com',
    'commit',
    '-m',
    'init',
  ])
}

async function waitForSocket(path) {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    const daemonPath = daemonSocketPathFromStderr()
    if (daemonPath) return daemonPath
    if (existsSync(path)) return path
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function daemonSocketPathFromStderr() {
  const marker = '[claude-codex-adapter] listening on '
  const index = daemonStderr.lastIndexOf(marker)
  if (index < 0) return null
  const line = daemonStderr
    .slice(index + marker.length)
    .split('\n')[0]
    ?.trim()
  return line && !line.startsWith('ws://') ? line : null
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
    proc.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') this.destroy(error)
    })
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.proc.stdin.write(chunk, (error) => {
      if (error && error.code !== 'EPIPE') callback(error)
      else callback()
    })
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
      createConnection: () => stream,
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
