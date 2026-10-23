// An adapter server in the test process, driven like the App drives it:
// requests in, notifications and server requests out to one peer.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexClaudeAppServer, type ServerOptions } from '../../src/server.mjs'
import { SessionStore } from '../../src/store.mjs'
import type {
  ClaudeRuntime,
  RpcPeer,
  RuntimeBackgroundListener,
  RuntimeHandlers,
  RuntimeTurnContext,
  WireMessage,
} from '../../src/types.mjs'

// A runtime that plays `script` for every turn and keeps the server's
// background listener.
export type ScriptedRuntime = ClaudeRuntime & { listener: RuntimeBackgroundListener | null }

export function scriptedRuntime(
  script: (context: RuntimeTurnContext, handlers: RuntimeHandlers) => Promise<void>,
  extra: Partial<ClaudeRuntime> = {},
): ScriptedRuntime {
  const runtime: ScriptedRuntime = {
    listener: null,
    runTurn: script,
    steer: async () => false,
    interrupt: async () => {},
    stop: async () => {},
    setBackgroundListener: (listener) => {
      runtime.listener = listener
    },
    ...extra,
  }
  return runtime
}

export interface RpcReply {
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

export interface InProcessApp {
  server: CodexClaudeAppServer
  store: SessionStore
  home: string
  messages: any[]
  // The reply as it went out, error or not.
  call(method: string, params: Record<string, unknown>): Promise<RpcReply>
  // The result; an error reply throws.
  request(method: string, params: Record<string, unknown>): Promise<any>
  respond(id: unknown, result: unknown): Promise<void>
  notified(method: string): any[]
  waitFor<T>(find: () => T | undefined, timeoutMs?: number): Promise<T>
  startThread(params?: Record<string, unknown>): Promise<string>
  startTurn(threadId: string, text: string, extra?: Record<string, unknown>): Promise<string>
  // The turn of its turn/completed, once it comes.
  turnCompleted(turnId: string): Promise<any>
}

const SAVED_ENV = [
  'CLAUDE_CODEX_HOME',
  'CODEX_HOME',
  'CLAUDE_CODEX_DEBUG_LOG',
  'CLAUDE_CODEX_MOCK',
  'CLAUDE_CODEX_NOTICE_ROWS',
  'CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS',
  'CLAUDE_CODEX_PREVENT_IDLE_SLEEP',
  'CLAUDE_CODEX_MODELS',
  'CLAUDE_CODEX_DISABLE_CODEX_PROXY',
] as const

export interface InProcessOptions {
  env?: Record<string, string>
  // A sleep monitor that never sees sleep unless the test gives its own.
  server?: ServerOptions
}

export async function withInProcessApp(
  runtime: ClaudeRuntime,
  body: (app: InProcessApp) => Promise<void>,
  options: InProcessOptions = {},
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const saved = SAVED_ENV.map((key) => [key, process.env[key]] as const)
  for (const key of SAVED_ENV) delete process.env[key]
  Object.assign(process.env, {
    CLAUDE_CODEX_HOME: home,
    CODEX_HOME: home,
    CLAUDE_CODEX_DEBUG_LOG: join(home, 'debug.jsonl'),
    CLAUDE_CODEX_MOCK: '1',
    ...options.env,
  })
  const store = new SessionStore(join(home, 'state.sqlite'))
  const server = new CodexClaudeAppServer(store, runtime, {
    sleepMonitor: { suspendedMs: () => 0, sleptSince: () => 0 },
    ...options.server,
  })
  const messages: any[] = []
  const peer: RpcPeer = {
    id: 'app',
    send: (message: WireMessage) => messages.push(structuredClone(message)),
    close: () => {},
  }
  let nextId = 1
  const waitFor = async <T,>(find: () => T | undefined, timeoutMs = 5_000): Promise<T> => {
    for (let waited = 0; ; waited += 10) {
      const found = find()
      if (found !== undefined) return found
      if (waited >= timeoutMs) {
        throw new Error(`timed out; saw ${messages.map((message) => message.method).join(',')}`)
      }
      await delay(10)
    }
  }
  const call = async (method: string, params: Record<string, unknown>): Promise<RpcReply> => {
    const id = `app-${nextId++}`
    await server.handle(peer, { jsonrpc: '2.0', id, method, params } as WireMessage)
    return waitFor(() =>
      messages.find((message) => message.id === id && message.method === undefined),
    )
  }
  const request = async (method: string, params: Record<string, unknown>): Promise<any> => {
    const reply = await call(method, params)
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
    return reply.result
  }
  try {
    await body({
      server,
      store,
      home,
      messages,
      call,
      request,
      respond: (id, result) =>
        server.handle(peer, { jsonrpc: '2.0', id, result } as unknown as WireMessage),
      notified: (method) =>
        messages.filter((message) => message.method === method).map((message) => message.params),
      waitFor,
      startThread: async (params = {}) =>
        (
          await request('thread/start', {
            cwd: process.cwd(),
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            ...params,
          })
        ).thread.id,
      startTurn: async (threadId, text, extra = {}) =>
        (
          await request('turn/start', {
            threadId,
            input: [{ type: 'text', text, text_elements: [] }],
            ...extra,
          })
        ).turn.id,
      turnCompleted: (turnId) =>
        waitFor(
          () =>
            messages.find(
              (message) => message.method === 'turn/completed' && message.params.turn.id === turnId,
            )?.params.turn,
        ),
    })
  } finally {
    await server.stop()
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}
