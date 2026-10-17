import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Extended cache TTL for 1-hour prompt caching
if (!process.env.ANTHROPIC_BETAS) {
  process.env.ANTHROPIC_BETAS = 'extended-cache-ttl-2025-04-11'
} else if (!process.env.ANTHROPIC_BETAS.includes('extended-cache-ttl-2025-04-11')) {
  process.env.ANTHROPIC_BETAS = `${process.env.ANTHROPIC_BETAS},extended-cache-ttl-2025-04-11`
}

// In-process Claude runtime — replaces the Python sidecar entirely. Talks to
// @anthropic-ai/claude-agent-sdk directly so we get a single process boundary
// (Codex App ⇄ adapter), faster cold-starts, and no JSONL bridge to maintain.
//
// Surface contract: the same ClaudeRuntime shape the older sidecar-runtime
// implemented, so server.mts is unchanged.
//
// What this file preserves from the Python sidecar:
//   * subagent suppression state machine (active_subagent_ids)
//   * text/thinking stream-vs-block dedup — JS SDK re-delivers completed
//     content blocks after their streaming deltas
//   * ToolUseBlock double-delivery dedup (skip start, take from AssistantMessage)
//   * StructuredOutput synthetic-tool coercion
//   * derive_permission_mode mapping for (approvalPolicy, sandbox, planMode)
//   * multimodal user input (text + base64/url image blocks)
//
// What this file no longer needs (vs. Python):
//   * class_name / obj_get polymorphism — JS blocks have native block.type
//   * droppable_in_priority TypeError loop — JS Options is a stable type
//   * rate_limit_event parse-gap fallback — JS SDK first-class
//
// Auth: relies on the host having `claude` CLI auth set up (claude /login or
// ANTHROPIC_API_KEY). The SDK shells out to the bundled claude-code binary
// installed via optionalDependencies.

import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { noteClaudeCommands } from './claude-commands.mjs'
import { recordCliChildren } from './cli-orphans.mjs'
import {
  CREATE_GOAL_DESCRIPTION,
  GET_GOAL_DESCRIPTION,
  UPDATE_GOAL_DESCRIPTION,
} from './goal-prompts.mjs'
import { echoedUuids, TurnInput, type TurnInputMessage } from './native-turn-input.mjs'
import { sdkHooks } from './sdk-hooks.mjs'
import { readTaskResult } from './task-output.mjs'
import type {
  ClaudeRuntime,
  ElicitationResponse,
  GoalToolHandlers,
  HookOutputEntry,
  HookRunStatus,
  ImageInput,
  PermissionDecision,
  RuntimeBackgroundListener,
  RuntimeHandlers,
  RuntimeLiveTask,
  RuntimeSteerOptions,
  RuntimeTaskUsage,
  RuntimeTurnContext,
  RuntimeTurnSettings,
  UserInputAnswers,
  UserInputQuestion,
} from './types.mjs'
import { debugLog, newId } from './util.mjs'
import { parseWorkflowCommand, workflowRuntimePrompt } from './workflow-command.mjs'
import {
  defaultWorkflowTranscriptRoots,
  parseWorkflowLaunchInfo,
  WorkflowJournalMonitor,
  type WorkflowLaunchInfo,
} from './workflow-subagents.mjs'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')
type Zod = typeof import('zod')

// In-process MCP server carrying Codex's thread-goal tools.
const GOAL_MCP_SERVER = 'codex_goal'

interface PendingTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  session: LiveSession
  // Claude started this turn itself (a background task reported back); the
  // turn only listens and sent no prompt of its own.
  autonomous: boolean
  // Open for the whole turn; steer() pushes into it and results are
  // attributed against what it sent (see native-turn-input.mts).
  input: TurnInput
  abort: AbortController
  resolved: boolean
  resolve: () => void
  reject: (error: Error) => void
  // SDK assistant envelopes can deliver one content block at a time. Keep
  // dedup scoped to a model response, preserving unstreamed blocks alongside
  // streamed ones and emitting a boundary only when the message id changes.
  assistantMessageId: string | null
  streamedBlocks: Map<number, { type: string; text: string }>
  // Subagent suppression — when a Task/Agent tool_use opens a subagent, all
  // nested tool_use / text / thinking events should be hidden from the App
  // timeline until the matching tool_result closes the parent Task.
  activeSubagents: Set<string>
  completedWorkflowTasks: Set<string>
  workflowToolUseIds: Set<string>
  workflowLaunches: Map<string, WorkflowLaunchInfo>
  workflowTranscriptRoots: string[]
  skippedWorkflowTaskIds: Set<string>
  workflowTasks: Map<string, WorkflowTaskState>
  // Tool ids whose content_block_start we already saw — used to skip the
  // second delivery via AssistantMessage.content (the SDK ships every
  // ToolUseBlock twice; we keep only the AssistantMessage copy because
  // content_block_start arrives with empty input).
  toolStartSeen: Set<string>
  // Buffer + tool ids for StructuredOutput coercion: when the SDK ships a
  // synthetic StructuredOutput tool_use we want to suppress the streamed
  // text and emit only the final coerced JSON.
  structuredBuffer: string
  pendingUserMessage: null | { resolve: (v: { message: unknown }) => void }
  deferredResult: PendingTurnResult | null
  workflowFailure: string | null
  // The model behind the main loop's latest response.
  model: string | null
}

interface PendingTurnResult {
  success: boolean
  resultText: string | null
  claudeSessionId: string | null
}

interface WorkflowTaskState {
  taskId: string
  toolUseId: string
  workflowName: string
  description: string
  prompt: string
  monitor: WorkflowJournalMonitor | null
  aggregateStarted: boolean
  terminal: boolean
  monitorFailed?: boolean
}

interface PendingPermission {
  resolve: (value: PermissionDecision) => void
}

// One Claude Code process. It normally lives exactly as long as its turn, but
// a background task (an Agent the CLI backgrounded, a background shell) runs
// inside that process: closing it after the turn kills the task and drops the
// notification Claude would have answered. While such work is live the session
// stays open between turns. A user turn attaches to it instead of starting a
// new process, and a turn Claude starts on its own (answering a task
// notification) is buffered until the server attaches a continuation turn.
interface LiveSession {
  threadId: string
  query: Query
  input: TurnInput
  abort: AbortController
  // Registered for reuse by later turns of the thread. Structured-output,
  // summary and compaction turns run in sessions of their own.
  reusable: boolean
  signature: string
  lastContext: RuntimeTurnContext
  model: string | null
  effort: string | null
  permissionMode: string
  // The turn currently receiving the session's messages.
  current: PendingTurn | null
  // Messages of a turn Claude started without a prompt from us, held until a
  // continuation turn attaches.
  backlog: Record<string, unknown>[]
  autonomousRequested: boolean
  // Live background tasks (non-ambient). background_tasks_changed is the
  // authoritative level; task_* edges keep it current on CLIs without it.
  liveTasks: Set<string>
  levelSeen: boolean
  tasks: Map<string, SessionTask>
  // A task ended and Claude may still start a turn to answer it.
  unsettled: boolean
  settleObservedRunning: boolean
  cliState: string | null
  // A top-level CLI turn is running: its system/init arrived, its result has
  // not. Every CLI turn, ours or Claude's own, is bracketed this way.
  cliRunning: boolean
  // The CLI reports command_lifecycle frames for the messages we send.
  lifecycleSeen: boolean
  // Sends the CLI has not finished yet (no lifecycle `completed`).
  openCommands: Set<string>
  // Steers waiting for the CLI to start consuming them, by send uuid.
  steers: Map<string, () => void>
  // Tasks the user stopped, and tasks that ended while the CLI was idle:
  // Claude starts a turn to answer those, which is pointless when the user
  // stopped every one of them.
  stoppedTasks: Set<string>
  endedWhileIdle: string[]
  // Interrupted while the process stays alive (see SessionSink).
  sink: SessionSink | null
  settleTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
  // Serializes message routing with turn attachment so a turn never misses
  // or reorders the messages that precede it.
  chain: Promise<void>
  closed: boolean
}

// What a soft interrupt left behind in a live session. The interrupted turn's
// tail has no turn to land in, and sends the CLI had queued but not started
// still run once it gets to them (interrupt() only stops the running turn):
// each is interrupted again as it starts and its output dropped. A new turn
// waits for the sink to drain so the CLI never batches a cancelled send with
// the new prompt.
interface SessionSink {
  pending: Set<string>
  // A CLI turn that answers cancelled input is running; drop until its result.
  turn: boolean
  drained: Promise<void>
  drain: () => void
}

interface SessionTask {
  taskType: string | null
  toolUseId: string | null
  outputFile: string | null
}

const WORKFLOW_TERMINAL_FLUSH_TIMEOUT_MS = 500
const WORKFLOW_JOURNAL_SETTLE_TIMEOUT_MS = 3_000
// How long an idle session waits for Claude to answer a task that just ended
// when the CLI does not report session state.
const SESSION_SETTLE_MS = 15_000
// How long an idle session keeps background tasks alive without any message.
const BACKGROUND_IDLE_MS = 2 * 60 * 60 * 1000
const SESSION_CONTROL_TIMEOUT_MS = 5_000
// How long a new turn waits for an interrupted session to drain before it
// gives up on the sink and goes ahead.
const SINK_DRAIN_TIMEOUT_MS = 30_000
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped'])
// A parked agent keeps its progress but does no work until sent a message.
const IDLE_TASK_STATUSES = new Set([...TERMINAL_TASK_STATUSES, 'paused'])

export class NativeClaudeRuntime implements ClaudeRuntime {
  private sdk: ClaudeSdk | null = null
  // zod builds the goal tools' input schemas. It ships with the SDK's MCP
  // dependency; without it the goal tools are left out.
  private zod: Zod | null = null
  private turns = new Map<string, PendingTurn>()
  private permissions = new Map<string, PendingPermission>()
  private sessions = new Map<string, LiveSession>()
  private listener: RuntimeBackgroundListener | null = null
  // The user's SessionEnd hooks by session (its abort controller): the CLI
  // runs them as it exits, after the SDK has dropped its callbacks.
  private hookEnds = new WeakMap<AbortController, (reason: string) => Promise<void>>()

  setBackgroundListener(listener: RuntimeBackgroundListener): void {
    this.listener = listener
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const sdk = await this.loadSdk()
    if (context.continuation) return this.attachContinuation(context, handlers)
    const draining = this.sessions.get(context.threadId)
    if (draining && !draining.closed && draining.sink) await this.drainSink(draining)
    const live = this.sessions.get(context.threadId)
    if (live && !live.closed && this.isReusable(context)) {
      if (live.signature === sessionSignature(context) || this.hasLiveWork(live)) {
        return this.attachTurn(live, context, handlers, false)
      }
      this.closeSession(live)
    }
    return this.openSession(sdk, context, handlers)
  }

  async steer(
    threadId: string,
    prompt: string,
    options: RuntimeSteerOptions = {},
  ): Promise<boolean> {
    // The CLI either folds the message into the running turn between tool
    // rounds or queues it as a follow-up turn; the turn stays open until it
    // answers. A continuation turn may still be attaching: let it finish.
    let pending = this.activeTurn(threadId)
    const live = this.sessions.get(threadId)
    if (!pending && live && !live.closed) {
      await this.serialize(live, () => {})
      pending = this.activeTurn(threadId)
    }
    if (!pending) return false
    const session = pending.session
    const uuid = this.send(session, this.buildUserMessage(prompt, options.imageInputs ?? []))
    if (!uuid) return false
    // Accepted once the CLI starts consuming it (command_lifecycle `started`)
    // or, on CLIs without lifecycle frames, once a result echoes it.
    if (options.onAccepted) session.steers.set(uuid, options.onAccepted)
    return true
  }

