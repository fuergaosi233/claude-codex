import { CodexAppServerChild } from './codex-app-server-child.mjs'
import {
  AG_MODEL_PREFIX,
  bareCodexModel,
  codexProviderForModel,
  isAgModel,
} from './harness-models.mjs'
import { RpcError, SERVER_ERROR } from './host-methods.mjs'
import type { SessionStore } from './store.mjs'
import type { RpcPeer, ThreadRecord } from './types.mjs'
import { debugLog } from './util.mjs'

// Codex threads on the native harness: the adapter keeps the thread's sidebar
// record (name, project, section, archive, preview), a real `codex
// app-server` child keeps the conversation and runs it. Every request about
// the conversation goes to the child as the App sent it, and what the child
// says comes back as Codex said it: approvals, diffs, plan mode, MCP, images,
// compaction, steer, rollback and fork behave as in Codex itself.
//
// The App knows a thread by the adapter's id. The child's thread is made on
// the first turn (a new chat's thread exists before the user picks its model,
// and may still move to another harness), so its id differs: ids are mapped
// both ways. A model id `codex-ag:<model>` runs on the AsterGate provider and
// is `<model>` to the child.

export const NOT_ROUTED = Symbol('notRouted')

export interface CodexBridgeHost {
  readonly store: SessionStore
  readonly detachedPeer: RpcPeer
  subscribe(threadId: string, peer: RpcPeer): void
  notifyThread(threadId: string, notification: { method: string; params: unknown }): void
  notifyAll(notification: { method: string; params: unknown }): void
  sendServerRequest(peer: RpcPeer, method: string, id: string, params: unknown): Promise<unknown>
  dropServerRequest(id: string): void
  // Validates and applies a model change the way the model menu would, and
  // saves the thread; throws the menu's refusal.
  applyModel(thread: ThreadRecord, params: Record<string, unknown>): void
  clientInfo(): Record<string, unknown>
  configOverrides(): readonly string[]
  checkIdle(): void
}

// Requests about a thread's conversation, answered by the child.
const FORWARDED = new Set([
  'thread/resume',
  'thread/read',
  'thread/turns/list',
  'thread/turns/items/list',
  'thread/items/list',
  'thread/timeline/list',
  'thread/searchOccurrences',
  'thread/settings/update',
  'thread/compact/start',
  'thread/shellCommand',
  'thread/rollback',
  'thread/revert',
  'thread/inject_items',
  'thread/backgroundTerminals/clean',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'thread/goal/set',
  'thread/goal/get',
  'thread/goal/clear',
  'thread/memoryMode/set',
  'thread/approveGuardianDeniedAction',
  'thread/increment_elicitation',
  'thread/decrement_elicitation',
  'thread/fork',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'turn/settings/update',
  'review/start',
])

// The adapter answers these from its own record; the child hears them too so
// its rollout stays in step.
const MIRRORED = new Set(['thread/name/set', 'thread/archive', 'thread/unarchive'])

// About the child process itself, not about a thread the App shows.
const DROPPED_NOTIFICATIONS = [
  'account/',
  'mcpServer/startupStatus/updated',
  'skills/changed',
  'fs/changed',
  'app/list/updated',
  'remoteControl/',
  'configWarning',
  'windowsSandbox/',
]

interface ActiveTurn {
  turnId: string
  provider: string
}

export class CodexNativeBridge {
  private readonly host: CodexBridgeHost
  private readonly children = new Map<string, CodexAppServerChild>()
  // Child thread id -> adapter thread id, where they differ.
  private readonly adapterIdByChild = new Map<string, string>()
  // provider -> child generation -> threads loaded in that child.
  private readonly loaded = new Map<string, { generation: number; ids: Set<string> }>()
  // Threads the child made for the adapter; their thread/started is the
  // adapter's to announce.
  private readonly ownStarts = new Set<string>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly pendingRequests = new Set<string>()
  private idleTimer: NodeJS.Timeout | null = null

  constructor(host: CodexBridgeHost) {
    this.host = host
  }

  busy(): boolean {
    return this.activeTurns.size > 0 || this.pendingRequests.size > 0
  }

  stop(): void {
    this.clearIdleTimer()
    for (const child of this.children.values()) child.stop()
    this.children.clear()
  }

  // The thread's record when the native harness runs it.
  owned(threadId: string): ThreadRecord | null {
    if (!threadId) return null
    const thread = this.host.store.getThread(threadId)
    return thread?.runtimeBackend === 'codex' ? thread : null
  }

