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
  ImageInput,
  PermissionDecision,
  RuntimeHandlers,
  RuntimeTurnContext,
} from './types.mjs'
import { newId } from './util.mjs'

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
}

interface PendingPermission {
  resolve: (value: PermissionDecision) => void
}

// Discriminator for the per-turn streamed delta map. We track text vs.
// thinking separately because the SDK delivers both via the same
// content_block_delta envelope but distinguishes via delta.type.
const STREAMED_TEXT = 'text'
const STREAMED_THINKING = 'thinking'

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
        toolStartSeen: new Set(),
        structuredBuffer: '',
        pendingUserMessage: null,
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
        q.streamInput((async function* () {
          yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }
        })())
      }
      return
    }
  }

  async interrupt(threadId: string): Promise<void> {
    for (const pending of this.turns.values()) {
      if (pending.context.threadId === threadId) {
        pending.abort.abort()
        await pending.query.interrupt().catch(() => {})
      }
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.turns.values()) {
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
    const text = context.prompt
    const images = context.imageInputs
    return (async function* () {
      if (!images || images.length === 0) {
        // Pure text — keep the simple string form so the SDK doesn't have to
        // re-stitch content blocks.
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: text },
          parent_tool_use_id: null,
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
      }
    })()
  }

  private buildOptions(sdk: ClaudeSdk, context: RuntimeTurnContext, abort: AbortController): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      abortController: abort,
      includePartialMessages: true,
      includeHookEvents: true,
      cwd: context.cwd,
    }
    if (context.model) opts.model = context.model
    if (context.effort) opts.effort = context.effort
    if (context.claudeSessionId) opts.resume = context.claudeSessionId
    if (context.forkSession) opts.forkSession = true
    if (context.addDirs && context.addDirs.length > 0) opts.additionalDirectories = context.addDirs
    if (context.allowedTools && context.allowedTools.length > 0) opts.allowedTools = context.allowedTools
    if (context.mcpServers && typeof context.mcpServers === 'object') opts.mcpServers = context.mcpServers
    if (context.outputFormat) opts.outputFormat = context.outputFormat

    // Codex App's pinned policies map onto Claude SDK's permissionMode. plan
    // mode supersedes everything (Codex sends planMode:true via turn/start);
    // approvalPolicy 'never' / sandbox 'danger-full-access' both mean "skip
    // per-tool prompts" → bypassPermissions; 'on-failure' approximates
    // acceptEdits (no prompt for write/edit until something fails).
    const mode = derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode)
    opts.permissionMode = mode

    // Per-tool approval round-trip with Codex App. Only attach the callback
    // when the mode actually consults it — bypassPermissions/dontAsk never
    // call it, so we save the round-trip overhead.
    if (mode !== 'bypassPermissions' && mode !== 'dontAsk' && mode !== 'plan') {
      opts.canUseTool = this.makeCanUseTool(context)
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

  private makeCanUseTool(context: RuntimeTurnContext) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID?: string; signal: AbortSignal },
    ): Promise<{ behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string }> => {
      const toolUseId = options.toolUseID || `tool-${newId()}`
      const requestId = `${context.threadId}:${context.turnId}:${toolName}:${toolUseId}`
      const pending = this.turns.get(context.turnId)
      if (!pending) return { behavior: 'deny', message: 'turn already finished' }

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
        return decision.updatedInput
          ? { behavior: 'allow', updatedInput: decision.updatedInput }
          : { behavior: 'allow' }
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
      // The async iterator finished without a 'result' message — treat as
      // successful empty turn (claude-agent-sdk does occasionally end without
      // a SDKResultMessage when interrupted cleanly).
      if (!pending.resolved) {
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

  private async handleMessage(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
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

  private async handleSystem(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
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
    }
  }

  private async handleStreamEvent(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
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

  private async handleAssistant(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
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
        await pending.handlers.onEvent({ type: 'tool_use', toolUseId: id, toolName: name, input })
      }
    }
  }

  private async handleUser(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
    // The SDK delivers tool_result blocks as a 'user' message turn from the
    // CLI's perspective. Surface them so the server can update the matching
    // tool item.
    const inner = message.message as Record<string, unknown> | undefined
    if (!inner) return
    const content = (inner.content as Array<Record<string, unknown>>) || []
    for (const block of content) {
      if (String(block.type) !== 'tool_result') continue
      const toolUseId = String(block.tool_use_id ?? '')
      if (!toolUseId) continue
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
      void wasSubagent
    }
  }

  private async handleResult(pending: PendingTurn, message: Record<string, unknown>): Promise<void> {
    const subtype = String(message.subtype ?? '')
    const success = subtype === 'success' && !message.is_error
    const resultText = message.result == null ? null : String(message.result)
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
    pending.resolved = true
    this.turns.delete(pending.context.turnId)
    try {
      await pending.handlers.onEvent({
        type: 'completed',
        success,
        result: resultText,
        claudeSessionId,
      })
      if (success) {
        pending.resolve()
      } else {
        pending.reject(new Error(resultText ?? 'Claude turn failed'))
      }
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async handleOther(pending: PendingTurn, type: string, message: Record<string, unknown>): Promise<void> {
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
// permissionMode. Same logic as Python's derive_permission_mode (see
// python/claude_sidecar.py L176-197).
function derivePermissionMode(
  approvalPolicy: string | null,
  sandboxMode: string | null,
  planMode: boolean,
): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' {
  // Env-level override always wins.
  const envOverride = process.env.CLAUDE_CODEX_PERMISSION_MODE
  if (envOverride === 'default' || envOverride === 'acceptEdits' || envOverride === 'bypassPermissions' ||
      envOverride === 'plan' || envOverride === 'dontAsk' || envOverride === 'auto') {
    return envOverride
  }
  if (planMode) return 'plan'
  if (sandboxMode === 'danger-full-access') return 'bypassPermissions'
  if (approvalPolicy === 'never') return 'bypassPermissions'
  if (approvalPolicy === 'on-failure') return 'acceptEdits'
  return 'default'
}

// Subagent tool detection — same allowlist as Python's is_subagent_tool and
// TS isSubagentToolName in server.mts.
function isSubagentTool(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n === 'task' || n === 'agent' || n === 'subagent' || n === 'spawn_agent' || n === 'spawnagent'
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

void STREAMED_TEXT
void STREAMED_THINKING