  async updateTurnSettings(
    threadId: string,
    turnId: string,
    settings: RuntimeTurnSettings,
  ): Promise<boolean> {
    const pending = this.turns.get(turnId)
    if (!pending || pending.resolved || pending.context.threadId !== threadId) return false
    const session = pending.session
    if (session.closed) return false
    // Not serialized with turn attachment: a turn waiting on an approval
    // holds that chain. The next turn attaching to this session puts its own
    // settings back (applySessionSettings).
    const query = session.query as Query & {
      setModel?: (model?: string) => Promise<void>
      applyFlagSettings?: (settings: { effortLevel?: string | null }) => Promise<void>
    }
    if (settings.model && settings.model !== session.model) {
      if (!query.setModel) throw new Error('this Claude Code cannot switch models mid-turn')
      session.model = settings.model
      await sessionControl(query.setModel(settings.model), 'model switch')
    }
    if (settings.effort && settings.effort !== session.effort) {
      if (!query.applyFlagSettings)
        throw new Error('this Claude Code cannot change effort mid-turn')
      session.effort = settings.effort
      await sessionControl(
        query.applyFlagSettings({ effortLevel: settings.effort }),
        'effort change',
      )
    }
    return true
  }

  async interrupt(threadId: string): Promise<void> {
    const live = this.sessions.get(threadId)
    const soft = live != null && !live.closed && live.liveTasks.size > 0
    if (soft && live) {
      // Aborting would kill the process and every background task with it.
      // Stop only the running turn; the tasks keep going and report back.
      await this.serialize(live, async () => {
        const current = live.current
        const cancelled = current ? this.cancelSends(live) : []
        if (current) {
          await this.stopLiveWorkflows(live, current)
          await this.stopWorkflowTasks(current)
          this.releaseTurn(current)
          live.current = null
        }
        live.steers.clear()
        live.backlog.length = 0
        live.autonomousRequested = false
        if (live.cliRunning || cancelled.length > 0)
          this.beginSink(live, cancelled, live.cliRunning)
        await settlesWithin(
          live.query.interrupt().catch(() => {}),
          SESSION_CONTROL_TIMEOUT_MS,
        )
        this.maybeRelease(live)
      })
    }
    for (const pending of [...this.turns.values()]) {
      if (pending.context.threadId !== threadId) continue
      if (soft && pending.session === live) continue
      await this.stopWorkflowTasks(pending)
      // The server already settled the turn. Nothing in the process is worth
      // keeping, so end it; a dying session must not take the next turn.
      this.releaseTurn(pending)
      pending.session.steers.clear()
      this.closeSession(pending.session)
      pending.abort.abort()
      await pending.session.query.interrupt().catch(() => {})
    }
  }

  async stopTask(threadId: string, taskId: string): Promise<boolean> {
    const live = this.sessions.get(threadId)
    if (!live || live.closed) return false
    const query = live.query as Query & { stopTask?: (taskId: string) => Promise<void> }
    if (typeof query.stopTask !== 'function') return false
    live.stoppedTasks.add(taskId)
    try {
      await query.stopTask(taskId)
      return true
    } catch (error) {
      live.stoppedTasks.delete(taskId)
      debugLog('native.task.stop_failed', {
        threadId,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  // A workflow belongs to the turn that launched it; the turn waits for it.
  // Left running past an interrupt, it would finish later and wake the thread.
  private async stopLiveWorkflows(live: LiveSession, pending: PendingTurn): Promise<void> {
    const query = live.query as (Query & { stopTask?: (taskId: string) => Promise<void> }) | null
    if (typeof query?.stopTask !== 'function') return
    const taskIds = new Set<string>()
    for (const [taskId, state] of pending.workflowTasks ?? [])
      if (!state.terminal) taskIds.add(taskId)
    for (const taskId of live.liveTasks)
      if (live.tasks.get(taskId)?.taskType === 'local_workflow') taskIds.add(taskId)
    for (const taskId of taskIds) {
      live.stoppedTasks.add(taskId)
      let failed = false
      const settled = await settlesWithin(
        query.stopTask(taskId).catch(() => {
          failed = true
        }),
        SESSION_CONTROL_TIMEOUT_MS,
      )
      if (failed) live.stoppedTasks.delete(taskId)
      debugLog('native.workflow.stop', { threadId: live.threadId, taskId, settled, failed })
    }
  }

  // Background tasks of the thread's live session that are still running.
  liveTasks(threadId: string): RuntimeLiveTask[] {
    const live = this.sessions.get(threadId)
    if (!live || live.closed) return []
    return [...live.liveTasks].map((taskId) => ({
      taskId,
      taskType: live.tasks.get(taskId)?.taskType ?? null,
      toolUseId: live.tasks.get(taskId)?.toolUseId ?? null,
    }))
  }

  filtersNestedEvents(): boolean {
    return true
  }

  hasBackgroundWork(): boolean {
    for (const session of this.sessions.values()) {
      if (!session.closed && this.hasLiveWork(session)) return true
    }
    return false
  }

  hasPendingContinuation(threadId: string): boolean {
    const live = this.sessions.get(threadId)
    return live != null && !live.closed && live.current == null && live.backlog.length > 0
  }

  resetSession(threadId: string): void {
    const live = this.sessions.get(threadId)
    if (live) this.closeSession(live)
  }

  async stop(): Promise<void> {
    for (const pending of this.turns.values()) {
      await this.stopWorkflowTasks(pending)
      pending.abort.abort()
    }
    for (const session of this.sessions.values()) {
      this.clearSessionTimers(session)
      session.closed = true
      session.abort.abort()
      session.input.close()
    }
    this.sessions.clear()
    this.turns.clear()
    this.permissions.clear()
  }

  // ── private ──

  private async loadSdk(): Promise<ClaudeSdk> {
    if (this.sdk) return this.sdk
    // Dynamic import keeps the heavy native binary out of the require graph
    // until a real runtime turn is requested (mocked tests don't pay for it).
    this.sdk = await import('@anthropic-ai/claude-agent-sdk')
    this.zod = await import('zod').catch(() => null)
    return this.sdk
  }

  private buildPromptMessage(context: RuntimeTurnContext): TurnInputMessage {
    return this.buildUserMessage(context.prompt, context.imageInputs)
  }

  private buildUserMessage(prompt: string, images: ImageInput[] | undefined): TurnInputMessage {
    const text = workflowRuntimePrompt(prompt)
    // Pure text — keep the simple string form so the SDK doesn't have to
    // re-stitch content blocks.
    if (!images || images.length === 0) return humanUserMessage(text)
    // Multimodal — assemble the Anthropic MessageParam content array.
    const content: unknown[] = []
    if (text) content.push({ type: 'text', text })
    for (const img of images) {
      if (img.kind === 'base64') {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })
      } else {
        content.push({
          type: 'image',
          source: { type: 'url', url: img.data },
        })
      }
    }
    return humanUserMessage(content as TurnInputMessage['message']['content'])
  }

  private buildOptions(
    sdk: ClaudeSdk,
    context: RuntimeTurnContext,
    abort: AbortController,
    sessionRef: () => LiveSession | null,
  ): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      abortController: abort,
      includePartialMessages: true,
      includeHookEvents: true,
      cwd: context.cwd,
    }
    if (context.model) opts.model = context.model
    if (context.effort) opts.effort = context.effort
    const resume = sdkResumeSessionId(context.claudeSessionId, context.cwd)
    if (resume) opts.resume = resume
    if (resume && context.forkSession) opts.forkSession = true
    // A rewound thread continues from one of its own checkpoints. Forking
    // leaves the source transcript intact, so older checkpoints stay valid.
    if (resume && context.resumeSessionAt) {
      opts.resumeSessionAt = context.resumeSessionAt
      opts.forkSession = true
    }

    // Ensure extended cache TTL is explicitly requested
    if (!process.env.ANTHROPIC_BETAS) {
      process.env.ANTHROPIC_BETAS = 'extended-cache-ttl-2025-04-11'
    }
    // session_state_changed tells a session that outlives its turn when the
    // CLI has finished answering everything queued (see maybeRelease).
    opts.env = { ...process.env, ...context.mcpEnv, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
    if (context.addDirs && context.addDirs.length > 0) opts.additionalDirectories = context.addDirs
    const allowedTools = [...(context.allowedTools ?? []), ...inheritedAllowedTools(context)]
    if (allowedTools.length > 0) opts.allowedTools = allowedTools
    if (context.disallowedTools && context.disallowedTools.length > 0)
      opts.disallowedTools = context.disallowedTools
    if (context.mcpServers && typeof context.mcpServers === 'object')
      opts.mcpServers = context.mcpServers
    if (context.agents && Object.keys(context.agents).length > 0) opts.agents = context.agents
    // The source the CLI would give this session's SessionStart hooks.
    const origin = !resume ? 'startup' : opts.forkSession ? 'fork' : 'resume'
    const { hooks, end } = sdkHooks(context, inheritedApprovals(context), origin)
    if (hooks) opts.hooks = hooks
    if (end) this.hookEnds.set(abort, end)
    let goalServer = false
    if (context.goalTools && this.zod && typeof sdk.createSdkMcpServer === 'function') {
      goalServer = true
      opts.mcpServers = {
        ...((opts.mcpServers as Record<string, unknown> | undefined) ?? {}),
        [GOAL_MCP_SERVER]: goalToolServer(sdk, this.zod, context.goalTools),
      }
    }
    if (context.outputFormat) opts.outputFormat = context.outputFormat

    // Codex App's pinned policies map onto Claude SDK's permissionMode. plan
    // mode supersedes everything. Relay rejects the SDK's dangerous bypass
    // flag outside a recognized container sandbox, so App-level Full Access
    // stays in default mode and auto-allows through canUseTool below. An
    // explicit env override can still opt into bypassPermissions.
    const mode = derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode)
    opts.permissionMode = mode
    if (mode === 'bypassPermissions') opts.allowDangerouslySkipPermissions = true
    // Goal bookkeeping never needs the user's approval. canUseTool allows it
    // where installed; a bare allowedTools entry there would shadow the
    // callback and make the SDK warn on every session.
    if (goalServer && mode === 'plan') {
      opts.allowedTools = [
        ...((opts.allowedTools as string[] | undefined) ?? []),
        `mcp__${GOAL_MCP_SERVER}`,
      ]
    }

    // Workflows are on by default except on Pro plans; the env switch turns
    // them on there too. It deliberately avoids --settings, which pinned
    // launchers reject outright, and leaves an explicit user opt-out alone.
    if (parseWorkflowCommand(context.prompt)?.type === 'run') {
      opts.env = { ...(opts.env as NodeJS.ProcessEnv), CLAUDE_CODE_WORKFLOWS: '1' }
    }

    // Per-tool approval round-trip with Codex App. In App-level Full Access,
    // the bridge auto-allows every permission request without surfacing a UI
    // prompt. Explicit SDK bypass omits the callback because Claude never calls
    // it in that mode.
    if (mode !== 'plan' && mode !== 'bypassPermissions') {
      opts.canUseTool = this.makeCanUseTool(sessionRef)
    }
    // MCP elicitations go to the App in every mode: they ask the user for
    // data, not for permission.
    opts.onElicitation = (request: Record<string, unknown>, options: { signal: AbortSignal }) =>
      this.elicit(sessionRef, request, options.signal)

    // Project + developer + personality instructions ride along as a system
    // prompt append, preserving Claude Code's built-in preset.
    // Re-render on resume so settings changes (including clearing an append)
    // take effect on the next turn instead of waiting for SDK compaction.
    opts.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      snapshot: false,
      ...(context.systemPromptAddendum?.trim()
        ? { append: context.systemPromptAddendum.trim() }
        : {}),
    }

    // CLI binary override (for users pinning a specific claude-code build).
    if (process.env.CLAUDE_CODEX_CLI) opts.pathToClaudeCodeExecutable = process.env.CLAUDE_CODEX_CLI

