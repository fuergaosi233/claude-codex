#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SessionStore } from './store.mjs'
import { CodexClaudeAppServer } from './server.mjs'
import { createRuntime } from './runtime-factory.mjs'
import {
  normalizeListenUrl,
  parseProxySockArg,
  runProxy,
  startStdioTransport,
  startWebSocketTransport,
} from './transports.mjs'
import type { RpcPeer } from './types.mjs'
import { defaultSocketPath, ensureParent } from './util.mjs'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] !== 'app-server') {
    usage(1)
    return
  }

  const proxyIndex = args.indexOf('proxy')
  if (proxyIndex >= 0) {
    await runProxy(parseProxySockArg(args.slice(proxyIndex + 1)))
    return
  }

  if (args.includes('--help') || args.includes('-h')) {
    usage(0)
    return
  }

  const listen = getArg(args, '--listen') ?? 'stdio://'
  if (listen === 'off') return
  const isUnixDaemon = listen.startsWith('unix://')
  let pidFile: string | null = null
  if (isUnixDaemon) {
    pidFile = ensureSingleUnixDaemon(listen)
  }

  const store = new SessionStore()
  if (isUnixDaemon) {
    const recovered = store.recoverStaleInProgressTurns()
    if (recovered > 0) {
      process.stderr.write(`[claude-codex-adapter] recovered ${recovered} stale in-progress turn(s)\n`)
    }
  }
  const runtime = createRuntime()
  const server = new CodexClaudeAppServer(store, runtime)
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await server.stop()
    if (pidFile) {
      try {
        unlinkSync(pidFile)
      } catch {}
    }
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  const onMessage = server.handle.bind(server)

  // When the Codex client (app-server proxy) disconnects, a `unix://` daemon
  // would otherwise linger forever and keep its Claude runtime sidecar alive.
  // Exit once the last peer is gone so the runtime socket closes and the
  // sidecar is reclaimed. Codex App re-probes and restarts the daemon on
  // reconnect. Set CLAUDE_CODEX_IDLE_EXIT_MS=0 to keep the legacy persistent
  // behavior.
  const idleExitMs = Number(process.env.CLAUDE_CODEX_IDLE_EXIT_MS ?? 15000)
  const idleExitEnabled = isUnixDaemon && Number.isFinite(idleExitMs) && idleExitMs > 0
  let activePeers = 0
  let everConnected = false
  let idleTimer: NodeJS.Timeout | null = null
  const cancelIdleExit = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdleExit = () => {
    if (!idleExitEnabled || activePeers > 0 || !everConnected || idleTimer || server.hasActiveTurns()) return
    idleTimer = setTimeout(() => {
      process.stderr.write(`[claude-codex-adapter] no active peers for ${idleExitMs}ms, shutting down\n`)
      void shutdown()
    }, idleExitMs)
    idleTimer.unref()
  }
  server.setIdleCheckHandler(armIdleExit)
  const onConnect = (_peer: RpcPeer) => {
    everConnected = true
    activePeers += 1
    cancelIdleExit()
  }
  const onClose = (peer: RpcPeer) => {
    activePeers = Math.max(0, activePeers - 1)
    server.closePeer(peer)
    armIdleExit()
  }

  const normalized = normalizeListenUrl(listen)
  if (normalized === 'stdio://') {
    startStdioTransport(onMessage, onClose)
    return
  }
  await startWebSocketTransport(normalized, onMessage, onClose, onConnect)
}

function getArg(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1] ?? null
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

function ensureSingleUnixDaemon(listen: string): string {
  const socketPath = listen === 'unix://' ? defaultSocketPath() : listen.slice('unix://'.length)
  const pidFile = `${socketPath}.pid`
  ensureParent(socketPath)
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (Number.isFinite(pid) && processIsAlive(pid)) {
      process.stderr.write(`[claude-codex-adapter] app-server already running at ${socketPath} (pid ${pid})\n`)
      process.exit(0)
    }
  }
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {}
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
  try {
    chmodSync(dirname(socketPath), 0o700)
  } catch {}
  return pidFile
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function usage(code: number): never {
  const text = `Usage:
  claude-codex-adapter app-server --listen stdio://
  claude-codex-adapter app-server --listen unix://
  claude-codex-adapter app-server --listen ws://127.0.0.1:8788
  claude-codex-adapter app-server proxy [--sock PATH]
`
  ;(code === 0 ? process.stdout : process.stderr).write(text)
  process.exit(code)
}

main().catch((error) => {
  process.stderr.write(`[claude-codex-adapter] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