  async route(peer: RpcPeer, method: string, rawParams: unknown): Promise<unknown> {
    if (!FORWARDED.has(method) && !MIRRORED.has(method) && method !== 'thread/delete')
      return NOT_ROUTED
    const params = asRecord(rawParams)
    const threadId = typeof params.threadId === 'string' ? params.threadId : ''
    // The model menu may move a new chat between harnesses before its first
    // message, so a model change is applied first, whichever harness has it.
    if ((method === 'thread/settings/update' || method === 'turn/start') && hasModel(params)) {
      const any = threadId ? this.host.store.getThread(threadId) : null
      if (any && (any.runtimeBackend === 'codex' || modelIsCodex(params)))
        this.host.applyModel(any, params)
    }
    const thread = this.owned(threadId)
    if (!thread) return NOT_ROUTED
    if (MIRRORED.has(method) || method === 'thread/delete') {
      if (thread.codexSessionId) void this.forwardQuietly(thread, method, params)
      return NOT_ROUTED
    }
    // A model change is the model menu's: the adapter checks it against the
    // thread's harness first.
    if (!thread.codexSessionId) {
      // Nothing in Codex yet: only a turn makes the conversation.
      if (method !== 'turn/start') return NOT_ROUTED
      await this.createChildThread(thread)
    }
    this.host.subscribe(thread.id, peer)
    this.clearIdleTimer()
    try {
      return await this.forward(thread, method, params)
    } finally {
      this.scheduleIdleStop()
    }
  }

