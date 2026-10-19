import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, type FSWatcher, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { rendersCompletedSubagentActivity, unverifiedAppWarning } from './app-compat.mjs'
import {
  type AppPlugin,
  type AppSkill,
  appPluginSkills,
  claudeHookSource,
  claudeRunnableAppPlugin,
  codexHookEventName,
  listClaudeHooks,
  listClaudeSkills,
} from './claude-capabilities.mjs'
import { onClaudeCommandsChanged, skillLinksToCommand } from './claude-commands.mjs'
import { runCodexNotify } from './codex-notify.mjs'
import {
  continuePrompt,
  goalBudgetExhausted,
  goalBudgetLimitPrompt,
  goalContinuationPrompt,
  goalObjectiveUpdatedPrompt,
  goalToolResult,
  isGoalStatus,
  MODEL_GOAL_STATUSES,
} from './goal-prompts.mjs'
import { accountUsage, hostMethod, RpcError } from './host-methods.mjs'
import { inheritedAgents, inheritedHooks, inheritedPermissionRules } from './inherited-config.mjs'
import {
  callMcpTool,
  listMcpServerStatuses,
  type McpConfigScope,
  readMcpConfig,
  readMcpResource,
} from './mcp.mjs'
import { projectInstructions } from './project-instructions.mjs'
import { projectProviderLoopConfig } from './provider-loop-config.mjs'
import {
  hasProviderLoopSelectionInput,
  isProviderLoopSelectionConfigKey,
  type ProviderLoopSelectionInput,
  providerLoopSelectionInputFromConfig,
  providerLoopSelectionInputFromEnv,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'
import {
  quietBackgroundTurnsEnabled,
  quietTurnReasons,
  stripQuietTurnHeartbeat,
  withQuietTurnHeartbeat,
} from './quiet-turns.mjs'
import { recordRunEvent } from './run-registry.mjs'
import { normalizeRuntimeType } from './runtime-config.mjs'
import {
  addedFileDiff,
  allSelectableModelOptions,
  asRecord,
  buildSystemPromptAddendum,
  coerceStructuredValue,
  collaborationModeEnvelope,
  collaborationModeFromParams,
  collaborationModeSettings,
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
  projectMetadata,
  projectName,
  projectRoots,
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
  visualizationDirNote,
  wrapMcpToolError,
  wrapMcpToolResult,
} from './server-helpers.mjs'
import { PINNED_SECTION_ID, type SessionStore, settledTurn } from './store.mjs'
import {
  findOccurrences,
  offsetCursor,
  pageItems,
  pageLimit,
  pageTimeline,
  pageTurns,
  sortDirectionOr,
  threadSnippet,
} from './thread-history.mjs'
import type {
  ClaudeCheckpoint,
  ClaudeRuntime,
  ElicitationRequest,
  ElicitationResponse,
  FileUpdateChange,
  GoalToolHandlers,
  ImageInput,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionDecision,
  ProjectRecord,
  QueuedSubmission,
  RpcPeer,
  RuntimeEvent,
  RuntimeLiveTask,
  RuntimeSteerOptions,
  RuntimeTaskEvent,
  RuntimeTaskUsage,
  RuntimeTurnSettings,
  ThreadAttachmentRecord,
  ThreadGoal,
  ThreadItem,
  ThreadRecord,
  ThreadSectionAppearance,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnRecord,
  TurnStatus,
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
  newThreadId,
  normalizeCodexReasoningEffort,
  nowMillis,
  nowSeconds,
  platformFamily,
  platformOs,
  resolveClaudeEffort,
  resolveClaudeModel,
  sleep,
  textFromInput,
  threadVisualizationDir,
  toolOutputInput,
  turnToolOutputFromParams,
} from './util.mjs'
import { markVisualizeLines } from './visualize-lines.mjs'
import { parseWorkflowCommand } from './workflow-command.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'

const execFileAsync = promisify(execFile)

// A missing Claude Task result must not keep the Codex App in its working state
// forever. This is deliberately a long, configurable watchdog for the whole
// subagent phase; it is not the short journal-drain grace period used when a
// terminal notification has already arrived.
const DEFAULT_SUBAGENT_WATCHDOG_MS = 30 * 60 * 1000
const MIN_SUBAGENT_WATCHDOG_MS = 100

// A turn end the state database refused is written again on this schedule
// (2s, 4s, ... apart), so thread/read stops showing the turn as running once
// the lock holder lets go.
const TURN_END_RETRY_DELAY_MS = 2_000
const TURN_END_RETRY_ATTEMPTS = 5

// Input for a running turn the runtime has not taken up yet (its session is
// still coming up, or the last turn's interrupt is still draining) waits this
// long for it, checking this often.
const STEER_WAIT_MS = 10_000
const STEER_RETRY_MS = 100

function isWorkflowToolName(value: string): boolean {
  const name = value.trim().toLowerCase()
  return name === 'workflow' || name === 'workflows'
}

// The Agent tool returns `{status: 'async_launched', agentId, ...}` when the
// child runs in the background; older CLIs only leave the text marker.
function isAsyncAgentLaunch(
  structured: Record<string, unknown> | null | undefined,
  content: unknown,
): boolean {
  if (structured) return structured.status === 'async_launched' || structured.isAsync === true
  return /^\s*Async agent launched/i.test(toolResultText(content))
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
  // The user stopped this child from its own thread; its Agent call then
  // returns early and the child counts as interrupted, not failed.
  stoppedByUser?: boolean
}

interface ActiveSubagentState {
  thread: ThreadRecord
  turn: TurnRecord
  contexts: Map<string, SubagentContext>
  active: Set<string>
}

// An Agent call Claude ran in the background. Its tool call returns at once
// (`async_launched`), but the child keeps working past the parent turn and
// reports back through a task notification, which also wakes Claude up.
interface BackgroundSubagent {
  parentThreadId: string
  parentTurnId: string
  toolUseId: string
  taskId: string | null
  agentId: string | null
  context: SubagentContext
  running: boolean
}

type SubagentActivityKind = 'started' | 'interacted' | 'interrupted' | 'completed'

// Notifications are routed by thread id (see peerForParams), so work that
// outlives its request can publish through this stub and still reach
// whichever peer currently follows the thread.
const DETACHED_PEER: RpcPeer = { id: 'detached', send: () => {}, close: () => {} }

const MAX_TRACKED_TASK_IDS = 512
const MAX_QUEUED_ACTIVITY = 64

// A hidden goal continuation that does no tool work ends the run of
// continuations until the user or the goal changes something.
const GOAL_IDLE_TURN_LIMIT = 1
const NO_PROGRESS_ITEM_TYPES = new Set([
  'userMessage',
  'functionCallOutput',
  'agentMessage',
  'reasoning',
  'plan',
])

// Only real work counts as goal progress; reading the goal back does not.
function goalTurnMadeProgress(turn: TurnRecord): boolean {
  return turn.items.some((item) => {
    if (NO_PROGRESS_ITEM_TYPES.has(item.type)) return false
    return !(item.type === 'mcpToolCall' && item.tool.startsWith('mcp__codex_goal__'))
  })
}

function goalBudget(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw new Error('goal budgets must be positive integers when provided')
  return value
}

function isUsageLimitError(error: unknown): boolean {
  const message = typeof asRecord(error).message === 'string' ? String(asRecord(error).message) : ''
  return /usage limit|rate limit|quota|\b429\b/i.test(message)
}

function queuedInput(value: unknown): UserInput[] {
  const input = Array.isArray(value) ? (value as UserInput[]) : []
  if (isEmptyInput(input)) throw new Error('queued message input must not be empty')
  return input
}

function isEmptyInput(input: UserInput[]): boolean {
  const { textPrompt, images } = extractImageInputs(input)
  return !textPrompt.trim() && images.length === 0 && !textFromInput(input).trim()
}

// What the user sent in a turn that did not finish.
function interruptedUserText(turn: TurnRecord | null): string | null {
  if (turn?.status !== 'interrupted' && turn?.status !== 'failed') return null
  const text = turn.items
    .flatMap((item) => (item.type === 'userMessage' ? [textFromInput(item.content).trim()] : []))
    .filter(Boolean)
    .join('\n\n')
  return text || null
}

// With the turnToolOutput gate on, a thread handoff or a message another
// thread sends arrives as turn/start `toolOutput` with empty `input`. Claude
// reads the tool result as the prompt.
// App rule: tool-output-turns
function turnInput(params: Record<string, unknown>): UserInput[] {
  const toolOutput = turnToolOutputFromParams(params.toolOutput)
  if (toolOutput) return toolOutputInput(toolOutput.output)
  return Array.isArray(params.input) ? (params.input as UserInput[]) : []
}

// The item that carries a turn's input: the user's message, or the tool
// result the App shows in its place.
function turnInputItem(params: Record<string, unknown>, input: UserInput[]): ThreadItem {
  const toolOutput = turnToolOutputFromParams(params.toolOutput)
  if (toolOutput) return { type: 'functionCallOutput', id: newId(), ...toolOutput }
  const clientId = nullIfEmpty(stringOr(params.clientUserMessageId, ''))
  return { type: 'userMessage', id: newId(), content: input, ...(clientId ? { clientId } : {}) }
}

interface PeerFeatures {
  // Codex App 26.818.61809 only accepts started/interacted/interrupted in the
  // subAgentActivity schema. Newer clients may opt into the completed kind
  // explicitly during initialize; keep the legacy wire shape otherwise.
  // App rule: subagent-completed-kind
  supportsCompletedSubagentActivity: boolean
  // clientInfo.name from initialize, which Codex's notify event reports.
  clientName: string | null
}

function turnItemsView(value: unknown): TurnItemsView {
  if (value === 'full' || value === 'summary' || value === 'notLoaded') return value
  return 'summary'
}

// The Claude model a helper thread runs on in place of a Codex model: the
// summary model.
// App rule: helper-thread-model
function claudeHelperModel(model: string): string {
  return resolveClaudeModel(model, 'summary') ?? model
}

export class CodexClaudeAppServer {
  private pendingServerRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private activePeerByThread = new Map<string, RpcPeer>()
  private peerFeatures = new WeakMap<RpcPeer, PeerFeatures>()
  private activeTurnByThread = new Map<string, string>()
  // Turns whose runtime run has not returned yet. A running turn outside this
  // set has nothing left that would ever end it.
  private runtimeRuns = new Set<string>()
  private subagentStateByTurn = new Map<string, ActiveSubagentState>()
  // Closes the message, reasoning and plan items a turn is still streaming,
  // so an interrupt that ends the turn from outside leaves none open.
  private closeStreamingItemsByTurn = new Map<string, () => void>()
  // Keyed by child thread id. Entries outlive the run so SendMessage can
  // still find (and resume) an agent that already reported back.
  private backgroundSubagents = new Map<string, BackgroundSubagent>()
  // task_started precedes the Agent tool result that backgrounds the task.
  private taskIdByToolUse = new Map<string, string>()
  // SendMessage and TaskStop calls addressed to a known agent, by tool use id.
  private pendingAgentCalls = new Map<
    string,
    { tool: 'sendInput' | 'closeAgent'; itemId: string; childThreadId: string; message: string }
  >()
  // Subagent activity that arrived while the parent had no turn to carry it.
  private queuedSubagentActivity = new Map<
    string,
    Array<{ context: SubagentContext; kind: SubagentActivityKind }>
  >()
  // Claude started a turn of its own while the thread's turn was settling.
  private pendingAutonomousTurns = new Set<string>()
  private lastTurnParamsByThread = new Map<string, Record<string, unknown>>()
  private fuzzySessions = new Map<string, { roots: string[] }>()
  private commandSessionAllow = new Map<string, Set<string>>()
  private commandProcesses = new Map<string, ChildProcess>()
  private processHandles = new Map<string, ChildProcess>()
  private fsWatchers = new Map<string, FSWatcher>()
  // Goal state lives in the store. These track the hidden continuation turns
  // the adapter starts, how many of them in a row made no progress, and when
  // goal time was last accrued for a thread's running turn.
  private goalTurns = new Set<string>()
  private goalIdleStreaks = new Map<string, number>()
  private goalClockByThread = new Map<string, number>()
  // The turn each goal's tokens accrue to: one that ran while the goal was
  // active, even if the goal settles before the turn's usage arrives.
  private goalTurnByThread = new Map<string, string>()
  // Tokens already charged to the goal for each main-loop API call of the
  // running turn, before its result settles the turn's usage.
  private goalProgressByThread = new Map<string, Map<string, number>>()
  private goalToolHandlers = new Map<string, GoalToolHandlers>()
  private elicitationCounts = new Map<string, number>()
  private tokenUsageByThread = new Map<string, TokenUsageBreakdown>()
  // Like Codex's last_token_usage, `last` is one API call: the main loop's
  // latest, which is what fills the context window. The first map follows
  // the running turn; the second keeps the call last reported.
  private lastCallUsageByThread = new Map<string, TokenUsageBreakdown>()
  private lastUsageByThread = new Map<string, TokenUsageBreakdown>()
  private contextWindowByThread = new Map<string, number>()
  private configModel = defaultSelectableModelId()
  private configReasoningEffort =
    normalizeCodexReasoningEffort(process.env.CLAUDE_CODEX_DEFAULT_EFFORT) ?? 'medium'
  // Catch-all for arbitrary keys the App's settings sheet writes (approval
  // policy, sandbox preference, instructions toggles, etc.). We don't apply
  // them to typed runtime state, but we round-trip them through config/read
  // so the user's settings survive a daemon restart instead of resetting on
  // every reconnect.
  private configOverrides: Record<string, unknown> = {}
  // Codex App plugins whose skills Claude can run, as the App installed them.
  private appPlugins: AppPlugin[] = []
  private readonly configPath = join(adapterHome(), 'config.json')
  private idleCheckHandler: (() => void) | null = null
  private stopped = false
  // Every connected peer, for notifications that belong to no thread.
  private peers = new Map<string, RpcPeer>()
  private readonly stopCommandsListener: () => void
  private readonly store: SessionStore
  private readonly runtime: ClaudeRuntime

  constructor(store: SessionStore, runtime: ClaudeRuntime) {
    this.store = store
    this.runtime = runtime
    this.loadPersistedConfig()
    // A CLI reported a different set of built-in commands: the App refetches
    // skills/list, which serves them as skills.
    // App rule: skills-popup
    this.stopCommandsListener = onClaudeCommandsChanged(() => {
      this.notifyAll({ method: 'skills/changed', params: {} })
    })
    this.runtime.setBackgroundListener?.({
      onTaskEvent: (threadId, event) => this.handleTaskEvent(threadId, event),
      onAutonomousTurn: (threadId) => this.handleAutonomousTurn(threadId),
      onSessionReleased: (threadId, liveTaskIds) =>
        this.handleSessionReleased(threadId, liveTaskIds),
    })
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if (peer !== DETACHED_PEER) this.peers.set(peer.id, peer)
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
    this.peers.delete(peer.id)
    for (const [threadId, activePeer] of this.activePeerByThread.entries()) {
      if (activePeer.id === peer.id) this.activePeerByThread.delete(threadId)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.stopCommandsListener()
    try {
      // Child turns are created directly from Task/Workflow events and are not
      // registered in activeTurnByThread. Finalize them before aborting the
      // runtime or closing SQLite, otherwise stdio EOF can leave child turns
      // persisted as inProgress until a later restart recovery pass.
      this.finalizeActiveSubagentsForShutdown('server stopped')
      this.finalizeBackgroundSubagents(null, 'server stopped')
      this.completeActiveTurns('interrupted', { message: 'server stopped' })
    } finally {
      // A store that can no longer be written must not keep the Claude
      // processes running.
      try {
        await this.runtime.stop()
      } finally {
        this.store.close()
      }
    }
  }

  // Background agents keep running (and Claude may still answer them) after
  // every turn has settled; the daemon must not idle-exit underneath them.
  hasActiveTurns(): boolean {
    if (this.activeTurnByThread.size > 0) return true
    for (const entry of this.backgroundSubagents.values()) if (entry.running) return true
    return this.runtime.hasBackgroundWork?.() === true
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
        ...(error instanceof RpcError ? { data: error.data } : {}),
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
            rendersCompletedSubagentActivity(stringOr(clientInfo.version, '')) ||
            process.env.CLAUDE_CODEX_SUBAGENT_COMPLETED === '1',
          clientName:
            typeof clientInfo.name === 'string' && clientInfo.name ? clientInfo.name : null,
        })
        // The App lists config warnings in its settings, which is where an App
        // build nobody checked the App rules against gets reported.
        // App rule: config-warnings
        const appWarning = unverifiedAppWarning(clientInfo)
        if (appWarning) {
          debugLog('app.unverified', { clientInfo, summary: appWarning.summary })
          process.stderr.write(`[claude-codex-adapter] ${appWarning.summary}\n`)
        }
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
          if (appWarning) this.notify(peer, { method: 'configWarning', params: appWarning })
        })
        return {
          // App rule: feature-gates
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
        return this.historyForPeer(peer, this.threadResume(peer, asRecord(params)))
      case 'thread/fork':
        return this.historyForPeer(peer, this.threadFork(peer, asRecord(params)))
      case 'thread/list':
        return this.threadList(asRecord(params))
      case 'thread/read':
        return this.historyForPeer(peer, this.threadRead(asRecord(params)))
      case 'thread/turns/list':
        return this.historyForPeer(peer, this.threadTurnsList(asRecord(params)))
      case 'thread/turns/items/list':
        return this.historyForPeer(peer, this.threadTurnItemsList(asRecord(params)))
      case 'thread/items/list':
        return this.historyForPeer(peer, this.threadItemsList(asRecord(params)))
      case 'thread/timeline/list':
        return this.historyForPeer(peer, this.threadTimelineList(asRecord(params)))
      case 'thread/search':
        return this.threadSearch(asRecord(params))
      case 'thread/searchOccurrences':
        return this.threadSearchOccurrences(asRecord(params))
      case 'thread/attachment/add':
        return this.threadAttachmentAdd(asRecord(params))
      case 'thread/attachment/list':
        return this.threadAttachmentList(asRecord(params))
      case 'thread/attachment/remove':
        return this.threadAttachmentRemove(asRecord(params))
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
        return this.threadGoalSet(peer, asRecord(params))
      case 'thread/goal/get':
        return this.threadGoalGet(asRecord(params))
      case 'thread/goal/clear':
        return this.threadGoalClear(peer, asRecord(params))
      case 'thread/queue/add':
        return this.threadQueueAdd(peer, asRecord(params))
      case 'thread/queue/list':
        return this.threadQueueList(asRecord(params))
      case 'thread/queue/update':
        return this.threadQueueUpdate(peer, asRecord(params))
      case 'thread/queue/delete':
        return this.threadQueueDelete(peer, asRecord(params))
      case 'thread/queue/reorder':
        return this.threadQueueReorder(peer, asRecord(params))
      case 'thread/queue/start':
        return this.threadQueueStart(peer, asRecord(params))
      case 'thread/metadata/update':
        return this.historyForPeer(peer, this.threadMetadataUpdate(asRecord(params)))
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
      case 'project/list':
        return this.projectList(asRecord(params))
      case 'project/read':
        return { project: this.requireProject(stringOr(asRecord(params).projectId, '')) }
      case 'project/create':
      case 'project/import':
        return this.projectCreate(asRecord(params), method === 'project/import')
      case 'project/update':
        return this.projectUpdate(asRecord(params))
      case 'project/delete':
        return this.projectDelete(asRecord(params))
      case 'project/move':
        return this.projectMove(asRecord(params))
      case 'thread/settings/update':
        return this.threadSettingsUpdate(peer, asRecord(params))
      // Intentional no-ops: Claude Code has no equivalent concept, so the
      // adapter acknowledges the call without side effects rather than failing
      // the RPC (which would break the Codex App connection).
      case 'thread/memoryMode/set':
      case 'memory/reset':
        return {}
      // Claude Code keeps no Codex memories, so none were ever consolidated.
      case 'memory/status':
        return { v2ConsolidatedThreads: 0, v2Ready: false }
      case 'thread/unarchive':
        return this.historyForPeer(peer, this.threadArchive(asRecord(params), false))
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
        return this.threadBackgroundTerminalsClean(peer, asRecord(params))
      case 'thread/backgroundTerminals/list':
        return this.threadBackgroundTerminalsList(asRecord(params))
      case 'thread/backgroundTerminals/terminate':
        return this.threadBackgroundTerminalsTerminate(peer, asRecord(params))
      case 'thread/rollback':
        return this.historyForPeer(peer, this.threadRollback(asRecord(params)))
      case 'thread/revert':
        return this.threadRevert(peer, asRecord(params))
      case 'thread/delete':
        return this.threadDelete(peer, asRecord(params))
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
      case 'turn/settings/update':
        return this.turnSettingsUpdate(asRecord(params))
      // Realtime voice is unsupported: Claude Code has no realtime audio
      // channel. These ack so the App's capability probe does not error; a
      // real session would need a separate audio backend.
      case 'thread/realtime/start':
      case 'thread/realtime/appendAudio':
      case 'thread/realtime/appendText':
      case 'thread/realtime/appendSpeech':
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
        // The composer enables /plan and its Plan toggle only with a plan
        // preset. It puts the picker's model and effort into the mode it
        // sends, so the presets name neither.
        // App rule: collaboration-modes
        return {
          data: [
            { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null },
            { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
          ],
        }
      case 'mock/experimentalMethod':
        return {
          echoed: typeof asRecord(params).value === 'string' ? asRecord(params).value : null,
        }
      case 'skills/list':
        return { data: listClaudeSkills(asRecord(params)) }
      // Skill folders the App adds, such as its plugins'. Claude Code loads
      // skills only from its own folders, so listing these would offer skills
      // Claude cannot run.
      case 'skills/extraRoots/set':
        return {}
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
        return {}
      case 'plugin/uninstall':
        return this.pluginUninstall(asRecord(params))
      case 'plugin/install':
        return this.pluginInstall(asRecord(params))
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
      // Event streams feed MCP app widgets. This server forwards no MCP
      // events, so a subscription stays silent until the App stops it.
      case 'mcpServer/event/stream/start':
      case 'mcpServer/event/stream/stop':
        return {}
      case 'mcpServerStatus/list': {
        // serverName limits discovery to one server.
        const serverName = nullIfEmpty(stringOr(asRecord(params).serverName, ''))
        return listMcpServerStatuses(this.mcpScope(params)).then((data) => ({
          data: serverName == null ? data : data.filter((server) => server.name === serverName),
          nextCursor: null,
        }))
      }
      case 'mcpServer/resource/read':
        // originCallId comes back only when a hosted app scoped the read;
        // Claude's MCP servers are read as they are.
        return readMcpResource(
          stringOr(asRecord(params).server, ''),
          stringOr(asRecord(params).uri, ''),
          this.mcpScope(params),
        ).then((result) => ({ ...result, originCallId: null }))
      case 'mcpServer/tool/call':
        return callMcpTool(
          stringOr(asRecord(params).server, ''),
          stringOr(asRecord(params).tool, ''),
          asRecord(params).arguments ?? {},
          this.mcpScope(params),
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
        // App rule: bedrock-account
        return { account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false }
      case 'account/rateLimits/read':
        return this.accountRateLimits()
      case 'account/usage/read':
        return accountUsage(this.store.turnActivity())
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
      case 'externalAgentConfig/import/readHistories':
        return { data: this.store.listImportHistories(), connectors: [] }
      case 'externalAgentConfig/import/recordHistory':
        return this.externalAgentImportRecord(asRecord(params))
      // Codex compresses its rollout files; the store here has none.
      case 'rollout/compress':
        return {}
      case 'server/diagnostics':
        return this.serverDiagnostics()
      case 'config/value/write':
      case 'config/batchWrite':
        return this.configWriteResponse(asRecord(params))
      case 'getConversationSummary':
        return this.getConversationSummary(asRecord(params))
      case 'gitDiffToRemote':
        return this.gitDiffToRemote(asRecord(params))
      case 'getAuthStatus':
        // Not an AuthMode value, but the auth method the App derives from the
        // account/read answer above. Its main process needs the two to match.
        // App rule: bedrock-auth-status
        return { authMethod: 'amazonBedrock', authToken: null, requiresOpenaiAuth: false }
      case 'fuzzyFileSearch':
        return this.fuzzyFileSearch(asRecord(params))
      case 'fuzzyFileSearch/sessionStart':
        return this.fuzzySessionStart(asRecord(params))
      case 'fuzzyFileSearch/sessionUpdate':
        return this.fuzzySessionUpdate(peer, asRecord(params))
      case 'fuzzyFileSearch/sessionStop':
        return this.fuzzySessionStop(peer, asRecord(params))
      default: {
        const result = hostMethod(method, asRecord(params))
        if (result === undefined) throw new Error(`method not implemented: ${method}`)
        return result
      }
    }
  }

  private threadStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const id = newThreadId()
    const now = nowSeconds()
    const projectId = stringOr(params.projectId, '') || null
    if (projectId) this.requireProject(projectId)
    const requestedCwd = stringOr(params.cwd, process.cwd())
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const requestedModel = modelFromParams(params, this.configModel)
    const reasoningEffort = reasoningEffortFromParams(params, this.configReasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    const selectedProviderLoop = resolveProviderLoopSelection(this.providerLoopSelectionInput())
    const isTitleOrHelper =
      params.ephemeral === true ||
      params.threadSource === 'title_generation' ||
      params.threadSource === 'memory_consolidation'
    // The App names its own OpenAI model for titles and other helper threads,
    // and accepts another one; with Codex routing off they run on Claude.
    // App rule: helper-thread-model
    const model =
      isTitleOrHelper && this.codexRoutingDisabled() && isCodexOpenAiModel(requestedModel)
        ? claudeHelperModel(requestedModel)
        : requestedModel
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
      projectId,
    }
    this.store.upsertThread(thread)
    if (projectId) this.store.setThreadProject(id, projectId)
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
    thread.collaborationMode =
      collaborationModeFromParams(params) ?? thread.collaborationMode ?? null
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
    return {
      ...this.threadEnvelope(
        thread,
        params.excludeTurns === true ? [] : this.store.listTurns(thread.id),
      ),
      // Codex reports the thread's effective mode on resume.
      collaborationMode: collaborationModeEnvelope(thread),
    }
  }

  private threadFork(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const parentId = stringOr(params.threadId, '')
    const parent = this.store.getThread(parentId)
    if (!parent) throw new Error(`unknown thread: ${parentId}`)
    const now = nowSeconds()
    const id = newThreadId()
    const requestedModel = modelFromParams(params, parent.model)
    // The App describes a thread in an ephemeral fork named for its own
    // summary model. With Codex routing off, the fork of a Claude thread stays
    // on its model.
    // App rule: helper-thread-model
    const forkModel =
      params.ephemeral === true &&
      parent.runtimeBackend === 'claude' &&
      isCodexOpenAiModel(requestedModel) &&
      this.codexRoutingDisabled()
        ? parent.model
        : requestedModel
    // Fork: model may flip backend (forking from claude-thread with a
    // gpt-* model = new codex-backed thread); otherwise inherit parent.
    const runtimeBackend: ThreadRecord['runtimeBackend'] = isCodexOpenAiModel(forkModel)
      ? 'codex'
      : 'claude'
    const requestedCwd = stringOr(params.cwd, parent.cwd)
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const forkPoint = runtimeBackend === 'claude' ? this.forkPointOf(parent) : null
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
      model: forkModel,
      reasoningEffort: reasoningEffortFromParams(params, parent.reasoningEffort),
      claudeSessionId: forkPoint?.sessionId ?? parent.claudeSessionId,
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
      // The App forks a thread to describe it and asks for an ephemeral fork;
      // like any helper thread, it stays out of the thread list.
      ephemeral: params.ephemeral === true || parent.ephemeral,
      // A helper fork never inherits the Plan toggle.
      collaborationMode: params.ephemeral === true ? null : (parent.collaborationMode ?? null),
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
      runtimeBackend,
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    // A fork stays in its parent's project.
    if (parent.projectId) this.store.setThreadProject(id, parent.projectId)
    if (forkPoint) {
      this.store.setForkCheckpoint(id, forkPoint)
      this.store.rewindClaudeSession(id, forkPoint.sessionId, forkPoint.messageUuid)
    }
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

  // Where a fork of `thread` picks up Claude's context: the checkpoint the
  // thread itself resumes at next if it was just rewound, else the end of its
  // newest settled turn. Null for legacy threads, which fork the whole session.
  private forkPointOf(thread: ThreadRecord): ClaudeCheckpoint | null {
    if (thread.runtimeBackend === 'codex') return null
    const resumeAt = this.store.claudeResumeAt(thread.id)
    if (thread.claudeSessionId && resumeAt)
      return { sessionId: thread.claudeSessionId, messageUuid: resumeAt }
    for (const turn of this.store.listTurns(thread.id).toReversed()) {
      if (turn.status === 'inProgress') continue
      const checkpoint = this.store.turnCheckpoint(turn.id)
      if (checkpoint) return checkpoint
    }
    return null
  }

  private threadList(params: Record<string, unknown>): unknown {
    const query = this.threadListQuery(params)
    const threads = this.store.listThreads(query.options)
    const last = threads.at(-1)
    return {
      data: threads.map((thread) => this.toThread(thread, [])),
      nextCursor: last && threads.length >= query.limit ? query.cursorOf(last) : null,
      backwardsCursor: threads[0] ? query.cursorOf(threads[0]) : null,
    }
  }

  // The filters, order and page size of thread/list, which thread/search
  // shares. A cursor is a thread's sort value and id; see listThreads.
  private threadListQuery(params: Record<string, unknown>): {
    options: Parameters<SessionStore['listThreads']>[0] & { cursor: string | null }
    limit: number
    cursorOf: (thread: ThreadRecord) => string
  } {
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
    // Omitted: every project; null: unassigned threads; an id: that project.
    const projectId =
      params.projectId === null
        ? null
        : typeof params.projectId === 'string'
          ? params.projectId
          : undefined
    // The store pages at most 200 threads.
    const limit = pageLimit(params.limit, 200) ?? 50
    return {
      options: {
        archived: (params.archived as boolean | null | undefined) ?? null,
        limit,
        cursor: typeof params.cursor === 'string' ? params.cursor : null,
        isPinned,
        sectionId,
        projectId,
        cwd:
          typeof params.cwd === 'string' || Array.isArray(params.cwd)
            ? (params.cwd as string | string[])
            : null,
        includeEphemeral: params.includeEphemeral === true,
        excludeEmpty: true,
        parentThreadId,
        ancestorThreadId,
        sourceKinds,
        sortKey,
        sortDirection,
      },
      limit,
      cursorOf: (thread) => {
        const value =
          sortKey === 'section_position'
            ? (thread.sectionPosition ?? thread.createdAt)
            : sortKey === 'created_at'
              ? thread.createdAt
              : thread.updatedAt
        return `${value}:${thread.id}`
      },
    }
  }

  // The sidebar's and the archive's search. The store narrows the threads by
  // text; a thread matches when its name, its preview or one of its visible
  // messages holds the term, and the first match is its snippet. A page keeps
  // reading the store until it is full, past threads the store let through.
  private threadSearch(params: Record<string, unknown>): unknown {
    const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm : ''
    const query = this.threadListQuery(params)
    const data: Array<{ thread: unknown; snippet: string }> = []
    let first: ThreadRecord | null = null
    let scanned: ThreadRecord | null = null
    let exhausted = searchTerm.trim().length === 0
    while (!exhausted && data.length < query.limit) {
      const batch = this.store.listThreads({
        ...query.options,
        cursor: scanned ? query.cursorOf(scanned) : query.options.cursor,
        searchTerm,
      })
      exhausted = batch.length < query.limit
      for (const thread of batch) {
        if (data.length === query.limit) {
          exhausted = false
          break
        }
        scanned = thread
        const snippet = threadSnippet(
          [thread.name, thread.preview],
          () => this.store.listTurns(thread.id),
          searchTerm,
        )
        if (!snippet) continue
        first ??= thread
        data.push({ thread: this.toThread(thread, []), snippet })
      }
    }
    return {
      data,
      nextCursor: !exhausted && scanned ? query.cursorOf(scanned) : null,
      backwardsCursor: first ? query.cursorOf(first) : null,
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
    const requestedLimit = numberOr(params.limit, 100)
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.floor(requestedLimit), 200))
      : 100
    const offset = typeof params.cursor === 'string' ? Number(params.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid section cursor')
    const sections = this.store.listSections(limit, String(offset))
    const nextOffset = offset + sections.length
    const hasMore = this.store.listSections(1, String(nextOffset)).length > 0
    return { data: sections, nextCursor: hasMore ? String(nextOffset) : null }
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

  // Projects group threads in the App's sidebar. Under the projects gate the
  // App holds every project write until project/list answers, and it matches
  // the store's error texts.
  // App rule: projects
  private projectList(params: Record<string, unknown>): unknown {
    const sortKey = params.sortKey === 'recencyAt' ? 'recencyAt' : 'position'
    const sortDirection =
      params.sortDirection === 'asc' || params.sortDirection === 'desc'
        ? params.sortDirection
        : sortKey === 'position'
          ? 'asc'
          : 'desc'
    const requestedLimit = numberOr(params.limit, 100)
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.floor(requestedLimit), 200))
      : 100
    const offset = typeof params.cursor === 'string' ? Number(params.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid project cursor')
    const projects = this.store.listProjects(sortKey, sortDirection, limit + 1, offset)
    return {
      data: projects.slice(0, limit),
      nextCursor: projects.length > limit ? String(offset + limit) : null,
    }
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.store.getProject(projectId)
    if (!project) throw new Error(`project not found: ${projectId}`)
    return project
  }

  private projectCreate(params: Record<string, unknown>, importing: boolean): unknown {
    const idempotencyKey = stringOr(params.idempotencyKey, '')
    if (!idempotencyKey) throw new Error('idempotencyKey must not be empty')
    const { project, created } = this.store.createProject(newId(), idempotencyKey, {
      name: projectName(params.name),
      roots: projectRoots(params.roots),
      metadata: params.metadata == null ? {} : projectMetadata(params.metadata),
    })
    if (!created) return { project }
    this.notifyAll({
      method: 'project/changed',
      params: { projectId: project.id, changeType: 'created' },
    })
    if (!importing || !Array.isArray(params.threads)) return { project }
    for (const threadId of params.threads)
      if (typeof threadId === 'string') this.assignThreadProject(threadId, project.id)
    return { project: this.requireProject(project.id) }
  }

  private projectUpdate(params: Record<string, unknown>): unknown {
    const projectId = stringOr(params.projectId, '')
    const project = this.store.updateProject(projectId, {
      ...(params.name == null ? {} : { name: projectName(params.name) }),
      ...(params.roots == null ? {} : { roots: projectRoots(params.roots) }),
      ...(params.metadata == null ? {} : { metadata: projectMetadata(params.metadata) }),
    })
    this.notifyAll({ method: 'project/changed', params: { projectId, changeType: 'updated' } })
    return { project }
  }

  private projectDelete(params: Record<string, unknown>): unknown {
    const projectId = stringOr(params.projectId, '')
    for (const threadId of this.store.deleteProject(projectId))
      this.notifyAll({ method: 'thread/project/updated', params: { threadId, projectId: null } })
    this.notifyAll({ method: 'project/changed', params: { projectId, changeType: 'deleted' } })
    return {}
  }

  private projectMove(params: Record<string, unknown>): unknown {
    const projectId = stringOr(params.projectId, '')
    const beforeProjectId = stringOr(params.beforeProjectId, '') || null
    this.store.moveProject(projectId, beforeProjectId)
    this.notifyAll({ method: 'project/changed', params: { projectId, changeType: 'updated' } })
    return {}
  }

  // Assigns a thread to a project (null: none), telling the App if it changed.
  // Unknown threads are skipped.
  private assignThreadProject(threadId: string, projectId: string | null): void {
    if (this.store.setThreadProject(threadId, projectId))
      this.notifyAll({ method: 'thread/project/updated', params: { threadId, projectId } })
  }

  private threadRead(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    // The Codex App hydrates the Subagent panel with includeTurns:false. A
    // parent-linked child with no renderable turns is treated by that client
    // as still loading, and it does not reliably follow up with turns/list.
    // Keep metadata-only reads for ordinary threads, but return the small
    // child transcript so Prompt/Response and the terminal state can render.
    // App rule: subagent-read
    const includeTurns = params.includeTurns !== false || thread.threadSource === 'subagent'
    const turns = includeTurns ? this.store.listTurns(threadId) : []
    return { thread: this.toThread(thread, turns) }
  }

  // The App pages a long thread from its newest turn, and loads a search
  // match by reading both ways from the match's turn.
  private threadTurnsList(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const itemsView = turnItemsView(params.itemsView)
    const page = pageTurns(this.store.listTurns(threadId), {
      cursor: params.cursor,
      limit: pageLimit(params.limit),
      sortDirection: sortDirectionOr(params.sortDirection, 'desc'),
    })
    return { ...page, data: page.data.map((turn) => this.toTurnView(turn, itemsView)) }
  }

  private threadItemsList(params: Record<string, unknown>): unknown {
    return pageItems(this.store.listTurns(stringOr(params.threadId, '')), {
      turnId: stringOr(params.turnId, '') || null,
      cursor: params.cursor,
      limit: pageLimit(params.limit),
      sortDirection: sortDirectionOr(params.sortDirection, 'asc'),
    })
  }

  private threadTimelineList(params: Record<string, unknown>): unknown {
    return pageTimeline(this.store.listTurns(stringOr(params.threadId, '')), {
      cursor: params.cursor,
      limit: pageLimit(params.limit),
    })
  }

  // Find in a conversation: every match in its messages, each with the
  // thread/turns/list cursor that loads the match's turn.
  private threadSearchOccurrences(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    if (!this.store.getThread(threadId)) throw new Error(`unknown thread: ${threadId}`)
    const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm : ''
    const occurrences = findOccurrences(this.store.listTurns(threadId), searchTerm)
    const start = offsetCursor(params.cursor, 'occurrence')
    const end = start + (pageLimit(params.limit, 1000) ?? 250)
    return {
      data: occurrences.slice(start, end),
      nextCursor: end < occurrences.length ? String(end) : null,
    }
  }

  // JSON the App keeps with a thread, one per type and key: the worktree it
  // archived with the thread, the pull requests opened from it.
  private threadAttachmentAdd(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    if (!this.store.getThread(threadId)) throw new Error(`unknown thread: ${threadId}`)
    const attachmentType = stringOr(params.attachmentType, '')
    const identityKey = stringOr(params.identityKey, '')
    if (!attachmentType || !identityKey)
      throw new Error('attachmentType and identityKey must not be empty')
    const { attachment, created } = this.store.addThreadAttachment(threadId, {
      id: newId(),
      attachmentType,
      identityKey,
      payload: params.payload ?? null,
    })
    if (created) this.notifyAttachment(threadId, attachment, 'created')
    return { outcome: created ? 'created' : 'existing', attachment }
  }

  private threadAttachmentList(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    if (!this.store.getThread(threadId)) throw new Error(`unknown thread: ${threadId}`)
    const offset = offsetCursor(params.cursor, 'attachment')
    const limit = pageLimit(params.limit, 200) ?? 100
    const attachments = this.store.listThreadAttachments(threadId, limit + 1, offset)
    return {
      data: attachments.slice(0, limit),
      nextCursor: attachments.length > limit ? String(offset + limit) : null,
    }
  }

  // Removing an attachment that is not there leaves nothing to report.
  private threadAttachmentRemove(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const removed = this.store.removeThreadAttachment(
      threadId,
      stringOr(params.attachmentType, ''),
      stringOr(params.identityKey, ''),
    )
    if (removed) this.notifyAttachment(threadId, removed, 'deleted')
    return {}
  }

  private notifyAttachment(
    threadId: string,
    attachment: ThreadAttachmentRecord,
    operation: 'created' | 'deleted',
  ): void {
    this.notifyAll({
      method: 'thread/attachment/updated',
      params: {
        threadId,
        attachmentType: attachment.attachmentType,
        identityKey: attachment.identityKey,
        attachmentId: attachment.id,
        operation,
      },
    })
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
  // usage tallies, goal bookkeeping, elicitation counts) so an archived thread
  // does not leak entries for the lifetime of the process. The goal itself and
  // the queue stay persisted for an unarchive.
  private clearThreadState(threadId: string): void {
    this.commandSessionAllow.delete(threadId)
    this.tokenUsageByThread.delete(threadId)
    this.lastCallUsageByThread.delete(threadId)
    this.lastUsageByThread.delete(threadId)
    this.contextWindowByThread.delete(threadId)
    this.goalIdleStreaks.delete(threadId)
    this.goalClockByThread.delete(threadId)
    this.goalTurnByThread.delete(threadId)
    this.goalToolHandlers.delete(threadId)
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

  // Thread goals follow Codex: the goal is persisted per thread, and while it
  // is active the adapter keeps the thread working by starting hidden
  // continuation turns whenever it goes idle (see startFollowUp).
  private threadGoalSet(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.goalThread(threadId)
    this.activePeerByThread.set(threadId, peer)
    if (params.status != null && !isGoalStatus(params.status))
      throw new Error(`invalid goal status: ${String(params.status)}`)
    const status = isGoalStatus(params.status) ? params.status : null
    const objective = typeof params.objective === 'string' ? params.objective.trim() : null
    if (objective === '') throw new Error('goal objective must not be empty')
    // An explicit null clears the budget; an absent field leaves it alone.
    const budget = 'tokenBudget' in params ? goalBudget(params.tokenBudget) : undefined
    const existing = this.store.getGoal(threadId)
    const now = nowSeconds()
    let goal: ThreadGoal
    let objectiveChanged = false
    if (
      !existing ||
      (existing.status === 'complete' && objective && objective !== existing.objective)
    ) {
      if (!objective) throw new Error(`no goal exists for thread ${threadId}`)
      goal = {
        threadId,
        objective,
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      }
    } else {
      goal = { ...existing }
      this.accrueGoalTime(goal)
      objectiveChanged = objective != null && objective !== existing.objective
      if (objective) goal.objective = objective
    }
    if (budget !== undefined) goal.tokenBudget = budget
    if (status) goal.status = status
    if (goal.status === 'active' && goalBudgetExhausted(goal)) goal.status = 'budgetLimited'
    goal.updatedAt = now
    // Setting or resuming a goal gives continuation a fresh start.
    if (goal.status === 'active') this.goalIdleStreaks.delete(threadId)
    this.commitGoal(goal)
    if (goal.status === 'active') {
      if (!this.activeTurnByThread.has(threadId)) setImmediate(() => this.startFollowUp(threadId))
      else if (objectiveChanged)
        void this.runtime
          .steer(threadId, goalObjectiveUpdatedPrompt(goal))
          .catch((error) =>
            debugLog('goal.objectiveSteer.failed', { threadId, error: String(error) }),
          )
    }
    return { goal }
  }

  private threadGoalGet(params: Record<string, unknown>): unknown {
    return { goal: this.store.getGoal(stringOr(params.threadId, '')) }
  }

  private threadGoalClear(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    if (this.store.getThread(threadId)) this.activePeerByThread.set(threadId, peer)
    const cleared = this.store.deleteGoal(threadId)
    this.goalIdleStreaks.delete(threadId)
    this.goalClockByThread.delete(threadId)
    this.goalTurnByThread.delete(threadId)
    if (cleared)
      this.notifyThread(threadId, { method: 'thread/goal/cleared', params: { threadId } })
    return { cleared }
  }

  private goalThread(threadId: string): ThreadRecord {
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (thread.ephemeral) throw new Error('Goal tools require a persistent thread.')
    return thread
  }

  private commitGoal(goal: ThreadGoal): void {
    this.store.putGoal(goal)
    this.syncGoalClock(goal.threadId, goal)
    this.notifyThread(goal.threadId, {
      method: 'thread/goal/updated',
      params: {
        threadId: goal.threadId,
        turnId: this.activeTurnByThread.get(goal.threadId) ?? null,
        goal,
      },
    })
  }

  // Goal time runs while the goal is active and the thread has a turn.
  private syncGoalClock(threadId: string, goal: ThreadGoal | null): void {
    const turnId = this.activeTurnByThread.get(threadId)
    if (goal?.status !== 'active' || !turnId) {
      this.goalClockByThread.delete(threadId)
      return
    }
    this.goalTurnByThread.set(threadId, turnId)
    if (!this.goalClockByThread.has(threadId)) this.goalClockByThread.set(threadId, Date.now())
  }

  private accrueGoalTime(goal: ThreadGoal): void {
    const since = this.goalClockByThread.get(goal.threadId)
    if (since == null) return
    const seconds = Math.floor((Date.now() - since) / 1000)
    if (seconds <= 0) return
    goal.timeUsedSeconds += seconds
    this.goalClockByThread.set(goal.threadId, since + seconds * 1000)
  }

  // Codex counts goal tokens while the goal is active; cache reads are free.
  // Claude reports usage per result, so a turn that completed or paused the
  // goal midway still owes it the tokens it spent.
  private accrueGoalTokens(threadId: string, tokens: number, midTurn: boolean): void {
    if (tokens <= 0) return
    const goal = this.store.getGoal(threadId)
    if (!goal) return
    const goalTurn = this.goalTurnByThread.get(threadId)
    if (goal.status !== 'active' && goalTurn !== this.activeTurnByThread.get(threadId)) return
    this.accrueGoalTime(goal)
    goal.tokensUsed += tokens
    const limited = goal.status === 'active' && goalBudgetExhausted(goal)
    if (limited) goal.status = 'budgetLimited'
    goal.updatedAt = nowSeconds()
    this.commitGoal(goal)
    // Like Codex, a budget that runs out mid-turn asks the model to wrap up
    // rather than cutting the turn off; no continuation follows it.
    if (limited && midTurn)
      void this.runtime
        .steer(threadId, goalBudgetLimitPrompt(goal))
        .catch((error) => debugLog('goal.budgetSteer.failed', { threadId, error: String(error) }))
  }

  // Charges one main-loop API call as it streams. Its usage only grows, and
  // the turn's result reconciles whatever it charged.
  private recordUsageProgress(
    threadId: string,
    messageId: string,
    usage: Record<string, unknown>,
  ): void {
    const breakdown = tokenBreakdownFromClaudeUsage(usage)
    if (breakdown.totalTokens > 0) this.lastCallUsageByThread.set(threadId, breakdown)
    const counted = breakdown.inputTokens + breakdown.outputTokens
    const progress = this.goalProgressByThread.get(threadId) ?? new Map<string, number>()
    const charged = progress.get(messageId) ?? 0
    if (counted <= charged) return
    progress.set(messageId, counted)
    this.goalProgressByThread.set(threadId, progress)
    this.accrueGoalTokens(threadId, counted - charged, true)
  }

  // Bookkeeping for a turn that just left the thread: close the goal clock
  // and track whether hidden continuation turns still make progress.
  private settleGoalTurn(threadId: string, settled: TurnRecord | null): void {
    const goalTurn = settled ? this.goalTurns.delete(settled.id) : false
    this.goalTurnByThread.delete(threadId)
    this.goalProgressByThread.delete(threadId)
    const goal = this.store.getGoal(threadId)
    if (!goal) {
      this.goalClockByThread.delete(threadId)
      return
    }
    if (this.goalClockByThread.has(threadId)) {
      this.accrueGoalTime(goal)
      this.goalClockByThread.delete(threadId)
      if (
        goal.status === 'active' &&
        settled?.status === 'failed' &&
        isUsageLimitError(settled.error)
      )
        goal.status = 'usageLimited'
      goal.updatedAt = nowSeconds()
      this.commitGoal(goal)
    }
    if (!goalTurn || !settled) return
    if (settled.status !== 'completed' || !goalTurnMadeProgress(settled))
      this.goalIdleStreaks.set(threadId, (this.goalIdleStreaks.get(threadId) ?? 0) + 1)
    else this.goalIdleStreaks.delete(threadId)
  }

  private canContinueGoal(threadId: string): boolean {
    const thread = this.store.getThread(threadId)
    return (
      !this.stopped &&
      !!thread &&
      !thread.ephemeral &&
      !thread.archived &&
      thread.runtimeBackend === 'claude' &&
      this.store.getGoal(threadId)?.status === 'active' &&
      (this.goalIdleStreaks.get(threadId) ?? 0) < GOAL_IDLE_TURN_LIMIT
    )
  }

  // Goal tools the model calls through the codex_goal MCP server. They read
  // the thread's goal at call time, so one set of handlers serves the
  // thread's whole session.
  private goalToolsFor(threadId: string): GoalToolHandlers {
    const cached = this.goalToolHandlers.get(threadId)
    if (cached) return cached
    const handlers: GoalToolHandlers = {
      getGoal: async () => goalToolResult(this.store.getGoal(threadId)),
      createGoal: async (rawObjective, tokenBudget) => {
        this.goalThread(threadId)
        const objective = rawObjective.trim()
        if (!objective) throw new Error('goal objective must not be empty')
        const budget = goalBudget(tokenBudget)
        const existing = this.store.getGoal(threadId)
        if (existing && existing.status !== 'complete')
          throw new Error(
            'cannot create a new goal because this thread has an unfinished goal; complete the existing goal first',
          )
        const now = nowSeconds()
        const goal: ThreadGoal = {
          threadId,
          objective,
          status: 'active',
          tokenBudget: budget,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
        }
        this.goalIdleStreaks.delete(threadId)
        this.commitGoal(goal)
        return goalToolResult(goal)
      },
      updateGoal: async (status) => {
        const goal = this.store.getGoal(threadId)
        if (!goal) throw new Error('cannot update goal because this thread has no goal')
        if (!MODEL_GOAL_STATUSES.has(status) || !isGoalStatus(status))
          throw new Error(
            "update_goal can only mark the existing goal complete, blocked, or paused at the user's explicit request; resume, budget-limited, and usage-limited status changes are controlled by the user or system",
          )
        // Budget limits take precedence over pausing.
        if (status === 'paused' && goal.status === 'budgetLimited') return goalToolResult(goal)
        this.accrueGoalTime(goal)
        goal.status = status
        goal.updatedAt = nowSeconds()
        this.commitGoal(goal)
        return goalToolResult(goal, status === 'complete')
      },
    }
    this.goalToolHandlers.set(threadId, handlers)
    return handlers
  }

  // Server-side message queue (thread/queue/*). Codex App queues follow-ups
  // here instead of in the window once the app-server version passes its
  // gate; the server dispatches the head whenever the thread goes idle, and
  // holds after an interrupted turn until the App resumes it with
  // thread/queue/start.
  private queueThread(threadId: string): ThreadRecord {
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (thread.ephemeral) throw new Error('queued messages require a persistent thread')
    return thread
  }

  private saveQueue(threadId: string, items: QueuedSubmission[]): void {
    this.store.saveQueue(threadId, items)
    this.notifyThread(threadId, { method: 'thread/queue/changed', params: { threadId } })
  }

  private queuedSubmission(threadId: string, id: string): QueuedSubmission {
    const item = this.store.listQueue(threadId).find((entry) => entry.id === id)
    if (!item) throw new Error(`unknown queued submission: ${id}`)
    return item
  }

  private threadQueueAdd(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.queueThread(threadId)
    this.activePeerByThread.set(threadId, peer)
    const submission: QueuedSubmission = {
      id: newId(),
      input: queuedInput(params.input),
      clientUserMessageId: nullIfEmpty(stringOr(params.clientUserMessageId, '')),
    }
    this.saveQueue(threadId, [...this.store.listQueue(threadId), submission])
    if (!this.activeTurnByThread.has(threadId) && !this.queueHeld(threadId))
      setImmediate(() => this.startFollowUp(threadId))
    return { queuedSubmission: submission }
  }

  private threadQueueList(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.queueThread(threadId)
    return { data: this.store.listQueue(threadId), nextCursor: null }
  }

  private threadQueueUpdate(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.queueThread(threadId)
    this.activePeerByThread.set(threadId, peer)
    const id = stringOr(params.queuedSubmissionId, '')
    const updated: QueuedSubmission = {
      ...this.queuedSubmission(threadId, id),
      input: queuedInput(params.input),
    }
    this.saveQueue(
      threadId,
      this.store.listQueue(threadId).map((entry) => (entry.id === id ? updated : entry)),
    )
    return { queuedSubmission: updated }
  }

  private threadQueueDelete(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.queueThread(threadId)
    this.activePeerByThread.set(threadId, peer)
    const id = stringOr(params.queuedSubmissionId, '')
    const items = this.store.listQueue(threadId)
    const rest = items.filter((entry) => entry.id !== id)
    if (rest.length === items.length) return { deleted: false }
    this.saveQueue(threadId, rest)
    return { deleted: true }
  }

  private threadQueueReorder(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.queueThread(threadId)
    this.activePeerByThread.set(threadId, peer)
    const order = Array.isArray(params.queuedSubmissionIds)
      ? params.queuedSubmissionIds.filter((id): id is string => typeof id === 'string')
      : []
    const byId = new Map(this.store.listQueue(threadId).map((entry) => [entry.id, entry]))
    const reordered: QueuedSubmission[] = []
    for (const id of order) {
      const entry = byId.get(id)
      if (!entry) continue
      byId.delete(id)
      reordered.push(entry)
    }
    this.saveQueue(threadId, [...reordered, ...byId.values()])
    return {}
  }

  private async threadQueueStart(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    this.queueThread(threadId)
    if (this.activeTurnByThread.has(threadId))
      throw new Error(`cannot start a queued message while thread ${threadId} has an active turn`)
    const id = stringOr(params.queuedSubmissionId, '')
    const submission = this.queuedSubmission(threadId, id)
    return this.dispatchQueued(peer, threadId, submission)
  }

  private queueHeld(threadId: string): boolean {
    return this.store.lastTurnStatus(threadId) === 'interrupted'
  }

  // Runs one queued submission as a regular user turn. The submission leaves
  // the queue only once its turn exists, so a rejected start keeps it.
  private async dispatchQueued(
    peer: RpcPeer,
    threadId: string,
    submission: QueuedSubmission,
  ): Promise<unknown> {
    const result = await this.turnStart(peer, {
      ...this.followUpParams(threadId),
      input: submission.input,
      ...(submission.clientUserMessageId
        ? { clientUserMessageId: submission.clientUserMessageId }
        : {}),
      _emitUserMessage: true,
    })
    this.saveQueue(
      threadId,
      this.store.listQueue(threadId).filter((entry) => entry.id !== submission.id),
    )
    return result
  }

  // Settings for a turn the adapter starts on the user's behalf: whatever the
  // last user turn used, minus its input. Queued messages never carry a
  // collaboration mode (the App keeps those in the window queue), and these
  // turns stay out of plan mode without changing the thread's stored mode.
  private followUpParams(threadId: string): Record<string, unknown> {
    const {
      input: _input,
      clientUserMessageId: _clientId,
      outputSchema: _schema,
      collaborationMode: _mode,
      ...rest
    } = this.lastTurnParamsByThread.get(threadId) ?? {}
    return { ...rest, threadId, planMode: false }
  }

  // The thread just went idle: run the next queued message, else keep an
  // active goal going. `settled` is the status of the turn that just ended,
  // when there is one; nothing follows an interrupt, and a goal does not
  // retry a failure on its own. Returns whether a turn was started.
  private startFollowUp(threadId: string, settled?: TurnStatus): boolean {
    if (this.stopped || settled === 'interrupted' || this.activeTurnByThread.has(threadId))
      return false
    const thread = this.store.getThread(threadId)
    if (!thread || thread.archived) return false
    const peer = this.peerForThread(threadId)
    if (!thread.ephemeral && !this.queueHeld(threadId)) {
      const head = this.store.listQueue(threadId)[0]
      if (head) {
        void this.dispatchQueued(peer, threadId, head).catch((error) => {
          debugLog('queue.dispatch.failed', { threadId, error: String(error) })
          this.notify(peer, {
            method: 'error',
            params: { threadId, turnId: null, willRetry: false, error: { message: String(error) } },
          })
        })
        return this.activeTurnByThread.has(threadId)
      }
    }
    if (settled === 'failed' || !this.canContinueGoal(threadId)) return false
    const goal = this.store.getGoal(threadId)
    if (!goal) return false
    void this.turnStart(peer, {
      ...this.followUpParams(threadId),
      input: [],
      _hiddenPrompt: goalContinuationPrompt(goal),
    }).catch((error) => debugLog('goal.continue.failed', { threadId, error: String(error) }))
    return this.activeTurnByThread.has(threadId)
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
    // projectId: omitted or null leaves it, '' clears it, an id assigns it.
    const projectId = typeof params.projectId === 'string' ? params.projectId || null : undefined
    if (projectId) this.requireProject(projectId)

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
    if (projectId !== undefined) {
      this.assignThreadProject(threadId, projectId)
      thread.projectId = projectId
    }

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
    thread.collaborationMode =
      collaborationModeFromParams(params) ?? thread.collaborationMode ?? null

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
          // The App adopts this as the composer's mode, so it has to be the
          // thread's real one or the Plan toggle switches itself off.
          // App rule: collaboration-modes
          collaborationMode: collaborationModeEnvelope(thread),
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
      const dropped = this.rewindThread(thread, () =>
        this.store.deleteRecentTurns(threadId, numTurns),
      )
      debugLog('thread.rollback', { threadId, requested: numTurns, dropped })
    }
    return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
  }

  // thread/revert is the paginated-history form of rollback: drop a turn and
  // everything after it, then let the App hydrate what is left through
  // thread/turns/list. Local file changes stay, as in Codex.
  private threadRevert(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const beforeTurnId = stringOr(params.beforeTurnId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (!this.store.listTurns(threadId).some((turn) => turn.id === beforeTurnId))
      throw new Error(`unknown turn: ${beforeTurnId}`)
    const dropped = this.rewindThread(thread, () =>
      this.store.deleteTurnsFrom(threadId, beforeTurnId),
    )
    debugLog('thread.revert', { threadId, beforeTurnId, dropped })
    const kept = this.store.listTurns(threadId)
    const last = kept.at(-1)
    const lastItem = last?.items.at(-1)
    this.notify(peer, { method: 'thread/reverted', params: { threadId } })
    return {
      thread: this.toThread(this.store.getThread(threadId) ?? thread, []),
      turnsBackwardsCursor: last ? last.id : null,
      itemsBackwardsCursor: lastItem ? lastItem.id : null,
    }
  }

  // Drops turns from the end of a thread and makes Claude forget them too:
  // the thread's next turn resumes the newest remaining checkpoint in a
  // forked session, so the transcript it came from stays valid for later
  // rewinds. Returns the number of turns dropped.
  private rewindThread(thread: ThreadRecord, drop: () => number): number {
    if (this.activeTurnByThread.has(thread.id))
      throw new Error(`cannot rewind thread ${thread.id} while a turn is running`)
    const dropped = drop()
    if (dropped === 0) return 0
    const remaining = this.store.listTurns(thread.id)
    if (thread.runtimeBackend === 'codex') {
      // `codex exec resume` cannot truncate a session; only a full rewind is exact.
      if (remaining.length === 0) this.store.updateCodexSessionId(thread.id, null)
      return dropped
    }
    this.runtime.resetSession?.(thread.id)
    for (const turn of remaining.toReversed()) {
      const checkpoint = this.store.turnCheckpoint(turn.id)
      if (checkpoint) {
        this.store.rewindClaudeSession(thread.id, checkpoint.sessionId, checkpoint.messageUuid)
        return dropped
      }
    }
    if (remaining.length === 0) {
      // Back to where the thread began: its fork point, or a new session.
      const fork = this.store.forkCheckpoint(thread.id)
      const parent = thread.forkedFromId ? this.store.getThread(thread.forkedFromId) : null
      this.store.rewindClaudeSession(
        thread.id,
        fork?.sessionId ?? parent?.claudeSessionId ?? null,
        fork?.messageUuid ?? null,
      )
      return dropped
    }
    // The remaining turns predate checkpoints: Claude keeps its context.
    debugLog('thread.rewind.unanchored', { threadId: thread.id, dropped })
    return dropped
  }

  // thread/delete removes a thread for good: its turns, goal and queue, and
  // the subagent threads it spawned. Claude's transcripts stay on disk;
  // forks of the thread may still resume from them. An unknown thread fails
  // the way Codex fails a thread without a rollout, so the App retries with
  // missingRolloutRecovery, which finds nothing left to delete.
  // App rule: delete-missing-rollout
  private async threadDelete(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    if (!this.store.getThread(threadId)) {
      if (params.missingRolloutRecovery === true) return {}
      throw new Error(`no rollout found for thread id ${threadId}`)
    }
    if (this.activeTurnByThread.has(threadId)) await this.turnInterrupt(peer, { threadId })
    // Background agents go with the thread that launched them (or that they
    // are): their turns end before their threads do.
    for (const entry of [...this.backgroundSubagents.values()]) {
      if (!entry.running) continue
      if (entry.parentThreadId !== threadId && entry.context.childThreadId !== threadId) continue
      await this.stopBackgroundSubagent(entry)
    }
    for (const id of this.store.deleteThread(threadId)) {
      this.runtime.resetSession?.(id)
      this.clearThreadState(id)
      this.pendingAutonomousTurns.delete(id)
      this.lastTurnParamsByThread.delete(id)
      this.goalProgressByThread.delete(id)
      this.backgroundSubagents.delete(id)
      this.activePeerByThread.delete(id)
      this.notify(peer, { method: 'thread/deleted', params: { threadId: id } })
    }
    return {}
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

  // Codex's "clean background terminals" ends the shells a thread left
  // running. Claude's are its background Bash tasks; stopping them through the
  // runtime also drops the turn Claude would start to acknowledge the stop.
  private async threadBackgroundTerminalsClean(
    peer: RpcPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    if (threadId) this.activePeerByThread.set(threadId, peer)
    const shells = (this.runtime.liveTasks?.(threadId) ?? []).filter(
      (task) => task.taskType === 'local_bash',
    )
    const stopped = await Promise.all(
      shells.map((task) =>
        (this.runtime.stopTask?.(threadId, task.taskId) ?? Promise.resolve(false)).catch(
          () => false,
        ),
      ),
    )
    debugLog('thread.backgroundTerminals.clean', {
      threadId,
      backgroundShells: shells.length,
      stopped: stopped.filter(Boolean).length,
      activeCommandProcesses: this.commandProcesses.size,
      activeProcessHandles: this.processHandles.size,
    })
    return {}
  }

  // Claude's background shells, shown by the App as the thread's background
  // terminals. Each is the Bash call that started it; the CLI runs it, so
  // there is no process id or usage to report.
  private threadBackgroundTerminalsList(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const terminals = this.backgroundShells(threadId).map(({ task, item }) => ({
      itemId: item?.id ?? task.taskId,
      processId: item?.processId ?? `claude-task:${task.taskId}`,
      command: item?.command ?? '',
      cwd: item?.cwd ?? this.store.getThread(threadId)?.cwd ?? '',
      osPid: null,
      cpuPercent: null,
      rssKb: null,
    }))
    const offset = offsetCursor(params.cursor, 'terminal')
    const end = offset + (pageLimit(params.limit, 200) ?? 100)
    return {
      data: terminals.slice(offset, end),
      nextCursor: end < terminals.length ? String(end) : null,
    }
  }

  private async threadBackgroundTerminalsTerminate(
    peer: RpcPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const processId = stringOr(params.processId, '')
    const shell = this.backgroundShells(threadId).find(
      ({ task, item }) =>
        item?.processId === processId || `claude-task:${task.taskId}` === processId,
    )
    if (!shell) return { terminated: false }
    this.activePeerByThread.set(threadId, peer)
    const terminated =
      (await this.runtime.stopTask?.(threadId, shell.task.taskId).catch(() => false)) === true
    debugLog('thread.backgroundTerminals.terminate', { threadId, processId, terminated })
    return { terminated }
  }

  // The thread's running background shells, each with the command item of
  // the Bash call that started it when the store has one.
  private backgroundShells(threadId: string): Array<{
    task: RuntimeLiveTask
    item: Extract<ThreadItem, { type: 'commandExecution' }> | null
  }> {
    const shells = (this.runtime.liveTasks?.(threadId) ?? []).filter(
      (task) => task.taskType === 'local_bash',
    )
    if (shells.length === 0) return []
    const commands = new Map<string, Extract<ThreadItem, { type: 'commandExecution' }>>()
    for (const turn of this.store.listTurns(threadId))
      for (const item of turn.items)
        if (item.type === 'commandExecution' && item.processId) commands.set(item.processId, item)
    return shells.map((task) => ({
      task,
      item: task.toolUseId ? (commands.get(`claude:${task.toolUseId}`) ?? null) : null,
    }))
  }

  // Codex can change a running turn's model, effort or reviewer; null leaves a
  // setting as it is, and the next turn takes its settings from turn/start
  // again. Claude switches model and effort in place. The user reviews every
  // approval, so the only reviewer is 'user'; a reasoning summary and a
  // service tier have no Claude counterpart.
  private async turnSettingsUpdate(params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const turnId = stringOr(params.turnId, '')
    const thread = this.store.getThread(threadId)
    if (!thread || this.activeTurnByThread.get(threadId) !== turnId)
      return { status: 'targetUnavailable' }
    const unsupported = ['summary', 'serviceTier'].filter((key) => params[key] != null)
    if (params.approvalsReviewer != null && params.approvalsReviewer !== 'user')
      unsupported.unshift(`approvalsReviewer ${String(params.approvalsReviewer)}`)
    if (unsupported.length > 0)
      throw new Error(`a running Claude turn cannot change ${unsupported.join(', ')}`)
    const settings: RuntimeTurnSettings = {}
    if (params.model != null) {
      // Unlike turn/start, an unknown model fails instead of falling back.
      const requested = stringOr(params.model, '')
      const model = allSelectableModelOptions().find(
        (option) => option.id.toLowerCase() === requested.toLowerCase(),
      )?.id
      if (!model) throw new Error(`unknown model: ${requested}`)
      const backend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      if (backend !== thread.runtimeBackend)
        throw new Error(`a running ${thread.runtimeBackend} turn cannot switch to ${model}`)
      const resolved = backend === 'codex' ? model : resolveClaudeModel(model)
      if (resolved) settings.model = resolved
    }
    if (params.effort != null) {
      const effort = resolveClaudeEffort(stringOr(params.effort, ''))
      if (!effort) throw new Error(`unsupported effort: ${String(params.effort)}`)
      settings.effort = effort
    }
    if (settings.model == null && settings.effort == null) return { status: 'applied' }
    if (!this.runtime.updateTurnSettings)
      throw new Error('this runtime cannot change the settings of a running turn')
    const applied = await this.runtime.updateTurnSettings(threadId, turnId, settings)
    return { status: applied ? 'applied' : 'targetUnavailable' }
  }

  // What the App's feedback report shows about this server.
  private serverDiagnostics(): unknown {
    let backgroundSubagents = 0
    for (const entry of this.backgroundSubagents.values())
      if (entry.running) backgroundSubagents += 1
    return {
      process: {
        id: process.pid,
        residentMemoryBytes: process.memoryUsage.rss(),
        physicalFootprintBytes: null,
      },
      gauges: [
        { name: 'connections', value: this.peers.size },
        { name: 'active_turns', value: this.activeTurnByThread.size },
        { name: 'background_subagents', value: backgroundSubagents },
        { name: 'command_processes', value: this.commandProcesses.size },
        { name: 'process_handles', value: this.processHandles.size },
      ],
    }
  }

  // The App imports another agent's setup itself and records the outcome
  // here, to show it later.
  private externalAgentImportRecord(params: Record<string, unknown>): unknown {
    const results = Array.isArray(params.itemTypeResults)
      ? params.itemTypeResults.map(asRecord)
      : []
    const importId = newId()
    this.store.addImportHistory({
      importId,
      providerId: stringOr(params.providerId, '') || null,
      completedAtMs: Date.now(),
      successes: results.flatMap((result) =>
        Array.isArray(result.successes)
          ? result.successes.map((success) => ({ title: null, ...asRecord(success) }))
          : [],
      ),
      failures: results.flatMap((result) =>
        Array.isArray(result.failures) ? result.failures : [],
      ),
    })
    return { importId }
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
      // stop() has already settled this turn; starting it now would launch
      // Claude after the runtime stopped.
      if (this.stopped) return
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
        if (!this.failTurn(peer, threadId, turn, error)) return
        recordRunEvent('turn.failed', {
          threadId,
          turnId,
          runtimeBackend: thread.runtimeBackend,
          error: { message: error.message },
        })
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
      // stop() has already settled this turn; starting it now would launch
      // Claude after the runtime stopped.
      if (this.stopped) return
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
          let finalAgent: ThreadItem = agentItem
          try {
            finalAgent =
              this.store.getTurn(turnId)?.items.find((i) => i.id === agentItem.id) ?? agentItem
          } catch {}
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: finalAgent, completedAtMs: nowMillis() },
          })
          // An interrupt already ended the turn and told the client.
          const completed = this.endTurn(turn, 'completed', null)
          if (!completed) return
          this.clearActiveTurn(threadId)
          this.setThreadStatus(peer, threadId, { type: 'idle' })
          this.notify(peer, {
            method: 'turn/completed',
            params: { threadId, turn: this.toLifecycleTurn(completed) },
          })
          this.notify(peer, { method: 'thread/compacted', params: { threadId } })
        })
        // The fallback writes to the store too; the turn has still ended above.
        .catch((error) => {
          debugLog('thread.compact.fallback_failed', {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          })
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
    // Follow-up turns the adapter starts itself have no requesting peer.
    if (peer !== DETACHED_PEER) this.activePeerByThread.set(threadId, peer)

    const turnId = newId()
    const input = turnInput(params)
    // Goal continuations prompt the model with hidden internal context and
    // carry no user message.
    const hiddenPrompt = typeof params._hiddenPrompt === 'string' ? params._hiddenPrompt : null
    // Codex App's Continue button sends no input at all.
    // App rule: continue-turns
    const resumed =
      hiddenPrompt == null && params.outputSchema == null && isEmptyInput(input)
        ? continuePrompt(interruptedUserText(this.store.lastTurn(threadId)))
        : null
    // extractImageInputs splits user input into the text prompt and any image
    // attachments (localImage / image URL / data:). Sidecar repacks the
    // images into a Claude SDK multimodal user message; here we also append
    // an `imageView` ThreadItem per image so the App's transcript shows them
    // inline next to the user message instead of losing them.
    const { textPrompt, images } = extractImageInputs(input)
    // A skill picked in the composer arrives as a markdown link; Claude Code
    // runs it as a slash command. The user message keeps the original input.
    // Text copied or handed over from a quiet turn's message drops the
    // heartbeat the adapter appended to it.
    // App rule: quiet-turn-heartbeat
    const prompt =
      hiddenPrompt ??
      resumed ??
      stripQuietTurnHeartbeat(skillLinksToCommand(textPrompt || textFromInput(input)))
    const workflowCommand = hiddenPrompt || resumed ? null : parseWorkflowCommand(prompt)
    // Like Codex, input that arrives while a turn is running joins that turn.
    // A turn/start can race a turn the adapter has just opened itself (for a
    // background agent's or workflow's report); a second turn would orphan
    // it, and it would never complete.
    if (resumed) {
      // Pressed while a turn runs: that turn is already carrying on.
      const runningTurnId = this.activeTurnByThread.get(threadId)
      const running = runningTurnId ? this.store.getTurn(runningTurnId) : null
      if (running?.status === 'inProgress') return { turn: this.toLifecycleTurn(running) }
    } else if (!hiddenPrompt && params.outputSchema == null) {
      const joined = await this.joinRunningTurn(
        peer,
        threadId,
        params,
        workflowCommand?.type === 'list',
      )
      if (joined) return { turn: this.toLifecycleTurn(joined) }
    }
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    // The App's Plan toggle. collaborationMode.mode names the mode and the
    // thread keeps it for turns that name none; the legacy planMode flag
    // sets one turn (the adapter's own follow-ups use it to stay out of
    // plan mode). A structured title or summary turn never plans.
    // App rule: collaboration-modes
    const namedMode = collaborationModeFromParams(params)
    if (namedMode) thread.collaborationMode = namedMode
    const planMode =
      params.outputSchema == null &&
      (namedMode != null
        ? namedMode === 'plan'
        : typeof params.planMode === 'boolean'
          ? params.planMode
          : thread.collaborationMode === 'plan')
    const requestedModel = modelFromParams(params, thread.model)
    // A helper thread on Claude maps a Codex model like thread/start does.
    // Structured summary/title turns map theirs to the summary model anyway.
    // App rule: helper-thread-model
    const helperModel =
      params.outputSchema == null &&
      thread.ephemeral &&
      thread.runtimeBackend === 'claude' &&
      isCodexOpenAiModel(requestedModel) &&
      this.codexRoutingDisabled()
        ? claudeHelperModel(requestedModel)
        : null
    const model = helperModel ?? requestedModel
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
    if (!hiddenPrompt && !resumed && !thread.preview && prompt) {
      thread.preview = prompt.slice(0, 200)
      thread.updatedAt = nowSeconds()
      this.store.upsertThread(thread)
    }
    const userItem: ThreadItem | null = hiddenPrompt ? null : turnInputItem(params, input)
    const initialItems: ThreadItem[] = userItem ? [userItem] : []
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
    if (hiddenPrompt) this.goalTurns.add(turnId)
    else if (params.outputSchema == null) this.goalIdleStreaks.delete(threadId)
    this.syncGoalClock(threadId, this.store.getGoal(threadId))
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toLifecycleTurn(turn)

    setImmediate(() => {
      // stop() has already settled this turn; starting it now would launch
      // Claude after the runtime stopped.
      if (this.stopped) return
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      // The App renders its own optimistic user message for turn/start; a
      // turn started from the server-side queue has none, so publish it.
      // App rule: optimistic-user-message
      if (userItem && params._emitUserMessage === true)
        this.emitItemLifecycle(peer, threadId, turnId, userItem)
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
      this.launchRuntimeTurn(peer, thread, turn, prompt, {
        ...params,
        ...collaborationModeSettings(params),
        ...(helperModel ? { model: helperModel } : {}),
        planMode,
        _imageInputs: images,
      })
    })
    return { turn: publicTurn }
  }

  // Steers input into the thread's running turn. Returns null when there is
  // none, or when it ended before the runtime took the input in, so that the
  // input starts the next turn instead.
  private async joinRunningTurn(
    peer: RpcPeer,
    threadId: string,
    params: Record<string, unknown>,
    workflowList: boolean,
  ): Promise<TurnRecord | null> {
    for (;;) {
      const runningTurnId = this.activeTurnByThread.get(threadId)
      if (!runningTurnId || this.store.getTurn(runningTurnId)?.status !== 'inProgress') return null
      if (workflowList) throw new Error('/workflows list can run once the current turn finishes')
      try {
        await this.turnSteer(peer, { ...params, expectedTurnId: runningTurnId })
      } catch (error) {
        if (this.activeTurnByThread.get(threadId) === runningTurnId) throw error
        // That turn ended meanwhile: join the one after it, if any.
        continue
      }
      return this.store.getTurn(runningTurnId)
    }
  }

  // Runs a turn and ends it if the run fails. Until both are done, something
  // still owns the turn and will end it.
  private launchRuntimeTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    prompt: string,
    params: Record<string, unknown>,
  ): void {
    this.runtimeRuns.add(turn.id)
    void this.runRuntimeTurn(peer, thread, turn, prompt, params)
      .catch((error) => {
        this.failTurn(peer, thread.id, turn, error)
      })
      .finally(() => this.runtimeRuns.delete(turn.id))
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
        const childIds = new Set<string>()
        for (const item of turn.items) {
          if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') continue
          for (const childId of item.receiverThreadIds) childIds.add(childId)
        }
        const children = Array.from(childIds).map((childId) => ({
          childId,
          child: this.store.getThread(childId),
        }))
        // Claude also runs workflows unasked; their agents carry the workflow role.
        const workflow = children.find(({ child }) => child?.agentRole === 'workflow')?.child
        if (command?.type !== 'run' && !workflow) return null
        const agents = children.map(({ childId, child }) => {
          const latestTurn = this.store.listTurns(childId).at(-1)
          return {
            nickname: child?.agentNickname ?? childId.slice(-12),
            role: child?.agentRole ?? 'subagent',
            status: latestTurn?.status ?? child?.status.type ?? 'unknown',
          }
        })
        const task = command?.type === 'run' ? command.prompt : prompt || workflow?.preview || ''
        return { turn, prompt: task, agents }
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
    let hasTextOutput = false
    const noticesSeen = new Set<string>()
    const commandOutputSeen = new Set<string>()
    // Hook runs by Claude's hook id, and the settings file each hook event
    // was traced to (read once per turn).
    const hookRuns = new Map<string, { summary: Record<string, unknown>; startedAtMs: number }>()
    const hookSources = new Map<string, ReturnType<typeof claudeHookSource>>()
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
    // Tool items still waiting for their tool_result. A turn that ends first
    // (interrupt, error, watchdog) drops the late result, so these are closed
    // as failed before the turn completes.
    const openToolItems = new Set<string>()
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
    // Plan mode (turnStart resolved the flag): Claude runs with
    // permissionMode 'plan', explores read-only and hands its finished plan
    // to ExitPlanMode. The runtime reports that plan as a `proposed_plan`
    // event, which becomes the turn's Codex `plan` item; what Claude says
    // around it stays an agent message, so the turn has one plan card.
    const planMode = params.planMode === true
    let planItemId: string | null = null
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
        summary: [],
        content: [''],
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return reasoningItemId
    }
    const completeReasoningItem = (): void => {
      if (!reasoningItemId) return
      const item = this.store.getTurn(turn.id)?.items.find((item) => item.id === reasoningItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      reasoningItemId = null
    }
    const completeAgentItem = (phase: 'commentary' | 'final_answer'): void => {
      if (!agentItemId) return
      // Visualize lines get their marks here and not in the deltas: the App
      // shows the completed text in place of what streamed.
      // App rule: visualize-line
      const updated = this.store.updateItem(turn.id, agentItemId, (item) =>
        item.type === 'agentMessage'
          ? { ...item, phase, text: markVisualizeLines(item.text) }
          : item,
      )
      const item = updated?.items.find((item) => item.id === agentItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      agentItemId = null
    }
    const completeMessage = (phase: 'commentary' | 'final_answer' = 'commentary'): void => {
      completeReasoningItem()
      completeAgentItem(phase)
    }
    // App rule: plan-implementation
    // When the turn completes, the App offers to implement its last `plan`
    // item. A plan Claude revises within the turn replaces the card.
    const deliverPlan = (text: string): void => {
      completeMessage()
      if (planItemId) {
        const updated = this.store.updateItem(turn.id, planItemId, (item) =>
          item.type === 'plan' ? { ...item, text } : item,
        )
        const item = updated?.items.find((item) => item.id === planItemId)
        if (item)
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
          })
        return
      }
      planItemId = newId()
      const item: ThreadItem = { type: 'plan', id: planItemId, text }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: { ...item, text: '' },
          startedAtMs: nowMillis(),
        },
      })
      this.notify(peer, {
        method: 'item/plan/delta',
        params: { threadId: thread.id, turnId: turn.id, itemId: planItemId, delta: text },
      })
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
      })
    }
    const completeOpenToolItems = (message: string): void => {
      for (const itemId of openToolItems) {
        const started = itemStartedAtMs.get(itemId)
        const durationMs = started == null ? null : Math.max(0, nowMillis() - started)
        const updated = this.store.updateItem(turn.id, itemId, (item) => {
          if (item.type === 'commandExecution') return { ...item, status: 'failed', durationMs }
          if (item.type === 'fileChange') return { ...item, status: 'failed' }
          if (item.type === 'mcpToolCall')
            return { ...item, status: 'failed', error: { message }, durationMs }
          return item
        })
        const item = updated?.items.find((candidate) => candidate.id === itemId)
        if (item)
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
          })
      }
      openToolItems.clear()
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
    const turnPurpose = params.outputSchema == null ? 'normal' : 'summary'
    const continuation = params._continuation === true
    // A turn Claude starts on its own inherits the last user turn's policy,
    // model and instructions.
    if (turnPurpose === 'normal' && !continuation && params._hiddenPrompt == null) {
      const { _imageInputs: _images, _emitUserMessage: _emit, ...rest } = params
      this.lastTurnParamsByThread.set(thread.id, rest)
    }
    const desktopPresentation = turnPurpose === 'normal' && thread.runtimeBackend !== 'codex'
    const appSkills = this.appSkillsFor(desktopPresentation ? thread.id : null)
    // Codex reads AGENTS.md itself; Claude gets it, and the Claude Code files
    // its CLI skips, in the prompt.
    const instructions = desktopPresentation ? projectInstructions(thread.cwd).prompt : null
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
        const parentSkills = this.appSkillsFor(desktopPresentation ? thread.forkedFromId : null)
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions: parentThread?.baseInstructions ?? baseInstructions,
          developerInstructions: parentDev,
          personality: parentThread?.personality ?? personality,
          desktopPresentation,
          projectInstructions: instructions,
          ...parentSkills,
        })
        // The parent's prompt names the parent's visualization directory.
        const sideInstructions = [developerInstructions]
        if (parentSkills.visualizationDir && appSkills.visualizationDir)
          sideInstructions.push(visualizationDirNote(appSkills.visualizationDir))
        effectivePrompt = `<side-conversation-instructions>\n${sideInstructions.join('\n\n')}\n</side-conversation-instructions>\n\n${prompt}`
      } else {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions,
          developerInstructions,
          personality,
          desktopPresentation,
          projectInstructions: instructions,
          ...appSkills,
        })
      }
    } else {
      systemPromptAddendum = buildSystemPromptAddendum({
        baseInstructions,
        developerInstructions,
        personality,
        desktopPresentation,
        projectInstructions: instructions,
        ...appSkills,
      })
    }

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
    this.closeStreamingItemsByTurn.set(turn.id, () => {
      completeMessage()
      completeOpenToolItems('Interrupted by the user.')
    })
    this.flushQueuedSubagentActivity(peer, thread.id, turn.id)
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
      !this.stopped &&
      acceptRuntimeEvents &&
      this.store.getTurn(turn.id)?.status === 'inProgress' &&
      this.activeTurnByThread.get(thread.id) === turn.id
    // Set after a rewind or fork: this turn resumes the session only up to a
    // checkpoint. It stays pending until Claude starts the forked session.
    const resumeSessionAt = isCodexThread ? null : this.store.claudeResumeAt(thread.id)
    let resumedAtCheckpoint = false
    const turnCwd = stringOr(params.cwd, thread.cwd)
    // A Claude thread's own turns also get the MCP servers, subagents,
    // permission rules and hooks the Codex and Claude Code configs bring.
    const inheritConfig = desktopPresentation && !isCodexThread
    const mcp = readMcpConfig({ cwd: turnCwd, inherit: inheritConfig })
    const permissionRules = inheritConfig ? inheritedPermissionRules(turnCwd) : null
    const runtimeTurn = this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        purpose: turnPurpose,
        prompt: effectivePrompt,
        cwd: turnCwd,
        runtimeType: isCodexThread ? 'codex-proxy' : null,
        model: resolvedModel,
        effort: resolvedEffort,
        claudeSessionId: isCodexThread ? thread.codexSessionId : thread.claudeSessionId,
        forkSession,
        resumeSessionAt,
        // createdAt is in whole seconds: the history a fork copies from its
        // parent is older than the second after it.
        forkedAt:
          !isCodexThread && thread.forkedFromId != null ? (thread.createdAt + 1) * 1000 : null,
        mcpServers: mcp.sdkValue,
        allowedTools: defaultAllowedTools(),
        inheritedAllowedTools: permissionRules?.allow ?? null,
        inheritedAskRules: permissionRules?.ask ?? null,
        disallowedTools: [...mcp.toolRules.disallowedTools, ...(permissionRules?.deny ?? [])],
        mcpEnabledTools: mcp.toolRules.enabledTools,
        agents: inheritConfig ? inheritedAgents(turnCwd) : null,
        claudeHooks: inheritConfig ? inheritedHooks(turnCwd) : null,
        addDirs: stringListFromEnv('CLAUDE_CODEX_ADD_DIRS', []),
        enableFileCheckpointing: process.env.CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING === '1',
        outputFormat: claudeOutputFormat(params.outputSchema),
        approvalPolicy,
        sandboxMode,
        systemPromptAddendum,
        readableRoots: [
          ...appSkills.appSkills.map((skill) => dirname(skill.path)),
          ...(appSkills.visualizationDir ? [appSkills.visualizationDir] : []),
        ],
        planMode,
        imageInputs: Array.isArray(params._imageInputs)
          ? (params._imageInputs as ImageInput[])
          : [],
        goalTools:
          turnPurpose === 'normal' &&
          !isCodexThread &&
          !thread.ephemeral &&
          process.env.CLAUDE_CODEX_GOAL_TOOLS !== '0'
            ? this.goalToolsFor(thread.id)
            : null,
        ...(continuation ? { continuation: true } : {}),
      },
      {
        onEvent: async (event) => {
          // Interrupts, watchdog expiry, and a peer reconnect can leave a few
          // SDK messages queued after the server has terminalized the turn.
          // They are stale and must never resurrect a child or an inProgress
          // item in the Codex App.
          // Checkpoints are the exception: whatever Claude wrote last, even
          // after an interrupt, is where a rewind to this turn must resume.
          if (event.type === 'checkpoint') {
            this.store.setTurnCheckpoint(turn.id, {
              sessionId: event.claudeSessionId,
              messageUuid: event.messageUuid,
            })
            return
          }
          if (!turnIsActive()) return
          if (event.type === 'session') {
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            if (resumeSessionAt) {
              this.store.clearClaudeResumeAt(thread.id)
              resumedAtCheckpoint = true
            }
            return
          }
          if (activeSubagents.size > 0 && !this.runtime.filtersNestedEvents?.(thread.id)) {
            if (
              event.type === 'text_delta' ||
              event.type === 'reasoning_delta' ||
              event.type === 'message_boundary'
            )
              return
            if (event.type === 'tool_use' && !isSubagentToolName(event.toolName)) return
            if (event.type === 'tool_output_delta' && !itemIds.has(event.toolUseId)) return
            if (
              event.type === 'tool_result' &&
              !activeSubagents.has(event.toolUseId) &&
              !itemIds.has(event.toolUseId) &&
              !this.pendingAgentCalls.has(event.toolUseId)
            )
              return
          }
          if (event.type === 'message_boundary') {
            completeMessage()
            return
          }
          if (event.type === 'tool_use' && !itemIds.has(event.toolUseId)) completeMessage()
          if (
            event.type === 'tool_use' &&
            ((event.toolName === 'SendMessage' &&
              this.beginSubagentSendInput(peer, thread, turn, event.toolUseId, event.input)) ||
              (event.toolName === 'TaskStop' &&
                this.beginSubagentClose(peer, thread, turn, event.toolUseId, event.input)))
          )
            return
          if (event.type === 'tool_result' && this.pendingAgentCalls.has(event.toolUseId)) {
            this.finishSubagentCall(peer, thread, turn, event)
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
            const childThreadId = newThreadId()
            // The id's random tail: its head is a timestamp, shared by agents
            // spawned in the same millisecond.
            const agentNickname = `agent-${childThreadId.replace(/-/g, '').slice(-12)}`
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
            // The bundled Codex App client creates a child conversation from
            // thread/started with an empty turn and treats the history as
            // loaded while the child is live. Replay the persisted prompt as
            // a normal item lifecycle so the child page has its Prompt even
            // when it is opened before the first response token arrives.
            // App rule: child-prompt
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
            // A run_in_background agent has nothing waiting on it (Codex only
            // waits when asked), and a wait it could never close would stay
            // inProgress in the App, so it gets none.
            if (event.input.run_in_background !== true) {
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
            }

            itemIds.set(event.toolUseId, waitId)
            subagentContexts.set(event.toolUseId, subagentContext)
            activeSubagents.add(event.toolUseId)
            armWatchdog()
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
            if (!ctx) return
            if (!event.isError && isAsyncAgentLaunch(event.structured, event.content)) {
              // Claude backgrounded the agent: the call returned, the child
              // did not. It completes on its task notification instead.
              this.backgroundSubagent(peer, thread, turn, event.toolUseId, ctx, event.structured)
              activeSubagents.delete(event.toolUseId)
              subagentContexts.delete(event.toolUseId)
              itemIds.delete(event.toolUseId)
              if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
              return
            }
            const rawResultText = toolResultText(event.content)
            const stopped = ctx.stoppedByUser === true
            const collabStatus: 'completed' | 'failed' =
              event.isError && !stopped ? 'failed' : 'completed'
            const agentStatus: 'completed' | 'errored' | 'interrupted' = stopped
              ? 'interrupted'
              : event.isError
                ? 'errored'
                : 'completed'

            // claude-agent-sdk's Task tool appends a metadata trailer to the
            // result content: an `agentId: <hex>` line + a `<usage>...</usage>`
            // block. Codex App doesn't render those — they just leak as raw
            // text. Strip them from the visible body and route the metadata
            // into the proper protocol fields (agentNickname / tokenUsage /
            // metrics) so the subagent timeline carries the same identity +
            // usage the SDK reports.
            const parsed = parseSubagentTrailer(rawResultText)
            const resultText = parsed.cleanText

            // A child the user stopped already ended as interrupted.
            const childTurn =
              (stopped ? this.store.getTurn(ctx.childTurnId) : null) ??
              this.completeSubagentChildTurn(
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
            // native V2. emitSubagentActivity records it either way and only
            // sends `completed` to clients that render it; the wait terminal
            // snapshot is sufficient for legacy reducers.
            this.emitSubagentActivity(
              peer,
              thread.id,
              turn.id,
              ctx,
              event.isError || stopped ? 'interrupted' : 'completed',
            )

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
              this.recordTokenUsage(
                peer,
                thread.id,
                turn.id,
                { output_tokens: parsed.usage.totalTokens },
                { child: true },
              )
            }

            // Stage 2 close — wait (end). Re-emits the same waitItemId.
            // The App marks every working agent done on a *completed* wait,
            // so while another agent of this thread still runs (a background
            // agent, or a sibling launched in the same message) the wait
            // closes failed instead. The App never renders a wait, and this
            // child's own agentsStates still carries its real outcome.
            // App rule: completed-wait
            const siblingRunning =
              [...activeSubagents].some((id) => id !== event.toolUseId) ||
              this.hasRunningBackgroundSubagent(thread.id)
            const waitEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: ctx.waitItemId,
              tool: 'wait',
              status: siblingRunning ? 'failed' : collabStatus,
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

            // Codex App 26.x does not advertise the terminal
            // subAgentActivity kind. For a successful child, wait/completed
            // is already the terminal display state; appending closeAgent
            // makes the bundled client hide the finished child. Keep the
            // legacy closeAgent cleanup only for failed results.
            // App rule: subagent-close-hides
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
              // History keeps it, marked, for a legacy App reading the thread
              // back: an App with the completed kind hides the child if it
              // reads it.
              this.store.appendItem(turn.id, { ...closeBegin, legacyOnly: true })
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
              this.store.updateItem(turn.id, closeId, () => ({ ...closeEnd, legacyOnly: true }))
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
            if (event.delta.length === 0) return
            completeReasoningItem()
            hasTextOutput = true
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
            completeAgentItem('commentary')
            const itemId = ensureReasoningItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'reasoning') {
                return {
                  ...item,
                  content: [(item.content[0] ?? '') + event.delta],
                }
              }
              return item
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
            // In plan mode ExitPlanMode is the plan card (see deliverPlan),
            // not a tool call.
            if (planMode && event.toolName === 'ExitPlanMode') {
              itemIds.set(event.toolUseId, '')
              return
            }
            const item = this.toolUseToItem(event, thread.cwd)
            itemIds.set(event.toolUseId, item.id)
            itemStartedAtMs.set(item.id, nowMillis())
            openToolItems.add(item.id)
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
            openToolItems.delete(itemId)
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
            if (this.stopped || this.store.getTurn(turn.id)?.status !== 'inProgress') return
            if (diff) {
              this.store.updateTurnDiff(turn.id, diff)
              this.notify(peer, {
                method: 'turn/diff/updated',
                params: { threadId: thread.id, turnId: turn.id, diff },
              })
            }
            return
          }
          if (event.type === 'proposed_plan') {
            if (event.text.trim()) deliverPlan(event.text)
            return
          }
          if (event.type === 'notice') {
            debugLog('turn.runtime.notice', { threadId: thread.id, turnId: turn.id, ...event })
            // Runtime status is not assistant prose. Keep genuine warnings
            // visible in the native warning surface without breaking Markdown.
            if (event.level !== 'info' && !noticesSeen.has(event.message)) {
              noticesSeen.add(event.message)
              this.notify(peer, {
                method: 'warning',
                params: { threadId: thread.id, message: event.message },
              })
            }
            return
          }
          if (event.type === 'usage') {
            this.recordTokenUsage(peer, thread.id, turn.id, event.usage, {
              contextWindow: event.contextWindow ?? null,
              child: event.child === true,
            })
            return
          }
          if (event.type === 'usage_progress') {
            this.recordUsageProgress(thread.id, event.messageId, event.usage)
            return
          }
          if (event.type === 'hook_run') {
            // Codex reports hook runs as hook/started + hook/completed, which
            // the App folds into the turn's hook summary rather than the
            // transcript. Claude events Codex has no name for are dropped,
            // as in hooks/list.
            const eventName = codexHookEventName(event.hookEvent)
            if (!eventName) return
            let run = hookRuns.get(event.hookId)
            if (!run) {
              let located = hookSources.get(event.hookEvent)
              if (!located) {
                located = claudeHookSource(thread.cwd, event.hookEvent)
                hookSources.set(event.hookEvent, located)
              }
              run = {
                summary: {
                  id: event.hookId,
                  eventName,
                  handlerType: 'command',
                  executionMode: 'sync',
                  scope:
                    eventName === 'sessionStart' || eventName === 'sessionEnd' ? 'thread' : 'turn',
                  ...located,
                  displayOrder: hookRuns.size,
                  startedAt: nowSeconds(),
                },
                startedAtMs: nowMillis(),
              }
              hookRuns.set(event.hookId, run)
            }
            const done = event.status !== 'running'
            this.notify(peer, {
              method: done ? 'hook/completed' : 'hook/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                run: {
                  ...run.summary,
                  status: event.status,
                  statusMessage: null,
                  entries: event.entries,
                  completedAt: done ? nowSeconds() : null,
                  durationMs: done ? Math.max(0, nowMillis() - run.startedAtMs) : null,
                },
              },
            })
            return
          }
          if (event.type === 'model_rerouted') {
            debugLog('turn.runtime.model_rerouted', {
              threadId: thread.id,
              turnId: turn.id,
              ...event,
            })
            // The App only draws Codex's one reroute reason, a cyber-safety
            // reroute; any other fallback is a plain warning.
            if (event.category === 'cyber') {
              this.notify(peer, {
                method: 'model/rerouted',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  fromModel: event.fromModel,
                  toModel: event.toModel,
                  reason: 'highRiskCyberActivity',
                },
              })
            } else {
              this.notify(peer, {
                method: 'warning',
                params: { threadId: thread.id, message: event.message },
              })
            }
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
          completeMessage()
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
            openToolItems.add(item.id)
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
          completeMessage()
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
        onElicitationRequest: async (request, signal) => {
          if (!turnIsActive()) return { action: 'cancel' }
          completeMessage()
          return this.requestElicitation(peer, thread.id, turn.id, request, signal)
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
    // stop() has already settled this turn and closes SQLite once the runtime
    // stops, so a turn that winds down after that has nothing left to record.
    if (this.stopped) return
    if (
      outcome.kind !== 'resolved' &&
      resumeSessionAt &&
      !resumedAtCheckpoint &&
      this.store.getTurn(turn.id)?.status === 'inProgress'
    ) {
      // Claude exits before starting a session when it cannot resume at the
      // checkpoint (its transcript was edited or removed). Give the rewind up
      // so the thread's next turn resumes the whole session instead.
      this.store.clearClaudeResumeAt(thread.id)
      debugLog('thread.rewind.dropped', {
        threadId: thread.id,
        turnId: turn.id,
        resumeSessionAt,
        error: outcome.kind === 'rejected' ? outcome.error.message : 'timeout',
      })
    }
    if (outcome.kind === 'timeout') {
      const timeoutSeconds = Math.ceil(watchdogTimeoutMs / 1000)
      const timeoutUnit = timeoutSeconds === 1 ? 'second' : 'seconds'
      const message = `Subagent did not publish a terminal result within ${timeoutSeconds} ${timeoutUnit}.`
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        completeMessage()
        completeOpenToolItems(message)
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
        completeMessage()
        completeOpenToolItems(outcome.error.message)
        this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
      }
      this.subagentStateByTurn.delete(turn.id)
      throw outcome.error
    }
    if (this.store.getTurn(turn.id)?.status === 'inProgress') {
      completeOpenToolItems('Claude finished the turn without a result for this tool.')
      this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
    }
    this.subagentStateByTurn.delete(turn.id)
    const currentTurn = this.store.getTurn(turn.id)
    if (currentTurn && currentTurn.status !== 'inProgress') return

    const finalDiff = await gitDiff(thread.cwd)
    if (this.stopped || this.store.getTurn(turn.id)?.status !== 'inProgress') return
    if (finalDiff) {
      this.store.updateTurnDiff(turn.id, finalDiff)
      this.notify(peer, {
        method: 'turn/diff/updated',
        params: { threadId: thread.id, turnId: turn.id, diff: finalDiff },
      })
    }
    if (params.outputSchema != null && !hasTextOutput) {
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
    // App rule: quiet-turn-heartbeat
    this.quietTurnIfWorkRuns(peer, thread, turn.id, params, agentItemId)
    completeMessage('final_answer')
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
    // Codex runs the config's notify program for its own threads' turns.
    if (params.outputSchema == null && thread.runtimeBackend !== 'codex' && !thread.ephemeral)
      this.notifyTurnComplete(peer, thread, completed, turnCwd)
    // A plan-mode plan is a `plan` item (see deliverPlan); turn/plan/updated
    // is reserved for the update_plan/TodoWrite checklist tool (see the
    // tool_use handler), matching the real app-server which keeps those two
    // surfaces separate.
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
  }

  // Runs the Codex config's notify program for a completed turn.
  private notifyTurnComplete(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    cwd: string,
  ): void {
    const inputMessages = turn.items
      .map((item) => (item.type === 'userMessage' ? textFromInput(item.content) : ''))
      .filter(Boolean)
    const answer = turn.items.findLast((item) => item.type === 'agentMessage' && item.text !== '')
    runCodexNotify({
      threadId: thread.id,
      turnId: turn.id,
      cwd,
      client: this.peerFeatures.get(peer)?.clientName ?? null,
      inputMessages,
      lastAssistantMessage: answer?.type === 'agentMessage' ? answer.text : null,
    })
  }

  private completeSubagentChildTurn(
    peer: RpcPeer,
    context: SubagentContext,
    resultText: string,
    status: 'completed' | 'failed' | 'interrupted',
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

    // App rule: visualize-line
    const completedItem: ThreadItem = { ...startedItem, text: markVisualizeLines(resultText) }
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
    kind: SubagentActivityKind,
  ): void {
    const item: ThreadItem = {
      type: 'subAgentActivity',
      id: newId(),
      kind,
      agentThreadId: context.childThreadId,
      agentPath: context.agentPath,
    }
    // History keeps every kind so a reload shows the cards the App saw live;
    // historyForPeer hides the ones a legacy client was never sent.
    this.store.appendItem(parentTurnId, item)
    // Codex App 26.818 treats a started marker as liveness but has no
    // terminal kind besides interrupted, so it only ever gets that one.
    // App rule: subagent-completed-kind
    if (!this.supportsCompletedSubagentActivity(peer) && kind !== 'interrupted') return
    this.emitItemLifecycle(peer, parentThreadId, parentTurnId, item)
  }

  // Reads replay history, and each client gets only the items it would have
  // been sent live. One that predates the started/completed activity kinds
  // gets neither kind, and only such a client gets the closeAgent kept for it.
  // Every client gets agent messages with their visualize lines marked.
  private historyForPeer(peer: RpcPeer, result: unknown): unknown {
    const current = this.supportsCompletedSubagentActivity(peer)
    const sentLive = (item: unknown): boolean => {
      const record = asRecord(item)
      if (record.legacyOnly === true) return !current
      return current || record.type !== 'subAgentActivity' || record.kind === 'interrupted'
    }
    const unmarked = (item: unknown): unknown => {
      if (asRecord(item).legacyOnly !== true) return item
      const { legacyOnly: _mark, ...rest } = asRecord(item)
      return rest
    }
    // Replies stored before the adapter marked their visualize lines render
    // as well.
    // App rule: visualize-line
    const withVisualizeMarks = (item: unknown): unknown => {
      const record = asRecord(item)
      if (record.type !== 'agentMessage' || typeof record.text !== 'string') return item
      const text = markVisualizeLines(record.text)
      return text === record.text ? item : { ...record, text }
    }
    const itemForPeer = (item: unknown): unknown => withVisualizeMarks(unmarked(item))
    const turnForPeer = (turn: unknown): unknown => {
      const record = asRecord(turn)
      return Array.isArray(record.items)
        ? { ...record, items: record.items.filter(sentLive).map(itemForPeer) }
        : turn
    }
    const entryForPeer = (entry: unknown): unknown => {
      const fields = asRecord(entry)
      if ('items' in fields) return turnForPeer(entry)
      return 'item' in fields ? { ...fields, item: itemForPeer(fields.item) } : itemForPeer(entry)
    }
    const record = asRecord(result)
    const thread = asRecord(record.thread)
    if (Array.isArray(thread.turns))
      return { ...record, thread: { ...thread, turns: thread.turns.map(turnForPeer) } }
    if (Array.isArray(record.data))
      return {
        ...record,
        data: record.data
          .filter((entry) => {
            const fields = asRecord(entry)
            // Turns, items/list entries, timeline entries.
            return 'items' in fields || sentLive('item' in fields ? fields.item : entry)
          })
          .map(entryForPeer),
      }
    return result
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
    status: 'failed' | 'interrupted' = 'failed',
  ): void {
    // The App shows an interrupted agent as done and an errored one as failed.
    // App rule: agent-states
    const agentState = status === 'interrupted' ? 'interrupted' : 'errored'
    for (const toolUseId of Array.from(active)) {
      const context = contexts.get(toolUseId)
      active.delete(toolUseId)
      contexts.delete(toolUseId)
      if (!context) continue

      const message = failureMessage
      const childTurn = this.completeSubagentChildTurn(
        peer,
        context,
        message,
        status,
        status === 'failed' ? { message } : null,
      )
      recordRunEvent('subagent.completed', {
        parentThreadId: thread.id,
        parentTurnId: turn.id,
        childThreadId: context.childThreadId,
        childTurnId: childTurn.id,
        status,
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
        agentsStates: { [context.childThreadId]: { status: agentState, message } },
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
        // Marked like the closeAgent of a failed child result above.
        // App rule: subagent-close-hides
        this.store.appendItem(turn.id, { ...closeBegin, legacyOnly: true })
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
          agentsStates: { [context.childThreadId]: { status: agentState, message } },
        }
        this.store.updateItem(turn.id, closeId, () => ({ ...closeEnd, legacyOnly: true }))
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

  private peerForThread(threadId: string): RpcPeer {
    return this.peerForParams(DETACHED_PEER, { threadId })
  }

  private backgroundSubagent(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    toolUseId: string,
    context: SubagentContext,
    structured: Record<string, unknown> | null | undefined,
  ): void {
    // Claude backgrounded the agent after the wait began, so nothing waits on
    // it any more. Close the wait without completing it: the App marks every
    // working agent done on a *completed* wait, while a failed one keeps the
    // child's own state (still running) and leaves no open item behind.
    // App rule: completed-wait
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
      agentsStates: { [context.childThreadId]: { status: 'running', message: null } },
    }
    const updated = this.store.updateItem(turn.id, context.waitItemId, () => waitEnd)
    if (updated?.items.some((item) => item.id === context.waitItemId))
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId: thread.id, turnId: turn.id, item: waitEnd, completedAtMs: nowMillis() },
      })
    const agentId =
      typeof structured?.agentId === 'string' && structured.agentId ? structured.agentId : null
    const taskId = this.taskIdByToolUse.get(toolUseId) ?? null
    this.taskIdByToolUse.delete(toolUseId)
    this.backgroundSubagents.set(context.childThreadId, {
      parentThreadId: thread.id,
      parentTurnId: turn.id,
      toolUseId,
      taskId,
      agentId,
      context,
      running: true,
    })
    const childThread = this.store.getThread(context.childThreadId)
    if (childThread && agentId) {
      // SendMessage addresses the agent by this id.
      childThread.agentNickname = agentId
      childThread.updatedAt = nowSeconds()
      this.store.upsertThread(childThread)
    }
    recordRunEvent('subagent.backgrounded', {
      parentThreadId: thread.id,
      parentTurnId: turn.id,
      childThreadId: context.childThreadId,
      taskId,
      agentId,
    })
  }

  private findBackgroundSubagent(
    parentThreadId: string,
    match: { taskId?: string | null; toolUseId?: string | null; agentId?: string | null },
  ): BackgroundSubagent | null {
    for (const entry of this.backgroundSubagents.values()) {
      if (entry.parentThreadId !== parentThreadId) continue
      if (match.taskId && (entry.taskId === match.taskId || entry.agentId === match.taskId))
        return entry
      if (match.toolUseId && entry.toolUseId === match.toolUseId) return entry
      if (match.agentId) {
        const nickname = this.store.getThread(entry.context.childThreadId)?.agentNickname
        if (entry.agentId === match.agentId || nickname === match.agentId) return entry
      }
    }
    return null
  }

  // A child that ran in the foreground, or before a restart, has no entry,
  // yet SendMessage resumes it all the same: the CLI runs it on in the
  // background. Track it from then on like any background agent.
  private adoptChildAgent(
    thread: ThreadRecord,
    turnId: string,
    agentId: string,
  ): BackgroundSubagent | null {
    const child = this.store
      .listThreads({ includeEphemeral: true, parentThreadId: thread.id, limit: 200 })
      .find((candidate) => candidate.agentNickname === agentId)
    // A child still inside its Agent call is not this one's to take over.
    if (!child || this.store.lastTurnStatus(child.id) === 'inProgress') return null
    const parentItems = this.store.listTurns(thread.id).flatMap((parentTurn) => parentTurn.items)
    const marker = parentItems.find(
      (item) => item.type === 'subAgentActivity' && item.agentThreadId === child.id,
    )
    const entry: BackgroundSubagent = {
      parentThreadId: thread.id,
      parentTurnId: turnId,
      toolUseId: '',
      taskId: null,
      agentId,
      context: {
        childThreadId: child.id,
        childTurnId: this.store.listTurns(child.id).at(-1)?.id ?? '',
        waitItemId: newId(),
        agentPath:
          marker?.type === 'subAgentActivity' && typeof marker.agentPath === 'string'
            ? marker.agentPath
            : `/root/${agentId}`,
        prompt: '',
        subType: child.agentRole,
      },
      running: false,
    }
    this.backgroundSubagents.set(child.id, entry)
    return entry
  }

  private rememberTaskId(toolUseId: string, taskId: string): void {
    this.taskIdByToolUse.set(toolUseId, taskId)
    // Foreground agents report task_started too but never claim theirs.
    if (this.taskIdByToolUse.size > MAX_TRACKED_TASK_IDS) {
      const oldest = this.taskIdByToolUse.keys().next().value
      if (oldest !== undefined) this.taskIdByToolUse.delete(oldest)
    }
  }

  private handleTaskEvent(threadId: string, event: RuntimeTaskEvent): void {
    if (event.type === 'task_started') {
      if (!event.toolUseId) return
      const entry = this.findBackgroundSubagent(threadId, { toolUseId: event.toolUseId })
      if (entry) entry.taskId = event.taskId
      else this.rememberTaskId(event.toolUseId, event.taskId)
      return
    }
    const entry = this.findBackgroundSubagent(threadId, {
      taskId: event.taskId,
      toolUseId: event.type === 'task_updated' ? null : event.toolUseId,
    })
    if (!entry?.running) return
    switch (event.type) {
      case 'task_progress':
        if (event.usage) this.publishChildTokenUsage(entry, event.usage)
        return
      case 'task_updated':
        if (event.status === 'paused')
          this.settleBackgroundSubagent(
            entry,
            'interrupted',
            'Parked; send it a message to resume.',
            null,
          )
        return
      case 'task_notification':
        this.settleBackgroundSubagent(
          entry,
          event.status === 'stopped' ? 'interrupted' : event.status,
          event.result ?? event.summary,
          event.usage,
        )
        return
    }
  }

  private publishChildTokenUsage(entry: BackgroundSubagent, usage: RuntimeTaskUsage): void {
    if (!usage.totalTokens) return
    const breakdown: TokenUsageBreakdown = {
      totalTokens: usage.totalTokens,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: usage.totalTokens,
      reasoningOutputTokens: 0,
    }
    const tokenUsage: ThreadTokenUsage = {
      total: breakdown,
      last: breakdown,
      modelContextWindow: null,
    }
    const { childThreadId, childTurnId } = entry.context
    this.notify(this.peerForThread(childThreadId), {
      method: 'thread/tokenUsage/updated',
      params: { threadId: childThreadId, turnId: childTurnId, tokenUsage },
    })
  }

  private settleBackgroundSubagent(
    entry: BackgroundSubagent,
    status: 'completed' | 'failed' | 'interrupted',
    text: string,
    usage: RuntimeTaskUsage | null,
  ): void {
    if (!entry.running) return
    entry.running = false
    const { context } = entry
    if (this.store.getTurn(context.childTurnId)?.status === 'inProgress') {
      const childTurn = this.completeSubagentChildTurn(
        this.peerForThread(context.childThreadId),
        context,
        text,
        status,
        status === 'completed' ? null : { message: text },
        usage?.durationMs ?? null,
      )
      recordRunEvent('subagent.completed', {
        parentThreadId: entry.parentThreadId,
        parentTurnId: entry.parentTurnId,
        childThreadId: context.childThreadId,
        childTurnId: childTurn.id,
        status: childTurn.status,
        agentRole: context.subType ?? 'general-purpose',
        background: true,
      })
    }
    if (usage?.totalTokens) {
      this.publishChildTokenUsage(entry, usage)
      const parentTurnId = this.activeTurnByThread.get(entry.parentThreadId) ?? entry.parentTurnId
      this.recordTokenUsage(
        this.peerForThread(entry.parentThreadId),
        entry.parentThreadId,
        parentTurnId,
        { output_tokens: usage.totalTokens },
        { child: true },
      )
    }
    this.publishSubagentActivity(
      entry.parentThreadId,
      context,
      status === 'completed' ? 'completed' : 'interrupted',
    )
    this.idleCheckHandler?.()
  }

  // Subagent activity belongs to a parent turn. A background agent usually
  // reports after that turn ended; hold the item for the turn Claude starts
  // to answer it (or the user's next one).
  private publishSubagentActivity(
    parentThreadId: string,
    context: SubagentContext,
    kind: SubagentActivityKind,
  ): void {
    const turnId = this.activeTurnByThread.get(parentThreadId)
    if (turnId) {
      const peer = this.peerForThread(parentThreadId)
      this.emitSubagentActivity(peer, parentThreadId, turnId, context, kind)
      return
    }
    const queue = this.queuedSubagentActivity.get(parentThreadId) ?? []
    queue.push({ context, kind })
    this.queuedSubagentActivity.set(parentThreadId, queue.slice(-MAX_QUEUED_ACTIVITY))
  }

  private flushQueuedSubagentActivity(peer: RpcPeer, threadId: string, turnId: string): void {
    const queue = this.queuedSubagentActivity.get(threadId)
    if (!queue) return
    this.queuedSubagentActivity.delete(threadId)
    for (const { context, kind } of queue) {
      this.emitSubagentActivity(peer, threadId, turnId, context, kind)
    }
  }

  // SendMessage to one of the thread's agents is Codex's sendInput: render it
  // as the collab tool call and reopen the child conversation with the message.
  private beginSubagentSendInput(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    toolUseId: string,
    input: Record<string, unknown>,
  ): boolean {
    const to = typeof input.to === 'string' ? input.to : ''
    const entry = to
      ? (this.findBackgroundSubagent(thread.id, { agentId: to }) ??
        this.adoptChildAgent(thread, turn.id, to))
      : null
    if (!entry) return false
    const message =
      typeof input.message === 'string'
        ? input.message
        : typeof input.content === 'string'
          ? input.content
          : JSON.stringify(input.message ?? input)
    const item: ThreadItem = {
      type: 'collabAgentToolCall',
      id: newId(),
      tool: 'sendInput',
      status: 'inProgress',
      senderThreadId: thread.id,
      receiverThreadIds: [entry.context.childThreadId],
      prompt: message || null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    }
    this.store.appendItem(turn.id, item)
    this.notify(peer, {
      method: 'item/started',
      params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
    })
    this.pendingAgentCalls.set(toolUseId, {
      tool: 'sendInput',
      itemId: item.id,
      childThreadId: entry.context.childThreadId,
      message,
    })
    return true
  }

  // TaskStop on a background agent is Codex's closeAgent. The task
  // notification that follows settles the child as interrupted.
  private beginSubagentClose(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    toolUseId: string,
    input: Record<string, unknown>,
  ): boolean {
    const taskId = typeof input.task_id === 'string' ? input.task_id : ''
    const entry = taskId ? this.findBackgroundSubagent(thread.id, { taskId }) : null
    if (!entry) return false
    const item: ThreadItem = {
      type: 'collabAgentToolCall',
      id: newId(),
      tool: 'closeAgent',
      status: 'inProgress',
      senderThreadId: thread.id,
      receiverThreadIds: [entry.context.childThreadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    }
    this.store.appendItem(turn.id, item)
    this.notify(peer, {
      method: 'item/started',
      params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
    })
    this.pendingAgentCalls.set(toolUseId, {
      tool: 'closeAgent',
      itemId: item.id,
      childThreadId: entry.context.childThreadId,
      message: '',
    })
    return true
  }

  private finishSubagentCall(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    event: Extract<RuntimeEvent, { type: 'tool_result' }>,
  ): void {
    const pending = this.pendingAgentCalls.get(event.toolUseId)
    if (!pending) return
    this.pendingAgentCalls.delete(event.toolUseId)
    const ok = !event.isError
    const failure = { status: 'errored' as const, message: toolResultText(event.content) || null }
    const item: ThreadItem = {
      type: 'collabAgentToolCall',
      id: pending.itemId,
      tool: pending.tool,
      status: ok ? 'completed' : 'failed',
      senderThreadId: thread.id,
      receiverThreadIds: [pending.childThreadId],
      prompt: pending.message || null,
      model: null,
      reasoningEffort: null,
      // A stop that failed says nothing about the agent, which may well have
      // finished first.
      agentsStates:
        pending.tool === 'closeAgent'
          ? ok
            ? { [pending.childThreadId]: { status: 'interrupted', message: null } }
            : {}
          : { [pending.childThreadId]: ok ? { status: 'running', message: null } : failure },
    }
    this.store.updateItem(turn.id, pending.itemId, () => item)
    this.notify(peer, {
      method: 'item/completed',
      params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
    })
    const entry = this.backgroundSubagents.get(pending.childThreadId)
    if (!ok || !entry) return
    if (pending.tool === 'closeAgent') {
      // Settle now: a notification for a stop Claude asked for may never come.
      this.settleBackgroundSubagent(entry, 'interrupted', 'Stopped by the parent agent.', null)
      return
    }
    this.resumeBackgroundChild(entry, pending.message, event.toolUseId)
    this.emitSubagentActivity(peer, thread.id, turn.id, entry.context, 'interacted')
  }

  private resumeBackgroundChild(
    entry: BackgroundSubagent,
    message: string,
    sendToolUseId: string,
  ): void {
    const { context } = entry
    const peer = this.peerForThread(context.childThreadId)
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: newId(),
      content: [{ type: 'text', text: message, text_elements: [] }],
    }
    const childTurn = this.store.getTurn(context.childTurnId)
    if (childTurn?.status === 'inProgress') {
      // Still running: Claude queues the message for its next step.
      this.store.appendItem(childTurn.id, userItem)
      this.emitItemLifecycle(peer, context.childThreadId, childTurn.id, userItem)
    } else {
      const turn: TurnRecord = {
        id: newId(),
        threadId: context.childThreadId,
        status: 'inProgress',
        startedAt: nowSeconds(),
        completedAt: null,
        durationMs: null,
        items: [userItem],
        diff: '',
        error: null,
      }
      this.store.upsertTurn(turn)
      this.setThreadStatus(peer, context.childThreadId, { type: 'active', activeFlags: [] })
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId: context.childThreadId, turn: this.toLifecycleTurn(turn) },
      })
      this.emitItemLifecycle(peer, context.childThreadId, turn.id, userItem)
      entry.context = { ...context, childTurnId: turn.id, prompt: message }
    }
    entry.running = true
    entry.taskId = this.taskIdByToolUse.get(sendToolUseId) ?? entry.taskId
    this.taskIdByToolUse.delete(sendToolUseId)
  }

  private handleAutonomousTurn(threadId: string): void {
    if (this.activeTurnByThread.has(threadId)) {
      // The previous turn is still finalizing; start once it clears.
      this.pendingAutonomousTurns.add(threadId)
      return
    }
    this.startAutonomousTurn(threadId)
  }

  // Claude answers a background agent's report without a user prompt. Open
  // a parent turn for it the way Codex does for its own agent wakeups.
  private startAutonomousTurn(threadId: string): void {
    this.pendingAutonomousTurns.delete(threadId)
    // stop() may have closed the store since this was scheduled.
    if (this.stopped) return
    const thread = this.store.getThread(threadId)
    if (
      !thread ||
      this.activeTurnByThread.has(threadId) ||
      this.runtime.hasPendingContinuation?.(threadId) !== true
    ) {
      this.idleCheckHandler?.()
      return
    }
    const peer = this.peerForThread(threadId)
    const turn: TurnRecord = {
      id: newId(),
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId: turn.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: 'continuation',
    })
    this.activeTurnByThread.set(threadId, turn.id)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    this.notify(peer, {
      method: 'turn/started',
      params: { threadId, turn: this.toLifecycleTurn(turn) },
    })
    const params: Record<string, unknown> = {
      ...(this.lastTurnParamsByThread.get(threadId) ?? {}),
      threadId,
      planMode: false,
      outputSchema: null,
      _continuation: true,
    }
    this.launchRuntimeTurn(peer, thread, turn, '', params)
  }

  private handleSessionReleased(threadId: string, liveTaskIds: string[]): void {
    this.pendingAutonomousTurns.delete(threadId)
    debugLog('subagent.background.sessionReleased', { threadId, liveTaskIds })
    this.finalizeBackgroundSubagents(
      threadId,
      'Claude session ended before this agent reported back.',
    )
    this.idleCheckHandler?.()
  }

  private hasRunningBackgroundSubagent(parentThreadId: string): boolean {
    for (const entry of this.backgroundSubagents.values())
      if (entry.running && entry.parentThreadId === parentThreadId) return true
    return false
  }

  // A turn that leaves background agents or workflows running ends with the
  // App's DONT_NOTIFY heartbeat on its last agent message, so the unread dot
  // waits for the turn the work reports back in (background shells do not
  // count; see quietTurnReasons). The store keeps the block too:
  // thread/read then matches what the App was sent, and the App hides the
  // block in both. An open message gets it before its item/completed; one
  // that already completed (a tool call came after it) is completed again,
  // which the App takes as a replacement. No delta carries the block, as the
  // App shows a streaming message raw.
  // App rule: quiet-turn-heartbeat
  private quietTurnIfWorkRuns(
    peer: RpcPeer,
    thread: ThreadRecord,
    turnId: string,
    params: Record<string, unknown>,
    openItemId: string | null,
  ): void {
    const running = quietTurnReasons({
      enabled: quietBackgroundTurnsEnabled(),
      structured: params.outputSchema != null,
      subagentThread: thread.threadSource === 'subagent',
      backgroundAgentRunning: this.hasRunningBackgroundSubagent(thread.id),
      liveTasks: this.runtime.liveTasks?.(thread.id) ?? [],
    })
    if (running.length === 0) return
    // The App reads the turn's last agent message, whatever its phase.
    const last = this.store.getTurn(turnId)?.items.findLast((item) => item.type === 'agentMessage')
    const text = last?.type === 'agentMessage' ? withQuietTurnHeartbeat(last.text) : null
    debugLog('turn.quiet', { threadId: thread.id, turnId, running, marked: text != null })
    if (!last || text == null) return
    const updated = this.store.updateItem(turnId, last.id, (item) =>
      item.type === 'agentMessage' ? { ...item, text } : item,
    )
    if (last.id === openItemId) return
    const item = updated?.items.find((candidate) => candidate.id === last.id)
    if (item)
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId: thread.id, turnId, item, completedAtMs: nowMillis() },
      })
  }

  private finalizeBackgroundSubagents(threadId: string | null, message: string): void {
    for (const entry of this.backgroundSubagents.values()) {
      if (threadId != null && entry.parentThreadId !== threadId) continue
      this.settleBackgroundSubagent(entry, 'interrupted', message, null)
    }
  }

  private async stopBackgroundSubagent(entry: BackgroundSubagent): Promise<void> {
    const taskId = entry.taskId ?? entry.agentId
    const stopped = taskId
      ? await this.runtime.stopTask?.(entry.parentThreadId, taskId).catch(() => false)
      : false
    debugLog('subagent.background.stop', {
      parentThreadId: entry.parentThreadId,
      childThreadId: entry.context.childThreadId,
      taskId,
      stopped: stopped === true,
    })
    this.settleBackgroundSubagent(entry, 'interrupted', 'Stopped by the user.', null)
  }

  // Stops one foreground child of a running parent turn through its CLI task.
  // The parent's Agent call then returns and the parent keeps going.
  private async stopForegroundSubagent(peer: RpcPeer, childThreadId: string): Promise<boolean> {
    for (const state of this.subagentStateByTurn.values()) {
      for (const toolUseId of state.active) {
        const context = state.contexts.get(toolUseId)
        if (context?.childThreadId !== childThreadId || context.stoppedByUser) continue
        const taskId = this.taskIdByToolUse.get(toolUseId)
        const stopped = taskId
          ? await this.runtime.stopTask?.(state.thread.id, taskId).catch(() => false)
          : false
        debugLog('subagent.foreground.stop', {
          parentThreadId: state.thread.id,
          childThreadId,
          taskId: taskId ?? null,
          stopped: stopped === true,
        })
        // Without a task to stop, only the child's turn ends here; the CLI
        // still finishes the agent and its result replaces this state.
        if (stopped !== true) return false
        context.stoppedByUser = true
        this.completeSubagentChildTurn(peer, context, 'Stopped by the user.', 'interrupted', null)
        return true
      }
    }
    return false
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

  // MCP elicitation as Codex's mcpServer/elicitation/request. The App renders
  // a form from `requestedSchema`, or a button that opens an https `url`.
  private async requestElicitation(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResponse> {
    const requestId = newId()
    const base = { threadId, turnId, serverName: request.serverName, message: request.message }
    const params =
      request.mode === 'url'
        ? {
            ...base,
            mode: 'url',
            url: request.url,
            elicitationId: request.elicitationId ?? requestId,
          }
        : {
            ...base,
            mode: 'form',
            requestedSchema: { properties: {}, ...request.requestedSchema, type: 'object' },
          }
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: ['waitingOnUserInput'] })
    let response: unknown
    try {
      response = await this.sendServerRequest(
        peer,
        'mcpServer/elicitation/request',
        requestId,
        params,
        signal,
      )
    } catch {
      return { action: 'cancel' }
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
      this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    }
    const result = (response ?? {}) as Record<string, unknown>
    const action =
      result.action === 'accept' || result.action === 'decline' ? result.action : 'cancel'
    const content = result.content
    return action === 'accept' && content && typeof content === 'object' && !Array.isArray(content)
      ? { action, content: content as Record<string, unknown> }
      : { action }
  }

  private async turnInterrupt(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const requestedTurnId = stringOr(params.turnId, '')
    this.activePeerByThread.set(threadId, peer)
    // A background child has no runtime turn of its own; stop its task.
    const background = this.backgroundSubagents.get(threadId)
    if (background?.running) {
      await this.stopBackgroundSubagent(background)
      return {}
    }
    // Neither does a foreground child: it runs inside its parent's turn.
    if (await this.stopForegroundSubagent(peer, threadId)) return {}
    const activeTurnId = this.activeTurnByThread.get(threadId)
    const turnId = activeTurnId || requestedTurnId
    if (turnId) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        // Claude may still be streaming a message (a turn held open for its
        // workflow always is); the App needs it completed before the turn.
        this.closeStreamingItemsByTurn.get(turnId)?.()
        this.closeStreamingItemsByTurn.delete(turnId)
        const subagents = this.subagentStateByTurn.get(turnId)
        if (subagents) {
          this.finalizeOrphanedSubagents(
            peer,
            subagents.thread,
            subagents.turn,
            subagents.contexts,
            subagents.active,
            'Interrupted by the user.',
            'interrupted',
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
    this.pendingAutonomousTurns.delete(threadId)
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

  private async turnSteer(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const expectedTurnId = stringOr(params.expectedTurnId, '')
    const activeTurnId = this.activeTurnByThread.get(threadId)
    // Codex App matches these messages: "no active turn to steer" makes it
    // send the message as a new turn instead, and the mismatch text carries
    // the turn id it retries against.
    // App rule: steer-errors
    if (!activeTurnId) throw new Error('no active turn to steer')
    if (expectedTurnId && expectedTurnId !== activeTurnId)
      throw new Error(`expected active turn id \`${expectedTurnId}\` but found \`${activeTurnId}\``)
    const turn = this.store.getTurn(activeTurnId)
    if (
      turn?.items.some(
        (item) => item.type === 'enteredReviewMode' || item.type === 'contextCompaction',
      )
    )
      throw new Error('cannot steer a review or compaction turn')
    const input = turnInput(params)
    const { textPrompt, images } = extractImageInputs(input)
    // App rule: quiet-turn-heartbeat
    const prompt = stripQuietTurnHeartbeat(skillLinksToCommand(textPrompt || textFromInput(input)))
    if (!prompt.trim() && images.length === 0) throw new Error('steer input must not be empty')
    if (peer !== DETACHED_PEER) this.activePeerByThread.set(threadId, peer)
    const item = turnInputItem(params, input)
    // The message joins the turn once Claude takes it in (between tool
    // rounds). Publishing it then, with the App's clientUserMessageId, lets
    // the App settle its pending steering bubble into the transcript.
    // App rule: steer-bubble
    let accepted = false
    const accept = (): void => {
      if (accepted) return
      accepted = true
      if (this.store.getTurn(activeTurnId)?.status !== 'inProgress') return
      this.store.appendItem(activeTurnId, item)
      this.emitItemLifecycle(this.peerForThread(threadId), threadId, activeTurnId, item)
    }
    const steered = await this.steerRunningTurn(threadId, activeTurnId, prompt, {
      imageInputs: images,
      onAccepted: accept,
    })
    if (steered === false) throw new Error('no active turn to steer')
    if (steered === undefined) accept()
    return { turnId: activeTurnId }
  }

  // The runtime holds no turn for a running one for a moment while its
  // session comes up or the turn finishes; input waits that out. A turn whose
  // run has already returned will never end by itself. It is ended here, so
  // the input starts a new turn rather than being refused until the user
  // stops the thread.
  private async steerRunningTurn(
    threadId: string,
    turnId: string,
    prompt: string,
    options: RuntimeSteerOptions,
  ): Promise<boolean | undefined> {
    const deadline = Date.now() + STEER_WAIT_MS
    for (;;) {
      const steered = await this.runtime.steer(threadId, prompt, options)
      if (steered !== false || this.activeTurnByThread.get(threadId) !== turnId) return steered
      if (!this.runtimeRuns.has(turnId)) {
        this.endLostTurn(threadId, turnId)
        return false
      }
      if (Date.now() >= deadline) return false
      await sleep(STEER_RETRY_MS)
    }
  }

  private endLostTurn(threadId: string, turnId: string): void {
    debugLog('turn.lost', { threadId, turnId })
    const turn = this.store.getTurn(turnId)
    if (!turn) {
      this.clearActiveTurn(threadId)
      return
    }
    const error = new Error('Claude stopped working on this turn before it finished.')
    this.failTurn(this.peerForThread(threadId), threadId, turn, error)
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

  // Codex models have nowhere to run: CLAUDE_CODEX_DISABLE_CODEX_PROXY turned
  // Codex routing off, and no Codex proxy carries every thread.
  private codexRoutingDisabled(): boolean {
    return (
      process.env.CLAUDE_CODEX_DISABLE_CODEX_PROXY === '1' &&
      resolveProviderLoopSelection(this.providerLoopSelectionInput()).runtimeType !== 'codex-proxy'
    )
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
    source: { contextWindow?: number | null; child?: boolean } = {},
  ): void {
    const spent = tokenBreakdownFromClaudeUsage(usage)
    // A child's tokens add to the thread's total and its goal; they neither
    // settle the main loop's streamed progress nor fill its context window.
    const child = source.child === true
    const progress = child ? undefined : this.goalProgressByThread.get(threadId)
    const lastCall = child ? undefined : this.lastCallUsageByThread.get(threadId)
    if (!child) {
      this.goalProgressByThread.delete(threadId)
      this.lastCallUsageByThread.delete(threadId)
    }
    if (source.contextWindow) this.contextWindowByThread.set(threadId, source.contextWindow)
    if (spent.totalTokens === 0) return
    const prior = this.tokenUsageByThread.get(threadId) ?? emptyTokenBreakdown()
    const total: TokenUsageBreakdown = {
      totalTokens: prior.totalTokens + spent.totalTokens,
      inputTokens: prior.inputTokens + spent.inputTokens,
      cachedInputTokens: prior.cachedInputTokens + spent.cachedInputTokens,
      outputTokens: prior.outputTokens + spent.outputTokens,
      reasoningOutputTokens: prior.reasoningOutputTokens + spent.reasoningOutputTokens,
    }
    this.tokenUsageByThread.set(threadId, total)
    const measured = child ? this.lastUsageByThread.get(threadId) : lastCall
    if (!child) {
      if (lastCall) this.lastUsageByThread.set(threadId, lastCall)
      else this.lastUsageByThread.delete(threadId)
    }
    const tokenUsage: ThreadTokenUsage = {
      total,
      last: measured ?? (child ? emptyTokenBreakdown() : spent),
      // Only one call's usage measures the context; a whole turn's sum would
      // overfill the App's gauge.
      modelContextWindow: measured ? (this.contextWindowByThread.get(threadId) ?? null) : null,
    }
    this.notify(peer, {
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage },
    })
    // The result is authoritative; charge only what streaming did not. A
    // child that ends inside a running turn can still steer it to wrap up.
    const charged = [...(progress?.values() ?? [])].reduce((sum, tokens) => sum + tokens, 0)
    const midTurn = child && this.activeTurnByThread.get(threadId) === turnId
    this.accrueGoalTokens(threadId, spent.inputTokens + spent.outputTokens - charged, midTurn)
    // NOTE: previously we also pushed `account/rateLimits/updated` here on
    // every token-usage event "to keep the UI in sync". That backfired —
    // Codex App treats every such notification as a fresh rate-limit signal
    // and surfaces it as a transient warning banner, so the user saw a
    // rate-limit pop on every assistant turn. Since we don't actually have
    // real rate-limit data from the Anthropic SDK (no headers exposed), the
    // notification was empty noise. The initial snapshot still fires once
    // post-handshake in `initialize` so the UI populates on first connect.
    // App rule: rate-limit-banner
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

  // The Codex App skills Claude can run in a thread, and where the thread's
  // inline visualizations go. The App shows a thread's visualizations only
  // when its id is a UUIDv7, which threads from older adapters lack, so they
  // go without the visualize skill.
  private appSkillsFor(threadId: string | null): {
    appSkills: AppSkill[]
    visualizationDir: string | null
  } {
    if (threadId == null) return { appSkills: [], visualizationDir: null }
    const dir = threadVisualizationDir(threadId)
    const appSkills = appPluginSkills(this.appPlugins).filter(
      (skill) => dir != null || skill.plugin !== 'visualize',
    )
    const visualize = appSkills.some((skill) => skill.plugin === 'visualize')
    return { appSkills, visualizationDir: visualize ? dir : null }
  }

  // The App installs its bundled plugins each time it starts. Remember the
  // ones whose skills Claude can run, across restarts too, so that turns
  // started before the App gets to it list the same skills.
  // App rule: inline-visualizations
  private pluginInstall(params: Record<string, unknown>): unknown {
    const plugin = claudeRunnableAppPlugin(params.marketplacePath, params.pluginName)
    const known = this.appPlugins.find((candidate) => candidate.name === plugin?.name)
    if (plugin && known?.root !== plugin.root) {
      this.appPlugins = [...this.appPlugins.filter((candidate) => candidate !== known), plugin]
      this.persistConfig()
    }
    return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
  }

  private pluginUninstall(params: Record<string, unknown>): unknown {
    // Plugin ids read `<name>@<marketplace>`.
    const name = stringOr(params.pluginId, '').split('@')[0]
    const kept = this.appPlugins.filter((plugin) => plugin.name !== name)
    if (kept.length !== this.appPlugins.length) {
      this.appPlugins = kept
      this.persistConfig()
    }
    return {}
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
        // Required by the protocol. The App's composer reads
        // `appTemplates.length` unguarded, and without it a thread with the
        // in-app browser open fails to render.
        appTemplates: [],
        mcpServers: [],
        scheduledTasks: null,
        onboardingSkill: null,
        shareUrl: null,
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

  private threadEnvelope(thread: ThreadRecord, turns: TurnRecord[] = []): Record<string, unknown> {
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
      instructionSources:
        thread.runtimeBackend === 'codex' ? [] : projectInstructions(thread.cwd).sources,
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
      projectId: thread.projectId ?? null,
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
    const firstUser = turn.items.find(
      (item) => item.type === 'userMessage' || item.type === 'functionCallOutput',
    )
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

  // Shared state (skills, projects) changed: every connected peer hears it,
  // whichever thread the notification names.
  private notifyAll(notification: { method: string; params: unknown }): void {
    if (this.stopped) return
    debugLog('rpc.notify', {
      peerIds: [...this.peers.keys()],
      method: notification.method,
      params: summarizeRpcParams(notification.method, notification.params),
    })
    for (const peer of this.peers.values())
      peer.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
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
    // The client's view comes first: a status it never hears about leaves the
    // thread spinning. A stored status the write missed is repaired at startup.
    try {
      this.store.updateThreadStatus(threadId, status)
    } catch (error) {
      debugLog('thread.status.persist_failed', {
        threadId,
        status: status.type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const target = peer ?? this.activePeerByThread.get(threadId)
    if (target)
      this.notify(target, { method: 'thread/status/changed', params: { threadId, status } })
  }

  // An aborted `signal` drops the request and rejects; the caller's
  // serverRequest/resolved then takes the App's card down.
  private sendServerRequest(
    peer: RpcPeer,
    method: string,
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = this.peerForParams(peer, params)
    const key = `${target.id}:${id}`
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`${method} was cancelled`))
        return
      }
      debugLog('rpc.serverRequest', {
        peerId: target.id,
        originalPeerId: target.id === peer.id ? null : peer.id,
        id,
        method,
        params: summarizeRpcParams(method, params),
      })
      const onAbort = () => {
        if (!this.pendingServerRequests.delete(key)) return
        reject(new Error(`${method} was cancelled`))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingServerRequests.set(key, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
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
    const turnId = this.activeTurnByThread.get(threadId)
    const existed = this.activeTurnByThread.delete(threadId)
    if (turnId) this.closeStreamingItemsByTurn.delete(turnId)
    let settled: TurnRecord | null = null
    try {
      settled = turnId ? this.store.getTurn(turnId) : null
      this.settleGoalTurn(threadId, settled)
    } catch (error) {
      // The thread is free either way; a locked state database only costs
      // the goal's time accounting for this turn.
      debugLog('turn.settle_failed', {
        threadId,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // Let the settled turn's notifications go out first. Claude's own
    // follow-up comes before the queue and goal continuation.
    if (this.pendingAutonomousTurns.delete(threadId)) {
      setImmediate(() => this.startAutonomousTurn(threadId))
      return
    }
    if (existed) {
      setImmediate(() => {
        if (!this.startFollowUp(threadId, settled?.status) && this.activeTurnByThread.size === 0)
          this.idleCheckHandler?.()
      })
    }
  }

  // The MCP servers an App request sees: a named thread's, its project's
  // included; otherwise those that apply in every folder.
  private mcpScope(params: unknown): McpConfigScope {
    const threadId = stringOr(asRecord(params).threadId, '')
    const thread = threadId ? this.store.getThread(threadId) : null
    return { cwd: thread && thread.runtimeBackend !== 'codex' ? thread.cwd : null }
  }

  // Ends a turn whose runtime run failed. The client leaves its running state
  // only on turn/completed, so that goes out even when the store refuses the
  // write too; the usual cause is another connection holding the state
  // database past its busy timeout. Returns false for a turn that had already
  // ended, e.g. through turn/interrupt.
  private failTurn(peer: RpcPeer, threadId: string, turn: TurnRecord, error: Error): boolean {
    const completed = this.endTurn(turn, 'failed', { message: error.message })
    if (!completed) {
      // Its end was recorded, but whatever ended it never let go of the
      // thread.
      if (this.activeTurnByThread.get(threadId) === turn.id) {
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      }
      return false
    }
    this.notify(peer, {
      method: 'error',
      params: { threadId, turnId: turn.id, willRetry: false, error: { message: error.message } },
    })
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId, turn: this.toLifecycleTurn(completed) },
    })
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
    return true
  }

  // Writes a turn's terminal state. Returns null when the turn already ended,
  // and the terminal record built in memory when the store refused the write;
  // that write is then retried in the background.
  private endTurn(turn: TurnRecord, status: TurnStatus, error: unknown | null): TurnRecord | null {
    try {
      const current = this.store.getTurn(turn.id)
      if (current && current.status !== 'inProgress') return null
      return this.store.completeTurn(turn.id, status, error) ?? turn
    } catch (storeError) {
      debugLog('turn.persist_failed', {
        threadId: turn.threadId,
        turnId: turn.id,
        status,
        error: storeError instanceof Error ? storeError.message : String(storeError),
      })
      this.retryTurnEnd(turn.threadId, turn.id, status, error, 1)
      return settledTurn(turn, status, error)
    }
  }

  private retryTurnEnd(
    threadId: string,
    turnId: string,
    status: TurnStatus,
    error: unknown | null,
    attempt: number,
  ): void {
    const timer = setTimeout(() => {
      try {
        if (this.store.getTurn(turnId)?.status === 'inProgress')
          this.store.completeTurn(turnId, status, error)
        if (
          !this.activeTurnByThread.has(threadId) &&
          this.store.getThread(threadId)?.status.type === 'active'
        )
          this.store.updateThreadStatus(threadId, { type: 'idle' })
        debugLog('turn.persist_recovered', { threadId, turnId, attempt })
      } catch (storeError) {
        if (attempt < TURN_END_RETRY_ATTEMPTS) {
          this.retryTurnEnd(threadId, turnId, status, error, attempt + 1)
          return
        }
        // Startup recovery still settles the row on the next launch.
        debugLog('turn.persist_abandoned', {
          threadId,
          turnId,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        })
      }
    }, TURN_END_RETRY_DELAY_MS * attempt)
    timer.unref?.()
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
      if (Array.isArray(parsed.appPlugins)) {
        this.appPlugins = parsed.appPlugins.flatMap((entry) => {
          const plugin = asRecord(entry)
          return typeof plugin.name === 'string' && typeof plugin.root === 'string'
            ? [{ name: plugin.name, root: plugin.root }]
            : []
        })
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
            appPlugins: this.appPlugins,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } catch {}
  }
}
