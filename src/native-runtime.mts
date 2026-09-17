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
//   * per-turn text/thinking stream-vs-block dedup (streamed_text_turns /
//     streamed_thinking_turns) — JS SDK still re-delivers each TextBlock /
//     ThinkingBlock at end-of-turn even when streamed, same as Python
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
import type {
  ClaudeRuntime,
  PermissionDecision,
  RuntimeHandlers,
  RuntimeTurnContext,
  UserInputAnswers,
  UserInputQuestion,
} from './types.mjs'
import { newId } from './util.mjs'
import { parseWorkflowCommand, workflowRuntimePrompt } from './workflow-command.mjs'
import {
  defaultWorkflowTranscriptRoots,
  parseWorkflowLaunchInfo,
  WorkflowJournalMonitor,
  type WorkflowLaunchInfo,
} from './workflow-subagents.mjs'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

interface PendingTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  query: Query
  abort: AbortController
  resolved: boolean
  resolve: () => void
  reject: (error: Error) => void
  // Per-turn dedup guards (same shape as Python's streamed_*_turns sets).
  streamedText: boolean
  streamedThinking: boolean
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

// Discriminator for the per-turn streamed delta map. We track text vs.
// thinking separately because the SDK delivers both via the same
// content_block_delta envelope but distinguishes via delta.type.
const STREAMED_TEXT = 'text'
const STREAMED_THINKING = 'thinking'
const WORKFLOW_TERMINAL_FLUSH_TIMEOUT_MS = 500
const WORKFLOW_JOURNAL_SETTLE_TIMEOUT_MS = 3_000

