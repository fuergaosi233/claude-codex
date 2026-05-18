import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  ClaudeRuntime,
  FileUpdateChange,
  ImageInput,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionDecision,
  RpcPeer,
  RuntimeEvent,
  ThreadItem,
  ThreadRecord,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnRecord,
  UserInput,
  WireMessage,
} from './types.mjs'
import { SessionStore } from './store.mjs'
import { callMcpTool, readMcpConfig, readMcpResource } from './mcp.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'
import {
  claudeOutputFormat,
  codexCliVersion,
  defaultAllowedTools,
  debugLog,
  claudeModelOptions,
  adapterHome,
  codexHome,
  codexUserAgent,
  ensureParent,
  extractImageInputs,
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
  private tokenUsageByThread = new Map<string, TokenUsageBreakdown>()
  private configModel = defaultSelectableModelId()
  private configReasoningEffort = normalizeCodexReasoningEffort(process.env.CLAUDE_CODEX_DEFAULT_EFFORT) ?? 'medium'
  private readonly configPath = join(adapterHome(), 'config.json')
  private idleCheckHandler: (() => void) | null = null
  private stopped = false

  constructor(
    private store: SessionStore,
    private runtime: ClaudeRuntime,
  ) {
    this.loadPersistedConfig()
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if ('method' in message && message.method) {
      debugLog('rpc.request', {
        peerId: peer.id,
        id: 'id' in message ? message.id : null,
        method: message.method,
        params: summarizeRpcParams(message.method, message.params),
      })
      if ('id' in message) {
        await this.handleRequest(peer, message as JsonRpcRequest)
      } else {
        await this.handleNotification(peer, message)
      }
      return
    }
    if ('id' in message) {
      debugLog('rpc.responseFromClient', { peerId: peer.id, id: message.id, hasError: Boolean((message as JsonRpcResponse).error) })
      this.resolveServerRequest(message as JsonRpcResponse)
    }
  }

  closePeer(peer: RpcPeer): void {
    debugLog('peer.close', { peerId: peer.id })
    for (const [threadId, activePeer] of this.activePeerByThread.entries()) {
      if (activePeer.id === peer.id) this.activePeerByThread.delete(threadId)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.runtime.stop()
    this.completeActiveTurns('interrupted', { message: 'server stopped' })
    this.store.close()
  }

  hasActiveTurns(): boolean {
    return this.activeTurnByThread.size > 0
  }

  setIdleCheckHandler(handler: () => void): void {
    this.idleCheckHandler = handler
  }

  private async handleNotification(_peer: RpcPeer, _message: WireMessage): Promise<void> {
    // Currently only `initialized` is expected from clients.
  }

  private async handleRequest(peer: RpcPeer, request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(peer, request.method, request.params ?? {})
      debugLog('rpc.response', { peerId: peer.id, id: request.id, method: request.method, ok: true })
      this.sendResponse(peer, request.id, result)
    } catch (error) {
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      })
      this.sendResponse(peer, request.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async dispatch(peer: RpcPeer, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        const initParams = asRecord(params)
        const clientInfo = asRecord(initParams.clientInfo)
        return {
          userAgent: codexUserAgent(stringOr(clientInfo.name, 'codex-app'), stringOr(clientInfo.version, 'unknown')),
          codexHome: codexHome(),
          platformFamily: platformFamily(),
          platformOs: platformOs(),
        }
      case 'thread/start':
        return this.threadStart(peer, asRecord(params))
      case 'thread/resume':
        return this.threadResume(peer, asRecord(params))
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
      // Intentional no-ops: Claude Code has no equivalent concept, so the
      // adapter acknowledges the call without side effects rather than failing
      // the RPC (which would break the Codex App connection).
      case 'thread/memoryMode/set':
      case 'memory/reset':
        return {}
      case 'thread/unarchive':
        return this.threadArchive(asRecord(params), false)
      case 'thread/compact/start':
        return this.threadCompactStart(peer, asRecord(params))
      case 'thread/shellCommand':
        return this.threadShellCommand(peer, asRecord(params))
      case 'thread/approveGuardianDeniedAction':
        return {}
      case 'thread/backgroundTerminals/clean':
        return this.threadBackgroundTerminalsClean(asRecord(params))
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
        return this.turnInterrupt(peer, asRecord(params))
      // Realtime voice is unsupported: Claude Code has no realtime audio
      // channel. These ack so the App's capability probe does not error; a
      // real session would need a separate audio backend.
      case 'thread/realtime/start':
      case 'thread/realtime/appendAudio':
      case 'thread/realtime/appendText':
      case 'thread/realtime/stop':
        return {}
      case 'thread/realtime/listVoices':
        return { voices: { v1: [], v2: [], defaultV1: null, defaultV2: null } }
      case 'review/start':
        return this.reviewStart(peer, asRecord(params))
      case 'config/read':
        return this.configRead()
      case 'configRequirements/read':
        return { requirements: null }
      case 'model/list':
        return this.modelList()
      case 'modelProvider/capabilities/read':
        return {
          namespaceTools: true,
          imageGeneration: false,
          // Claude Code SDK ships a WebSearch tool. Default to advertising it
          // so Codex App shows the search affordance; CLAUDE_CODEX_WEBSEARCH=0
          // turns it off for environments where the tool is rate-limited.
          webSearch: process.env.CLAUDE_CODEX_WEBSEARCH !== '0',
        }
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
        // The App applies its OpenAI hidden-model allowlist unless auth is
        // Bedrock-shaped. Claude Code is externally authenticated, so use that
        // local auth shape to keep Claude aliases visible in the model picker.
        return { account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false }
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
      // Stateful fuzzy-search sessions are not implemented; the one-shot
      // `fuzzyFileSearch` above already covers the App's file picker needs.
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
    const model = modelFromParams(params, this.configModel)
    const reasoningEffort = reasoningEffortFromParams(params, this.configReasoningEffort)
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
      approvalPolicy: normalizeApprovalPolicy(params.approvalPolicy),
      sandboxMode: normalizeSandboxMode(params.sandbox),
      ephemeral: params.ephemeral === true,
      threadSource: typeof params.threadSource === 'string' ? params.threadSource : null,
      agentRole: typeof params.agentRole === 'string' ? params.agentRole : null,
      agentNickname: typeof params.agentNickname === 'string' ? params.agentNickname : null,
      baseInstructions: typeof params.baseInstructions === 'string' ? params.baseInstructions : null,
      developerInstructions: typeof params.developerInstructions === 'string' ? params.developerInstructions : null,
      personality: normalizePersonality(params.personality),
    }
    this.store.upsertThread(thread)
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread)
  }

  private threadResume(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const model = modelFromParams(params, null)
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (model) thread.model = model
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (typeof params.approvalPolicy === 'string') thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    if (typeof params.sandbox === 'string') thread.sandboxMode = normalizeSandboxMode(params.sandbox)
    if (typeof params.threadSource === 'string') thread.threadSource = params.threadSource
    if (typeof params.baseInstructions === 'string') thread.baseInstructions = params.baseInstructions
    if (typeof params.developerInstructions === 'string') thread.developerInstructions = params.developerInstructions
    if (typeof params.personality === 'string') thread.personality = normalizePersonality(params.personality)
    this.store.upsertThread(thread)
    this.activePeerByThread.set(threadId, peer)
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
      model: modelFromParams(params, parent.model),
      reasoningEffort: reasoningEffortFromParams(params, parent.reasoningEffort),
      claudeSessionId: parent.claudeSessionId,
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy: typeof params.approvalPolicy === 'string'
        ? normalizeApprovalPolicy(params.approvalPolicy)
        : parent.approvalPolicy,
      sandboxMode: typeof params.sandbox === 'string'
        ? normalizeSandboxMode(params.sandbox)
        : parent.sandboxMode,
      ephemeral: parent.ephemeral,
      threadSource: typeof params.threadSource === 'string' ? params.threadSource : parent.threadSource,
      agentRole: typeof params.agentRole === 'string' ? params.agentRole : parent.agentRole,
      agentNickname: typeof params.agentNickname === 'string' ? params.agentNickname : parent.agentNickname,
      baseInstructions: typeof params.baseInstructions === 'string' ? params.baseInstructions : parent.baseInstructions,
      developerInstructions: typeof params.developerInstructions === 'string' ? params.developerInstructions : parent.developerInstructions,
      personality: typeof params.personality === 'string' ? normalizePersonality(params.personality) : parent.personality,
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
      includeEphemeral: params.includeEphemeral === true,
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
    if (!thread) throw new Error('unknown thread: ' + threadId)
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
    this.clearThreadState(threadId)
    return {}
  }

  // Drops per-thread in-memory state (session-scoped command approvals, token
  // usage tallies, goals, elicitation counts) so an archived thread does not
  // leak entries for the lifetime of the process.
  private clearThreadState(threadId: string): void {
    this.commandSessionAllow.delete(threadId)
    this.tokenUsageByThread.delete(threadId)
    this.goals.delete(threadId)
    this.elicitationCounts.delete(threadId)
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
    debugLog('thread.shellCommand.start', { threadId, processId, cwd, command })
    const child = spawn(shell, ['-lc', command], { cwd, env: process.env, stdio: 'pipe' })
    this.commandProcesses.set(processId, child)
    child.stdout?.on('data', (chunk) => this.notify(peer, { method: 'command/exec/outputDelta', params: { processId, stream: 'stdout', deltaBase64: Buffer.from(chunk).toString('base64'), capReached: false } }))
    child.stderr?.on('data', (chunk) => this.notify(peer, { method: 'command/exec/outputDelta', params: { processId, stream: 'stderr', deltaBase64: Buffer.from(chunk).toString('base64'), capReached: false } }))
    child.once('error', (error) => debugLog('thread.shellCommand.error', { threadId, processId, error: error.message }))
    child.once('close', (code, signal) => {
      debugLog('thread.shellCommand.close', { threadId, processId, code, signal })
      this.commandProcesses.delete(processId)
    })
    return {}
  }

  private threadBackgroundTerminalsClean(params: Record<string, unknown>): unknown {
    debugLog('thread.backgroundTerminals.clean', {
      threadId: stringOr(params.threadId, ''),
      activeCommandProcesses: this.commandProcesses.size,
      activeProcessHandles: this.processHandles.size,
    })
    return {}
  }

  private reviewStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    this.activePeerByThread.set(threadId, peer)
    const turnId = newId()
    const review = reviewLabel(params.target)
    const prompt = reviewPrompt(params.target)
    const userItem: ThreadItem = { type: 'userMessage', id: turnId, content: [{ type: 'text', text: review, text_elements: [] }] }
    const entered: ThreadItem = { type: 'enteredReviewMode', id: newId(), review }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [userItem, entered],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    this.activeTurnByThread.set(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toTurn(turn)
    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      this.notify(peer, { method: 'item/started', params: { threadId, turnId, item: entered, startedAtMs: nowMillis() } })
      void this.runRuntimeTurn(peer, thread, turn, prompt, { model: thread.model, effort: thread.reasoningEffort }).catch((error) => {
        const completed = this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        this.notify(peer, { method: 'error', params: { threadId, turnId, willRetry: false, error: { message: error.message } } })
        this.notify(peer, { method: 'turn/completed', params: { threadId, turn: this.toTurn(completed) } })
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: publicTurn, reviewThreadId: threadId }
  }

  private threadCompactStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const turnId = newId()
    const compactItem: ThreadItem = { type: 'contextCompaction', id: newId() }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [compactItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    this.activeTurnByThread.set(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toTurn(turn)
    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      this.notify(peer, { method: 'item/started', params: { threadId, turnId, item: compactItem, startedAtMs: nowMillis() } })
      const agentItem: ThreadItem = { type: 'agentMessage', id: newId(), text: '', phase: null, memoryCitation: null }
      this.store.appendItem(turnId, agentItem)
      this.notify(peer, { method: 'item/started', params: { threadId, turnId, item: agentItem, startedAtMs: nowMillis() } })

      // Drive an actual Claude (summary model) turn to compact the thread
      // instead of just stringifying the last 12 snippets locally — the
      // local fallback still kicks in if the runtime errors.
      void this.runCompactTurn(peer, thread, turnId, agentItem.id, compactItem)
        .catch((error) => {
          debugLog('thread.compact.fallback', { threadId, error: error?.message ?? String(error) })
          const fallback = compactSummary(thread, this.store.listTurns(threadId))
          this.store.updateItem(turnId, agentItem.id, (item) =>
            item.type === 'agentMessage' ? { ...item, text: fallback } : item,
          )
          this.notify(peer, { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: agentItem.id, delta: fallback } })
        })
        .finally(() => {
          this.notify(peer, { method: 'item/completed', params: { threadId, turnId, item: compactItem, completedAtMs: nowMillis() } })
          const finalAgent = this.store.getTurn(turnId)?.items.find((i) => i.id === agentItem.id) ?? agentItem
          this.notify(peer, { method: 'item/completed', params: { threadId, turnId, item: finalAgent, completedAtMs: nowMillis() } })
          const completed = this.store.completeTurn(turnId, 'completed') ?? turn
          this.clearActiveTurn(threadId)
          this.setThreadStatus(peer, threadId, { type: 'idle' })
          this.notify(peer, { method: 'turn/completed', params: { threadId, turn: this.toTurn(completed) } })
          this.notify(peer, { method: 'thread/compacted', params: { threadId } })
        })
    })
    return {}
  }

  // Calls into the runtime with a structured "give me a 1-paragraph summary"
  // prompt against the summary model alias (haiku). Streams the text into the
  // placeholder agent message via item/agentMessage/delta. Errors propagate
  // so the threadCompactStart fallback can substitute the local snippet.
  private async runCompactTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turnId: string,
    agentItemId: string,
    compactItem: ThreadItem,
  ): Promise<void> {
    const turns = this.store.listTurns(thread.id)
    const promptBody = compactSummary(thread, turns)
    const compactPrompt = [
      'You are summarizing a Codex / Claude Code conversation so the user can keep context after compaction.',
      'Produce ONE concise paragraph (≤ 6 sentences) covering goals, decisions, files touched, and outstanding work.',
      'Skip greetings; do not invent details that are not in the snippets below.',
      '',
      promptBody,
    ].join('\n')

    let collected = ''
    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId,
        purpose: 'compact',
        prompt: compactPrompt,
        cwd: thread.cwd,
        runtimeType: null,
        model: resolveClaudeModel(thread.model, 'summary'),
        effort: resolveClaudeEffort(thread.reasoningEffort ?? null),
        claudeSessionId: null,
        forkSession: false,
        mcpServers: null,
        allowedTools: ['Read', 'Glob', 'Grep'],
        addDirs: [],
        enableFileCheckpointing: false,
        outputFormat: null,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: async (event) => {
          if (event.type === 'text_delta' && event.delta) {
            collected += event.delta
            this.store.updateItem(turnId, agentItemId, (item) =>
              item.type === 'agentMessage' ? { ...item, text: item.text + event.delta } : item,
            )
            this.notify(peer, { method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId, itemId: agentItemId, delta: event.delta } })
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'completed' && !event.success) {
            throw new Error(event.result ?? 'compaction turn failed')
          }
        },
        // Compaction never asks for approvals — it's read-only summarisation.
        onPermissionRequest: async () => ({ decision: 'accept' }),
      },
    )

    // If Claude produced nothing usable, surface the local fallback so the
    // caller's catch path runs and the user still gets a summary.
    if (!collected.trim()) {
      void compactItem
      throw new Error('compaction returned no content')
    }
  }

  private async turnStart(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    this.activePeerByThread.set(threadId, peer)

    const turnId = newId()
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    // extractImageInputs splits user input into the text prompt and any image
    // attachments (localImage / image URL / data:). Sidecar repacks the
    // images into a Claude SDK multimodal user message; here we also append
    // an `imageView` ThreadItem per image so the App's transcript shows them
    // inline next to the user message instead of losing them.
    const { textPrompt, images } = extractImageInputs(input)
    const prompt = textPrompt || textFromInput(input)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const model = modelFromParams(params, this.configModel)
    const reasoningEffort = reasoningEffortFromParams(params, this.configReasoningEffort)
    if (model) thread.model = model
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    this.store.upsertThread(thread)
    if (!thread.preview && prompt) {
      thread.preview = prompt.slice(0, 200)
      thread.updatedAt = nowSeconds()
      this.store.upsertThread(thread)
    }
    const initialItems: ThreadItem[] = [{ type: 'userMessage', id: newId(), content: input }]
    for (const img of images) {
      initialItems.push({ type: 'imageView', id: newId(), path: img.displayPath })
    }
    // Note: we used to short-circuit Codex App's title-generation turn with a
    // local regex-derived title to avoid prompt leakage into the parent thread.
    // That leakage no longer happens (title turns run on their own ephemeral
    // thread, filtered from listings), so the short-circuit was just forcing a
    // hardcoded "处理X" string instead of the real model output. Now every turn
    // — including the structured title turn on Claude Haiku — runs end-to-end.
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: initialItems,
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    this.activeTurnByThread.set(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toTurn(turn)

    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      // Carry parsed images through the params bag so runRuntimeTurn can hand
      // them to the runtime context without re-parsing user input.
      void this.runRuntimeTurn(peer, thread, turn, prompt, { ...params, _imageInputs: images }).catch((error) => {
      const completed = this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
      this.notify(peer, { method: 'error', params: { threadId, turnId, willRetry: false, error: { message: error.message } } })
      this.notify(peer, { method: 'turn/completed', params: { threadId, turn: this.toTurn(completed) } })
      this.clearActiveTurn(threadId)
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
    const commandOutputSeen = new Set<string>()
    // Codex's native subagent rendering is a sequence of three
    // collabAgentToolCall lifecycle pairs in the parent timeline:
    //   spawnAgent (begin → end)  – "spawning the agent"
    //   wait        (begin → end)  – the agent is working (covers runtime)
    //   closeAgent (begin → end)  – the agent finished
    // Together they tell Codex App which child thread to navigate into and
    // give the user a live "agent is running" indicator instead of a single
    // collapsed item that goes silent for the duration of the subagent.
    const subagentContexts = new Map<string, { childThreadId: string; waitItemId: string; prompt: string; subType: string | null }>()
    const activeSubagents = new Set<string>()
    // Mutable holder rather than `let collectedMetrics`: TS's control-flow
    // analysis doesn't see writes from inside the onEvent callback, so a bare
    // `let` would still be inferred as `null` outside the closure.
    const collectedMetrics: { apiDurationMs: number | null; numTurns: number | null; costUsd: number | null; set: boolean } = {
      apiDurationMs: null,
      numTurns: null,
      costUsd: null,
      set: false,
    }
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

    // Allow per-turn override of policy (Codex App may attach updated values
    // when the user toggles Full access mid-conversation), then fall back to
    // the thread-level setting captured at start/resume. turn/start ships a
    // sandboxPolicy struct (e.g. {type:"dangerFullAccess"}); thread/start uses
    // the simpler sandbox string. Both are honoured.
    const approvalPolicy =
      (typeof params.approvalPolicy === 'string' ? normalizeApprovalPolicy(params.approvalPolicy) : null) ??
      thread.approvalPolicy
    const sandboxMode = sandboxFromTurnParams(params) ?? thread.sandboxMode
    // Per-turn instruction overrides: Codex App may resend its instruction
    // panel state when the user toggles personality mid-thread. Falls back to
    // whatever was captured at thread/start.
    const baseInstructions =
      (typeof params.baseInstructions === 'string' ? params.baseInstructions : null) ?? thread.baseInstructions
    const developerInstructions =
      (typeof params.developerInstructions === 'string' ? params.developerInstructions : null) ??
      thread.developerInstructions
    const personality =
      (typeof params.personality === 'string' ? normalizePersonality(params.personality) : null) ??
      thread.personality
    const systemPromptAddendum = buildSystemPromptAddendum({
      baseInstructions,
      developerInstructions,
      personality,
    })
    const selectedModel = stringOr(params.model, thread.model)
    const turnPurpose = params.outputSchema == null ? 'normal' : 'summary'

    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        purpose: turnPurpose,
        prompt,
        cwd: stringOr(params.cwd, thread.cwd),
        runtimeType: null,
        model: resolveClaudeModel(selectedModel, turnPurpose),
        effort: resolveClaudeEffort(
          typeof params.effort === 'string' ? params.effort : thread.reasoningEffort ?? process.env.CLAUDE_CODEX_EFFORT ?? null,
        ),
        claudeSessionId: thread.claudeSessionId,
        forkSession,
        mcpServers: readMcpConfig().sdkValue,
        allowedTools: defaultAllowedTools(),
        addDirs: stringListFromEnv('CLAUDE_CODEX_ADD_DIRS', []),
        enableFileCheckpointing: process.env.CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING === '1',
        outputFormat: claudeOutputFormat(params.outputSchema),
        approvalPolicy,
        sandboxMode,
        systemPromptAddendum,
        planMode: params.planMode === true,
        imageInputs: Array.isArray(params._imageInputs) ? (params._imageInputs as ImageInput[]) : [],
      },
      {
        onEvent: async (event) => {
          if (event.type === 'session') {
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            return
          }
          if (activeSubagents.size > 0) {
            if (event.type === 'text_delta' || event.type === 'reasoning_delta') return
            if (event.type === 'tool_use' && event.toolName !== 'Task') return
            if (event.type === 'tool_output_delta' && !itemIds.has(event.toolUseId)) return
            if (event.type === 'tool_result' && !activeSubagents.has(event.toolUseId) && !itemIds.has(event.toolUseId)) return
          }
          if (event.type === 'tool_use' && event.toolName === 'Task') {
            // Spawn the ephemeral subagent thread, then mirror Codex's native
            // 3-stage timeline: `spawnAgent` (begin+end), `wait` (begin only,
            // closes when the Task tool_result lands), and later `closeAgent`.
            //
            // Concept alignment: Claude's `subagent_type` (e.g. "general-
            // purpose") is the same idea as Codex's `agentRole`; we also
            // generate an `agentNickname` matching the `agent-{12hex}` shape
            // Claude itself uses internally so the App's subagent UI shows a
            // distinct, repeatable handle. The collabAgentToolCall.model
            // field carries the actual SDK model the subagent runs on, NOT
            // the subagent_type — that distinction was wrong before.
            const promptText = String(event.input.prompt ?? event.input.description ?? '')
            const subType = typeof event.input.subagent_type === 'string' ? event.input.subagent_type : null
            const subagentModel = typeof event.input.model === 'string' ? event.input.model : thread.model
            const childThreadId = newId()
            const agentNickname = `agent-${childThreadId.replace(/-/g, '').slice(0, 12)}`
            const agentRole = subType ?? 'general-purpose'
            const childThread: ThreadRecord = {
              id: childThreadId,
              sessionId: thread.sessionId,
              forkedFromId: thread.id,
              preview: promptText.slice(0, 200),
              name: null,
              archived: false,
              cwd: thread.cwd,
              model: subagentModel,
              reasoningEffort: thread.reasoningEffort,
              modelProvider: thread.modelProvider,
              claudeSessionId: null,
              source: thread.source,
              createdAt: nowSeconds(),
              updatedAt: nowSeconds(),
              status: { type: 'active', activeFlags: [] },
              approvalPolicy: thread.approvalPolicy,
              sandboxMode: thread.sandboxMode,
              ephemeral: true,
              threadSource: 'subagent',
              agentRole,
              agentNickname,
              // Subagent inherits parent's instruction surface so the same
              // project/developer guidance applies to the child run.
              baseInstructions: thread.baseInstructions,
              developerInstructions: thread.developerInstructions,
              personality: thread.personality,
            }
            this.store.upsertThread(childThread)

            // Stage 1 — spawnAgent (begin + end emitted together; the agent is
            // already created so there's no real latency here).
            const spawnId = newId()
            const spawnBegin: ThreadItem = {
              type: 'collabAgentToolCall', id: spawnId, tool: 'spawnAgent',
              status: 'inProgress', senderThreadId: thread.id, receiverThreadIds: [],
              prompt: promptText || null, model: subagentModel,
              reasoningEffort: thread.reasoningEffort, agentsStates: {},
            }
            this.store.appendItem(turn.id, spawnBegin)
            this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: spawnBegin, startedAtMs: nowMillis() } })
            const spawnEnd: ThreadItem = {
              type: 'collabAgentToolCall', id: spawnId, tool: 'spawnAgent',
              status: 'completed', senderThreadId: thread.id, receiverThreadIds: [childThreadId],
              prompt: promptText || null, model: subagentModel,
              reasoningEffort: thread.reasoningEffort,
              agentsStates: { [childThreadId]: { status: 'running', message: null } },
            }
            this.store.updateItem(turn.id, spawnId, () => spawnEnd)
            this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: spawnEnd, completedAtMs: nowMillis() } })

            // Stage 2 — wait (begin only; this is the long phase that gives
            // Codex App its "agent is working" indicator while the subagent
            // runs. It closes when the Task tool_result arrives.)
            const waitId = newId()
            const waitBegin: ThreadItem = {
              type: 'collabAgentToolCall', id: waitId, tool: 'wait',
              status: 'inProgress', senderThreadId: thread.id, receiverThreadIds: [childThreadId],
              prompt: null, model: null, reasoningEffort: null, agentsStates: {},
            }
            this.store.appendItem(turn.id, waitBegin)
            this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: waitBegin, startedAtMs: nowMillis() } })

            itemIds.set(event.toolUseId, waitId)
            subagentContexts.set(event.toolUseId, { childThreadId, waitItemId: waitId, prompt: promptText, subType })
            activeSubagents.add(event.toolUseId)
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
            activeSubagents.delete(event.toolUseId)
            subagentContexts.delete(event.toolUseId)
            if (!ctx) return
            const resultText = toolResultText(event.content)
            const collabStatus: 'completed' | 'failed' = event.isError ? 'failed' : 'completed'
            const agentStatus: 'completed' | 'errored' = event.isError ? 'errored' : 'completed'

            // Materialize a one-turn transcript on the child thread so the
            // Codex App can drill in from the parent collabAgentToolCall.
            const childTurn: TurnRecord = {
              id: newId(),
              threadId: ctx.childThreadId,
              status: event.isError ? 'failed' : 'completed',
              startedAt: nowSeconds(),
              completedAt: nowSeconds(),
              durationMs: 0,
              items: [
                { type: 'userMessage', id: newId(), content: [{ type: 'text', text: ctx.prompt, text_elements: [] }] },
                { type: 'agentMessage', id: newId(), text: resultText, phase: null, memoryCitation: null },
              ],
              diff: '',
              error: event.isError ? { message: 'subagent failed' } : null,
            }
            this.store.upsertTurn(childTurn)
            const childThread = this.store.getThread(ctx.childThreadId)
            if (childThread) {
              childThread.status = { type: 'idle' }
              childThread.updatedAt = nowSeconds()
              this.store.upsertThread(childThread)
            }

            // Stage 2 close — wait (end). Re-emits the same waitItemId.
            const waitEnd: ThreadItem = {
              type: 'collabAgentToolCall', id: ctx.waitItemId, tool: 'wait',
              status: collabStatus, senderThreadId: thread.id, receiverThreadIds: [ctx.childThreadId],
              prompt: null, model: null, reasoningEffort: null,
              agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
            }
            this.store.updateItem(turn.id, ctx.waitItemId, () => waitEnd)
            this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: waitEnd, completedAtMs: nowMillis() } })

            // Stage 3 — closeAgent (begin + end emitted together; the SDK has
            // already torn down the subagent by the time we get the result).
            const closeId = newId()
            const closeBegin: ThreadItem = {
              type: 'collabAgentToolCall', id: closeId, tool: 'closeAgent',
              status: 'inProgress', senderThreadId: thread.id, receiverThreadIds: [ctx.childThreadId],
              prompt: null, model: null, reasoningEffort: null, agentsStates: {},
            }
            this.store.appendItem(turn.id, closeBegin)
            this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: closeBegin, startedAtMs: nowMillis() } })
            const closeEnd: ThreadItem = {
              type: 'collabAgentToolCall', id: closeId, tool: 'closeAgent',
              status: collabStatus, senderThreadId: thread.id, receiverThreadIds: [ctx.childThreadId],
              prompt: null, model: null, reasoningEffort: null,
              agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
            }
            this.store.updateItem(turn.id, closeId, () => closeEnd)
            this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: closeEnd, completedAtMs: nowMillis() } })
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
            if (event.delta.length === 0) return
            const itemId = ensureReasoningItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'reasoning') {
                return {
                  ...item,
                  summary: [(item.summary[0] ?? '') + event.delta],
                  content: [(item.content[0] ?? '') + event.delta],
                }
              }
              return item
            })
            this.notify(peer, {
              method: 'item/reasoning/summaryTextDelta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta, summaryIndex: 0 },
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
            commandOutputSeen.add(itemId)
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
            const resultText = toolResultText(event.content)
            const updated = this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  aggregatedOutput: item.aggregatedOutput ?? resultText,
                  exitCode: event.isError ? 1 : 0,
                }
              }
              if (item.type === 'fileChange') return { ...item, status: event.isError ? 'failed' : 'completed' }
              if (item.type === 'mcpToolCall') {
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  result: event.isError ? null : event.content,
                  error: event.isError ? event.content : null,
                }
              }
              if (item.type === 'webSearch') {
                return { ...item, action: parseWebSearchAction(item.query, resultText) }
              }
              return item
            })
            const item = updated?.items.find((candidate) => candidate.id === itemId)
            if (item?.type === 'commandExecution' && resultText && !commandOutputSeen.has(itemId)) {
              this.notify(peer, { method: 'item/commandExecution/outputDelta', params: { threadId: thread.id, turnId: turn.id, itemId, delta: resultText } })
            }
            if (item) this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() } })
            const diff = await gitDiff(thread.cwd)
            if (diff) {
              this.store.updateTurnDiff(turn.id, diff)
              this.notify(peer, { method: 'turn/diff/updated', params: { threadId: thread.id, turnId: turn.id, diff } })
            }
            return
          }
          if (event.type === 'notice') {
            const itemId = ensureAgentItem()
            const prefix = event.level === 'warning' ? '[Claude warning] ' : event.level === 'error' ? '[Claude error] ' : '[Claude event] '
            const delta = prefix + event.message + '\n'
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'agentMessage') return { ...item, text: item.text + delta }
              return item
            })
            this.notify(peer, { method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId, delta } })
            return
          }
          if (event.type === 'usage') {
            this.recordTokenUsage(peer, thread.id, turn.id, event.usage)
            return
          }
          if (event.type === 'hook') {
            // Render the hook event as a Codex hookPrompt item alongside the
            // (still-emitted) notice line, so the user sees structured hook
            // activity in the timeline instead of just a one-liner warning.
            const fragments: Array<{ kind: 'text' | 'note'; text: string }> = [
              { kind: 'text', text: `Hook · ${event.hookName}` },
            ]
            if (event.status) fragments.push({ kind: 'note', text: `status: ${event.status}` })
            if (event.decision) fragments.push({ kind: 'note', text: `decision: ${event.decision}` })
            if (event.message) fragments.push({ kind: 'text', text: event.message })
            const hookItem: ThreadItem = { type: 'hookPrompt', id: newId(), fragments }
            this.store.appendItem(turn.id, hookItem)
            this.notify(peer, { method: 'item/started', params: { threadId: thread.id, turnId: turn.id, item: hookItem, startedAtMs: nowMillis() } })
            this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item: hookItem, completedAtMs: nowMillis() } })
            return
          }
          if (event.type === 'metrics') {
            // Track metrics on the runRuntimeTurn closure rather than in the
            // SQLite turns row (which doesn't have these columns). They get
            // merged into the final TurnRecord shipped via turn/completed.
            collectedMetrics.apiDurationMs = event.apiDurationMs
            collectedMetrics.numTurns = event.numTurns
            collectedMetrics.costUsd = event.costUsd
            collectedMetrics.set = true
            return
          }
          if (event.type === 'completed') {
            if (event.claudeSessionId) this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            if (!event.success) throw new Error(event.result ?? 'Claude turn failed')
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
    if (params.outputSchema != null && agentItemId == null) {
      const text = fallbackStructuredText(params.outputSchema, prompt)
      const itemId = ensureAgentItem()
      this.store.updateItem(turn.id, itemId, (item) => {
        if (item.type === 'agentMessage') return { ...item, text }
        return item
      })
      this.notify(peer, { method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId, delta: text } })
    }
    const latestTurn = this.store.getTurn(turn.id)
    for (const completedItemId of [reasoningItemId, agentItemId]) {
      const item = latestTurn?.items.find((candidate) => candidate.id === completedItemId)
      if (item) this.notify(peer, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() } })
    }
    const completed: TurnRecord = this.store.completeTurn(turn.id, 'completed') ?? turn
    if (collectedMetrics.set) {
      completed.apiDurationMs = collectedMetrics.apiDurationMs
      completed.numTurns = collectedMetrics.numTurns
      completed.costUsd = collectedMetrics.costUsd
    }
    this.clearActiveTurn(thread.id)
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
    // Defensive: if Codex App selected approvalPolicy=never (or "Full access"
    // sandbox), auto-accept without bouncing the request to the user. The
    // sidecar already drops can_use_tool in those modes, but in case some
    // future SDK path still emits permission_request, this prevents the
    // adapter from sitting on "Awaiting approval" forever.
    const thread = this.store.getThread(threadId)
    if (thread && (thread.approvalPolicy === 'never' || thread.sandboxMode === 'danger-full-access')) {
      return { decision: 'accept' }
    }
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

  private async turnInterrupt(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const requestedTurnId = stringOr(params.turnId, '')
    const activeTurnId = this.activeTurnByThread.get(threadId)
    await this.runtime.interrupt(threadId)
    const turnId = activeTurnId || requestedTurnId
    if (turnId) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        const completed = this.store.completeTurn(turnId, 'interrupted', { message: 'interrupted' }) ?? turn
        this.notify(peer, { method: 'turn/completed', params: { threadId, turn: this.toTurn(completed) } })
      }
    }
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
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
        model: this.configModel,
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
        model_reasoning_effort: this.configReasoningEffort,
        model_reasoning_summary: null,
        model_verbosity: null,
        service_tier: null,
        analytics: null,
        apps: null,
        model_providers: {
          'claude-code': {
            name: 'Claude Code',
            base_url: null,
            env_key: null,
            env_key_instructions: null,
            experimental_bearer_token: null,
            auth: null,
            aws: null,
            wire_api: 'responses',
            query_params: null,
            http_headers: null,
            env_http_headers: null,
            request_max_retries: null,
            stream_max_retries: null,
            stream_idle_timeout_ms: null,
            websocket_connect_timeout_ms: null,
            requires_openai_auth: false,
            supports_websockets: false,
          },
        },
      },
      origins: {
        model_provider: configLayerMetadata(),
        'model_providers.claude-code': configLayerMetadata(),
      },
      layers: null,
    }
  }

  private modelList(): unknown {
    const defaultModel = this.configModel
    const options = claudeModelOptions()
    const hasConfiguredDefault = options.some((option) => option.id === defaultModel)
    const reasoningEfforts = [
      { reasoningEffort: 'low', description: 'Fast Claude Code runtime response' },
      { reasoningEffort: 'medium', description: 'Balanced Claude Code runtime response' },
      { reasoningEffort: 'high', description: 'Deeper Claude Code runtime response' },
      { reasoningEffort: 'xhigh', description: 'Maximum Codex UI reasoning level for Claude Code' },
    ]
    return {
      data: options.map((option) => ({
        id: option.id,
        model: option.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: option.displayName,
        description: option.description,
        hidden: false,
        supportedReasoningEfforts: reasoningEfforts,
        defaultReasoningEffort: this.configReasoningEffort,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        isDefault: hasConfiguredDefault ? option.id === defaultModel : option.isDefault === true,
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

  // Accumulates Claude Agent SDK token usage per thread and pushes a
  // `thread/tokenUsage/updated` notification so the Codex App can render real
  // consumption instead of leaving the meter blank.
  private recordTokenUsage(peer: RpcPeer, threadId: string, turnId: string, usage: Record<string, unknown>): void {
    const last = tokenBreakdownFromClaudeUsage(usage)
    if (last.totalTokens === 0) return
    const prior = this.tokenUsageByThread.get(threadId) ?? emptyTokenBreakdown()
    const total: TokenUsageBreakdown = {
      totalTokens: prior.totalTokens + last.totalTokens,
      inputTokens: prior.inputTokens + last.inputTokens,
      cachedInputTokens: prior.cachedInputTokens + last.cachedInputTokens,
      outputTokens: prior.outputTokens + last.outputTokens,
      reasoningOutputTokens: prior.reasoningOutputTokens + last.reasoningOutputTokens,
    }
    this.tokenUsageByThread.set(threadId, total)
    const tokenUsage: ThreadTokenUsage = { total, last, modelContextWindow: null }
    this.notify(peer, { method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage } })
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
    const command = commandArray(params.command)
    if (command.length === 0) throw new Error('command/exec requires command')
    if ((params.streamStdoutStderr === true || params.streamStdin === true || params.tty === true) && typeof params.processId !== 'string') {
      throw new Error('command/exec streaming requires processId')
    }

    const executable = command[0] as string
    const streamOutput = params.streamStdoutStderr === true || params.tty === true
    const cwd = stringOr(params.cwd, process.cwd())
    debugLog('command.exec.start', { processId, cwd, command, streamOutput, streamStdin: params.streamStdin === true, tty: params.tty === true })
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
        debugLog('command.exec.error', { processId, error: error.message, code: (error as NodeJS.ErrnoException).code })
        if (timeout) clearTimeout(timeout)
        this.commandProcesses.delete(processId)
        reject(error)
      })
      child.once('close', (code, signal) => {
        debugLog('command.exec.close', { processId, code, signal, stdoutBytes, stderrBytes })
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
    const command = commandArray(params.command)
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
    let exited = false
    debugLog('process.spawn.start', { processHandle, cwd, command, streamOutput, streamStdin: params.streamStdin === true, tty: params.tty === true })
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
    child.once('error', (error) => {
      debugLog('process.spawn.error', { processHandle, error: error.message, code: (error as NodeJS.ErrnoException).code })
      if (exited) return
      exited = true
      if (timeout) clearTimeout(timeout)
      this.processHandles.delete(processHandle)
      setImmediate(() => this.notify(peer, {
        method: 'process/exited',
        params: {
          processHandle,
          exitCode: 1,
          stdout: streamOutput ? '' : Buffer.concat(stdout).toString('utf8'),
          stdoutCapReached,
          stderr: error.message,
          stderrCapReached: false,
        },
      }))
    })
    child.once('close', (code, signal) => {
      if (exited) return
      exited = true
      debugLog('process.spawn.close', { processHandle, code, signal, stdoutBytes, stderrBytes, stdoutCapReached, stderrCapReached })
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
    for (const edit of configEdits(params)) {
      if (edit.keyPath === 'model' && typeof edit.value === 'string' && edit.value.length > 0) {
        this.configModel = normalizeSelectableModelId(edit.value, this.configModel)
      }
      if (edit.keyPath === 'model_reasoning_effort' && typeof edit.value === 'string') {
        this.configReasoningEffort = normalizeCodexReasoningEffort(edit.value) ?? this.configReasoningEffort
      }
    }
    this.persistConfig()
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
        cliVersion: codexCliVersion(),
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
    if (event.toolName === 'WebSearch') {
      // Codex App has a dedicated `webSearch` ThreadItem with a structured
      // action — emit it instead of a generic mcpToolCall so the App can show
      // the search badge (and follow-up open-page links) natively. Action is
      // populated when the tool_result arrives (see tool_result handler).
      return {
        type: 'webSearch',
        id,
        query: String(event.input.query ?? ''),
        action: { type: 'search' },
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
      approvalPolicy: thread.approvalPolicy ?? 'on-request',
      approvalsReviewer: 'user',
      sandbox: sandboxEnvelope(thread.sandboxMode, thread.cwd),
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
      ephemeral: thread.ephemeral,
      modelProvider: thread.modelProvider,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: thread.status,
      path: null,
      cwd: thread.cwd,
      cliVersion: codexCliVersion(),
      source: thread.source,
      threadSource: thread.threadSource,
      agentNickname: thread.agentNickname,
      agentRole: thread.agentRole,
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
      apiDurationMs: turn.apiDurationMs ?? null,
      numTurns: turn.numTurns ?? null,
      costUsd: turn.costUsd ?? null,
    }
  }

  private sendResponse(peer: RpcPeer, id: JsonRpcId, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id }
    if (error) response.error = error
    else response.result = result ?? null
    peer.send(response)
  }

  private notify(peer: RpcPeer, notification: { method: string; params: unknown }): void {
    const target = this.peerForParams(peer, notification.params)
    debugLog('rpc.notify', {
      peerId: target.id,
      originalPeerId: target.id === peer.id ? null : peer.id,
      method: notification.method,
      params: summarizeRpcParams(notification.method, notification.params),
    })
    target.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
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
    const target = this.peerForParams(peer, params)
    const key = `${target.id}:${id}`
    return new Promise((resolve, reject) => {
      debugLog('rpc.serverRequest', {
        peerId: target.id,
        originalPeerId: target.id === peer.id ? null : peer.id,
        id,
        method,
        params: summarizeRpcParams(method, params),
      })
      this.pendingServerRequests.set(key, { resolve, reject })
      target.send({ jsonrpc: '2.0', id, method, params })
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

  private completeActiveTurns(status: 'interrupted' | 'failed', error: unknown): void {
    for (const [threadId, turnId] of this.activeTurnByThread.entries()) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        this.store.completeTurn(turnId, status, error)
      }
      this.store.updateThreadStatus(threadId, { type: 'idle' })
    }
    this.activeTurnByThread.clear()
  }

  private clearActiveTurn(threadId: string): void {
    const existed = this.activeTurnByThread.delete(threadId)
    if (existed && this.activeTurnByThread.size === 0) this.idleCheckHandler?.()
  }

  private peerForParams(peer: RpcPeer, params: unknown): RpcPeer {
    const threadId = stringOr(asRecord(params).threadId, '')
    if (!threadId) return peer
    return this.activePeerByThread.get(threadId) ?? peer
  }

  private loadPersistedConfig(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as Record<string, unknown>
      let shouldRepair = false
      if (typeof parsed.model === 'string' && parsed.model.length > 0) {
        const normalized = normalizeSelectableModelId(parsed.model, this.configModel)
        shouldRepair = normalized !== parsed.model
        this.configModel = normalized
      }
      if (typeof parsed.model_reasoning_effort === 'string') {
        this.configReasoningEffort = normalizeCodexReasoningEffort(parsed.model_reasoning_effort) ?? this.configReasoningEffort
      }
      if (shouldRepair) this.persistConfig()
    } catch {}
  }

  private persistConfig(): void {
    try {
      ensureParent(this.configPath)
      writeFileSync(
        this.configPath,
        JSON.stringify({ model: this.configModel, model_reasoning_effort: this.configReasoningEffort }, null, 2) + '\n',
        { mode: 0o600 },
      )
    } catch {}
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function configEdits(params: Record<string, unknown>): Array<{ keyPath: string; value: unknown }> {
  if (Array.isArray(params.edits)) {
    return params.edits.map((edit) => {
      const rec = asRecord(edit)
      return { keyPath: String(rec.keyPath ?? rec.key ?? ''), value: rec.value }
    }).filter((edit) => edit.keyPath.length > 0)
  }
  const keyPath = String(params.keyPath ?? params.key ?? '')
  return keyPath ? [{ keyPath, value: params.value }] : []
}

function configLayerMetadata(): unknown {
  return {
    name: { type: 'user', file: `${codexHome()}/config.toml` },
    version: `claude-codex-${nowSeconds()}`,
  }
}

function defaultSelectableModelId(): string {
  const options = claudeModelOptions()
  const defaultModel = process.env.CLAUDE_CODEX_DEFAULT_MODEL
  if (defaultModel && options.some((option) => option.id === defaultModel)) return defaultModel
  return options.find((option) => option.isDefault === true)?.id ?? options[0]?.id ?? 'sonnet'
}

function normalizeSelectableModelId(value: string, fallback: string): string {
  const options = claudeModelOptions()
  const ids = new Set(options.map((option) => option.id))
  if (ids.has(value)) return value
  if (ids.has(fallback)) return fallback
  const defaultModel = defaultSelectableModelId()
  debugLog('config.model.repaired', { requestedModel: value, repairedModel: defaultModel })
  return defaultModel
}

function modelFromParams(params: Record<string, unknown>, fallback: string | null): string {
  const config = asRecord(params.config)
  if (typeof params.model === 'string' && params.model.length > 0) return params.model
  if (typeof config.model === 'string' && config.model.length > 0) return config.model
  return fallback ?? ''
}

function reasoningEffortFromParams(params: Record<string, unknown>, fallback: string | null): 'low' | 'medium' | 'high' | 'xhigh' | null {
  const config = asRecord(params.config)
  const effort =
    typeof params.effort === 'string'
      ? params.effort
      : typeof config.model_reasoning_effort === 'string'
        ? config.model_reasoning_effort
        : fallback
  return normalizeCodexReasoningEffort(effort)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function commandArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((part) => part.length > 0)
  if (typeof value === 'string' && value.trim()) return [process.env.SHELL || '/bin/sh', '-lc', value]
  return []
}

function summarizeRpcParams(method: string, params: unknown): unknown {
  const rec = asRecord(params)
  if (method === 'turn/start') {
    return {
      threadId: rec.threadId,
      cwd: rec.cwd,
      model: rec.model,
      effort: rec.effort,
      configEffort: asRecord(rec.config).model_reasoning_effort,
      hasOutputSchema: rec.outputSchema != null,
      inputTypes: Array.isArray(rec.input) ? rec.input.map((item) => asRecord(item).type) : [],
    }
  }
  if (method === 'process/spawn' || method === 'command/exec') {
    return {
      processHandle: rec.processHandle,
      processId: rec.processId,
      cwd: rec.cwd,
      command: commandArray(rec.command),
      streamStdoutStderr: rec.streamStdoutStderr,
      streamStdin: rec.streamStdin,
      tty: rec.tty,
      timeoutMs: rec.timeoutMs,
    }
  }
  if (method.includes('outputDelta')) {
    return {
      processHandle: rec.processHandle,
      processId: rec.processId,
      itemId: rec.itemId,
      stream: rec.stream,
      deltaBytes: typeof rec.deltaBase64 === 'string' ? Buffer.from(rec.deltaBase64, 'base64').byteLength : typeof rec.delta === 'string' ? rec.delta.length : 0,
      capReached: rec.capReached,
    }
  }
  if (method === 'item/agentMessage/delta') {
    return {
      threadId: rec.threadId,
      turnId: rec.turnId,
      itemId: rec.itemId,
      deltaChars: typeof rec.delta === 'string' ? rec.delta.length : 0,
    }
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = asRecord(rec.item)
    return {
      threadId: rec.threadId,
      turnId: rec.turnId,
      item: { id: item.id, type: item.type },
    }
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const turn = asRecord(rec.turn)
    const items = Array.isArray(turn.items) ? turn.items.map((item) => ({ id: asRecord(item).id, type: asRecord(item).type })) : []
    return {
      threadId: rec.threadId,
      turn: { id: turn.id, status: turn.status, items },
    }
  }
  return rec
}

function reviewLabel(target: unknown): string {
  const rec = asRecord(target)
  const type = stringOr(rec.type, 'uncommittedChanges')
  if (type === 'commit') return 'commit ' + stringOr(rec.sha, '') + (typeof rec.title === 'string' ? ': ' + rec.title : '')
  if (type === 'baseBranch') return 'base branch ' + stringOr(rec.branch, 'main')
  if (type === 'custom') return stringOr(rec.instructions, 'custom review')
  return 'uncommitted changes'
}

function reviewPrompt(target: unknown): string {
  const label = reviewLabel(target)
  return [
    'Review the code changes for: ' + label,
    '',
    'Prioritize correctness bugs, regressions, security issues, and missing tests.',
    'Return findings first, ordered by severity, with file and line references when available.',
    'If there are no actionable issues, say so clearly and mention residual risk.',
  ].join('\n')
}

function compactSummary(thread: ThreadRecord, turns: TurnRecord[]): string {
  const snippets = turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === 'userMessage' || item.type === 'agentMessage')
    .slice(-12)
    .map((item) => {
      if (item.type === 'userMessage') return 'User: ' + textFromInput(item.content).slice(0, 500)
      if (item.type === 'agentMessage') return 'Assistant: ' + item.text.slice(0, 500)
      return ''
    })
    .filter(Boolean)
  return [
    'Context compacted for thread ' + thread.id + '.',
    '',
    snippets.length > 0 ? snippets.join('\n') : 'No prior conversation content was available to summarize.',
  ].join('\n')
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

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
  }
  return ''
}

function fallbackStructuredText(outputSchema: unknown, prompt: string): string {
  return JSON.stringify(coerceStructuredValue(outputSchema, prompt), null, 0)
}

function normalizeApprovalPolicy(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  // Codex AskForApproval enum: untrusted | on-failure | on-request | never.
  // (We previously had "unless-trusted" which never appeared in the wire enum.)
  if (v === 'untrusted' || v === 'on-failure' || v === 'on-request' || v === 'never') return v
  // Some early App builds shipped the longer form; normalize forward.
  if (v === 'unless-trusted') return 'untrusted'
  return null
}

function normalizeSandboxMode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v === 'read-only' || v === 'workspace-write' || v === 'danger-full-access' ? v : null
}

// turn/start uses `sandboxPolicy: SandboxPolicy` (a struct) instead of the
// thread/start `sandbox: SandboxMode` string. Translate the struct's `type`
// back to the internal canonical mode string the sidecar understands.
function sandboxFromTurnParams(params: Record<string, unknown>): string | null {
  if (typeof params.sandbox === 'string') return normalizeSandboxMode(params.sandbox)
  const policy = params.sandboxPolicy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
  const type = (policy as Record<string, unknown>).type
  if (type === 'dangerFullAccess') return 'danger-full-access'
  if (type === 'readOnly') return 'read-only'
  if (type === 'workspaceWrite' || type === 'externalSandbox') return 'workspace-write'
  return null
}

function normalizePersonality(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v === 'none' || v === 'friendly' || v === 'pragmatic' || v === 'cynic' || v === 'robot' || v === 'nerd') return v
  return null
}

// Assemble the per-thread system prompt addendum from Codex App's instruction
// surface. Sidecar concatenates this onto Claude's default system prompt so
// the user's project / developer / personality settings actually take effect.
function buildSystemPromptAddendum(input: {
  baseInstructions: string | null
  developerInstructions: string | null
  personality: string | null
}): string | null {
  const sections: string[] = []
  const base = (input.baseInstructions ?? '').trim()
  if (base) sections.push(`# Project instructions\n${base}`)
  const dev = (input.developerInstructions ?? '').trim()
  if (dev) sections.push(`# Developer instructions\n${dev}`)
  const cue = personalityPromptCue(input.personality)
  if (cue) sections.push(cue)
  return sections.length > 0 ? sections.join('\n\n') : null
}

function personalityPromptCue(personality: string | null): string | null {
  switch (personality) {
    case 'friendly':
      return 'Personality: friendly. Communicate in a warm, encouraging tone; default to plain language and short paragraphs.'
    case 'pragmatic':
      return 'Personality: pragmatic. Be concise and direct; lead with the answer, skip pleasantries, prefer concrete code or commands.'
    case 'cynic':
      return 'Personality: cynic. Be terse and wry; surface trade-offs and risks plainly; avoid hype.'
    case 'robot':
      return 'Personality: robot. Reply in clipped, structured prose; prefer bullet points and exact field names; minimise filler.'
    case 'nerd':
      return 'Personality: nerd. Get into mechanism and detail; explain underlying assumptions and edge cases when relevant.'
    case 'none':
    case null:
    default:
      return null
  }
}

// Codex App's thread envelope expects a sandbox object whose `type` matches the
// chosen tier. Returning the right shape lets the App render the correct badge
// (Read-only / Workspace / Full access) and stops it from over-prompting.
function sandboxEnvelope(mode: string | null, cwd: string): unknown {
  if (mode === 'read-only') return { type: 'readOnly' }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  // Default: workspace-write (or null/legacy).
  return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
}

function emptyTokenBreakdown(): TokenUsageBreakdown {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
}

// Best-effort: when the WebSearch tool returns a result, sniff whether the
// first result was an explicit page open vs a result list. Codex App's
// `webSearch` ThreadItem renders the action badge accordingly.
function parseWebSearchAction(query: string, resultText: string):
  | { type: 'search' }
  | { type: 'openPage'; url: string }
  | { type: 'findInPage'; pattern: string; url: string }
  | { type: 'other' } {
  if (!resultText) return { type: 'search' }
  const urlMatch = resultText.match(/https?:\/\/[^\s)\]"'<]+/)
  if (urlMatch && query) return { type: 'openPage', url: urlMatch[0] }
  return { type: 'search' }
}

// Maps the raw Anthropic usage block carried on the Claude Agent SDK
// ResultMessage onto the Codex `TokenUsageBreakdown` shape. Cache-creation
// tokens count as input; Claude does not separate reasoning output tokens.
function tokenBreakdownFromClaudeUsage(usage: Record<string, unknown>): TokenUsageBreakdown {
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheCreation = num(usage.cache_creation_input_tokens)
  const inputTokens = num(usage.input_tokens) + cacheCreation
  const outputTokens = num(usage.output_tokens)
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cacheRead + outputTokens,
  }
}


function coerceStructuredValue(schema: unknown, prompt: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return prompt
  const record = schema as Record<string, unknown>
  if (record.type === 'string') return conciseStructuredString(prompt)
  if (record.type === 'array') {
    const itemSchema = record.items && typeof record.items === 'object' && !Array.isArray(record.items) ? record.items : { type: 'string' }
    const values = prompt.split(/\r?\n/).map((line) => line.trim().replace(/^[-*\d.、)\s]+/, '')).filter(Boolean)
    return (values.length > 0 ? values : prompt.trim() ? [prompt.trim()] : []).slice(0, 10).map((value) => coerceStructuredValue(itemSchema, value))
  }
  if (record.type !== 'object') return null
  const properties = record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
    ? (record.properties as Record<string, unknown>)
    : {}
  const required = Array.isArray(record.required) ? record.required.map(String) : Object.keys(properties)
  const result: Record<string, unknown> = {}
  for (const key of required) {
    const property = properties[key]
    const propertyType = property && typeof property === 'object' && !Array.isArray(property) ? (property as Record<string, unknown>).type : null
    result[key] = coerceStructuredValue(property, prompt)
  }
  return result
}

function conciseStructuredString(prompt: string): string {
  const lines = prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const source = lines.at(-1) ?? prompt.trim()
  const colon = Math.max(source.lastIndexOf('：'), source.lastIndexOf(':'))
  const value = colon >= 0 ? source.slice(colon + 1).trim() : source
  return value.replace(/^[-*\d.、)\s]+/, '').slice(0, 80).trim()
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

// `git diff` failing is expected outside a repo, so we still return '' to keep
// turns working — but the reason is written to the debug log instead of being
// dropped silently, and a genuine git error is flagged as such.
function isNotAGitRepo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not a git repository/i.test(message)
}

async function gitDiff(cwd: string): Promise<string> {
  let trackedDiff = ''
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], { cwd, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 })
    trackedDiff = stdout
  } catch (error) {
    debugLog('git.diff.failed', {
      cwd,
      reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
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
  } catch (error) {
    debugLog('git.untrackedDiff.failed', {
      cwd,
      reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
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
  } catch (rgError) {
    debugLog('listFiles.rgFailed', { root, error: rgError instanceof Error ? rgError.message : String(rgError) })
    try {
      const { stdout } = await execFileAsync('find', ['.', '-type', 'f'], { cwd: root, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 })
      return stdout.split('\n').filter(Boolean).map((path) => path.replace(/^\.\//, ''))
    } catch (findError) {
      debugLog('listFiles.findFailed', { root, error: findError instanceof Error ? findError.message : String(findError) })
      return []
    }
  }
}
