#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const usage = `Usage:
  claude-codex-isolated --state-dir PATH [--port PORT]
      [--ws-auth capability-token|none] [--ws-token-file ABS_PATH | --ws-token-sha256 HEX]
      [--ws-allowed-origins ORIGIN,...]

Starts a foreground adapter on ws://127.0.0.1:PORT (default: a free port).
Use a dedicated state directory for each instance. Token auth is on by default;
the adapter prints the token file and bound address, never the token.
Connect a chosen native Codex CLI with --remote and --remote-auth-token-env.
Stop this launcher with Ctrl-C or SIGTERM; no global mode helper is needed.
`

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'state-dir': { type: 'string' },
      port: { type: 'string', default: '0' },
      'ws-auth': { type: 'string' },
      'ws-token-file': { type: 'string' },
      'ws-token-sha256': { type: 'string' },
      'ws-allowed-origins': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    process.stdout.write(usage)
    return 0
  }
  if (!values['state-dir']?.trim())
    throw new Error('--state-dir is required; use a dedicated folder')
  const port = Number(values.port)
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535')
  }

  mkdirSync(values['state-dir'], { recursive: true, mode: 0o700 })
  const stateDir = realpathSync(values['state-dir'])
  const lockPath = join(stateDir, 'launcher.lock')
  const owner = `${JSON.stringify({ pid: process.pid, id: randomUUID() })}\n`
  try {
    writeFileSync(lockPath, owner, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new Error(
      `state directory is reserved: ${lockPath}. Use another --state-dir, or stop its launcher. ` +
        'After a crash, confirm both launcher and adapter have stopped before removing the lock.',
    )
  }

  try {
    const adapterHome = join(stateDir, 'adapter')
    const args = ['app-server', '--listen', `ws://127.0.0.1:${port}`]
    args.push(
      '--ws-auth',
      values['ws-auth'] ?? process.env.CLAUDE_CODEX_WS_AUTH ?? 'capability-token',
    )
    for (const option of ['ws-token-file', 'ws-token-sha256', 'ws-allowed-origins'] as const) {
      const value = values[option]
      if (value !== undefined) args.push(`--${option}`, value)
    }
    // A fresh child loads every adapter module with the isolated environment.
    // In particular, recovery and orphan reaping must never see another home.
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./adapter.mjs', import.meta.url)), ...args],
      {
        // A terminal Ctrl-C should reach the child only through our forwarder,
        // rather than also delivering a second signal to its process group.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          CODEX_HOME: join(stateDir, 'codex'),
          CLAUDE_CODEX_HOME: adapterHome,
          CLAUDE_CODEX_SOCKET_PATH: join(stateDir, 'control.sock'),
          CLAUDE_CODEX_DEBUG_LOG: join(adapterHome, 'debug.jsonl'),
          CLAUDE_CODEX_RUN_LOG: join(adapterHome, 'runs.jsonl'),
          // The legacy helper manages shared host processes, not this instance.
          CLAUDE_CODEX_HTTP_MANAGE_BRIDGE: '0',
        },
      },
    )
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal)
    }
    for (const signal of signals) process.on(signal, forward)
    process.stderr.write(
      `[claude-codex-isolated] state: ${stateDir}; launcher pid ${process.pid}, adapter pid ${child.pid ?? 'unavailable'}; stop with Ctrl-C\n`,
    )
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => resolve(code ?? 1))
      })
    } finally {
      for (const signal of signals) process.off(signal, forward)
    }
  } finally {
    // Never remove a replacement lock, even if an operator moved ours.
    try {
      if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[claude-codex-isolated] could not remove lock: ${lockPath}\n`)
      }
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(
      `[claude-codex-isolated] ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  },
)