export class NativeClaudeRuntime implements ClaudeRuntime {
  private sdk: ClaudeSdk | null = null
  private turns = new Map<string, PendingTurn>()
  private permissions = new Map<string, PendingPermission>()

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const sdk = await this.loadSdk()
    const abort = new AbortController()
    return new Promise<void>((resolve, reject) => {
      // The SDK accepts either a plain string prompt OR an AsyncIterable of
      // SDKUserMessage envelopes. Always feed the iterable form so we have
      // room to attach image blocks alongside the text and the door is open
      // for mid-turn steer() calls.
      const promptIterable = this.buildPromptIterable(context)
      const options = this.buildOptions(sdk, context, abort)

      const query = sdk.query({ prompt: promptIterable, options })
      const pending: PendingTurn = {
        context,
        handlers,
        query,
        abort,
        resolved: false,
        resolve,
        reject,
        streamedText: false,
        streamedThinking: false,
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
      }
      this.turns.set(context.turnId, pending)
      // Kick off the receive loop in the background. We don't await it here
      // because runTurn() must resolve when the result message arrives — the
      // receive loop will call resolve/reject on `pending` once the SDK ends.
      void this.consume(pending).catch((err: unknown) => {
        if (!pending.resolved) {
          pending.resolved = true
          this.turns.delete(context.turnId)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  async steer(threadId: string, prompt: string): Promise<void> {
    // Find an in-flight turn for this thread (we don't index by threadId so
    // walk the map — there's usually only one active turn per thread). The
    // SDK exposes streamInput on the Query for this purpose.
    for (const pending of this.turns.values()) {
      if (pending.context.threadId !== threadId) continue
      const q = pending.query as Query & { streamInput?: (it: AsyncIterable<unknown>) => void }
      if (typeof q.streamInput === 'function') {
        q.streamInput(
          (async function* () {
            yield {
              type: 'user',
              message: { role: 'user', content: workflowRuntimePrompt(prompt) },
              parent_tool_use_id: null,
              origin: { kind: 'human' },
            }
          })(),
        )
      }
      return
    }
  }

  async interrupt(threadId: string): Promise<void> {
    for (const pending of this.turns.values()) {
      if (pending.context.threadId === threadId) {
        await this.stopWorkflowTasks(pending)
        pending.abort.abort()
        await pending.query.interrupt().catch(() => {})
      }
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.turns.values()) {
      await this.stopWorkflowTasks(pending)
      pending.abort.abort()
    }
    this.turns.clear()
    this.permissions.clear()
  }

  // ── private ──

  private async loadSdk(): Promise<ClaudeSdk> {
    if (this.sdk) return this.sdk
    // Dynamic import keeps the heavy native binary out of the require graph
    // until a real runtime turn is requested (mocked tests don't pay for it).
    this.sdk = await import('@anthropic-ai/claude-agent-sdk')
    return this.sdk
  }

  private buildPromptIterable(context: RuntimeTurnContext): AsyncIterable<any> {
    const text = workflowRuntimePrompt(context.prompt)
    const images = context.imageInputs
    return (async function* () {
      if (!images || images.length === 0) {
        // Pure text — keep the simple string form so the SDK doesn't have to
        // re-stitch content blocks.
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: text },
          parent_tool_use_id: null,
          origin: { kind: 'human' as const },
        }
        return
      }
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
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
        origin: { kind: 'human' as const },
      }
    })()
  }

  private buildOptions(
    sdk: ClaudeSdk,
    context: RuntimeTurnContext,
    abort: AbortController,
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

    // Ensure extended cache TTL is explicitly requested
    if (!process.env.ANTHROPIC_BETAS) {
      process.env.ANTHROPIC_BETAS = 'extended-cache-ttl-2025-04-11'
    }
    if (context.addDirs && context.addDirs.length > 0) opts.additionalDirectories = context.addDirs
    if (context.allowedTools && context.allowedTools.length > 0)
      opts.allowedTools = context.allowedTools
    if (context.mcpServers && typeof context.mcpServers === 'object')
      opts.mcpServers = context.mcpServers
    if (context.outputFormat) opts.outputFormat = context.outputFormat

    // Codex App's pinned policies map onto Claude SDK's permissionMode. plan
    // mode supersedes everything. Relay rejects the SDK's dangerous bypass
    // flag outside a recognized container sandbox, so App-level Full Access
    // stays in default mode and auto-allows through canUseTool below. An
    // explicit env override can still opt into bypassPermissions.
    const permissionModeOverride = configuredPermissionMode()
    const mode = derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode)
    opts.permissionMode = mode
    if (mode === 'bypassPermissions') opts.allowDangerouslySkipPermissions = true

    if (parseWorkflowCommand(context.prompt)?.type === 'run') {
      opts.settings = {
        ...((opts.settings as Record<string, unknown> | undefined) ?? {}),
        enableWorkflows: true,
        workflowKeywordTriggerEnabled: true,
      }
    }

    // Per-tool approval round-trip with Codex App. In App-level Full Access,
    // the bridge auto-allows every permission request without surfacing a UI
    // prompt. Explicit SDK bypass omits the callback because Claude never calls
    // it in that mode.
    if (mode !== 'plan' && mode !== 'bypassPermissions') {
      const appFullAccess =
        permissionModeOverride === null &&
        (context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access')
      const autoAllow = appFullAccess || mode === 'dontAsk'
      opts.canUseTool = this.makeCanUseTool(context, autoAllow)
    }

    // Project + developer + personality instructions ride along as a system
    // prompt append, preserving Claude Code's built-in preset.
    if (context.systemPromptAddendum && context.systemPromptAddendum.trim()) {
      opts.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: context.systemPromptAddendum.trim(),
      }
    }

    // CLI binary override (for users pinning a specific claude-code build).
    if (process.env.CLAUDE_CODEX_CLI) opts.pathToClaudeCodeExecutable = process.env.CLAUDE_CODEX_CLI

    void sdk // keep parameter referenced for future SDK-version-gated options
    return opts
  }

  private makeCanUseTool(context: RuntimeTurnContext, autoAllow: boolean) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID?: string; signal: AbortSignal },
    ): Promise<
      { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }
    > => {
      const toolUseId = options.toolUseID || `tool-${newId()}`
      const pending = this.turns.get(context.turnId)
      if (!pending) return { behavior: 'deny', message: 'turn already finished' }

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

  private async consume(pending: PendingTurn): Promise<void> {
    const { context, handlers, query } = pending
    try {
      for await (const message of query as AsyncIterable<Record<string, unknown>>) {
        await this.handleMessage(pending, message)
        if (pending.resolved) break
      }
      if (!pending.resolved && pending.deferredResult) {
        // The SDK iterator is the authoritative lifetime of a turn. If it
        // closes while a workflow journal still has an unresolved task, there
        // will be no later task_notification to unblock the deferred result.
        // Close those projected agents as failed and finish the parent turn
        // rather than leaving Codex cc's spinner alive forever.
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
    } catch (err) {
      if (!pending.resolved) {
        await this.stopWorkflowTasks(pending)
        pending.resolved = true
        this.turns.delete(context.turnId)
        const error = err instanceof Error ? err : new Error(String(err))
        try {
          await handlers.onEvent({ type: 'error', message: error.message })
        } catch {}
        pending.reject(error)
      }
    }
  }

  private async handleMessage(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const type = String(message.type ?? '')
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
        // Hook events, rate-limit notifications, etc. Many of them surface as
        // their own SDKMessage variants in recent SDK builds. Convert to a
        // generic notice + (for hook events) a structured hook event so the
        // server can render a hookPrompt timeline item.
        await this.handleOther(pending, type, message)
    }
  }

  private async handleSystem(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const subtype = String(message.subtype ?? '')
    if (subtype === 'init') {
      const sessionId = String(message.session_id ?? '')
      if (sessionId) await pending.handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
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
    const eventType = String(event.type ?? '')
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
        // Special-case: StructuredOutput synthetic tool buffers text and emits
        // only the final coerced JSON; suppress raw deltas while it's active.
        if (pending.context.outputFormat) {
          pending.structuredBuffer += text
          return
        }
        // Subagent suppression — if any subagent is running, hide its prose
        // from the parent timeline.
        if (pending.activeSubagents.size > 0) return
        pending.streamedText = true
        await pending.handlers.onEvent({ type: 'text_delta', delta: text })
      } else if (deltaType === 'thinking_delta') {
        const thinking = String(delta.thinking ?? '')
        if (!thinking) return
        if (pending.activeSubagents.size > 0) return
        pending.streamedThinking = true
        await pending.handlers.onEvent({ type: 'reasoning_delta', delta: thinking })
      }
    }
  }

  private async handleAssistant(
    pending: PendingTurn,
    message: Record<string, unknown>,
  ): Promise<void> {
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    const content = (inner.content as Array<Record<string, unknown>>) || []
    for (const block of content) {
      const blockType = String(block.type ?? '')
      if (blockType === 'text') {
        // Skip if we already streamed this text via content_block_delta.
        if (pending.streamedText) continue
        if (pending.activeSubagents.size > 0) continue
        const text = String(block.text ?? '')
        if (text) await pending.handlers.onEvent({ type: 'text_delta', delta: text })
      } else if (blockType === 'thinking') {
        if (pending.streamedThinking) continue
        if (pending.activeSubagents.size > 0) continue
        const thinking = String(block.thinking ?? '')
        if (thinking) await pending.handlers.onEvent({ type: 'reasoning_delta', delta: thinking })
      } else if (blockType === 'tool_use') {
        const id = String(block.id ?? '')
        const name = String(block.name ?? '')
        const input = (block.input as Record<string, unknown>) || {}
        if (!id) continue
        // Suppress nested tool uses while a subagent is in flight.
        const parentSubagent = pending.activeSubagents.size > 0
        if (isSubagentTool(name)) {
          pending.activeSubagents.add(id)
        }
        if (parentSubagent && !isSubagentTool(name)) continue
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
    for (const block of content) {
      if (String(block.type) !== 'tool_result') continue
      const toolUseId = String(block.tool_use_id ?? '')
      if (!toolUseId) continue
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
    const subtype = String(message.subtype ?? '')
    const success = subtype === 'success' && !message.is_error && pending.workflowFailure == null
    const resultText =
      pending.workflowFailure ?? (message.result == null ? null : String(message.result))
    const claudeSessionId = message.session_id == null ? null : String(message.session_id)
    const usage = (message.usage as Record<string, unknown>) || {}
    // Push usage + metrics before completed so server can roll them into the
    // turn before emitting turn/completed.
    if (Object.keys(usage).length > 0) {
      await pending.handlers.onEvent({ type: 'usage', usage })
    }
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
      const msg = String(message.message ?? 'rate limit')
      await pending.handlers.onEvent({ type: 'notice', level: 'warning', message: msg })
      return
    }
    if (type === 'hook' || type === 'hook_event' || type === 'system_hook_event') {
      const hookName = String(message.hook_event_name ?? message.hook_name ?? 'hook')
      const status = stringOrNull(message.status) ?? stringOrNull(message.subtype)
      const decision = stringOrNull(message.decision) ?? stringOrNull(message.permission_decision)
      const text = stringOrNull(message.message) ?? stringOrNull(message.reason)
      await pending.handlers.onEvent({
        type: 'hook',
        hookName,
        status,
        decision,
        message: text,
      })
    }
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

function workflowTaskUsage(value: unknown): {
  totalTokens: number
  toolUses: number
  durationMs: number
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  const totalTokens = numberOrNull(usage.total_tokens)
  const toolUses = numberOrNull(usage.tool_uses)
  const durationMs = numberOrNull(usage.duration_ms)
  if (totalTokens === null || toolUses === null || durationMs === null) return null
  return { totalTokens, toolUses, durationMs }
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

void STREAMED_TEXT
void STREAMED_THINKING

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