    void sdk // keep parameter referenced for future SDK-version-gated options
    return opts
  }

  private makeCanUseTool(sessionRef: () => LiveSession | null) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID?: string; signal: AbortSignal },
    ): Promise<
      { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }
    > => {
      if (toolName.startsWith(`mcp__${GOAL_MCP_SERVER}__`)) return { behavior: 'allow' }
      const toolUseId = options.toolUseID || `tool-${newId()}`
      const session = sessionRef()
      const pending = session?.current
      if (!session || !pending || pending.resolved) {
        // A background task asked between turns. There is no turn to surface
        // an approval in, so only the thread's standing policy can answer.
        if (session && toolName !== 'AskUserQuestion' && autoAllowsTools(session.lastContext)) {
          return { behavior: 'allow' }
        }
        return { behavior: 'deny', message: 'no active turn to ask the user for approval' }
      }
      const context = pending.context
      const autoAllow = autoAllowsTools(context)

      // AskUserQuestion is a CLI built-in that, in SDK mode, has no TUI to
      // render the question. Bridge it to Codex's native request_user_input
      // primitive so the App can show a structured choice card. We return
      // the user's answer back to the model through canUseTool's deny
      // channel — denying suppresses the built-in CLI rendering while the
      // `message` body carries the formatted AskUserQuestionOutput JSON so
      // Claude reads the answer just like a normal tool_result.
      if (toolName === 'AskUserQuestion') {
        try {
          const requestId = `${context.threadId}:${context.turnId}:askq:${toolUseId}`
          const questions = parseAskUserQuestions(input)
          if (questions.length === 0) {
            return { behavior: 'deny', message: 'no questions provided' }
          }
          if (typeof pending.handlers.onUserInputRequest !== 'function') {
            return { behavior: 'deny', message: 'user input not available in this runtime' }
          }
          const answers = await pending.handlers.onUserInputRequest({
            type: 'user_input_request',
            requestId,
            toolUseId,
            questions,
          })
          const formatted = formatAskUserQuestionAnswers(input, questions, answers)
          return { behavior: 'deny', message: formatted }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { behavior: 'deny', message: `AskUserQuestion failed: ${msg}` }
        }
      }

      // Auto-allow when the App has selected Full Access / bypassPermissions —
      // matches the previous behaviour of skipping the canUseTool round-trip
      // entirely for those modes.
      if (autoAllow) return { behavior: 'allow' }

      const requestId = `${context.threadId}:${context.turnId}:${toolName}:${toolUseId}`
      // Subagent-aware approval suppression: when Claude is mid-subagent we
      // still want THIS tool to be approved by the user (otherwise nested
      // tools would silently bypass approval). The server-side already
      // routes everything through onPermissionRequest; nothing to change here.
      const decision = await new Promise<PermissionDecision>((resolve) => {
        this.permissions.set(requestId, { resolve })
        void Promise.resolve(
          pending.handlers.onPermissionRequest({
            type: 'permission_request',
            requestId,
            toolUseId,
            toolName,
            input,
          }),
        ).then((d) => {
          // The handler may resolve synchronously via the App's permission
          // response. Surface that here.
          this.permissions.delete(requestId)
          resolve(d)
        })
      })

      if (decision.decision === 'accept' || decision.decision === 'acceptForSession') {
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
      }
      return { behavior: 'deny', message: 'denied by user' }
    }
  }

  private async elicit(
    sessionRef: () => LiveSession | null,
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ElicitationResponse> {
    const pending = sessionRef()?.current
    // Between turns (a background task's MCP call) there is nowhere to ask.
    if (!pending || pending.resolved || !pending.handlers.onElicitationRequest)
      return { action: 'decline' }
    const url = stringOrNull(request.url)
    const mode = request.mode === 'url' && url ? 'url' : 'form'
    const schema = request.requestedSchema
    try {
      return await pending.handlers.onElicitationRequest(
        {
          serverName: String(request.serverName ?? ''),
          message: String(request.message ?? ''),
          mode,
          requestedSchema:
            schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : null,
          url: mode === 'url' ? url : null,
          elicitationId: stringOrNull(request.elicitationId),
        },
        signal,
      )
    } catch {
      return { action: 'cancel' }
    }
  }

  private openSession(
    sdk: ClaudeSdk,
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
  ): Promise<void> {
    const abort = new AbortController()
    return new Promise<void>((resolve, reject) => {
      // The SDK accepts either a plain string prompt OR an AsyncIterable of
      // SDKUserMessage envelopes. Always feed the iterable form so we have
      // room to attach image blocks alongside the text, and keep it open for
      // the whole session so mid-turn steer() calls, control round trips and
      // later turns still reach the CLI.
      const input = new TurnInput()
      const reusable = this.isReusable(context) && this.listener != null
      // canUseTool reaches the session only once Claude asks for a tool.
      let session: LiveSession | null = null
      const options = this.buildOptions(sdk, context, abort, () => session)
      const opened: LiveSession = {
        threadId: context.threadId,
        query: sdk.query({ prompt: input, options }),
        input,
        abort,
        reusable,
        signature: sessionSignature(context),
        lastContext: context,
        model: context.model,
        effort: context.effort ?? null,
        permissionMode: derivePermissionMode(
          context.approvalPolicy,
          context.sandboxMode,
          context.planMode,
        ),
        current: null,
        backlog: [],
        autonomousRequested: false,
        liveTasks: new Set(),
        levelSeen: false,
        tasks: new Map(),
        unsettled: false,
        settleObservedRunning: false,
        cliState: null,
        cliRunning: false,
        lifecycleSeen: false,
        openCommands: new Set(),
        steers: new Map(),
        stoppedTasks: new Set(),
        endedWhileIdle: [],
        sink: null,
        settleTimer: null,
        idleTimer: null,
        chain: Promise.resolve(),
        closed: false,
      }
      session = opened
      this.send(opened, this.buildPromptMessage(context))
      const pending = this.createPendingTurn(opened, context, handlers, false, resolve, reject)
      opened.current = pending
      this.turns.set(context.turnId, pending)
      if (reusable) {
        const previous = this.sessions.get(context.threadId)
        if (previous && previous !== opened) this.closeSession(previous)
        this.sessions.set(context.threadId, opened)
      }
      // Run the receive loop in the background. runTurn() resolves when this
      // turn's result arrives; the loop itself runs for the session.
      void this.consumeSession(opened)
    })
  }

  private attachContinuation(
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
  ): Promise<void> {
    const live = this.sessions.get(context.threadId)
    if (!live || live.closed || (live.backlog.length === 0 && !live.autonomousRequested)) {
      // Nothing left to receive (a user turn already took it, or the session
      // ended): an empty turn completes immediately.
      return Promise.resolve(
        handlers.onEvent({ type: 'completed', success: true, result: null }),
      ).then(() => {})
    }
    return this.attachTurn(live, context, handlers, true)
  }

  private attachTurn(
    session: LiveSession,
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
    autonomous: boolean,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pending = this.createPendingTurn(
        session,
        context,
        handlers,
        autonomous,
        resolve,
        reject,
      )
      void this.serialize(session, async () => {
        if (session.closed) {
          pending.resolved = true
          if (autonomous) {
            await handlers.onEvent({ type: 'completed', success: true, result: null })
            resolve()
          } else {
            reject(new Error('Claude session ended before the turn could start'))
          }
          return
        }
        this.clearSessionTimers(session)
        // A turn the server has given up on (or never claimed) yields.
        if (session.current) this.releaseTurn(session.current)
        session.current = pending
        session.lastContext = context
        session.autonomousRequested = false
        session.steers.clear()
        this.turns.set(context.turnId, pending)
        session.input.beginTurn()
        if (!autonomous) {
          await this.applySessionSettings(session, context)
          this.send(session, this.buildPromptMessage(context))
        }
        // Replay what Claude already produced on its own. Anything after the
        // result that ends this turn stays queued for the next one.
        while (session.backlog.length > 0 && !pending.resolved) {
          const message = session.backlog.shift() as Record<string, unknown>
          await this.deliver(session, pending, message)
        }
        if (pending.resolved) {
          this.detach(session, pending)
          // The replay may have been everything Claude had to say; no later
          // message is coming to schedule the release.
          this.maybeRelease(session)
        }
      }).catch((error: unknown) => {
        if (pending.resolved) return
        pending.resolved = true
        this.turns.delete(context.turnId)
        if (session.current === pending) session.current = null
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private createPendingTurn(
    session: LiveSession,
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
    autonomous: boolean,
    resolve: () => void,
    reject: (error: Error) => void,
  ): PendingTurn {
    return {
      context,
      handlers,
      session,
      autonomous,
      input: session.input,
      abort: session.abort,
      resolved: false,
      resolve,
      reject,
      assistantMessageId: null,
      streamedBlocks: new Map(),
      activeSubagents: new Set(),
      completedWorkflowTasks: new Set(),
      workflowToolUseIds: new Set(),
      workflowLaunches: new Map(),
      workflowTranscriptRoots: defaultWorkflowTranscriptRoots(process.env, context.cwd),
      skippedWorkflowTaskIds: new Set(),
      workflowTasks: new Map(),
      toolStartSeen: new Set(),
      structuredBuffer: '',
      pendingUserMessage: null,
      deferredResult: null,
      workflowFailure: null,
      model: null,
    }
  }

  private async applySessionSettings(
    session: LiveSession,
    context: RuntimeTurnContext,
  ): Promise<void> {
    const query = session.query as Query & {
      setModel?: (model?: string) => Promise<void>
      setPermissionMode?: (mode: string) => Promise<void>
      applyFlagSettings?: (settings: { effortLevel?: string | null }) => Promise<void>
    }
    if (context.model && context.model !== session.model && query.setModel) {
      session.model = context.model
      await settlesWithin(
        query.setModel(context.model).catch(() => {}),
        SESSION_CONTROL_TIMEOUT_MS,
      )
    }
    // Effort is part of the session signature, so only a turn pinned to this
    // session by background work, or one after a mid-turn change, gets here
    // with a different effort. null is the model's default.
    const effort = context.effort ?? null
    if (effort !== session.effort && query.applyFlagSettings) {
      session.effort = effort
      await settlesWithin(
        query.applyFlagSettings({ effortLevel: effort }).catch(() => {}),
        SESSION_CONTROL_TIMEOUT_MS,
      )
    }
    const mode = derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode)
    if (
      mode !== session.permissionMode &&
      mode !== 'bypassPermissions' &&
      session.permissionMode !== 'bypassPermissions' &&
      query.setPermissionMode
    ) {
      session.permissionMode = mode
      await settlesWithin(
        query.setPermissionMode(mode).catch(() => {}),
        SESSION_CONTROL_TIMEOUT_MS,
      )
    }
  }

  private serialize(session: LiveSession, task: () => Promise<void> | void): Promise<void> {
    const run = session.chain.then(task)
    session.chain = run.catch(() => {})
    return run
  }

  private async consumeSession(session: LiveSession): Promise<void> {
    let failure: Error | null = null
    try {
      for await (const message of session.query as AsyncIterable<Record<string, unknown>>) {
        await this.serialize(session, () => this.routeMessage(session, message))
        if (session.closed) break
      }
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err))
    }
    await this.serialize(session, () => this.endSession(session, failure))
  }

  private async routeMessage(
    session: LiveSession,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (session.closed) return
    this.clearSessionTimers(session)
    const type = String(message.type ?? '')
    if (type === 'command_lifecycle') {
      this.trackCommand(session, message)
      this.maybeRelease(session)
      return
    }
    if (type === 'system') await this.trackSessionSystem(session, message)
    const init = type === 'system' && message.subtype === 'init' && !message.parent_tool_use_id
    const result = type === 'result'
    let endedWhileIdle: string[] = []
    if (init) {
      // Claude started a turn: whatever just ended is being answered now.
      endedWhileIdle = session.endedWhileIdle
      session.endedWhileIdle = []
      session.cliRunning = true
      session.unsettled = false
    }
    const sink = session.sink
    if (
      sink &&
      !sink.turn &&
      sink.pending.size > 0 &&
      !session.lifecycleSeen &&
      (init || result || isTurnOutput(type, message))
    ) {
      // Without lifecycle frames, the next turn is the cancelled input's:
      // the CLI runs queued input in order.
      sink.turn = true
      this.reinterrupt(session)
    }
    if (result) for (const uuid of echoedUuids(message)) this.acceptSteer(session, uuid)
    if (session.sink?.turn) {
      if (result) this.endSinkTurn(session, message)
    } else if (session.current) {
      await this.deliver(session, session.current, message)
      if (session.current?.resolved) this.detach(session, session.current)
    } else if (init && this.answersOnlyStoppedTasks(session, endedWhileIdle)) {
      // The user stopped these tasks; Codex does not wake the parent for
      // that, so neither does a turn Claude starts only to acknowledge it.
      debugLog('native.session.stopped_task_turn', {
        threadId: session.threadId,
        taskIds: endedWhileIdle,
      })
      this.beginSink(session, [], true)
      this.reinterrupt(session)
    } else if (this.startsAutonomousTurn(session, type, message)) {
      session.backlog.push(message)
      if (!session.autonomousRequested) {
        session.autonomousRequested = true
        this.listener?.onAutonomousTurn(session.threadId)
      }
    }
    if (result) {
      session.cliRunning = false
      if (!session.lifecycleSeen)
        for (const uuid of echoedUuids(message)) session.openCommands.delete(uuid)
    }
    this.maybeRelease(session)
  }

  // Between turns, only Claude's own top-level output means it started a
  // turn: its system/init, then the response (an api_retry while the model
  // is still unreachable). Nested output belongs to a running task, a bare
  // result has nothing left to show, and bookkeeping frames (rate limits,
  // hooks, task progress) come and go.
  private startsAutonomousTurn(
    session: LiveSession,
    type: string,
    message: Record<string, unknown>,
  ): boolean {
    if (!session.reusable || !this.listener) return false
    if (message.parent_tool_use_id) return false
    if (type === 'result') return session.backlog.length > 0
    if (type === 'system') {
      return message.subtype === 'init' || (message.subtype === 'api_retry' && session.cliRunning)
    }
    return isTurnOutput(type, message)
  }

  private answersOnlyStoppedTasks(session: LiveSession, ended: string[]): boolean {
    return ended.length > 0 && ended.every((taskId) => session.stoppedTasks.has(taskId))
  }

  private activeTurn(threadId: string): PendingTurn | null {
    const live = this.sessions.get(threadId)
    if (live?.current && !live.current.resolved) return live.current
    for (const pending of this.turns.values()) {
      if (pending.context.threadId === threadId && !pending.resolved) return pending
    }
    return null
  }

  private send(session: LiveSession, message: TurnInputMessage): string | null {
    const uuid = session.input.send(message)
    if (uuid) session.openCommands.add(uuid)
    return uuid
  }

  // command_lifecycle: queued → started → (the turn) → completed, keyed by
  // the uuid we stamped on the send.
  private trackCommand(session: LiveSession, message: Record<string, unknown>): void {
    session.lifecycleSeen = true
    const uuid = stringOrNull(message.command_uuid)
    if (!uuid) return
    const state = stringOrNull(message.state)
    if (state === 'started') {
      this.acceptSteer(session, uuid)
      const sink = session.sink
      if (sink?.pending.has(uuid)) {
        // Interrupted before it started; it is starting now. Stop it too.
        sink.turn = true
        this.reinterrupt(session)
      }
    } else if (state === 'completed') {
      session.openCommands.delete(uuid)
      if (session.sink?.pending.delete(uuid)) this.settleSink(session)
    }
  }

  private acceptSteer(session: LiveSession, uuid: string): void {
    const accept = session.steers.get(uuid)
    if (!accept) return
    session.steers.delete(uuid)
    try {
      accept()
    } catch (error) {
      debugLog('native.steer.accept_failed', {
        threadId: session.threadId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // The current turn's sends the CLI has not finished. Those still in our
  // queue never reached it and are dropped outright.
  private cancelSends(session: LiveSession): string[] {
    const unanswered = session.input.unansweredUuids()
    const dropped = new Set(session.input.discard(unanswered))
    for (const uuid of dropped) session.openCommands.delete(uuid)
    return unanswered.filter(
      (uuid) => !dropped.has(uuid) && (!session.lifecycleSeen || session.openCommands.has(uuid)),
    )
  }

  private beginSink(session: LiveSession, pending: string[], turn: boolean): void {
    const previous = session.sink
    let resolve: () => void = () => {}
    const drained = new Promise<void>((done) => {
      resolve = done
    })
    session.sink = {
      pending: new Set([...(previous?.pending ?? []), ...pending]),
      turn: turn || (previous?.turn ?? false),
      drained,
      drain: () => {
        resolve()
        previous?.drain()
      },
    }
    this.settleSink(session)
  }

  private endSinkTurn(session: LiveSession, result: Record<string, unknown>): void {
    const sink = session.sink
    if (!sink) return
    sink.turn = false
    for (const uuid of echoedUuids(result)) sink.pending.delete(uuid)
    // Older producers echo nothing and report no lifecycle: the result is
    // all there is to go by.
    if (!session.lifecycleSeen && !Array.isArray(result.user_message_uuids)) sink.pending.clear()
    this.settleSink(session)
  }

  private settleSink(session: LiveSession): void {
    const sink = session.sink
    if (!sink || sink.turn || sink.pending.size > 0) return
    session.sink = null
    sink.drain()
  }

  private reinterrupt(session: LiveSession): void {
    // Not awaited: routing must keep draining the stream meanwhile.
    void session.query.interrupt().catch(() => {})
  }

  private async drainSink(session: LiveSession): Promise<void> {
    const sink = session.sink
    if (!sink) return
    if (await settlesWithin(sink.drained, SINK_DRAIN_TIMEOUT_MS)) return
    if (session.sink !== sink) return
    debugLog('native.session.sink_timeout', {
      threadId: session.threadId,
      pending: [...sink.pending],
      turn: sink.turn,
    })
    session.sink = null
    sink.drain()
  }

  private async deliver(
    session: LiveSession,
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.handleMessage(pending, message)
    } catch (err) {
      if (pending.resolved) return
      await this.stopWorkflowTasks(pending).catch(() => {})
      pending.resolved = true
      this.turns.delete(pending.context.turnId)
      if (session.current === pending && message.type !== 'result') this.abandonCliTurn(session)
      const error = err instanceof Error ? err : new Error(String(err))
      try {
        await pending.handlers.onEvent({ type: 'error', message: error.message })
      } catch {}
      pending.reject(error)
    }
  }

  // The server failed a turn the CLI is still running. Left alone, the CLI
  // would carry on with it unseen, tools and all, and its output would come
  // back as a turn of its own. Background tasks keep the session; a session
  // without any has nothing worth keeping.
  private abandonCliTurn(session: LiveSession): void {
    session.current = null
    session.steers.clear()
    session.backlog.length = 0
    session.autonomousRequested = false
    if (session.liveTasks.size === 0) {
      this.closeSession(session)
      session.abort.abort()
      return
    }
    // Routing must keep draining the stream, so the interrupt is not awaited.
    this.beginSink(session, this.cancelSends(session), session.cliRunning)
    this.reinterrupt(session)
  }

  private detach(session: LiveSession, pending: PendingTurn): void {
    if (session.current === pending) session.current = null
    this.turns.delete(pending.context.turnId)
    if (session.closed || session.backlog.length === 0 || !session.reusable || !this.listener)
      return
    // Claude already began its next turn while this one was finishing.
    session.autonomousRequested = true
    this.listener.onAutonomousTurn(session.threadId)
  }

  // Resolve a turn without a terminal event: the server already settled it
  // (interrupt) or a newer turn took the session over.
  private releaseTurn(pending: PendingTurn): void {
    if (pending.resolved) return
    pending.resolved = true
    this.turns.delete(pending.context.turnId)
    pending.resolve()
  }

  private maybeRelease(session: LiveSession): void {
    if (session.closed || session.current || session.backlog.length > 0) return
    if (!session.reusable) {
      this.closeSession(session)
      return
    }
    // Background tasks, a CLI turn nobody has claimed yet (the model can be
    // unreachable for a while: api_retry backs off for tens of seconds), or
    // an interrupted turn still draining: all need the process.
    if (session.liveTasks.size > 0 || session.cliRunning || session.sink) {
      session.idleTimer = setTimeout(() => {
        session.idleTimer = null
        debugLog('native.session.idle_timeout', {
          threadId: session.threadId,
          liveTasks: [...session.liveTasks],
          cliRunning: session.cliRunning,
        })
        if (!session.current && session.backlog.length === 0) this.closeSession(session)
      }, backgroundIdleMs())
      session.idleTimer.unref?.()
      return
    }
    // A task just ended: Claude starts its turn to answer it within moments.
    if (session.unsettled) {
      session.settleTimer = setTimeout(() => {
        session.settleTimer = null
        if (!session.current && session.backlog.length === 0 && session.liveTasks.size === 0)
          this.closeSession(session)
      }, sessionSettleMs())
      session.settleTimer.unref?.()
      return
    }
    this.closeSession(session)
  }

  private closeSession(session: LiveSession): void {
    if (session.closed) return
    session.closed = true
    this.clearSessionTimers(session)
    session.input.close()
    try {
      ;(session.query as Query & { close?: () => void }).close?.()
    } catch {}
  }

  private clearSessionTimers(session: LiveSession): void {
    if (session.settleTimer) clearTimeout(session.settleTimer)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.settleTimer = null
    session.idleTimer = null
  }

  private async endSession(session: LiveSession, failure: Error | null): Promise<void> {
    this.clearSessionTimers(session)
    session.closed = true
    // A superseded session winds down after its replacement registered; the
    // thread's background work now belongs to the replacement.
    const registered = this.sessions.get(session.threadId)
    const superseded = registered != null && registered !== session
    if (registered === session) this.sessions.delete(session.threadId)
    // Release the CLI's stdin (see TurnInput).
    session.input.close()
    void this.hookEnds.get(session.abort)?.('other')
    const pending = session.current
    session.current = null
    if (pending && !pending.resolved) await this.finishTurnAtSessionEnd(pending, failure)
    session.backlog.length = 0
    const liveTasks = [...session.liveTasks]
    session.liveTasks.clear()
    if (session.reusable && !superseded) {
      this.listener?.onSessionReleased(session.threadId, liveTasks)
    }
  }

  private async finishTurnAtSessionEnd(pending: PendingTurn, failure: Error | null): Promise<void> {
    const { context, handlers } = pending
    if (failure) {
      await this.stopWorkflowTasks(pending)
      pending.resolved = true
      this.turns.delete(context.turnId)
      try {
        await handlers.onEvent({ type: 'error', message: failure.message })
      } catch {}
      pending.reject(failure)
      return
    }
    if (pending.deferredResult) {
      // The SDK iterator is the authoritative lifetime of a turn. If it
      // closes while a workflow journal still has an unresolved task, there
      // will be no later task_notification to unblock the deferred result.
      // Close those projected agents as failed and finish the parent turn
      // rather than leaving the Codex App's spinner alive forever.
      if (this.hasPendingWorkflowTasks(pending)) await this.stopWorkflowTasks(pending)
      await this.finishDeferredResult(pending, true)
      if (!pending.resolved) return
    }
    // The async iterator finished without a 'result' message — treat as
    // successful empty turn (claude-agent-sdk does occasionally end without
    // a SDKResultMessage when interrupted cleanly).
    if (!pending.resolved) {
      await this.stopWorkflowTasks(pending)
      pending.resolved = true
      this.turns.delete(context.turnId)
      try {
        await handlers.onEvent({ type: 'completed', success: true, result: null })
        pending.resolve()
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  private isReusable(context: RuntimeTurnContext): boolean {
    return (context.purpose ?? 'normal') === 'normal' && !context.outputFormat
  }

  private hasLiveWork(session: LiveSession): boolean {
    return (
      session.current != null ||
      session.liveTasks.size > 0 ||
      session.unsettled ||
      session.cliRunning ||
      session.sink != null ||
      session.backlog.length > 0
    )
  }

  // Background task bookkeeping. Every system frame passes through here
  // before the current turn (if any) sees it; workflow tasks keep their own
  // projection in handleSystem and are only counted for liveness here.
  private async trackSessionSystem(
    session: LiveSession,
    message: Record<string, unknown>,
  ): Promise<void> {
    const subtype = String(message.subtype ?? '')
    if (subtype === 'session_state_changed') {
      const state = String(message.state ?? '')
      if (state === 'idle') {
        if (session.unsettled && session.settleObservedRunning) session.unsettled = false
      } else if (session.unsettled) {
        session.settleObservedRunning = true
      }
      session.cliState = state || null
      return
    }
    if (subtype === 'background_tasks_changed') {
      const next = new Set<string>()
      for (const entry of Array.isArray(message.tasks) ? message.tasks : []) {
        const task = recordOrNull(entry)
        const taskId = stringOrNull(task?.task_id)
        if (taskId && task?.ambient !== true) next.add(taskId)
      }
      for (const taskId of session.liveTasks) if (!next.has(taskId)) this.markTaskEnded(session)
      session.liveTasks = next
      session.levelSeen = true
      return
    }
    if (
      subtype !== 'task_started' &&
      subtype !== 'task_progress' &&
      subtype !== 'task_updated' &&
      subtype !== 'task_notification'
    )
      return
    const taskId = stringOrNull(message.task_id)
    if (!taskId) return
    const known = session.tasks.get(taskId)
    const toolUseId = stringOrNull(message.tool_use_id) ?? known?.toolUseId ?? null
    const taskType = stringOrNull(message.task_type) ?? known?.taskType ?? null
    const workflow = taskType === 'local_workflow'
    const listener = session.reusable && !workflow ? this.listener : null

    if (subtype === 'task_started') {
      session.tasks.set(taskId, { taskType, toolUseId, outputFile: known?.outputFile ?? null })
      const backgrounded =
        typeof message.is_backgrounded === 'boolean' ? message.is_backgrounded : null
      if (!session.levelSeen && backgrounded === true && message.ambient !== true)
        session.liveTasks.add(taskId)
      await listener?.onTaskEvent(session.threadId, {
        type: 'task_started',
        taskId,
        toolUseId,
        taskType,
        description: String(message.description ?? ''),
        subagentType: stringOrNull(message.subagent_type),
        prompt: stringOrNull(message.prompt),
        backgrounded,
      })
      return
    }
    if (subtype === 'task_progress') {
      await listener?.onTaskEvent(session.threadId, {
        type: 'task_progress',
        taskId,
        toolUseId,
        description: String(message.description ?? ''),
        summary: stringOrNull(message.summary),
        lastToolName: stringOrNull(message.last_tool_name),
        usage: taskUsage(message.usage),
      })
      return
    }
    if (subtype === 'task_updated') {
      const patch = recordOrNull(message.patch) ?? {}
      const status = stringOrNull(patch.status)
      const backgrounded = typeof patch.is_backgrounded === 'boolean' ? patch.is_backgrounded : null
      if (!session.levelSeen) {
        if (status && IDLE_TASK_STATUSES.has(status)) {
          if (session.liveTasks.delete(taskId)) this.markTaskEnded(session)
        } else if (backgrounded === true) {
          session.liveTasks.add(taskId)
        }
      }
      await listener?.onTaskEvent(session.threadId, {
        type: 'task_updated',
        taskId,
        status,
        backgrounded,
        error: stringOrNull(patch.error),
      })
      return
    }
    // task_notification: the task is over and Claude is told about it. A
    // foreground task ends inside its turn and leaves nothing to answer.
    if (!session.levelSeen && session.liveTasks.delete(taskId)) this.markTaskEnded(session)
    const rawStatus = String(message.status ?? '')
    const status =
      rawStatus === 'failed' ? 'failed' : rawStatus === 'stopped' ? 'stopped' : 'completed'
    // Interrupting a turn also stops the background agents it launched. Like
    // a stop from the user, that is no news to wake the thread with.
    if (status === 'stopped') session.stoppedTasks.add(taskId)
    // An interrupted turn answers nothing more: what ends while it drains is
    // left for the turn after it, same as when the CLI is idle.
    if (!session.cliRunning || session.sink) session.endedWhileIdle.push(taskId)
    const outputFile = stringOrNull(message.output_file) ?? known?.outputFile ?? null
    const result =
      listener && outputFile && (taskType === 'local_agent' || taskType == null)
        ? await readTaskResult(outputFile)
        : null
    await listener?.onTaskEvent(session.threadId, {
      type: 'task_notification',
      taskId,
      toolUseId,
      status,
      summary: String(message.summary ?? ''),
      result,
      usage: taskUsage(message.usage),
    })
  }

  private markTaskEnded(session: LiveSession): void {
    session.unsettled = true
    // A CLI already busy reports idle only once it has drained its queue,
    // notification included. An idle one must first be seen running again.
    session.settleObservedRunning = session.cliState != null && session.cliState !== 'idle'
  }

  private async handleMessage(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const type = String(message.type ?? '')
    if ((type === 'assistant' || type === 'user') && !message.parent_tool_use_id) {
      const messageUuid = stringOrNull(message.uuid)
      const claudeSessionId = stringOrNull(message.session_id)
      if (messageUuid && claudeSessionId)
        await pending.handlers.onEvent({ type: 'checkpoint', claudeSessionId, messageUuid })
    }
    switch (type) {
      case 'system':
        await this.handleSystem(pending, message)
        break
      case 'stream_event':
        await this.handleStreamEvent(pending, message)
        break
      case 'assistant':
        await this.handleAssistant(pending, message)
        break
      case 'user':
        await this.handleUser(pending, message)
        break
      case 'result':
        await this.handleResult(pending, message)
        break
      default:
        // Rate-limit notifications and other non-system frames.
        await this.handleOther(pending, type, message)
    }
  }

  private async handleSystem(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const subtype = String(message.subtype ?? '')
    if (subtype === 'init') {
      void recordCliChildren()
      const skills = Array.isArray(message.skills) ? message.skills.map(String) : null
      if (skills)
        void pending.session.query
          ?.supportedCommands()
          .then((commands) => noteClaudeCommands(commands, skills))
          .catch(() => {})
      const sessionId = String(message.session_id ?? '')
      if (sessionId) await pending.handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
      return
    }
    if (subtype === 'hook_started' || subtype === 'hook_response') {
      const hookId = stringOrNull(message.hook_id)
      const hookEvent = stringOrNull(message.hook_event)
      if (!hookId || !hookEvent) return
      const run =
        subtype === 'hook_started'
          ? { status: 'running' as const, entries: [] }
          : hookRunOutcome(message)
      await pending.handlers.onEvent({ type: 'hook_run', hookId, hookEvent, ...run })
      return
    }
    if (subtype === 'model_refusal_fallback') {
      const text = stringOrNull(message.content)
      // 'local' fell back for a subagent only, and 'revert' returns to the
      // original model: the session's model did not move away.
      if (message.scope === 'local' || message.direction === 'revert') {
        if (text)
          await pending.handlers.onEvent({ type: 'notice', level: 'warning', message: text })
        return
      }
      const fromModel = String(message.original_model ?? '')
      const toModel = String(message.fallback_model ?? '')
      await pending.handlers.onEvent({
        type: 'model_rerouted',
        fromModel,
        toModel,
        category: stringOrNull(message.api_refusal_category),
        message: text ?? `Claude switched from ${fromModel} to ${toModel} after a refusal.`,
      })
      return
    }
    if (subtype === 'model_refusal_no_fallback' || subtype === 'informational') {
      const text = stringOrNull(message.content)
      // Informational lines below 'warning' are transcript chatter.
      if (!text || (subtype === 'informational' && message.level !== 'warning')) return
      await pending.handlers.onEvent({ type: 'notice', level: 'warning', message: text })
      return
    }
    if (subtype === 'permission_denied') {
      // The SDK auto-denied a tool call (auto-mode classifier, deny rule, etc).
      // Surface as a notice so the user sees why nothing happened.
      const toolName = String((message as Record<string, unknown>).tool_name ?? 'tool')
      await pending.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: `Permission denied for ${toolName}`,
      })
      return
    }
    if (subtype === 'task_started' && isWorkflowBackgroundTask(message)) {
      const taskId = String(message.task_id ?? '')
      if (!taskId) return
      const sourceToolUseId = String(message.tool_use_id ?? '')
      if (message.skip_transcript === true) {
        const skipped =
          pending.skippedWorkflowTaskIds ?? (pending.skippedWorkflowTaskIds = new Set())
        skipped.add(taskId)
        this.discardDeferredWorkflowLaunches(pending, taskId, sourceToolUseId)
        const hiddenState = pending.workflowTasks?.get(taskId)
        if (hiddenState) {
          hiddenState.terminal = true
          await hiddenState.monitor?.stop()
          await this.closeWorkflowAgentLifecycles(
            pending,
            hiddenState,
            'Workflow transcript was hidden before the agent completed.',
            false,
          )
          await this.closeWorkflowAggregateLifecycle(
            pending,
            hiddenState,
            'Workflow transcript was hidden.',
            false,
          )
        }
        await this.finishDeferredResult(pending)
        return
      }
      const toolUseId = workflowTaskToolUseId(taskId)
      if (pending.completedWorkflowTasks.has(toolUseId)) return
      const state = this.ensureWorkflowTask(pending, taskId)
      if (sourceToolUseId && !state.toolUseId) state.toolUseId = sourceToolUseId
      state.workflowName = String(message.workflow_name ?? '').trim() || state.workflowName
      state.description = String(message.description ?? '').trim() || state.description
      state.prompt =
        String(message.prompt ?? '').trim() ||
        state.prompt ||
        state.description ||
        state.workflowName
      this.attachDeferredWorkflowJournal(pending, state, sourceToolUseId)
      return
    }
    if (subtype === 'task_notification') {
      const taskId = String(message.task_id ?? '')
      if (!taskId) return
      const knownState = pending.workflowTasks?.get(taskId)
      const hasWorkflowHint =
        isWorkflowBackgroundTask(message) || String(message.workflow_name ?? '').trim().length > 0
      const sourceToolUseId = String(message.tool_use_id ?? '')
      const hasPendingWorkflowLaunch = [...(pending.workflowLaunches?.values() ?? [])].some(
        (launch) => launch.taskId === taskId,
      )
      const hasPendingWorkflowTool =
        sourceToolUseId.length > 0 && pending.workflowToolUseIds?.has(sourceToolUseId) === true
      // The SDK's task_notification shape does not require task_type or
      // workflow_name. Once this turn has a matching launch/tool id, the task
      // is already proven to be a Workflow and the terminal notification must
      // not be discarded just because optional hints are absent.
      if (!knownState && !hasWorkflowHint && !hasPendingWorkflowLaunch && !hasPendingWorkflowTool)
        return
      if (pending.skippedWorkflowTaskIds?.has(taskId)) {
        this.discardDeferredWorkflowLaunches(pending, taskId, '')
        const hiddenState = pending.workflowTasks?.get(taskId)
        if (hiddenState) {
          hiddenState.terminal = true
          await hiddenState.monitor?.stop()
          await this.closeWorkflowAgentLifecycles(
            pending,
            hiddenState,
            'Workflow transcript was hidden before the agent completed.',
            false,
          )
          await this.closeWorkflowAggregateLifecycle(
            pending,
            hiddenState,
            'Workflow transcript was hidden.',
            false,
          )
        }
        await this.finishDeferredResult(pending)
        return
      }
      let state = knownState
      if (!state) {
        // Claude can emit task_notification before task_started (especially
        // after a reconnect or when the SDK batches system events). Create the
        // projected state from the notification instead of dropping the only
        // terminal signal and leaving the parent deferred forever.
        state = this.ensureWorkflowTask(pending, taskId)
        if (sourceToolUseId && !state.toolUseId) state.toolUseId = sourceToolUseId
        state.workflowName = String(message.workflow_name ?? '').trim() || state.workflowName
        state.description = String(message.description ?? '').trim() || state.description
        state.prompt =
          String(message.prompt ?? '').trim() ||
          state.prompt ||
          state.description ||
          state.workflowName
        this.attachDeferredWorkflowJournal(pending, state, sourceToolUseId)
      }
      if (message.skip_transcript === true) {
        const skipped =
          pending.skippedWorkflowTaskIds ?? (pending.skippedWorkflowTaskIds = new Set())
        skipped.add(taskId)
        this.discardDeferredWorkflowLaunches(pending, taskId, state.toolUseId)
        state.terminal = true
        await state.monitor?.stop()
        await this.closeWorkflowAgentLifecycles(
          pending,
          state,
          'Workflow transcript was hidden before the agent completed.',
          false,
        )
        await this.closeWorkflowAggregateLifecycle(
          pending,
          state,
          'Workflow transcript was hidden.',
          false,
        )
        await this.finishDeferredResult(pending)
        return
      }
      const toolUseId = workflowTaskToolUseId(taskId)
      if (pending.completedWorkflowTasks.has(toolUseId)) {
        state.terminal = true
        await this.finishDeferredResult(pending)
        return
      }
      const status = String(message.status ?? '')
      const summary = String(message.summary ?? '').trim() || `Workflow ${status || 'finished'}`
      const usage = workflowTaskUsage(message.usage)
      const trailer = usage
        ? `\n<usage>total_tokens: ${usage.totalTokens}\ntool_uses: ${usage.toolUses}\nduration_ms: ${usage.durationMs}</usage>`
        : ''
      const monitor = state.monitor
      let monitorStopped = false
      if (monitor && !state.aggregateStarted && !state.monitorFailed) {
        await settlesWithin(monitor.flush(), WORKFLOW_TERMINAL_FLUSH_TIMEOUT_MS)
        // onError can replace state.monitor while flush() is awaiting I/O.
        // Continue through the aggregate fallback in that case; never
        // dereference the mutable field after an await.
        if (state.monitor === monitor && !state.monitorFailed) {
          await monitor.drain(WORKFLOW_JOURNAL_SETTLE_TIMEOUT_MS)
        }
        if (state.monitor === monitor && !state.monitorFailed) {
          const projectedBeforeStop = this.workflowProjectedAgentIds(pending, state)
          if (monitor.startedCount > 0 || projectedBeforeStop.length > 0) {
            state.terminal = true
          }
          await monitor.stop()
          monitorStopped = true
          const projectedAgentIds = this.workflowProjectedAgentIds(pending, state)
          // A terminal notification owns this monitor even when the journal
          // yielded no agents. Clear the state before the aggregate fallback
          // so a late read or poll cannot keep the parent looking active.
          if (state.monitor === monitor) state.monitor = null
          if (monitor.startedCount > 0 || projectedAgentIds.length > 0) {
            state.terminal = true
            await this.closeWorkflowAgentLifecycles(
              pending,
              state,
              status === 'completed'
                ? `Workflow completed before the individual transcript result became visible.\n${summary}`
                : `Workflow ended before the agent published an individual result.\n${summary}`,
              status !== 'completed',
            )
            pending.completedWorkflowTasks.add(toolUseId)
            await pending.handlers.onEvent({
              type: 'notice',
              level: status === 'completed' ? 'info' : 'warning',
              message: `${state.workflowName || `Workflow ${taskId}`}: ${summary}${trailer}`,
            })
            // Without an aggregate result, nothing else carries what the
            // workflow's agents spent.
            if (usage?.totalTokens)
              await pending.handlers.onEvent({
                type: 'usage',
                usage: { output_tokens: usage.totalTokens },
                child: true,
              })
            await this.finishDeferredResult(pending)
            return
          }
        }
      }
      // If monitor failure raced with flush/drain, the error path has already
      // detached the monitor. Stop the snapshot defensively as well; stop is
      // idempotent and this closes the only remaining polling handle.
      if (monitor && !monitorStopped && (state.monitor !== monitor || state.monitorFailed)) {
        await monitor.stop()
      }

      await this.ensureWorkflowAggregateStarted(pending, state)
      if (!pending.activeSubagents.delete(toolUseId)) return
      pending.completedWorkflowTasks.add(toolUseId)
      state.terminal = true
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `${summary}${trailer}`,
        isError: status !== 'completed',
      })
      await this.finishDeferredResult(pending)
    }
  }

  private async handleStreamEvent(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const event = message.event as Record<string, unknown> | undefined
    if (!event) return
    // Subagent frames carry the Agent call's id; the main loop keeps
    // streaming beside background and workflow agents.
    if (message.parent_tool_use_id) return
    const eventType = String(event.type ?? '')
    if (eventType === 'message_start') {
      const inner = event.message as Record<string, unknown> | undefined
      await this.beginAssistantMessage(pending, stringOrNull(inner?.id), true)
      return
    }
    if (eventType === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block && String(block.type) === 'tool_use') {
        const id = String(block.id ?? '')
        // Skip the start envelope for tool_use — input is empty here and the
        // full block lands later inside the AssistantMessage. Without this
        // we'd emit one orphan inProgress item per tool and a real one.
        if (id) pending.toolStartSeen.add(id)
      }
      return
    }
    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) return
      const deltaType = String(delta.type ?? '')
      if (deltaType === 'text_delta') {
        const text = String(delta.text ?? '')
        if (!text) return
        this.recordStreamedBlock(pending, event.index, 'text', text)
        // Special-case: StructuredOutput synthetic tool buffers text and emits
        // only the final coerced JSON; suppress raw deltas while it's active.
        if (pending.context.outputFormat) {
          pending.structuredBuffer += text
          return
        }
        await pending.handlers.onEvent({ type: 'text_delta', delta: text })
      } else if (deltaType === 'thinking_delta') {
        const thinking = String(delta.thinking ?? '')
        if (!thinking) return
        this.recordStreamedBlock(pending, event.index, 'thinking', thinking)
        await pending.handlers.onEvent({ type: 'reasoning_delta', delta: thinking })
      }
    }
  }

  private async beginAssistantMessage(
    pending: PendingTurn,
    messageId: string | null,
    streamStart = false,
  ): Promise<void> {
    if (messageId ? messageId === pending.assistantMessageId : !streamStart) return
    pending.assistantMessageId = messageId
    pending.streamedBlocks = new Map()
    if (!pending.context?.outputFormat) {
      await pending.handlers.onEvent({ type: 'message_boundary' })
    }
  }

  private recordStreamedBlock(
    pending: PendingTurn,
    index: unknown,
    type: string,
    text: string,
  ): void {
    const blockIndex = typeof index === 'number' ? index : 0
    const blocks = (pending.streamedBlocks ??= new Map())
    const previous = blocks.get(blockIndex)
    blocks.set(blockIndex, { type, text: (previous?.type === type ? previous.text : '') + text })
  }

  private unstreamedBlockText(pending: PendingTurn, type: string, text: string): string {
    for (const [index, block] of pending.streamedBlocks ?? []) {
      if (block.type !== type || !text.startsWith(block.text)) continue
      pending.streamedBlocks.delete(index)
      return text.slice(block.text.length)
    }
    return text
  }

  private async handleAssistant(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    const nestedMessage = Boolean(message.parent_tool_use_id)
    if (!nestedMessage) {
      await this.beginAssistantMessage(pending, stringOrNull(inner.id))
      pending.model = stringOrNull(inner.model) ?? pending.model
      const usage = recordOrNull(inner.usage)
      const messageId = stringOrNull(inner.id)
      // Not final until the result, but enough to see a goal budget run out
      // inside a long turn.
      if (usage && messageId)
        await pending.handlers.onEvent({ type: 'usage_progress', messageId, usage })
    }
    const content = (inner.content as Array<Record<string, unknown>>) || []
    for (const block of content) {
      const blockType = String(block.type ?? '')
      if (blockType === 'text') {
        if (nestedMessage) continue
        const text = this.unstreamedBlockText(pending, 'text', String(block.text ?? ''))
        if (pending.context?.outputFormat) {
          pending.structuredBuffer += text
        } else if (text) {
          await pending.handlers.onEvent({ type: 'text_delta', delta: text })
        }
      } else if (blockType === 'thinking') {
        if (nestedMessage) continue
        const thinking = this.unstreamedBlockText(pending, 'thinking', String(block.thinking ?? ''))
        if (thinking) await pending.handlers.onEvent({ type: 'reasoning_delta', delta: thinking })
      } else if (blockType === 'tool_use') {
        const id = String(block.id ?? '')
        const name = String(block.name ?? '')
        const input = (block.input as Record<string, unknown>) || {}
        if (!id) continue
        // A subagent's own tool calls stay inside its child thread. Tools the
        // main loop runs beside an Agent call are the parent's.
        if (isSubagentTool(name)) {
          pending.activeSubagents.add(id)
        }
        if (nestedMessage && !isSubagentTool(name)) continue
        if (name === 'StructuredOutput') {
          // Defer emission; the final coercion happens at result-time.
          continue
        }
        if (name === 'AskUserQuestion') {
          // The canUseTool bridge below renders this as a Codex-native
          // dynamicToolCall via onUserInputRequest. Skip the generic
          // tool_use event so the App doesn't also draw an mcpToolCall card
          // for the same question.
          continue
        }
        await pending.handlers.onEvent({ type: 'tool_use', toolUseId: id, toolName: name, input })
        if (isWorkflowTool(name)) pending.workflowToolUseIds.add(id)
      }
    }
  }

  private async handleUser(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
    // The SDK delivers tool_result blocks as a 'user' message turn from the
    // CLI's perspective. Surface them so the server can update the matching
    // tool item.
    const workflowLaunchResult =
      message.tool_use_result ?? (message as Record<string, unknown>).toolUseResult
    let workflowLaunchAttached = false
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    const content = (inner.content as Array<Record<string, unknown>>) || []
    const toolResultCount = content.filter((block) => String(block.type) === 'tool_result').length
    // The structured result describes the message's only tool result (e.g.
    // an Agent call's `async_launched` when Claude backgrounded it).
    const structured = toolResultCount === 1 ? recordOrNull(workflowLaunchResult) : null
    for (const block of content) {
      if (String(block.type) !== 'tool_result') continue
      const toolUseId = String(block.tool_use_id ?? '')
      if (!toolUseId) continue
      // Results of a subagent's own tools stay inside it, like their calls.
      if (message.parent_tool_use_id && !pending.activeSubagents.has(toolUseId)) continue
      const isWorkflowLaunch = pending.workflowToolUseIds?.delete(toolUseId) === true
      const wasSubagent = pending.activeSubagents.delete(toolUseId)
      // Even if this was a subagent we still emit its tool_result so the
      // server's subagent state machine closes the collabAgentToolCall.
      const isError = Boolean(block.is_error)
      const bodyContent = block.content
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: bodyContent,
        isError,
        ...(structured ? { structured } : {}),
      })
      if (!workflowLaunchAttached && isWorkflowLaunch && toolResultCount === 1) {
        workflowLaunchAttached = true
        this.attachWorkflowJournal(pending, workflowLaunchResult, toolUseId)
      }
      void wasSubagent
    }
  }

  private attachWorkflowJournal(pending: PendingTurn, value: unknown, toolUseId: string): void {
    const launch = parseWorkflowLaunchInfo(
      value,
      pending.workflowTranscriptRoots ?? defaultWorkflowTranscriptRoots(process.env),
    )
    if (!launch) return
    if (pending.skippedWorkflowTaskIds?.has(launch.taskId)) return
    const state = pending.workflowTasks?.get(launch.taskId)
    if (!state) {
      const boundState = [...(pending.workflowTasks?.values() ?? [])].find(
        (candidate) => candidate.toolUseId === toolUseId,
      )
      if (boundState) return
      const launches = pending.workflowLaunches ?? (pending.workflowLaunches = new Map())
      launches.set(toolUseId, launch)
      return
    }
    this.attachParsedWorkflowJournal(pending, state, launch, toolUseId)
  }

  private attachParsedWorkflowJournal(
    pending: PendingTurn,
    state: WorkflowTaskState,
    launch: WorkflowLaunchInfo,
    toolUseId: string,
  ): void {
    if (launch.taskId !== state.taskId) return
    if (state.toolUseId && state.toolUseId !== toolUseId) return
    if (!state.toolUseId) state.toolUseId = toolUseId
    state.workflowName = launch.workflowName || state.workflowName
    state.description = launch.summary || state.description
    state.prompt = state.prompt || state.description || state.workflowName
    if (state.terminal || state.aggregateStarted || state.monitor) return

    state.monitor = this.createWorkflowMonitor(pending, state, launch)
    state.monitor.start()
  }

  private attachDeferredWorkflowJournal(
    pending: PendingTurn,
    state: WorkflowTaskState,
    sourceToolUseId: string,
  ): void {
    const launches = pending.workflowLaunches
    if (!launches || launches.size === 0) return
    if (sourceToolUseId) {
      const launch = launches.get(sourceToolUseId)
      if (!launch) return
      launches.delete(sourceToolUseId)
      this.attachParsedWorkflowJournal(pending, state, launch, sourceToolUseId)
      return
    }
    const matches = [...launches.entries()].filter(([, launch]) => launch.taskId === state.taskId)
    if (matches.length !== 1) return
    const match = matches[0]
    if (!match) return
    const [toolUseId, launch] = match
    launches.delete(toolUseId)
    this.attachParsedWorkflowJournal(pending, state, launch, toolUseId)
  }

  private discardDeferredWorkflowLaunches(
    pending: PendingTurn,
    taskId: string,
    sourceToolUseId: string,
  ): void {
    const launches = pending.workflowLaunches
    if (!launches) return
    if (sourceToolUseId) launches.delete(sourceToolUseId)
    for (const [toolUseId, launch] of launches) {
      if (launch.taskId === taskId) launches.delete(toolUseId)
    }
  }

  private createWorkflowMonitor(
    pending: PendingTurn,
    state: WorkflowTaskState,
    launch: WorkflowLaunchInfo,
  ): WorkflowJournalMonitor {
    return new WorkflowJournalMonitor({
      launch,
      onStarted: async (agent) => {
        if (state.terminal) return
        const toolUseId = workflowAgentToolUseId(state.taskId, agent.agentId)
        if (
          pending.activeSubagents.has(toolUseId) ||
          pending.completedWorkflowTasks.has(toolUseId)
        ) {
          return
        }
        pending.activeSubagents.add(toolUseId)
        try {
          await pending.handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Agent',
            input: {
              description: agent.description,
              prompt: agent.prompt,
              subagent_type: 'workflow',
            },
          })
        } catch (error) {
          pending.activeSubagents.delete(toolUseId)
          throw error
        }
      },
      onResult: async (agent) => {
        if (state.terminal) return
        const toolUseId = workflowAgentToolUseId(state.taskId, agent.agentId)
        if (!pending.activeSubagents.has(toolUseId)) return
        await pending.handlers.onEvent({
          type: 'tool_result',
          toolUseId,
          content: agent.content,
          isError: agent.isError,
        })
        pending.activeSubagents.delete(toolUseId)
        pending.completedWorkflowTasks.add(toolUseId)
      },
      onError: async (error) => {
        if (state.terminal) return
        // Monitoring failures are terminal for the projected workflow. Record
        // the failure now so a later successful SDK result cannot revive the
        // task or leave the parent waiting for a journal that is no longer
        // being observed.
        const message = `Workflow monitoring failed: ${error.message}`
        state.monitorFailed = true
        state.monitor = null
        state.terminal = true
        pending.workflowFailure ??= message
        await this.closeWorkflowAgentLifecycles(pending, state, message, true)
        await this.closeWorkflowAggregateLifecycle(pending, state, message, true)
        if (state.toolUseId) pending.workflowToolUseIds.delete(state.toolUseId)
        await pending.handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message,
        })
        if (pending.deferredResult) {
          pending.completedWorkflowTasks.add(workflowTaskToolUseId(state.taskId))
          pending.deferredResult = {
            ...pending.deferredResult,
            success: false,
            resultText: pending.deferredResult.resultText ?? message,
          }
          await this.finishDeferredResult(pending, true)
        }
      },
    })
  }

  private workflowProjectedAgentIds(pending: PendingTurn, state: WorkflowTaskState): string[] {
    const agentIds = new Set(state.monitor?.activeAgentIds() ?? [])
    const prefix = `workflow-agent:${state.taskId}:`
    for (const toolUseId of pending.activeSubagents) {
      if (!toolUseId.startsWith(prefix)) continue
      const agentId = toolUseId.slice(prefix.length)
      if (agentId) agentIds.add(agentId)
    }
    return [...agentIds]
  }

  private async closeWorkflowAgentLifecycles(
    pending: PendingTurn,
    state: WorkflowTaskState,
    message: string,
    isError: boolean,
  ): Promise<number> {
    let closed = 0
    for (const agentId of this.workflowProjectedAgentIds(pending, state)) {
      const toolUseId = workflowAgentToolUseId(state.taskId, agentId)
      if (!pending.activeSubagents.delete(toolUseId)) continue
      pending.completedWorkflowTasks.add(toolUseId)
      await pending.handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `${message}\nagentId: ${agentId}`,
        isError,
      })
      closed += 1
    }
    return closed
  }

  private async closeWorkflowAggregateLifecycle(
    pending: PendingTurn,
    state: WorkflowTaskState,
    message: string,
    isError: boolean,
  ): Promise<boolean> {
    const toolUseId = workflowTaskToolUseId(state.taskId)
    if (!pending.activeSubagents.delete(toolUseId)) return false
    pending.completedWorkflowTasks.add(toolUseId)
    await pending.handlers.onEvent({
      type: 'tool_result',
      toolUseId,
      content: message,
      isError,
    })
    return true
  }

  private ensureWorkflowTask(pending: PendingTurn, taskId: string): WorkflowTaskState {
    const tasks = pending.workflowTasks ?? (pending.workflowTasks = new Map())
    const existing = tasks.get(taskId)
    if (existing) return existing
    const state: WorkflowTaskState = {
      taskId,
      toolUseId: '',
      workflowName: '',
      description: '',
      prompt: '',
      monitor: null,
      aggregateStarted: false,
      terminal: false,
    }
    tasks.set(taskId, state)
    return state
  }

  private async ensureWorkflowAggregateStarted(
    pending: PendingTurn,
    state: WorkflowTaskState,
  ): Promise<void> {
    if (state.terminal || state.aggregateStarted) return
    const toolUseId = workflowTaskToolUseId(state.taskId)
    if (pending.completedWorkflowTasks.has(toolUseId)) return
    state.aggregateStarted = true
    pending.activeSubagents.add(toolUseId)
    try {
      await pending.handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: {
          description: state.workflowName ? `Workflow: ${state.workflowName}` : 'Workflow',
          prompt: state.prompt || state.description || state.workflowName || 'Workflow',
          subagent_type: 'workflow',
        },
      })
    } catch (error) {
      state.aggregateStarted = false
      pending.activeSubagents.delete(toolUseId)
      throw error
    }
  }

  private async stopWorkflowTasks(pending: PendingTurn): Promise<void> {
    const tasks = pending.workflowTasks
    if (tasks) {
      for (const state of tasks.values()) {
        state.terminal = true
        await state.monitor?.stop()
        await this.closeWorkflowAgentLifecycles(
          pending,
          state,
          'Workflow monitoring stopped before the agent published an individual result.',
          true,
        )
        await this.closeWorkflowAggregateLifecycle(
          pending,
          state,
          'Workflow monitoring stopped before the workflow published a terminal result.',
          true,
        )
      }
    }
    pending.workflowLaunches?.clear()
  }

  private hasPendingWorkflowTasks(pending: PendingTurn): boolean {
    if ((pending.workflowToolUseIds?.size ?? 0) > 0) return true
    if ((pending.workflowLaunches?.size ?? 0) > 0) return true
    for (const state of pending.workflowTasks?.values() ?? []) {
      if (!state.terminal) return true
    }
    return false
  }

  private async finishDeferredResult(pending: PendingTurn, force = false): Promise<void> {
    const deferred = pending.deferredResult
    if (!deferred || pending.resolved) return
    if (!force && deferred.success && this.hasPendingWorkflowTasks(pending)) return

    pending.deferredResult = null
    pending.resolved = true
    this.turns.delete(pending.context.turnId)
    try {
      await pending.handlers.onEvent({
        type: 'completed',
        success: deferred.success,
        result: deferred.resultText,
        claudeSessionId: deferred.claudeSessionId,
      })
      if (deferred.success) {
        pending.resolve()
      } else {
        pending.reject(new Error(deferred.resultText ?? 'Claude turn failed'))
      }
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async handleResult(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (pending.deferredResult || pending.resolved) return
    const usage = (message.usage as Record<string, unknown>) || {}
    // Push usage + metrics before completed so server can roll them into the
    // turn before emitting turn/completed. Usage is per result, so record it
    // for every result the session spent tokens on, including ones that
    // don't end this turn.
    if (Object.keys(usage).length > 0) {
      await pending.handlers.onEvent({
        type: 'usage',
        usage,
        contextWindow: contextWindowOf(message.modelUsage, pending.model),
      })
    }
    // A resumed session can answer queued work of its own first, and a
    // queued steer gets a result of its own; only the result that answers
    // everything this turn sent completes it.
    if (
      (pending.autonomous
        ? pending.input.classifyAutonomousResult(message)
        : pending.input.classifyResult(message)) !== 'final'
    )
      return
    const subtype = String(message.subtype ?? '')
    const success = subtype === 'success' && !message.is_error && pending.workflowFailure == null
    const resultText =
      pending.workflowFailure ?? (message.result == null ? null : String(message.result))
    const claudeSessionId = message.session_id == null ? null : String(message.session_id)
    await pending.handlers.onEvent({
      type: 'metrics',
      durationMs: numberOrNull(message.duration_ms),
      apiDurationMs: numberOrNull(message.duration_api_ms),
      numTurns: numberOrNull(message.num_turns),
      costUsd: numberOrNull(message.total_cost_usd),
    })
    // If we suppressed text for StructuredOutput, emit the coerced JSON now.
    if (pending.context.outputFormat && pending.structuredBuffer) {
      await pending.handlers.onEvent({ type: 'text_delta', delta: pending.structuredBuffer.trim() })
    }
    pending.deferredResult = { success, resultText, claudeSessionId }
    if (!success) await this.stopWorkflowTasks(pending)
    await this.finishDeferredResult(pending)
  }

  private async handleOther(
    pending: PendingTurn,
    type: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (type === 'rate_limit' || type === 'rate_limit_event') {
      const info = message.rate_limit_info as Record<string, unknown> | undefined
      // Subscription usage updates also arrive when requests are allowed.
      // Those are bookkeeping, not warnings about a failed model request.
      if (info?.status === 'allowed') return
      const explicit = stringOrNull(message.message)
      if (!explicit && info?.status !== 'allowed_warning' && info?.status !== 'rejected') {
        if (type === 'rate_limit_event') return
      }
      await pending.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: explicit ?? rateLimitNotice(info),
      })
      return
    }
  }
}

