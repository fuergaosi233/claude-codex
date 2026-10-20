import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { platform } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { adapterHome, debugLog, ensureParent } from './util.mjs'

// Authentication for the TCP websocket listener (`--listen ws://`).
//
// The Codex App never uses it: it talks to the adapter over stdio, or over the
// unix socket behind `app-server proxy`, which the file system protects. The
// TCP listener is for other clients (`codex --remote`, scripts), and anything
// on the machine, including a web page the browser is showing, can open a
// connection to it. So:
//
// - an upgrade that carries an Origin header is refused unless the origin is
//   allowed, which keeps web pages (and DNS rebinding) out; app-server
//   clients outside a browser send no Origin;
// - with capability-token auth the upgrade needs the token, as
//   `Authorization: Bearer <token>` (what `codex --remote-auth-token-env`
//   sends) or, from a browser, the `claude-codex.bearer.<token>` subprotocol
//   next to `claude-codex.v1`;
// - a listener on an address other than loopback refuses to start without it,
//   unless the operator opts out explicitly (`--ws-allow-unauthenticated`).
//
// Tokens are compared as SHA-256 digests in constant time and never logged.

export const WS_PROTOCOL = 'claude-codex.v1'
export const WS_BEARER_PROTOCOL_PREFIX = 'claude-codex.bearer.'
const MIN_TOKEN_LENGTH = 16

export type WebSocketAuthMode = 'none' | 'capability-token'

export interface WebSocketAuthOptions {
  auth?: string | null
  tokenFile?: string | null
  tokenSha256?: string | null
  allowedOrigins?: string | null
  // Lets a listener on a non-loopback address start without auth.
  allowUnauthenticated?: boolean
}

export type UpgradeVerdict = { ok: true } | { ok: false; status: 401 | 403; reason: string }

export interface WebSocketAuth {
  readonly mode: WebSocketAuthMode
  // Where the token comes from, for the startup line. Never the token itself.
  readonly source: string | null
  readonly allowedOrigins: ReadonlySet<string>
  verify(req: IncomingMessage): UpgradeVerdict
}

export function resolveWebSocketAuth(
  host: string,
  port: number,
  options: WebSocketAuthOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): WebSocketAuth {
  const allowedOrigins = parseAllowedOrigins(
    options.allowedOrigins ?? env.CLAUDE_CODEX_WS_ALLOWED_ORIGINS ?? '',
  )
  const requested = options.auth ?? (env.CLAUDE_CODEX_WS_AUTH || null)
  if (requested !== null && requested !== 'none' && requested !== 'capability-token') {
    throw new Error(`unsupported websocket auth mode: ${requested} (use capability-token or none)`)
  }
  const envToken = env.CLAUDE_CODEX_WS_TOKEN || null
  const tokenFile = options.tokenFile ?? (env.CLAUDE_CODEX_WS_TOKEN_FILE || null)
  const tokenSha256 = options.tokenSha256 ?? (env.CLAUDE_CODEX_WS_TOKEN_SHA256 || null)
  const sources = [envToken, tokenFile, tokenSha256].filter((value) => value !== null)
  if (sources.length > 1) {
    throw new Error(
      'set only one of CLAUDE_CODEX_WS_TOKEN, --ws-token-file (CLAUDE_CODEX_WS_TOKEN_FILE) and --ws-token-sha256 (CLAUDE_CODEX_WS_TOKEN_SHA256)',
    )
  }
  const mode: WebSocketAuthMode =
    (requested as WebSocketAuthMode | null) ?? (sources.length > 0 ? 'capability-token' : 'none')
  if (mode === 'none' && sources.length > 0) {
    throw new Error('a websocket token is configured but websocket auth is set to none')
  }
  const allowUnauthenticated =
    options.allowUnauthenticated === true || env.CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED === '1'
  if (mode === 'none') {
    if (!isLoopbackHost(host) && !allowUnauthenticated) {
      throw new Error(
        `refusing to start non-loopback websocket listener ws://${host}:${port} without auth. ` +
          'Pass --ws-auth capability-token (CLAUDE_CODEX_WS_AUTH=capability-token) to require a token, ' +
          'or --ws-allow-unauthenticated (CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED=1) to accept ' +
          'any client that can reach this address.',
      )
    }
    return makeAuth('none', null, null, allowedOrigins)
  }
  if (allowUnauthenticated) {
    throw new Error(
      '--ws-allow-unauthenticated (CLAUDE_CODEX_WS_ALLOW_UNAUTHENTICATED) cannot be combined with websocket token auth',
    )
  }

  let digest: Buffer
  let source: string
  if (envToken !== null) {
    digest = tokenDigest(checkedToken(envToken, 'CLAUDE_CODEX_WS_TOKEN'))
    source = 'CLAUDE_CODEX_WS_TOKEN'
  } else if (tokenSha256 !== null) {
    if (!/^[0-9a-f]{64}$/i.test(tokenSha256)) {
      throw new Error('--ws-token-sha256 must be 64 hex characters')
    }
    digest = Buffer.from(tokenSha256, 'hex')
    source = 'a SHA-256 digest'
  } else {
    const path = tokenFile ?? defaultTokenFile()
    if (!isAbsolute(path)) throw new Error(`--ws-token-file must be an absolute path: ${path}`)
    const created = tokenFile === null && ensureTokenFile(path)
    digest = tokenDigest(readTokenFile(path))
    source = created ? `${path} (created)` : path
  }
  return makeAuth('capability-token', digest, source, allowedOrigins)
}

