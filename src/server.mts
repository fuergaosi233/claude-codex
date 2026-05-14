import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { promisify } from 'node:util'
import type {
  ClaudeRuntime,
  FileUpdateChange,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionDecision,
  RpcPeer,
  RuntimeEvent,
  ThreadItem,
  ThreadRecord,
  TurnRecord,
  UserInput,
  WireMessage,
} from './types.mjs'
import { SessionStore } from './store.mjs'
import { callMcpTool, readMcpConfig, readMcpResource } from './mcp.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'
import {
  claudeModelOptions,
  codexHome,
  newId,
  nowMillis,
  nowSeconds,
  normalizeCodexReasoningEffort,
  platformFamily,
  platformOs,
  resolveClaudeEffort,
  resolveClaudeModel,
  textFromInput,
} from './util.mjs'

const execFileAsync = promisify(execFile)

export class CodexClaudeAppServer {
  private pendingServerRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private activePeerByThread = new Map<string, RpcPeer>()
  private activeTurnByThread = new Map<string, string>()
  private commandSessionAllow = new Map<string, Set<string>>()
  private commandProcesses = new Map<string, ChildProcess>()
  private processHandles = new Map<string, ChildProcess>()
  private fsWatchers = new Map<string, FSWatcher>()
  private goals = new Map<string, Record<string, unknown>>()
  private elicitationCounts = new Map<string, number>()
  private stopped = false