// A finished hook as Codex reports one. Exit code 2 is Claude Code's blocking
// exit (stderr goes back to Claude); a command hook can also block or stop
// the turn through its JSON output.
function hookRunOutcome(message: Record<string, unknown>): {
  status: HookRunStatus
  entries: HookOutputEntry[]
} {
  const stderr = String(message.stderr ?? '').trim()
  if (message.outcome === 'cancelled') return { status: 'stopped', entries: [] }
  if (message.exit_code === 2)
    return { status: 'blocked', entries: stderr ? [{ kind: 'feedback', text: stderr }] : [] }
  if (message.outcome === 'error') {
    const text = stderr || String(message.output ?? '').trim()
    return { status: 'failed', entries: text ? [{ kind: 'error', text }] : [] }
  }
  const output = parseHookOutput(message.stdout ?? message.output)
  const entries: HookOutputEntry[] = []
  const systemMessage = stringOrNull(output.systemMessage)
  if (systemMessage) entries.push({ kind: 'warning', text: systemMessage })
  if (output.continue === false) {
    const reason = stringOrNull(output.stopReason)
    if (reason) entries.push({ kind: 'stop', text: reason })
    return { status: 'blocked', entries }
  }
  if (output.decision === 'block') {
    const reason = stringOrNull(output.reason)
    if (reason) entries.push({ kind: 'feedback', text: reason })
    return { status: 'blocked', entries }
  }
  return { status: 'completed', entries }
}