// The startup line about a listener's auth: where its token comes from, or a
// warning when an opted-out listener off loopback takes any client. Never the
// token itself.
export function authNotice(auth: WebSocketAuth, host: string, address: string): string | null {
  if (auth.mode === 'capability-token') {
    return `websocket clients need the capability token from ${auth.source}`
  }
  if (isLoopbackHost(host)) return null
  return `warning: ${address} accepts clients without a token; anyone who can reach it can run the agent as this user`
}

export function defaultTokenFile(): string {
  return join(adapterHome(), 'ws-token')
}

// Creates the token file with a random token unless it exists. Returns whether
// it was created.
export function ensureTokenFile(path: string): boolean {
  ensureParent(path)
  try {
    writeFileSync(path, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  // The umask can only take bits away; this keeps the mode exact anyway.
  chmodSync(path, 0o600)
  return true
}

function readTokenFile(path: string): string {
  if (platform() !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`websocket token file ${path} is readable by other users; chmod 600 it`)
  }
  return checkedToken(readFileSync(path, 'utf8').trim(), path)
}

function checkedToken(token: string, label: string): string {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`websocket token from ${label} is shorter than ${MIN_TOKEN_LENGTH} characters`)
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`websocket token from ${label} must be printable ASCII without spaces`)
  }
  return token
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

function makeAuth(
  mode: WebSocketAuthMode,
  digest: Buffer | null,
  source: string | null,
  allowedOrigins: ReadonlySet<string>,
): WebSocketAuth {
  return {
    mode,
    source,
    allowedOrigins,
    verify(req) {
      const origin = req.headers.origin
      if (origin !== undefined && !allowedOrigins.has(normalizeOrigin(origin) ?? '')) {
        return { ok: false, status: 403, reason: 'origin not allowed' }
      }
      if (digest === null) return { ok: true }
      const token = presentedToken(req)
      if (token === null) return { ok: false, status: 401, reason: 'missing token' }
      if (!timingSafeEqual(tokenDigest(token), digest)) {
        return { ok: false, status: 401, reason: 'invalid token' }
      }
      return { ok: true }
    },
  }
}

function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
    if (match?.[1]) return match[1]
  }
  for (const protocol of offeredProtocols(req)) {
    if (protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX)) {
      const token = protocol.slice(WS_BEARER_PROTOCOL_PREFIX.length)
      if (token.length > 0) return token
    }
  }
  return null
}

function offeredProtocols(req: IncomingMessage): string[] {
  const header = req.headers['sec-websocket-protocol']
  if (typeof header !== 'string') return []
  return header
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

// ws `handleProtocols`: prefers claude-codex.v1, otherwise keeps the ws default
// (the first one offered), and never selects, so never echoes, a token.
export function selectProtocol(protocols: Set<string>): string | false {
  if (protocols.has(WS_PROTOCOL)) return WS_PROTOCOL
  for (const protocol of protocols) {
    if (!protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX)) return protocol
  }
  return false
}

export function rejectUpgrade(
  socket: Duplex,
  req: IncomingMessage,
  verdict: { status: 401 | 403; reason: string },
): void {
  debugLog('ws.upgrade.rejected', {
    status: verdict.status,
    reason: verdict.reason,
    remoteAddress: req.socket.remoteAddress ?? null,
  })
  const title = verdict.status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = `${verdict.reason}\n`
  const lines = [
    `HTTP/1.1 ${verdict.status} ${title}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
  ]
  if (verdict.status === 401) lines.push('WWW-Authenticate: Bearer')
  // Node hands over an upgrade socket without its own error listener, and ws
  // adds one only in handleUpgrade, which a refused request never reaches. A
  // client resetting the connection mid-reply would otherwise end the adapter.
  socket.on('error', () => socket.destroy())
  socket.once('finish', () => socket.destroy())
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`)
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare.toLowerCase() === 'localhost') return true
  const family = isIP(bare)
  if (family === 4) return bare.startsWith('127.')
  if (family === 6) {
    const lower = bare.toLowerCase()
    // IPv4-mapped 127/8, as written or as URL normalizes it (::ffff:7f00:1).
    return (
      lower === '::1' || lower.startsWith('::ffff:127.') || /^::ffff:7f[0-9a-f]{2}:/.test(lower)
    )
  }
  return false
}

function parseAllowedOrigins(value: string): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const entry of value.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const origin = normalizeOrigin(trimmed)
    if (origin === null) throw new Error(`invalid websocket allowed origin: ${trimmed}`)
    origins.add(origin)
  }
  return origins
}

function normalizeOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}
