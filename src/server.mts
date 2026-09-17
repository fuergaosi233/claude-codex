import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, type FSWatcher, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { listClaudeHooks, listClaudeSkills } from './claude-capabilities.mjs'
import { callMcpTool, listMcpServerStatuses, readMcpConfig, readMcpResource } from './mcp.mjs'
import { projectProviderLoopConfig } from './provider-loop-config.mjs'
import {
  hasProviderLoopSelectionInput,
  isProviderLoopSelectionConfigKey,
  type ProviderLoopSelectionInput,
  providerLoopSelectionInputFromConfig,
  providerLoopSelectionInputFromEnv,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'
import { recordRunEvent } from './run-registry.mjs'
import { normalizeRuntimeType } from './runtime-config.mjs'
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
  hasLegacyPermissionParams,
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
  permissionProfileIdFromParams,
  permissionProfileList,
  permissionProfilePolicy,
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
  threadPermissionProfileId,
  todoWriteToPlanSteps,
  tokenBreakdownFromClaudeUsage,
  toolResultText,
  userInputAnswersAsContent,
  wrapMcpToolError,
  wrapMcpToolResult,
} from './server-helpers.mjs'
import { PINNED_SECTION_ID, type SessionStore } from './store.mjs'
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
  ThreadSectionAppearance,
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
import { parseWorkflowCommand } from './workflow-command.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'

const execFileAsync = promisify(execFile)

// A missing Claude Task result must not keep Codex cc in its working state
// forever. This is deliberately a long, configurable watchdog for the whole
// subagent phase; it is not the short journal-drain grace period used when a
// terminal notification has already arrived.
const DEFAULT_SUBAGENT_WATCHDOG_MS = 30 * 60 * 1000
const MIN_SUBAGENT_WATCHDOG_MS = 100

function isWorkflowToolName(value: string): boolean {
  const name = value.trim().toLowerCase()
  return name === 'workflow' || name === 'workflows'
}

function subagentWatchdogTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_SUBAGENT_WATCHDOG_MS
  const parsed = Number(raw)
  // Zero is the documented opt-out. Invalid and negative values must fall
  // back to the bounded default rather than silently reintroducing an
  // unbounded loading state.
  if (!Number.isFinite(parsed)) return DEFAULT_SUBAGENT_WATCHDOG_MS
  if (parsed === 0) return 0
  if (parsed < 0) return DEFAULT_SUBAGENT_WATCHDOG_MS
  return Math.max(MIN_SUBAGENT_WATCHDOG_MS, Math.floor(parsed))
}

type TurnItemsView = 'full' | 'summary' | 'notLoaded'

interface SubagentContext {
  childThreadId: string
  childTurnId: string
  waitItemId: string
  agentPath: string
  prompt: string
  subType: string | null
}

interface ActiveSubagentState {
  thread: ThreadRecord
  turn: TurnRecord
  contexts: Map<string, SubagentContext>
  active: Set<string>
}

interface PeerFeatures {
  // Codex cc 26.818.61809 only accepts started/interacted/interrupted in the
  // subAgentActivity schema. Newer clients may opt into the completed kind
  // explicitly during initialize; keep the legacy wire shape otherwise.
  supportsCompletedSubagentActivity: boolean
}

function turnItemsView(value: unknown): TurnItemsView {
  if (value === 'full' || value === 'summary' || value === 'notLoaded') return value
  return 'summary'
}