function parseHookOutput(value: unknown): Record<string, unknown> {
  const text = String(value ?? '').trim()
  if (!text.startsWith('{')) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function rateLimitNotice(info: Record<string, unknown> | undefined): string {
  const window = String(info?.rateLimitType ?? 'usage').replaceAll('_', ' ')
  const status =
    info?.status === 'allowed_warning'
      ? `Claude usage is nearing the ${window} limit`
      : `Claude ${window} limit reached`
  const utilization = typeof info?.utilization === 'number' ? info.utilization : null
  const used = utilization == null ? '' : ` (${Math.round(utilization * 100)}% used)`
  const resetsAt = typeof info?.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null
  const reset =
    resetsAt && Number.isFinite(resetsAt.getTime()) ? ` Resets at ${resetsAt.toISOString()}.` : ''
  return `${status}${used}.${reset}`
}

function humanUserMessage(content: TurnInputMessage['message']['content']): TurnInputMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  }
}

// Codex's (approvalPolicy, sandbox, planMode) tri-state → Claude SDK
// permissionMode. This preserves the adapter's old sidecar mapping while using
// the native TS SDK runtime.
function derivePermissionMode(
  approvalPolicy: string | null,
  sandboxMode: string | null,
  planMode: boolean,
): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' {
  // Env-level override always wins.
  const envOverride = configuredPermissionMode()
  if (envOverride) return envOverride
  if (planMode) return 'plan'
  if (sandboxMode === 'danger-full-access' || approvalPolicy === 'never') return 'default'
  if (approvalPolicy === 'on-failure') return 'acceptEdits'
  return 'default'
}

