import { existsSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import readline from 'node:readline'
import { WebSocket, WebSocketServer } from 'ws'
import type { RpcPeer, WireMessage } from './types.mjs'
import { defaultSocketPath, ensureParent, newId, sleep } from './util.mjs'

export type MessageHandler = (peer: RpcPeer, message: WireMessage) => void | Promise<void>
export type CloseHandler = (peer: RpcPeer) => void

class StdioPeer implements RpcPeer {
  readonly id = 'stdio'

  send(message: WireMessage): void {
    // process.stdout.write can throw a synchronous EPIPE if the consumer
    // (App's SSH stream) has closed mid-stream. Without the guard a single
    // peer disconnect during a Claude text stream would kill the entire
    // adapter — which is exactly the pid-churn pattern we saw in debug.
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'EPIPE' && code !== 'ECONNRESET' && code !== 'EBADF') throw error
    }
  }

  close(): void {
    process.exit(0)
  }
}

class WebSocketPeer implements RpcPeer {
  readonly id = newId()
  private readonly ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  send(message: WireMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(message))
    } catch (error) {
      // ws.send may still throw if the socket transitioned between the
      // readyState check and the send (typical when a peer drops). Drop the
      // message rather than crashing the daemon for other peers.
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'EPIPE' && code !== 'ECONNRESET' && code !== 'EBADF') throw error
    }
  }

  close(): void {
    this.ws.close()
  }
}

export interface RunningTransport {
  close(): Promise<void>
}

export function startStdioTransport(
  onMessage: MessageHandler,
  onClose: CloseHandler,
): RunningTransport {
  const peer = new StdioPeer()
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      void onMessage(peer, JSON.parse(trimmed) as WireMessage)
    } catch (error) {
      peer.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' },
      })
    }
  })
  rl.on('close', () => onClose(peer))
  return {
    async close() {
      rl.close()
    },
  }
}

export async function startWebSocketTransport(
  listenUrl: string,
  onMessage: MessageHandler,
  onClose: CloseHandler,
  onConnect?: CloseHandler,
): Promise<RunningTransport> {
  const parsed = parseListenUrl(listenUrl)
  const server = http.createServer()
  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    const peer = new WebSocketPeer(ws)
    onConnect?.(peer)
    ws.on('message', (data) => {
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
        void onMessage(peer, JSON.parse(text) as WireMessage)
      } catch (error) {
        peer.send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: error instanceof Error ? error.message : 'Parse error' },
        })
      }
    })
    ws.on('close', () => onClose(peer))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', resolve)
    if (parsed.kind === 'unix') {
      ensureParent(parsed.path)
      if (existsSync(parsed.path)) rmSync(parsed.path, { force: true })
      server.listen(parsed.path)
    } else {
      server.listen(parsed.port, parsed.host)
    }
  })

  if (parsed.kind === 'unix') {
    process.stderr.write(`[claude-codex-adapter] listening on ${parsed.path}\n`)
  } else {
    process.stderr.write(`[claude-codex-adapter] listening on ws://${parsed.host}:${parsed.port}\n`)
  }

  return {
    async close() {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve())
        })
      })
      if (parsed.kind === 'unix' && existsSync(parsed.path)) {
        rmSync(parsed.path, { force: true })
      }
    },
  }
}

export async function runProxy(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  let lastError: unknown = null
  while (Date.now() - started < timeoutMs) {
    try {
      const socket = await connectUnix(socketPath)
      await new Promise<void>((resolve) => {
        process.stdin.pipe(socket)
        socket.pipe(process.stdout)
        // `.pipe()` propagates errors as unhandled events. process.stdout
        // throws EPIPE when the App's SSH channel closes mid-stream; without
        // these handlers that error tears down the proxy process and the
        // daemon's only client. Swallow expected disconnect codes, log
        // anything else, and let `socket.on('close')` handle the lifecycle.
        const swallow = (label: string) => (error: NodeJS.ErrnoException) => {
          if (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'EBADF')
            return
          process.stderr.write(`[claude-codex-adapter] proxy ${label} error: ${error.message}\n`)
        }
        process.stdin.on('error', swallow('stdin'))
        process.stdout.on('error', swallow('stdout'))
        socket.on('close', () => resolve())
        socket.on('error', (error) => {
          process.stderr.write(`[claude-codex-adapter] proxy socket error: ${error.message}\n`)
          resolve()
        })
      })
      return
    } catch (error) {
      lastError = error
      await sleep(100)
    }
  }
  throw new Error(
    `failed to connect to app-server control socket at ${socketPath}: ${String(lastError)}`,
  )
}

function connectUnix(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

export function normalizeListenUrl(value: string | null | undefined): string {
  return value && value.length > 0 ? value : 'stdio://'
}

export function parseProxySockArg(args: string[]): string {
  const index = args.indexOf('--sock')
  const next = args[index + 1]
  if (index >= 0 && next) return next
  return defaultSocketPath()
}

function parseListenUrl(
  listenUrl: string,
): { kind: 'unix'; path: string } | { kind: 'ws'; host: string; port: number } {
  if (listenUrl === 'unix://') return { kind: 'unix', path: defaultSocketPath() }
  if (listenUrl.startsWith('unix://')) {
    const path = listenUrl.slice('unix://'.length)
    return { kind: 'unix', path: path.length > 0 ? path : defaultSocketPath() }
  }
  if (listenUrl.startsWith('ws://')) {
    const url = new URL(listenUrl)
    return {
      kind: 'ws',
      host: url.hostname || '127.0.0.1',
      port: Number(url.port || 8788),
    }
  }
  throw new Error(`unsupported listen URL: ${listenUrl}`)
}
