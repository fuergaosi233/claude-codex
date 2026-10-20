import { existsSync, lstatSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import readline from 'node:readline'
import { WebSocket, WebSocketServer } from 'ws'
import type { RpcPeer, WireMessage } from './types.mjs'
import { defaultSocketPath, ensureParent, newId, sleep } from './util.mjs'
import {
  authNotice,
  rejectUpgrade,
  resolveWebSocketAuth,
  selectProtocol,
  type WebSocketAuth,
  type WebSocketAuthOptions,
} from './ws-auth.mjs'

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

export interface WebSocketTransportOptions {
  // Applies to ws:// listeners; a unix socket is protected by its directory.
  // Resolved from the environment when absent.
  auth?: WebSocketAuth
}

export interface RunningWebSocketTransport extends RunningTransport {
  // ws://host:port with the bound port, or the socket path.
  readonly address: string
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
  options: WebSocketTransportOptions = {},
): Promise<RunningWebSocketTransport> {
  const parsed = parseListenUrl(listenUrl)
  // Resolved before binding, so a listener that would be unprotected never
  // opens its port.
  const auth =
    parsed.kind === 'ws' ? (options.auth ?? resolveWebSocketAuth(parsed.host, parsed.port)) : null
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectProtocol })
  server.on('upgrade', (req, socket, head) => {
    const verdict = auth ? auth.verify(req) : null
    if (verdict && !verdict.ok) {
      rejectUpgrade(socket, req, verdict)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

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
      server.listen(parsed.port, unbracketHost(parsed.host))
    }
  })

  // The socket this listener bound, by inode: another process may bind the
  // same path later, and that socket is not ours to remove.
  const socketPath = parsed.kind === 'unix' ? parsed.path : null
  const ownSocket = socketPath ? fileId(socketPath) : null
  let address: string
  if (parsed.kind === 'unix') {
    address = parsed.path
  } else {
    const bound = server.address()
    const port = bound && typeof bound === 'object' ? bound.port : parsed.port
    address = `ws://${parsed.host}:${port}`
    const notice = auth ? authNotice(auth, parsed.host, address) : null
    if (notice) process.stderr.write(`[claude-codex-adapter] ${notice}\n`)
  }
  process.stderr.write(`[claude-codex-adapter] listening on ${address}\n`)

  return {
    address,
    async close() {
      // Both servers wait for their connections to end before they close.
      for (const client of wss.clients) client.terminate()
      const current = socketPath ? fileId(socketPath) : null
      if (current && current !== ownSocket) {
        // Closing a unix listener unlinks its path, whatever is there now. The
        // path holds another socket, so this one stays open, unreachable, until
        // the process exits.
        wss.close()
        server.unref()
        return
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
      })
      // Closing unlinked our socket; in case it did not.
      if (socketPath && fileId(socketPath) === ownSocket) rmSync(socketPath, { force: true })
    },
  }
}

// A file's device and inode, or null when nothing is at the path.
function fileId(path: string): string | null {
  try {
    const stat = lstatSync(path)
    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
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

// Resolves the auth of a ws:// listener (creating the token file when needed)
// and throws when the listener would be unprotected; null for other URLs.
export function prepareWebSocketAuth(
  listenUrl: string,
  options: WebSocketAuthOptions,
): WebSocketAuth | null {
  if (!listenUrl.startsWith('ws://')) return null
  const parsed = parseListenUrl(listenUrl)
  return parsed.kind === 'ws' ? resolveWebSocketAuth(parsed.host, parsed.port, options) : null
}

// URL keeps IPv6 hosts in brackets; listen() wants the bare address.
function unbracketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}