function configuredPermissionMode():
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'
  | null {
  const value = process.env.CLAUDE_CODEX_PERMISSION_MODE
  if (
    value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'plan' ||
    value === 'dontAsk' ||
    value === 'auto'
  ) {
    return value
  }
  return null
}

// Subagent tool detection — same allowlist as Python's is_subagent_tool and
// TS isSubagentToolName in server.mts.
function isSubagentTool(name: string): boolean {
  const n = name.trim().toLowerCase()
  return (
    n === 'task' || n === 'agent' || n === 'subagent' || n === 'spawn_agent' || n === 'spawnagent'
  )
}

function isWorkflowTool(name: string): boolean {
  return name === 'Workflow'
}

function isWorkflowBackgroundTask(message: Record<string, unknown>): boolean {
  return String(message.task_type ?? '') === 'local_workflow'
}

function workflowTaskToolUseId(taskId: string): string {
  return `workflow-task:${taskId}`
}

function workflowAgentToolUseId(taskId: string, agentId: string): string {
  return `workflow-agent:${taskId}:${agentId}`
}

// Claude's own top-level response output (not a running task's).
function isTurnOutput(type: string, message: Record<string, unknown>): boolean {
  if (message.parent_tool_use_id) return false
  return type === 'stream_event' || type === 'assistant' || type === 'user'
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// A control request whose failure the caller reports.
async function sessionControl(request: Promise<void>, what: string): Promise<void> {
  let failure: unknown = null
  const settled = await settlesWithin(
    request.catch((error: unknown) => {
      failure = error
    }),
    SESSION_CONTROL_TIMEOUT_MS,
  )
  if (failure != null)
    throw new Error(
      `Claude Code rejected the ${what}: ${failure instanceof Error ? failure.message : String(failure)}`,
    )
  if (!settled) throw new Error(`Claude Code did not confirm the ${what} in time`)
}

// The context window of the model that ran the main loop, as the CLI reports
// it per model in the result.
function contextWindowOf(modelUsage: unknown, model: string | null): number | null {
  const models = recordOrNull(modelUsage)
  if (!models) return null
  const entries = Object.values(models)
  const entry =
    recordOrNull(model ? models[model] : null) ??
    (entries.length === 1 ? recordOrNull(entries[0]) : null)
  const window = numberOrNull(entry?.contextWindow)
  return window != null && window > 0 ? window : null
}

function workflowTaskUsage(value: unknown): RuntimeTaskUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  const totalTokens = numberOrNull(usage.total_tokens)
  const toolUses = numberOrNull(usage.tool_uses)
  const durationMs = numberOrNull(usage.duration_ms)
  if (totalTokens === null || toolUses === null || durationMs === null) return null
  return { totalTokens, toolUses, durationMs }
}