  // Children with nothing to do for a while are stopped; the next request
  // starts them again and reloads its thread.
  private scheduleIdleStop(): void {
    this.clearIdleTimer()
    const ms = Number(process.env.CLAUDE_CODEX_NATIVE_IDLE_MS ?? 600_000)
    if (!(ms > 0)) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.busy()) return this.scheduleIdleStop()
      for (const child of this.children.values()) child.stop()
      debugLog('codexBridge.idleStop', {})
    }, ms)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private async forward(
    thread: ThreadRecord,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const provider = codexProviderForModel(thread.model)
    const child = this.child(provider)
    const childId = thread.codexSessionId as string
    if (method !== 'thread/resume') await this.ensureLoaded(child, thread)
    if (method === 'turn/start' && !thread.preview) this.rememberPreview(thread, params)
    const outgoing = this.inbound(params, thread.id, childId)
    let result: unknown
    try {
      result = await child.request(method, outgoing)
    } catch (error) {
      throw error instanceof RpcError ? error : new RpcError(String(error))
    }
    if (method === 'thread/resume') this.markLoaded(child, childId)
    if (method === 'thread/fork') return this.adoptFork(thread, result, params, child)
    if (method === 'turn/start') {
      const turnId = stringField(asRecord(asRecord(result).turn).id)
      if (turnId) this.activeTurns.set(thread.id, { turnId, provider })
    }
    return this.outbound(result, provider)
  }

  private async forwardQuietly(
    thread: ThreadRecord,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const child = this.child(codexProviderForModel(thread.model))
      await this.ensureLoaded(child, thread)
      await child.request(method, this.inbound(params, thread.id, thread.codexSessionId as string))
    } catch (error) {
      debugLog('codexBridge.mirror_failed', { method, threadId: thread.id, error: String(error) })
    }
  }

  private async createChildThread(thread: ThreadRecord): Promise<void> {
    const provider = codexProviderForModel(thread.model)
    const child = this.child(provider)
    const result = asRecord(
      await child.request('thread/start', {
        model: bareCodexModel(thread.model),
        modelProvider: provider,
        cwd: thread.cwd,
        approvalPolicy: thread.approvalPolicy,
        sandbox: thread.sandboxMode,
        ...(thread.baseInstructions ? { baseInstructions: thread.baseInstructions } : {}),
        ...(thread.developerInstructions
          ? { developerInstructions: thread.developerInstructions }
          : {}),
        ...(thread.personality ? { personality: thread.personality } : {}),
        ...(thread.ephemeral ? { ephemeral: true } : {}),
      }),
    )
    const childId = stringField(asRecord(result.thread).id)
    if (!childId) throw new RpcError('codex app-server started no thread')
    this.ownStarts.add(childId)
    if (childId !== thread.id) this.adapterIdByChild.set(childId, thread.id)
    thread.codexSessionId = childId
    this.host.store.upsertThread(thread)
    this.markLoaded(child, childId)
    debugLog('codexBridge.thread', { threadId: thread.id, childId, provider })
  }

  // The child's fork is a thread of its own; the adapter files it like the
  // parent so the sidebar lists it.
  private adoptFork(
    parent: ThreadRecord,
    result: unknown,
    params: Record<string, unknown>,
    child: CodexAppServerChild,
  ): unknown {
    const record = asRecord(result)
    const forkId = stringField(asRecord(record.thread).id)
    if (forkId && !this.host.store.getThread(forkId)) {
      this.ownStarts.add(forkId)
      const model = typeof params.model === 'string' && params.model ? params.model : parent.model
      this.host.store.upsertThread({
        ...parent,
        id: forkId,
        sessionId: forkId,
        forkedFromId: parent.id,
        isPinned: false,
        sectionId: null,
        sectionEnteredAt: null,
        sectionPosition: null,
        name: null,
        model: isAgModel(parent.model) && !isAgModel(model) ? `${AG_MODEL_PREFIX}${model}` : model,
        ephemeral: params.ephemeral === true,
        codexSessionId: forkId,
        claudeSessionId: null,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
        status: { type: 'idle' },
      })
      this.markLoaded(child, forkId)
    }
    return this.outbound(result, child.provider)
  }

  private async ensureLoaded(child: CodexAppServerChild, thread: ThreadRecord): Promise<void> {
    const childId = thread.codexSessionId as string
    const entry = this.loaded.get(child.provider)
    if (child.running && entry?.generation === child.generation && entry.ids.has(childId)) return
    await child.request('thread/resume', {
      threadId: childId,
      excludeTurns: true,
      modelProvider: child.provider,
    })
    this.markLoaded(child, childId)
  }

  private markLoaded(child: CodexAppServerChild, childId: string): void {
    let entry = this.loaded.get(child.provider)
    if (!entry || entry.generation !== child.generation) {
      entry = { generation: child.generation, ids: new Set() }
      this.loaded.set(child.provider, entry)
    }
    entry.ids.add(childId)
  }

  private rememberPreview(thread: ThreadRecord, params: Record<string, unknown>): void {
    const input = Array.isArray(params.input) ? params.input : []
    const text = input
      .map((part) => asRecord(part))
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join(' ')
      .trim()
    if (!text) return
    thread.preview = text.slice(0, 200)
    this.host.store.upsertThread(thread)
  }

  private child(provider: string): CodexAppServerChild {
    let child = this.children.get(provider)
    if (!child) {
      child = new CodexAppServerChild(
        provider,
        {
          notification: (from, method, params) => this.onNotification(from, method, params),
          serverRequest: (from, id, method, params) =>
            this.onServerRequest(from, id, method, params),
          exited: (from, generation, reason) => this.onExit(from, generation, reason),
        },
        {
          clientInfo: () => this.host.clientInfo(),
          configOverrides: () => this.host.configOverrides(),
        },
      )
      this.children.set(provider, child)
    }
    return child
  }

  private adapterId(childId: string): string {
    return this.adapterIdByChild.get(childId) ?? childId
  }

  // Adapter ids -> child ids, and the harness prefix off model ids.
  private inbound(params: Record<string, unknown>, adapterId: string, childId: string): unknown {
    return rewrite(params, (value, key) => {
      if (value === adapterId) return childId
      if ((key === 'model' || key === 'toModel') && isAgModel(value)) return bareCodexModel(value)
      return value
    })
  }

  // Child ids -> adapter ids, and the harness prefix back on model ids of
  // AsterGate threads. The App files every thread under the adapter's
  // provider, so its composer predictions never fork one.
  // App rule: prediction-provider
  private outbound(payload: unknown, provider: string): unknown {
    const ag = provider !== 'openai'
    return rewrite(payload, (value, key) => {
      const mapped = this.adapterIdByChild.get(value)
      if (mapped) return mapped
      if (key === 'modelProvider' || key === 'model_provider') return 'claude-code'
      if (
        ag &&
        (key === 'model' || key === 'fromModel' || key === 'toModel') &&
        value &&
        !isAgModel(value)
      )
        return `${AG_MODEL_PREFIX}${value}`
      return value
    })
  }

  private onNotification(provider: string, method: string, params: unknown): void {
    if (DROPPED_NOTIFICATIONS.some((prefix) => method.startsWith(prefix))) return
    const fields = asRecord(params)
    const childThreadId = stringField(fields.threadId) ?? stringField(asRecord(fields.thread).id)
    if (method === 'thread/started' && childThreadId && this.ownStarts.has(childThreadId)) return
    if (method === 'serverRequest/resolved') {
      const id = this.resolvedRequestId(provider, fields.requestId)
      if (!id) return
      this.pendingRequests.delete(id)
      this.host.dropServerRequest(id)
      const resolved = { ...asRecord(this.outbound(params, provider)), requestId: id }
      if (childThreadId)
        this.host.notifyThread(this.adapterId(childThreadId), { method, params: resolved })
      else this.host.notifyAll({ method, params: resolved })
      return
    }
    const threadId = childThreadId ? this.adapterId(childThreadId) : null
    const notification = { method, params: this.outbound(params, provider) }
    if (threadId) this.track(threadId, method, asRecord(notification.params))
    if (threadId && this.host.store.getThread(threadId))
      this.host.notifyThread(threadId, notification)
    else this.host.notifyAll(notification)
  }

  // The sidebar record follows the conversation.
  private track(threadId: string, method: string, params: Record<string, unknown>): void {
    const thread = this.host.store.getThread(threadId)
    if (!thread) return
    switch (method) {
      case 'turn/started': {
        const turnId = stringField(asRecord(params.turn).id)
        if (turnId)
          this.activeTurns.set(threadId, {
            turnId,
            provider: codexProviderForModel(thread.model),
          })
        thread.updatedAt = Math.floor(Date.now() / 1000)
        this.host.store.upsertThread(thread)
        return
      }
      case 'turn/completed': {
        this.activeTurns.delete(threadId)
        thread.updatedAt = Math.floor(Date.now() / 1000)
        thread.status = { type: 'idle' }
        this.host.store.upsertThread(thread)
        this.host.checkIdle()
        return
      }
      case 'thread/status/changed': {
        const status = asRecord(params.status)
        if (typeof status.type === 'string')
          this.host.store.updateThreadStatus(threadId, status as ThreadRecord['status'])
        return
      }
      case 'thread/name/updated': {
        const name = stringField(params.threadName) ?? stringField(params.name)
        if (name) {
          thread.name = name
          this.host.store.upsertThread(thread)
        }
        return
      }
    }
  }

  private onServerRequest(
    provider: string,
    childRequestId: string | number,
    method: string,
    params: unknown,
  ): void {
    const child = this.children.get(provider)
    if (!child) return
    const id = `cx:${provider}:${child.generation}:${childRequestId}`
    const outgoing = this.outbound(params, provider)
    const threadId = stringField(asRecord(outgoing).threadId)
    this.pendingRequests.add(id)
    this.host
      .sendServerRequest(this.host.detachedPeer, method, id, outgoing)
      .then((result) => {
        child.respond(childRequestId, this.childResult(result, threadId))
      })
      .catch((error: unknown) => {
        child.respond(childRequestId, undefined, {
          code: SERVER_ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.pendingRequests.delete(id)
        this.host.checkIdle()
      })
  }

  private childResult(result: unknown, threadId: string | null): unknown {
    const thread = threadId ? this.host.store.getThread(threadId) : null
    if (!thread?.codexSessionId) return result
    return this.inbound(asRecord(result), thread.id, thread.codexSessionId)
  }

  private onExit(provider: string, generation: number, reason: string): void {
    for (const [threadId, turn] of this.activeTurns.entries()) {
      if (turn.provider !== provider) continue
      this.activeTurns.delete(threadId)
      const error = { message: `Codex stopped: ${reason}` }
      this.host.notifyThread(threadId, {
        method: 'turn/completed',
        params: { threadId, turn: { id: turn.turnId, items: [], status: 'failed', error } },
      })
      this.host.notifyThread(threadId, {
        method: 'thread/status/changed',
        params: { threadId, status: { type: 'idle' } },
      })
      this.host.store.updateThreadStatus(threadId, { type: 'idle' })
    }
    for (const id of [...this.pendingRequests]) {
      if (!id.startsWith(`cx:${provider}:${generation}:`)) continue
      this.pendingRequests.delete(id)
      this.host.dropServerRequest(id)
    }
    this.host.checkIdle()
  }

  // serverRequest/resolved names the child's request id.
  resolvedRequestId(provider: string, childRequestId: unknown): string | null {
    const child = this.children.get(provider)
    if (!child || childRequestId === undefined || childRequestId === null) return null
    return `cx:${provider}:${child.generation}:${String(childRequestId)}`
  }
}

function requestedModel(params: Record<string, unknown>): string | null {
  if (typeof params.model === 'string' && params.model) return params.model
  const nested = asRecord(asRecord(params.collaborationMode).settings).model
  return typeof nested === 'string' && nested ? nested : null
}

function modelIsCodex(params: Record<string, unknown>): boolean {
  const model = requestedModel(params)
  return (
    model !== null &&
    (/^gpt[-_]/.test(model) || /^o[0-9]/.test(model) || model.startsWith('codex-'))
  )
}

function hasModel(params: Record<string, unknown>): boolean {
  return (
    (typeof params.model === 'string' && params.model.length > 0) ||
    typeof asRecord(asRecord(params.collaborationMode).settings).model === 'string'
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

// Every string value of the payload passed through `map`, with its key.
function rewrite(
  value: unknown,
  map: (value: string, key: string | null) => string,
  key: string | null = null,
): unknown {
  if (typeof value === 'string') return map(value, key)
  if (Array.isArray(value)) return value.map((entry) => rewrite(entry, map, key))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [field, entry] of Object.entries(value)) out[field] = rewrite(entry, map, field)
    return out
  }
  return value
}
