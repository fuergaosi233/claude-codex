#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const DEFAULT_MODES = ['codex', 'agent-sdk-sidecar', 'agent-http', 'agentapi', 'claude-p']
const TOKEN_FILE = '.claude-codex-mode-matrix-token'
const MODEL = process.env.MODE_MATRIX_MODEL || 'haiku'
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 180_000)
const RESTORE_ENV = process.env.MODE_MATRIX_RESTORE_ENV !== '0'

async function runOverSsh(args) {
  const host = args[0] || process.env.CLAUDE_CODEX_MATRIX_SSH_HOST
  if (!host) throw new Error('usage: acceptance-ssh-runtime-matrix.mjs <ssh-host> <cwd-a> <cwd-b>')
  const cwds = args.slice(1)
  if (cwds.length < 2)
    throw new Error('usage: acceptance-ssh-runtime-matrix.mjs <ssh-host> <cwd-a> <cwd-b>')
  const self = fileURLToPath(import.meta.url)
  const remoteScript = `/tmp/claude-codex-runtime-matrix-${Date.now()}-${process.pid}.mjs`

  runChecked('scp', ['-q', self, `${host}:${remoteScript}`])
  try {
    const cwdArgs = cwds.slice(0, 2).map(shQuote).join(' ')
    const env = [
      `MODE_MATRIX_MODEL=${shQuote(MODEL)}`,
      `TURN_TIMEOUT_MS=${shQuote(String(TURN_TIMEOUT_MS))}`,
      `MODE_MATRIX_RESTORE_ENV=${shQuote(RESTORE_ENV ? '1' : '0')}`,
      process.env.MODE_MATRIX_MODES
        ? `MODE_MATRIX_MODES=${shQuote(process.env.MODE_MATRIX_MODES)}`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
    const command = [
      'set -e',
      '. "$HOME/.claude-codex/runtime.env"',
      'node_bin="${CLAUDE_CODEX_NODE:-node}"',
      `${env} "$node_bin" ${shQuote(remoteScript)} --runner ${cwdArgs}`,
    ].join('; ')
    const proc = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', host, command], {
      stdio: 'inherit',
    })
    const code = await new Promise((resolve) =>
      proc.on('exit', (exitCode) => resolve(exitCode ?? 1)),
    )
    if (code !== 0) process.exit(code)
  } finally {
    spawnSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', host, `rm -f ${shQuote(remoteScript)}`],
      {
        stdio: 'ignore',
      },
    )
  }
}