const taskUsage = workflowTaskUsage

function goalToolServer(sdk: ClaudeSdk, z: Zod, goal: GoalToolHandlers) {
  const run = async (call: () => Promise<string>) => {
    try {
      return { content: [{ type: 'text' as const, text: await call() }] }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text' as const, text }], isError: true }
    }
  }
  return sdk.createSdkMcpServer({
    name: GOAL_MCP_SERVER,
    version: '1.0.0',
    tools: [
      sdk.tool('get_goal', GET_GOAL_DESCRIPTION, {}, () => run(() => goal.getGoal())),
      sdk.tool(
        'create_goal',
        CREATE_GOAL_DESCRIPTION,
        {
          objective: z
            .string()
            .describe(
              'Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.',
            ),
          token_budget: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Positive token budget for the new goal. Omit unless explicitly requested.'),
        },
        (args) => run(() => goal.createGoal(args.objective, args.token_budget ?? null)),
      ),
      sdk.tool(
        'update_goal',
        UPDATE_GOAL_DESCRIPTION,
        {
          status: z
            .enum(['complete', 'blocked', 'paused'])
            .describe(
              'Required. `paused` requires an explicit user request. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse.',
            ),
        },
        (args) => run(() => goal.updateGoal(args.status)),
      ),
    ],
  })
}

