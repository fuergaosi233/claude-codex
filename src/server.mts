import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, type FSWatcher, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { rendersCompletedSubagentActivity, unverifiedAppWarning } from './app-compat.mjs'
import { type InstalledAppPlugin, stopAppPluginServers } from './app-plugin-mcp.mjs'
import { AUTO_COMPACT_KEY, autoCompactTokenLimit, autoCompactWindow } from './auto-compact.mjs'
import {
  type AppPlugin,
  type AppSkill,
  appMarketplacePlugin,
  appPluginSkills,
  claudeHookSource,
  claudeRunnableAppPlugin,
  claudeSkillDirs,
  codexHookEventName,
  listClaudeHooks,
  listClaudeSkills,
} from './claude-capabilities.mjs'
import { onClaudeCommandsChanged, skillLinksToCommand } from './claude-commands.mjs'
import {
  DEFAULT_EFFORTS,
  defaultReasoningEffort,
  reasoningEffortOptions,
  reportedClaudeModel,
} from './claude-models.mjs'
import { configRequirements } from './cli-probes.mjs'
import { codexAutoCompactLimit } from './codex-config.mjs'
import { runCodexNotify } from './codex-notify.mjs'
import { parseCommandActions } from './command-actions.mjs'
import { appendCommandOutput } from './command-output.mjs'
import {
  DYNAMIC_TOOL_CANCELLED,
  DYNAMIC_TOOL_REQUEST_FAILED,
  dynamicToolFailure,
  dynamicToolResponse,
  dynamicToolServers,
  dynamicToolsEnabled,
  parseDynamicTools,
} from './dynamic-tools.mjs'
import { gitInfoFor, patchGitInfo } from './git-info.mjs'
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
import {
  accountUsage,
  asInvalidRequest,
  hostMethod,
  INVALID_REQUEST,
  invalidRequest,
  invalidRequestIfThrows,
  methodNotFound,
  RpcError,
  SERVER_ERROR,
} from './host-methods.mjs'
import { IdleSleepGuard, type IdleSleepGuardOptions } from './idle-sleep.mjs'
import { inheritedAgents, inheritedHooks, inheritedPermissionRules } from './inherited-config.mjs'
import { LEADER_APP_THREAD_TOOLS, LeaderThreads } from './leader-tools.mjs'
import {
  callMcpTool,
  listMcpServerStatuses,
  type McpConfigScope,
  mcpOauthUnavailable,
  readMcpConfig,
  readMcpResource,
  resetMcpStatusCache,
  toolCallMeta,
} from './mcp.mjs'
import {
  experimentalFeatureList,
  MEMORIES_FEATURE,
  memoriesConfigTable,
  memoriesEnabled,
  memoriesMappingEnabled,
  memoryStatus,
  newThreadMemoryMode,
  parseMemoryMode,
} from './memories.mjs'
import { memoryCitation } from './memory-citations.mjs'
import {
  assertModelProfileTransition,
  modelProfileBindingError,
  modelProfileFingerprint,
  resolveClaudeModelProfile,
} from './model-profiles.mjs'
import {
  mcpToolAllowRule,
  savedAllowRules,
  savedCommandPrefix,
  sessionApproval,
  sessionSuggestionsEnabled,
} from './permission-suggestions.mjs'
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
  acceptsAmendment,
  addedFileDiff,
  addTokenBreakdowns,
  allSelectableModelOptions,
  approvalSessionKey,
  approvalsReviewerFromParams,
  asRecord,
  autoReviewAction,
  buildSystemPromptAddendum,
  type CodexTurnError,
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
  permissionProfileIdFromParams,
  permissionProfileList,
  permissionProfilePolicy,
  personalityPromptCue,
  projectMetadata,
  projectName,
  projectRoots,
  REVIEW_FALLBACK,
  readConfigReasoningEffort,
  reasoningEffortFromParams,
  reasoningSummariesVisible,
  retryTurnError,
  reviewLabel,
  reviewPrompt,
  sandboxEnvelope,
  sandboxFromTurnParams,
  simpleDiff,
  stringListFromEnv,
  stringOr,
  subagentEffortFromInput,
  summarizeRpcParams,
  threadPermissionProfileId,
  todoWriteToPlanSteps,
  tokenBreakdownFromClaudeUsage,
  toolApprovalCommand,
  toolResultText,
  turnErrorOf,
  turnFailure,
  userInputAnswersAsContent,
  visualizationDirNote,
  wrapMcpToolError,
  wrapMcpToolResult,
} from './server-helpers.mjs'
import { type SleepMonitor, SleepTracker, withSleepNotice } from './sleep-notice.mjs'
import { PINNED_SECTION_ID, type SessionStore, settledTurn } from './store.mjs'
import {
  clipText,
  collapseWhitespace,
  SUBAGENT_STOPPED_BY_USER,
  subagentFailureReason,
  subagentThreadName,
  subagentTurnError,
  taskEndReason,
  withSubagentFailures,
} from './subagent-presentation.mjs'
import {
  findOccurrences,
  forkTurns,
  offsetCursor,
  pageItems,
  pageLimit,
  pageTimeline,
  pageTurns,
  sortDirectionOr,
  threadSnippet,
} from './thread-history.mjs'
import {
  capOutput,
  exploreToolCommand,
  imageReadPath,
  isExploreTool,
  splitMcpToolName,
} from './tool-items.mjs'
import {
  type AppToolNoteOptions,
  additionalContextBlocks,
  injectedItemsContext,
  skillInstructions,
  withTurnContext,
} from './turn-context.mjs'
import {
  noticeRowsEnabled,
  noticeTurnError,
  TurnNoticeLog,
  withTurnNotices,
} from './turn-notices.mjs'
import { TurnWatchdog } from './turn-watchdog.mjs'
import type {
  ClaudeResumePoint,
  ClaudeRuntime,
  CommandAction,
  DynamicToolCallRequest,
  DynamicToolCallResponse,
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
  RecalledMemory,
  RpcPeer,
  RuntimeEvent,
  RuntimeLiveTask,
  RuntimeMcpServerStatus,
  RuntimeSteerOptions,
  RuntimeTaskEvent,
  RuntimeTaskUsage,
  RuntimeTurnContext,
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
  CLAUDE_CODE_AGENT_EFFORT_VERSION,
  claudeCodeAtLeast,
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
  GENERIC_MODEL_DESCRIPTION,
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
  resolveClaudeSummaryModelIdentity,
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
// forever. This is deliberately a long, configurable inactivity window: any
// sign of life from the turn's subagents or workflow (their output, task
// progress, a projected workflow agent starting or finishing) starts it over,
// so a long but healthy run never trips it. It is not the short journal-drain
// grace period used when a terminal notification has already arrived.
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
  // The user asked to stop this child and the CLI has not confirmed it yet.
  // Its Agent call can return first: an error it returns meanwhile is the
  // stop's own.
  stopRequested?: boolean
  // An agent another subagent launched hangs off that agent's child thread
  // (its host), as in Codex: its spawn, wait and activity items go to the
  // host's turn. Absent for an agent the main thread launched, whose items
  // go to the parent turn.
  hostThreadId?: string
  hostTurnId?: string
}

interface ActiveSubagentState {
  thread: ThreadRecord
  turn: TurnRecord
  contexts: Map<string, SubagentContext>
  active: Set<string>
  // Tells the turn's watchdog its subagents are still working.
  noteProgress: () => void
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

interface PendingServerRequest {
  readonly method: string
  readonly threadId: string | null
  readonly turnId: string | null
  readonly request: WireMessage
  // Ids of the peers the request was sent to, which a replay skips.
  readonly targets: Set<string>
  // Withdrawn through its abort signal, rather than when its turn ends.
  readonly cancellable: boolean
  resolve(value: unknown): void
  reject(error: Error): void
}

// Notifications are routed by thread id (see targetsForParams), so work that
// outlives its request can publish through this stub and still reach
// whichever peers currently follow the thread.
const DETACHED_PEER: RpcPeer = { id: 'detached', send: () => {}, close: () => {} }

const MAX_TRACKED_TASK_IDS = 512
// Command items a background shell's later output may still go to.
const MAX_TRACKED_COMMAND_ITEMS = 512
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
    // Items from before MCP names were split keep the whole name as the tool.
    return !(
      item.type === 'mcpToolCall' &&
      (item.server === 'codex_goal' || item.tool.startsWith('mcp__codex_goal__'))
    )
  })
}

function goalBudget(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw invalidRequest('goal budgets must be positive integers when provided')
  return value
}

function isUsageLimitError(error: unknown): boolean {
  const message = typeof asRecord(error).message === 'string' ? String(asRecord(error).message) : ''
  return /usage limit|rate limit|quota|\b429\b/i.test(message)
}

function queuedInput(value: unknown): UserInput[] {
  const input = Array.isArray(value) ? (value as UserInput[]) : []
  if (isEmptyInput(input)) throw invalidRequest('queued message input must not be empty')
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
  // capabilities.optOutNotificationMethods from initialize: notifications
  // Codex never sends to the connection. The App opts out of
  // turn/diff/updated, among others.
  optedOutNotifications: ReadonlySet<string>
}

function turnItemsView(value: unknown): TurnItemsView {
  if (value === 'full' || value === 'summary' || value === 'notLoaded') return value
  return 'summary'
}

// The model process profile fingerprint a thread on `model` pins (see
// model-profiles.mts): null for Codex threads and when no profiles exist.
function profileFingerprintForModel(
  model: string,
  runtimeBackend: ThreadRecord['runtimeBackend'],
): string | null {
  if (runtimeBackend === 'codex') return null
  return modelProfileFingerprint(model)
}

// The Claude model a helper thread runs on in place of a Codex model: the
// summary profile when model profiles are configured, else the summary model.
// App rule: helper-thread-model
function claudeHelperModel(model: string): string {
  const summary = resolveClaudeSummaryModelIdentity(model)
  return summary.modelProfileId ?? summary.model ?? model
}

// A Claude thread's session lives in its model process profile (executable,
// provider, CLAUDE_CONFIG_DIR). Once that profile is gone or its configuration
// changed, or the thread started before profiles were set up, nothing may
// start Claude for it: that would resume the session somewhere else.
function threadModelProfileBindingError(thread: ThreadRecord): Error | null {
  if (thread.runtimeBackend !== 'claude') return null
  return modelProfileBindingError(thread.model, thread.modelProfileFingerprint ?? null)
}

// A Codex model with Codex routing off has nowhere to run.
function codexRoutingDisabledError(model: string): RpcError {
  return invalidRequest(
    `Codex model routing is disabled, so ${model} cannot run here; pick a Claude model`,
  )
}

function unknownThread(threadId: string): RpcError {
  return invalidRequest(`unknown thread: ${threadId}`)
}

export interface ServerOptions {
  sleepMonitor?: SleepMonitor
  // Where the adapter runs, for advice that names an App setting.
  platform?: NodeJS.Platform
  // The keep-awake guard's settings; the server says when it is busy.
  idleSleep?: Omit<IdleSleepGuardOptions, 'busy'>
}

export class CodexClaudeAppServer {
  // Keyed by request id. A request goes to every peer following its thread;
  // the first answer resolves it.
  private pendingServerRequests = new Map<string, PendingServerRequest>()
  // The peers following each thread, by peer id, the latest subscriber last.
  // A thread's notifications and server requests go to all of them, the way
  // Codex app-server connections each subscribe to the threads they open.
  private subscribersByThread = new Map<string, Map<string, RpcPeer>>()
  private peerFeatures = new WeakMap<RpcPeer, PeerFeatures>()
  private activeTurnByThread = new Map<string, string>()
  // Turns whose runtime run has not returned yet. A running turn outside this
  // set has nothing left that would ever end it.
  private runtimeRuns = new Set<string>()
  private subagentStateByTurn = new Map<string, ActiveSubagentState>()
  // Closes the message, reasoning and plan items a turn is still streaming,
  // so an interrupt that ends the turn from outside leaves none open.
  private closeStreamingItemsByTurn = new Map<string, () => void>()
  // Turns review/start and thread/compact/start run, which take no steering.
  private unsteerableTurns = new Map<string, 'review' | 'compact'>()
  // Keyed by child thread id. Entries outlive the run so SendMessage can
  // still find (and resume) an agent that already reported back.
  private backgroundSubagents = new Map<string, BackgroundSubagent>()
  // task_started precedes the Agent tool result that backgrounds the task.
  private taskIdByToolUse = new Map<string, string>()
  // Bash command items by tool use id.
  private commandItems = new Map<string, { threadId: string; turnId: string; itemId: string }>()
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
  // Approvals the user gave "for this session", by thread: a command, a
  // non-edit tool call, or an MCP tool (see approvalSessionKey).
  private sessionApprovals = new Map<string, Set<string>>()
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
  // Chats a thread started with the leader tools, and the waits on them.
  private readonly leaderThreads: LeaderThreads
  private elicitationCounts = new Map<string, number>()
  private tokenUsageByThread = new Map<string, TokenUsageBreakdown>()
  // Like Codex's last_token_usage, `last` is one API call: the main loop's
  // latest, which is what fills the context window. The first map follows
  // the running turn; the second keeps the call last reported.
  private lastCallUsageByThread = new Map<string, TokenUsageBreakdown>()
  private lastUsageByThread = new Map<string, TokenUsageBreakdown>()
  // The main loop's API calls since the turn's last result, by message id.
  // Live updates add them to the settled total until the result replaces
  // them.
  private liveCallUsageByThread = new Map<string, Map<string, TokenUsageBreakdown>>()
  private contextWindowByThread = new Map<string, number>()
  // The window a result last reported for each model, for a thread that has
  // not had a result of its own yet.
  private contextWindowByModel = new Map<string, number>()
  private configModel = defaultSelectableModelId()
  private configReasoningEffort =
    normalizeCodexReasoningEffort(process.env.CLAUDE_CODEX_DEFAULT_EFFORT) ?? 'medium'
  // Catch-all for arbitrary keys the App's settings sheet writes (approval
  // policy, sandbox preference, instructions toggles, etc.). We don't apply
  // them to typed runtime state, but we round-trip them through config/read
  // so the user's settings survive a daemon restart instead of resetting on
  // every reconnect.
  private configOverrides: Record<string, unknown> = {}
  // The memories feature as the App last set it with
  // experimentalFeature/enablement/set; features.memories in the config wins.
  private memoriesEnablement: boolean | null = null
  // model_auto_compact_token_limit from the config a thread was started,
  // resumed or forked with. As in Codex, it lasts as long as the process.
  private threadAutoCompactLimits = new Map<string, number>()
  // Codex App plugins whose skills Claude can run, as the App installed them.
  private appPlugins: AppPlugin[] = []
  // Every App plugin the App installed, by its <plugin>@<marketplace> id, for
  // the plugin MCP servers the App calls through the host.
  private installedAppPlugins: InstalledAppPlugin[] = []
  private readonly configPath = join(adapterHome(), 'config.json')
  private idleCheckHandler: (() => void) | null = null
  private stopped = false
  // Every connected peer, for notifications that belong to no thread.
  private peers = new Map<string, RpcPeer>()
  private readonly stopCommandsListener: () => void
  private readonly store: SessionStore
  private readonly runtime: ClaudeRuntime
  // Notices that the computer slept, for the turn watchdog and failed turns.
  private readonly sleepMonitor: SleepMonitor
  private readonly platform: NodeJS.Platform
  // The CLI notices each recent turn has shown (see turn-notices.mts).
  private readonly turnNotices: TurnNoticeLog
  // Keeps the Mac from idle-sleeping while anything runs, when turned on.
  private readonly idleSleep: IdleSleepGuard