async function runMatrix(cwds) {
  if (cwds.length < 2)
    throw new Error('usage: acceptance-ssh-runtime-matrix.mjs --runner <cwd-a> <cwd-b>')
  const selectedCwds = cwds.slice(0, 2)
  for (const cwd of selectedCwds) {
    if (!existsSync(cwd)) throw new Error(`cwd not found: ${cwd}`)
  }

  const modes = modesFromEnv('MODE_MATRIX_MODES', DEFAULT_MODES)
  const fromModes = modesFromEnv('MODE_MATRIX_FROM_MODES', modes)
  const toModes = modesFromEnv('MODE_MATRIX_TO_MODES', modes)
  const envFile =
    process.env.CLAUDE_CODEX_RUNTIME_ENV ||
    join(process.env.HOME || '', '.claude-codex/runtime.env')
  const originalEnv = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null
  const helper = process.env.CLAUDE_CODEX_MODE_COMMAND || 'claude-codex-mode'
  const codexReal = requireEnv('CODEX_REAL')
  const nodeBin = process.env.CLAUDE_CODEX_NODE || process.execPath
  const adapter = requireEnv('CLAUDE_CODEX_ADAPTER')
  const scratch = mkdtempSync(join(tmpdir(), 'claude-codex-runtime-matrix-'))
  const results = []
  const runId = Date.now().toString(36)

  for (let i = 0; i < selectedCwds.length; i += 1) {
    writeToken(selectedCwds[i], `MODE_MATRIX_BOOT_${runId}_${i}_${basename(selectedCwds[i])}`)
  }

  console.log(
    JSON.stringify({
      event: 'matrix-start',
      host: process.env.HOSTNAME || null,
      modes,
      fromModes,
      toModes,
      cwds: selectedCwds,
      model: MODEL,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      envFile,
      helper,
      adapter,
    }),
  )

  try {
    let transitionIndex = 0
    for (const from of fromModes) {
      for (const to of toModes) {
        transitionIndex += 1
        const transition = `${from}->${to}`
        const switchStarted = Date.now()
        runHelper(helper, ['set', from, MODEL, selectedCwds[0]], 180_000)
        runHelper(helper, ['set', to, MODEL, selectedCwds[0]], 180_000)
        const switchMs = Date.now() - switchStarted

        for (let cwdIndex = 0; cwdIndex < selectedCwds.length; cwdIndex += 1) {
          const cwd = selectedCwds[cwdIndex]
          const expected = `MODE_MATRIX_TOKEN_${runId}_${transitionIndex}_${cwdIndex}_${basename(cwd)}`
          writeToken(cwd, expected)
          const rec = {
            event: 'matrix-result',
            transitionIndex,
            transition,
            from,
            to,
            cwd,
            cwdIndex,
            expected,
            ok: false,
            switchMs,
            durationMs: 0,
            text: '',
            error: '',
          }
          const started = Date.now()
          try {
            await ensureBridgeIfNeeded(helper, to, cwd)
            const text =
              to === 'codex'
                ? runCodex(codexReal, cwd, expected, scratch)
                : await runAdapter({ nodeBin, adapter, cwd, expected, mode: to })
            rec.text = text.trim()
            rec.ok = rec.text.includes(expected)
            if (!rec.ok) rec.error = 'expected token not found in model response'
          } catch (error) {
            rec.error = error instanceof Error ? error.message : String(error)
          } finally {
            rec.durationMs = Date.now() - started
            results.push(rec)
            console.log(JSON.stringify(rec))
          }
        }
      }
    }
  } finally {
    for (const cwd of selectedCwds) {
      try {
        unlinkSync(join(cwd, TOKEN_FILE))
      } catch {}
    }
    rmSync(scratch, { recursive: true, force: true })
    if (RESTORE_ENV && originalEnv != null) {
      writeFileSync(envFile, originalEnv)
      try {
        runHelper(helper, ['prune-bridges'], 60_000, true)
      } catch {}
    }
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(
    JSON.stringify({
      event: 'matrix-summary',
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      failures: failed.map(({ transition, cwd, error, text }) => ({
        transition,
        cwd,
        error,
        text: text.slice(0, 240),
      })),
    }),
  )
  process.exit(failed.length > 0 ? 1 : 0)
}

function modesFromEnv(key, fallback) {
  const raw = process.env[key]
  if (!raw) return fallback
  const modes = raw
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean)
  return modes.length > 0 ? modes : fallback
}

function requireEnv(key) {
  const value = process.env[key]
  if (!value)
    throw new Error(`missing ${key}; source ~/.claude-codex/runtime.env before running the matrix`)
  return value
}

function writeToken(cwd, token) {
  writeFileSync(join(cwd, TOKEN_FILE), `${token}\n`)
}

function prompt(expected) {
  return [
    `Read the file named ${TOKEN_FILE} in the current working directory.`,
    'Reply with exactly the file contents and nothing else.',
    `The expected content is: ${expected}`,
  ].join('\n')
}

function runHelper(helper, args, timeout, allowFail = false) {
  const result = spawnSync(helper, args, {
    encoding: 'utf8',
    timeout,
    env: { ...process.env },
    maxBuffer: 1024 * 1024,
  })
  if (!allowFail && result.status !== 0) {
    throw new Error(
      (
        result.stderr ||
        result.stdout ||
        `${helper} ${args.join(' ')} exited ${result.status}`
      ).trim(),
    )
  }
  return result
}

async function ensureBridgeIfNeeded(helper, mode, cwd) {
  if (mode !== 'agent-http' && mode !== 'agentapi') return
  const ready = runHelper(helper, ['ensure-bridge', mode, MODEL, cwd], 180_000)
  if (mode !== 'agentapi') return
  const baseUrl = ready.stdout.match(/CLAUDE_CODEX_BRIDGE_URL=(\S+)/)?.[1]
  if (baseUrl) runHelper(helper, ['trust', baseUrl], 60_000, true)
}

