import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { type FSWatcher, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { callMcpTool, listMcpServerStatuses, readMcpConfig, readMcpResource } from './mcp.mjs'
import {
  addedFileDiff,
  asRecord,
  buildSystemPromptAddendum,
  coerceStructuredValue,
  commandArray,
  commandEnv,
  compactSummary,
  conciseStructuredString,
  configEdits,
  configLayerMetadata,
  defaultSelectableModelId,
  emptyTokenBreakdown,
  fallbackStructuredText,
  fileChangeFromTool,
  gitDiff,
  gitUntrackedDiff,
  isGitWorkTree,
  isNotAGitRepo,
  isSubagentToolName,
  listFiles,
  modelFromParams,
  normalizeApprovalPolicy,
  normalizeDecision,
  normalizePersonality,
  normalizeReasoningEffortEnum,
  normalizeSandboxMode,
  normalizeSelectableModelId,
  normalizeSessionSource,
  normalizeThreadSource,
  normalizeUserInputAnswers,
  nullIfEmpty,
  numberOr,
  parseExitCodeFromResult,
  parseSubagentTrailer,
  parseWebSearchAction,
  personalityPromptCue,
  readConfigReasoningEffort,
  reasoningEffortFromParams,
  reviewLabel,
  reviewPrompt,
  sandboxEnvelope,
  sandboxFromTurnParams,
  simpleDiff,
  stringListFromEnv,
  stringOr,
  summarizeInjectedItem,
  summarizeRpcParams,
  todoWriteToPlanSteps,
  tokenBreakdownFromClaudeUsage,
  toolResultText,
  userInputAnswersAsContent,
  wrapMcpToolError,
  wrapMcpToolResult,
} from './server-helpers.mjs'
import type { SessionStore } from './store.mjs'
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
  UserInputAnswers,
  UserInputQuestion,
  WireMessage,
} from './types.mjs'
import {
  adapterHome,
  claudeModelOptions,
  claudeOutputFormat,
  codexCliVersion,
  codexHome,
  codexProxyModelOptions,
  codexUserAgent,
  debugLog,
  defaultAllowedTools,
  ensureParent,
  extractImageInputs,
  isCodexOpenAiModel,
  newId,
  normalizeCodexReasoningEffort,
  nowMillis,
  nowSeconds,
  platformFamily,
  platformOs,
  resolveClaudeEffort,
  resolveClaudeModel,
  textFromInput,
} from './util.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'

const execFileAsync = promisify(execFile)

export class CodexClaudeAppServer {
  private pendingServerRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private activePeerByThread = new Map<string, RpcPeer>()
  private activeTurnByThread = new Map<string, string>()
  private fuzzySessions = new Map<string, { roots: string[] }>()
  private commandSessionAllow = new Map<string, Set<string>>()
  private commandProcesses = new Map<string, ChildProcess>()
  private processHandles = new Map<string, ChildProcess>()
  private fsWatchers = new Map<string, FSWatcher>()
  private goals = new Map<string, Record<string, unknown>>()
  private elicitationCounts = new Map<string, number>()
  private tokenUsageByThread = new Map<string, TokenUsageBreakdown>()
  private configModel = defaultSelectableModelId()
  private configReasoningEffort =
    normalizeCodexReasoningEffort(process.env.CLAUDE_CODEX_DEFAULT_EFFORT) ?? 'medium'
  // Catch-all for arbitrary keys the App's settings sheet writes (approval
  // policy, sandbox preference, instructions toggles, etc.). We don't apply
  // them to typed runtime state, but we round-trip them through config/read
  // so the user's settings survive a daemon restart instead of resetting on
  // every reconnect.
  private configOverrides: Record<string, unknown> = {}
  private readonly configPath = join(adapterHome(), 'config.json')
  private idleCheckHandler: (() => void) | null = null
  private stopped = false
  private readonly store: SessionStore
  private readonly runtime: ClaudeRuntime

