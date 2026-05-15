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
  claudeSessionId: string | null
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
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      status: string
      arguments: unknown
      result: unknown | null
      error: unknown | null
      durationMs: number | null
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
      agentsStates: Record<string, { status: 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound'; message: string | null }>
    }

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export interface RuntimeTurnContext {
  threadId: string
  turnId: string
  prompt: string
  cwd: string
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
}

export type RuntimeEvent =
  | { type: 'session'; claudeSessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_output_delta'; toolUseId: string; delta: string }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }
  | { type: 'permission_request'; requestId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'metrics'; durationMs: number | null; apiDurationMs: number | null; numTurns: number | null; costUsd: number | null }
  | { type: 'completed'; claudeSessionId?: string | null; result?: string | null; success: boolean }
  | { type: 'error'; message: string }

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
  onPermissionRequest(event: Extract<RuntimeEvent, { type: 'permission_request' }>): Promise<PermissionDecision>
}

export interface ClaudeRuntime {
  runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void>
  steer(threadId: string, prompt: string): Promise<void>
  interrupt(threadId: string): Promise<void>
  stop(): Promise<void>
}