  constructor(
    private store: SessionStore,
    private runtime: ClaudeRuntime,
  ) {}

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if ('method' in message && message.method) {
      if ('id' in message) {
        await this.handleRequest(peer, message as JsonRpcRequest)
      } else {
        await this.handleNotification(peer, message)
      }
      return
    }
    if ('id' in message) {
      this.resolveServerRequest(message as JsonRpcResponse)
    }
  }

  closePeer(peer: RpcPeer): void {
    for (const [threadId, activePeer] of this.activePeerByThread.entries()) {
      if (activePeer.id === peer.id) this.activePeerByThread.delete(threadId)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.runtime.stop()
    this.store.close()
  }

  private async handleNotification(_peer: RpcPeer, _message: WireMessage): Promise<void> {
    // Currently only `initialized` is expected from clients.
  }

  private async handleRequest(peer: RpcPeer, request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(peer, request.method, request.params ?? {})
      this.sendResponse(peer, request.id, result)
    } catch (error) {
      this.sendResponse(peer, request.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async dispatch(peer: RpcPeer, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          userAgent: 'claude-codex-adapter/0.1.0',
          codexHome: codexHome(),
          platformFamily: platformFamily(),
          platformOs: platformOs(),
        }
      case 'thread/start':
        return this.threadStart(peer, asRecord(params))
      case 'thread/resume':
        return this.threadResume(asRecord(params))
      case 'thread/fork':
        return this.threadFork(peer, asRecord(params))
      case 'thread/list':
        return this.threadList(asRecord(params))
      case 'thread/read':
        return this.threadRead(asRecord(params))
      case 'thread/turns/list':
        return this.threadTurnsList(asRecord(params))
      case 'thread/turns/items/list':
        return this.threadTurnItemsList(asRecord(params))
      case 'thread/name/set':
        return this.threadNameSet(asRecord(params))
      case 'thread/archive':
        return this.threadArchive(asRecord(params), true)
      case 'thread/unsubscribe':
        return this.threadUnsubscribe(peer, asRecord(params))
      case 'thread/increment_elicitation':
        return this.threadAdjustElicitation(asRecord(params), 1)
      case 'thread/decrement_elicitation':
        return this.threadAdjustElicitation(asRecord(params), -1)
      case 'thread/goal/set':
        return this.threadGoalSet(asRecord(params))
      case 'thread/goal/get':
        return this.threadGoalGet(asRecord(params))
      case 'thread/goal/clear':
        return this.threadGoalClear(asRecord(params))
      case 'thread/metadata/update':
        return this.threadMetadataUpdate(asRecord(params))
      case 'thread/memoryMode/set':
      case 'memory/reset':
        return {}
      case 'thread/unarchive':
        return this.threadArchive(asRecord(params), false)
      case 'thread/compact/start':
        return {}
      case 'thread/shellCommand':
        return this.threadShellCommand(peer, asRecord(params))
      case 'thread/approveGuardianDeniedAction':
      case 'thread/backgroundTerminals/clean':
        return {}
      case 'thread/rollback':
        return this.threadRollback(asRecord(params))
      case 'thread/loaded/list':
        return this.threadLoadedList(asRecord(params))
      case 'thread/inject_items':
        return {}
      case 'turn/start':
        return this.turnStart(peer, asRecord(params))
      case 'turn/steer':
        return this.turnSteer(peer, asRecord(params))
      case 'turn/interrupt':
        return this.turnInterrupt(asRecord(params))
      case 'thread/realtime/start':
      case 'thread/realtime/appendAudio':
      case 'thread/realtime/appendText':
      case 'thread/realtime/stop':
        return {}
      case 'thread/realtime/listVoices':
        return { voices: { v1: ['alloy'], v2: ['alloy'], defaultV1: 'alloy', defaultV2: 'alloy' } }
      case 'review/start':
        return this.reviewStart(asRecord(params))
      case 'config/read':
        return this.configRead()
      case 'configRequirements/read':
        return { requirements: null }
      case 'model/list':
        return this.modelList()
      case 'modelProvider/capabilities/read':
        return { namespaceTools: true, imageGeneration: false, webSearch: false }
      case 'experimentalFeature/list':
        return { data: [], nextCursor: null }
      case 'experimentalFeature/enablement/set':
        return { enablement: asRecord(asRecord(params).enablement) }
      case 'collaborationMode/list':
        return method === 'collaborationMode/list' ? { data: [] } : {}
      case 'mock/experimentalMethod':
        return { echoed: typeof asRecord(params).value === 'string' ? asRecord(params).value : null }
      case 'skills/list':
        return { data: [] }
      case 'hooks/list':
        return { data: [] }
      case 'marketplace/add':
        return this.marketplaceAdd(asRecord(params))
      case 'marketplace/remove':
        return this.marketplaceRemove(asRecord(params))
      case 'marketplace/upgrade':
        return this.marketplaceUpgrade(asRecord(params))
      case 'plugin/list':
        return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
      case 'plugin/read':
        return this.pluginRead(asRecord(params))
      case 'plugin/skill/read':
        return { contents: null }
      case 'plugin/share/save':
        return this.pluginShareSave(asRecord(params))
      case 'plugin/share/updateTargets':
        return this.pluginShareUpdateTargets(asRecord(params))
      case 'plugin/share/delete':
      case 'plugin/uninstall':
        return {}
      case 'plugin/install':
        return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
      case 'skills/config/write':
        return { effectiveEnabled: asRecord(params).enabled === true }
      case 'plugin/share/list':
        return { data: [] }
      case 'app/list':
        return { data: [], nextCursor: null }
      case 'mcpServer/oauth/login':
        return { authorizationUrl: `https://localhost.invalid/claude-codex/mcp-oauth/${encodeURIComponent(stringOr(asRecord(params).name, 'server'))}` }
      case 'config/mcpServer/reload':
        return {}
      case 'mcpServerStatus/list':
        return { data: readMcpConfig().statuses, nextCursor: null }
      case 'mcpServer/resource/read':
        return readMcpResource(stringOr(asRecord(params).server, ''), stringOr(asRecord(params).uri, ''))
      case 'mcpServer/tool/call':
        return callMcpTool(stringOr(asRecord(params).server, ''), stringOr(asRecord(params).tool, ''), asRecord(params).arguments ?? {})
      case 'windowsSandbox/setupStart':
        return { started: false }
      case 'windowsSandbox/readiness':
        return { status: 'notConfigured' }
      case 'account/login/start':
        return { type: 'apiKey' }
      case 'account/login/cancel':
        return { status: 'notFound' }
      case 'account/logout':
        return {}
      case 'account/sendAddCreditsNudgeEmail':
        return { status: 'cooldown_active' }
      case 'feedback/upload':
        return { threadId: stringOr(asRecord(params).threadId, '') }
      case 'account/read':
        return { account: null, requiresOpenaiAuth: false }
      case 'account/rateLimits/read':
        return this.accountRateLimits()
      case 'fs/readFile':
        return this.fsReadFile(asRecord(params))
      case 'fs/readDirectory':
        return this.fsReadDirectory(asRecord(params))
      case 'fs/getMetadata':
        return this.fsGetMetadata(asRecord(params))
      case 'fs/writeFile':
        return this.fsWriteFile(asRecord(params))
      case 'fs/createDirectory':
        return this.fsCreateDirectory(asRecord(params))
      case 'fs/remove':
        return this.fsRemove(asRecord(params))
      case 'fs/copy':
        return this.fsCopy(asRecord(params))
      case 'fs/watch':
        return this.fsWatch(peer, asRecord(params))
      case 'fs/unwatch':
        return this.fsUnwatch(asRecord(params))
      case 'command/exec':
        return this.commandExec(peer, asRecord(params))
      case 'command/exec/write':
        return this.commandExecWrite(asRecord(params))
      case 'command/exec/terminate':
        return this.commandExecTerminate(asRecord(params))
      case 'command/exec/resize':
        return {}
      case 'process/spawn':
        return this.processSpawn(peer, asRecord(params))
      case 'process/writeStdin':
        return this.processWriteStdin(asRecord(params))
      case 'process/kill':
        return this.processKill(asRecord(params))
      case 'process/resizePty':
        return {}
      case 'externalAgentConfig/detect':
        return { items: [] }
      case 'externalAgentConfig/import':
        return {}
      case 'config/value/write':
      case 'config/batchWrite':
        return this.configWriteResponse(asRecord(params))
      case 'getConversationSummary':
        return this.getConversationSummary(asRecord(params))
      case 'gitDiffToRemote':
        return this.gitDiffToRemote(asRecord(params))
      case 'getAuthStatus':
        return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
      case 'fuzzyFileSearch':
        return this.fuzzyFileSearch(asRecord(params))
      case 'fuzzyFileSearch/sessionStart':
      case 'fuzzyFileSearch/sessionUpdate':
      case 'fuzzyFileSearch/sessionStop':
        return {}
      default:
        throw new Error(`method not implemented: ${method}`)
    }
  }

  private threadStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const id = newId()
    const now = nowSeconds()
    const requestedCwd = stringOr(params.cwd, process.cwd())
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const model = stringOr(params.model, process.env.CLAUDE_CODEX_DEFAULT_MODEL ?? 'sonnet')
    const reasoningEffort = normalizeCodexReasoningEffort(
      typeof params.effort === 'string' ? params.effort : process.env.CLAUDE_CODEX_DEFAULT_EFFORT ?? 'medium',
    )
    const thread: ThreadRecord = {
      id,
      sessionId: id,
      forkedFromId: null,
      preview: '',
      name: null,
      archived: false,
      cwd,
      model,
      reasoningEffort,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'app_server',
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
    }
    this.store.upsertThread(thread)
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread)
  }

  private threadResume(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    if (typeof params.model === 'string' && params.model.length > 0) thread.model = params.model
    if (typeof params.effort === 'string') thread.reasoningEffort = normalizeCodexReasoningEffort(params.effort)
    this.store.upsertThread(thread)
    return this.threadEnvelope(thread, params.excludeTurns === true ? [] : this.store.listTurns(thread.id))
  }

  private threadFork(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const parentId = stringOr(params.threadId, '')
    const parent = this.store.getThread(parentId)
    if (!parent) throw new Error(`unknown thread: ${parentId}`)
    const now = nowSeconds()
    const id = newId()
    const requestedCwd = stringOr(params.cwd, parent.cwd)
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const thread: ThreadRecord = {
      ...parent,
      id,
      sessionId: parent.sessionId,
      forkedFromId: parent.id,
      archived: false,
      cwd,
      model: stringOr(params.model, parent.model),
      reasoningEffort: normalizeCodexReasoningEffort(typeof params.effort === 'string' ? params.effort : parent.reasoningEffort),
      claudeSessionId: parent.claudeSessionId,
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
    }
    this.store.upsertThread(thread)
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread, params.excludeTurns === true ? [] : this.store.listTurns(parent.id))
  }

  private threadList(params: Record<string, unknown>): unknown {
    const threads = this.store.listThreads({
      archived: params.archived as boolean | null | undefined,
      limit: numberOr(params.limit, 50),
      cursor: typeof params.cursor === 'string' ? params.cursor : null,
      cwd: typeof params.cwd === 'string' || Array.isArray(params.cwd) ? (params.cwd as string | string[]) : null,
    })
    const last = threads.at(-1)
    return {
      data: threads.map((thread) => this.toThread(thread, [])),
      nextCursor: last && threads.length >= numberOr(params.limit, 50) ? String(last.updatedAt) : null,
      backwardsCursor: threads[0] ? String(threads[0].updatedAt) : null,
    }
  }

  private threadRead(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const turns = params.includeTurns === false ? [] : this.store.listTurns(threadId)
    return { thread: this.toThread(thread, turns) }
  }

  private threadTurnsList(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    return {
      data: this.store.listTurns(threadId).map((turn) => this.toTurn(turn)),
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private threadTurnItemsList(params: Record<string, unknown>): unknown {
    const turnId = stringOr(params.turnId, '')
    const turn = this.store.getTurn(turnId)
    return {
      data: turn?.items ?? [],
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private threadNameSet(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const name = params.name == null ? null : String(params.name)
    this.store.updateThreadName(threadId, name)
    this.notifyThread(threadId, { method: 'thread/name/updated', params: { threadId, threadName: name ?? undefined } })
    return {}
  }

  private threadArchive(params: Record<string, unknown>, archived: boolean): unknown {
    const threadId = stringOr(params.threadId, '')
    this.store.setArchived(threadId, archived)
    this.notifyThread(threadId, { method: archived ? 'thread/archived' : 'thread/unarchived', params: { threadId } })
    if (!archived) {
      const thread = this.store.getThread(threadId)
      if (!thread) throw new Error(`unknown thread: ${threadId}`)
      return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
    }
    return {}
  }

  private threadUnsubscribe(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const active = this.activePeerByThread.get(threadId)
    if (!active) return { status: 'notSubscribed' }
    if (active.id !== peer.id) return { status: 'notSubscribed' }
    this.activePeerByThread.delete(threadId)
    this.notify(peer, { method: 'thread/closed', params: { threadId } })
    return { status: 'unsubscribed' }
  }

  private threadLoadedList(params: Record<string, unknown>): unknown {
    const loaded = Array.from(this.activePeerByThread.keys())
    const limit = numberOr(params.limit, loaded.length || 50)
    return { data: loaded.slice(0, limit), nextCursor: loaded.length > limit ? String(limit) : null }
  }

  private threadGoalSet(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const existing = this.goals.get(threadId)
    const now = nowSeconds()
    const goal = {
      threadId,
      objective: stringOr(params.objective, String(existing?.objective ?? '')),
      status: typeof params.status === 'string' ? params.status : existing?.status ?? 'active',
      tokenBudget: typeof params.tokenBudget === 'number' ? params.tokenBudget : existing?.tokenBudget ?? null,
      tokensUsed: existing?.tokensUsed ?? 0,
      timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.goals.set(threadId, goal)
    this.notifyThread(threadId, { method: 'thread/goal/updated', params: { threadId, goal } })
    return { goal }
  }

  private threadGoalGet(params: Record<string, unknown>): unknown {
    return { goal: this.goals.get(stringOr(params.threadId, '')) ?? null }
  }

  private threadGoalClear(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const cleared = this.goals.delete(threadId)
    if (cleared) this.notifyThread(threadId, { method: 'thread/goal/cleared', params: { threadId } })
    return { cleared }
  }

  private threadAdjustElicitation(params: Record<string, unknown>, delta: number): unknown {
    const threadId = stringOr(params.threadId, '')
    const next = Math.max(0, (this.elicitationCounts.get(threadId) ?? 0) + delta)
    this.elicitationCounts.set(threadId, next)
    return { count: next, paused: next > 0 }
  }

  private threadMetadataUpdate(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
  }

  private threadRollback(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
  }

  private threadShellCommand(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    const command = stringOr(params.command, '')
    if (!command) return {}
    const shell = process.env.SHELL || '/bin/sh'
    const cwd = thread?.cwd ?? process.cwd()
    const processId = newId()
    const child = spawn(shell, ['-lc', command], { cwd, env: process.env, stdio: 'pipe' })
    this.commandProcesses.set(processId, child)
    child.stdout?.on('data', (chunk) => this.notify(peer, { method: 'command/exec/outputDelta', params: { processId, stream: 'stdout', deltaBase64: Buffer.from(chunk).toString('base64'), capReached: false } }))
    child.stderr?.on('data', (chunk) => this.notify(peer, { method: 'command/exec/outputDelta', params: { processId, stream: 'stderr', deltaBase64: Buffer.from(chunk).toString('base64'), capReached: false } }))
    child.once('close', () => this.commandProcesses.delete(processId))
    return {}
  }

  private reviewStart(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const turn: TurnRecord = {
      id: newId(),
      threadId,
      status: 'completed',
      startedAt: nowSeconds(),
      completedAt: nowSeconds(),
      durationMs: 0,
      items: [{ type: 'agentMessage', id: newId(), text: 'Review mode is not implemented by the Claude-backed adapter.', phase: null, memoryCitation: null }],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    return { turn: this.toTurn(turn), reviewThreadId: threadId }
  }

  private async turnStart(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    this.activePeerByThread.set(threadId, peer)

    const turnId = newId()
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    const prompt = textFromInput(input)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    if (typeof params.model === 'string' && params.model.length > 0) thread.model = params.model
    if (typeof params.effort === 'string') thread.reasoningEffort = normalizeCodexReasoningEffort(params.effort)
    this.store.upsertThread(thread)
    if (!thread.preview && prompt) {
      thread.preview = prompt.slice(0, 200)
      thread.updatedAt = nowSeconds()
      this.store.upsertThread(thread)
    }
    const userItem: ThreadItem = { type: 'userMessage', id: newId(), content: input }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [userItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    this.activeTurnByThread.set(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toTurn(turn)

    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      void this.runRuntimeTurn(peer, thread, turn, prompt, params).catch((error) => {
      const completed = this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
      this.notify(peer, { method: 'error', params: { threadId, turnId, willRetry: false, error: { message: error.message } } })
      this.notify(peer, { method: 'turn/completed', params: { threadId, turn: this.toTurn(completed) } })
      this.activeTurnByThread.delete(threadId)
      this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: publicTurn }
  }

  private async runRuntimeTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    prompt: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const itemIds = new Map<string, string>()
    let agentItemId: string | null = null
    let reasoningItemId: string | null = null
    const forkSession = thread.forkedFromId != null && thread.claudeSessionId != null && this.store.listTurns(thread.id).length <= 1
    const ensureAgentItem = (): string => {
      if (agentItemId) return agentItemId
      agentItemId = newId()
      const item: ThreadItem = { type: 'agentMessage', id: agentItemId, text: '', phase: null, memoryCitation: null }
      this.store.appendItem(turn.id, item)
      this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() } })
      return agentItemId
    }
    const ensureReasoningItem = (): string => {
      if (reasoningItemId) return reasoningItemId
      reasoningItemId = newId()
      const item: ThreadItem = { type: 'reasoning', id: reasoningItemId, summary: [''], content: [''] }
      this.store.appendItem(turn.id, item)
      this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() } })
      return reasoningItemId
    }

    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        prompt,
        cwd: stringOr(params.cwd, thread.cwd),
        model: resolveClaudeModel(stringOr(params.model, thread.model)),
        effort: resolveClaudeEffort(
          typeof params.effort === 'string' ? params.effort : thread.reasoningEffort ?? process.env.CLAUDE_CODEX_EFFORT ?? null,
        ),
        claudeSessionId: thread.claudeSessionId,
        forkSession,
        mcpServers: readMcpConfig().sdkValue,
        allowedTools: stringListFromEnv('CLAUDE_CODEX_ALLOWED_TOOLS', ['Read', 'Glob', 'Grep']),
        addDirs: stringListFromEnv('CLAUDE_CODEX_ADD_DIRS', []),
        enableFileCheckpointing: process.env.CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING === '1',
        outputFormat: params.outputSchema ?? null,
      },
      {
        onEvent: async (event) => {
          if (event.type === 'session') {
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            return
          }
          if (event.type === 'text_delta') {
            const itemId = ensureAgentItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'agentMessage') return { ...item, text: item.text + event.delta }
              return item
            })
            this.notify(peer, { method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta } })
            return
          }
          if (event.type === 'reasoning_delta') {
            const itemId = ensureReasoningItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'reasoning') return { ...item, content: [(item.content[0] ?? '') + event.delta] }
              return item
            })
            this.notify(peer, {
              method: 'item/reasoning/textDelta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta, contentIndex: 0 },
            })
            return
          }
          if (event.type === 'tool_use') {
            const item = this.toolUseToItem(event, thread.cwd)
            itemIds.set(event.toolUseId, item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() } })
            if (item.type === 'fileChange') {
              this.notify(peer, { method: 'item/fileChange/patchUpdated', params: { threadId: thread.id, turnId: turn.id, itemId: item.id, changes: item.changes } })
            }
            return
          }
          if (event.type === 'tool_output_delta') {
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return { ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${event.delta}` }
              }
              return item
            })
            this.notify(peer, { method: 'item/commandExecution/outputDelta', params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta } })
            return
          }
          if (event.type === 'tool_result') {
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            const updated = this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') return { ...item, status: event.isError ? 'failed' : 'completed', exitCode: event.isError ? 1 : 0 }
              if (item.type === 'fileChange') return { ...item, status: event.isError ? 'failed' : 'completed' }
              if (item.type === 'mcpToolCall') {
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  result: event.isError ? null : event.content,
                  error: event.isError ? event.content : null,
                }
              }
              return item
            })
            const item = updated?.items.find((candidate) => candidate.id === itemId)
            if (item) this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() } })
            const diff = await gitDiff(thread.cwd)
            if (diff) {
              this.store.updateTurnDiff(turn.id, diff)
              this.notify(peer, { method: 'turn/diff/updated', params: { threadId: thread.id, turnId: turn.id, diff } })
            }
            return
          }
          if (event.type === 'completed') {
            if (event.claudeSessionId) this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
          }
          if (event.type === 'error') {
            throw new Error(event.message)
          }
        },
        onPermissionRequest: async (event) => {
          let itemId = itemIds.get(event.toolUseId)
          if (!itemId) {
            const item = this.toolUseToItem({ type: 'tool_use', toolUseId: event.toolUseId, toolName: event.toolName, input: event.input }, thread.cwd)
            itemId = item.id
            itemIds.set(event.toolUseId, item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() } })
            if (item.type === 'fileChange') {
              this.notify(peer, { method: 'item/fileChange/patchUpdated', params: { threadId: thread.id, turnId: turn.id, itemId: item.id, changes: item.changes } })
            }
          }
          const decision = await this.requestApproval(peer, thread.id, turn.id, itemId, event)
          if (decision.decision === 'acceptForSession') {
            const command = String(event.input.command ?? '')
            if (command) {
              const set = this.commandSessionAllow.get(thread.id) ?? new Set<string>()
              set.add(command)
              this.commandSessionAllow.set(thread.id, set)
            }
          }
          return decision
        },
      },
    )

    const finalDiff = await gitDiff(thread.cwd)
    if (finalDiff) {
      this.store.updateTurnDiff(turn.id, finalDiff)
      this.notify(peer, { method: 'turn/diff/updated', params: { threadId: thread.id, turnId: turn.id, diff: finalDiff } })
    }
    const latestTurn = this.store.getTurn(turn.id)
    for (const completedItemId of [reasoningItemId, agentItemId]) {
      const item = latestTurn?.items.find((candidate) => candidate.id === completedItemId)
      if (item) this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() } })
    }
    const completed = this.store.completeTurn(turn.id, 'completed') ?? turn
    this.activeTurnByThread.delete(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    this.notify(peer, { method: 'turn/completed', params: { threadId: thread.id, turn: this.toTurn(completed) } })
  }

  private async requestApproval(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
  ): Promise<PermissionDecision> {
    const command = String(event.input.command ?? '')
    if (command && this.commandSessionAllow.get(threadId)?.has(command)) {
      return { decision: 'accept' }
    }

    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: ['waitingOnApproval'] })
    const requestId = newId()
    const isCommand = event.toolName === 'Bash'
    const method = isCommand ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval'
    const params = isCommand
      ? {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          approvalId: requestId,
          reason: null,
          command,
          cwd: String(event.input.cwd ?? ''),
          commandActions: [],
          additionalPermissions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        }
      : {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          reason: null,
          grantRoot: null,
        }

    let response: unknown
    try {
      response = await this.sendServerRequest(peer, method, requestId, params)
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
      this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    }
    const decision = normalizeDecision(response)
    return { decision }
  }

  private async turnInterrupt(params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    await this.runtime.interrupt(threadId)
    this.activeTurnByThread.delete(threadId)
    this.setThreadStatus(null, threadId, { type: 'idle' })
    return {}
  }

  private async turnSteer(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const expectedTurnId = stringOr(params.expectedTurnId, '')
    const activeTurnId = this.activeTurnByThread.get(threadId)
    if (!activeTurnId) throw new Error(`thread has no active turn: ${threadId}`)
    if (expectedTurnId && expectedTurnId !== activeTurnId) {
      throw new Error(`active turn mismatch: expected ${expectedTurnId}, got ${activeTurnId}`)
    }
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    const prompt = textFromInput(input)
    const item: ThreadItem = { type: 'userMessage', id: newId(), content: input }
    this.store.appendItem(activeTurnId, item)
    this.notify(peer, { method: 'item/started', params: { threadId, turnId: activeTurnId, item, startedAtMs: nowMillis() } })
    this.notify(peer, { method: 'item/completed', params: { threadId, turnId: activeTurnId, item, completedAtMs: nowMillis() } })
    await this.runtime.steer(threadId, prompt)
    return { turnId: activeTurnId }
  }

  private configRead(): unknown {
    return {
      config: {
        model: process.env.CLAUDE_CODEX_DEFAULT_MODEL ?? 'sonnet',
        review_model: null,
        model_context_window: null,
        model_auto_compact_token_limit: null,
        model_provider: 'claude-code',
        approval_policy: 'on-request',
        approvals_reviewer: 'user',
        sandbox_mode: 'workspace-write',
        sandbox_workspace_write: null,
        forced_chatgpt_workspace_id: null,
        forced_login_method: null,
        web_search: 'disabled',
        tools: null,
        profile: null,
        profiles: {},
        instructions: null,
        developer_instructions: null,
        compact_prompt: null,
        model_reasoning_effort: normalizeCodexReasoningEffort(process.env.CLAUDE_CODEX_DEFAULT_EFFORT) ?? 'medium',
        model_reasoning_summary: null,
        model_verbosity: null,
        service_tier: null,
        analytics: null,
        apps: null,
      },
      origins: {},
      layers: null,
    }
  }

  private modelList(): unknown {
    const defaultModel = process.env.CLAUDE_CODEX_DEFAULT_MODEL ?? 'sonnet'
    const reasoningEfforts = [
      { reasoningEffort: 'low', description: 'Fast Claude Code runtime response' },
      { reasoningEffort: 'medium', description: 'Balanced Claude Code runtime response' },
      { reasoningEffort: 'high', description: 'Deeper Claude Code runtime response' },
      { reasoningEffort: 'xhigh', description: 'Maximum Codex UI reasoning level for Claude Code' },
    ]
    return {
      data: claudeModelOptions().map((option) => ({
        id: option.id,
        model: option.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: option.displayName,
        description: option.description,
        hidden: false,
        supportedReasoningEfforts: reasoningEfforts,
        defaultReasoningEffort: normalizeCodexReasoningEffort(process.env.CLAUDE_CODEX_DEFAULT_EFFORT) ?? 'medium',
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        isDefault: option.isDefault === true || option.id === defaultModel,
      })),
      nextCursor: null,
    }
  }

  private accountRateLimits(): unknown {
    const rateLimits = {
      limitId: 'claude-code',
      limitName: 'Claude Code',
      primary: null,
      secondary: null,
      credits: null,
      planType: null,
      rateLimitReachedType: null,
    }
    return { rateLimits, rateLimitsByLimitId: { 'claude-code': rateLimits } }
  }

  private async fsReadFile(params: Record<string, unknown>): Promise<unknown> {
    const { readFile } = await import('node:fs/promises')
    const path = stringOr(params.path ?? params.filePath, '')
    return { dataBase64: (await readFile(path)).toString('base64') }
  }

  private async fsReadDirectory(params: Record<string, unknown>): Promise<unknown> {
    const { readdir } = await import('node:fs/promises')
    const path = stringOr(params.path, process.cwd())
    const entries = await readdir(path, { withFileTypes: true })
    return {
      entries: entries.map((entry) => ({
        fileName: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      })),
    }
  }

  private async fsGetMetadata(params: Record<string, unknown>): Promise<unknown> {
    const { stat } = await import('node:fs/promises')
    const path = stringOr(params.path, '')
    const metadata = await stat(path)
    return {
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      isSymlink: metadata.isSymbolicLink(),
      createdAtMs: metadata.birthtimeMs,
      modifiedAtMs: metadata.mtimeMs,
    }
  }

  private async fsWriteFile(params: Record<string, unknown>): Promise<unknown> {
    const { writeFile } = await import('node:fs/promises')
    const path = stringOr(params.path, '')
    const data = typeof params.dataBase64 === 'string' ? Buffer.from(params.dataBase64, 'base64') : Buffer.alloc(0)
    await writeFile(path, data)
    return {}
  }

  private async fsCreateDirectory(params: Record<string, unknown>): Promise<unknown> {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(stringOr(params.path, ''), { recursive: params.recursive !== false })
    return {}
  }

  private async fsRemove(params: Record<string, unknown>): Promise<unknown> {
    const { rm } = await import('node:fs/promises')
    await rm(stringOr(params.path, ''), { recursive: params.recursive !== false, force: params.force !== false })
    return {}
  }

  private async fsCopy(params: Record<string, unknown>): Promise<unknown> {
    const { cp } = await import('node:fs/promises')
    await cp(stringOr(params.sourcePath, ''), stringOr(params.destinationPath, ''), { recursive: params.recursive === true })
    return {}
  }

  private async fsWatch(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const { realpath } = await import('node:fs/promises')
    const watchId = stringOr(params.watchId, newId())
    const path = await realpath(stringOr(params.path, process.cwd()))
    this.fsWatchers.get(watchId)?.close()
    const watcher = watch(path, { persistent: false }, (_eventType, filename) => {
      const changedPath = filename ? `${path}/${String(filename)}` : path
      this.notify(peer, { method: 'fs/changed', params: { watchId, changedPaths: [changedPath] } })
    })
    this.fsWatchers.set(watchId, watcher)
    return { path }
  }

  private fsUnwatch(params: Record<string, unknown>): unknown {
    const watchId = stringOr(params.watchId, '')
    this.fsWatchers.get(watchId)?.close()
    this.fsWatchers.delete(watchId)
    return {}
  }

  private async commandExec(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const processId = typeof params.processId === 'string' ? params.processId : newId()
    const command = Array.isArray(params.command)
      ? params.command.map(String)
      : typeof params.command === 'string'
        ? [params.command]
        : []
    if (command.length === 0) throw new Error('command/exec requires command')
    if ((params.streamStdoutStderr === true || params.streamStdin === true || params.tty === true) && typeof params.processId !== 'string') {
      throw new Error('command/exec streaming requires processId')
    }

    const executable = command[0] as string
    const streamOutput = params.streamStdoutStderr === true || params.tty === true
    const cwd = stringOr(params.cwd, process.cwd())
    const child = spawn(executable, command.slice(1), { cwd, env: commandEnv(params.env), stdio: 'pipe' })
    this.commandProcesses.set(processId, child)

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const cap = params.disableOutputCap === true ? Number.POSITIVE_INFINITY : numberOr(params.outputBytesCap, 1_000_000)
    let stdoutBytes = 0
    let stderrBytes = 0

    const capture = (target: Buffer[], chunk: Buffer, currentBytes: number): number => {
      if (currentBytes >= cap) return currentBytes
      const allowed = Math.min(chunk.byteLength, cap - currentBytes)
      if (allowed > 0) target.push(chunk.subarray(0, allowed))
      return currentBytes + allowed
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, { method: 'command/exec/outputDelta', params: { processId, stream: 'stdout', deltaBase64: buffer.toString('base64'), capReached: false } })
        return
      }
      stdoutBytes = capture(stdout, buffer, stdoutBytes)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, { method: 'command/exec/outputDelta', params: { processId, stream: 'stderr', deltaBase64: buffer.toString('base64'), capReached: false } })
        return
      }
      stderrBytes = capture(stderr, buffer, stderrBytes)
    })

    const timeoutMs = params.disableTimeout === true ? null : numberOr(params.timeoutMs, 60_000)
    let timeout: NodeJS.Timeout | null = null
    if (timeoutMs != null && timeoutMs > 0) {
      timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    }

    return new Promise((resolve, reject) => {
      child.once('error', (error) => {
        if (timeout) clearTimeout(timeout)
        this.commandProcesses.delete(processId)
        reject(error)
      })
      child.once('close', (code) => {
        if (timeout) clearTimeout(timeout)
        this.commandProcesses.delete(processId)
        resolve({
          exitCode: code ?? 1,
          stdout: streamOutput ? '' : Buffer.concat(stdout).toString('utf8'),
          stderr: streamOutput ? '' : Buffer.concat(stderr).toString('utf8'),
        })
      })
    })
  }

  private commandExecWrite(params: Record<string, unknown>): unknown {
    const processId = stringOr(params.processId, '')
    const child = this.commandProcesses.get(processId)
    if (!child) throw new Error(`unknown command process: ${processId}`)
    if (typeof params.deltaBase64 === 'string' && params.deltaBase64.length > 0) {
      child.stdin?.write(Buffer.from(params.deltaBase64, 'base64'))
    }
    if (params.closeStdin === true) {
      child.stdin?.end()
    }
    return {}
  }

  private commandExecTerminate(params: Record<string, unknown>): unknown {
    const processId = stringOr(params.processId, '')
    const child = this.commandProcesses.get(processId)
    if (!child) throw new Error(`unknown command process: ${processId}`)
    child.kill('SIGTERM')
    return {}
  }

  private processSpawn(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    if (!processHandle) throw new Error('process/spawn requires processHandle')
    if (this.processHandles.has(processHandle)) throw new Error(`process handle already active: ${processHandle}`)
    const command = Array.isArray(params.command) ? params.command.map(String) : []
    if (command.length === 0) throw new Error('process/spawn requires command')
    const cwd = stringOr(params.cwd, process.cwd())
    const streamOutput = params.streamStdoutStderr === true || params.tty === true
    const cap = params.outputBytesCap == null ? 1_000_000 : numberOr(params.outputBytesCap, 1_000_000)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutCapReached = false
    let stderrCapReached = false
    const child = spawn(command[0] as string, command.slice(1), { cwd, env: commandEnv(params.env), stdio: 'pipe' })
    this.processHandles.set(processHandle, child)

    const capture = (target: Buffer[], chunk: Buffer, currentBytes: number): [number, boolean] => {
      if (currentBytes >= cap) return [currentBytes, true]
      const allowed = Math.min(chunk.byteLength, cap - currentBytes)
      if (allowed > 0) target.push(chunk.subarray(0, allowed))
      return [currentBytes + allowed, allowed < chunk.byteLength]
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, { method: 'process/outputDelta', params: { processHandle, stream: 'stdout', deltaBase64: buffer.toString('base64'), capReached: false } })
      } else {
        ;[stdoutBytes, stdoutCapReached] = capture(stdout, buffer, stdoutBytes)
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, { method: 'process/outputDelta', params: { processHandle, stream: 'stderr', deltaBase64: buffer.toString('base64'), capReached: false } })
      } else {
        ;[stderrBytes, stderrCapReached] = capture(stderr, buffer, stderrBytes)
      }
    })
    const timeoutMs = params.timeoutMs == null ? 60_000 : numberOr(params.timeoutMs, 60_000)
    const timeout = timeoutMs > 0 ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null
    child.once('close', (code) => {
      if (timeout) clearTimeout(timeout)
      this.processHandles.delete(processHandle)
      this.notify(peer, {
        method: 'process/exited',
        params: {
          processHandle,
          exitCode: code ?? 1,
          stdout: streamOutput ? '' : Buffer.concat(stdout).toString('utf8'),
          stdoutCapReached,
          stderr: streamOutput ? '' : Buffer.concat(stderr).toString('utf8'),
          stderrCapReached,
        },
      })
    })
    return {}
  }

  private processWriteStdin(params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    const child = this.processHandles.get(processHandle)
    if (!child) throw new Error(`unknown process handle: ${processHandle}`)
    if (typeof params.deltaBase64 === 'string' && params.deltaBase64.length > 0) child.stdin?.write(Buffer.from(params.deltaBase64, 'base64'))
    if (params.closeStdin === true) child.stdin?.end()
    return {}
  }

  private processKill(params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    const child = this.processHandles.get(processHandle)
    if (!child) throw new Error(`unknown process handle: ${processHandle}`)
    child.kill('SIGTERM')
    return {}
  }

  private marketplaceAdd(params: Record<string, unknown>): unknown {
    const source = stringOr(params.source, 'local')
    const marketplaceName = stringOr(params.refName, source.split('/').filter(Boolean).at(-1) ?? 'marketplace')
    return {
      marketplaceName,
      installedRoot: `${codexHome()}/marketplaces/${marketplaceName}`,
      alreadyAdded: true,
    }
  }

  private marketplaceRemove(params: Record<string, unknown>): unknown {
    const marketplaceName = stringOr(params.marketplaceName, 'marketplace')
    return { marketplaceName, installedRoot: null }
  }

  private marketplaceUpgrade(params: Record<string, unknown>): unknown {
    const marketplaceName = typeof params.marketplaceName === 'string' ? params.marketplaceName : null
    return {
      selectedMarketplaces: marketplaceName ? [marketplaceName] : [],
      upgradedRoots: [],
      errors: [],
    }
  }

  private pluginShareSave(params: Record<string, unknown>): unknown {
    const remotePluginId = stringOr(params.remotePluginId, `local-${newId()}`)
    return {
      remotePluginId,
      shareUrl: `https://localhost.invalid/claude-codex/plugin-share/${encodeURIComponent(remotePluginId)}`,
    }
  }

  private pluginShareUpdateTargets(params: Record<string, unknown>): unknown {
    const shareTargets = Array.isArray(params.shareTargets) ? params.shareTargets : []
    return {
      principals: shareTargets.map((target) => {
        const rec = asRecord(target)
        return {
          principalType: stringOr(rec.principalType, 'user'),
          principalId: stringOr(rec.principalId, ''),
          name: stringOr(rec.principalId, 'unknown'),
        }
      }),
      discoverability: params.discoverability === 'UNLISTED' ? 'UNLISTED' : 'PRIVATE',
    }
  }

  private configWriteResponse(params: Record<string, unknown>): unknown {
    const filePath = stringOr(params.filePath, `${codexHome()}/config.toml`)
    return {
      status: 'ok',
      version: `claude-codex-${nowSeconds()}`,
      filePath,
      overriddenMetadata: null,
    }
  }

  private pluginRead(params: Record<string, unknown>): unknown {
    const name = stringOr(params.pluginName, 'unknown')
    return {
      plugin: {
        marketplaceName: stringOr(params.remoteMarketplaceName, 'local'),
        marketplacePath: params.marketplacePath ?? null,
        summary: {
          id: name,
          name,
          shareContext: null,
          source: { type: 'remote' },
          installed: false,
          enabled: false,
          installPolicy: 'NOT_AVAILABLE',
          authPolicy: 'ON_USE',
          availability: 'AVAILABLE',
          interface: null,
          keywords: [],
        },
        description: null,
        skills: [],
        hooks: [],
        apps: [],
        mcpServers: [],
      },
    }
  }

  private getConversationSummary(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.conversationId, '')
    const thread = this.store.getThread(threadId) ?? this.store.listThreads({ limit: 1 }).at(0)
    const now = new Date().toISOString()
    return {
      summary: {
        conversationId: thread?.id ?? threadId,
        path: '',
        preview: thread?.preview ?? '',
        timestamp: now,
        updatedAt: now,
        modelProvider: thread?.modelProvider ?? 'claude-code',
        cwd: thread?.cwd ?? process.cwd(),
        cliVersion: 'claude-codex-adapter/0.1.0',
        source: thread?.source ?? 'app_server',
        gitInfo: null,
      },
    }
  }

  private async gitDiffToRemote(params: Record<string, unknown>): Promise<unknown> {
    const cwd = stringOr(params.cwd, process.cwd())
    const diff = await gitDiff(cwd)
    let sha = ''
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 10_000 })
      sha = stdout.trim()
    } catch {}
    return { sha, diff }
  }

  private async fuzzyFileSearch(params: Record<string, unknown>): Promise<unknown> {
    const query = stringOr(params.query, '').toLowerCase()
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : [process.cwd()]
    const files: Array<Record<string, unknown>> = []
    for (const root of roots) {
      const paths = await listFiles(root)
      for (const path of paths) {
        const fileName = path.split('/').at(-1) ?? path
        const haystack = path.toLowerCase()
        if (query && !haystack.includes(query)) continue
        files.push({
          root,
          path,
          match_type: 'file',
          file_name: fileName,
          score: query ? Math.max(1, 100 - haystack.indexOf(query)) : 1,
          indices: null,
        })
        if (files.length >= 100) break
      }
      if (files.length >= 100) break
    }
    return { files }
  }

  private toolUseToItem(event: Extract<RuntimeEvent, { type: 'tool_use' }>, cwd: string): ThreadItem {
    const id = newId()
    if (event.toolName === 'Bash') {
      return {
        type: 'commandExecution',
        id,
        command: String(event.input.command ?? ''),
        cwd: String(event.input.cwd ?? cwd),
        processId: null,
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }
    }
    if (['Edit', 'Write', 'MultiEdit'].includes(event.toolName)) {
      return {
        type: 'fileChange',
        id,
        changes: fileChangeFromTool(event.toolName, event.input),
        status: 'inProgress',
      }
    }
    return {
      type: 'mcpToolCall',
      id,
      server: 'claude-code',
      tool: event.toolName,
      status: 'inProgress',
      arguments: event.input,
      result: null,
      error: null,
      durationMs: null,
    }
  }

  private threadEnvelope(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    return {
      thread: this.toThread(thread, turns),
      model: thread.model,
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd: thread.cwd,
      instructionSources: [],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      permissionProfile: null,
      activePermissionProfile: null,
      reasoningEffort: thread.reasoningEffort,
    }
  }

  private toThread(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    return {
      id: thread.id,
      sessionId: thread.sessionId,
      forkedFromId: thread.forkedFromId,
      preview: thread.preview,
      ephemeral: false,
      modelProvider: thread.modelProvider,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: thread.status,
      path: null,
      cwd: thread.cwd,
      cliVersion: 'claude-codex-adapter/0.1.0',
      source: thread.source,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: thread.name,
      turns: turns.map((turn) => this.toTurn(turn)),
    }
  }

  private toTurn(turn: TurnRecord): unknown {
    return {
      id: turn.id,
      items: turn.items,
      itemsView: 'full',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  private sendResponse(peer: RpcPeer, id: JsonRpcId, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id }
    if (error) response.error = error
    else response.result = result ?? null
    peer.send(response)
  }

  private notify(peer: RpcPeer, notification: { method: string; params: unknown }): void {
    peer.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
  }

  private notifyThread(threadId: string, notification: { method: string; params: unknown }): void {
    const peer = this.activePeerByThread.get(threadId)
    if (peer) this.notify(peer, notification)
  }

  private setThreadStatus(peer: RpcPeer | null, threadId: string, status: ThreadRecord['status']): void {
    this.store.updateThreadStatus(threadId, status)
    const target = peer ?? this.activePeerByThread.get(threadId)
    if (target) this.notify(target, { method: 'thread/status/changed', params: { threadId, status } })
  }

  private sendServerRequest(peer: RpcPeer, method: string, id: string, params: unknown): Promise<unknown> {
    const key = `${peer.id}:${id}`
    return new Promise((resolve, reject) => {
      this.pendingServerRequests.set(key, { resolve, reject })
      peer.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private resolveServerRequest(response: JsonRpcResponse): void {
    for (const [key, pending] of this.pendingServerRequests.entries()) {
      if (key.endsWith(`:${String(response.id)}`)) {
        this.pendingServerRequests.delete(key)
        if (response.error) pending.reject(new Error(response.error.message))
        else pending.resolve(response.result)
        return
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function commandEnv(value: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return env
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null) delete env[key]
    else env[key] = String(raw)
  }
  return env
}

function stringListFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {}
  return raw.split(',').map((part) => part.trim()).filter(Boolean)
}

function normalizeDecision(response: unknown): PermissionDecision['decision'] {
  const decision = asRecord(response).decision
  if (decision === 'accept' || decision === 'acceptForSession' || decision === 'decline' || decision === 'cancel') return decision
  if (decision && typeof decision === 'object' && ('acceptWithExecpolicyAmendment' in decision || 'applyNetworkPolicyAmendment' in decision)) {
    return 'acceptForSession'
  }
  return 'decline'
}

function fileChangeFromTool(toolName: string, input: Record<string, unknown>): FileUpdateChange[] {
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((edit, index) => {
      const rec = asRecord(edit)
      return {
        path: String(input.file_path ?? input.path ?? `edit-${index}`),
        kind: { type: 'update', move_path: null },
        diff: simpleDiff(String(input.file_path ?? input.path ?? `edit-${index}`), String(rec.old_string ?? ''), String(rec.new_string ?? '')),
      }
    })
  }
  const path = String(input.file_path ?? input.path ?? input.filename ?? 'unknown')
  if (toolName === 'Write') {
    return [{ path, kind: { type: 'add' }, diff: simpleDiff(path, '', String(input.content ?? '')) }]
  }
  return [{ path, kind: { type: 'update', move_path: null }, diff: simpleDiff(path, String(input.old_string ?? ''), String(input.new_string ?? '')) }]
}

function simpleDiff(path: string, oldText: string, newText: string): string {
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@',
    ...oldText.split('\n').filter(Boolean).map((line) => `-${line}`),
    ...newText.split('\n').filter(Boolean).map((line) => `+${line}`),
    '',
  ].join('\n')
}

async function gitDiff(cwd: string): Promise<string> {
  let trackedDiff = ''
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], { cwd, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 })
    trackedDiff = stdout
  } catch {
    return ''
  }
  const untrackedDiff = await gitUntrackedDiff(cwd)
  return [trackedDiff, untrackedDiff].filter(Boolean).join('\n')
}

async function gitUntrackedDiff(cwd: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    const paths = stdout.split('\0').filter(Boolean).slice(0, 50)
    const diffs: string[] = []
    for (const path of paths) {
      const bytes = await readFile(`${cwd}/${path}`)
      if (bytes.includes(0)) continue
      diffs.push(addedFileDiff(path, bytes.toString('utf8')))
    }
    return diffs.join('\n')
  } catch {
    return ''
  }
}

function addedFileDiff(path: string, text: string): string {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n')
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('rg', ['--files'], { cwd: root, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 })
    return stdout.split('\n').filter(Boolean)
  } catch {
    try {
      const { stdout } = await execFileAsync('find', ['.', '-type', 'f'], { cwd: root, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 })
      return stdout.split('\n').filter(Boolean).map((path) => path.replace(/^\.\//, ''))
    } catch {
      return []
    }
  }
}
