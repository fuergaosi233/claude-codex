import type { RuntimeBackendType } from './runtime-config.mjs'

export type JsonRpcId = string | number | null

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface JsonRpcRequest {
  jsonrpc?: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type WireMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export interface RpcPeer {
  id: string
  send(message: WireMessage): void
  close(): void
}

export interface ThreadRecord {
  id: string
  sessionId: string
  forkedFromId: string | null
  preview: string
  name: string | null
  archived: boolean
  cwd: string
  model: string
  reasoningEffort: string | null
  modelProvider: string
  // Which backend actually drives this thread's turns. 'claude' = our native
  // @anthropic-ai/claude-agent-sdk runtime. 'codex' = a child `codex exec`
  // process running the real OpenAI Codex CLI. Picked at thread/start based
  // on the model the user chose in the App's model picker (gpt-* → codex,
  // sonnet/opus/haiku → claude), persisted on the thread so every later
  // turn / resume / fork / steer routes to the right backend without needing
  // the model id again.
  runtimeBackend: 'claude' | 'codex'
  claudeSessionId: string | null
  // Real Codex's persisted session id (returned by `codex exec` as
  // thread.started.thread_id). Reused on subsequent turns via
  // `codex exec resume <id>` so the conversation history survives. Only
  // populated for runtimeBackend='codex' threads.
  codexSessionId: string | null
  source: string
  createdAt: number
  updatedAt: number
  status: ThreadStatus
  // Codex App-supplied policy. `approvalPolicy` is one of untrusted /
  // on-failure / on-request / never; `sandboxMode` is read-only /
  // workspace-write / danger-full-access. These map onto Claude Agent SDK
  // permission_mode and the can_use_tool callback.
  approvalPolicy: string | null
  sandboxMode: string | null
  // Codex App marks transient title-generation / consolidation threads as
  // ephemeral — these should not appear in the user-facing thread list.
  ephemeral: boolean
  // 'user' | 'subagent' | 'memory_consolidation' (Codex `ThreadSource`).
  // Subagent threads spawned by the Task tool also carry this.
  threadSource: string | null
  // Codex's native subagent identity. `agentRole` mirrors the Codex
  // "agent_role" (mapped from Claude's Task `subagent_type`); `agentNickname`
  // is the unique handle the App displays for this subagent instance.
  agentRole: string | null
  agentNickname: string | null
  // Codex App's per-thread instruction surface (settings panel: project
  // instructions / developer instructions / personality). We thread these
  // through to Claude as a system_prompt addendum so the user's configured
  // tone and constraints actually take effect.
  baseInstructions: string | null
  developerInstructions: string | null
  personality: string | null
}

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> }

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export interface TurnRecord {
  id: string
  threadId: string
  status: TurnStatus
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
  items: ThreadItem[]
  diff: string
  error: unknown | null
  // Claude Agent SDK ResultMessage metrics. Surface them in turn/completed
  // so Codex App's status bar can show real timing + cost instead of blanks.
  apiDurationMs?: number | null
  numTurns?: number | null
  costUsd?: number | null
}