export class CodexClaudeAppServer {
  private pendingServerRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private activePeerByThread = new Map<string, RpcPeer>()
  private peerFeatures = new WeakMap<RpcPeer, PeerFeatures>()
  private activeTurnByThread = new Map<string, string>()
  private subagentStateByTurn = new Map<string, ActiveSubagentState>()
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
    // Child turns are created directly from Task/Workflow events and are not
    // registered in activeTurnByThread. Finalize them before aborting the
    // runtime or closing SQLite, otherwise stdio EOF can leave child turns
    // persisted as inProgress until a later restart recovery pass.
    this.finalizeActiveSubagentsForShutdown('server stopped')
    this.completeActiveTurns('interrupted', { message: 'server stopped' })
    await this.runtime.stop()
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
        const capabilities = asRecord(initParams.capabilities)
        const declaredActivityKinds = Array.isArray(capabilities.subAgentActivityKinds)
          ? capabilities.subAgentActivityKinds
          : []
        this.peerFeatures.set(peer, {
          supportsCompletedSubagentActivity:
            capabilities.subAgentActivityCompleted === true ||
            declaredActivityKinds.includes('completed') ||
            process.env.CLAUDE_CODEX_SUBAGENT_COMPLETED === '1',
        })
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
      case 'thread/section/move':
        return this.threadSectionMove(asRecord(params))
      case 'threadSection/list':
        return this.threadSectionList(asRecord(params))
      case 'threadSection/create':
        return this.threadSectionCreate(asRecord(params))
      case 'threadSection/update':
        return this.threadSectionUpdate(asRecord(params))
      case 'threadSection/delete':
        return this.threadSectionDelete(asRecord(params))
      case 'thread/settings/update':
        return this.threadSettingsUpdate(peer, asRecord(params))
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
      case 'permissionProfile/list':
        return permissionProfileList(asRecord(params))
      case 'experimentalFeature/enablement/set':
        return { enablement: asRecord(asRecord(params).enablement) }
      case 'collaborationMode/list':
        return method === 'collaborationMode/list' ? { data: [] } : {}
      case 'mock/experimentalMethod':
        return {
          echoed: typeof asRecord(params).value === 'string' ? asRecord(params).value : null,
        }
      case 'skills/list':
        return { data: listClaudeSkills(asRecord(params)) }
      case 'hooks/list':
        return { data: listClaudeHooks(asRecord(params)) }
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
        return this.processResizePty(asRecord(params))
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
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    const selectedProviderLoop = resolveProviderLoopSelection(this.providerLoopSelectionInput())
    const isTitleOrHelper =
      params.ephemeral === true ||
      params.threadSource === 'title_generation' ||
      params.threadSource === 'memory_consolidation'
    const thread: ThreadRecord = {
      id,
      sessionId: id,
      forkedFromId: null,
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
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
      approvalPolicy:
        permissionProfile?.approvalPolicy ??
        normalizeApprovalPolicy(params.approvalPolicy) ??
        'never',
      sandboxMode:
        permissionProfile?.sandboxMode ??
        normalizeSandboxMode(params.sandbox) ??
        'danger-full-access',
      permissionProfileId: permissionProfile?.id ?? null,
      ephemeral: isTitleOrHelper,
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
      runtimeBackend:
        selectedProviderLoop.runtimeType === 'codex-proxy' || isCodexOpenAiModel(model)
          ? 'codex'
          : 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    recordRunEvent('thread.started', {
      threadId: thread.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread)
  }

  private threadResume(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
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
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (typeof params.approvalPolicy === 'string')
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      if (typeof params.sandbox === 'string')
        thread.sandboxMode = normalizeSandboxMode(params.sandbox)
    }
    if (typeof params.threadSource === 'string')
      thread.threadSource = normalizeThreadSource(params.threadSource)
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    this.store.upsertThread(thread)
    recordRunEvent('thread.resumed', {
      threadId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(threadId, peer)
    this.bindPeerToDescendants(peer, threadId)
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
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
      archived: false,
      cwd,
      model: modelFromParams(params, parent.model),
      reasoningEffort: reasoningEffortFromParams(params, parent.reasoningEffort),
      claudeSessionId: parent.claudeSessionId,
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy:
        permissionProfilePolicy(permissionProfileIdFromParams(params))?.approvalPolicy ??
        (typeof params.approvalPolicy === 'string'
          ? normalizeApprovalPolicy(params.approvalPolicy)
          : parent.approvalPolicy),
      sandboxMode:
        permissionProfilePolicy(permissionProfileIdFromParams(params))?.sandboxMode ??
        (typeof params.sandbox === 'string'
          ? normalizeSandboxMode(params.sandbox)
          : parent.sandboxMode),
      permissionProfileId:
        permissionProfileIdFromParams(params) ??
        (hasLegacyPermissionParams(params) ? null : (parent.permissionProfileId ?? null)),
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
    recordRunEvent('thread.forked', {
      threadId: thread.id,
      parentThreadId: parent.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(
      thread,
      params.excludeTurns === true ? [] : this.store.listTurns(parent.id),
    )
  }

  private threadList(params: Record<string, unknown>): unknown {
    const sourceKinds = Array.isArray(params.sourceKinds)
      ? params.sourceKinds.filter((value): value is string => typeof value === 'string')
      : []
    const parentThreadId =
      typeof params.parentThreadId === 'string' && params.parentThreadId.length > 0
        ? params.parentThreadId
        : null
    const ancestorThreadId =
      typeof params.ancestorThreadId === 'string' && params.ancestorThreadId.length > 0
        ? params.ancestorThreadId
        : null
    const sortKey =
      params.sortKey === 'updated_at' ||
      params.sortKey === 'recency_at' ||
      params.sortKey === 'section_position'
        ? params.sortKey
        : 'created_at'
    const sortDirection = params.sortDirection === 'asc' ? 'asc' : 'desc'
    const isPinned = typeof params.isPinned === 'boolean' ? params.isPinned : null
    const sectionId =
      params.sectionId === null
        ? null
        : typeof params.sectionId === 'string'
          ? params.sectionId
          : undefined
    const threads = this.store.listThreads({
      archived: (params.archived as boolean | null | undefined) ?? null,
      limit: numberOr(params.limit, 50),
      cursor: typeof params.cursor === 'string' ? params.cursor : null,
      isPinned,
      sectionId,
      cwd:
        typeof params.cwd === 'string' || Array.isArray(params.cwd)
          ? (params.cwd as string | string[])
          : null,
      includeEphemeral: params.includeEphemeral === true,
      parentThreadId,
      ancestorThreadId,
      sourceKinds,
      sortKey,
      sortDirection,
    })
    const last = threads.at(-1)
    const cursorValue = (thread: ThreadRecord): number =>
      sortKey === 'section_position'
        ? (thread.sectionPosition ?? thread.createdAt)
        : sortKey === 'created_at'
          ? thread.createdAt
          : thread.updatedAt
    return {
      data: threads.map((thread) => this.toThread(thread, [])),
      nextCursor:
        last && threads.length >= numberOr(params.limit, 50) ? String(cursorValue(last)) : null,
      backwardsCursor: threads[0] ? String(cursorValue(threads[0])) : null,
    }
  }

  private threadSectionMove(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    if (params.sectionId !== null && typeof params.sectionId !== 'string')
      throw new Error('sectionId must be a string or null')
    const sectionId = params.sectionId === null ? null : params.sectionId
    if (sectionId === '') throw new Error('sectionId must not be empty')
    const beforeThreadId =
      typeof params.beforeThreadId === 'string' && params.beforeThreadId.length > 0
        ? params.beforeThreadId
        : null
    const moved = this.store.moveThreadToSection(threadId, sectionId, beforeThreadId)
    debugLog('thread.section.moved', {
      threadId,
      sectionId: moved.sectionId ?? null,
      isPinned: moved.isPinned === true,
      beforeThreadId,
    })
    return {}
  }

  private threadSectionList(params: Record<string, unknown>): unknown {
    const sections = this.store.listSections(
      numberOr(params.limit, 100),
      typeof params.cursor === 'string' ? params.cursor : null,
    )
    return { data: sections, nextCursor: null }
  }

  private threadSectionCreate(params: Record<string, unknown>): unknown {
    const name = stringOr(params.name, '')
    const section = this.store.createSection(
      newId(),
      name,
      this.sectionAppearance(params.appearance),
    )
    return { section }
  }

  private threadSectionUpdate(params: Record<string, unknown>): unknown {
    const sectionId = stringOr(params.sectionId, '')
    const existing = this.store.getSection(sectionId)
    if (!existing) throw new Error(`unknown section: ${sectionId}`)
    const name = typeof params.name === 'string' ? params.name : existing.name
    const appearance =
      params.appearance === undefined
        ? existing.appearance
        : this.sectionAppearance(params.appearance)
    return { section: this.store.updateSection(sectionId, name, appearance) }
  }

  private threadSectionDelete(params: Record<string, unknown>): unknown {
    this.store.deleteSection(stringOr(params.sectionId, ''))
    return {}
  }

  private sectionAppearance(value: unknown): ThreadSectionAppearance | null {
    if (value == null) return null
    const record = asRecord(value)
    return {
      color: typeof record.color === 'string' ? record.color : null,
      icon: typeof record.icon === 'string' ? record.icon : null,
    }
  }

  private threadRead(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    // Codex cc hydrates the Subagent panel with includeTurns:false. A
    // parent-linked child with no renderable turns is treated by that client
    // as still loading, and it does not reliably follow up with turns/list.
    // Keep metadata-only reads for ordinary threads, but return the small
    // child transcript so Prompt/Response and the terminal state can render.
    const includeTurns = params.includeTurns !== false || thread.threadSource === 'subagent'
    const turns = includeTurns ? this.store.listTurns(threadId) : []
    return { thread: this.toThread(thread, turns) }
  }

  private threadTurnsList(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const itemsView = turnItemsView(params.itemsView)
    return {
      data: this.store.listTurns(threadId).map((turn) => this.toTurnView(turn, itemsView)),
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

    // Support dynamic model, reasoning effort, approval policy and sandbox updates
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (model) {
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      thread.runtimeBackend = newBackend
      thread.model = model
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (typeof params.approvalPolicy === 'string')
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    if (typeof params.sandbox === 'string')
      thread.sandboxMode = normalizeSandboxMode(params.sandbox)
    if (typeof params.isPinned === 'boolean') {
      const currentlyPinned = thread.sectionId === PINNED_SECTION_ID || thread.isPinned === true
      if (currentlyPinned !== params.isPinned) {
        const moved = this.store.moveThreadToSection(
          threadId,
          params.isPinned ? PINNED_SECTION_ID : null,
          null,
        )
        thread.isPinned = moved.isPinned
        thread.sectionId = moved.sectionId
        thread.sectionEnteredAt = moved.sectionEnteredAt
        thread.sectionPosition = moved.sectionPosition
      }
    }
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)

    thread.updatedAt = nowSeconds()
    this.store.upsertThread(thread)

    return this.threadEnvelope(thread, this.store.listTurns(threadId))
  }

  private threadSettingsUpdate(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)

    // Codex App sends model and effort changes through this RPC. Keep these
    // legacy settings fields in the compatibility handler so removing the
    // duplicate dispatch case does not silently disable profile/model
    // switching for existing clients.
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    if (model) {
      thread.runtimeBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      thread.model = model
    }
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    const collaborationMode = asRecord(params.collaborationMode)
    const collaborationSettings = asRecord(collaborationMode.settings)
    const developerInstructions =
      typeof collaborationSettings.developer_instructions === 'string'
        ? collaborationSettings.developer_instructions
        : typeof collaborationSettings.developerInstructions === 'string'
          ? collaborationSettings.developerInstructions
          : null
    if (developerInstructions !== null)
      thread.developerInstructions = nullIfEmpty(developerInstructions)

    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    if (permissionProfileId) thread.permissionProfileId = permissionProfileId
    else if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
    if (permissionProfile?.approvalPolicy) thread.approvalPolicy = permissionProfile.approvalPolicy
    if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    if (typeof params.approvalPolicy === 'string' && !permissionProfile)
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    const sandboxMode = sandboxFromTurnParams(params)
    if (sandboxMode && !permissionProfile) thread.sandboxMode = sandboxMode
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    this.store.upsertThread(thread)

    const activePermissionProfileId = threadPermissionProfileId(
      thread.permissionProfileId,
      thread.approvalPolicy,
      thread.sandboxMode,
    )
    this.notify(peer, {
      method: 'thread/settings/updated',
      params: {
        threadId,
        threadSettings: {
          cwd: thread.cwd,
          approvalPolicy: thread.approvalPolicy ?? 'on-request',
          approvalsReviewer: 'user',
          sandboxPolicy: sandboxEnvelope(thread.sandboxMode, thread.cwd),
          activePermissionProfile: activePermissionProfileId
            ? { id: activePermissionProfileId, extends: null }
            : null,
          model: thread.model,
          modelProvider: thread.modelProvider,
          serviceTier: null,
          effort: thread.reasoningEffort,
          summary: null,
          collaborationMode: {
            mode: 'default',
            settings: {
              model: thread.model,
              reasoning_effort: thread.reasoningEffort,
              developer_instructions: thread.developerInstructions,
            },
          },
          personality: thread.personality,
        },
      },
    })
    return {}
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
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
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
        recordRunEvent('turn.failed', {
          threadId,
          turnId,
          runtimeBackend: thread.runtimeBackend,
          error: { message: error.message },
        })
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
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
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
    const workflowCommand = parseWorkflowCommand(prompt)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const model = modelFromParams(params, thread.model)
    const reasoningEffort = reasoningEffortFromParams(params, thread.reasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    if (model) thread.model = model
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (typeof params.approvalPolicy === 'string')
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      const requestedSandbox = sandboxFromTurnParams(params)
      if (requestedSandbox) thread.sandboxMode = requestedSandbox
    }
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
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
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
      if (params.outputSchema == null && workflowCommand?.type === 'list') {
        this.completeWorkflowListTurn(peer, thread, turn)
        return
      }
      // Carry parsed images through the params bag so runRuntimeTurn can hand
      // them to the runtime context without re-parsing user input.
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        ...params,
        _imageInputs: images,
      }).catch((error) => {
        const current = this.store.getTurn(turnId)
        if (current && current.status !== 'inProgress') return
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

  private completeWorkflowListTurn(peer: RpcPeer, thread: ThreadRecord, turn: TurnRecord): void {
    const itemId = newId()
    const emptyItem: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.store.appendItem(turn.id, emptyItem)
    this.notify(peer, {
      method: 'item/started',
      params: { threadId: thread.id, turnId: turn.id, item: emptyItem, startedAtMs: nowMillis() },
    })

    const text = this.workflowListText(thread.id, turn.id)
    const completedItem: ThreadItem = { ...emptyItem, text }
    this.store.updateItem(turn.id, itemId, () => completedItem)
    this.notify(peer, {
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, itemId, delta: text },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        item: completedItem,
        completedAtMs: nowMillis(),
      },
    })

    const completed = this.store.completeTurn(turn.id, 'completed') ?? turn
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      command: 'workflows.list',
    })
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
  }

  private workflowListText(threadId: string, currentTurnId: string): string {
    const runs = this.store
      .listTurns(threadId)
      .filter((turn) => turn.id !== currentTurnId)
      .map((turn) => {
        const userItem = turn.items.find((item) => item.type === 'userMessage')
        const prompt = userItem?.type === 'userMessage' ? textFromInput(userItem.content) : ''
        const command = parseWorkflowCommand(prompt)
        if (command?.type !== 'run') return null
        const childIds = new Set<string>()
        for (const item of turn.items) {
          if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') continue
          for (const childId of item.receiverThreadIds) childIds.add(childId)
        }
        const agents = Array.from(childIds).map((childId) => {
          const child = this.store.getThread(childId)
          const latestTurn = this.store.listTurns(childId).at(-1)
          return {
            nickname: child?.agentNickname ?? childId.slice(0, 12),
            role: child?.agentRole ?? 'subagent',
            status: latestTurn?.status ?? child?.status.type ?? 'unknown',
          }
        })
        return { turn, prompt: command.prompt, agents }
      })
      .filter((run): run is NonNullable<typeof run> => run !== null)
      .reverse()
      .slice(0, 20)

    if (runs.length === 0) {
      return [
        'No workflow runs in this task.',
        '',
        'Start one with `/workflows <task>`. The adapter runs it through Claude ultracode and exposes its agents as reviewable Codex subagent tasks.',
      ].join('\n')
    }

    const lines = ['Workflow runs in this task:']
    for (const run of runs) {
      const task = run.prompt.replace(/\s+/g, ' ').slice(0, 120)
      lines.push(
        `- ${run.turn.id.slice(0, 12)} · ${run.turn.status} · ${run.agents.length} agent(s) · ${task}`,
      )
      if (run.agents.length > 0) {
        lines.push(
          `  Agents: ${run.agents
            .map((agent) => `${agent.nickname} (${agent.role}, ${agent.status})`)
            .join(', ')}`,
        )
      }
    }
    lines.push('', 'Open the Agent items in the workflow turn to review each child task.')
    return lines.join('\n')
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
    // MultiAgent V2 uses subAgentActivity for display/liveness and the
    // spawnAgent/wait tool calls for the structured timeline. A naturally
    // completed child is not closed again: wait/completed must remain the last
    // parent state so Codex App retains the terminal snapshot.
    const subagentContexts = new Map<string, SubagentContext>()
    const activeSubagents = new Set<string>()
    // A Workflow launch can be pending before it has produced a journal
    // agent (or after its last projected agent has completed). Keep the
    // watchdog armed for that whole async operation, not only while a child
    // tool_use is present.
    let workflowInFlight = false
    const workflowLaunchToolUseIds = new Set<string>()
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
    const permissionProfile = permissionProfilePolicy(permissionProfileIdFromParams(params))
    const approvalPolicy =
      permissionProfile?.approvalPolicy ??
      (typeof params.approvalPolicy === 'string'
        ? normalizeApprovalPolicy(params.approvalPolicy)
        : null) ??
      thread.approvalPolicy
    const sandboxMode =
      permissionProfile?.sandboxMode ?? sandboxFromTurnParams(params) ?? thread.sandboxMode
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
    // If this is a forked side-conversation (sidechat) that has different
    // developerInstructions from its parent, appending them to systemPromptAddendum
    // would mutate the system prompt prefix and invalidate the prefix KV cache
    // for all inherited history (80k+ tokens).
    // Instead, preserve the parent's system prompt addendum to guarantee 100% cache hits,
    // and prepend side-conversation instructions directly into the turn's user prompt.
    let systemPromptAddendum: string | null = null
    let effectivePrompt = prompt
    if (thread.forkedFromId != null && developerInstructions) {
      const parentThread = this.store.getThread(thread.forkedFromId)
      const parentDev = parentThread?.developerInstructions ?? null
      if (developerInstructions !== parentDev) {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions: parentThread?.baseInstructions ?? baseInstructions,
          developerInstructions: parentDev,
          personality: parentThread?.personality ?? personality,
        })
        effectivePrompt = `<side-conversation-instructions>\n${developerInstructions}\n</side-conversation-instructions>\n\n${prompt}`
      } else {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions,
          developerInstructions,
          personality,
        })
      }
    } else {
      systemPromptAddendum = buildSystemPromptAddendum({
        baseInstructions,
        developerInstructions,
        personality,
      })
    }
    const turnPurpose = params.outputSchema == null ? 'normal' : 'summary'

    const rawTurnModel = stringOr(params.model, thread.model)
    const isCodexThread = thread.runtimeBackend === 'codex' && process.env.CLAUDE_CODEX_MOCK !== '1'
    const resolvedModel = isCodexThread
      ? rawTurnModel
      : resolveClaudeModel(rawTurnModel, params.outputSchema == null ? 'normal' : 'summary')
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
    this.subagentStateByTurn.set(turn.id, {
      thread,
      turn,
      contexts: subagentContexts,
      active: activeSubagents,
    })
    let acceptRuntimeEvents = true
    let watchdogTimer: NodeJS.Timeout | null = null
    let resolveWatchdog: (() => void) | null = null
    const watchdogTimeoutMs = subagentWatchdogTimeoutMs()
    const watchdogPromise =
      watchdogTimeoutMs > 0
        ? new Promise<void>((resolve) => {
            resolveWatchdog = resolve
          })
        : null
    const disarmWatchdog = (): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    const armWatchdog = (): void => {
      if (
        !watchdogPromise ||
        watchdogTimer ||
        !acceptRuntimeEvents ||
        (activeSubagents.size === 0 && !workflowInFlight)
      )
        return
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        // Flip this before resolving the race so an already-buffered SDK event
        // cannot create a fresh child after the watchdog has decided to fail.
        acceptRuntimeEvents = false
        resolveWatchdog?.()
      }, watchdogTimeoutMs)
      watchdogTimer.unref()
    }
    const turnIsActive = (): boolean =>
      acceptRuntimeEvents &&
      this.store.getTurn(turn.id)?.status === 'inProgress' &&
      this.activeTurnByThread.get(thread.id) === turn.id
    const runtimeTurn = this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        purpose: turnPurpose,
        prompt: effectivePrompt,
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
          // Interrupts, watchdog expiry, and a peer reconnect can leave a few
          // SDK messages queued after the server has terminalized the turn.
          // They are stale and must never resurrect a child or an inProgress
          // item in the Codex App.
          if (!turnIsActive()) return
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
            // Spawn the ephemeral child, then mirror MultiAgent V2: a
            // subAgentActivity started item plus spawnAgent/wait tool state.
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
            const agentPath = `/root/${agentNickname}`
            const agentRole = subType ?? 'general-purpose'
            const childStartedAt = nowSeconds()
            const childThread: ThreadRecord = {
              id: childThreadId,
              sessionId: thread.sessionId,
              forkedFromId: thread.id,
              isPinned: false,
              sectionId: null,
              sectionEnteredAt: null,
              sectionPosition: null,
              preview: promptText.slice(0, 200),
              name: null,
              archived: false,
              cwd: thread.cwd,
              model: subagentModel,
              reasoningEffort: thread.reasoningEffort,
              modelProvider: thread.modelProvider,
              claudeSessionId: null,
              source: normalizeSessionSource(thread.source),
              createdAt: childStartedAt,
              updatedAt: childStartedAt,
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
            // Child notifications must follow the current parent peer. This
            // matters after unix-daemon reconnects, when the old peer is gone
            // before the child publishes its response.
            this.activePeerByThread.set(childThreadId, peer)
            const childTurn: TurnRecord = {
              id: newId(),
              threadId: childThreadId,
              status: 'inProgress',
              startedAt: childStartedAt,
              completedAt: null,
              durationMs: null,
              items: [
                {
                  type: 'userMessage',
                  id: newId(),
                  content: [{ type: 'text', text: promptText, text_elements: [] }],
                },
              ],
              diff: '',
              error: null,
            }
            this.store.upsertTurn(childTurn)
            this.notify(peer, {
              method: 'thread/started',
              params: { thread: this.toThread(childThread, []) },
            })
            this.notify(peer, {
              method: 'turn/started',
              params: {
                threadId: childThreadId,
                turn: this.toLifecycleTurn(childTurn),
              },
            })
            // The bundled Codex cc client creates a child conversation from
            // thread/started with an empty turn and treats the history as
            // loaded while the child is live. Replay the persisted prompt as
            // a normal item lifecycle so the child page has its Prompt even
            // when it is opened before the first response token arrives.
            const childPrompt = childTurn.items.find((item) => item.type === 'userMessage')
            if (childPrompt) this.emitItemLifecycle(peer, childThreadId, childTurn.id, childPrompt)
            recordRunEvent('subagent.spawned', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId,
              model: subagentModel,
              agentRole,
              agentNickname,
            })

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
            const waitId = newId()
            const subagentContext: SubagentContext = {
              childThreadId,
              childTurnId: childTurn.id,
              waitItemId: waitId,
              agentPath,
              prompt: promptText,
              subType,
            }
            this.emitSubagentActivity(peer, thread.id, turn.id, subagentContext, 'started')

            // Wait begins after the activity item; this is the long phase that
            // gives Codex App its "agent is working" indicator while the
            // subagent runs. It closes when the Task tool_result arrives.
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
            subagentContexts.set(event.toolUseId, subagentContext)
            activeSubagents.add(event.toolUseId)
            armWatchdog()
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
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

            const childTurn = this.completeSubagentChildTurn(
              peer,
              ctx,
              resultText,
              event.isError ? 'failed' : 'completed',
              event.isError ? { message: 'subagent failed' } : null,
              parsed.usage?.durationMs ?? null,
            )
            recordRunEvent('subagent.completed', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId: ctx.childThreadId,
              childTurnId: childTurn.id,
              status: childTurn.status,
              agentRole: ctx.subType ?? 'general-purpose',
            })
            const childThread = this.store.getThread(ctx.childThreadId)
            if (childThread) {
              childThread.updatedAt = nowSeconds()
              // Replace our synthetic `agent-{hex}` nickname with the SDK-
              // assigned id so SendMessage / SubAgent navigation in the App
              // uses the same handle the SDK reports.
              if (parsed.agentId) childThread.agentNickname = parsed.agentId
              this.store.upsertThread(childThread)
            }

            // The child completion activity arrives before wait/completed in
            // native V2. The installed Codex cc schema predates the
            // `completed` activity kind, so only send it when the client
            // explicitly advertises support; the wait terminal snapshot is
            // sufficient for legacy reducers.
            if (event.isError || this.supportsCompletedSubagentActivity(peer)) {
              this.emitSubagentActivity(
                peer,
                thread.id,
                turn.id,
                ctx,
                event.isError ? 'interrupted' : 'completed',
              )
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
            this.store.updateItemAndMoveToEnd(turn.id, ctx.waitItemId, () => waitEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitEnd,
                completedAtMs: nowMillis(),
              },
            })

            // Codex cc 26.x does not advertise the terminal
            // subAgentActivity kind. For a successful child, wait/completed
            // is already the terminal display state; appending closeAgent
            // makes the bundled client hide the finished child. Keep the
            // legacy closeAgent cleanup only for failed results.
            if (!this.supportsCompletedSubagentActivity(peer) && event.isError) {
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
                ...closeBegin,
                status: collabStatus,
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
            }
            // Keep the context discoverable until the child turn and wait
            // item have both been persisted. If one of those operations throws,
            // the outer settlement path can still finalize the child as failed.
            activeSubagents.delete(event.toolUseId)
            subagentContexts.delete(event.toolUseId)
            if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
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
            if (isWorkflowToolName(event.toolName)) {
              workflowLaunchToolUseIds.add(event.toolUseId)
              workflowInFlight = true
              armWatchdog()
            }
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
            if (workflowLaunchToolUseIds.delete(event.toolUseId)) {
              workflowInFlight = workflowLaunchToolUseIds.size > 0
              if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
            }
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
            if (this.store.getTurn(turn.id)?.status !== 'inProgress') return
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
          if (!turnIsActive()) return { decision: 'cancel' }
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
          if (!turnIsActive()) return { decision: 'cancel' }
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
          if (!turnIsActive()) return { answers: {} }
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
          if (!turnIsActive()) return { answers: {} }
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
    const runtimeOutcome = runtimeTurn.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    )
    const outcome = watchdogPromise
      ? await Promise.race([
          runtimeOutcome,
          watchdogPromise.then(() => ({ kind: 'timeout' as const })),
        ])
      : await runtimeOutcome
    disarmWatchdog()
    acceptRuntimeEvents = false
    if (outcome.kind === 'timeout') {
      const timeoutSeconds = Math.ceil(watchdogTimeoutMs / 1000)
      const timeoutUnit = timeoutSeconds === 1 ? 'second' : 'seconds'
      const message = `Subagent did not publish a terminal result within ${timeoutSeconds} ${timeoutUnit}.`
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        this.finalizeOrphanedSubagents(
          peer,
          thread,
          turn,
          subagentContexts,
          activeSubagents,
          message,
        )
        this.subagentStateByTurn.delete(turn.id)
        // Do not await the SDK interrupt here: some SDK versions wait for the
        // same result that has just timed out. The server catch path will
        // terminalize the parent turn immediately and late events are guarded.
        void this.runtime.interrupt(thread.id).catch(() => {})
      }
      throw new Error(message)
    }
    if (outcome.kind === 'rejected') {
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
      }
      this.subagentStateByTurn.delete(turn.id)
      throw outcome.error
    }
    if (this.store.getTurn(turn.id)?.status === 'inProgress') {
      this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
    }
    this.subagentStateByTurn.delete(turn.id)
    const currentTurn = this.store.getTurn(turn.id)
    if (currentTurn && currentTurn.status !== 'inProgress') return

    const finalDiff = await gitDiff(thread.cwd)
    if (this.store.getTurn(turn.id)?.status !== 'inProgress') return
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
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      apiDurationMs: collectedMetrics.apiDurationMs,
      numTurns: collectedMetrics.numTurns,
      costUsd: collectedMetrics.costUsd,
    })
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

  private completeSubagentChildTurn(
    peer: RpcPeer,
    context: SubagentContext,
    resultText: string,
    status: 'completed' | 'failed',
    error: unknown | null,
    durationMs: number | null = null,
  ): TurnRecord {
    let childTurn = this.store.getTurn(context.childTurnId)
    if (!childTurn) {
      childTurn = {
        id: context.childTurnId,
        threadId: context.childThreadId,
        status: 'inProgress',
        startedAt: nowSeconds(),
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: 'userMessage',
            id: newId(),
            content: [{ type: 'text', text: context.prompt, text_elements: [] }],
          },
        ],
        diff: '',
        error: null,
      }
      this.store.upsertTurn(childTurn)
    }

    const agentItemId = newId()
    const startedItem: ThreadItem = {
      type: 'agentMessage',
      id: agentItemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.store.appendItem(childTurn.id, startedItem)
    this.notify(peer, {
      method: 'item/started',
      params: {
        threadId: context.childThreadId,
        turnId: childTurn.id,
        item: startedItem,
        startedAtMs: nowMillis(),
      },
    })

    const completedItem: ThreadItem = { ...startedItem, text: resultText }
    this.store.updateItem(childTurn.id, agentItemId, () => completedItem)
    if (resultText) {
      this.notify(peer, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: context.childThreadId,
          turnId: childTurn.id,
          itemId: agentItemId,
          delta: resultText,
        },
      })
    }
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId: context.childThreadId,
        turnId: childTurn.id,
        item: completedItem,
        completedAtMs: nowMillis(),
      },
    })

    const completed = this.store.completeTurn(childTurn.id, status, error) ?? childTurn
    if (durationMs != null) {
      completed.durationMs = durationMs
      this.store.upsertTurn(completed)
    }
    this.setThreadStatus(peer, context.childThreadId, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: {
        threadId: context.childThreadId,
        turn: this.toCompletedTurn(completed),
      },
    })
    return completed
  }

  private emitSubagentActivity(
    peer: RpcPeer,
    parentThreadId: string,
    parentTurnId: string,
    context: SubagentContext,
    kind: 'started' | 'interacted' | 'interrupted' | 'completed',
  ): void {
    // Codex cc 26.x treats a persisted started activity marker as liveness,
    // but does not advertise a compatible terminal activity kind. The
    // canonical spawnAgent/wait lifecycle remains available for discovery and
    // review, so omit this optional marker for legacy peers.
    if (!this.supportsCompletedSubagentActivity(peer) && kind !== 'interrupted') return
    const item: ThreadItem = {
      type: 'subAgentActivity',
      id: newId(),
      kind,
      agentThreadId: context.childThreadId,
      agentPath: context.agentPath,
    }
    // Keep the persisted history capability-neutral. The durable wait and
    // child-turn state covers live and completed runs; persisting either
    // started or completed activity would make a mixed-version reconnect
    // decode a kind the peer may not support. Interrupted remains the one
    // legacy-safe terminal marker for abandoned children.
    if (kind === 'interrupted') this.store.appendItem(parentTurnId, item)
    this.emitItemLifecycle(peer, parentThreadId, parentTurnId, item)
  }

  private emitItemLifecycle(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    item: ThreadItem,
  ): void {
    const startedAtMs = nowMillis()
    this.notify(peer, {
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item,
        startedAtMs,
      },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item,
        completedAtMs: nowMillis(),
      },
    })
  }

  private supportsCompletedSubagentActivity(peer: RpcPeer): boolean {
    if (process.env.CLAUDE_CODEX_SUBAGENT_COMPLETED === '1') return true
    if (process.env.CLAUDE_CODEX_SUBAGENT_COMPLETED === '0') return false
    return this.peerFeatures.get(peer)?.supportsCompletedSubagentActivity === true
  }

  private finalizeOrphanedSubagents(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    contexts: Map<string, SubagentContext>,
    active: Set<string>,
    failureMessage = 'Subagent ended without a terminal task result.',
  ): void {
    for (const toolUseId of Array.from(active)) {
      const context = contexts.get(toolUseId)
      active.delete(toolUseId)
      contexts.delete(toolUseId)
      if (!context) continue

      const message = failureMessage
      const childTurn = this.completeSubagentChildTurn(peer, context, message, 'failed', {
        message,
      })
      recordRunEvent('subagent.completed', {
        parentThreadId: thread.id,
        parentTurnId: turn.id,
        childThreadId: context.childThreadId,
        childTurnId: childTurn.id,
        status: 'failed',
        agentRole: context.subType ?? 'general-purpose',
      })

      this.emitSubagentActivity(peer, thread.id, turn.id, context, 'interrupted')

      const waitEnd: ThreadItem = {
        type: 'collabAgentToolCall',
        id: context.waitItemId,
        tool: 'wait',
        status: 'failed',
        senderThreadId: thread.id,
        receiverThreadIds: [context.childThreadId],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { [context.childThreadId]: { status: 'errored', message } },
      }
      this.store.updateItemAndMoveToEnd(turn.id, context.waitItemId, () => waitEnd)
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: waitEnd,
          completedAtMs: nowMillis(),
        },
      })
      if (!this.supportsCompletedSubagentActivity(peer)) {
        const closeId = newId()
        const closeBegin: ThreadItem = {
          type: 'collabAgentToolCall',
          id: closeId,
          tool: 'closeAgent',
          status: 'inProgress',
          senderThreadId: thread.id,
          receiverThreadIds: [context.childThreadId],
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
          ...closeBegin,
          status: 'failed',
          agentsStates: { [context.childThreadId]: { status: 'errored', message } },
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
      }
    }
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
    this.activePeerByThread.set(threadId, peer)
    const activeTurnId = this.activeTurnByThread.get(threadId)
    const turnId = activeTurnId || requestedTurnId
    if (turnId) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        const subagents = this.subagentStateByTurn.get(turnId)
        if (subagents) {
          this.finalizeOrphanedSubagents(
            peer,
            subagents.thread,
            subagents.turn,
            subagents.contexts,
            subagents.active,
          )
          this.subagentStateByTurn.delete(turnId)
        }
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
    // Persist the terminal state before asking the SDK to abort. A few SDK
    // versions deliver one or two buffered tool events during interrupt; the
    // runRuntimeTurn guard now rejects them because the turn is no longer
    // active, so they cannot create an orphan child after this point.
    const interrupting = this.runtime.interrupt(threadId)
    await interrupting
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
        ...this.publicConfigOverrides(),
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
        provider_loop_config: projectProviderLoopConfig(
          undefined,
          this.providerLoopSelectionInput(),
        ),
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

  private providerLoopSelectionInput(): ProviderLoopSelectionInput {
    const legacyRuntimeType = normalizeRuntimeType(
      process.env.CLAUDE_CODEX_RUNTIME_TYPE ??
        process.env.CLAUDE_CODEX_RUNTIME ??
        process.env.CLAUDE_CODEX_BACKEND,
    )
    const envInput = providerLoopSelectionInputFromEnv(process.env, legacyRuntimeType)
    if (hasProviderLoopSelectionInput(envInput)) return envInput
    return providerLoopSelectionInputFromConfig(
      this.configOverrides,
      legacyRuntimeType,
      process.env.CLAUDE_CODEX_MOCK === '1',
    )
  }

  private publicConfigOverrides(): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(this.configOverrides).filter(
        ([key]) => !isProviderLoopSelectionConfigKey(key),
      ),
    )
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
    const isTty = params.tty === true
    const streamOutput = params.streamStdoutStderr === true || isTty
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
      tty: isTty,
    })

    // For interactive TTY sessions (e.g. Codex App built-in terminal), spawn via pty-bridge.py
    // to allocate a real pseudo-terminal (PTY) master/slave pair with ANSI echo & ZLE line editor.
    let child: ChildProcess
    const file = fileURLToPath(import.meta.url)
    const candidates = [
      join(file, '../../../scripts/pty-bridge.py'),
      join(file, '../../scripts/pty-bridge.py'),
      join(homedir(), '.local/share/claude-codex/scripts/pty-bridge.py'),
    ]
    const ptyBridge = candidates.find((c) => c && existsSync(c))
    if (isTty && ptyBridge && existsSync(ptyBridge)) {
      child = spawn('python3', [ptyBridge, ...command], {
        cwd,
        env: { ...commandEnv(params.env), TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      ;(child as any).__isPtyBridge = true
    } else {
      child = spawn(command[0] as string, command.slice(1), {
        cwd,
        env: commandEnv(params.env),
        stdio: 'pipe',
      })
    }
    this.processHandles.set(processHandle, child)

    const capture = (target: Buffer[], chunk: Buffer, currentBytes: number): [number, boolean] => {
      if (currentBytes >= cap) return [currentBytes, true]
      const allowed = Math.min(chunk.byteLength, cap - currentBytes)
      if (allowed > 0) target.push(chunk.subarray(0, allowed))
      return [currentBytes + allowed, allowed < chunk.byteLength]
    }

    if ((child as any).__isPtyBridge) {
      let bufferStr = ''
      child.stdout?.on('data', (chunk: Buffer | string) => {
        bufferStr += chunk.toString('utf8')
        const lines = bufferStr.split(/\r?\n/)
        bufferStr = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.stream === 'stdout') {
              this.notify(peer, {
                method: 'process/outputDelta',
                params: {
                  processHandle,
                  stream: 'stdout',
                  deltaBase64: msg.delta,
                  capReached: false,
                },
              })
            }
          } catch {}
        }
      })
    } else {
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
    }

    // Do not impose a default timeout on interactive/streaming terminal sessions (tty or streamStdin)
    const isInteractive = isTty || params.streamStdin === true
    const defaultTimeout = isInteractive ? 0 : 60_000
    const timeoutMs =
      params.timeoutMs == null ? defaultTimeout : numberOr(params.timeoutMs, defaultTimeout)
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
    if (typeof params.deltaBase64 === 'string' && params.deltaBase64.length > 0) {
      if ((child as any).__isPtyBridge) {
        child.stdin?.write(JSON.stringify({ action: 'input', data: params.deltaBase64 }) + '\n')
      } else {
        child.stdin?.write(Buffer.from(params.deltaBase64, 'base64'))
      }
    }
    if (params.closeStdin === true) child.stdin?.end()
    return {}
  }

  private processResizePty(params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    const child = this.processHandles.get(processHandle)
    if (child && (child as any).__isPtyBridge) {
      const size = (params.size as Record<string, unknown>) || {}
      const cols = numberOr(size.cols, 80)
      const rows = numberOr(size.rows, 24)
      child.stdin?.write(JSON.stringify({ action: 'resize', cols, rows }) + '\n')
    }
    return {}
  }

  private processKill(params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    const child = this.processHandles.get(processHandle)
    if (!child) throw new Error(`unknown process handle: ${processHandle}`)
    if ((child as any).__isPtyBridge) {
      child.stdin?.write(JSON.stringify({ action: 'kill' }) + '\n')
    }
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
    if (session && this.fuzzySessions.get(sessionId) === session) {
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
    let displayTool = event.toolName
    if (event.toolName === 'Read') {
      const raw = String(event.input.file_path || event.input.path || '')
      if (raw) {
        let displayPath = raw
        try {
          if (cwd && raw.startsWith(cwd)) {
            displayPath = raw.slice(cwd.length).replace(/^\/+/, '')
          } else {
            const parts = raw.split(/\//).filter(Boolean)
            displayPath = parts.length > 2 ? parts.slice(-2).join('/') : raw
          }
        } catch {}
        displayTool = `Read ${displayPath || raw}`
      }
    } else if (event.toolName === 'Grep') {
      const pat = String(event.input.pattern ?? '')
      const rawPath = event.input.path ? String(event.input.path) : ''
      let pathStr = ''
      if (rawPath) {
        const parts = rawPath.split(/\//).filter(Boolean)
        pathStr = ` (${parts.length > 2 ? parts.slice(-2).join('/') : rawPath})`
      }
      if (pat) displayTool = `Grep ${pat}${pathStr}`
    } else if (event.toolName === 'Glob') {
      const pat = String(event.input.pattern ?? '')
      if (pat) displayTool = `Glob ${pat}`
    }

    return {
      type: 'mcpToolCall',
      id,
      server: 'claude-code',
      tool: displayTool,
      status: 'inProgress',
      arguments: event.input,
      result: null,
      error: null,
      durationMs: null,
    }
  }

  private threadEnvelope(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    const activePermissionProfileId = threadPermissionProfileId(
      thread.permissionProfileId,
      thread.approvalPolicy,
      thread.sandboxMode,
    )
    return {
      thread: this.toThread(thread, turns),
      model: thread.model,
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: [thread.cwd],
      instructionSources: [],
      approvalPolicy: thread.approvalPolicy ?? 'never',
      approvalsReviewer: 'user',
      sandbox: sandboxEnvelope(thread.sandboxMode, thread.cwd),
      permissionProfile: null,
      activePermissionProfile: activePermissionProfileId
        ? { id: activePermissionProfileId, extends: null }
        : null,
      // Some newer clients read the compact id while older clients use the
      // structured activePermissionProfile field. Return both; unknown extra
      // fields are ignored by the legacy app-server schema.
      permissions: activePermissionProfileId,
      reasoningEffort: thread.reasoningEffort,
      multiAgentMode: 'explicitRequestOnly',
    }
  }

  private toThread(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    const agentNickname = nullIfEmpty(thread.agentNickname)
    const agentRole = nullIfEmpty(thread.agentRole)
    const parentThreadId = thread.threadSource === 'subagent' ? thread.forkedFromId : null
    const source = parentThreadId
      ? {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: this.subagentDepth(thread),
              agent_path: null,
              agent_nickname: agentNickname,
              agent_role: agentRole,
            },
          },
        }
      : normalizeSessionSource(thread.source)
    const profileId =
      thread.sandboxMode === 'danger-full-access'
        ? ':danger-full-access'
        : thread.sandboxMode === 'read-only'
          ? ':read-only'
          : ':workspace'
    const section = thread.sectionId == null ? null : this.store.getSection(thread.sectionId)
    const isPinned = thread.sectionId === PINNED_SECTION_ID || thread.isPinned === true

    return {
      id: thread.id,
      isPinned,
      section,
      sectionEnteredAt: thread.sectionEnteredAt ?? null,
      sessionId: thread.sessionId,
      forkedFromId: thread.forkedFromId,
      parentThreadId,
      preview: thread.preview,
      ephemeral: thread.ephemeral,
      modelProvider: thread.modelProvider,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.updatedAt,
      status: thread.status,
      path: null,
      cwd: thread.cwd,
      cliVersion: codexCliVersion(),
      canAcceptDirectInput: true,
      activePermissionProfile: profileId,
      // Defense-in-depth: even if older rows hold an invalid `source` or
      // `threadSource` (legacy `app_server`, empty string from a buggy write
      // path), coerce on the way out so the App's strict deserializer never
      // sees a value outside the wire enum.
      source,
      threadSource: normalizeThreadSource(thread.threadSource),
      agentNickname,
      agentRole,
      gitInfo: null,
      name: thread.name,
      turns: turns.map((turn) => this.toTurn(turn)),
    }
  }

  private subagentDepth(thread: ThreadRecord): number {
    let depth = thread.threadSource === 'subagent' ? 1 : 0
    let ancestorId = thread.forkedFromId
    const seen = new Set([thread.id])
    while (ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId)
      const ancestor = this.store.getThread(ancestorId)
      if (!ancestor || ancestor.threadSource !== 'subagent') break
      depth += 1
      ancestorId = ancestor.forkedFromId
    }
    return depth
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

  private toTurnView(turn: TurnRecord, itemsView: TurnItemsView): unknown {
    if (itemsView === 'full') return this.toTurn(turn)
    if (itemsView === 'notLoaded') return this.toLifecycleTurn(turn)
    const firstUser = turn.items.find((item) => item.type === 'userMessage')
    const lastAgent = turn.items.findLast((item) => item.type === 'agentMessage')
    const items: ThreadItem[] = []
    if (firstUser) items.push(firstUser)
    if (lastAgent && lastAgent.id !== firstUser?.id) items.push(lastAgent)
    return {
      id: turn.id,
      items,
      itemsView: 'summary',
      status: turn.status,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    }
  }

  // Lightweight payload for turn/start, turn/started, and terminal paths that
  // intentionally do not carry an assistant summary. The item stream drives
  // the timeline; completed subagent turns use toCompletedTurn below.
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

  // Codex includes the final assistant message in successful turn/completed
  // notifications. Subagent pages depend on that summary because they can be
  // opened with a metadata-only thread/read and may not replay prior deltas.
  private toCompletedTurn(turn: TurnRecord): unknown {
    const lastAgent =
      turn.status === 'completed' && turn.error == null
        ? turn.items.findLast((item) => item.type === 'agentMessage' && item.text.trim().length > 0)
        : undefined
    return {
      id: turn.id,
      items: lastAgent ? [lastAgent] : [],
      itemsView: lastAgent ? 'summary' : 'notLoaded',
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
    // Shutdown intentionally suppresses wire notifications: the peer may
    // already have closed, while persistence still needs to settle child and
    // parent state without throwing on a broken pipe.
    if (this.stopped) return
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

  private finalizeActiveSubagentsForShutdown(message: string): void {
    for (const [turnId, state] of this.subagentStateByTurn.entries()) {
      const turn = this.store.getTurn(turnId)
      if (!turn || turn.status !== 'inProgress') {
        this.subagentStateByTurn.delete(turnId)
        continue
      }
      const peer = this.activePeerByThread.get(state.thread.id) ?? {
        id: 'shutdown',
        send: () => {},
        close: () => {},
      }
      this.finalizeOrphanedSubagents(
        peer,
        state.thread,
        turn,
        state.contexts,
        state.active,
        message,
      )
      this.subagentStateByTurn.delete(turnId)
    }
  }

  private clearActiveTurn(threadId: string): void {
    const existed = this.activeTurnByThread.delete(threadId)
    if (existed && this.activeTurnByThread.size === 0) this.idleCheckHandler?.()
  }

  private peerForParams(peer: RpcPeer, params: unknown): RpcPeer {
    const threadId = stringOr(asRecord(params).threadId, '')
    if (!threadId) return peer
    const direct = this.activePeerByThread.get(threadId)
    if (direct) return direct
    const seen = new Set<string>()
    let current = this.store.getThread(threadId)
    while (current?.forkedFromId && !seen.has(current.forkedFromId)) {
      seen.add(current.forkedFromId)
      const ancestorPeer = this.activePeerByThread.get(current.forkedFromId)
      if (ancestorPeer) {
        this.activePeerByThread.set(threadId, ancestorPeer)
        return ancestorPeer
      }
      current = this.store.getThread(current.forkedFromId)
    }
    return peer
  }

  private bindPeerToDescendants(peer: RpcPeer, rootThreadId: string): void {
    const queue = [rootThreadId]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const parentId = queue.shift()
      if (!parentId || seen.has(parentId)) continue
      seen.add(parentId)
      for (const child of this.store.listThreads({
        includeEphemeral: true,
        parentThreadId: parentId,
        sortKey: 'created_at',
        sortDirection: 'asc',
      })) {
        this.activePeerByThread.set(child.id, peer)
        queue.push(child.id)
      }
    }
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