  constructor(store: SessionStore, runtime: ClaudeRuntime) {
    this.store = store
    this.runtime = runtime
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
      debugLog('rpc.responseFromClient', {
        peerId: peer.id,
        id: message.id,
        hasError: Boolean((message as JsonRpcResponse).error),
      })
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
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: true,
      })
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
      case 'initialize': {
        const initParams = asRecord(params)
        const clientInfo = asRecord(initParams.clientInfo)
        // Push the account snapshot + MCP server statuses right after handshake
        // so the App's sidebar avatar and MCP panel populate without waiting
        // for the next polling cycle. Without these the avatar stays "signed
        // out" and the MCP list never reflects current boot state.
        queueMicrotask(() => {
          this.notify(peer, {
            method: 'account/updated',
            params: { authMode: 'apikey', planType: null },
          })
          for (const status of readMcpConfig().startupStatuses) {
            this.notify(peer, {
              method: 'mcpServer/startupStatus/updated',
              params: { name: status.name, status: status.status, error: status.error ?? null },
            })
          }
        })
        return {
          userAgent: codexUserAgent(
            stringOr(clientInfo.name, 'codex-app'),
            stringOr(clientInfo.version, 'unknown'),
          ),
          codexHome: codexHome(),
          platformFamily: platformFamily(),
          platformOs: platformOs(),
        }
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
      case 'thread/approveGuardianDeniedAction': {
        // Codex App's "Guardian" is an OpenAI-side pre-tool safety classifier
        // that can deny a tool call before it reaches the runtime. Claude
        // Code has no equivalent — every denial in our pipeline already
        // routes through the canUseTool round-trip, which the user resolves
        // directly via the standard approval modal. There is no separate
        // guardian-denied action to retry. We log the event (for parity
        // debugging) and ack with the schema-correct {} response.
        const evt = asRecord(params).event
        debugLog('thread.approveGuardianDeniedAction', {
          threadId: stringOr(asRecord(params).threadId, ''),
          eventType:
            evt && typeof evt === 'object' ? ((evt as Record<string, unknown>).type ?? null) : null,
        })
        return {}
      }
      case 'thread/backgroundTerminals/clean':
        return this.threadBackgroundTerminalsClean(asRecord(params))
      case 'thread/rollback':
        return this.threadRollback(asRecord(params))
      case 'thread/loaded/list':
        return this.threadLoadedList(asRecord(params))
      case 'thread/inject_items':
        return this.threadInjectItems(peer, asRecord(params))
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
        return {
          echoed: typeof asRecord(params).value === 'string' ? asRecord(params).value : null,
        }
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
      // Stub the three RPC methods Codex App may call but our dispatcher
      // previously threw "method not implemented" on. Stubs return the
      // schema-correct empty shape so the App's call sites don't surface an
      // RPC error toast.
      case 'plugin/share/checkout':
        // PluginShareCheckoutResponse — App polls after a share/save; nothing to checkout.
        return {}
      case 'environment/add':
        // EnvironmentAddResponse — adds a workspace environment; we have no concept of one.
        return {}
      case 'attestation/generate':
        // AttestationGenerateResponse — returns a signed blob; clients with
        // requestAttestation:true expect a string. Empty string is permissive.
        return { attestation: '' }
      case 'app/list':
        return { data: [], nextCursor: null }
      case 'mcpServer/oauth/login':
        return {
          authorizationUrl: `https://localhost.invalid/claude-codex/mcp-oauth/${encodeURIComponent(stringOr(asRecord(params).name, 'server'))}`,
        }
      case 'config/mcpServer/reload':
        return {}
      case 'mcpServerStatus/list':
        return listMcpServerStatuses().then((data) => ({ data, nextCursor: null }))
      case 'mcpServer/resource/read':
        return readMcpResource(
          stringOr(asRecord(params).server, ''),
          stringOr(asRecord(params).uri, ''),
        )
      case 'mcpServer/tool/call':
        return callMcpTool(
          stringOr(asRecord(params).server, ''),
          stringOr(asRecord(params).tool, ''),
          asRecord(params).arguments ?? {},
        )
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
      case 'fuzzyFileSearch/sessionStart':
        return this.fuzzySessionStart(asRecord(params))
      case 'fuzzyFileSearch/sessionUpdate':
        return this.fuzzySessionUpdate(peer, asRecord(params))
      case 'fuzzyFileSearch/sessionStop':
        return this.fuzzySessionStop(peer, asRecord(params))
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
      // v2 SessionSource is camelCase; the old `app_server` falls through to
      // `unknown` on the App side, hiding the source in the thread sidebar.
      source: 'appServer',
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy: normalizeApprovalPolicy(params.approvalPolicy),
      sandboxMode: normalizeSandboxMode(params.sandbox),
      ephemeral: params.ephemeral === true,
      threadSource: normalizeThreadSource(params.threadSource),
      agentRole: nullIfEmpty(typeof params.agentRole === 'string' ? params.agentRole : null),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : null,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string' ? params.baseInstructions : null,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string' ? params.developerInstructions : null,
      ),
      personality: normalizePersonality(params.personality),
      // Pick the runtime backend from the chosen model — picking gpt-* in
      // the App's model dropdown flips the new thread to runtimeBackend
      // 'codex' so turns get forwarded to `codex exec`. Default 'claude'.
      runtimeBackend: isCodexOpenAiModel(model) ? 'codex' : 'claude',
      codexSessionId: null,
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
    if (model) {
      // runtimeBackend is pinned at thread/start. Refuse cross-backend
      // model changes on resume — the conversation history wouldn't carry
      // over between Claude SDK and `codex exec`. App's model picker can
      // still rebind same-backend models (e.g. sonnet → opus).
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      if (newBackend === thread.runtimeBackend) {
        thread.model = model
      } else {
        debugLog('thread.resume.modelBackendMismatch', {
          threadId,
          oldModel: thread.model,
          newModel: model,
          oldBackend: thread.runtimeBackend,
          newBackend,
        })
      }
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (typeof params.approvalPolicy === 'string')
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    if (typeof params.sandbox === 'string')
      thread.sandboxMode = normalizeSandboxMode(params.sandbox)
    if (typeof params.threadSource === 'string')
      thread.threadSource = normalizeThreadSource(params.threadSource)
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    this.store.upsertThread(thread)
    this.activePeerByThread.set(threadId, peer)
    return this.threadEnvelope(
      thread,
      params.excludeTurns === true ? [] : this.store.listTurns(thread.id),
    )
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
      approvalPolicy:
        typeof params.approvalPolicy === 'string'
          ? normalizeApprovalPolicy(params.approvalPolicy)
          : parent.approvalPolicy,
      sandboxMode:
        typeof params.sandbox === 'string'
          ? normalizeSandboxMode(params.sandbox)
          : parent.sandboxMode,
      ephemeral: parent.ephemeral,
      threadSource:
        typeof params.threadSource === 'string'
          ? normalizeThreadSource(params.threadSource)
          : normalizeThreadSource(parent.threadSource),
      agentRole: nullIfEmpty(
        typeof params.agentRole === 'string' ? params.agentRole : parent.agentRole,
      ),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : parent.agentNickname,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string'
          ? params.baseInstructions
          : parent.baseInstructions,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string'
          ? params.developerInstructions
          : parent.developerInstructions,
      ),
      personality:
        typeof params.personality === 'string'
          ? normalizePersonality(params.personality)
          : parent.personality,
      // Fork: model may flip backend (forking from claude-thread with a
      // gpt-* model = new codex-backed thread); otherwise inherit parent.
      runtimeBackend: isCodexOpenAiModel(modelFromParams(params, parent.model))
        ? 'codex'
        : 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(
      thread,
      params.excludeTurns === true ? [] : this.store.listTurns(parent.id),
    )
  }

  private threadList(params: Record<string, unknown>): unknown {
    const threads = this.store.listThreads({
      archived: (params.archived as boolean | null | undefined) ?? null,
      limit: numberOr(params.limit, 50),
      cursor: typeof params.cursor === 'string' ? params.cursor : null,
      cwd:
        typeof params.cwd === 'string' || Array.isArray(params.cwd)
          ? (params.cwd as string | string[])
          : null,
      includeEphemeral: params.includeEphemeral === true,
    })
    const last = threads.at(-1)
    return {
      data: threads.map((thread) => this.toThread(thread, [])),
      nextCursor:
        last && threads.length >= numberOr(params.limit, 50) ? String(last.updatedAt) : null,
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
    this.notifyThread(threadId, {
      method: 'thread/name/updated',
      params: { threadId, threadName: name ?? undefined },
    })
    return {}
  }

  private threadArchive(params: Record<string, unknown>, archived: boolean): unknown {
    const threadId = stringOr(params.threadId, '')
    this.store.setArchived(threadId, archived)
    this.notifyThread(threadId, {
      method: archived ? 'thread/archived' : 'thread/unarchived',
      params: { threadId },
    })
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
    return {
      data: loaded.slice(0, limit),
      nextCursor: loaded.length > limit ? String(limit) : null,
    }
  }

  // Codex App calls thread/inject_items to push hidden context into a thread's
  // model history — typically file-attachment ingestion, "pin this output as
  // future context", or App-side memory consolidation. Items are raw Responses
  // API entries (free-form JSON). Without an implementation the App's
  // ingestion just disappears, breaking any feature that relies on it.
  //
  // Approach: synthesize an injected turn carrying a single agentMessage that
  // recaps the items as a human-readable block. That turn becomes part of the
  // thread's transcript so the next runRuntimeTurn picks it up as prior
  // conversation context, AND it's visible in thread/read so the user can
  // confirm what was added. We pick agentMessage (instead of a custom type)
  // for App-compatibility — every Codex App build renders it without needing
  // a new ThreadItem variant.
  private threadInjectItems(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const items = Array.isArray(params.items) ? params.items : []
    if (items.length === 0) return {}

    const now = nowSeconds()
    const turnId = newId()
    const itemId = newId()
    // Compact summary of injected items — try to extract human-readable text
    // (Responses items often have `content` arrays with text segments).
    const summary = items
      .map((raw) => summarizeInjectedItem(raw))
      .filter(Boolean)
      .join('\n\n')
    const text =
      summary.length > 0
        ? summary
        : `[adapter] ${items.length} item(s) injected via thread/inject_items`
    const agentItem: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      text,
      phase: null,
      memoryCitation: null,
    }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      items: [agentItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    thread.updatedAt = now
    this.store.upsertThread(thread)
    // Defer notifications past the inject_items response. Firing them
    // synchronously enqueues them in front of the response on the wire,
    // which trips clients that do "await response, then read notifications"
    // (they end up draining the notifications while waiting for the
    // response, then loop forever looking for already-discarded events).
    queueMicrotask(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: agentItem, completedAtMs: nowMillis() },
      })
      this.notify(peer, {
        method: 'turn/completed',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
    })
    debugLog('thread.inject_items', { threadId, count: items.length })
    return {}
  }

  private threadGoalSet(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const existing = this.goals.get(threadId)
    const now = nowSeconds()
    const goal = {
      threadId,
      objective: stringOr(params.objective, String(existing?.objective ?? '')),
      status: typeof params.status === 'string' ? params.status : (existing?.status ?? 'active'),
      tokenBudget:
        typeof params.tokenBudget === 'number'
          ? params.tokenBudget
          : (existing?.tokenBudget ?? null),
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
    if (cleared)
      this.notifyThread(threadId, { method: 'thread/goal/cleared', params: { threadId } })
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
    // Honor the protocol's `numTurns: u32, must be >= 1` — drop that many
    // turns from the end of the thread. Without this, App's rewind UI sends
    // the request and we silently return the unchanged thread, leaving the
    // user staring at the timeline they were trying to redo.
    const numTurns =
      typeof params.numTurns === 'number' && params.numTurns >= 1 ? Math.floor(params.numTurns) : 0
    if (numTurns > 0) {
      const dropped = this.store.deleteRecentTurns(threadId, numTurns)
      debugLog('thread.rollback', { threadId, requested: numTurns, dropped })
    }
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
    child.stdout?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stdout',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.stderr?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stderr',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.once('error', (error) =>
      debugLog('thread.shellCommand.error', { threadId, processId, error: error.message }),
    )
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
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: turnId,
      content: [{ type: 'text', text: review, text_elements: [] }],
    }
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
    // The review/start RESPONSE carries the synthesized userMessage item (the
    // real app-server's build_review_turn does the same, with itemsView
    // notLoaded); the turn/started NOTIFICATION stays empty like every other
    // lifecycle turn.
    const responseTurn = this.toLifecycleTurn(turn, [userItem])
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: entered, startedAtMs: nowMillis() },
      })
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        model: thread.model,
        effort: thread.reasoningEffort,
      }).catch((error) => {
        const completed =
          this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        this.notify(peer, {
          method: 'error',
          params: { threadId, turnId, willRetry: false, error: { message: error.message } },
        })
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: responseTurn, reviewThreadId: threadId }
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
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: compactItem, startedAtMs: nowMillis() },
      })
      const agentItem: ThreadItem = {
        type: 'agentMessage',
        id: newId(),
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(turnId, agentItem)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: agentItem, startedAtMs: nowMillis() },
      })

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
          this.notify(peer, {
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, itemId: agentItem.id, delta: fallback },
          })
        })
        .finally(() => {
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: compactItem, completedAtMs: nowMillis() },
          })
          const finalAgent =
            this.store.getTurn(turnId)?.items.find((i) => i.id === agentItem.id) ?? agentItem
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: finalAgent, completedAtMs: nowMillis() },
          })
          const completed = this.store.completeTurn(turnId, 'completed') ?? turn
          this.clearActiveTurn(threadId)
          this.setThreadStatus(peer, threadId, { type: 'idle' })
          this.notify(peer, {
            method: 'turn/completed',
            params: { threadId, turn: this.toLifecycleTurn(completed) },
          })
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
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId, itemId: agentItemId, delta: event.delta },
            })
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'completed' && !event.success) {
            throw new Error(event.result ?? 'compaction turn failed')
          }
        },
        // Compaction never asks for approvals — it's read-only summarisation.
        onPermissionRequest: async () => ({ decision: 'accept' }),
        // Compaction shouldn't ever invoke AskUserQuestion; if it does, return
        // an empty answer so the model proceeds with its summary.
        onUserInputRequest: async (event) => ({
          answers: Object.fromEntries(event.questions.map((q) => [q.id, { answers: [] }])),
        }),
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
    const model = modelFromParams(params, thread.model)
    const reasoningEffort = reasoningEffortFromParams(params, thread.reasoningEffort)
    if (model) thread.model = model
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    this.store.upsertThread(thread)
    if (!thread.preview && prompt) {
      thread.preview = prompt.slice(0, 200)
      thread.updatedAt = nowSeconds()
      this.store.upsertThread(thread)
    }
    const initialItems: ThreadItem[] = [{ type: 'userMessage', id: newId(), content: input }]
    const imageItems: ThreadItem[] = []
    for (const img of images) {
      // Codex v2 imageView.path is AbsolutePathBuf — Rust's custom Deserialize
      // rejects anything that isn't an absolute filesystem path (URLs, data:
      // URIs, relative paths). For non-local images we'd otherwise crash the
      // App on persist/reload. Only emit imageView for kind:'base64' inputs
      // that came from a real local file path (the displayPath in that case
      // is the original absolute path captured by extractImageInputs).
      if (img.kind === 'base64' && img.displayPath.startsWith('/')) {
        imageItems.push({ type: 'imageView', id: newId(), path: img.displayPath })
      }
    }
    // imageView items are retained on the turn for history (thread/read) and, in
    // contrast to the userMessage, surfaced live through the item/* event stream
    // so the App's transcript shows the uploaded image inline during the turn.
    initialItems.push(...imageItems)
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
    const publicTurn = this.toLifecycleTurn(turn)

    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      for (const item of imageItems) {
        this.notify(peer, {
          method: 'item/started',
          params: { threadId, turnId, item, startedAtMs: nowMillis() },
        })
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId, turnId, item, completedAtMs: nowMillis() },
        })
      }
      // Carry parsed images through the params bag so runRuntimeTurn can hand
      // them to the runtime context without re-parsing user input.
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        ...params,
        _imageInputs: images,
      }).catch((error) => {
        const completed =
          this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        this.notify(peer, {
          method: 'error',
          params: { threadId, turnId, willRetry: false, error: { message: error.message } },
        })
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
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
    const subagentContexts = new Map<
      string,
      { childThreadId: string; waitItemId: string; prompt: string; subType: string | null }
    >()
    const activeSubagents = new Set<string>()
    // Track per-item start time so commandExecution / mcpToolCall items can
    // report a real durationMs in turn/completed (otherwise the App's status
    // bar shows "—" for every command).
    const itemStartedAtMs = new Map<string, number>()
    // Mutable holder rather than `let collectedMetrics`: TS's control-flow
    // analysis doesn't see writes from inside the onEvent callback, so a bare
    // `let` would still be inferred as `null` outside the closure.
    const collectedMetrics: {
      apiDurationMs: number | null
      numTurns: number | null
      costUsd: number | null
      set: boolean
    } = {
      apiDurationMs: null,
      numTurns: null,
      costUsd: null,
      set: false,
    }
    const forkSession =
      thread.forkedFromId != null &&
      thread.claudeSessionId != null &&
      this.store.listTurns(thread.id).length <= 1
    // Plan mode: Claude SDK runs with permissionMode='plan' — it produces
    // planning text but does not execute tools. We surface the planning
    // output as Codex's native `plan` ThreadItem (instead of agentMessage)
    // and stream deltas via item/plan/delta + turn/plan/updated so the
    // App's Plan-mode UI lights up properly. Detection:
    //   * turn/start.planMode === true (App's explicit request)
    //   * thread.approvalPolicy / sandbox flags don't suppress it
    // The current planMode flag for this turn was computed above as
    // `params.planMode === true`; reproduce here so the helpers can check it.
    const planMode = params.planMode === true
    let planItemId: string | null = null
    const ensurePlanItem = (): string => {
      if (planItemId) return planItemId
      planItemId = newId()
      const item: ThreadItem = { type: 'plan', id: planItemId, text: '' }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return planItemId
    }
    const ensureAgentItem = (): string => {
      if (agentItemId) return agentItemId
      agentItemId = newId()
      const item: ThreadItem = {
        type: 'agentMessage',
        id: agentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return agentItemId
    }
    const ensureReasoningItem = (): string => {
      if (reasoningItemId) return reasoningItemId
      reasoningItemId = newId()
      const item: ThreadItem = {
        type: 'reasoning',
        id: reasoningItemId,
        summary: [''],
        content: [''],
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return reasoningItemId
    }

    // Allow per-turn override of policy (Codex App may attach updated values
    // when the user toggles Full access mid-conversation), then fall back to
    // the thread-level setting captured at start/resume. turn/start ships a
    // sandboxPolicy struct (e.g. {type:"dangerFullAccess"}); thread/start uses
    // the simpler sandbox string. Both are honoured.
    const approvalPolicy =
      (typeof params.approvalPolicy === 'string'
        ? normalizeApprovalPolicy(params.approvalPolicy)
        : null) ?? thread.approvalPolicy
    const sandboxMode = sandboxFromTurnParams(params) ?? thread.sandboxMode
    // Per-turn instruction overrides: Codex App may resend its instruction
    // panel state when the user toggles personality mid-thread. Falls back to
    // whatever was captured at thread/start.
    const baseInstructions =
      (typeof params.baseInstructions === 'string' ? params.baseInstructions : null) ??
      thread.baseInstructions
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
    const turnPurpose = params.outputSchema == null ? 'normal' : 'summary'

    const resolvedModel = resolveClaudeModel(
      stringOr(params.model, thread.model),
      params.outputSchema == null ? 'normal' : 'summary',
    )
    const resolvedEffort = resolveClaudeEffort(
      typeof params.effort === 'string'
        ? params.effort
        : (thread.reasoningEffort ?? process.env.CLAUDE_CODEX_EFFORT ?? null),
    )
    // Log the effective Claude SDK model+effort per turn so when a user
    // reports "switching model didn't work" we can diff App's payload against
    // what actually reached the SDK in one grep.
    debugLog('turn.runtime.applied', {
      threadId: thread.id,
      turnId: turn.id,
      paramsModel: params.model ?? null,
      paramsEffort: params.effort ?? null,
      threadModel: thread.model,
      threadEffort: thread.reasoningEffort,
      envDefaultModel: process.env.CLAUDE_CODEX_DEFAULT_MODEL ?? null,
      envDefaultEffort:
        process.env.CLAUDE_CODEX_DEFAULT_EFFORT ?? process.env.CLAUDE_CODEX_EFFORT ?? null,
      resolvedModel,
      resolvedEffort,
    })
    // For codex-backed threads, force the per-turn runtimeType to 'codex-proxy'
    // so the SelectableRuntime dispatches to CodexProxyRuntime instead of
    // the default Claude SDK runtime. Also route the codex session id (stored
    // separately from Claude's) through the existing claudeSessionId slot —
    // CodexProxyRuntime consumes it as the resume id. In mock mode the
    // mock runtime handles everything regardless of model id — bypass the
    // codex-proxy override so unit tests stay deterministic.
    const isCodexThread = thread.runtimeBackend === 'codex' && process.env.CLAUDE_CODEX_MOCK !== '1'
    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        purpose: turnPurpose,
        prompt,
        cwd: stringOr(params.cwd, thread.cwd),
        runtimeType: isCodexThread ? 'codex-proxy' : null,
        model: resolvedModel,
        effort: resolvedEffort,
        claudeSessionId: isCodexThread ? thread.codexSessionId : thread.claudeSessionId,
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
        imageInputs: Array.isArray(params._imageInputs)
          ? (params._imageInputs as ImageInput[])
          : [],
      },
      {
        onEvent: async (event) => {
          if (event.type === 'session') {
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            return
          }
          if (activeSubagents.size > 0) {
            if (event.type === 'text_delta' || event.type === 'reasoning_delta') return
            if (event.type === 'tool_use' && !isSubagentToolName(event.toolName)) return
            if (event.type === 'tool_output_delta' && !itemIds.has(event.toolUseId)) return
            if (
              event.type === 'tool_result' &&
              !activeSubagents.has(event.toolUseId) &&
              !itemIds.has(event.toolUseId)
            )
              return
          }
          if (event.type === 'tool_use' && isSubagentToolName(event.toolName)) {
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
            const subType =
              typeof event.input.subagent_type === 'string' ? event.input.subagent_type : null
            const subagentModel =
              typeof event.input.model === 'string' ? event.input.model : thread.model
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
              source: normalizeSessionSource(thread.source),
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
              // Subagents always run via Claude — the Task tool is a Claude SDK
              // construct. A codex-backed thread that spawns a subagent would
              // never reach this code path (subagent detection is Claude-side).
              runtimeBackend: 'claude',
              codexSessionId: null,
            }
            this.store.upsertThread(childThread)

            // Stage 1 — spawnAgent (begin + end emitted together; the agent is
            // already created so there's no real latency here).
            const spawnId = newId()
            // Codex v2 collabAgentToolCall.reasoningEffort is `ReasoningEffort | null`
            // (strict enum: none|minimal|low|medium|high|xhigh). Same Oops trap as
            // threadSource — an empty string from a sloppy resume crashes the App.
            // Normalize here once and reuse for every stage of the lifecycle.
            const collabEffort = normalizeReasoningEffortEnum(thread.reasoningEffort)
            const spawnBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, spawnBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnBegin,
                startedAtMs: nowMillis(),
              },
            })
            const spawnEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: { [childThreadId]: { status: 'running', message: null } },
            }
            this.store.updateItem(turn.id, spawnId, () => spawnEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnEnd,
                completedAtMs: nowMillis(),
              },
            })

            // Stage 2 — wait (begin only; this is the long phase that gives
            // Codex App its "agent is working" indicator while the subagent
            // runs. It closes when the Task tool_result arrives.)
            const waitId = newId()
            const waitBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: waitId,
              tool: 'wait',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, waitBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitBegin,
                startedAtMs: nowMillis(),
              },
            })

            itemIds.set(event.toolUseId, waitId)
            subagentContexts.set(event.toolUseId, {
              childThreadId,
              waitItemId: waitId,
              prompt: promptText,
              subType,
            })
            activeSubagents.add(event.toolUseId)
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
            activeSubagents.delete(event.toolUseId)
            subagentContexts.delete(event.toolUseId)
            if (!ctx) return
            const rawResultText = toolResultText(event.content)
            const collabStatus: 'completed' | 'failed' = event.isError ? 'failed' : 'completed'
            const agentStatus: 'completed' | 'errored' = event.isError ? 'errored' : 'completed'

            // claude-agent-sdk's Task tool appends a metadata trailer to the
            // result content: an `agentId: <hex>` line + a `<usage>...</usage>`
            // block. Codex App doesn't render those — they just leak as raw
            // text. Strip them from the visible body and route the metadata
            // into the proper protocol fields (agentNickname / tokenUsage /
            // metrics) so the subagent timeline carries the same identity +
            // usage the SDK reports.
            const parsed = parseSubagentTrailer(rawResultText)
            const resultText = parsed.cleanText

            // Materialize a one-turn transcript on the child thread so the
            // Codex App can drill in from the parent collabAgentToolCall.
            const childTurn: TurnRecord = {
              id: newId(),
              threadId: ctx.childThreadId,
              status: event.isError ? 'failed' : 'completed',
              startedAt: nowSeconds(),
              completedAt: nowSeconds(),
              durationMs: parsed.usage?.durationMs ?? 0,
              items: [
                {
                  type: 'userMessage',
                  id: newId(),
                  content: [{ type: 'text', text: ctx.prompt, text_elements: [] }],
                },
                {
                  type: 'agentMessage',
                  id: newId(),
                  text: resultText,
                  phase: null,
                  memoryCitation: null,
                },
              ],
              diff: '',
              error: event.isError ? { message: 'subagent failed' } : null,
              apiDurationMs: parsed.usage?.durationMs ?? null,
              numTurns: parsed.usage?.toolUses ?? null,
              costUsd: null,
            }
            this.store.upsertTurn(childTurn)
            const childThread = this.store.getThread(ctx.childThreadId)
            if (childThread) {
              childThread.status = { type: 'idle' }
              childThread.updatedAt = nowSeconds()
              // Replace our synthetic `agent-{hex}` nickname with the SDK-
              // assigned id so SendMessage / SubAgent navigation in the App
              // uses the same handle the SDK reports.
              if (parsed.agentId) childThread.agentNickname = parsed.agentId
              this.store.upsertThread(childThread)
            }

            // Push the subagent's token usage as a Codex-native
            // thread/tokenUsage/updated notification on the CHILD thread
            // (App's status bar reads from this) and roll the totals into
            // the parent thread so subagent costs aren't invisible.
            if (parsed.usage && parsed.usage.totalTokens) {
              const breakdown: TokenUsageBreakdown = {
                totalTokens: parsed.usage.totalTokens,
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: parsed.usage.totalTokens,
                reasoningOutputTokens: 0,
              }
              const childUsage: ThreadTokenUsage = {
                total: breakdown,
                last: breakdown,
                modelContextWindow: null,
              }
              this.notify(peer, {
                method: 'thread/tokenUsage/updated',
                params: {
                  threadId: ctx.childThreadId,
                  turnId: childTurn.id,
                  tokenUsage: childUsage,
                },
              })
              this.recordTokenUsage(peer, thread.id, turn.id, {
                input_tokens: 0,
                output_tokens: parsed.usage.totalTokens,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              })
            }

            // Stage 2 close — wait (end). Re-emits the same waitItemId.
            const waitEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: ctx.waitItemId,
              tool: 'wait',
              status: collabStatus,
              senderThreadId: thread.id,
              receiverThreadIds: [ctx.childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
            }
            this.store.updateItem(turn.id, ctx.waitItemId, () => waitEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitEnd,
                completedAtMs: nowMillis(),
              },
            })

            // Stage 3 — closeAgent (begin + end emitted together; the SDK has
            // already torn down the subagent by the time we get the result).
            const closeId = newId()
            const closeBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: closeId,
              tool: 'closeAgent',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [ctx.childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, closeBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: closeBegin,
                startedAtMs: nowMillis(),
              },
            })
            const closeEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: closeId,
              tool: 'closeAgent',
              status: collabStatus,
              senderThreadId: thread.id,
              receiverThreadIds: [ctx.childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
            }
            this.store.updateItem(turn.id, closeId, () => closeEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: closeEnd,
                completedAtMs: nowMillis(),
              },
            })
            return
          }
          if (event.type === 'text_delta') {
            // In plan mode, text is the plan body — route to a Plan item +
            // item/plan/delta + (later) turn/plan/updated so the App's
            // Plan-mode UI lights up natively. Outside plan mode it's a
            // normal agentMessage delta.
            if (planMode) {
              const itemId = ensurePlanItem()
              this.store.updateItem(turn.id, itemId, (item) => {
                if (item.type === 'plan') return { ...item, text: item.text + event.delta }
                return item
              })
              this.notify(peer, {
                method: 'item/plan/delta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
              })
              return
            }
            const itemId = ensureAgentItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'agentMessage') return { ...item, text: item.text + event.delta }
              return item
            })
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
            })
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
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                delta: event.delta,
                summaryIndex: 0,
              },
            })
            this.notify(peer, {
              method: 'item/reasoning/textDelta',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                delta: event.delta,
                contentIndex: 0,
              },
            })
            return
          }
          if (event.type === 'tool_use') {
            // Defense in depth against duplicate tool_use events for the same
            // tool_use_id. Claude SDK has been known to emit a block_start
            // event with an empty input AND a complete copy in the final
            // AssistantMessage — sidecar suppresses the empty start, but if
            // anything slips through we'd otherwise create a husk
            // commandExecution item that never closes (the second emit
            // overwrites itemIds[] so the husk never sees its tool_result).
            if (itemIds.has(event.toolUseId)) return
            // Claude's TodoWrite is the equivalent of Codex's `update_plan`
            // todo/checklist tool, which the real app-server maps to a
            // turn/plan/updated notification (structured steps) rather than a
            // timeline item. Mirror that: emit the structured plan and suppress
            // the generic tool item so the App's plan/checklist UI drives off
            // the spec'd notification.
            if (event.toolName === 'TodoWrite') {
              const plan = todoWriteToPlanSteps(event.input)
              if (plan) {
                this.notify(peer, {
                  method: 'turn/plan/updated',
                  params: { threadId: thread.id, turnId: turn.id, explanation: null, plan },
                })
              }
              itemIds.set(event.toolUseId, '')
              return
            }
            const item = this.toolUseToItem(event, thread.cwd)
            itemIds.set(event.toolUseId, item.id)
            itemStartedAtMs.set(item.id, nowMillis())
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
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
            this.notify(peer, {
              method: 'item/commandExecution/outputDelta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
            })
            return
          }
          if (event.type === 'tool_result') {
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            const resultText = toolResultText(event.content)
            const durationMs = (() => {
              const started = itemStartedAtMs.get(itemId)
              return started == null ? null : Math.max(0, nowMillis() - started)
            })()
            const parsedExitCode = parseExitCodeFromResult(event.content) ?? (event.isError ? 1 : 0)
            const updated = this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  aggregatedOutput: item.aggregatedOutput ?? resultText,
                  exitCode: parsedExitCode,
                  durationMs,
                }
              }
              if (item.type === 'fileChange')
                return { ...item, status: event.isError ? 'failed' : 'completed' }
              if (item.type === 'mcpToolCall') {
                // Protocol-correct shape: McpToolCallResult = {content[], structuredContent, _meta};
                // McpToolCallError = {message}. We previously shipped raw event.content for both
                // which crashed App's ts-rs deserializer for any tool that returned anything richer
                // than a primitive. Always wrap into the strict shape.
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  result: event.isError ? null : wrapMcpToolResult(event.content),
                  error: event.isError ? wrapMcpToolError(event.content) : null,
                  durationMs,
                }
              }
              if (item.type === 'webSearch') {
                return { ...item, action: parseWebSearchAction(item.query, resultText) }
              }
              return item
            })
            const item = updated?.items.find((candidate) => candidate.id === itemId)
            if (item?.type === 'commandExecution' && resultText && !commandOutputSeen.has(itemId)) {
              this.notify(peer, {
                method: 'item/commandExecution/outputDelta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: resultText },
              })
            }
            if (item)
              this.notify(peer, {
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
              })
            const diff = await gitDiff(thread.cwd)
            if (diff) {
              this.store.updateTurnDiff(turn.id, diff)
              this.notify(peer, {
                method: 'turn/diff/updated',
                params: { threadId: thread.id, turnId: turn.id, diff },
              })
            }
            return
          }
          if (event.type === 'notice') {
            const itemId = ensureAgentItem()
            const prefix =
              event.level === 'warning'
                ? '[Claude warning] '
                : event.level === 'error'
                  ? '[Claude error] '
                  : '[Claude event] '
            const delta = prefix + event.message + '\n'
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'agentMessage') return { ...item, text: item.text + delta }
              return item
            })
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta },
            })
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
            // All fragments of the same hook run share one hookRunId so App
            // groups them under a single execution; the format matches
            // Codex's own hookprompt items (one synthetic run id per emit).
            const hookRunId = newId()
            const fragments: Array<{ text: string; hookRunId: string }> = [
              { text: `Hook · ${event.hookName}`, hookRunId },
            ]
            if (event.status) fragments.push({ text: `status: ${event.status}`, hookRunId })
            if (event.decision) fragments.push({ text: `decision: ${event.decision}`, hookRunId })
            if (event.message) fragments.push({ text: event.message, hookRunId })
            const hookItem: ThreadItem = { type: 'hookPrompt', id: newId(), fragments }
            this.store.appendItem(turn.id, hookItem)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: hookItem,
                startedAtMs: nowMillis(),
              },
            })
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: hookItem,
                completedAtMs: nowMillis(),
              },
            })
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
            if (event.claudeSessionId) {
              // Codex-backed threads route the SAME claudeSessionId slot into
              // codex_session_id (used as `codex exec resume <id>` on the
              // next turn). Claude threads keep the original wiring.
              if (isCodexThread) {
                this.store.updateCodexSessionId(thread.id, event.claudeSessionId)
              } else {
                this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
              }
            }
            if (!event.success) throw new Error(event.result ?? 'Claude turn failed')
          }
          if (event.type === 'error') {
            throw new Error(event.message)
          }
        },
        onPermissionRequest: async (event) => {
          let itemId = itemIds.get(event.toolUseId)
          if (!itemId) {
            const item = this.toolUseToItem(
              {
                type: 'tool_use',
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
              },
              thread.cwd,
            )
            itemId = item.id
            itemIds.set(event.toolUseId, item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
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
        onUserInputRequest: async (event) => {
          // Render AskUserQuestion as Codex's native dynamicToolCall item +
          // item/tool/requestUserInput reverse RPC. The App pops its
          // structured choice card; we wait for the answers, finalise the
          // item, then return the structured answer back to the runtime
          // (which forwards it to the model via the canUseTool deny path).
          const item: ThreadItem = {
            type: 'dynamicToolCall',
            id: newId(),
            namespace: 'claude',
            tool: 'AskUserQuestion',
            arguments: { questions: event.questions },
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          }
          this.store.appendItem(turn.id, item)
          const startedAt = nowMillis()
          this.notify(peer, {
            method: 'item/started',
            params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: startedAt },
          })
          this.setThreadStatus(peer, thread.id, {
            type: 'active',
            activeFlags: ['waitingOnUserInput'],
          })
          const answers = await this.requestUserInput(
            peer,
            thread.id,
            turn.id,
            item.id,
            event.questions,
          )
          const contentItems = userInputAnswersAsContent(event.questions, answers)
          const completedItem: ThreadItem = {
            ...item,
            status: 'completed',
            success: true,
            contentItems,
            durationMs: Math.max(0, nowMillis() - startedAt),
          }
          this.store.updateItem(turn.id, item.id, () => completedItem)
          this.notify(peer, {
            method: 'item/completed',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              item: completedItem,
              completedAtMs: nowMillis(),
            },
          })
          this.setThreadStatus(peer, thread.id, { type: 'active', activeFlags: [] })
          return answers
        },
      },
    )

    const finalDiff = await gitDiff(thread.cwd)
    if (finalDiff) {
      this.store.updateTurnDiff(turn.id, finalDiff)
      this.notify(peer, {
        method: 'turn/diff/updated',
        params: { threadId: thread.id, turnId: turn.id, diff: finalDiff },
      })
    }
    if (params.outputSchema != null && agentItemId == null) {
      const text = fallbackStructuredText(params.outputSchema, prompt)
      const itemId = ensureAgentItem()
      this.store.updateItem(turn.id, itemId, (item) => {
        if (item.type === 'agentMessage') return { ...item, text }
        return item
      })
      this.notify(peer, {
        method: 'item/agentMessage/delta',
        params: { threadId: thread.id, turnId: turn.id, itemId, delta: text },
      })
    }
    const latestTurn = this.store.getTurn(turn.id)
    for (const completedItemId of [reasoningItemId, agentItemId, planItemId]) {
      const item = latestTurn?.items.find((candidate) => candidate.id === completedItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
    }
    const completed: TurnRecord = this.store.completeTurn(turn.id, 'completed') ?? turn
    if (collectedMetrics.set) {
      completed.apiDurationMs = collectedMetrics.apiDurationMs
      completed.numTurns = collectedMetrics.numTurns
      completed.costUsd = collectedMetrics.costUsd
    }
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    // Plan-mode text streams through the `plan` ThreadItem + item/plan/delta
    // events; turn/plan/updated is reserved for the update_plan/TodoWrite
    // checklist tool (see the tool_use handler), matching the real app-server
    // which keeps those two surfaces separate.
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
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
    if (
      thread &&
      (thread.approvalPolicy === 'never' || thread.sandboxMode === 'danger-full-access')
    ) {
      return { decision: 'accept' }
    }
    const command = String(event.input.command ?? '')
    if (command && this.commandSessionAllow.get(threadId)?.has(command)) {
      return { decision: 'accept' }
    }

    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: ['waitingOnApproval'] })
    const requestId = newId()
    const isCommand = event.toolName === 'Bash'
    const method = isCommand
      ? 'item/commandExecution/requestApproval'
      : 'item/fileChange/requestApproval'
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

  private async requestUserInput(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    questions: UserInputQuestion[],
  ): Promise<UserInputAnswers> {
    const requestId = newId()
    // Always guarantee an "Other" affordance so the App's free-text fallback
    // is available, even when the upstream caller (Claude tool input, mock
    // runtime, etc.) didn't model it explicitly.
    const normalized = questions.map((q) => {
      const options = q.options ?? []
      const hasOther = options.some((o) => o.label === 'Other')
      return hasOther
        ? q
        : {
            ...q,
            options: [...options, { label: 'Other', description: 'Provide a free-form answer' }],
          }
    })
    const params = { threadId, turnId, itemId, questions: normalized }
    let response: unknown
    try {
      response = await this.sendServerRequest(peer, 'item/tool/requestUserInput', requestId, params)
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
    }
    return normalizeUserInputAnswers(response, normalized)
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
        const completed =
          this.store.completeTurn(turnId, 'interrupted', { message: 'interrupted' }) ?? turn
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
      }
    }
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
    return {}
  }

  private async turnSteer(_peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const expectedTurnId = stringOr(params.expectedTurnId, '')
    const activeTurnId = this.activeTurnByThread.get(threadId)
    if (!activeTurnId) throw new Error(`thread has no active turn: ${threadId}`)
    if (expectedTurnId && expectedTurnId !== activeTurnId) {
      throw new Error(`active turn mismatch: expected ${expectedTurnId}, got ${activeTurnId}`)
    }
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    const prompt = textFromInput(input)
    // The steered message is retained on the turn for history (thread/read), but
    // — like a normal turn's user message — it is NOT surfaced as a userMessage
    // item/started+item/completed event. The real app-server's turn_steer just
    // feeds the input into the core (steer_input) and EventMsg::UserMessage is
    // unhandled in the live stream, so no userMessage item event is emitted.
    const item: ThreadItem = { type: 'userMessage', id: newId(), content: input }
    this.store.appendItem(activeTurnId, item)
    await this.runtime.steer(threadId, prompt)
    return { turnId: activeTurnId }
  }

  private configRead(): unknown {
    // Base config = our typed defaults; overrides (whatever the App's
    // settings sheet has written previously via config/value/write) are
    // layered on top so the user sees their last-saved values instead of
    // the defaults bouncing back on every reconnect. Typed fields (model /
    // model_reasoning_effort) take precedence over overrides since they're
    // applied via a stricter validator.
    return {
      config: {
        ...this.configOverrides,
        model: this.configModel,
        review_model: null,
        model_context_window: null,
        model_auto_compact_token_limit: null,
        model_provider: 'claude-code',
        approval_policy: this.configOverrides.approval_policy ?? 'on-request',
        approvals_reviewer: this.configOverrides.approvals_reviewer ?? 'user',
        sandbox_mode: this.configOverrides.sandbox_mode ?? 'workspace-write',
        sandbox_workspace_write: this.configOverrides.sandbox_workspace_write ?? null,
        forced_chatgpt_workspace_id: null,
        forced_login_method: null,
        web_search: this.configOverrides.web_search ?? 'disabled',
        tools: this.configOverrides.tools ?? null,
        profile: this.configOverrides.profile ?? null,
        profiles: {},
        instructions: this.configOverrides.instructions ?? null,
        developer_instructions: this.configOverrides.developer_instructions ?? null,
        compact_prompt: this.configOverrides.compact_prompt ?? null,
        model_reasoning_effort: this.configReasoningEffort,
        model_reasoning_summary: this.configOverrides.model_reasoning_summary ?? null,
        model_verbosity: this.configOverrides.model_verbosity ?? null,
        service_tier: this.configOverrides.service_tier ?? null,
        analytics: this.configOverrides.analytics ?? null,
        apps: this.configOverrides.apps ?? null,
        model_providers: this.exposedModelProviders(),
      },
      origins: {
        model_provider: configLayerMetadata(),
        'model_providers.claude-code': configLayerMetadata(),
        ...(codexProxyModelOptions().length > 0
          ? { 'model_providers.codex': configLayerMetadata() }
          : {}),
      },
      layers: null,
    }
  }

  // Build the model_providers map served by config/read. Always exposes
  // 'claude-code'; conditionally adds 'codex' when a real Codex CLI is
  // resolvable on the host. Exposing 'codex' as a separate provider entry
  // gives the App's settings panel a way to surface OpenAI-family models
  // (gpt-*) without the App treating them as foreign to the Claude
  // provider's allowlist.
  private exposedModelProviders(): Record<string, unknown> {
    const providers: Record<string, unknown> = {
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
    }
    if (codexProxyModelOptions().length > 0) {
      // 'codex' = real OpenAI Codex CLI forwarded via `codex exec --json`.
      // Auth is delegated to the real codex binary (its own OAuth login),
      // so we advertise requires_openai_auth: false to keep our own
      // account/read amazonBedrock shim from gating these.
      providers.codex = {
        name: 'Codex (OpenAI · forwarded)',
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
      }
    }
    return providers
  }

  private modelList(): unknown {
    const defaultModel = this.configModel
    const claudeOptions = claudeModelOptions()
    // When a real Codex CLI binary is available on the host (CODEX_REAL env
    // or auto-discovered), expose its native models alongside Claude's so
    // the Codex App's per-thread model picker can route between backends
    // without any reconnect or shell flip. Picking gpt-* flips the thread
    // to runtimeBackend='codex' which the runtime router dispatches to
    // CodexProxyRuntime (shells out to `codex exec --json`).
    const codexOptions = codexProxyModelOptions()
    const options = [...claudeOptions, ...codexOptions]
    const hasConfiguredDefault = options.some((option) => option.id === defaultModel)
    const reasoningEfforts = [
      { reasoningEffort: 'low', description: 'Fast runtime response' },
      { reasoningEffort: 'medium', description: 'Balanced runtime response' },
      { reasoningEffort: 'high', description: 'Deeper runtime response' },
      { reasoningEffort: 'xhigh', description: 'Maximum reasoning' },
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
  private recordTokenUsage(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    usage: Record<string, unknown>,
  ): void {
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
    this.notify(peer, {
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage },
    })
    // NOTE: previously we also pushed `account/rateLimits/updated` here on
    // every token-usage event "to keep the UI in sync". That backfired —
    // Codex App treats every such notification as a fresh rate-limit signal
    // and surfaces it as a transient warning banner, so the user saw a
    // rate-limit pop on every assistant turn. Since we don't actually have
    // real rate-limit data from the Anthropic SDK (no headers exposed), the
    // notification was empty noise. The initial snapshot still fires once
    // post-handshake in `initialize` so the UI populates on first connect.
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
    const data =
      typeof params.dataBase64 === 'string'
        ? Buffer.from(params.dataBase64, 'base64')
        : Buffer.alloc(0)
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
    await rm(stringOr(params.path, ''), {
      recursive: params.recursive !== false,
      force: params.force !== false,
    })
    return {}
  }

  private async fsCopy(params: Record<string, unknown>): Promise<unknown> {
    const { cp } = await import('node:fs/promises')
    await cp(stringOr(params.sourcePath, ''), stringOr(params.destinationPath, ''), {
      recursive: params.recursive === true,
    })
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
    if (
      (params.streamStdoutStderr === true || params.streamStdin === true || params.tty === true) &&
      typeof params.processId !== 'string'
    ) {
      throw new Error('command/exec streaming requires processId')
    }

    const executable = command[0] as string
    const streamOutput = params.streamStdoutStderr === true || params.tty === true
    const cwd = stringOr(params.cwd, process.cwd())
    debugLog('command.exec.start', {
      processId,
      cwd,
      command,
      streamOutput,
      streamStdin: params.streamStdin === true,
      tty: params.tty === true,
    })
    const child = spawn(executable, command.slice(1), {
      cwd,
      env: commandEnv(params.env),
      stdio: 'pipe',
    })
    this.commandProcesses.set(processId, child)

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const cap =
      params.disableOutputCap === true
        ? Number.POSITIVE_INFINITY
        : numberOr(params.outputBytesCap, 1_000_000)
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
        this.notify(peer, {
          method: 'command/exec/outputDelta',
          params: {
            processId,
            stream: 'stdout',
            deltaBase64: buffer.toString('base64'),
            capReached: false,
          },
        })
        return
      }
      stdoutBytes = capture(stdout, buffer, stdoutBytes)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, {
          method: 'command/exec/outputDelta',
          params: {
            processId,
            stream: 'stderr',
            deltaBase64: buffer.toString('base64'),
            capReached: false,
          },
        })
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
        debugLog('command.exec.error', {
          processId,
          error: error.message,
          code: (error as NodeJS.ErrnoException).code,
        })
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
    if (this.processHandles.has(processHandle))
      throw new Error(`process handle already active: ${processHandle}`)
    const command = commandArray(params.command)
    if (command.length === 0) throw new Error('process/spawn requires command')
    const cwd = stringOr(params.cwd, process.cwd())
    const streamOutput = params.streamStdoutStderr === true || params.tty === true
    const cap =
      params.outputBytesCap == null ? 1_000_000 : numberOr(params.outputBytesCap, 1_000_000)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutCapReached = false
    let stderrCapReached = false
    let exited = false
    debugLog('process.spawn.start', {
      processHandle,
      cwd,
      command,
      streamOutput,
      streamStdin: params.streamStdin === true,
      tty: params.tty === true,
    })
    const child = spawn(command[0] as string, command.slice(1), {
      cwd,
      env: commandEnv(params.env),
      stdio: 'pipe',
    })
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
        this.notify(peer, {
          method: 'process/outputDelta',
          params: {
            processHandle,
            stream: 'stdout',
            deltaBase64: buffer.toString('base64'),
            capReached: false,
          },
        })
      } else {
        ;[stdoutBytes, stdoutCapReached] = capture(stdout, buffer, stdoutBytes)
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, {
          method: 'process/outputDelta',
          params: {
            processHandle,
            stream: 'stderr',
            deltaBase64: buffer.toString('base64'),
            capReached: false,
          },
        })
      } else {
        ;[stderrBytes, stderrCapReached] = capture(stderr, buffer, stderrBytes)
      }
    })
    const timeoutMs = params.timeoutMs == null ? 60_000 : numberOr(params.timeoutMs, 60_000)
    const timeout = timeoutMs > 0 ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null
    child.once('error', (error) => {
      debugLog('process.spawn.error', {
        processHandle,
        error: error.message,
        code: (error as NodeJS.ErrnoException).code,
      })
      if (exited) return
      exited = true
      if (timeout) clearTimeout(timeout)
      this.processHandles.delete(processHandle)
      setImmediate(() =>
        this.notify(peer, {
          method: 'process/exited',
          params: {
            processHandle,
            exitCode: 1,
            stdout: streamOutput ? '' : Buffer.concat(stdout).toString('utf8'),
            stdoutCapReached,
            stderr: error.message,
            stderrCapReached: false,
          },
        }),
      )
    })
    child.once('close', (code, signal) => {
      if (exited) return
      exited = true
      debugLog('process.spawn.close', {
        processHandle,
        code,
        signal,
        stdoutBytes,
        stderrBytes,
        stdoutCapReached,
        stderrCapReached,
      })
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
    if (typeof params.deltaBase64 === 'string' && params.deltaBase64.length > 0)
      child.stdin?.write(Buffer.from(params.deltaBase64, 'base64'))
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
    const marketplaceName = stringOr(
      params.refName,
      source.split('/').filter(Boolean).at(-1) ?? 'marketplace',
    )
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
    const marketplaceName =
      typeof params.marketplaceName === 'string' ? params.marketplaceName : null
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
      const { keyPath, value } = edit
      if (keyPath === 'model' && typeof value === 'string' && value.length > 0) {
        this.configModel = normalizeSelectableModelId(value, this.configModel)
      } else if (keyPath === 'model_reasoning_effort' && typeof value === 'string') {
        this.configReasoningEffort =
          normalizeCodexReasoningEffort(value) ?? this.configReasoningEffort
      } else {
        // Unknown key — store in the generic overrides bag so it survives a
        // restart even though we don't apply it to typed runtime state. This
        // captures approvalPolicy, sandboxMode, instruction toggles, anything
        // the App's settings sheet may emit. `null` value clears the entry.
        if (value === null || value === undefined) {
          delete this.configOverrides[keyPath]
        } else {
          this.configOverrides[keyPath] = value
        }
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
        source: normalizeSessionSource(thread?.source),
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
    const query = stringOr(params.query, '')
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : [process.cwd()]
    return { files: await this.fuzzySearchCore(query, roots) }
  }

  private async fuzzySearchCore(
    rawQuery: string,
    roots: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const query = rawQuery.toLowerCase()
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
    return files
  }

  private fuzzySessionStart(params: Record<string, unknown>): unknown {
    const sessionId = stringOr(params.sessionId, '')
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : [process.cwd()]
    if (sessionId) this.fuzzySessions.set(sessionId, { roots })
    return {}
  }

  private async fuzzySessionUpdate(
    peer: RpcPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionId = stringOr(params.sessionId, '')
    const query = stringOr(params.query, '')
    const session = this.fuzzySessions.get(sessionId)
    const roots = session?.roots ?? [process.cwd()]
    const files = await this.fuzzySearchCore(query, roots)
    if (sessionId && this.fuzzySessions.get(sessionId) === session) {
      this.notify(peer, {
        method: 'fuzzyFileSearch/sessionUpdated',
        params: { sessionId, query, files },
      })
    }
    return {}
  }

  private fuzzySessionStop(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const sessionId = stringOr(params.sessionId, '')
    this.fuzzySessions.delete(sessionId)
    if (sessionId) {
      this.notify(peer, {
        method: 'fuzzyFileSearch/sessionCompleted',
        params: { sessionId },
      })
    }
    return {}
  }

  private toolUseToItem(
    event: Extract<RuntimeEvent, { type: 'tool_use' }>,
    cwd: string,
  ): ThreadItem {
    const id = newId()
    if (event.toolName === 'Bash') {
      return {
        type: 'commandExecution',
        id,
        command: String(event.input.command ?? ''),
        cwd: String(event.input.cwd ?? cwd),
        // Use the SDK's tool_use_id as a stable handle. Without a non-null
        // processId the Codex App was treating these as "Background terminal"
        // entries (no attached process) and hiding their output; with a
        // synthetic id they render as inline command items like a normal
        // foreground bash invocation.
        processId: `claude:${event.toolUseId}`,
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
      // the search badge (and follow-up open-page links) natively. The action
      // is finalized when the tool_result arrives (see tool_result handler).
      // The 'search' variant's `query` / `queries` are required (Option fields
      // with no serde default), so always populate both even on the initial
      // inProgress emit.
      const q = String(event.input.query ?? '')
      return {
        type: 'webSearch',
        id,
        query: q,
        action: { type: 'search', query: q || null, queries: null },
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
      // Defense-in-depth: even if older rows hold an invalid `source` or
      // `threadSource` (legacy `app_server`, empty string from a buggy write
      // path), coerce on the way out so the App's strict deserializer never
      // sees a value outside the wire enum.
      source: normalizeSessionSource(thread.source),
      threadSource: normalizeThreadSource(thread.threadSource),
      agentNickname: nullIfEmpty(thread.agentNickname),
      agentRole: nullIfEmpty(thread.agentRole),
      gitInfo: null,
      name: thread.name,
      turns: turns.map((turn) => this.toTurn(turn)),
    }
  }

  // Full turn payload for history reads (thread/read, turns/list) — carries the
  // loaded items. The Codex v2 `Turn` schema has no api/cost metadata fields, so
  // the adapter's internal metrics are not serialized onto the wire.
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

  // Turn payload for the turn lifecycle surface (turn/start response,
  // turn/started, turn/completed). The real codex app-server deliberately ships
  // an empty `items` list with `itemsView: "notLoaded"` here: the App's timeline
  // is driven by the item/* event stream, not by items embedded in these turn
  // envelopes. Re-shipping the full item list risks duplicate rendering.
  private toLifecycleTurn(turn: TurnRecord, items: ThreadItem[] = []): unknown {
    return {
      id: turn.id,
      items,
      itemsView: 'notLoaded',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  private sendResponse(
    peer: RpcPeer,
    id: JsonRpcId,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
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

  private setThreadStatus(
    peer: RpcPeer | null,
    threadId: string,
    status: ThreadRecord['status'],
  ): void {
    this.store.updateThreadStatus(threadId, status)
    const target = peer ?? this.activePeerByThread.get(threadId)
    if (target)
      this.notify(target, { method: 'thread/status/changed', params: { threadId, status } })
  }

  private sendServerRequest(
    peer: RpcPeer,
    method: string,
    id: string,
    params: unknown,
  ): Promise<unknown> {
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
        this.configReasoningEffort =
          normalizeCodexReasoningEffort(parsed.model_reasoning_effort) ?? this.configReasoningEffort
      }
      // Restore the overrides bag — any key persisted previously that isn't
      // the strongly-typed model / effort lives here so it survives restarts.
      if (
        parsed.overrides &&
        typeof parsed.overrides === 'object' &&
        !Array.isArray(parsed.overrides)
      ) {
        this.configOverrides = parsed.overrides as Record<string, unknown>
      }
      if (shouldRepair) this.persistConfig()
    } catch {}
  }

  private persistConfig(): void {
    try {
      ensureParent(this.configPath)
      writeFileSync(
        this.configPath,
        JSON.stringify(
          {
            model: this.configModel,
            model_reasoning_effort: this.configReasoningEffort,
            overrides: this.configOverrides,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } catch {}
  }
}