export type UserInput =
  | { type: 'text'; text: string; text_elements?: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export type ThreadItem =
  | { type: 'userMessage'; id: string; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null; memoryCitation: null }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'enteredReviewMode'; id: string; review: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      processId: string | null
      source: string
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
      commandActions: unknown[]
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
    }
  | {
      type: 'fileChange'
      id: string
      changes: FileUpdateChange[]
      status: 'inProgress' | 'completed' | 'failed' | 'declined'
    }
  // User-uploaded image surfaced in the thread transcript so Codex App can
  // render an inline preview. Path is either a real file path (localImage)
  // or a URL (image with http(s)/data:).
  | { type: 'imageView'; id: string; path: string }
  // Codex hookPrompt — surfaces Claude Code hook activity (PreToolUse,
  // PostToolUse, UserPromptSubmit, etc.) as a first-class timeline item
  // instead of flattening it into a single notice line.
  | {
      type: 'hookPrompt'
      id: string
      // Codex protocol HookPromptFragment = { text, hookRunId }. We previously
      // emitted {kind, text} (a misread of an older schema) — that would crash
      // the App's ts-rs deserializer with "missing field `hookRunId`". Each
      // fragment now carries the structured hookRunId so App can group related
      // fragments under one hook execution.
      fragments: Array<{ text: string; hookRunId: string }>
    }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: string
      arguments: unknown
      // Codex v2 McpToolCallResult shape — must have all three fields present
      // (structuredContent / _meta default to null). Raw content array is the
      // Anthropic tool-result block array.
      result: {
        content: unknown[]
        structuredContent: unknown | null
        _meta: unknown | null
      } | null
      // Codex v2 McpToolCallError shape — { message: string } and nothing else.
      error: { message: string } | null
      durationMs: number | null
    }
  // Native Codex Web Search rendering. Claude SDK's WebSearch tool input is
  // {query: string}; we map it to Codex's `webSearch` ThreadItem so the App
  // gets the dedicated search badge / link UI instead of a generic mcpToolCall.
  | {
      type: 'webSearch'
      id: string
      query: string
      // Codex v2 WebSearchAction. Each variant's inner fields are Option<...>
      // with no serde default, so we MUST always emit them (allowed to be null).
      action:
        | { type: 'search'; query: string | null; queries: string[] | null }
        | { type: 'openPage'; url: string | null }
        | { type: 'findInPage'; pattern: string | null; url: string | null }
        | { type: 'other' }
        | null
    }
  // Native Codex subagent representation. The Task tool spawns a child thread;
  // Codex App displays it as one Agent item that can drill into the child
  // thread by id (`receiverThreadIds`).
  | {
      type: 'collabAgentToolCall'
      id: string
      tool: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent'
      status: 'inProgress' | 'completed' | 'failed'
      senderThreadId: string
      receiverThreadIds: string[]
      prompt: string | null
      model: string | null
      reasoningEffort: string | null
      agentsStates: Record<
        string,
        {
          status:
            | 'pendingInit'
            | 'running'
            | 'interrupted'
            | 'completed'
            | 'errored'
            | 'shutdown'
            | 'notFound'
          message: string | null
        }
      >
    }
  // Codex's native dynamic tool call item — used to surface AskUserQuestion as
  // a structured choice card the App renders inline (paired with the
  // item/tool/requestUserInput reverse RPC). The contentItems array carries
  // the user's free-form answer text (Codex `DynamicToolCallOutputContentItem`).
  | {
      type: 'dynamicToolCall'
      id: string
      namespace: string | null
      tool: string
      arguments: unknown
      status: 'inProgress' | 'completed' | 'failed'
      contentItems: Array<
        { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }
      > | null
      success: boolean | null
      durationMs: number | null
    }

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export interface RuntimeTurnContext {
  threadId: string
  turnId: string
  // normal = user-visible chat/review turn; summary = Codex App's structured
  // title/metadata turn; compact = explicit context compaction.
  purpose?: 'normal' | 'summary' | 'compact'
  prompt: string
  cwd: string
  runtimeType: RuntimeBackendType | null
  model: string | null
  effort: string | null
  claudeSessionId: string | null
  forkSession: boolean
  mcpServers: unknown | null
  allowedTools: string[] | null
  addDirs: string[]
  enableFileCheckpointing: boolean
  outputFormat: unknown | null
  // Honour the Codex App's selected policy (unless-trusted / on-failure /
  // on-request / never) and sandbox tier (read-only / workspace-write /
  // danger-full-access). When the App says "Full access" the runtime should
  // skip per-tool approvals instead of asking for every Claude tool call.
  approvalPolicy: string | null
  sandboxMode: string | null
  // Pre-assembled system prompt addendum (baseInstructions + developerInstructions
  // + personality cue). Sidecar appends it to Claude's default system prompt.
  systemPromptAddendum: string | null
  // Drive Claude SDK permission_mode='plan' for this turn — Claude generates
  // a plan but does not execute tools. Set when the App requests `planMode`
  // on turn/start (or when CLAUDE_CODEX_PERMISSION_MODE=plan globally).
  planMode: boolean
  // Multimodal input attached to the turn. localImage gets read + base64
  // encoded; image (URL) is passed through as-is. Sidecar reshapes the
  // Claude SDK query into a multimodal user message when this is non-empty.
  imageInputs: ImageInput[]
}

export interface ImageInput {
  kind: 'base64' | 'url'
  mediaType: string
  // Base64-encoded bytes when kind=base64; the URL string when kind=url.
  data: string
  // Display path/URL preserved for the imageView ThreadItem rendering.
  displayPath: string
}

export type RuntimeEvent =
  | { type: 'session'; claudeSessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_output_delta'; toolUseId: string; delta: string }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }
  | {
      type: 'permission_request'
      requestId: string
      toolUseId: string
      toolName: string
      input: Record<string, unknown>
    }
  | {
      type: 'user_input_request'
      requestId: string
      toolUseId: string
      questions: UserInputQuestion[]
    }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'usage'; usage: Record<string, unknown> }
  | {
      type: 'metrics'
      durationMs: number | null
      apiDurationMs: number | null
      numTurns: number | null
      costUsd: number | null
    }
  | {
      type: 'hook'
      hookName: string
      status: string | null
      decision: string | null
      message: string | null
    }
  | { type: 'completed'; claudeSessionId?: string | null; result?: string | null; success: boolean }
  | { type: 'error'; message: string }

// Codex's request_user_input primitive — surfaces Claude's AskUserQuestion as a
// native choice card in the App instead of a generic mcpToolCall blob. Matches
// the Codex v2 ToolRequestUserInputQuestion shape so the App's structured UI
// (`isOther` for free-text, `isSecret` for masked, options list) renders correctly.
export interface UserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }> | null
}

export interface UserInputAnswers {
  // Keyed by question id. Each answer is an array of selected option labels
  // (size > 1 only when the original question was multi-select). When the
  // user picks "Other", the free-text reply lives in `notes`.
  answers: Record<string, { answers: string[]; notes?: string | null }>
}

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

export interface PermissionDecision {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  updatedInput?: Record<string, unknown>
}

export interface RuntimeHandlers {
  onEvent(event: RuntimeEvent): Promise<void> | void
  onPermissionRequest(
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
  ): Promise<PermissionDecision>
  // Routed when Claude invokes AskUserQuestion. The server bridges this to
  // Codex's native `item/tool/requestUserInput` reverse RPC so the App can
  // render structured choice cards instead of a raw tool_use blob. Optional
  // because not every consumer (mock harnesses, compaction subturns) needs
  // to expose a real user-input surface — when absent the runtime returns an
  // empty answer to the model.
  onUserInputRequest?(
    event: Extract<RuntimeEvent, { type: 'user_input_request' }>,
  ): Promise<UserInputAnswers>
}

export interface ClaudeRuntime {
  runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void>
  steer(threadId: string, prompt: string): Promise<void>
  interrupt(threadId: string): Promise<void>
  stop(): Promise<void>
}