  constructor(store: SessionStore, runtime: ClaudeRuntime, options: ServerOptions = {}) {
    this.store = store
    this.runtime = runtime
    this.sleepMonitor = options.sleepMonitor ?? new SleepTracker()
    this.sleepMonitor.start?.()
    this.platform = options.platform ?? process.platform
    this.turnNotices = new TurnNoticeLog()
    this.idleSleep = new IdleSleepGuard({
      ...options.idleSleep,
      busy: () => this.hasActiveTurns(),
    })
    this.leaderThreads = new LeaderThreads({
      store,
      activeTurnId: (threadId) => this.activeTurnByThread.get(threadId) ?? null,
      startThread: (leader, options) => this.startLeaderThread(leader, options),
      sendInput: (threadId, text) => this.sendLeaderInput(threadId, text),
    })
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
      onNotice: (threadId, message) => this.handleRuntimeNotice(threadId, message),
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
      this.resolveServerRequest(peer, message as JsonRpcResponse)
    }
  }

  closePeer(peer: RpcPeer): void {
    debugLog('peer.close', { peerId: peer.id })
    this.peers.delete(peer.id)
    for (const [threadId, subscribers] of this.subscribersByThread.entries()) {
      if (subscribers.delete(peer.id) && subscribers.size === 0)
        this.subscribersByThread.delete(threadId)
    }
    for (const pending of this.pendingServerRequests.values()) pending.targets.delete(peer.id)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.stopCommandsListener()
    this.sleepMonitor.stop?.()
    this.idleSleep.stop()
    this.leaderThreads.stop()
    try {
      // Child turns are created directly from Task/Workflow events and are not
      // registered in activeTurnByThread. Finalize them before aborting the
      // runtime or closing SQLite, otherwise stdio EOF can leave child turns
      // persisted as inProgress until a later restart recovery pass.
      this.finalizeActiveSubagentsForShutdown('server stopped')
      this.finalizeBackgroundSubagents(null, 'server stopped')
      this.completeActiveTurns('interrupted', { message: 'server stopped' })
    } finally {
      // The App plugin servers go with the adapter.
      stopAppPluginServers()
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

  // Something that kept the adapter busy may have ended: the keep-awake
  // guard and the daemon's idle exit look again.
  private checkIdle(): void {
    this.idleSleep.check()
    this.idleCheckHandler?.()
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
      this.replayPendingServerRequests(peer)
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
        code: error instanceof RpcError ? error.code : SERVER_ERROR,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof RpcError && error.data !== undefined ? { data: error.data } : {}),
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
          optedOutNotifications: new Set(
            Array.isArray(capabilities.optOutNotificationMethods)
              ? capabilities.optOutNotificationMethods.filter(
                  (method): method is string => typeof method === 'string',
                )
              : [],
          ),
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
      case 'thread/resume': {
        const resumeParams = asRecord(params)
        await this.gitInfoForResume(resumeParams)
        return this.historyForPeer(peer, this.threadResume(peer, resumeParams))
      }
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
      case 'thread/attachmentOwner/list':
        return this.threadAttachmentOwnerList(asRecord(params))
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
      case 'thread/memoryMode/set':
        return this.threadMemoryModeSet(asRecord(params))
      // Claude Code keeps its auto-memory in per-project folders that Claude
      // Code in a terminal shares, so deleting them here would take memories
      // the App never made. The App reports the failure.
      // App rule: memories-settings
      case 'memory/reset':
        throw new Error(
          "memory/reset is not supported: Claude Code keeps its memories in its own per-project folders, shared with Claude Code outside the App. Review or delete them with Claude Code's /memory command.",
        )
      // Claude Code never consolidates chats into Codex memories.
      case 'memory/status':
        return memoryStatus(asRecord(params))
      case 'thread/unarchive':
        return this.historyForPeer(peer, this.threadArchive(asRecord(params), false))
      case 'thread/compact/start':
        return this.threadCompactStart(peer, asRecord(params))
      case 'thread/shellCommand':
        return this.threadShellCommand(peer, asRecord(params))
      case 'thread/approveGuardianDeniedAction': {
        // The App offers this on an auto-review denial card ("approve
        // anyway"). On a Codex thread it records a one-off approval for the
        // next retry. Claude Code's auto-mode classifier takes no such
        // override (the model sees the denial and decides what to do next),
        // so there is nothing to record. Log the event and ack with the
        // schema's {}.
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
        return this.threadInjectItems(asRecord(params))
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
        return this.configRead(asRecord(params))
      case 'configRequirements/read':
        return configRequirements()
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
        return this.experimentalFeatureList(asRecord(params))
      case 'permissionProfile/list':
        return permissionProfileList(asRecord(params))
      case 'experimentalFeature/enablement/set':
        return this.experimentalFeatureEnablementSet(asRecord(params))
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
      // Stub the three RPC methods Codex App may call that our dispatcher
      // would otherwise answer as unknown. Stubs return the
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
        // The Agent SDK has no call that starts an MCP server's OAuth flow, so
        // there is no authorization URL to hand the App. Say where to sign in
        // instead of returning a link that leads nowhere.
        throw new Error(mcpOauthUnavailable(stringOr(asRecord(params).name, '')))
      case 'config/mcpServer/reload': {
        // Every turn hands Claude Code the MCP config as it is then. What a
        // reload adds: the server list is read afresh, sessions kept open by
        // background work retry the servers that failed or wait for a
        // sign-in, and every App window hears the servers configured now.
        resetMcpStatusCache()
        void this.runtime.reloadMcpServers?.()
        for (const status of readMcpConfig().startupStatuses) {
          this.notifyAll({
            method: 'mcpServer/startupStatus/updated',
            params: { name: status.name, status: status.status, error: status.error ?? null },
          })
        }
        return {}
      }
      // Event streams feed MCP app widgets. This server forwards no MCP
      // events, so a subscription stays silent until the App stops it.
      case 'mcpServer/event/stream/start':
      case 'mcpServer/event/stream/stop':
        return {}
      case 'mcpServerStatus/list': {
        // serverName limits discovery to one server. With a Claude thread
        // whose session is live, runtimeStatus is that session's view.
        const serverName = nullIfEmpty(stringOr(asRecord(params).serverName, ''))
        const session = this.mcpSessionStatuses(params).catch(() => null)
        return listMcpServerStatuses(this.mcpScope(params), session).then((data) => ({
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
          toolCallMeta(asRecord(params)._meta, stringOr(asRecord(params).threadId, '')),
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
      // Requests of the protocol that no App build sends. Codex itself answers
      // thread/prediction/request with method not found, and
      // thread/readState/update too when it keeps no read state.
      case 'thread/items/read':
      case 'thread/prediction/request':
      case 'thread/readState/update':
        throw methodNotFound(method)
      default: {
        const result = hostMethod(method, asRecord(params))
        if (result === undefined) throw methodNotFound(method)
        return result
      }
    }
  }

  private threadStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    // Specs Codex would reject fail the request, as they do there. With the
    // switch off they are ignored.
    // App rule: dynamic-tools
    const dynamicTools = dynamicToolsEnabled() ? parseDynamicTools(params.dynamicTools) : []
    const id = newThreadId()
    const now = nowSeconds()
    const projectId = stringOr(params.projectId, '') || null
    if (projectId) this.requireProject(projectId)
    const requestedModel = modelFromParams(params, this.configModel)
    const isTitleOrHelper =
      params.ephemeral === true ||
      params.threadSource === 'title_generation' ||
      params.threadSource === 'memory_consolidation'
    const codexRoutingDisabled = this.codexRoutingDisabled()
    // The App names its own OpenAI model for titles and other helper threads,
    // and accepts another one; with Codex routing off they run on Claude.
    // App rule: helper-thread-model
    const model =
      isTitleOrHelper && codexRoutingDisabled && isCodexOpenAiModel(requestedModel)
        ? claudeHelperModel(requestedModel)
        : requestedModel
    // Any other thread on a Codex model has nowhere to run, and the picker
    // offers none: refuse it before a worktree is made for it.
    if (codexRoutingDisabled && isCodexOpenAiModel(model)) throw codexRoutingDisabledError(model)
    const selectedProviderLoop = resolveProviderLoopSelection(this.providerLoopSelectionInput())
    // Pick the runtime backend from the chosen model — picking gpt-* in
    // the App's model dropdown flips the new thread to runtimeBackend
    // 'codex' so turns get forwarded to `codex exec`. Default 'claude'.
    const runtimeBackend: ThreadRecord['runtimeBackend'] =
      selectedProviderLoop.runtimeType === 'codex-proxy' || isCodexOpenAiModel(model)
        ? 'codex'
        : 'claude'
    // Resolved before any side effect so a misconfigured model process profile
    // fails the request without leaving a worktree behind.
    const profileFingerprint = profileFingerprintForModel(model, runtimeBackend)
    const requestedCwd = stringOr(params.cwd, process.cwd())
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const reasoningEffort = reasoningEffortFromParams(params, this.configReasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    const thread: ThreadRecord = {
      id,
      sessionId: id,
      forkedFromId: null,
      isPinned: false,
      sectionId: null,
      sectionEnteredAt: null,
      sectionPosition: null,
      // Set only for a chat the adapter starts itself; see startLeaderThread.
      preview: typeof params._preview === 'string' ? params._preview.slice(0, 200) : '',
      name: nullIfEmpty(typeof params._name === 'string' ? params._name : null),
      archived: false,
      cwd,
      model,
      modelProfileFingerprint: profileFingerprint,
      reasoningEffort,
      // Never openai: the App would fork a Claude thread for its composer
      // predictions.
      // App rule: prediction-provider
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
      // Helper threads never ask the user anything.
      // App rule: auto-review
      approvalsReviewer: isTitleOrHelper ? null : approvalsReviewerFromParams(params),
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
      // The App's per-chat memories switches arrive as memories.* config.
      // Helper threads never remember. Without the memories mapping no mode
      // is kept.
      memoryMode: !memoriesMappingEnabled()
        ? null
        : isTitleOrHelper
          ? 'disabled'
          : newThreadMemoryMode(asRecord(params.config), this.configOverrides),
      runtimeBackend,
      codexSessionId: null,
      projectId,
    }
    this.store.upsertThread(thread)
    this.rememberAutoCompactLimit(id, params.config)
    if (projectId) this.store.setThreadProject(id, projectId)
    this.store.putDynamicTools(id, dynamicTools)
    // Like Codex, thread/start answers without git info; the App looks the
    // branch up itself, and thread/list has it once the lookup lands.
    // App rule: thread-git-info
    if (!thread.ephemeral) void this.captureGitInfo(id, cwd)
    recordRunEvent('thread.started', {
      threadId: thread.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.subscribe(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread)
  }

  // thread_start: the chat goes through thread/start and turn/start as if
  // the App had sent them on the leader's connection, with the leader's
  // settings. thread/started puts it in the App's sidebar and the App then
  // follows its turns live; the App drew no user message, so it is published.
  // App rule: server-started-threads
  private async startLeaderThread(
    leader: ThreadRecord,
    options: { prompt: string; cwd: string; model: string; title: string | null },
  ): Promise<{ threadId: string; turnId: string }> {
    // Claude chats only, for now: on the Codex proxy a new chat runs there.
    if (
      resolveProviderLoopSelection(this.providerLoopSelectionInput()).runtimeType === 'codex-proxy'
    )
      throw new Error(
        'new chats run on the Codex proxy right now; thread_start starts Claude chats only',
      )
    const peer = this.peerForThread(leader.id)
    const started = this.threadStart(peer, {
      cwd: options.cwd,
      model: options.model,
      effort: leader.reasoningEffort,
      // A leader without a policy asks before tools run. thread/start reads
      // a missing one as never and full access, so pass the asking pair that
      // runs the same: a started chat gets no more than its leader.
      approvalPolicy: leader.approvalPolicy ?? 'on-request',
      sandbox: leader.sandboxMode ?? 'workspace-write',
      permissions: leader.permissionProfileId,
      baseInstructions: leader.baseInstructions,
      developerInstructions: leader.developerInstructions,
      personality: leader.personality,
      projectId: leader.projectId,
      threadSource: 'user',
      // The App names a chat it is told about from the thread/started it gets:
      // it shows the name if there is one, and otherwise titles the chat from
      // its preview, as it does a chat started in the composer. With neither
      // the chat stays untitled, so both are set before the turn starts.
      // App rule: added-thread-titles
      _preview: options.prompt,
      _name: options.title,
    })
    // No App follows the leader right now: threadStart subscribes no one, and
    // the chat finds its followers when an App opens it.
    const threadId = stringOr(asRecord(asRecord(started).thread).id, '')
    // Linked before its turn starts, so that turn already gets no leader tools.
    this.store.addLeaderThread(threadId, leader.id)
    const result = await this.turnStart(peer, {
      threadId,
      input: [{ type: 'text', text: options.prompt, text_elements: [] }],
      _emitUserMessage: true,
    })
    return { threadId, turnId: stringOr(asRecord(asRecord(result).turn).id, '') }
  }

  // thread_prompt: input goes in as the App sends a message. A running turn
  // takes it as a steer, like the App's default follow-up mode; there is no
  // queue to wait behind while the leader waits for an answer.
  private async sendLeaderInput(
    threadId: string,
    text: string,
  ): Promise<{ turnId: string; steered: boolean }> {
    const running = this.activeTurnByThread.get(threadId) ?? null
    const leaderId = this.store.leaderOf(threadId)
    const peer =
      this.subscribersOf(threadId).at(-1) ??
      (leaderId ? this.peerForThread(leaderId) : DETACHED_PEER)
    const result = await this.turnStart(peer, {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      _emitUserMessage: true,
    })
    const turnId = stringOr(asRecord(asRecord(result).turn).id, '')
    return { turnId, steered: running !== null && turnId === running }
  }

  private threadResume(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw unknownThread(threadId)
    // A chat its model process profile can no longer run still opens, so it
    // can be read; a turn, review, compaction or fork of it is refused.
    const unbound = this.modelProfileUnbound(thread)
    if (unbound) {
      debugLog('thread.resume.modelProfileUnbound', { threadId, message: unbound.message })
    }
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
        // A Claude conversation also stays on its model process profile; the
        // picker's choice is ignored rather than failing the resume. One no
        // profile can run keeps its model and pin, so it stays refused.
        try {
          if (unbound) throw unbound
          if (newBackend === 'claude' && this.threadHasConversation(thread))
            assertModelProfileTransition(thread.model, model)
          thread.modelProfileFingerprint = profileFingerprintForModel(model, newBackend)
          thread.model = model
        } catch (error) {
          debugLog('thread.resume.modelProfileMismatch', {
            threadId,
            oldModel: thread.model,
            newModel: model,
            message: error instanceof Error ? error.message : String(error),
          })
        }
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
    thread.approvalsReviewer =
      approvalsReviewerFromParams(params) ?? thread.approvalsReviewer ?? null
    this.store.upsertThread(thread)
    this.rememberAutoCompactLimit(threadId, params.config)
    recordRunEvent('thread.resumed', {
      threadId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.subscribe(threadId, peer)
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
    this.checkModelProfileBinding(parent)
    // A fork from one of the parent's turns keeps the history up to it, and
    // Claude's context with it.
    const parentTurns = this.store.listTurns(parent.id)
    const kept = forkTurns(parentTurns, params)
    const now = nowSeconds()
    const id = newThreadId()
    const requestedModel = modelFromParams(params, parent.model)
    // The App describes a thread in an ephemeral fork named for its own
    // summary model. A thread on a model process profile cannot leave it, so
    // that fork stays on the profile, and so does its summary turn. With Codex
    // routing off, the fork of any Claude thread stays on its model.
    // App rule: helper-thread-model
    const forkModel =
      params.ephemeral === true &&
      parent.runtimeBackend === 'claude' &&
      isCodexOpenAiModel(requestedModel) &&
      (resolveClaudeModelProfile(parent.model) || this.codexRoutingDisabled())
        ? parent.model
        : requestedModel
    // Fork: model may flip backend (forking from claude-thread with a
    // gpt-* model = new codex-backed thread); otherwise inherit parent.
    const runtimeBackend: ThreadRecord['runtimeBackend'] = isCodexOpenAiModel(forkModel)
      ? 'codex'
      : 'claude'
    // The fork carries the parent's conversation, which a Claude parent keeps
    // in its model process profile. A Codex parent's lives in Codex, so its
    // fork may take any profile, as it takes any Claude model without them.
    if (parent.runtimeBackend === 'claude') {
      assertModelProfileTransition(parent.model, forkModel)
    }
    const profileFingerprint = profileFingerprintForModel(forkModel, runtimeBackend)
    const requestedCwd = stringOr(params.cwd, parent.cwd)
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    let forkPoint = runtimeBackend === 'claude' ? this.forkPointOf(parent, kept) : null
    // Turns from before checkpoints give Claude's context no place to stop
    // at the fork point: the fork keeps all of it, as a whole fork does.
    const uncut =
      kept !== null &&
      forkPoint === null &&
      runtimeBackend === 'claude' &&
      parent.runtimeBackend !== 'codex'
    if (uncut) forkPoint = this.forkPointOf(parent, null)
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
      modelProfileFingerprint: profileFingerprint,
      reasoningEffort: reasoningEffortFromParams(params, parent.reasoningEffort),
      claudeSessionId:
        forkPoint === 'new' ? null : (forkPoint?.sessionId ?? parent.claudeSessionId),
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
      // A fork remembers like its parent; an ephemeral one never does.
      memoryMode:
        params.ephemeral === true || parent.ephemeral ? 'disabled' : (parent.memoryMode ?? null),
      // A fork starts in the default mode, as a Codex fork does: Codex
      // carries the parent's reviewer into a fork but not its mode. The App
      // sends the mode it shows for the fork with each of its turns.
      // A helper fork does not inherit the reviewer either.
      collaborationMode: null,
      approvalsReviewer:
        params.ephemeral === true
          ? null
          : (approvalsReviewerFromParams(params) ?? parent.approvalsReviewer ?? null),
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
      gitInfo: cwd === parent.cwd ? (parent.gitInfo ?? null) : null,
    }
    this.store.upsertThread(thread)
    // A fork compacts like its parent unless its own config says otherwise.
    const parentLimit = this.threadAutoCompactLimits.get(parent.id)
    if (parentLimit != null) this.threadAutoCompactLimits.set(id, parentLimit)
    this.rememberAutoCompactLimit(id, params.config)
    // A fork stays in its parent's project, and keeps its dynamic tools:
    // thread/fork does not carry them.
    if (parent.projectId) this.store.setThreadProject(id, parent.projectId)
    // As in Codex, a fork that is kept holds its parent's attachments (the
    // worktree it ran in, the pull requests opened from it), so
    // thread/attachmentOwner/list names it too; an ephemeral fork holds none.
    if (!thread.ephemeral) this.store.copyThreadAttachments(parent.id, id)
    this.store.putDynamicTools(id, this.store.getDynamicTools(parent.id))
    this.store.setThreadGitInfo(id, thread.gitInfo ?? null)
    if (!thread.ephemeral && !thread.gitInfo) void this.captureGitInfo(id, cwd)
    if (forkPoint) {
      this.store.setForkCheckpoint(id, forkPoint)
      this.resumeClaudeAt(id, forkPoint)
    }
    recordRunEvent('thread.forked', {
      threadId: thread.id,
      parentThreadId: parent.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
      keptTurns: kept?.length ?? null,
    })
    this.subscribe(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    // App rule: config-warnings
    if (uncut && kept.length < parentTurns.length) {
      this.notify(peer, {
        method: 'configWarning',
        params: {
          summary: 'Claude in a forked chat still remembers the turns after the fork point',
          details: `Thread ${parent.id} has no Claude checkpoint up to the turn it was forked at (its turns predate checkpoints), so its fork ${id} resumes the whole Claude session, later turns included.`,
        },
      })
    }
    return this.threadEnvelope(thread, params.excludeTurns === true ? [] : (kept ?? parentTurns))
  }

  // Where a fork of `thread` picks up Claude's context. A fork that keeps
  // only `kept`, the thread's turns up to some turn, takes the context after
  // them. A whole fork takes the checkpoint the thread itself resumes at next
  // if it was just rewound, else the end of its newest settled turn. Null when
  // the turns predate checkpoints; a whole fork then resumes the whole session.
  private forkPointOf(thread: ThreadRecord, kept: TurnRecord[] | null): ClaudeResumePoint | null {
    if (thread.runtimeBackend === 'codex') return null
    if (kept) return this.claudeContextAfter(thread, kept)
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
      throw invalidRequest('sectionId must be a string or null')
    const sectionId = params.sectionId === null ? null : params.sectionId
    if (sectionId === '') throw invalidRequest('sectionId must not be empty')
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
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalidRequest('invalid section cursor')
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
    if (!existing) throw invalidRequest(`unknown section: ${sectionId}`)
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
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalidRequest('invalid project cursor')
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
    if (!idempotencyKey) throw invalidRequest('idempotencyKey must not be empty')
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
    if (!thread) throw unknownThread(threadId)
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
    if (!this.store.getThread(threadId)) throw unknownThread(threadId)
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
    if (!this.store.getThread(threadId)) throw unknownThread(threadId)
    const attachmentType = stringOr(params.attachmentType, '')
    const identityKey = stringOr(params.identityKey, '')
    if (!attachmentType || !identityKey)
      throw invalidRequest('attachmentType and identityKey must not be empty')
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
    if (!this.store.getThread(threadId)) throw unknownThread(threadId)
    const offset = offsetCursor(params.cursor, 'attachment')
    const limit = pageLimit(params.limit, 200) ?? 100
    const attachments = this.store.listThreadAttachments(threadId, limit + 1, offset)
    return {
      data: attachments.slice(0, limit),
      nextCursor: attachments.length > limit ? String(offset + limit) : null,
    }
  }

  // The threads holding an attachment, by thread id: the App keeps the
  // worktree of a thread it archives while another thread still holds it.
  // archived false lists the live threads only, true the archived ones.
  private threadAttachmentOwnerList(params: Record<string, unknown>): unknown {
    const attachmentType = stringOr(params.attachmentType, '')
    const identityKey = stringOr(params.identityKey, '')
    if (!attachmentType.trim()) throw invalidRequest('attachmentType must not be empty')
    if (!identityKey.trim()) throw invalidRequest('identityKey must not be empty')
    const archived = typeof params.archived === 'boolean' ? params.archived : null
    const offset = offsetCursor(params.cursor, 'attachment owner')
    const limit = pageLimit(params.limit, 200) ?? 25
    const owners = this.store.listAttachmentOwners(
      { attachmentType, identityKey, archived },
      limit + 1,
      offset,
    )
    return {
      data: owners.slice(0, limit),
      nextCursor: owners.length > limit ? String(offset + limit) : null,
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
      if (!thread) throw unknownThread(threadId)
      return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
    }
    this.clearThreadState(threadId)
    return {}
  }

  // Drops per-thread in-memory state (session-scoped approvals, token
  // usage tallies, goal bookkeeping, elicitation counts) so an archived thread
  // does not leak entries for the lifetime of the process. The goal itself and
  // the queue stay persisted for an unarchive.
  private clearThreadState(threadId: string): void {
    this.sessionApprovals.delete(threadId)
    this.tokenUsageByThread.delete(threadId)
    this.lastCallUsageByThread.delete(threadId)
    this.lastUsageByThread.delete(threadId)
    this.liveCallUsageByThread.delete(threadId)
    this.contextWindowByThread.delete(threadId)
    this.goalIdleStreaks.delete(threadId)
    this.goalClockByThread.delete(threadId)
    this.goalTurnByThread.delete(threadId)
    this.goalToolHandlers.delete(threadId)
    this.leaderThreads.forget(threadId)
    this.elicitationCounts.delete(threadId)
  }

  private threadUnsubscribe(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const subscribers = this.subscribersByThread.get(threadId)
    if (!subscribers?.delete(peer.id)) return { status: 'notSubscribed' }
    if (subscribers.size === 0) this.subscribersByThread.delete(threadId)
    // The peer drops the thread's request cards with it, so a later
    // thread/resume shows its pending requests again.
    for (const pending of this.pendingServerRequests.values())
      if (pending.threadId === threadId) pending.targets.delete(peer.id)
    // The thread's other followers keep it open; only this peer hears it close.
    this.sendNotification(peer, { method: 'thread/closed', params: { threadId } })
    return { status: 'unsubscribed' }
  }

  private threadLoadedList(params: Record<string, unknown>): unknown {
    const loaded = Array.from(this.subscribersByThread.keys())
    const limit = numberOr(params.limit, loaded.length || 50)
    return {
      data: loaded.slice(0, limit),
      nextCursor: loaded.length > limit ? String(limit) : null,
    }
  }

  // The App injects Responses API items into a thread's model history before
  // a turn, such as an MCP app's content or the state of the chat's inline
  // visualizations, and when it opens a side chat. Codex adds them to the
  // history without a turn or an item, so the transcript does not show them.
  // Claude's history is its own session, so they wait in the store and the
  // next message hands them to Claude (see modelPrompt).
  // App rule: injected-context
  private threadInjectItems(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw unknownThread(threadId)
    const items = Array.isArray(params.items) ? params.items : []
    this.store.addInjectedItems(threadId, items)
    debugLog('thread.inject_items', { threadId, count: items.length })
    return {}
  }

  // Thread goals follow Codex: the goal is persisted per thread, and while it
  // is active the adapter keeps the thread working by starting hidden
  // continuation turns whenever it goes idle (see startFollowUp).
  private threadGoalSet(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.goalThread(threadId)
    this.subscribe(threadId, peer)
    if (params.status != null && !isGoalStatus(params.status))
      throw invalidRequest(`invalid goal status: ${String(params.status)}`)
    const status = isGoalStatus(params.status) ? params.status : null
    const objective = typeof params.objective === 'string' ? params.objective.trim() : null
    if (objective === '') throw invalidRequest('goal objective must not be empty')
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
      if (!objective) throw invalidRequest(`no goal exists for thread ${threadId}`)
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
    if (this.store.getThread(threadId)) this.subscribe(threadId, peer)
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
    if (!thread) throw unknownThread(threadId)
    if (thread.ephemeral) throw invalidRequest('Goal tools require a persistent thread.')
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
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    messageId: string,
    usage: Record<string, unknown>,
  ): void {
    const breakdown = tokenBreakdownFromClaudeUsage(usage)
    if (breakdown.totalTokens > 0) {
      this.lastCallUsageByThread.set(threadId, breakdown)
      this.publishLiveTokenUsage(peer, threadId, turnId, messageId, breakdown)
    }
    const counted = breakdown.inputTokens + breakdown.outputTokens
    const progress = this.goalProgressByThread.get(threadId) ?? new Map<string, number>()
    const charged = progress.get(messageId) ?? 0
    if (counted <= charged) return
    progress.set(messageId, counted)
    this.goalProgressByThread.set(threadId, progress)
    this.accrueGoalTokens(threadId, counted - charged, true)
  }

  // Codex reports token usage after every model request, so the App's context
  // gauge moves while a turn runs. Each main-loop API call reports here once
  // its usage grows (the CLI repeats it with every content block), as `last`
  // and on top of the settled total; the turn's result then settles it.
  private publishLiveTokenUsage(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    messageId: string,
    breakdown: TokenUsageBreakdown,
  ): void {
    const calls = this.liveCallUsageByThread.get(threadId) ?? new Map<string, TokenUsageBreakdown>()
    const reported = calls.get(messageId)
    if (reported && reported.totalTokens >= breakdown.totalTokens) return
    calls.set(messageId, breakdown)
    this.liveCallUsageByThread.set(threadId, calls)
    // The App hides its gauge for a null window, so wait for one rather than
    // blank it.
    const modelContextWindow = this.contextWindowFor(threadId)
    if (!modelContextWindow) return
    const tokenUsage: ThreadTokenUsage = {
      total: this.liveTokenTotal(threadId),
      last: breakdown,
      modelContextWindow,
    }
    this.notify(peer, {
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage },
    })
  }

  // What results have settled plus the API calls reported since.
  private liveTokenTotal(threadId: string): TokenUsageBreakdown {
    const settled = this.tokenUsageByThread.get(threadId) ?? emptyTokenBreakdown()
    const live = this.liveCallUsageByThread.get(threadId)?.values() ?? []
    return addTokenBreakdowns([settled, ...live])
  }

  // App rule: context-gauge
  private contextWindowFor(threadId: string): number | null {
    const known = this.contextWindowByThread.get(threadId)
    if (known) return known
    const model = this.store.getThread(threadId)?.model
    return (model && this.contextWindowByModel.get(model)) || null
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
    if (!thread) throw unknownThread(threadId)
    if (thread.ephemeral) throw invalidRequest('queued messages require a persistent thread')
    return thread
  }

  private saveQueue(threadId: string, items: QueuedSubmission[]): void {
    this.store.saveQueue(threadId, items)
    this.notifyThread(threadId, { method: 'thread/queue/changed', params: { threadId } })
  }

  private queuedSubmission(threadId: string, id: string): QueuedSubmission {
    const item = this.store.listQueue(threadId).find((entry) => entry.id === id)
    if (!item) throw invalidRequest(`unknown queued submission: ${id}`)
    return item
  }

  private threadQueueAdd(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    this.queueThread(threadId)
    this.subscribe(threadId, peer)
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
    this.subscribe(threadId, peer)
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
    this.subscribe(threadId, peer)
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
    this.subscribe(threadId, peer)
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
      throw invalidRequest(
        `cannot start a queued message while thread ${threadId} has an active turn`,
      )
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
  // They run on the thread's stored reviewer, which may have fallen back to
  // the user since that turn asked for automatic review. Nor the lineage of a
  // turn started for another turn: such a turn is its own root.
  private followUpParams(threadId: string): Record<string, unknown> {
    const {
      input: _input,
      clientUserMessageId: _clientId,
      outputSchema: _schema,
      parentTurnId: _parent,
      rootTurnId: _root,
      collaborationMode: _mode,
      approvalsReviewer: _reviewer,
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
            params: { threadId, turnId: null, willRetry: false, error: turnErrorOf(error) },
          })
        })
        return this.activeTurnByThread.has(threadId)
      }
    }
    if (settled === 'failed' || !this.canContinueGoal(threadId)) return false
    const goal = this.store.getGoal(threadId)
    if (!goal) return false
    // Nor does a goal go on in a chat its model process profile can no longer
    // run; say why, as a refused queued message does.
    let unbound: Error | null = null
    try {
      unbound = this.modelProfileUnbound(thread)
    } catch {
      // An unreadable profiles file fails the turn start below.
    }
    if (unbound) {
      debugLog('goal.continue.failed', { threadId, error: unbound.message })
      this.notify(peer, {
        method: 'error',
        params: { threadId, turnId: null, willRetry: false, error: { message: unbound.message } },
      })
      return false
    }
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
    if (!thread) throw unknownThread(threadId)
    // projectId: omitted or null leaves it, '' clears it, an id assigns it.
    const projectId = typeof params.projectId === 'string' ? params.projectId || null : undefined
    if (projectId) this.requireProject(projectId)
    // The App sets the branch after it creates one for the thread.
    const gitInfo =
      params.gitInfo == null
        ? undefined
        : invalidRequestIfThrows(() => patchGitInfo(thread.gitInfo ?? null, params.gitInfo))

    // Support dynamic model, reasoning effort, approval policy and sandbox updates
    const model = this.requestedModelChange(thread, params)
    const reasoningEffort = reasoningEffortFromParams(params, null)
    // First, so a model on the other backend is refused before anything changes.
    if (model) this.setThreadModel(thread, model)
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
    if (gitInfo !== undefined) {
      this.store.setThreadGitInfo(threadId, gitInfo)
      thread.gitInfo = gitInfo
    }

    thread.updatedAt = nowSeconds()
    this.store.upsertThread(thread)

    return this.threadEnvelope(thread, this.store.listTurns(threadId))
  }

  private threadSettingsUpdate(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw unknownThread(threadId)

    // Codex App sends model and effort changes through this RPC. Keep these
    // legacy settings fields in the compatibility handler so removing the
    // duplicate dispatch case does not silently disable profile/model
    // switching for existing clients.
    // The App's model menu lands here. A model on the other backend is
    // refused before anything changes: the App then reports that it could
    // not update the settings and the chat keeps its model.
    // App rule: model-menu-settings
    const model = this.requestedModelChange(thread, params)
    if (model) this.setThreadModel(thread, model)
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
    // App rule: auto-review
    thread.approvalsReviewer =
      approvalsReviewerFromParams(params) ?? thread.approvalsReviewer ?? null
    this.store.upsertThread(thread)
    this.notifyThreadSettings(peer, thread)
    return {}
  }

  private notifyThreadSettings(peer: RpcPeer, thread: ThreadRecord): void {
    const activePermissionProfileId = threadPermissionProfileId(
      thread.permissionProfileId,
      thread.approvalPolicy,
      thread.sandboxMode,
    )
    this.notify(peer, {
      method: 'thread/settings/updated',
      params: {
        threadId: thread.id,
        threadSettings: {
          cwd: thread.cwd,
          approvalPolicy: thread.approvalPolicy ?? 'on-request',
          // The reviewer actually in effect: the App's picker follows it.
          // App rule: auto-review
          approvalsReviewer: thread.approvalsReviewer ?? 'user',
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
  }

  // The thread asked for automatic review and its session cannot run it. Its
  // approvals stay with the user: store and echo that, so the App's picker
  // shows what is in effect, and say why in the App's config warnings.
  // App rule: auto-review
  private autoReviewUnavailable(peer: RpcPeer, threadId: string, reason: string): void {
    debugLog('thread.autoReview.unavailable', { threadId, reason })
    const thread = this.store.getThread(threadId)
    if (thread?.approvalsReviewer === 'auto_review') {
      thread.approvalsReviewer = 'user'
      this.store.upsertThread(thread)
      this.notifyThreadSettings(peer, thread)
    }
    this.notify(peer, {
      method: 'configWarning',
      params: {
        summary: 'Auto-review is not available on this Claude thread; you will review approvals.',
        details: /[.!?]$/.test(reason) ? reason : `${reason}.`,
      },
    })
  }

  private threadRollback(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw unknownThread(threadId)
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
    if (!thread) throw unknownThread(threadId)
    if (!this.store.listTurns(threadId).some((turn) => turn.id === beforeTurnId))
      throw invalidRequest(`unknown turn: ${beforeTurnId}`)
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
      throw invalidRequest(`cannot rewind thread ${thread.id} while a turn is running`)
    const dropped = drop()
    if (dropped === 0) return 0
    const remaining = this.store.listTurns(thread.id)
    if (thread.runtimeBackend === 'codex') {
      // `codex exec resume` cannot truncate a session; only a full rewind is exact.
      if (remaining.length === 0) this.store.updateCodexSessionId(thread.id, null)
      return dropped
    }
    this.runtime.resetSession?.(thread.id)
    const point = this.claudeContextAfter(thread, remaining)
    if (point) {
      this.resumeClaudeAt(thread.id, point)
      return dropped
    }
    if (remaining.length === 0) {
      // A fork from before fork points goes back to its parent's session.
      const parent = thread.forkedFromId ? this.store.getThread(thread.forkedFromId) : null
      this.store.rewindClaudeSession(thread.id, parent?.claudeSessionId ?? null, null)
      return dropped
    }
    // The remaining turns predate checkpoints: Claude keeps its context.
    debugLog('thread.rewind.unanchored', { threadId: thread.id, dropped })
    return dropped
  }

  // Where Claude's context stands once a thread has run `turns`, its first
  // turns: the newest of their checkpoints, or with no turns, where the thread
  // began (its fork point, or a new session). Null when the turns, or the fork
  // they start from, predate checkpoints.
  private claudeContextAfter(thread: ThreadRecord, turns: TurnRecord[]): ClaudeResumePoint | null {
    for (const turn of turns.toReversed()) {
      const checkpoint = this.store.turnCheckpoint(turn.id)
      if (checkpoint) return checkpoint
    }
    if (turns.length > 0) return null
    return thread.forkedFromId ? this.store.forkCheckpoint(thread.id) : 'new'
  }

  // Points a thread's next turn at `point`: a forked session resumed there,
  // or a new session.
  private resumeClaudeAt(threadId: string, point: ClaudeResumePoint): void {
    if (point === 'new') this.store.rewindClaudeSession(threadId, null, null)
    else this.store.rewindClaudeSession(threadId, point.sessionId, point.messageUuid)
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
    // are, or that they hang off): their turns end before their threads do.
    for (const entry of [...this.backgroundSubagents.values()]) {
      if (!entry.running) continue
      if (
        entry.parentThreadId !== threadId &&
        entry.context.childThreadId !== threadId &&
        !this.isSubagentDescendant(entry.context.childThreadId, threadId)
      )
        continue
      await this.stopBackgroundSubagent(entry)
    }
    for (const id of this.store.deleteThread(threadId)) {
      this.runtime.resetSession?.(id)
      this.clearThreadState(id)
      this.pendingAutonomousTurns.delete(id)
      this.lastTurnParamsByThread.delete(id)
      this.goalProgressByThread.delete(id)
      this.backgroundSubagents.delete(id)
      // Whoever deleted the thread hears it, and so does every follower.
      const targets = new Map([[peer.id, peer]])
      for (const follower of this.subscribersOf(id)) targets.set(follower.id, follower)
      this.subscribersByThread.delete(id)
      for (const target of targets.values())
        this.sendNotification(target, { method: 'thread/deleted', params: { threadId: id } })
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
    if (threadId) this.subscribe(threadId, peer)
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
    this.subscribe(threadId, peer)
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
  // again. Claude switches model, effort and auto mode in place (a session
  // that cannot run auto mode says so and keeps the user as reviewer); a
  // reasoning summary and a service tier have no Claude counterpart.
  private async turnSettingsUpdate(params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const turnId = stringOr(params.turnId, '')
    const thread = this.store.getThread(threadId)
    if (!thread || this.activeTurnByThread.get(threadId) !== turnId)
      return { status: 'targetUnavailable' }
    const unsupported = ['summary', 'serviceTier'].filter((key) => params[key] != null)
    if (unsupported.length > 0)
      throw invalidRequest(`a running Claude turn cannot change ${unsupported.join(', ')}`)
    const settings: RuntimeTurnSettings = {}
    // App rule: auto-review
    const reviewer = approvalsReviewerFromParams(params)
    if (reviewer) settings.autoReview = reviewer === 'auto_review'
    if (params.model != null) {
      // Unlike turn/start, an unknown model fails instead of falling back.
      const requested = stringOr(params.model, '')
      const model = invalidRequestIfThrows(allSelectableModelOptions).find(
        (option) => option.id.toLowerCase() === requested.toLowerCase(),
      )?.id
      if (!model) throw invalidRequest(`unknown model: ${requested}`)
      const backend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      if (backend !== thread.runtimeBackend)
        throw invalidRequest(`a running ${thread.runtimeBackend} turn cannot switch to ${model}`)
      // The running turn's process belongs to its model process profile.
      if (backend === 'claude')
        invalidRequestIfThrows(() => assertModelProfileTransition(thread.model, model))
      const resolved = backend === 'codex' ? model : resolveClaudeModel(model)
      if (resolved) settings.model = resolved
    }
    // 'none' is the effort of a model that takes none (model/list gives it to
    // Haiku), so it leaves the effort as it is.
    if (params.effort != null && params.effort !== 'none') {
      const effort = resolveClaudeEffort(stringOr(params.effort, ''))
      if (!effort) throw invalidRequest(`unsupported effort: ${String(params.effort)}`)
      settings.effort = effort
    }
    if (reviewer && reviewer !== (thread.approvalsReviewer ?? 'user')) {
      // Like turn/start, the reviewer holds for the thread's later turns.
      thread.approvalsReviewer = reviewer
      this.store.upsertThread(thread)
    }
    if (settings.model == null && settings.effort == null && settings.autoReview == null)
      return { status: 'applied' }
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
    if (!thread) throw unknownThread(threadId)
    this.checkModelProfileBinding(thread)
    this.subscribe(threadId, peer)
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
    this.unsteerableTurns.set(turnId, 'review')
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
      // The marker is complete once the review is under way, as in Codex.
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: entered, completedAtMs: nowMillis() },
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
    if (!thread) throw unknownThread(threadId)
    this.checkModelProfileBinding(thread)
    this.subscribe(threadId, peer)
    const turnId = newId()
    const compactItem: ThreadItem = { type: 'contextCompaction', id: newId() }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      // The compaction item joins the turn once it completes (compactThread).
      items: [],
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
      purpose: 'compact',
    })
    this.activeTurnByThread.set(threadId, turnId)
    this.unsteerableTurns.set(turnId, 'compact')
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
      void this.compactThread(peer, thread, turn, compactItem).catch((error) => {
        debugLog('thread.compact.failed', {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
    return {}
  }

  // Compacts the thread like Codex's /compact: Claude compacts the thread's
  // own session, so the next turn goes on from its summary. A thread with no
  // Claude session yet, or whose compaction fails, gets a summary written in
  // a session of its own instead, and keeps its session as it was.
  private async compactThread(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    compactItem: ThreadItem,
  ): Promise<void> {
    const threadId = thread.id
    const turnId = turn.id
    let compactOpen = true
    // The turn keeps the item, first in it, only once it completes: the App
    // draws a stored contextCompaction as compacted, and Codex keeps only
    // the compactions that finished.
    // App rule: compaction-marker
    const completeCompactItem = (): void => {
      if (!compactOpen) return
      compactOpen = false
      this.store.insertItemAfter(turnId, null, compactItem)
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: compactItem, completedAtMs: nowMillis() },
      })
    }
    let agentItem: ThreadItem | null = null
    const completeAgentItem = (): void => {
      if (!agentItem) return
      let item: ThreadItem = agentItem
      agentItem = null
      try {
        const id = item.id
        item = this.store.getTurn(turnId)?.items.find((candidate) => candidate.id === id) ?? item
      } catch {}
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item, completedAtMs: nowMillis() },
      })
    }
    // An interrupt ends the turn from outside. Like Codex's, the compaction
    // it cuts short stays open, which the App shows as interrupted.
    this.closeStreamingItemsByTurn.set(turnId, () => {
      completeAgentItem()
    })
    const active = (): boolean =>
      !this.stopped &&
      this.store.getTurn(turnId)?.status === 'inProgress' &&
      this.activeTurnByThread.get(threadId) === turnId
    try {
      const current = this.store.getThread(threadId) ?? thread
      let compacted = false
      if (
        current.runtimeBackend !== 'codex' &&
        current.claudeSessionId &&
        this.runtime.compactsSessions?.() === true
      ) {
        compacted = await this.runSessionCompaction(
          peer,
          current,
          turnId,
          active,
          completeCompactItem,
        ).catch((error) => {
          debugLog('thread.compact.session_failed', {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          })
          return false
        })
      }
      if (compacted || !active()) return
      const item: ThreadItem = {
        type: 'agentMessage',
        id: newId(),
        text: '',
        phase: null,
        memoryCitation: null,
      }
      agentItem = item
      this.store.appendItem(turnId, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item, startedAtMs: nowMillis() },
      })
      try {
        await this.runCompactTurn(peer, current, turnId, item.id, active)
      } catch (error) {
        debugLog('thread.compact.fallback', {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        })
        if (!active()) return
        const fallback = compactSummary(current, this.store.listTurns(threadId))
        this.store.updateItem(turnId, item.id, (entry) =>
          entry.type === 'agentMessage' ? { ...entry, text: fallback } : entry,
        )
        this.notify(peer, {
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: item.id, delta: fallback },
        })
      }
    } finally {
      // stop() has already settled the turn and closes SQLite.
      if (!this.stopped) {
        if (active()) completeCompactItem()
        completeAgentItem()
        // An interrupt already ended the turn and told the client.
        const completed = this.endTurn(turn, 'completed', null)
        if (completed) {
          this.clearActiveTurn(threadId)
          this.setThreadStatus(peer, threadId, { type: 'idle' })
          this.notify(peer, {
            method: 'turn/completed',
            params: { threadId, turn: this.toLifecycleTurn(completed) },
          })
          this.notify(peer, { method: 'thread/compacted', params: { threadId, turnId } })
        }
      }
    }
  }

  // Sends `/compact` to the thread's Claude session the way the thread's
  // next turn would reach it: into the live session when one is up, else by
  // resuming it. True once Claude reports the conversation compacted.
  private async runSessionCompaction(
    peer: RpcPeer,
    thread: ThreadRecord,
    turnId: string,
    active: () => boolean,
    completeCompactItem: () => void,
  ): Promise<boolean> {
    // The settings of the thread's last turn keep its session's signature,
    // so the live session takes the command instead of a new one opening.
    const params = this.lastTurnParamsByThread.get(thread.id) ?? {}
    const built = this.runtimeTurnContext(thread, turnId, '/compact', params)
    // thread/compact/start carries no instructions: a bare /compact, which
    // no side-conversation note may precede either.
    const context: RuntimeTurnContext = { ...built.context, prompt: '/compact', imageInputs: [] }
    let compacted = false
    let failure: string | null = null
    await this.runtime.runTurn(context, {
      onEvent: async (event) => {
        // As in a user turn, where Claude's session ends up is where a
        // rewind to this turn resumes.
        if (event.type === 'checkpoint') {
          this.store.setTurnCheckpoint(turnId, {
            sessionId: event.claudeSessionId,
            messageUuid: event.messageUuid,
          })
          return
        }
        if (!active()) return
        if (event.type === 'session') {
          this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
          if (built.resumeSessionAt) this.store.clearClaudeResumeAt(thread.id)
          return
        }
        if (event.type === 'compaction_completed') {
          compacted = true
          completeCompactItem()
          this.recordCompactedContext(peer, thread.id, turnId, event.postTokens, false)
          return
        }
        if (event.type === 'compaction_failed') {
          failure = event.message
          this.publishNotice(peer, thread.id, turnId, event.message)
          return
        }
        if (event.type === 'notice') {
          if (event.level !== 'info') this.publishNotice(peer, thread.id, turnId, event.message)
          return
        }
        if (event.type === 'completed') {
          if (event.claudeSessionId)
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
          if (!event.success) failure = event.result ?? 'Claude did not compact the conversation'
          return
        }
        if (event.type === 'error') failure = event.message
        // What the command prints, and the usage of the summary it wrote,
        // are not part of the conversation.
      },
      // The command runs no tools and asks nothing.
      onPermissionRequest: async () => ({ decision: 'cancel' }),
      onUserInputRequest: async (event) => ({
        answers: Object.fromEntries(event.questions.map((q) => [q.id, { answers: [] }])),
      }),
    })
    if (!compacted)
      debugLog('thread.compact.session_incomplete', {
        threadId: thread.id,
        turnId,
        failure,
      })
    return compacted
  }

  // Calls into the runtime with a structured "give me a 1-paragraph summary"
  // prompt against the summary model alias (haiku), in a session of its own.
  // Streams the text into the placeholder agent message via
  // item/agentMessage/delta. Errors propagate so compactThread can
  // substitute the local snippet.
  private async runCompactTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turnId: string,
    agentItemId: string,
    active: () => boolean,
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
    // A thread on a model process profile summarizes in that profile's
    // process; any other thread on the summary model (or its profile).
    const summaryModel = resolveClaudeSummaryModelIdentity(
      thread.model,
      thread.modelProfileFingerprint ?? null,
    )
    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId,
        purpose: 'compact',
        prompt: compactPrompt,
        cwd: thread.cwd,
        runtimeType: null,
        model: summaryModel.model,
        modelProfileId: summaryModel.modelProfileId,
        modelProfileFingerprint: summaryModel.modelProfileFingerprint,
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
          if (event.type === 'text_delta' && event.delta && active()) {
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
    if (!collected.trim()) throw new Error('compaction returned no content')
  }

  private async turnStart(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw unknownThread(threadId)
    this.checkModelProfileBinding(thread)
    // Follow-up turns the adapter starts itself have no requesting peer.
    if (peer !== DETACHED_PEER) this.subscribe(threadId, peer)

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
    // A structured summary or title turn runs its model, mapped to the
    // summary model, for that turn alone; it never rebinds the thread's.
    const summaryTurn = params.outputSchema != null
    const requestedModel = modelFromParams(params, thread.model)
    // A helper thread on Claude maps a Codex model like thread/start does.
    // App rule: helper-thread-model
    const helperModel =
      !summaryTurn &&
      thread.ephemeral &&
      thread.runtimeBackend === 'claude' &&
      isCodexOpenAiModel(requestedModel) &&
      this.codexRoutingDisabled()
        ? claudeHelperModel(requestedModel)
        : null
    const model = summaryTurn ? null : (helperModel ?? requestedModel)
    // First, so a model on the other backend is refused before anything changes.
    if (model && model !== thread.model) this.setThreadModel(thread, model)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    // The App's Plan toggle. collaborationMode.mode names the mode and the
    // thread keeps it for turns that name none; the legacy planMode flag
    // sets one turn (the adapter's own follow-ups use it to stay out of
    // plan mode). A structured title or summary turn never plans.
    // App rule: collaboration-modes
    const namedMode = collaborationModeFromParams(params)
    if (namedMode) thread.collaborationMode = namedMode
    const planMode =
      !summaryTurn &&
      (namedMode != null
        ? namedMode === 'plan'
        : typeof params.planMode === 'boolean'
          ? params.planMode
          : thread.collaborationMode === 'plan')
    const reasoningEffort = reasoningEffortFromParams(params, thread.reasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
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
    // Like Codex, a reviewer named on turn/start holds for later turns too.
    // App rule: auto-review
    const reviewer = approvalsReviewerFromParams(params)
    if (reviewer) thread.approvalsReviewer = reviewer
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
    // Work started on behalf of another turn names that turn's root; as in
    // Codex, without one (or with a blank one) the turn is its own root.
    const rootTurnId = stringOr(params.rootTurnId, '')
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
      rootTurnId: rootTurnId.trim() ? rootTurnId : null,
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
      // The thread's other followers did not send the message, so they get it.
      // App rule: optimistic-user-message
      if (userItem && params._emitUserMessage === true)
        this.emitItemLifecycle(peer, threadId, turnId, userItem)
      else if (userItem && peer !== DETACHED_PEER)
        this.emitItemLifecycleToOthers(peer, threadId, turnId, userItem)
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
      this.launchRuntimeTurn(peer, thread, turn, this.modelPrompt(thread, prompt, params), {
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

  // What the runtime gets for a turn of the thread: the policy, instructions,
  // model and session a user turn with these params runs with.
  private runtimeTurnContext(
    thread: ThreadRecord,
    turnId: string,
    prompt: string,
    params: Record<string, unknown>,
  ): {
    context: RuntimeTurnContext
    isCodexThread: boolean
    resumeSessionAt: string | null
    turnCwd: string
  } {
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
          appTools: this.appToolNoteOptions(parentThread ?? thread),
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
          appTools: this.appToolNoteOptions(thread),
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
        appTools: this.appToolNoteOptions(thread),
        ...appSkills,
      })
    }

    const summaryTurn = params.outputSchema != null
    const isCodexThread = thread.runtimeBackend === 'codex' && process.env.CLAUDE_CODEX_MOCK !== '1'
    // A thread on a model process profile runs every turn in that profile:
    // its summary turns too, whatever summary model the App names, and a
    // helper thread's turns, whatever Codex model they name. Any other
    // thread's summary turns use the summary model (or the summary profile).
    const threadModelProfile = isCodexThread ? null : resolveClaudeModelProfile(thread.model)
    const rawTurnModel = threadModelProfile ? thread.model : stringOr(params.model, thread.model)
    const summaryModelIdentity =
      summaryTurn && !isCodexThread
        ? resolveClaudeSummaryModelIdentity(
            rawTurnModel,
            threadModelProfile ? (thread.modelProfileFingerprint ?? null) : null,
          )
        : null
    const modelProfileId = isCodexThread
      ? null
      : summaryModelIdentity
        ? summaryModelIdentity.modelProfileId
        : (threadModelProfile?.id ?? null)
    const modelProfileFingerprint = isCodexThread
      ? null
      : summaryModelIdentity
        ? summaryModelIdentity.modelProfileFingerprint
        : (thread.modelProfileFingerprint ?? null)
    const resolvedModel = isCodexThread
      ? rawTurnModel
      : summaryModelIdentity
        ? summaryModelIdentity.model
        : resolveClaudeModel(rawTurnModel, 'normal')
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
      turnId,
      paramsModel: params.model ?? null,
      paramsEffort: params.effort ?? null,
      threadModel: thread.model,
      threadEffort: thread.reasoningEffort,
      envDefaultModel: process.env.CLAUDE_CODEX_DEFAULT_MODEL ?? null,
      envDefaultEffort:
        process.env.CLAUDE_CODEX_DEFAULT_EFFORT ?? process.env.CLAUDE_CODEX_EFFORT ?? null,
      modelProfileId,
      modelProfileFingerprint,
      resolvedModel,
      resolvedEffort,
    })
    const forkSession =
      thread.forkedFromId != null &&
      thread.claudeSessionId != null &&
      this.store.listTurns(thread.id).length <= 1
    // Set after a rewind or fork: this turn resumes the session only up to a
    // checkpoint. It stays pending until Claude starts the forked session.
    const resumeSessionAt = isCodexThread ? null : this.store.claudeResumeAt(thread.id)
    const turnCwd = stringOr(params.cwd, thread.cwd)
    // A Claude thread's own turns also get the MCP servers, subagents,
    // permission rules and hooks the Codex and Claude Code configs bring.
    const inheritConfig = desktopPresentation && !isCodexThread
    const mcp = readMcpConfig({ cwd: turnCwd, inherit: inheritConfig })
    const permissionRules = inheritConfig ? inheritedPermissionRules(turnCwd) : null
    // The tools the client registered when it started the thread.
    const dynamicTools =
      turnPurpose === 'normal' && !isCodexThread && !thread.ephemeral && dynamicToolsEnabled()
        ? dynamicToolServers(this.store.getDynamicTools(thread.id))
        : []
    // For codex-backed threads, force the per-turn runtimeType to 'codex-proxy'
    // so the SelectableRuntime dispatches to CodexProxyRuntime instead of
    // the default Claude SDK runtime. Also route the codex session id (stored
    // separately from Claude's) through the existing claudeSessionId slot —
    // CodexProxyRuntime consumes it as the resume id. In mock mode the
    // mock runtime handles everything regardless of model id — bypass the
    // codex-proxy override so unit tests stay deterministic.
    const context: RuntimeTurnContext = {
      threadId: thread.id,
      turnId,
      purpose: turnPurpose,
      prompt: effectivePrompt,
      cwd: turnCwd,
      runtimeType: isCodexThread ? 'codex-proxy' : null,
      model: resolvedModel,
      modelProfileId,
      modelProfileFingerprint,
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
      planMode: params.planMode === true,
      // App rule: auto-review
      autoReview: thread.approvalsReviewer === 'auto_review',
      imageInputs: Array.isArray(params._imageInputs) ? (params._imageInputs as ImageInput[]) : [],
      goalTools:
        turnPurpose === 'normal' &&
        !isCodexThread &&
        !thread.ephemeral &&
        process.env.CLAUDE_CODEX_GOAL_TOOLS !== '0'
          ? this.goalToolsFor(thread.id)
          : null,
      // Title and compaction turns never show their thinking.
      thinkingDisplay:
        reasoningSummariesVisible(this.configOverrides) && turnPurpose === 'normal'
          ? 'summarized'
          : null,
      dynamicTools: dynamicTools.length > 0 ? dynamicTools : null,
      leaderTools:
        turnPurpose === 'normal' && !isCodexThread && this.leaderThreads.allowed(thread)
          ? this.leaderThreads.handlersFor(thread.id)
          : null,
      // Without the memories mapping the runtime leaves auto-memory to
      // Claude Code's own settings.
      ...(memoriesMappingEnabled()
        ? { autoMemory: !isCodexThread && this.autoMemoryFor(thread) }
        : {}),
      // Only a user who set Codex's compaction limit changes Claude's window.
      ...(isCodexThread
        ? {}
        : { autoCompactWindow: this.autoCompactWindowFor(thread.id, turnCwd) }),
      ...(continuation ? { continuation: true } : {}),
    }
    return { context, isCodexThread, resumeSessionAt, turnCwd }
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
    // What Claude Code reports beside the turn, once each: a warning, and a
    // row under the turn unless the turn is one the user does not watch.
    const noticesVisible = params.outputSchema == null
    const publishNotice = (message: string): void =>
      this.publishNotice(peer, thread.id, turn.id, message, noticesVisible)
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
    // Agents of this turn that failed on their own (not stopped, not ended by
    // the turn's own end): a turn that then fails says how many and why the
    // first one did.
    const selfFailedSubagents: { count: number; firstReason: string | null } = {
      count: 0,
      firstReason: null,
    }
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
    // Read, Grep, Glob and LS items, whose output the App keeps capped.
    const exploreItemIds = new Set<string>()
    // An image Read shows as an imageView. If Claude cannot read the image,
    // the item becomes this failed Read command instead.
    // App rule: item-completed-replaces
    const imageReadFallbacks = new Map<string, ThreadItem>()
    const failedImageRead = (
      itemId: string,
      output: string | null,
      exitCode: number | null,
      durationMs: number | null,
    ): ThreadItem | null => {
      const fallback = imageReadFallbacks.get(itemId)
      if (fallback?.type !== 'commandExecution') return null
      return { ...fallback, status: 'failed', aggregatedOutput: output, exitCode, durationMs }
    }
    // What Claude's auto-memory recalled for the turn's prompts.
    const recalledMemories: RecalledMemory[] = []
    // The item/tool/call requests of dynamic tool items still open, by item.
    const dynamicToolCalls = new Map<string, AbortController>()
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
    // The Codex App renders a reasoning item from its summary alone, so
    // Claude's thinking streams as one summary part unless summaries are off;
    // then it stays raw content, kept in history but not shown.
    // App rule: reasoning-summary
    const reasoningVisible = reasoningSummariesVisible(this.configOverrides)
    const ensureReasoningItem = (): string => {
      if (reasoningItemId) return reasoningItemId
      reasoningItemId = newId()
      const item: ThreadItem = {
        type: 'reasoning',
        id: reasoningItemId,
        summary: reasoningVisible ? [''] : [],
        content: reasoningVisible ? [] : [''],
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      if (reasoningVisible)
        this.notify(peer, {
          method: 'item/reasoning/summaryPartAdded',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: reasoningItemId,
            summaryIndex: 0,
          },
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
      // The answer cites the memories Claude recalled during the turn.
      const citation = phase === 'final_answer' ? memoryCitation(recalledMemories) : null
      // Visualize lines get their marks here and not in the deltas: the App
      // shows the completed text in place of what streamed.
      // App rule: visualize-line
      const updated = this.store.updateItem(turn.id, agentItemId, (item) =>
        item.type === 'agentMessage'
          ? {
              ...item,
              phase,
              text: markVisualizeLines(item.text),
              ...(citation ? { memoryCitation: citation } : {}),
            }
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
    const failToolItem = (itemId: string, message: string): void => {
      openToolItems.delete(itemId)
      const started = itemStartedAtMs.get(itemId)
      const durationMs = started == null ? null : Math.max(0, nowMillis() - started)
      const updated = this.store.updateItem(turn.id, itemId, (item) => {
        if (item.type === 'commandExecution') return { ...item, status: 'failed', durationMs }
        if (item.type === 'imageView')
          return failedImageRead(itemId, null, null, durationMs) ?? item
        if (item.type === 'fileChange') return { ...item, status: 'failed' }
        if (item.type === 'mcpToolCall')
          return { ...item, status: 'failed', error: { message }, durationMs }
        // Codex's shape for a call cancelled before the client answered.
        if (item.type === 'dynamicToolCall')
          return { ...item, status: 'failed', contentItems: [], success: false, durationMs }
        return item
      })
      const item = updated?.items.find((candidate) => candidate.id === itemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
      dynamicToolCalls.get(itemId)?.abort()
    }
    const completeOpenToolItems = (message: string): void => {
      for (const itemId of openToolItems) failToolItem(itemId, message)
      openToolItems.clear()
    }
    // Claude compacting the conversation within the turn, on its own when
    // the context fills up, shows as Codex's contextCompaction item. The turn
    // keeps the item only once the compaction is done, in the place it
    // started: the App draws a stored contextCompaction as compacted
    // whatever became of it. Like Codex's, a compaction an interrupt or a
    // failed turn cuts short stays open, which the App shows as interrupted.
    // One that failed while the turn went on becomes an empty reasoning item,
    // which the App does not draw, so nothing claims the context was
    // compacted; the notice that it failed says what happened.
    // App rule: compaction-marker
    // App rule: item-completed-replaces
    let compaction: { id: string; afterItemId: string | null } | null = null
    const startCompactionItem = (): void => {
      if (compaction) return
      const items = this.store.getTurn(turn.id)?.items ?? []
      compaction = { id: newId(), afterItemId: items.at(-1)?.id ?? null }
      const item: ThreadItem = { type: 'contextCompaction', id: compaction.id }
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
    }
    const completeCompactionItem = (): void => {
      if (!compaction) return
      const item: ThreadItem = { type: 'contextCompaction', id: compaction.id }
      this.store.insertItemAfter(turn.id, compaction.afterItemId, item)
      compaction = null
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
      })
    }
    const dropCompactionItem = (): void => {
      if (!compaction) return
      const item: ThreadItem = { type: 'reasoning', id: compaction.id, summary: [], content: [] }
      compaction = null
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
      })
    }
    // File tool calls drawn from Claude's streamed input whose finished call
    // has not arrived yet. Codex streams its own apply_patch input the same
    // way: the card opens with the first part of the change and grows through
    // item/fileChange/patchUpdated while the model writes the rest.
    const previewToolUseIds = new Set<string>()
    const patchFileChange = (
      toolUseId: string,
      toolName: string,
      input: Record<string, unknown>,
    ): void => {
      const itemId = itemIds.get(toolUseId)
      if (!itemId) return
      const changes = fileChangeFromTool(toolName, input)
      this.store.updateItem(turn.id, itemId, (item) =>
        item.type === 'fileChange' ? { ...item, changes } : item,
      )
      this.notify(peer, {
        method: 'item/fileChange/patchUpdated',
        params: { threadId: thread.id, turnId: turn.id, itemId, changes },
      })
    }
    // The finished call replaces what streamed, so the card, the approval and
    // the completed item show exactly the change Claude makes.
    const finishPreview = (
      toolUseId: string,
      toolName: string,
      input: Record<string, unknown>,
    ): boolean => {
      if (!previewToolUseIds.delete(toolUseId)) return false
      patchFileChange(toolUseId, toolName, input)
      return true
    }
    // A model response that ended without finishing a call (its stream broke
    // and Claude asked again) leaves a card no result will close.
    const abandonPreviews = (): void => {
      for (const toolUseId of previewToolUseIds) {
        const itemId = itemIds.get(toolUseId)
        if (itemId && openToolItems.has(itemId))
          failToolItem(itemId, 'Claude did not finish this call.')
      }
      previewToolUseIds.clear()
    }
    // App rule: declined-tool-items
    // Tool calls the user declined or Claude refused without asking. Like a
    // Codex thread's, a command or a patch ends declined, without output or
    // an exit code, as soon as it is refused; Claude's refusal result is not
    // shown. An MCP tool call has no declined state: its result ends it as
    // failed.
    const declinedToolUseIds = new Set<string>()
    const declineToolItem = (toolUseId: string): void => {
      const itemId = itemIds.get(toolUseId)
      if (!itemId || !openToolItems.has(itemId)) return
      const updated = this.store.updateItem(turn.id, itemId, (item) => {
        if (item.type === 'commandExecution')
          return {
            ...item,
            status: 'declined',
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          }
        if (item.type === 'fileChange') return { ...item, status: 'declined' }
        return item
      })
      const item = updated?.items.find((candidate) => candidate.id === itemId)
      if (item?.type !== 'commandExecution' && item?.type !== 'fileChange') return
      openToolItems.delete(itemId)
      declinedToolUseIds.add(toolUseId)
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
      })
    }
    // App rule: auto-review
    // Claude's auto-mode classifier denied a call. Like Codex's automatic
    // reviewer, that is a denied review of the call's item, which then ends
    // declined. A call with no item here (a subagent's) gets a warning.
    const reportAutoReviewDenial = (
      toolUseId: string,
      toolName: string,
      rationale: string | null,
    ): void => {
      const itemId = itemIds.get(toolUseId)
      const item = itemId
        ? this.store.getTurn(turn.id)?.items.find((candidate) => candidate.id === itemId)
        : undefined
      const action = item ? autoReviewAction(item, stringOr(params.cwd, thread.cwd)) : null
      if (!itemId || !action) {
        publishNotice(
          rationale
            ? `Permission denied for ${toolName}: ${rationale}`
            : `Permission denied for ${toolName}`,
        )
        return
      }
      const completedAtMs = nowMillis()
      this.notify(peer, {
        method: 'item/autoApprovalReview/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          startedAtMs: itemStartedAtMs.get(itemId) ?? completedAtMs,
          completedAtMs,
          reviewId: newId(),
          targetItemId: itemId,
          decisionSource: 'agent',
          review: { status: 'denied', riskLevel: null, userAuthorization: null, rationale },
          action,
        },
      })
      declineToolItem(toolUseId)
    }

    // A turn Claude starts on its own inherits the last user turn's policy,
    // model and instructions.
    if (
      params.outputSchema == null &&
      params._continuation !== true &&
      params._hiddenPrompt == null
    ) {
      const { _imageInputs: _images, _emitUserMessage: _emit, ...rest } = params
      this.lastTurnParamsByThread.set(thread.id, rest)
    }
    const { context, isCodexThread, resumeSessionAt, turnCwd } = this.runtimeTurnContext(
      thread,
      turn.id,
      prompt,
      params,
    )
    // Tool items name the MCP server by these, as server names may hold `__`.
    const toolItemOptions = {
      mcpServers: Object.keys((context.mcpServers ?? {}) as Record<string, unknown>),
    }
    let acceptRuntimeEvents = true
    let resolveWatchdog: (() => void) | null = null
    // Fails the turn after a whole window without a sign of life from the
    // subagents or workflow it waits on. Waiting on the user pauses it, and
    // a sleep of the computer starts the window over (turn-watchdog.mts).
    const watchdogTimeoutMs = subagentWatchdogTimeoutMs()
    const watchdog = new TurnWatchdog({
      timeoutMs: watchdogTimeoutMs,
      suspendedMs: () => this.sleepMonitor.suspendedMs(),
      onExpire: () => {
        // Flip this before resolving the race so an already-buffered SDK event
        // cannot create a fresh child after the watchdog has decided to fail.
        acceptRuntimeEvents = false
        resolveWatchdog?.()
      },
    })
    const watchdogPromise = watchdog.enabled
      ? new Promise<void>((resolve) => {
          resolveWatchdog = resolve
        })
      : null
    const disarmWatchdog = (): void => watchdog.disarm()
    const noteProgress = (): void => watchdog.noteProgress()
    const armWatchdog = (): void => {
      if (!acceptRuntimeEvents || (activeSubagents.size === 0 && !workflowInFlight)) return
      watchdog.arm()
    }
    this.subagentStateByTurn.set(turn.id, {
      thread,
      turn,
      contexts: subagentContexts,
      active: activeSubagents,
      noteProgress,
    })
    this.closeStreamingItemsByTurn.set(turn.id, () => {
      completeMessage()
      completeOpenToolItems('Interrupted by the user.')
    })
    this.flushQueuedSubagentActivity(peer, thread.id, turn.id)
    const turnIsActive = (): boolean =>
      !this.stopped &&
      acceptRuntimeEvents &&
      this.store.getTurn(turn.id)?.status === 'inProgress' &&
      this.activeTurnByThread.get(thread.id) === turn.id
    let resumedAtCheckpoint = false
    const runtimeTurn = this.runtime.runTurn(
      context,
      // What Claude streams, and the approvals and answers it waits on.
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
          // Anything the turn still hears (a child's output, its progress, a
          // projected workflow agent) shows it is moving; the watchdog only
          // gives up after a whole window without any of it.
          noteProgress()
          if (event.type === 'subagent_progress') return
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
              event.type === 'message_boundary' ||
              event.type === 'tool_input_progress'
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
            abandonPreviews()
            return
          }
          if (
            (event.type === 'tool_use' || event.type === 'tool_input_progress') &&
            !itemIds.has(event.toolUseId)
          )
            completeMessage()
          if (event.type === 'tool_input_progress') {
            // App rule: file-change-preview
            if (itemIds.has(event.toolUseId)) {
              if (previewToolUseIds.has(event.toolUseId))
                patchFileChange(event.toolUseId, event.toolName, event.input)
              return
            }
            const item = this.toolUseToItem({ ...event, type: 'tool_use' }, thread.cwd)
            if (item.type !== 'fileChange') return
            previewToolUseIds.add(event.toolUseId)
            itemIds.set(event.toolUseId, item.id)
            itemStartedAtMs.set(item.id, nowMillis())
            openToolItems.add(item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            this.notify(peer, {
              method: 'item/fileChange/patchUpdated',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId: item.id,
                changes: item.changes,
              },
            })
            return
          }
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
            // A fork runs on its parent's model and effort; Claude ignores
            // the Agent tool's model and effort inputs for it. Claude matches
            // the agent type ignoring case. A CLI older than the effort input
            // runs every subagent at its parent's effort.
            const forkSubagent = subType?.trim().toLowerCase() === 'fork'
            const subagentModel =
              !forkSubagent && typeof event.input.model === 'string'
                ? event.input.model
                : thread.model
            const effortInput =
              !forkSubagent &&
              claudeCodeAtLeast(
                this.runtime.cliVersion?.(thread.id),
                CLAUDE_CODE_AGENT_EFFORT_VERSION,
              )
            const subagentEffort =
              (effortInput ? subagentEffortFromInput(event.input.effort) : null) ??
              thread.reasoningEffort
            const childThreadId = newThreadId()
            // The id's random tail: its head is a timestamp, shared by agents
            // spawned in the same millisecond.
            const agentNickname = `agent-${childThreadId.replace(/-/g, '').slice(-12)}`
            // A subagent's own Agent call nests the new child under that
            // agent's child thread. Without the agent's id (older CLIs) every
            // child hangs off this thread, as before.
            const host = this.nestingHost(thread.id, subagentContexts, event.agentId)
            const hostThreadId = host?.childThreadId ?? thread.id
            const hostTurnId = host?.childTurnId ?? turn.id
            const agentPath = `${host?.agentPath ?? '/root'}/${agentNickname}`
            const agentRole = subType ?? 'general-purpose'
            const childStartedAt = nowSeconds()
            // The child is named when it is announced: what the parent called
            // the agent, else its type and the first line of its prompt. The
            // App shows a subagent thread's name as its title and generates
            // one only for a child announced without a name.
            // App rule: subagent-titles
            const childName = subagentThreadName({
              description: event.input.description,
              subType,
              prompt: promptText,
            })
            const childThread: ThreadRecord = {
              id: childThreadId,
              sessionId: thread.sessionId,
              forkedFromId: hostThreadId,
              isPinned: false,
              sectionId: null,
              sectionEnteredAt: null,
              sectionPosition: null,
              preview: promptText.slice(0, 200),
              name: childName,
              archived: false,
              cwd: thread.cwd,
              // The subagent runs inside the parent's model process profile,
              // so its record carries that profile rather than Task's alias.
              model: thread.modelProfileFingerprint ? thread.model : subagentModel,
              modelProfileFingerprint: thread.modelProfileFingerprint ?? null,
              reasoningEffort: subagentEffort,
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
            // Child notifications must follow the parent's current followers.
            // This matters after unix-daemon reconnects, when the old peer is
            // gone before the child publishes its response.
            this.subscribe(childThreadId, peer)
            for (const follower of this.subscribersOf(thread.id))
              this.subscribe(childThreadId, follower)
            if (host)
              for (const follower of this.subscribersOf(hostThreadId))
                this.subscribe(childThreadId, follower)
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
              // A spawned agent works for the turn that spawned it, as in Codex.
              rootTurnId: turn.rootTurnId ?? turn.id,
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
              parentThreadId: hostThreadId,
              parentTurnId: hostTurnId,
              childThreadId,
              model: subagentModel,
              agentRole,
              agentNickname,
              ...(host ? { rootThreadId: thread.id, rootTurnId: turn.id } : {}),
            })

            // Stage 1 — spawnAgent (begin + end emitted together; the agent is
            // already created so there's no real latency here).
            const spawnId = newId()
            // Codex v2 collabAgentToolCall.reasoningEffort is `ReasoningEffort | null`
            // (strict enum: none|minimal|low|medium|high|xhigh|max). Same Oops trap as
            // threadSource — an empty string from a sloppy resume crashes the App.
            // Normalize here once and reuse for every stage of the lifecycle.
            const collabEffort = normalizeReasoningEffortEnum(subagentEffort)
            // The App finds an agent's child through the spawn item of the
            // conversation the child names as its parent, so a nested agent's
            // items live in its host's turn.
            // App rule: nested-subagent
            const spawnBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: hostThreadId,
              receiverThreadIds: [],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: {},
            }
            this.store.appendItem(hostTurnId, spawnBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: hostThreadId,
                turnId: hostTurnId,
                item: spawnBegin,
                startedAtMs: nowMillis(),
              },
            })
            const spawnEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: hostThreadId,
              receiverThreadIds: [childThreadId],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: { [childThreadId]: { status: 'running', message: null } },
            }
            this.store.updateItem(hostTurnId, spawnId, () => spawnEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: hostThreadId,
                turnId: hostTurnId,
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
              ...(host ? { hostThreadId, hostTurnId } : {}),
            }
            this.emitSubagentActivity(peer, hostThreadId, hostTurnId, subagentContext, 'started')

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
                senderThreadId: hostThreadId,
                receiverThreadIds: [childThreadId],
                prompt: null,
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              }
              this.store.appendItem(hostTurnId, waitBegin)
              this.notify(peer, {
                method: 'item/started',
                params: {
                  threadId: hostThreadId,
                  turnId: hostTurnId,
                  item: waitBegin,
                  startedAtMs: nowMillis(),
                },
              })
            }

            // The turn keeps track of every agent it runs, nested ones too:
            // they are its own for the watchdog and for its end.
            itemIds.set(event.toolUseId, waitId)
            subagentContexts.set(event.toolUseId, subagentContext)
            activeSubagents.add(event.toolUseId)
            armWatchdog()
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
            if (!ctx) return
            // The runtime closed the agent's call because this turn is ending.
            // The agent did not fail on its own: it ends with the turn, below,
            // saying why the turn ended.
            // App rule: subagent-failure-reason
            if (event.endedWithTurn) return
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
            const stopped =
              ctx.stoppedByUser === true || (event.isError === true && ctx.stopRequested === true)
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
            // Where the agent's collab items live: its host agent's thread
            // for a nested agent, this one otherwise.
            const hostThreadId = ctx.hostThreadId ?? thread.id
            const hostTurnId = ctx.hostTurnId ?? turn.id
            // Why the agent did not complete, told in its child turn's error
            // and in its state on the parent's collab items. Its full text
            // stays the child's last message.
            // App rule: subagent-failure-reason
            const failureReason = stopped
              ? SUBAGENT_STOPPED_BY_USER
              : event.isError
                ? subagentFailureReason(resultText)
                : null
            if (event.isError && !stopped && failureReason) {
              selfFailedSubagents.count += 1
              selfFailedSubagents.firstReason ??= failureReason
            }

            // A child the user stopped ends as interrupted, once: the stop
            // has usually ended it already.
            const currentChildTurn = this.store.getTurn(ctx.childTurnId)
            const childTurn =
              stopped && currentChildTurn && currentChildTurn.status !== 'inProgress'
                ? currentChildTurn
                : this.completeSubagentChildTurn(
                    peer,
                    ctx,
                    stopped ? SUBAGENT_STOPPED_BY_USER : resultText,
                    stopped ? 'interrupted' : event.isError ? 'failed' : 'completed',
                    failureReason ? subagentTurnError(failureReason) : null,
                    parsed.usage?.durationMs ?? null,
                  )
            recordRunEvent('subagent.completed', {
              parentThreadId: hostThreadId,
              parentTurnId: hostTurnId,
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
              hostThreadId,
              hostTurnId,
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
            // A nested agent's siblings are the other agents of its host;
            // the agent the host itself is runs on regardless.
            const siblingRunning = ctx.hostThreadId
              ? [...activeSubagents].some(
                  (id) =>
                    id !== event.toolUseId &&
                    subagentContexts.get(id)?.hostThreadId === ctx.hostThreadId,
                ) || this.hostHasRunningBackgroundSubagent(ctx.hostThreadId)
              : [...activeSubagents].some((id) => id !== event.toolUseId) ||
                this.hasRunningBackgroundSubagent(thread.id)
            const waitEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: ctx.waitItemId,
              tool: 'wait',
              status: siblingRunning ? 'failed' : collabStatus,
              senderThreadId: hostThreadId,
              receiverThreadIds: [ctx.childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {
                [ctx.childThreadId]: { status: agentStatus, message: failureReason },
              },
            }
            this.store.updateItemAndMoveToEnd(hostTurnId, ctx.waitItemId, () => waitEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: hostThreadId,
                turnId: hostTurnId,
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
            if (event.isError) {
              this.emitLegacyCloseAgent(
                peer,
                hostThreadId,
                hostTurnId,
                ctx.childThreadId,
                collabStatus,
                { [ctx.childThreadId]: { status: agentStatus, message: failureReason } },
              )
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
              if (item.type !== 'reasoning') return item
              return reasoningVisible
                ? { ...item, summary: [(item.summary[0] ?? '') + event.delta] }
                : { ...item, content: [(item.content[0] ?? '') + event.delta] }
            })
            this.notify(peer, {
              method: reasoningVisible
                ? 'item/reasoning/summaryTextDelta'
                : 'item/reasoning/textDelta',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                delta: event.delta,
                ...(reasoningVisible ? { summaryIndex: 0 } : { contentIndex: 0 }),
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
            // A file change already drawn from the streamed input keeps its
            // card and takes the finished input.
            if (finishPreview(event.toolUseId, event.toolName, event.input)) return
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
            const item = this.toolUseToItem(event, thread.cwd, toolItemOptions)
            itemIds.set(event.toolUseId, item.id)
            itemStartedAtMs.set(item.id, nowMillis())
            openToolItems.add(item.id)
            // Read, Grep, Glob and LS calls never run as background shells.
            if (isExploreTool(event.toolName)) exploreItemIds.add(item.id)
            else if (item.type === 'commandExecution')
              this.rememberCommandItem(event.toolUseId, thread.id, turn.id, item.id)
            if (item.type === 'imageView')
              imageReadFallbacks.set(item.id, {
                ...this.toolUseToItem(event, thread.cwd, { imageView: false }),
                id: item.id,
              })
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
            // Output that comes after the result is not the item's any more.
            if (!itemId || !openToolItems.has(itemId)) return
            commandOutputSeen.add(itemId)
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return {
                  ...item,
                  aggregatedOutput: appendCommandOutput(item.aggregatedOutput, event.delta),
                }
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
            if (!itemId || declinedToolUseIds.has(event.toolUseId)) return
            openToolItems.delete(itemId)
            const resultText = toolResultText(event.content)
            const durationMs = (() => {
              const started = itemStartedAtMs.get(itemId)
              return started == null ? null : Math.max(0, nowMillis() - started)
            })()
            const parsedExitCode = parseExitCodeFromResult(event.content) ?? (event.isError ? 1 : 0)
            const output = exploreItemIds.has(itemId) ? capOutput(resultText) : resultText
            const updated = this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  // The result has all of the output, where what streamed in
                  // may have skipped some.
                  aggregatedOutput:
                    commandOutputSeen.has(itemId) && output
                      ? output
                      : (item.aggregatedOutput ?? output),
                  exitCode: parsedExitCode,
                  durationMs,
                }
              }
              if (item.type === 'imageView' && event.isError)
                return failedImageRead(itemId, output, parsedExitCode, durationMs) ?? item
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
              // A webSearch keeps the action it started with: its results
              // always hold links, but a search is not a page open.
              return item
            })
            const item = updated?.items.find((candidate) => candidate.id === itemId)
            // A failed image Read was an imageView in the App until now; its
            // output arrives with the completed item instead.
            if (
              item?.type === 'commandExecution' &&
              output &&
              !commandOutputSeen.has(itemId) &&
              !imageReadFallbacks.has(itemId)
            ) {
              this.notify(peer, {
                method: 'item/commandExecution/outputDelta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: output },
              })
            }
            if (item)
              this.notify(peer, {
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
              })
            // A whole-tree diff after every tool is wasted on a client that
            // opted out of hearing it (every follower of the thread, when
            // several are); the turn's end still records one.
            const targets = this.targetsForParams(peer, { threadId: thread.id })
            if (targets.every((target) => this.optedOut(target, 'turn/diff/updated'))) return
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
          if (event.type === 'compaction_started') {
            // What Claude said so far stays above the compaction.
            completeMessage()
            startCompactionItem()
            return
          }
          if (event.type === 'compaction_completed') {
            // A boundary can arrive without the status before it.
            completeMessage()
            startCompactionItem()
            completeCompactionItem()
            this.notify(peer, {
              method: 'thread/compacted',
              params: { threadId: thread.id, turnId: turn.id },
            })
            this.recordCompactedContext(peer, thread.id, turn.id, event.postTokens, true)
            return
          }
          if (event.type === 'compaction_failed') {
            debugLog('turn.runtime.compaction_failed', {
              threadId: thread.id,
              turnId: turn.id,
              message: event.message,
            })
            dropCompactionItem()
            publishNotice(event.message)
            return
          }
          if (event.type === 'memory_recall') {
            recalledMemories.push(...event.memories)
            return
          }
          if (event.type === 'proposed_plan') {
            if (event.text.trim()) deliverPlan(event.text)
            return
          }
          if (event.type === 'tool_denied') {
            if (event.autoReview)
              reportAutoReviewDenial(
                event.toolUseId,
                event.toolName ?? 'tool',
                event.autoReview.rationale,
              )
            else declineToolItem(event.toolUseId)
            return
          }
          if (event.type === 'auto_review_unavailable') {
            this.autoReviewUnavailable(peer, thread.id, event.reason)
            thread.approvalsReviewer = 'user'
            return
          }
          if (event.type === 'notice') {
            debugLog('turn.runtime.notice', { threadId: thread.id, turnId: turn.id, ...event })
            // Runtime status is not assistant prose: genuine warnings go out
            // as notices, beside the transcript and without breaking its
            // Markdown.
            if (event.level !== 'info') publishNotice(event.message)
            return
          }
          if (event.type === 'retrying') {
            debugLog('turn.runtime.retrying', { threadId: thread.id, turnId: turn.id, ...event })
            // Codex reports a model request it will send again as an `error`
            // with willRetry, which the App shows as a passing
            // "Reconnecting" row; like Codex, it is not kept in history.
            // Helper turns the App starts for structured output show nothing.
            if (context.purpose !== 'normal') return
            // A subagent's retry shows in its own thread, while its turn
            // runs; one whose agent is gone or unknown shows nowhere, never
            // in this turn.
            // App rule: reconnecting-errors
            if (event.toolUseId) {
              const agent =
                subagentContexts.get(event.toolUseId) ??
                this.findBackgroundSubagent(thread.id, { toolUseId: event.toolUseId })?.context
              if (!agent || this.store.getTurn(agent.childTurnId)?.status !== 'inProgress') return
              this.notify(peer, {
                method: 'error',
                params: {
                  threadId: agent.childThreadId,
                  turnId: agent.childTurnId,
                  willRetry: true,
                  error: retryTurnError(event),
                },
              })
              return
            }
            this.notify(peer, {
              method: 'error',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                willRetry: true,
                error: retryTurnError(event),
              },
            })
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
            this.recordUsageProgress(peer, thread.id, turn.id, event.messageId, event.usage)
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
            // reroute; any other fallback is a notice.
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
              publishNotice(event.message)
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
            if (!event.success)
              throw turnFailure(event.result ?? 'Claude turn failed', event.failure)
          }
          if (event.type === 'error') {
            throw new Error(event.message)
          }
        },
        onPermissionRequest: async (event) => {
          if (!turnIsActive()) return { decision: 'cancel' }
          completeMessage()
          // The request can overtake the finished call; the approval must
          // show the whole change, not the part that streamed.
          finishPreview(event.toolUseId, event.toolName, event.input)
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
              // The approval card asks about the Read command, so the item
              // is that command, not the image it may show.
              { ...toolItemOptions, imageView: false },
            )
            itemId = item.id
            itemIds.set(event.toolUseId, item.id)
            openToolItems.add(item.id)
            if (isExploreTool(event.toolName)) exploreItemIds.add(item.id)
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
          const decision = await watchdog.whilePaused(
            this.requestApproval(
              peer,
              thread.id,
              turn.id,
              itemId,
              event,
              imageReadFallbacks.get(itemId),
            ),
          )
          if (!turnIsActive()) return { decision: 'cancel' }
          if (decision.decision === 'decline' || decision.decision === 'cancel')
            declineToolItem(event.toolUseId)
          if (decision.decision === 'cancel') {
            // Cancel declines the call and stops the turn, as on a Codex
            // thread. The turn ends interrupted now, so what Claude sends
            // while it stops is dropped like after turn/interrupt.
            this.settleInterruptedTurn(peer, thread.id, turn.id)
            void this.runtime.interrupt(thread.id).catch(() => {})
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
          const answers = await watchdog.whilePaused(
            this.requestUserInput(peer, thread.id, turn.id, item.id, event.questions),
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
          return watchdog.whilePaused(
            this.requestElicitation(peer, thread.id, turn.id, request, signal),
          )
        },
        // Claude called one of the client's dynamic tools: a dynamicToolCall
        // item around the item/tool/call request, as Codex records it.
        onDynamicToolCall: async (request, signal) => {
          if (!turnIsActive()) return dynamicToolFailure(DYNAMIC_TOOL_CANCELLED)
          completeMessage()
          const item: ThreadItem = {
            type: 'dynamicToolCall',
            id: request.callId,
            namespace: request.namespace,
            tool: request.tool,
            arguments: request.arguments,
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          }
          const startedAt = nowMillis()
          itemStartedAtMs.set(item.id, startedAt)
          openToolItems.add(item.id)
          this.store.appendItem(turn.id, item)
          this.notify(peer, {
            method: 'item/started',
            params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: startedAt },
          })
          const abort = new AbortController()
          dynamicToolCalls.set(item.id, abort)
          const response = await watchdog.whilePaused(
            this.requestDynamicTool(
              peer,
              thread.id,
              turn.id,
              request,
              AbortSignal.any([signal, abort.signal]),
            ),
          )
          dynamicToolCalls.delete(item.id)
          // An interrupt or the end of the turn closed the item already.
          if (!openToolItems.delete(item.id))
            return response ?? dynamicToolFailure(DYNAMIC_TOOL_CANCELLED)
          const durationMs = Math.max(0, nowMillis() - startedAt)
          const completedItem: ThreadItem = response
            ? {
                ...item,
                status: response.success ? 'completed' : 'failed',
                contentItems: response.contentItems,
                success: response.success,
                durationMs,
              }
            : { ...item, status: 'failed', contentItems: [], success: false, durationMs }
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
          return response ?? dynamicToolFailure(DYNAMIC_TOOL_CANCELLED)
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
        void this.releaseStalledTurn(thread.id, turn.id).catch(() => {})
      }
      // App rule: subagent-failure-reason
      throw withSubagentFailures(new Error(message), selfFailedSubagents)
    }
    if (outcome.kind === 'rejected') {
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        completeMessage()
        completeOpenToolItems(outcome.error.message)
        // An agent still running ends with its parent, which says why.
        // App rule: subagent-failure-reason
        const parentReason = clipText(collapseWhitespace(outcome.error.message), 200)
        this.finalizeOrphanedSubagents(
          peer,
          thread,
          turn,
          subagentContexts,
          activeSubagents,
          parentReason
            ? `Ended because the parent turn failed: ${parentReason}`
            : 'Ended because the parent turn failed.',
        )
      }
      this.subagentStateByTurn.delete(turn.id)
      throw withSubagentFailures(outcome.error, selfFailedSubagents)
    }
    if (this.store.getTurn(turn.id)?.status === 'inProgress') {
      completeOpenToolItems('Claude finished the turn without a result for this tool.')
      // A compaction that never reached its boundary failed; the turn went
      // on without it, and the context was not compacted.
      dropCompactionItem()
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
    this.exitReviewMode(peer, thread.id, turn.id)
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
    // terminal kind besides interrupted, so it only ever gets that one:
    // peerTakesNotification decides for each follower, whoever started the
    // turn.
    // App rule: subagent-completed-kind
    this.emitItemLifecycle(peer, parentThreadId, parentTurnId, item)
  }

  // A follower without the completed activity kind gets a closeAgent after a
  // failed child, or its agent list never lets the child go. History keeps
  // the items, marked, for such an App reading the thread back, unless only
  // Apps with the completed kind follow: an App with that kind hides the
  // child if it reads them.
  // App rule: subagent-close-hides
  private emitLegacyCloseAgent(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    childThreadId: string,
    status: 'completed' | 'failed',
    agentsStates: Extract<ThreadItem, { type: 'collabAgentToolCall' }>['agentsStates'],
  ): void {
    const legacy = this.targetsForParams(peer, { threadId }).filter(
      (target) => !this.supportsCompletedSubagentActivity(target),
    )
    if (legacy.length === 0) return
    const closeId = newId()
    const closeBegin: ThreadItem = {
      type: 'collabAgentToolCall',
      id: closeId,
      tool: 'closeAgent',
      status: 'inProgress',
      senderThreadId: threadId,
      receiverThreadIds: [childThreadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    }
    this.store.appendItem(turnId, { ...closeBegin, legacyOnly: true })
    for (const target of legacy)
      this.sendNotification(target, {
        method: 'item/started',
        params: { threadId, turnId, item: closeBegin, startedAtMs: nowMillis() },
      })
    const closeEnd: ThreadItem = { ...closeBegin, status, agentsStates }
    this.store.updateItem(turnId, closeId, () => ({ ...closeEnd, legacyOnly: true }))
    for (const target of legacy)
      this.sendNotification(target, {
        method: 'item/completed',
        params: { threadId, turnId, item: closeEnd, completedAtMs: nowMillis() },
      })
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
    // Thinking stored before it went to the summary shows as one, too.
    // App rule: reasoning-summary
    const visibleReasoning = reasoningSummariesVisible(this.configOverrides)
    const withReasoningSummary = (item: unknown): unknown => {
      const record = asRecord(item)
      if (!visibleReasoning || record.type !== 'reasoning') return item
      const filled = (parts: unknown): string[] =>
        Array.isArray(parts)
          ? parts.filter((part): part is string => typeof part === 'string' && part.length > 0)
          : []
      const content = filled(record.content)
      if (filled(record.summary).length > 0 || content.length === 0) return item
      return { ...record, summary: content }
    }
    const itemForPeer = (item: unknown): unknown =>
      withReasoningSummary(withVisualizeMarks(unmarked(item)))
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

  // The item's lifecycle for the thread's followers other than `peer`.
  private emitItemLifecycleToOthers(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    item: ThreadItem,
  ): void {
    for (const other of this.subscribersOf(threadId)) {
      if (other.id === peer.id) continue
      this.sendNotification(other, {
        method: 'item/started',
        params: { threadId, turnId, item, startedAtMs: nowMillis() },
      })
      this.sendNotification(other, {
        method: 'item/completed',
        params: { threadId, turnId, item, completedAtMs: nowMillis() },
      })
    }
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
    // Deepest first: a nested agent ends inside its host's turn, before the
    // host agent's turn does. Agents of one depth keep their order.
    const depth = (toolUseId: string): number =>
      contexts.get(toolUseId)?.agentPath.split('/').length ?? 0
    for (const toolUseId of Array.from(active).sort((a, b) => depth(b) - depth(a))) {
      const context = contexts.get(toolUseId)
      active.delete(toolUseId)
      contexts.delete(toolUseId)
      if (!context) continue
      const hostThreadId = context.hostThreadId ?? thread.id
      const hostTurnId = context.hostTurnId ?? turn.id

      const message = failureMessage
      // The child's turn says why it ended, interrupted as well as failed;
      // the App draws the error of a failed turn only.
      // App rule: subagent-failure-reason
      const childTurn = this.completeSubagentChildTurn(
        peer,
        context,
        message,
        status,
        subagentTurnError(message),
      )
      recordRunEvent('subagent.completed', {
        parentThreadId: hostThreadId,
        parentTurnId: hostTurnId,
        childThreadId: context.childThreadId,
        childTurnId: childTurn.id,
        status,
        agentRole: context.subType ?? 'general-purpose',
      })

      this.emitSubagentActivity(peer, hostThreadId, hostTurnId, context, 'interrupted')

      const waitEnd: ThreadItem = {
        type: 'collabAgentToolCall',
        id: context.waitItemId,
        tool: 'wait',
        status: 'failed',
        senderThreadId: hostThreadId,
        receiverThreadIds: [context.childThreadId],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { [context.childThreadId]: { status: agentState, message } },
      }
      this.store.updateItemAndMoveToEnd(hostTurnId, context.waitItemId, () => waitEnd)
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: hostThreadId,
          turnId: hostTurnId,
          item: waitEnd,
          completedAtMs: nowMillis(),
        },
      })
      this.emitLegacyCloseAgent(peer, hostThreadId, hostTurnId, context.childThreadId, 'failed', {
        [context.childThreadId]: { status: agentState, message },
      })
    }
  }

  // The thread's latest follower, standing in for all of them: notify() and
  // sendServerRequest() fan out by thread id.
  private peerForThread(threadId: string): RpcPeer {
    return this.targetsForParams(DETACHED_PEER, { threadId }).at(-1) ?? DETACHED_PEER
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
    const hostThreadId = context.hostThreadId ?? thread.id
    const hostTurnId = context.hostTurnId ?? turn.id
    const waitEnd: ThreadItem = {
      type: 'collabAgentToolCall',
      id: context.waitItemId,
      tool: 'wait',
      status: 'failed',
      senderThreadId: hostThreadId,
      receiverThreadIds: [context.childThreadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: { [context.childThreadId]: { status: 'running', message: null } },
    }
    const updated = this.store.updateItem(hostTurnId, context.waitItemId, () => waitEnd)
    if (updated?.items.some((item) => item.id === context.waitItemId))
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: hostThreadId,
          turnId: hostTurnId,
          item: waitEnd,
          completedAtMs: nowMillis(),
        },
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

  // The agent whose own Agent call this is, when the frame names it by task
  // id (agent_id, newer CLIs) and it is still working in this turn or in the
  // background: the new child then hangs off that agent's child thread.
  // Null for the main loop's calls, for an older CLI and for a host whose
  // child turn is over, which leaves the child under the parent thread.
  private nestingHost(
    threadId: string,
    contexts: Map<string, SubagentContext>,
    agentId: string | undefined,
  ): SubagentContext | null {
    if (!agentId) return null
    let host: SubagentContext | null = null
    for (const [toolUseId, context] of contexts) {
      if (this.taskIdByToolUse.get(toolUseId) !== agentId) continue
      host = context
      break
    }
    if (!host) {
      const entry = this.findBackgroundSubagent(threadId, { taskId: agentId })
      if (entry?.running) host = entry.context
    }
    if (!host || this.store.getTurn(host.childTurnId)?.status !== 'inProgress') return null
    return host
  }

  private hostHasRunningBackgroundSubagent(hostThreadId: string): boolean {
    for (const entry of this.backgroundSubagents.values())
      if (entry.running && entry.context.hostThreadId === hostThreadId) return true
    return false
  }

  // Whether a subagent thread sits somewhere below the given thread.
  private isSubagentDescendant(threadId: string, ancestorThreadId: string): boolean {
    const seen = new Set<string>()
    let current = this.store.getThread(threadId)
    while (current?.threadSource === 'subagent' && current.forkedFromId) {
      if (current.forkedFromId === ancestorThreadId) return true
      if (seen.has(current.id)) return false
      seen.add(current.id)
      current = this.store.getThread(current.forkedFromId)
    }
    return false
  }

  // A child that ran in the foreground, or before a restart, has no entry,
  // yet SendMessage resumes it all the same: the CLI runs it on in the
  // background. Track it from then on like any background agent.
  private adoptChildAgent(
    thread: ThreadRecord,
    turnId: string,
    agentId: string,
  ): BackgroundSubagent | null {
    // A direct child first; then one nested below another agent.
    const child =
      this.store
        .listThreads({ includeEphemeral: true, parentThreadId: thread.id, limit: 200 })
        .find((candidate) => candidate.agentNickname === agentId) ??
      this.store
        .listThreads({
          includeEphemeral: true,
          ancestorThreadId: thread.id,
          sourceKinds: ['subAgentThreadSpawn'],
          limit: 200,
        })
        .find(
          (candidate) =>
            candidate.agentNickname === agentId &&
            this.isSubagentDescendant(candidate.id, thread.id),
        )
    // A child still inside its Agent call is not this one's to take over.
    if (!child || this.store.lastTurnStatus(child.id) === 'inProgress') return null
    const hostThreadId = child.forkedFromId ?? thread.id
    const hostTurns = this.store.listTurns(hostThreadId)
    const marker = hostTurns
      .flatMap((hostTurn) => hostTurn.items)
      .find((item) => item.type === 'subAgentActivity' && item.agentThreadId === child.id)
    const hostTurnId = hostTurns.at(-1)?.id
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
        ...(hostThreadId !== thread.id && hostTurnId ? { hostThreadId, hostTurnId } : {}),
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

  private rememberCommandItem(
    toolUseId: string,
    threadId: string,
    turnId: string,
    itemId: string,
  ): void {
    this.commandItems.set(toolUseId, { threadId, turnId, itemId })
    if (this.commandItems.size > MAX_TRACKED_COMMAND_ITEMS) {
      const oldest = this.commandItems.keys().next().value
      if (oldest !== undefined) this.commandItems.delete(oldest)
    }
  }

  // A background shell goes on printing after its Bash call returned and the
  // call's item completed, maybe after its turn ended. The App appends the
  // output to that item wherever it is.
  // App rule: command-output-after-completion
  private appendBackgroundOutput(
    threadId: string,
    event: Extract<RuntimeTaskEvent, { type: 'task_output' }>,
  ): void {
    const at = this.commandItems.get(event.toolUseId)
    if (!at || at.threadId !== threadId || !event.delta) return
    let found = false
    this.store.updateItem(at.turnId, at.itemId, (item) => {
      if (item.type !== 'commandExecution') return item
      found = true
      return { ...item, aggregatedOutput: appendCommandOutput(item.aggregatedOutput, event.delta) }
    })
    if (!found) return
    this.notify(this.peerForThread(threadId), {
      method: 'item/commandExecution/outputDelta',
      params: { threadId, turnId: at.turnId, itemId: at.itemId, delta: event.delta },
    })
  }

  private handleTaskEvent(threadId: string, event: RuntimeTaskEvent): void {
    if (event.type === 'task_output') {
      this.appendBackgroundOutput(threadId, event)
      return
    }
    // A foreground agent's progress keeps the turn waiting on it from giving
    // up on it.
    const toolUseId = event.type === 'task_updated' ? null : event.toolUseId
    if (toolUseId) {
      for (const state of this.subagentStateByTurn.values()) {
        if (state.thread.id === threadId && state.active.has(toolUseId)) state.noteProgress()
      }
    }
    if (event.type === 'task_started') {
      if (!event.toolUseId) return
      const entry = this.findBackgroundSubagent(threadId, { toolUseId: event.toolUseId })
      if (entry) entry.taskId = event.taskId
      else this.rememberTaskId(event.toolUseId, event.taskId)
      if (event.parentTaskId) this.checkNestingParent(threadId, event.toolUseId, event.parentTaskId)
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
          event.status === 'completed'
            ? undefined
            : taskEndReason(
                event.status,
                event.summary,
                event.result,
                this.store.getThread(entry.context.childThreadId)?.name ?? null,
              ),
        )
        return
    }
  }

  // task_started names the agent that launched a nested one (parent_task_id).
  // Its spawning frame's agent_id placed the child already, as the thread
  // must exist before the task starts; a disagreement only goes to the log.
  private checkNestingParent(threadId: string, toolUseId: string, parentTaskId: string): void {
    const states = [...this.subagentStateByTurn.values()].filter(
      (state) => state.thread.id === threadId,
    )
    const context =
      states.map((state) => state.contexts.get(toolUseId)).find(Boolean) ??
      this.findBackgroundSubagent(threadId, { toolUseId })?.context
    if (!context) return
    const hostTaskIds = new Set<string>()
    if (context.hostThreadId) {
      for (const state of states)
        for (const [id, candidate] of state.contexts) {
          const taskId = this.taskIdByToolUse.get(id)
          if (candidate.childThreadId === context.hostThreadId && taskId) hostTaskIds.add(taskId)
        }
      const background = this.backgroundSubagents.get(context.hostThreadId)
      if (background?.taskId) hostTaskIds.add(background.taskId)
      if (background?.agentId) hostTaskIds.add(background.agentId)
    }
    if (hostTaskIds.has(parentTaskId)) return
    debugLog('subagent.nesting_mismatch', {
      threadId,
      toolUseId,
      parentTaskId,
      hostThreadId: context.hostThreadId ?? null,
    })
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
    // Why it did not complete, when `text` is not that already.
    reason?: string,
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
        status === 'completed' ? null : subagentTurnError(reason ?? subagentFailureReason(text)),
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
    this.checkIdle()
  }

  // Subagent activity belongs to a parent turn. A background agent usually
  // reports after that turn ended; hold the item for the turn Claude starts
  // to answer it (or the user's next one). A nested agent reports to its
  // host's child turn while that runs, else to the parent thread like any
  // other.
  // App rule: nested-subagent
  private publishSubagentActivity(
    parentThreadId: string,
    context: SubagentContext,
    kind: SubagentActivityKind,
  ): void {
    if (
      context.hostThreadId &&
      context.hostTurnId &&
      this.store.getTurn(context.hostTurnId)?.status === 'inProgress'
    ) {
      const peer = this.peerForThread(context.hostThreadId)
      this.emitSubagentActivity(peer, context.hostThreadId, context.hostTurnId, context, kind)
      return
    }
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
    this.resumeBackgroundChild(entry, pending.message, event.toolUseId, turn.rootTurnId ?? turn.id)
    this.emitSubagentActivity(peer, thread.id, turn.id, entry.context, 'interacted')
  }

  // rootTurnId: the root of the parent turn that sent the message, which a
  // turn it starts in the child works for, as in Codex.
  private resumeBackgroundChild(
    entry: BackgroundSubagent,
    message: string,
    sendToolUseId: string,
    rootTurnId: string,
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
        rootTurnId,
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

  // A notice the runtime raises outside any turn's stream, such as a call a
  // background agent made between turns that had to be refused. It shows
  // under the thread's running turn, else under its last one; a thread
  // without turns only gets the warning.
  // App rule: turn-notices
  private handleRuntimeNotice(threadId: string, message: string): void {
    if (this.stopped || !this.store.getThread(threadId)) return
    const turnId =
      this.activeTurnByThread.get(threadId) ?? this.store.lastTurnRef(threadId)?.id ?? null
    debugLog('thread.notice', { threadId, turnId })
    this.publishNotice(this.peerForThread(threadId), threadId, turnId, message)
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
      this.checkIdle()
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
    this.checkIdle()
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
    this.settleBackgroundSubagent(entry, 'interrupted', SUBAGENT_STOPPED_BY_USER, null)
  }

  // Stops one foreground child of a running parent turn through its CLI task.
  // The parent's Agent call then returns and the parent keeps going.
  private async stopForegroundSubagent(peer: RpcPeer, childThreadId: string): Promise<boolean> {
    for (const state of this.subagentStateByTurn.values()) {
      for (const toolUseId of state.active) {
        const context = state.contexts.get(toolUseId)
        if (
          context?.childThreadId !== childThreadId ||
          context.stoppedByUser ||
          context.stopRequested
        )
          continue
        const taskId = this.taskIdByToolUse.get(toolUseId)
        // The agent's call can return before the CLI confirms the stop.
        // App rule: subagent-failure-reason
        if (taskId) context.stopRequested = true
        const stopped = taskId
          ? await this.runtime.stopTask?.(state.thread.id, taskId).catch(() => false)
          : false
        context.stopRequested = false
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
        // Unless its call returned meanwhile and ended it.
        if (this.store.getTurn(context.childTurnId)?.status === 'inProgress')
          this.completeSubagentChildTurn(
            peer,
            context,
            SUBAGENT_STOPPED_BY_USER,
            'interrupted',
            subagentTurnError(SUBAGENT_STOPPED_BY_USER),
          )
        return true
      }
    }
    return false
  }

  // The App tools a Claude thread has by another route, which its tool
  // availability note leaves out: the client's dynamic tools and, with
  // leader tools on, the App thread tools they stand in for. Such a thread
  // also reports the chats it starts as Codex does.
  // App rule: app-tool-availability
  private appToolNoteOptions(thread: ThreadRecord): AppToolNoteOptions {
    const available = new Set<string>()
    if (!thread.ephemeral && dynamicToolsEnabled())
      for (const server of dynamicToolServers(this.store.getDynamicTools(thread.id)))
        for (const tool of server.tools) available.add(tool.name)
    const leader = this.leaderThreads.allowed(thread)
    if (leader) for (const tool of LEADER_APP_THREAD_TOOLS) available.add(tool)
    return { available, reportsCreatedThreads: leader }
  }

  // The watchdog gave up on a turn whose subagents went quiet. An interrupt
  // stops it like the user's stop does, which keeps what earlier turns left
  // running but also ends the background agents this turn handed off, so a
  // backend that can let go of the turn alone does that while any of them
  // still run.
  private async releaseStalledTurn(threadId: string, turnId: string): Promise<void> {
    const abandoned =
      (await this.runtime.abandonTurn?.(threadId, turnId).catch(() => false)) === true
    debugLog('subagent.watchdog.release', { threadId, turnId, abandoned })
    if (abandoned) return
    await this.runtime.interrupt(threadId)
  }

  private async requestApproval(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
    // The command an item that is not one asks about, such as the Read
    // behind an image the App shows.
    commandFallback?: ThreadItem,
  ): Promise<PermissionDecision> {
    // Defensive: if Codex App selected approvalPolicy=never (or "Full access"
    // sandbox), auto-accept without bouncing the request to the user. The
    // sidecar already drops can_use_tool in those modes, but in case some
    // future SDK path still emits permission_request, this prevents the
    // adapter from sitting on "Awaiting approval" forever.
    // A call Claude Code says the user has to answer themselves is the
    // exception, in every mode: only the user answers it, and only for this
    // call.
    // App rule: auto-review
    const userOnly = event.requiresUser === true
    const thread = this.store.getThread(threadId)
    if (
      !userOnly &&
      thread &&
      (thread.approvalPolicy === 'never' || thread.sandboxMode === 'danger-full-access')
    ) {
      return { decision: 'accept' }
    }
    // App rule: mcp-tool-approval
    const mcpTool = /^mcp__(.+?)__(.+)$/.exec(event.toolName)
    if (mcpTool) {
      const server = event.mcpServer || mcpTool[1] || ''
      // A server name may hold `__` itself: the tool is what follows it.
      const named = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`
      const tool = event.toolName.startsWith(named)
        ? event.toolName.slice(named.length)
        : (mcpTool[2] ?? '')
      return this.requestMcpToolApproval(peer, threadId, turnId, event, server, tool)
    }
    const sessionKey = approvalSessionKey(event.toolName, event.input)
    if (!userOnly && this.sessionApprovals.get(threadId)?.has(sessionKey))
      return { decision: 'accept' }
    const allowSession = !event.suppressSessionApproval && !userOnly

    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: ['waitingOnApproval'] })
    const requestId = newId()
    const reason = event.reason || event.title || null
    // App rule: command-approval-card
    // The App draws a patch approval from the fileChange item it belongs to,
    // so only an edit asks as one. Any other tool asks as a command: Bash and
    // the file exploration tools as the command their item shows (an image
    // Read as its Read), any other with the tool's name and what it touches
    // in place of a shell command.
    const item =
      commandFallback ??
      this.store.getTurn(turnId)?.items.find((candidate) => candidate.id === itemId)
    const isFileChange = item?.type === 'fileChange'
    const commandItem = item?.type === 'commandExecution' ? item : null
    const command =
      event.toolName === 'Bash'
        ? String(event.input.command ?? '')
        : (commandItem?.command ?? toolApprovalCommand(event.toolName, event.input))
    // The card lists the actions' commands in place of the command, so it
    // gets them only when they spell out the whole command.
    // App rule: command-approval-actions
    const actions = commandItem?.commandActions ?? []
    const commandActions: CommandAction[] = !commandItem
      ? []
      : actions.length === 1 && actions[0]?.command === command
        ? actions
        : [{ type: 'unknown', command }]
    const method = isFileChange
      ? 'item/fileChange/requestApproval'
      : 'item/commandExecution/requestApproval'
    const blockedPath = event.blockedPath ?? null
    // App rule: command-approval-amendment
    // "Allow similar commands" saves the rule Claude offers for a shell
    // command, shown as the command prefix it covers. The App offers it for
    // any prefix it gets, so a call without a session choice gets none.
    const saved =
      allowSession && !isFileChange && event.toolName === 'Bash'
        ? savedAllowRules(event.suggestions)
        : null
    const prefix = savedCommandPrefix(saved)
    const params = isFileChange
      ? {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          reason,
          // The folder outside the workspace the edit asks to write in, which
          // the App shows the edit's paths relative to. "For this session"
          // grants that folder only with CLAUDE_CODEX_SESSION_SUGGESTIONS=1
          // (see sessionApproval), and never a mode in which edits stop
          // asking.
          grantRoot: blockedPath && isAbsolute(blockedPath) ? dirname(blockedPath) : null,
        }
      : {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          approvalId: requestId,
          reason,
          command,
          cwd: commandItem?.cwd ?? String(event.input.cwd ?? thread?.cwd ?? ''),
          commandActions,
          additionalPermissions: null,
          proposedExecpolicyAmendment: prefix,
          proposedNetworkPolicyAmendments: null,
          availableDecisions: allowSession
            ? [
                'accept',
                ...(prefix
                  ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } }]
                  : []),
                'acceptForSession',
                'decline',
                'cancel',
              ]
            : ['accept', 'decline', 'cancel'],
        }

    let response: unknown
    try {
      response = await this.sendServerRequest(peer, method, requestId, params)
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
      this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    }
    const decision = normalizeDecision(response)
    if (decision === 'acceptForSession' && userOnly) return { decision: 'accept' }
    // Only the prefix the card showed saves the rule: Claude Code writes it
    // to the project's local settings and asks no more for what it covers.
    if (saved && acceptsAmendment(response, prefix)) {
      this.rememberSessionApproval(threadId, sessionKey)
      return { decision: 'acceptForSession', updatedPermissions: [saved] }
    }
    if (decision === 'acceptForSession' && allowSession) {
      if (!isFileChange) this.rememberSessionApproval(threadId, sessionKey)
      return sessionApproval(event.suggestions, sessionSuggestionsEnabled())
    }
    return { decision }
  }

  private rememberSessionApproval(threadId: string, key: string): void {
    const approvals = this.sessionApprovals.get(threadId) ?? new Set<string>()
    approvals.add(key)
    this.sessionApprovals.set(threadId, approvals)
  }

  // A Claude MCP tool call asks as a Codex one does: an MCP elicitation the
  // App draws as its tool approval card, with "Allow for this session" when
  // Claude offers one, and "Always allow" when Claude also offers to save a
  // rule for the tool.
  private async requestMcpToolApproval(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
    server: string,
    tool: string,
  ): Promise<PermissionDecision> {
    const sessionKey = approvalSessionKey(event.toolName, event.input)
    // App rule: auto-review
    const userOnly = event.requiresUser === true
    if (!userOnly && this.sessionApprovals.get(threadId)?.has(sessionKey))
      return { decision: 'accept' }
    const allowSession = !event.suppressSessionApproval && !userOnly
    // "Always allow" saves a rule naming this tool of this server alone,
    // whatever rule Claude offered (see mcpToolAllowRule).
    const saved =
      allowSession && savedAllowRules(event.suggestions) ? mcpToolAllowRule(event.toolName) : null
    const reason = event.reason || event.title || null
    let response: Record<string, unknown>
    try {
      response = await this.sendElicitation(
        peer,
        threadId,
        newId(),
        {
          threadId,
          turnId,
          serverName: server,
          mode: 'form',
          message: `Allow the ${server} MCP server to run tool "${tool}"?`,
          requestedSchema: { type: 'object', properties: {} },
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            ...(allowSession ? { persist: saved ? ['session', 'always'] : 'session' } : {}),
            tool_name: tool,
            tool_params: event.input,
            ...(reason ? { reason } : {}),
          },
        },
        'waitingOnApproval',
      )
    } catch {
      // The App could not answer: refuse this call and let Claude go on.
      return { decision: 'decline' }
    }
    if (response.action === 'decline') return { decision: 'decline' }
    if (response.action !== 'accept') return { decision: 'cancel' }
    const meta = response._meta
    const persist =
      meta && typeof meta === 'object' ? (meta as Record<string, unknown>).persist : null
    if (saved && persist === 'always') {
      this.rememberSessionApproval(threadId, sessionKey)
      return { decision: 'acceptForSession', updatedPermissions: [saved] }
    }
    if (allowSession && persist === 'session') {
      this.rememberSessionApproval(threadId, sessionKey)
      return sessionApproval(event.suggestions, sessionSuggestionsEnabled())
    }
    return { decision: 'accept' }
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
    let result: Record<string, unknown>
    try {
      result = await this.sendElicitation(
        peer,
        threadId,
        requestId,
        params,
        'waitingOnUserInput',
        signal,
      )
    } catch {
      return { action: 'cancel' }
    }
    const action =
      result.action === 'accept' || result.action === 'decline' ? result.action : 'cancel'
    const content = result.content
    return action === 'accept' && content && typeof content === 'object' && !Array.isArray(content)
      ? { action, content: content as Record<string, unknown> }
      : { action }
  }

  // A dynamic tool call as Codex's item/tool/call: the client runs the tool
  // while the turn is in progress. Null when `signal` cancelled the call; a
  // client error becomes a failed call, as in Codex.
  // App rule: dynamic-tools
  private async requestDynamicTool(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    request: DynamicToolCallRequest,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse | null> {
    const requestId = newId()
    const params = {
      threadId,
      turnId,
      callId: request.callId,
      namespace: request.namespace,
      tool: request.tool,
      arguments: request.arguments,
    }
    try {
      return dynamicToolResponse(
        await this.sendServerRequest(peer, 'item/tool/call', requestId, params, signal),
      )
    } catch (error) {
      if (signal.aborted) return null
      debugLog('dynamicTools.callFailed', {
        threadId,
        turnId,
        callId: request.callId,
        error: error instanceof Error ? error.message : String(error),
      })
      return dynamicToolFailure(DYNAMIC_TOOL_REQUEST_FAILED)
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
    }
  }

  // Sends an mcpServer/elicitation/request and returns the App's answer. The
  // thread waits on input for an MCP server's form or link, and on approval
  // for a tool approval card.
  private async sendElicitation(
    peer: RpcPeer,
    threadId: string,
    requestId: string,
    params: Record<string, unknown>,
    flag: 'waitingOnApproval' | 'waitingOnUserInput',
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [flag] })
    try {
      return asRecord(
        await this.sendServerRequest(
          peer,
          'mcpServer/elicitation/request',
          requestId,
          params,
          signal,
        ),
      )
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
      this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    }
  }

  private async turnInterrupt(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const requestedTurnId = stringOr(params.turnId, '')
    this.subscribe(threadId, peer)
    // A background child has no runtime turn of its own; stop its task.
    const background = this.backgroundSubagents.get(threadId)
    if (background?.running) {
      await this.stopBackgroundSubagent(background)
      return {}
    }
    // Neither does a foreground child: it runs inside its parent's turn.
    if (await this.stopForegroundSubagent(peer, threadId)) return {}
    const activeTurnId = this.activeTurnByThread.get(threadId)
    this.settleInterruptedTurn(peer, threadId, activeTurnId || requestedTurnId)
    // Persist the terminal state before asking the SDK to abort. A few SDK
    // versions deliver one or two buffered tool events during interrupt; the
    // runRuntimeTurn guard now rejects them because the turn is no longer
    // active, so they cannot create an orphan child after this point.
    const interrupting = this.runtime.interrupt(threadId)
    await interrupting
    return {}
  }

  // Ends a thread's running turn as interrupted and leaves the thread idle:
  // for turn/interrupt, and for an approval the user cancelled.
  private settleInterruptedTurn(peer: RpcPeer, threadId: string, turnId: string): void {
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
        this.exitReviewMode(peer, threadId, turnId)
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
    // Like Codex, a review or a compaction the user started takes no input
    // until it ends; a turn Claude compacted on its own still does. The
    // refusal is Codex's invalid-request error with the turn kind in
    // `data`, which App builds that queue a message sent during a compaction
    // match on.
    const turnKind = this.unsteerableTurns.get(activeTurnId)
    if (turnKind) {
      const message = `cannot steer a ${turnKind} turn`
      throw new RpcError(
        message,
        {
          message,
          codexErrorInfo: { activeTurnNotSteerable: { turnKind } },
          additionalDetails: null,
          misalignment: null,
        },
        INVALID_REQUEST,
      )
    }
    const input = turnInput(params)
    const { textPrompt, images } = extractImageInputs(input)
    // App rule: quiet-turn-heartbeat
    const prompt = stripQuietTurnHeartbeat(skillLinksToCommand(textPrompt || textFromInput(input)))
    if (!prompt.trim() && images.length === 0) throw new Error('steer input must not be empty')
    if (peer !== DETACHED_PEER) this.subscribe(threadId, peer)
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
    const thread = this.store.getThread(threadId)
    const modelPrompt = thread ? this.modelPrompt(thread, prompt, params, { steer: true }) : prompt
    const steered = await this.steerRunningTurn(threadId, activeTurnId, modelPrompt, {
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

  private configRead(params: Record<string, unknown>): unknown {
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
        // Codex reports a window here only when config.toml sets one; the App
        // takes the window from thread/tokenUsage/updated.
        model_context_window: null,
        // The window Claude threads compact at, for the folder asked about:
        // null unless the user set the limit.
        model_auto_compact_token_limit: this.autoCompactWindowFor(
          null,
          nullIfEmpty(stringOr(params.cwd, '')),
        ),
        model_provider: 'claude-code',
        approval_policy: this.configOverrides.approval_policy ?? 'on-request',
        approvals_reviewer: this.configOverrides.approvals_reviewer ?? 'user',
        sandbox_mode: this.configOverrides.sandbox_mode ?? 'workspace-write',
        sandbox_workspace_write: this.configOverrides.sandbox_workspace_write ?? null,
        forced_chatgpt_workspace_id: null,
        forced_login_method: null,
        // Claude searches the web live with its WebSearch tool, which
        // modelProvider/capabilities/read advertises unless
        // CLAUDE_CODEX_WEBSEARCH=0.
        web_search:
          this.configOverrides.web_search ??
          (process.env.CLAUDE_CODEX_WEBSEARCH === '0' ? 'disabled' : 'live'),
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
        // The App reads its memories switches from the table; the adapter
        // keeps the key paths it writes flat. Only the memories mapping
        // gathers them.
        ...(memoriesMappingEnabled()
          ? { memories: memoriesConfigTable(this.configOverrides) }
          : {}),
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
    return process.env.CLAUDE_CODEX_DISABLE_CODEX_PROXY === '1' && !this.codexProxySelected()
  }

  // The Codex proxy carries every thread, whatever its model.
  private codexProxySelected(): boolean {
    return (
      resolveProviderLoopSelection(this.providerLoopSelectionInput()).runtimeType === 'codex-proxy'
    )
  }

  // The model a settings or metadata update moves the thread to, or null. The
  // App sends the chat's current model along with other settings; that is no
  // change, even when the picker no longer lists it and repairing it would
  // pick a model on the other backend. Model process profiles that fail to
  // load are the user's to fix, like a model the thread cannot take.
  // App rule: model-menu-settings
  private requestedModelChange(
    thread: ThreadRecord,
    params: Record<string, unknown>,
  ): string | null {
    const rawModel = modelFromParams(params, null)
    if (!rawModel || rawModel === thread.model) return null
    const model = invalidRequestIfThrows(() => normalizeSelectableModelId(rawModel, thread.model))
    return model === thread.model ? null : model
  }

  // Whether `model` runs on another backend than the thread's. The Codex
  // proxy runs Claude models too, so a Codex thread keeps it for either.
  private crossesRuntimeBackend(thread: ThreadRecord, model: string): boolean {
    const codexModel = isCodexOpenAiModel(model)
    return thread.runtimeBackend === 'claude'
      ? codexModel
      : !codexModel && !this.codexProxySelected()
  }

  // Something was said in the thread, or it carries a parent's conversation.
  private threadHasConversation(thread: ThreadRecord): boolean {
    return (
      thread.forkedFromId != null ||
      thread.claudeSessionId != null ||
      thread.codexSessionId != null ||
      this.activeTurnByThread.has(thread.id) ||
      this.store.lastTurn(thread.id) != null
    )
  }

  // Moves the thread to `model`, or throws before anything changes. A thread
  // stays on the backend it started on: its conversation lives in a Claude
  // session or a Codex one, and neither carries over to the other. So another
  // Claude model is fine for a Claude thread but a Codex one is not, and the
  // other way round unless the Codex proxy carries every thread. A thread with
  // no conversation yet has nothing to lose, so its model still picks its
  // backend: the App starts a new chat's thread before the user picks a model.
  // App rule: prewarmed-threads
  // With model process profiles configured, a Claude conversation likewise
  // stays on its profile, since its session lives in that profile's process
  // and config dir; a thread with no conversation yet can take any profile.
  // A conversation no profile can run any more keeps its model, so a model
  // change cannot pin it to a profile, or to none, and resume it there.
  // Every refusal here is the user's to put right, by picking another model
  // or starting a new chat: an invalid request, whose reason the App's model
  // menu shows.
  // App rule: model-menu-settings
  private setThreadModel(thread: ThreadRecord, model: string): void {
    let runtimeBackend = thread.runtimeBackend
    let profileFingerprint: string | null
    try {
      if (this.crossesRuntimeBackend(thread, model)) {
        const codexModel = isCodexOpenAiModel(model)
        if (this.threadHasConversation(thread)) {
          throw new Error(
            `cannot change runtime backend from ${thread.runtimeBackend} to ${codexModel ? 'codex' : 'claude'} for ${model}; start a new thread`,
          )
        }
        if (codexModel && this.codexRoutingDisabled()) throw codexRoutingDisabledError(model)
        runtimeBackend = codexModel ? 'codex' : 'claude'
      } else if (runtimeBackend === 'claude' && this.threadHasConversation(thread)) {
        const unbound = threadModelProfileBindingError(thread)
        if (unbound) throw unbound
        assertModelProfileTransition(thread.model, model)
      }
      profileFingerprint = profileFingerprintForModel(model, runtimeBackend)
    } catch (error) {
      throw asInvalidRequest(error)
    }
    thread.runtimeBackend = runtimeBackend
    thread.model = model
    thread.modelProfileFingerprint = profileFingerprint
  }

  // A Claude thread's conversation lives in its model process profile: it
  // continues only while that profile is configured as it was (see
  // threadModelProfileBindingError). Anything that would start Claude for it
  // checks this first: turns, reviews, compaction and forks.
  private checkModelProfileBinding(thread: ThreadRecord): void {
    const unbound = this.modelProfileUnbound(thread)
    if (unbound) throw asInvalidRequest(unbound)
  }

  // Why the thread's conversation cannot go on in a Claude Code process, or
  // null when it can. A thread with no conversation yet has nothing to lose
  // and takes the profile's current configuration.
  private modelProfileUnbound(thread: ThreadRecord): Error | null {
    if (thread.runtimeBackend !== 'claude') return null
    if (this.threadHasConversation(thread)) return threadModelProfileBindingError(thread)
    let fingerprint: string | null
    try {
      fingerprint = profileFingerprintForModel(thread.model, 'claude')
    } catch {
      // Its model is no profile now: a model change can still pin one, and
      // a turn on this model fails naming it.
      fingerprint = null
    }
    if (fingerprint === (thread.modelProfileFingerprint ?? null)) return null
    thread.modelProfileFingerprint = fingerprint
    this.store.upsertThread(thread)
    return null
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

  // App rule: memories-settings
  private memoriesOn(): boolean {
    return memoriesEnabled(this.configOverrides, this.memoriesEnablement)
  }

  private experimentalFeatureList(params: Record<string, unknown>): unknown {
    // Without the memories mapping no feature has anything to switch, so
    // none is listed and the App hides its memories settings.
    if (!memoriesMappingEnabled()) return { data: [], nextCursor: null }
    // Codex reads the flags of a thread's own config; every thread here has
    // the global ones.
    const threadId = stringOr(params.threadId, '')
    if (threadId && !this.store.getThread(threadId))
      throw invalidRequest(`thread not found: ${threadId}`)
    return experimentalFeatureList(this.memoriesOn(), params)
  }

  // The App sets its defaults for the connection with this, memories among
  // them. The other features have nothing to switch on Claude threads.
  private experimentalFeatureEnablementSet(params: Record<string, unknown>): unknown {
    const enablement = asRecord(params.enablement)
    const memories = enablement[MEMORIES_FEATURE]
    if (typeof memories === 'boolean') this.memoriesEnablement = memories
    return { enablement }
  }

  // Without the memories mapping /memories has nothing to switch, and the
  // call is acknowledged without effect.
  private threadMemoryModeSet(params: Record<string, unknown>): unknown {
    if (!memoriesMappingEnabled()) return {}
    const threadId = stringOr(params.threadId, '')
    const mode = parseMemoryMode(params.mode)
    if (!mode) throw invalidRequest(`invalid memory mode: ${String(params.mode)}`)
    if (!this.store.getThread(threadId)) throw unknownThread(threadId)
    this.store.setThreadMemoryMode(threadId, mode)
    debugLog('thread.memoryMode', { threadId, mode })
    return {}
  }

  // Whether the thread's sessions run with Claude Code's auto-memory: the
  // feature is on and so is the thread's mode, which threads saved before
  // modes existed take from the config. The mode is read from the store
  // because it can change while a turn holds an older record.
  private autoMemoryFor(thread: ThreadRecord): boolean {
    if (thread.ephemeral || !this.memoriesOn()) return false
    const mode = this.store.getThread(thread.id)?.memoryMode ?? thread.memoryMode
    return (mode ?? newThreadMemoryMode({}, this.configOverrides)) === 'enabled'
  }

  // A model_auto_compact_token_limit in the config a thread came with.
  private rememberAutoCompactLimit(threadId: string, config: unknown): void {
    const limit = autoCompactTokenLimit(asRecord(config)[AUTO_COMPACT_KEY])
    if (limit != null) this.threadAutoCompactLimits.set(threadId, limit)
  }

  // The auto-compact window of a thread's Claude sessions, from the first to
  // set model_auto_compact_token_limit of: the config the thread came with,
  // what a client wrote with config/value/write, and, when the user asks for
  // it, the Codex config files for its folder. Null when none does, and
  // Claude Code keeps its own window.
  private autoCompactWindowFor(threadId: string | null, cwd: string | null): number | null {
    return autoCompactWindow(
      threadId ? this.threadAutoCompactLimits.get(threadId) : undefined,
      this.configOverrides[AUTO_COMPACT_KEY],
      codexAutoCompactLimit(cwd),
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
    // Each Claude model offers the efforts Claude Code reported for it: 'max'
    // where the model takes it, none on a model without effort. Ids and names
    // stay the adapter's own; only the placeholder description gives way to
    // Claude Code's.
    // App rule: model-efforts
    const claudeOptions = claudeModelOptions().map((option) => {
      const reported = reportedClaudeModel(option.sdkModel)
      return {
        ...option,
        description:
          option.description === GENERIC_MODEL_DESCRIPTION && reported?.description
            ? reported.description
            : option.description,
        efforts: reported?.efforts ?? DEFAULT_EFFORTS,
      }
    })
    // When a real Codex CLI binary is available on the host (CODEX_REAL env
    // or auto-discovered), expose its native models alongside Claude's so
    // the Codex App's per-thread model picker can route between backends
    // without any reconnect or shell flip. Picking gpt-* flips the thread
    // to runtimeBackend='codex' which the runtime router dispatches to
    // CodexProxyRuntime (shells out to `codex exec --json`).
    const codexOptions = codexProxyModelOptions().map((option) => ({
      ...option,
      efforts: DEFAULT_EFFORTS,
    }))
    const options = [...claudeOptions, ...codexOptions]
    const hasConfiguredDefault = options.some((option) => option.id === defaultModel)
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
        supportedReasoningEfforts: reasoningEffortOptions(option.efforts),
        defaultReasoningEffort: defaultReasoningEffort(option.efforts, this.configReasoningEffort),
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
      // The result counts the calls reported live.
      this.liveCallUsageByThread.delete(threadId)
    }
    if (source.contextWindow) {
      this.contextWindowByThread.set(threadId, source.contextWindow)
      const model = this.store.getThread(threadId)?.model
      if (model) this.contextWindowByModel.set(model, source.contextWindow)
    }
    if (spent.totalTokens === 0) return
    const prior = this.tokenUsageByThread.get(threadId) ?? emptyTokenBreakdown()
    this.tokenUsageByThread.set(threadId, addTokenBreakdowns([prior, spent]))
    // A child that reports while the main loop runs keeps its latest call in
    // the gauge.
    const measured = child
      ? (this.lastCallUsageByThread.get(threadId) ?? this.lastUsageByThread.get(threadId))
      : lastCall
    if (!child) {
      if (lastCall) this.lastUsageByThread.set(threadId, lastCall)
      else this.lastUsageByThread.delete(threadId)
    }
    const tokenUsage: ThreadTokenUsage = {
      total: this.liveTokenTotal(threadId),
      last: measured ?? (child ? emptyTokenBreakdown() : spent),
      // Only one call's usage measures the context; a whole turn's sum would
      // overfill the App's gauge.
      modelContextWindow: measured ? this.contextWindowFor(threadId) : null,
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

  // Claude compacted the thread's context down to a summary of `postTokens`
  // tokens: like Codex's after a compaction, the context meter drops to it.
  // Within a turn the next call's usage measures the context again; after a
  // compaction turn, which makes no further call, the meter keeps it.
  private recordCompactedContext(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    postTokens: number | null,
    midTurn: boolean,
  ): void {
    if (postTokens == null || postTokens <= 0) return
    const last: TokenUsageBreakdown = {
      ...emptyTokenBreakdown(),
      totalTokens: postTokens,
      inputTokens: postTokens,
    }
    if (midTurn) this.lastCallUsageByThread.set(threadId, last)
    else this.lastCallUsageByThread.delete(threadId)
    this.lastUsageByThread.set(threadId, last)
    const tokenUsage: ThreadTokenUsage = {
      total: this.tokenUsageByThread.get(threadId) ?? emptyTokenBreakdown(),
      last,
      modelContextWindow: this.contextWindowByThread.get(threadId) ?? null,
    }
    this.notify(peer, {
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage },
    })
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
    if (command.length === 0) throw invalidRequest('command/exec requires command')
    if (
      (params.streamStdoutStderr === true || params.streamStdin === true || params.tty === true) &&
      typeof params.processId !== 'string'
    ) {
      throw invalidRequest('command/exec streaming requires processId')
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
    if (!child) throw invalidRequest(`unknown command process: ${processId}`)
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
    if (!child) throw invalidRequest(`unknown command process: ${processId}`)
    child.kill('SIGTERM')
    return {}
  }

  private processSpawn(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    if (!processHandle) throw invalidRequest('process/spawn requires processHandle')
    if (this.processHandles.has(processHandle))
      throw invalidRequest(`process handle already active: ${processHandle}`)
    const command = commandArray(params.command)
    if (command.length === 0) throw invalidRequest('process/spawn requires command')
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
    if (!child) throw invalidRequest(`unknown process handle: ${processHandle}`)
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
    if (!child) throw invalidRequest(`unknown process handle: ${processHandle}`)
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

  // What Claude reads for a user message: the items the App injected into the
  // thread since its last message, the message, then the SKILL.md of each
  // skill it picks and the context the App attached to it. Helper turns and
  // the adapter's own prompts get none of it, and leave the injected items to
  // the next message. So does a steer: the App injects items only while no
  // turn runs, for the turn it starts next.
  // App rule: skill-injection
  // App rule: additional-context
  // App rule: injected-context
  private modelPrompt(
    thread: ThreadRecord,
    prompt: string,
    params: Record<string, unknown>,
    options: { steer?: boolean } = {},
  ): string {
    if (params.outputSchema != null || typeof params._hiddenPrompt === 'string') return prompt
    const skillDirs = [
      ...claudeSkillDirs(thread.cwd),
      ...this.appSkillsFor(thread.id).appSkills.map((skill) => dirname(skill.path)),
    ]
    return withTurnContext(
      prompt,
      [skillInstructions(prompt, skillDirs), additionalContextBlocks(params.additionalContext)],
      options.steer ? null : injectedItemsContext(this.store.takeInjectedItems(thread.id)),
    )
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
    let changed = false
    if (plugin && known?.root !== plugin.root) {
      this.appPlugins = [...this.appPlugins.filter((candidate) => candidate !== known), plugin]
      changed = true
    }
    // App rule: code-review-plugin-server
    const installed = appMarketplacePlugin(params.marketplacePath, params.pluginName)
    if (installed?.marketplace) {
      const id = `${installed.name}@${installed.marketplace}`
      const was = this.installedAppPlugins.find((candidate) => candidate.id === id)
      if (was?.root !== installed.root) {
        this.installedAppPlugins = [
          ...this.installedAppPlugins.filter((candidate) => candidate !== was),
          { id, root: installed.root },
        ]
        changed = true
      }
    }
    if (changed) this.persistConfig()
    return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
  }

  private pluginUninstall(params: Record<string, unknown>): unknown {
    // Plugin ids read `<name>@<marketplace>`.
    const id = stringOr(params.pluginId, '')
    const name = id.split('@')[0]
    const kept = this.appPlugins.filter((plugin) => plugin.name !== name)
    const installed = this.installedAppPlugins.filter((plugin) => plugin.id !== id)
    if (
      kept.length !== this.appPlugins.length ||
      installed.length !== this.installedAppPlugins.length
    ) {
      this.appPlugins = kept
      this.installedAppPlugins = installed
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
        gitInfo: thread?.gitInfo
          ? {
              sha: thread.gitInfo.sha,
              branch: thread.gitInfo.branch,
              origin_url: thread.gitInfo.originUrl,
            }
          : null,
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

  // The thread item a Claude tool call shows as. `mcpServers` names the
  // turn's configured MCP servers; `imageView: false` keeps an image Read a
  // Read command.
  private toolUseToItem(
    event: Extract<RuntimeEvent, { type: 'tool_use' }>,
    cwd: string,
    options: { mcpServers?: Iterable<string>; imageView?: boolean } = {},
  ): ThreadItem {
    const id = newId()
    const command = (
      text: string,
      itemCwd: string,
      commandActions: CommandAction[],
    ): ThreadItem => ({
      type: 'commandExecution',
      id,
      command: text,
      cwd: itemCwd,
      // Use the SDK's tool_use_id as a stable handle. Without a non-null
      // processId the Codex App was treating these as "Background terminal"
      // entries (no attached process) and hiding their output; with a
      // synthetic id they render as inline command items like a normal
      // foreground bash invocation.
      processId: `claude:${event.toolUseId}`,
      source: 'agent',
      status: 'inProgress',
      commandActions,
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    })
    if (event.toolName === 'Bash') {
      const text = String(event.input.command ?? '')
      const itemCwd = String(event.input.cwd ?? cwd)
      // A command that only reads, lists or searches files joins the App's
      // "Explored" group, as Codex's own commands do.
      // App rule: explored-commands
      return command(text, itemCwd, text ? parseCommandActions(text, itemCwd) : [])
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
      // the search badge natively. The 'search' variant's `query` / `queries`
      // are required (Option fields with no serde default), so always
      // populate both.
      const q = String(event.input.query ?? '')
      return {
        type: 'webSearch',
        id,
        query: q,
        action: { type: 'search', query: q || null, queries: null },
      }
    }
    if (event.toolName === 'WebFetch') {
      // Fetching a page is what Codex shows as opening it.
      const url = String(event.input.url ?? '')
      return { type: 'webSearch', id, query: url, action: { type: 'openPage', url: url || null } }
    }
    const imagePath =
      options.imageView === false ? null : imageReadPath(event.toolName, event.input, cwd)
    if (imagePath) return { type: 'imageView', id, path: imagePath }
    if (isExploreTool(event.toolName)) {
      // Read, Grep, Glob and LS show as commands named after the tool, with
      // the action Codex gives a shell command doing the same, so the App
      // groups them under "Explored".
      // App rule: explored-commands
      const explored = exploreToolCommand(event.toolName, event.input, cwd)
      return command(explored.command, cwd, explored.commandActions)
    }
    // MCP tools name their server; Claude Code's other tools are shown
    // under a `claude-code` server.
    const mcp = splitMcpToolName(event.toolName, options.mcpServers)
    return {
      type: 'mcpToolCall',
      id,
      server: mcp?.server ?? 'claude-code',
      tool: mcp?.tool ?? event.toolName,
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
      // App rule: auto-review
      approvalsReviewer: thread.approvalsReviewer ?? 'user',
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
      gitInfo: thread.gitInfo ?? null,
      name: thread.name,
      model: thread.model || null,
      reasoningEffort: normalizeReasoningEffortEnum(thread.reasoningEffort),
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
  // the adapter's internal metrics are not serialized onto the wire. Every
  // payload carries rootTurnId (0.163), the turn itself unless it was started
  // for another turn's work.
  private toTurn(turn: TurnRecord): unknown {
    return {
      id: turn.id,
      rootTurnId: turn.rootTurnId ?? turn.id,
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
      rootTurnId: turn.rootTurnId ?? turn.id,
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
      rootTurnId: turn.rootTurnId ?? turn.id,
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
      rootTurnId: turn.rootTurnId ?? turn.id,
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
    const targets = this.targetsForParams(peer, notification.params)
    debugLog('rpc.notify', {
      ...this.targetFields(peer, targets),
      method: notification.method,
      params: summarizeRpcParams(notification.method, notification.params),
    })
    const message: WireMessage = {
      jsonrpc: '2.0',
      method: notification.method,
      params: notification.params,
    }
    for (const target of targets) {
      if (
        !this.optedOut(target, notification.method) &&
        this.peerTakesNotification(target, notification)
      )
        target.send(message)
    }
  }

  // To this peer only, whoever else follows the notification's thread.
  private sendNotification(peer: RpcPeer, notification: { method: string; params: unknown }): void {
    if (this.stopped) return
    if (this.optedOut(peer, notification.method)) return
    debugLog('rpc.notify', {
      peerId: peer.id,
      originalPeerId: null,
      method: notification.method,
      params: summarizeRpcParams(notification.method, notification.params),
    })
    peer.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
  }

  // The debug log names the one peer a message went to, as before several
  // could follow a thread, or all of them.
  private targetFields(peer: RpcPeer, targets: RpcPeer[]): Record<string, unknown> {
    const [only] = targets
    return targets.length === 1 && only
      ? { peerId: only.id, originalPeerId: only.id === peer.id ? null : peer.id }
      : { peerIds: targets.map((target) => target.id), originalPeerId: peer.id }
  }

  // A thread's followers can be Apps of different builds: only those with the
  // completed kind get the started and completed subagent activity items.
  // App rule: subagent-completed-kind
  private peerTakesNotification(
    peer: RpcPeer,
    notification: { method: string; params: unknown },
  ): boolean {
    if (notification.method !== 'item/started' && notification.method !== 'item/completed')
      return true
    const item = asRecord(asRecord(notification.params).item)
    if (item.type !== 'subAgentActivity' || item.kind === 'interrupted') return true
    return this.supportsCompletedSubagentActivity(peer)
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
      if (!this.optedOut(peer, notification.method))
        peer.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
  }

  // Whether the client asked in initialize not to hear `method`.
  private optedOut(peer: RpcPeer, method: string): boolean {
    return this.peerFeatures.get(peer)?.optedOutNotifications.has(method) === true
  }

  private notifyThread(threadId: string, notification: { method: string; params: unknown }): void {
    const peer = this.subscribersOf(threadId).at(-1)
    if (peer) this.notify(peer, notification)
  }

  // A notice from Claude Code (turn-notices.mts): the `warning` Codex would
  // send, and for the first few of a turn also a row under it that the App
  // renders. Each message goes out once per turn. turnId null: the thread has
  // no turn to show it under, so only the warning goes out; visible false: a
  // turn the user does not watch, such as a title or a compaction's summary.
  // App rule: turn-notices
  private publishNotice(
    peer: RpcPeer,
    threadId: string,
    turnId: string | null,
    message: string,
    visible = true,
  ): void {
    const decision = this.turnNotices.record(turnId ?? `thread:${threadId}`, message)
    if (!decision.warn) return
    this.notify(peer, { method: 'warning', params: { threadId, message } })
    if (!decision.show || !visible || !turnId || !noticeRowsEnabled()) return
    this.notify(peer, {
      method: 'error',
      params: { threadId, turnId, willRetry: true, error: noticeTurnError(message) },
    })
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
    const target = peer ?? this.subscribersOf(threadId).at(-1)
    if (target)
      this.notify(target, { method: 'thread/status/changed', params: { threadId, status } })
    this.leaderThreads.threadChanged()
    // A turn starting is when the keep-awake guard takes hold.
    this.idleSleep.check()
  }

  // An aborted `signal` drops the request and rejects; the caller's
  // serverRequest/resolved then takes the App's card down. The request goes to
  // every peer following the thread, as Codex's app-server sends it to every
  // connection subscribed to the thread; the first answer wins, and the
  // caller's serverRequest/resolved takes the other cards down.
  private sendServerRequest(
    peer: RpcPeer,
    method: string,
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const targets = this.targetsForParams(peer, params)
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`${method} was cancelled`))
        return
      }
      debugLog('rpc.serverRequest', {
        ...this.targetFields(peer, targets),
        id,
        method,
        params: summarizeRpcParams(method, params),
      })
      const onAbort = () => {
        if (!this.pendingServerRequests.delete(id)) return
        reject(new Error(`${method} was cancelled`))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const request: WireMessage = { jsonrpc: '2.0', id, method, params }
      const fields = asRecord(params)
      this.pendingServerRequests.set(id, {
        method,
        threadId: nullIfEmpty(stringOr(fields.threadId, '')),
        turnId: nullIfEmpty(stringOr(fields.turnId, '')),
        request,
        targets: new Set(targets.map((target) => target.id)),
        cancellable: signal != null,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      for (const target of targets) target.send(request)
    })
  }

  // Any client may answer a pending request, as in Codex's app-server: the App
  // back from a reconnect is a new peer, and it may answer before it reopens
  // the thread.
  private resolveServerRequest(peer: RpcPeer, response: JsonRpcResponse): void {
    const id = String(response.id)
    const pending = this.pendingServerRequests.get(id)
    // Too late: another follower answered first, or the request was withdrawn.
    if (!pending) {
      debugLog('rpc.responseFromClient.ignored', {
        peerId: peer.id,
        id: id.slice(0, 40),
        reason: 'notPending',
      })
      return
    }
    this.pendingServerRequests.delete(id)
    if (response.error) pending.reject(new Error(response.error.message))
    else pending.resolve(response.result)
  }

  // A peer that starts following a thread after a request went out (a second
  // client opening it, or the App after a reconnect) gets the request too, as
  // Codex's app-server replays a thread's pending requests on thread/resume.
  // A request whose turn has ended is not shown again.
  private replayPendingServerRequests(peer: RpcPeer): void {
    if (this.pendingServerRequests.size === 0 || peer === DETACHED_PEER) return
    for (const [id, pending] of this.pendingServerRequests.entries()) {
      if (pending.threadId === null || pending.targets.has(peer.id)) continue
      if (!this.subscribersByThread.get(pending.threadId)?.has(peer.id)) continue
      if (pending.turnId && this.store.getTurn(pending.turnId)?.status !== 'inProgress') continue
      pending.targets.add(peer.id)
      debugLog('rpc.serverRequest.replay', { peerId: peer.id, id, method: pending.method })
      peer.send(pending.request)
    }
  }

  // A turn's approvals and questions end with it, as Codex's app-server drops
  // a thread's pending requests when its turn completes: an answer that comes
  // later is ignored instead of reporting the idle thread active again.
  // Requests with an abort signal are withdrawn through it.
  private dropPendingServerRequests(threadId: string, turnId: string): void {
    for (const [id, pending] of this.pendingServerRequests.entries()) {
      if (pending.cancellable || pending.threadId !== threadId || pending.turnId !== turnId)
        continue
      this.pendingServerRequests.delete(id)
      debugLog('rpc.serverRequest.dropped', { threadId, turnId, id, method: pending.method })
    }
  }

  private completeActiveTurns(status: 'interrupted' | 'failed', error: unknown): void {
    for (const [threadId, turnId] of this.activeTurnByThread.entries()) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        // A review the stop cuts off still closes in the thread's history.
        this.exitReviewMode(null, threadId, turnId)
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
      const peer = this.subscribersOf(state.thread.id).at(-1) ?? {
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
    if (turnId) {
      this.closeStreamingItemsByTurn.delete(turnId)
      this.unsteerableTurns.delete(turnId)
      this.dropPendingServerRequests(threadId, turnId)
    }
    // A turn that ended without a result leaves its live calls unsettled.
    this.liveCallUsageByThread.delete(threadId)
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
      this.refreshGitInfoAfterTurn(threadId)
      setImmediate(() => {
        if (!this.startFollowUp(threadId, settled?.status) && this.activeTurnByThread.size === 0)
          this.checkIdle()
      })
    }
  }

  // Stores the git info of the thread's workspace once the lookup lands. A
  // failed lookup keeps what is stored unless `replace` says the workspace
  // itself changed.
  private async captureGitInfo(
    threadId: string,
    cwd: string,
    options: { fresh?: boolean; replace?: boolean } = {},
  ): Promise<void> {
    try {
      const gitInfo = await gitInfoFor(cwd, { fresh: options.fresh === true })
      if (this.stopped || (!gitInfo && !options.replace)) return
      this.store.setThreadGitInfo(threadId, gitInfo)
    } catch (error) {
      debugLog('thread.git_info.failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // A turn can switch or create the branch, so the sidebar follows the branch
  // the thread last worked on.
  private refreshGitInfoAfterTurn(threadId: string): void {
    try {
      const thread = this.store.getThread(threadId)
      if (thread && !thread.ephemeral)
        void this.captureGitInfo(threadId, thread.cwd, { fresh: true })
    } catch {
      // Only the branch label waits for the next turn.
    }
  }

  // Threads stored before the adapter kept git info, or resumed before their
  // start-time lookup landed, get it before resuming; resuming in another
  // directory replaces it.
  private async gitInfoForResume(params: Record<string, unknown>): Promise<void> {
    const thread = this.store.getThread(stringOr(params.threadId, ''))
    if (!thread || thread.ephemeral) return
    const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : thread.cwd
    if (cwd !== thread.cwd) await this.captureGitInfo(thread.id, cwd, { replace: true })
    else if (!thread.gitInfo) await this.captureGitInfo(thread.id, cwd)
  }

  // The MCP servers an App request sees: a named thread's, its project's
  // included; otherwise those that apply in every folder.
  private mcpScope(params: unknown): McpConfigScope {
    const threadId = stringOr(asRecord(params).threadId, '')
    const thread = threadId ? this.store.getThread(threadId) : null
    return {
      cwd: thread && thread.runtimeBackend !== 'codex' ? thread.cwd : null,
      appPlugins: this.installedAppPlugins,
    }
  }

  // What the live Claude session of the thread a request names says of its
  // MCP servers; null without one.
  private async mcpSessionStatuses(params: unknown): Promise<RuntimeMcpServerStatus[] | null> {
    const threadId = stringOr(asRecord(params).threadId, '')
    const thread = threadId ? this.store.getThread(threadId) : null
    if (!thread || thread.runtimeBackend === 'codex') return null
    return (await this.runtime.mcpServerStatuses?.(threadId)) ?? null
  }

  // Codex ends a review turn with an exitedReviewMode item holding the review,
  // or a fallback text when the reviewer gave no answer (an interrupted or
  // failed review). Before the turn completes, as there. Without a peer the
  // item is only recorded: the adapter is stopping and tells no client. A
  // store that refuses the item must not keep the turn from ending.
  private exitReviewMode(peer: RpcPeer | null, threadId: string, turnId: string): void {
    let item: ThreadItem
    try {
      const turn = this.store.getTurn(turnId)
      if (turn?.status !== 'inProgress') return
      if (!turn.items.some((item) => item.type === 'enteredReviewMode')) return
      if (turn.items.some((item) => item.type === 'exitedReviewMode')) return
      const answer = turn.items.findLast(
        (item) => item.type === 'agentMessage' && item.phase === 'final_answer',
      )
      const text = answer?.type === 'agentMessage' ? answer.text.trim() : ''
      item = { type: 'exitedReviewMode', id: newId(), review: text || REVIEW_FALLBACK }
      this.store.appendItem(turnId, item)
    } catch (error) {
      debugLog('review.exit_failed', {
        threadId,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (!peer) return
    this.notify(peer, {
      method: 'item/started',
      params: { threadId, turnId, item, startedAtMs: nowMillis() },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: { threadId, turnId, item, completedAtMs: nowMillis() },
    })
  }

  // Ends a turn whose runtime run failed. The client leaves its running state
  // only on turn/completed, so that goes out even when the store refuses the
  // write too; the usual cause is another connection holding the state
  // database past its busy timeout. Returns false for a turn that had already
  // ended, e.g. through turn/interrupt.
  private failTurn(peer: RpcPeer, threadId: string, turn: TurnRecord, error: Error): boolean {
    this.exitReviewMode(peer, threadId, turn.id)
    const turnError = this.explainTurnError(turn, turnErrorOf(error))
    const completed = this.endTurn(turn, 'failed', turnError)
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
      params: { threadId, turnId: turn.id, willRetry: false, error: turnError },
    })
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId, turn: this.toLifecycleTurn(completed) },
    })
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
    return true
  }

  // What a failed turn's error leaves out: that the computer slept during
  // the turn, which is the likely reason a model request broke off, and the
  // notices Claude reported along the way, whose rows the App does not keep.
  private explainTurnError(turn: TurnRecord, error: CodexTurnError): CodexTurnError {
    const sleptMs = turn.startedAt == null ? 0 : this.sleepMonitor.sleptSince(turn.startedAt * 1000)
    const explained = withSleepNotice(error, sleptMs, this.platform)
    if (explained !== error) {
      debugLog('turn.slept', { threadId: turn.threadId, turnId: turn.id, sleptMs })
    }
    return withTurnNotices(explained, this.turnNotices.messages(turn.id))
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

  // The peers a thread's message goes to: its followers, else those of the
  // nearest forked-from ancestor (which the thread then inherits), else the
  // peer that caused it.
  private targetsForParams(peer: RpcPeer, params: unknown): RpcPeer[] {
    const threadId = stringOr(asRecord(params).threadId, '')
    if (!threadId) return [peer]
    const direct = this.subscribersByThread.get(threadId)
    if (direct?.size) return [...direct.values()]
    const seen = new Set<string>()
    let current = this.store.getThread(threadId)
    while (current?.forkedFromId && !seen.has(current.forkedFromId)) {
      seen.add(current.forkedFromId)
      const ancestor = this.subscribersByThread.get(current.forkedFromId)
      if (ancestor?.size) {
        this.subscribersByThread.set(threadId, new Map(ancestor))
        return [...ancestor.values()]
      }
      current = this.store.getThread(current.forkedFromId)
    }
    return [peer]
  }

  private subscribersOf(threadId: string): RpcPeer[] {
    return [...(this.subscribersByThread.get(threadId)?.values() ?? [])]
  }

  // Adds a follower to the thread, or moves it to the end as the latest.
  // Neither the detached stub nor a peer that has disconnected meanwhile (a
  // turn outliving its client) is added.
  private subscribe(threadId: string, peer: RpcPeer): void {
    if (!threadId || !this.peers.has(peer.id)) return
    let subscribers = this.subscribersByThread.get(threadId)
    if (!subscribers) {
      subscribers = new Map()
      this.subscribersByThread.set(threadId, subscribers)
    }
    subscribers.delete(peer.id)
    subscribers.set(peer.id, peer)
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
        this.subscribe(child.id, peer)
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
      if (Array.isArray(parsed.installedAppPlugins)) {
        this.installedAppPlugins = parsed.installedAppPlugins.flatMap((entry) => {
          const plugin = asRecord(entry)
          return typeof plugin.id === 'string' && typeof plugin.root === 'string'
            ? [{ id: plugin.id, root: plugin.root }]
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
            installedAppPlugins: this.installedAppPlugins,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
    } catch {}
  }
}