// Codex's approval policy says "never ask" (or the sandbox is wide open) and
// no explicit permission mode overrides it: tools run without a prompt.
function autoAllowsTools(context: RuntimeTurnContext): boolean {
  const mode = derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode)
  return (
    (configuredPermissionMode() === null &&
      (context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access')) ||
    mode === 'dontAsk'
  )
}

// Whether the user's Claude Code config (allow rules, hooks) may let a tool
// run without the Codex approval: not in a read-only sandbox or plan mode,
// which would stop those tools.
function inheritedApprovals(context: RuntimeTurnContext): boolean {
  if (context.sandboxMode === 'read-only') return false
  return (
    derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode) !== 'plan'
  )
}

// The allow rules from the user's Claude Code settings that apply to a turn.
function inheritedAllowedTools(context: RuntimeTurnContext): string[] {
  const rules = context.inheritedAllowedTools ?? []
  return rules.length > 0 && inheritedApprovals(context) ? rules : []
}

// Options a live CLI process cannot change in place. A turn whose signature
// differs needs a fresh process (unless background work pins the old one).
function sessionSignature(context: RuntimeTurnContext): string {
  return JSON.stringify([
    context.cwd,
    context.effort ?? null,
    context.systemPromptAddendum ?? '',
    context.mcpServers ?? null,
    // Compared in memory only, never logged.
    context.mcpEnv ?? null,
    context.goalTools ? GOAL_MCP_SERVER : null,
    context.addDirs ?? [],
    context.allowedTools ?? [],
    inheritedAllowedTools(context),
    context.inheritedAskRules ?? null,
    context.disallowedTools ?? [],
    context.mcpEnabledTools ?? null,
    context.agents ?? null,
    context.claudeHooks ?? null,
    context.claudeHooks?.length ? inheritedApprovals(context) : null,
    parseWorkflowCommand(context.prompt)?.type === 'run',
    context.planMode === true,
    configuredPermissionMode(),
  ])
}

function sessionSettleMs(): number {
  return positiveEnvMs('CLAUDE_CODEX_SESSION_SETTLE_MS') ?? SESSION_SETTLE_MS
}

function backgroundIdleMs(): number {
  return positiveEnvMs('CLAUDE_CODEX_BACKGROUND_IDLE_MS') ?? BACKGROUND_IDLE_MS
}

function positiveEnvMs(name: string): number | null {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : null
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function sdkResumeSessionId(value: string | null, cwd?: string): string | null {
  if (!value) return null
  if (/^(agent-http|agentapi|claude-p):/.test(value)) return null
  if (cwd) {
    const home = homedir()
    const slug = (dir: string) => dir.replace(/[^a-zA-Z0-9-]/g, '-')
    const slugs = [slug(cwd)]
    try {
      const real = realpathSync(cwd)
      if (real !== cwd) slugs.push(slug(real))
    } catch {}

    // Discover all candidate config directories (default ~/.claude plus any custom router / multi-model roots)
    const configRoots = new Set<string>([join(home, '.claude')])
    if (process.env.CLAUDE_CONFIG_DIR) configRoots.add(process.env.CLAUDE_CONFIG_DIR)
    const extraRoots = (process.env.CLAUDE_CONFIG_DIRS || process.env.CLAUDE_ROUTER_DIR || '')
      .split(/[,:]/)
      .map((p) => p.trim())
      .filter(Boolean)
    for (const extra of extraRoots) {
      if (existsSync(extra)) configRoots.add(extra)
    }

    // Generic discovery of cached multi-model router config workspaces under ~/.cache/*/claude-router
    const cacheBase = join(home, '.cache')
    if (existsSync(cacheBase)) {
      try {
        for (const sub of readdirSync(cacheBase)) {
          const routerDir = join(cacheBase, sub, 'claude-router')
          if (existsSync(routerDir)) {
            for (const item of readdirSync(routerDir)) {
              configRoots.add(join(routerDir, item))
            }
          }
        }
      } catch {}
    }

    let sourceFile: string | null = null
    for (const root of configRoots) {
      for (const s of slugs) {
        const p = join(root, 'projects', s, value + '.jsonl')
        if (existsSync(p)) {
          sourceFile = p
          break
        }
      }
      if (sourceFile) break
      const sessFile = join(root, 'sessions', value + '.jsonl')
      if (existsSync(sessFile)) {
        sourceFile = sessFile
        break
      }
    }

    if (!sourceFile) return null

    // Ensure the session transcript is mirrored across candidate project roots
    // so switching models or routers retains 100% conversation history
    for (const root of configRoots) {
      for (const s of slugs) {
        const targetDir = join(root, 'projects', s)
        const targetFile = join(targetDir, value + '.jsonl')
        if (targetFile === sourceFile) continue
        try {
          if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
          if (!existsSync(targetFile)) {
            copyFileSync(sourceFile, targetFile)
          }
        } catch {}
      }
    }
  }
  return value
}

// ── AskUserQuestion bridging helpers ──

// Parse the Claude SDK AskUserQuestionInput envelope into Codex's per-question
// shape. Claude's input is `{questions: [{question, header, options:[{label,
// description, preview?}], multiSelect}]}`. Codex's wire format separates the
// "Other" / free-text path via the `isOther` flag — we synthesise an extra
// option per question to mirror the harness behaviour (AskUserQuestion always
// implicitly offers an Other choice).
export function parseAskUserQuestions(input: Record<string, unknown>): UserInputQuestion[] {
  const raw = (input.questions as Array<Record<string, unknown>>) || []
  const out: UserInputQuestion[] = []
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] || {}
    const header = String(q.header ?? `Question ${i + 1}`)
    const question = String(q.question ?? '')
    const optionsRaw = (q.options as Array<Record<string, unknown>>) || []
    const options = optionsRaw.map((o) => ({
      label: String(o.label ?? ''),
      description: String(o.description ?? ''),
    }))
    // Claude's harness implicitly offers an "Other" free-text choice; surface
    // it as a Codex isOther option so the App renders the free-text affordance.
    options.push({ label: 'Other', description: 'Provide a custom answer' })
    out.push({
      id: `q${i}`,
      header: header.slice(0, 12),
      question,
      isOther: false,
      isSecret: false,
      options,
    })
  }
  return out
}

// Build the AskUserQuestionOutput JSON Claude expects. We push it through the
// canUseTool deny `message` field — Claude's model reads denied-tool messages
// as part of the tool_result, so the structured JSON arrives in the same
// schema the model would have seen had the CLI rendered the question itself.
export function formatAskUserQuestionAnswers(
  input: Record<string, unknown>,
  questions: UserInputQuestion[],
  answers: UserInputAnswers,
): string {
  const original = (input.questions as Array<Record<string, unknown>>) || []
  const answersByQuestion: Record<string, string> = {}
  const annotations: Record<string, { notes?: string; preview?: string }> = {}
  for (const [i, q] of questions.entries()) {
    const origQ = original[i] || {}
    const questionText = String(origQ.question ?? q.question)
    const slot = answers.answers[q.id]
    if (!slot) {
      answersByQuestion[questionText] = ''
      continue
    }
    const picked = Array.isArray(slot.answers) ? slot.answers.filter((s) => s !== 'Other') : []
    const notes = typeof slot.notes === 'string' ? slot.notes : null
    // Other-only: notes is the user's free-text reply.
    if (picked.length === 0 && notes) {
      answersByQuestion[questionText] = notes
    } else if (notes && picked.includes('Other')) {
      answersByQuestion[questionText] = notes
    } else {
      // Multi-select Claude format = comma-separated labels.
      answersByQuestion[questionText] = picked.join(', ')
    }
    if (notes) annotations[questionText] = { notes }
  }
  const payload = {
    questions: original,
    answers: answersByQuestion,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  }
  return JSON.stringify(payload)
}