function runCodex(codexReal, cwd, expected, scratch) {
  const out = join(scratch, `codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
  const result = spawnSync(
    codexReal,
    [
      'exec',
      '--cd',
      cwd,
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      out,
      prompt(expected),
    ],
    {
      encoding: 'utf8',
      timeout: TURN_TIMEOUT_MS,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      maxBuffer: 2 * 1024 * 1024,
    },
  )
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `codex exec exited ${result.status}`).trim())
  }
  return existsSync(out) ? readFileSync(out, 'utf8') : result.stdout
}

async function runAdapter({ nodeBin, adapter, cwd, expected, mode }) {
  const envFile =
    process.env.CLAUDE_CODEX_RUNTIME_ENV ||
    join(process.env.HOME || '', '.claude-codex/runtime.env')
  const proc = spawn(
    'bash',
    [
      '-lc',
      `set -a; . ${shQuote(envFile)}; set +a; exec ${shQuote(nodeBin)} ${shQuote(adapter)} app-server --listen stdio://`,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: adapterEnv(),
      detached: process.platform !== 'win32',
    },
  )
  const reader = new RpcReader(proc)
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-6000)
  })
  const timer = setTimeout(() => {
    terminateProcessTree(proc, 'SIGTERM')
    setTimeout(() => terminateProcessTree(proc, 'SIGKILL'), 1500).unref()
  }, TURN_TIMEOUT_MS)

  try {
    send(proc, {
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'runtime-mode-matrix', title: 'Runtime Mode Matrix', version: '1' },
        capabilities: null,
      },
    })
    await reader.response(1)
    send(proc, {
      id: 2,
      method: 'thread/start',
      params: {
        cwd,
        model: MODEL,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })
    const start = await reader.response(2)
    const threadId = start.result?.thread?.id
    if (!threadId) throw new Error(`thread/start did not return a thread id for ${mode}`)
    send(proc, {
      id: 3,
      method: 'turn/start',
      params: {
        threadId,
        cwd,
        model: MODEL,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        input: [{ type: 'text', text: prompt(expected), text_elements: [] }],
      },
    })
    await reader.response(3)
    let text = ''
    for (;;) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params?.delta || ''
      if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
        text = message.params.item.text || text
      }
      if (
        message.method === 'item/commandExecution/requestApproval' ||
        message.method === 'item/fileChange/requestApproval'
      ) {
        send(proc, { id: message.id, result: { decision: 'accept' } })
      }
      if (message.method === 'error') throw new Error(JSON.stringify(message.params))
      if (message.method === 'turn/completed') {
        const status = message.params?.turn?.status
        if (status && status !== 'completed')
          throw new Error(`turn completed with status ${status}`)
        return text
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${detail}${stderr ? `\nstderr:\n${stderr}` : ''}`)
  } finally {
    clearTimeout(timer)
    terminateProcessTree(proc, 'SIGTERM')
    await delay(50)
  }
}

function adapterEnv() {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' }
  if (!env.CLAUDE_CODEX_CLAUDE_P_TIMEOUT_MS) {
    const timeout = Math.max(30_000, Math.min(120_000, TURN_TIMEOUT_MS - 60_000))
    env.CLAUDE_CODEX_CLAUDE_P_TIMEOUT_MS = String(timeout)
  }
  return env
}

function send(proc, message) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

class RpcReader {
  constructor(proc) {
    this.buffer = ''
    this.queue = []
    this.waiters = []
    this.error = null
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.push(chunk))
    proc.on('exit', (code, signal) =>
      this.fail(new Error(`app-server exited code=${code} signal=${signal}`)),
    )
    proc.on('error', (error) => this.fail(error))
  }

  push(chunk) {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) return
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(message)
      else this.queue.push(message)
    }
  }

  fail(error) {
    this.error = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  next() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  async response(id) {
    for (;;) {
      const message = await this.next()
      if (message.id !== id || message.method != null) continue
      if (message.error) throw new Error(JSON.stringify(message.error))
      return message
    }
  }
}

function terminateProcessTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  child.kill(signal)
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim())
  }
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

if (process.argv[2] === '--runner') {
  await runMatrix(process.argv.slice(3))
} else {
  await runOverSsh(process.argv.slice(2))
}
