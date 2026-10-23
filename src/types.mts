import type { ClaudeHookSpec } from './claude-hooks.mjs'
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

// Codex `ModeKind`: the collaboration modes the App's composer offers.
export type CollaborationModeKind = 'plan' | 'default'

// Codex `ApprovalsReviewer`: who answers a thread's approvals. 'auto_review'
// (older Apps send 'guardian_subagent') lets an automatic reviewer decide
// them; a Claude thread runs it as Claude Code's 'auto' permission mode.
export type ApprovalsReviewer = 'user' | 'auto_review'

export interface ThreadRecord {
  id: string
  sessionId: string
  forkedFromId: string | null
  // Legacy Codex App clients use this flag to partition the thread list into
  // pinned and work-directory views. Keep it optional for older test fixtures
  // and normalize missing values to false at the persistence boundary.
  isPinned?: boolean | undefined
  // Newer Codex clients represent pinning as membership in a reserved thread
  // section. Keep the raw section metadata alongside the legacy flag so both
  // protocol generations can share the same persisted state.
  sectionId?: string | null | undefined
  sectionEnteredAt?: number | null | undefined
  sectionPosition?: number | null | undefined
  preview: string
  name: string | null
  archived: boolean
  cwd: string
  model: string
  // Fingerprint of the model process profile the thread started on (see
  // model-profiles.mts); null for Codex threads and when no profiles exist.
  modelProfileFingerprint?: string | null
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
  // Newer Codex clients send a built-in or custom permission profile id
  // (for example `:danger-full-access`) instead of a legacy sandbox string.
  // Keep it alongside the normalized policies so the profile survives resume
  // and the settings UI can round-trip its selection.
  permissionProfileId?: string | null
  // The App's collaboration mode (the /plan toggle), as last sent on
  // turn/start or thread/settings/update. Null until the App names one; a
  // turn that names none runs in the stored mode.
  collaborationMode?: CollaborationModeKind | null
  // Who answers the thread's approvals, as the App last chose it and the
  // thread can run it. Null until the App names one, which means 'user'.
  approvalsReviewer?: ApprovalsReviewer | null
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
  // Codex's per-thread memory mode, from the memories.* config of
  // thread/start. Saved only when the thread is created; change it through
  // SessionStore.setThreadMemoryMode (thread/memoryMode/set). Null on threads
  // saved before it existed; they follow the global memories config.
  memoryMode?: 'enabled' | 'disabled' | null
  // The project the thread belongs to. Read-only here: upsertThread leaves it
  // alone, so a stale record saved after a turn cannot undo an assignment
  // made meanwhile. Assign through SessionStore.setThreadProject.
  projectId?: string | null
  // Codex `GitInfo` of the thread's workspace: captured when the thread is
  // created and refreshed when a turn ends. Read-only here like projectId;
  // write through SessionStore.setThreadGitInfo.
  gitInfo?: GitInfo | null
}

// Codex `GitInfo`. originUrl never carries credentials.
export interface GitInfo {
  sha: string | null
  branch: string | null
  originUrl: string | null
}

// Codex `Project`: a named group of threads with workspace roots. Times are
// Unix seconds; recencyAt is the newest unarchived member thread's update.
export interface ProjectRecord {
  id: string
  name: string
  roots: Array<{ path: string }>
  metadata: Record<string, string>
  position: number
  createdAt: number
  updatedAt: number
  recencyAt: number | null
}

// Codex `ThreadAttachment`: App-owned JSON kept with a thread (its archived
// worktree, linked pull requests), unique per (type, identityKey).
export interface ThreadAttachmentRecord {
  id: string
  attachmentType: string
  identityKey: string
  payload: unknown
  createdAt: number
}

// Codex `ExternalAgentConfigImportHistory`: one finished import the App
// recorded, with what it brought over and what failed.
export interface ImportHistoryRecord {
  importId: string
  providerId: string | null
  completedAtMs: number
  successes: unknown[]
  failures: unknown[]
}

export interface ThreadSectionAppearance {
  color: string | null
  icon: string | null
}

export interface ThreadSectionRecord {
  id: string
  name: string
  appearance: ThreadSectionAppearance | null
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
  // The first turn in the chain of work that led to this one, when that is
  // another turn: the rootTurnId of turn/start, or for a subagent's turn the
  // root of the turn that spawned it. Null or absent: the turn is its own root.
  rootTurnId?: string | null
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

export type ThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

export interface ThreadGoal {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

// A follow-up the App queued server-side (thread/queue/*) while a turn ran.
export interface QueuedSubmission {
  id: string
  input: UserInput[]
  clientUserMessageId: string | null
}

// Codex's TurnToolOutput. `output` is a string or Responses API content items
// (input_text, input_image, ...).
export interface TurnToolOutput {
  name: string
  namespace: string | null
  output: string | Array<Record<string, unknown>>
}

// Codex v2 MemoryCitation: the memories an answer drew on. The App lists each
// entry's note under the answer; threadIds names Codex rollouts.
export interface MemoryCitation {
  entries: MemoryCitationEntry[]
  threadIds: string[]
}

export interface MemoryCitationEntry {
  path: string
  lineStart: number
  lineEnd: number
  note: string
}

// A memory Claude's auto-memory put into its context. `path` is the memory
// file, or a `<synthesis:DIR>` marker or a URL for a memory that is not a
// local file; `content` is the memory's text when Claude reported it.
export interface RecalledMemory {
  path: string
  scope: string | null
  content: string | null
}

// Codex v2 CommandAction: what a command does, as the App's "Explored" rows
// and approval cards show it. A read path is absolute; listFiles and search
// paths are short display paths.
export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string }

export type ThreadItem =
  // clientId echoes turn/start's or turn/steer's clientUserMessageId so the
  // App can reconcile its optimistic copy of the message.
  | { type: 'userMessage'; id: string; content: UserInput[]; clientId?: string }
  // A codex_app tool result that turn/start carried in place of user input,
  // such as a thread handoff. The App shows it as the turn's user message.
  | ({ type: 'functionCallOutput'; id: string } & TurnToolOutput)
  | {
      type: 'agentMessage'
      id: string
      text: string
      phase: string | null
      memoryCitation: MemoryCitation | null
    }
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
      commandActions: CommandAction[]
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
      // Stored only: marks a closeAgent kept for Apps without the completed
      // subagent activity kind. historyForPeer hides it from every other
      // client and strips the mark.
      legacyOnly?: true
    }
  // Canonical MultiAgent V2 display/liveness item. Codex App discovers the
  // child from `started` and clears its working state from `completed` or
  // `interrupted`; collabAgentToolCall remains the structured tool timeline.
  | {
      type: 'subAgentActivity'
      id: string
      kind: 'started' | 'interacted' | 'interrupted' | 'completed'
      agentThreadId: string
      agentPath: string
    }
  // Codex's native dynamic tool call item: a call to a tool the client
  // registered on thread/start (answered through item/tool/call), and
  // AskUserQuestion shown as a structured choice card (paired with the
  // item/tool/requestUserInput reverse RPC). contentItems is the tool result
  // (Codex `DynamicToolCallOutputContentItem`).
  | {
      type: 'dynamicToolCall'
      id: string
      namespace: string | null
      tool: string
      arguments: unknown
      status: 'inProgress' | 'completed' | 'failed'
      contentItems: DynamicToolContentItem[] | null
      success: boolean | null
      durationMs: number | null
    }

// Codex's DynamicToolCallOutputContentItem.
export type DynamicToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string }

// A dynamic tool as the client registers it on thread/start, in Codex's
// canonical DynamicToolSpec form (a lone function or a namespace of them).
export interface DynamicToolFunctionSpec {
  type: 'function'
  name: string
  description: string
  inputSchema: unknown
  deferLoading?: boolean
}

export type DynamicToolSpec =
  | DynamicToolFunctionSpec
  | {
      type: 'namespace'
      name: string
      description: string
      tools: DynamicToolFunctionSpec[]
    }

// The dynamic tools of one namespace (or the ones without a namespace), as
// one in-process MCP server Claude sees as mcp__<server>__<tool>.
export interface DynamicToolServer {
  server: string
  namespace: string | null
  description: string
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
    deferLoading: boolean
  }>
}

// Claude called a dynamic tool: the item/tool/call request without the
// thread and turn, which the server knows.
export interface DynamicToolCallRequest {
  callId: string
  namespace: string | null
  tool: string
  arguments: unknown
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolContentItem[]
  success: boolean
}

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export interface RuntimeTurnContext {
  threadId: string
  turnId: string
  // normal = user-visible chat/review turn, and a /compact run in the
  // thread's own session; summary = Codex App's structured title/metadata
  // turn; compact = the summary a compaction falls back to.
  purpose?: 'normal' | 'summary' | 'compact'
  prompt: string
  cwd: string
  runtimeType: RuntimeBackendType | null
  model: string | null
  // Model process profile the turn runs in, and the fingerprint its current
  // configuration must still match.
  modelProfileId?: string | null
  modelProfileFingerprint?: string | null
  effort: string | null
  claudeSessionId: string | null
  forkSession: boolean
  // Resume claudeSessionId only up to this transcript entry, in a forked
  // session (thread rewind or fork). Backends that cannot truncate ignore it.
  resumeSessionAt?: string | null
  // Set on a thread forked from another (ms since the epoch, after the fork).
  // Its Claude session opens with the parent's history, all older than this,
  // and what Claude left scheduled or running there stays the parent's.
  forkedAt?: number | null
  mcpServers: unknown | null
  allowedTools: string[] | null
  // Tools Claude must not use, as permission rules (the CLI's --disallowedTools).
  disallowedTools?: string[] | null
  // MCP servers limited to some of their tools: the server's tool-name prefix
  // (mcp__<server>__) to the full names of the tools Claude may call.
  mcpEnabledTools?: Record<string, string[]> | null
  // Allow rules from the user's Claude Code settings. Unlike allowedTools
  // they do not apply in plan mode or a read-only sandbox, where Codex would
  // not let the tools run unasked.
  inheritedAllowedTools?: string[] | null
  // Ask rules from the user's Claude Code settings: the calls they cover go
  // to the permission prompt even when an allow rule covers them too.
  inheritedAskRules?: string[] | null
  // Subagents by name, as the SDK's agents option takes them.
  agents?: Record<string, Record<string, unknown>> | null
  // Command hooks from the user's Claude Code settings, run as SDK hook
  // callbacks.
  claudeHooks?: ClaudeHookSpec[] | null
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
  // Folders outside the workspace Claude may read without asking, such as
  // the Codex App skills the prompt lists. Writes still follow the policy.
  readableRoots?: string[]
  // Drive Claude SDK permission_mode='plan' for this turn — Claude explores
  // read-only and proposes a plan through ExitPlanMode. Set when the thread's
  // collaboration mode is 'plan' (or the legacy `planMode` flag is on).
  planMode: boolean
  // The thread chose the App's automatic reviewer: run the session in Claude
  // Code's 'auto' permission mode, where Claude's classifier answers the asks
  // the approval policy would bring to the user. A backend that cannot
  // reports auto_review_unavailable and leaves the approvals with the user.
  autoReview?: boolean
  // Multimodal input attached to the turn. localImage gets read + base64
  // encoded; image (URL) is passed through as-is. Sidecar reshapes the
  // Claude SDK query into a multimodal user message when this is non-empty.
  imageInputs: ImageInput[]
  // Text Claude reads before `prompt`, in text blocks of the same message,
  // for a prompt that runs a Claude Code command (see turnPrompt in
  // src/turn-context.mts). A runtime that sends no content blocks puts it
  // in front of the prompt.
  promptContext?: string[]
  // Attach to a turn Claude already started on its own (a background task
  // reported back) instead of sending `prompt`. Only meaningful after the
  // runtime called RuntimeBackgroundListener.onAutonomousTurn for the thread.
  continuation?: boolean
  // The thread has a goal: expose Codex's goal tools (get_goal, create_goal,
  // update_goal) to Claude. Backends without in-process tools ignore it.
  goalTools?: GoalToolHandlers | null
  // Let Claude Code's auto-memory read and write its memory folder. Set only
  // with the memories mapping on (CLAUDE_CODEX_MEMORIES=1): true when the user
  // turned memories on in the App and the thread's memory mode is enabled,
  // false to have the runtime switch auto-memory off. Unset leaves it to
  // Claude Code's own settings.
  autoMemory?: boolean
  // The auto-compact window, in tokens, of the thread's Claude sessions: set
  // only when the user set Codex's model_auto_compact_token_limit. Unset
  // leaves Claude Code's own window.
  autoCompactWindow?: number | null
  // Tools the client registered on thread/start, one MCP server per
  // namespace. Claude's calls reach RuntimeHandlers.onDynamicToolCall of the
  // turn in flight. Backends without in-process tools ignore it.
  dynamicTools?: DynamicToolServer[] | null
  // The thread may lead other threads: expose the thread_* tools that start,
  // prompt, wait on and read separate chats. Off unless the adapter enables
  // them; backends without in-process tools ignore it.
  leaderTools?: LeaderToolHandlers | null
  // Ask Claude to return its thinking as readable summaries (the CLI's
  // --thinking-display). Unset keeps the CLI's default, which recent models
  // answer with redacted thinking. Backends without the flag ignore it.
  thinkingDisplay?: 'summarized' | null
}

// Each handler returns the text of the tool result; a thrown Error becomes an
// error result. They outlive the turn (a live session keeps its tools), so
// they must resolve the thread's state when called, not when created.
export interface GoalToolHandlers {
  getGoal(): Promise<string>
  createGoal(objective: string, tokenBudget: number | null): Promise<string>
  updateGoal(status: string): Promise<string>
}

// Same contract as GoalToolHandlers: each returns the tool result text (JSON
// here), a thrown Error becomes an error result. `signal` aborts a wait when
// Claude's tool call is cancelled.
export interface LeaderToolHandlers {
  list(input: { scope?: string | undefined }): Promise<string>
  start(input: {
    prompt: string
    cwd?: string | undefined
    model?: string | undefined
    title?: string | undefined
  }): Promise<string>
  prompt(
    input: {
      threadId: string
      text: string
      wait?: boolean | undefined
      timeoutSec?: number | undefined
    },
    signal?: AbortSignal,
  ): Promise<string>
  wait(
    input: { threadIds: string[]; until?: string | undefined; timeoutSec?: number | undefined },
    signal?: AbortSignal,
  ): Promise<string>
  read(input: { threadId: string; sinceCursor?: string | undefined }): Promise<string>
}

export interface ImageInput {
  kind: 'base64' | 'url'
  mediaType: string
  // Base64-encoded bytes when kind=base64; the URL string when kind=url.
  data: string
  // Display path/URL preserved for the imageView ThreadItem rendering.
  displayPath: string
}

// A point in a Claude session transcript: resuming `sessionId` at
// `messageUuid` restores exactly the context Claude had there.
export interface ClaudeCheckpoint {
  sessionId: string
  messageUuid: string
}

// Where a thread's Claude context starts over after a rewind or a fork: a
// checkpoint, or 'new' for a new session that remembers nothing.
export type ClaudeResumePoint = ClaudeCheckpoint | 'new'

// One piece of a subagent's work, as Claude Code forwards it from the
// subagent's transcript: complete blocks, never streamed deltas.
export type SubagentOutput =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  // It launched an agent of its own (an Agent call), which shows apart from
  // its work: only what it was saying ends there.
  | { type: 'agent_call'; toolUseId: string }

export interface SubagentOutputEvent {
  type: 'subagent_output'
  toolUseId: string
  agentId?: string
  output: SubagentOutput
}

export type RuntimeEvent =
  | { type: 'session'; claudeSessionId: string }
  // Claude wrote a top-level transcript entry; the newest one of a turn is
  // where a rewind back to that turn resumes.
  | { type: 'checkpoint'; claudeSessionId: string; messageUuid: string }
  // A new top-level model response is beginning, not a streamed content block.
  // `failedRequest` marks this boundary, and the text and usage that follow
  // it, of the message Claude Code writes for a model request that failed for
  // good (its text names the error): they show, but are no sign Claude got on
  // with the turn.
  | { type: 'message_boundary'; failedRequest?: boolean }
  | { type: 'text_delta'; delta: string; failedRequest?: boolean }
  | { type: 'reasoning_delta'; delta: string }
  | {
      type: 'tool_use'
      toolUseId: string
      toolName: string
      input: Record<string, unknown>
      // A subagent's own call: the task id of the agent that made it, which
      // stays the same when the agent is resumed. Only Agent calls of a
      // subagent reach the server; absent for the main loop and on CLIs
      // that do not report it.
      agentId?: string
    }
  // The input of a file tool call (Edit, Write, MultiEdit) as far as the
  // model has written it; the finished call follows as `tool_use`.
  | {
      type: 'tool_input_progress'
      toolUseId: string
      toolName: string
      input: Record<string, unknown>
    }
  | { type: 'tool_output_delta'; toolUseId: string; delta: string }
  | {
      type: 'tool_result'
      toolUseId: string
      content: unknown
      isError?: boolean
      // Claude Code's structured tool result (e.g. Agent `async_launched`,
      // SendMessage `resumedAgentId`) when the backend exposes it.
      structured?: Record<string, unknown> | null
      // The runtime closed this agent's call because the turn is ending (it
      // failed, was interrupted or stopped, or its session closed while the
      // agent ran), not because the agent finished: the agent ends with the
      // turn, for the turn's reason.
      endedWithTurn?: boolean
    }
  | {
      type: 'permission_request'
      requestId: string
      toolUseId: string
      toolName: string
      input: Record<string, unknown>
      // Why Claude asks (a matched rule, a hook, a path outside the
      // workspace), shown on the approval card.
      reason?: string | null
      // Claude's own one-line prompt for the request ("Claude wants to read
      // foo.txt"), used when it gives no reason.
      title?: string | null
      // The path outside the allowed folders that made Claude ask.
      blockedPath?: string | null
      // The MCP server an mcp__ tool belongs to.
      mcpServer?: string | null
      // Claude offers no "always allow" for this call, so the card offers no
      // session approval either.
      suppressSessionApproval?: boolean
      // Claude Code says the user has to answer this call themselves (the
      // card is the tool's own interface, or the ask only shows locally): only
      // the user may answer it, never a policy or an earlier session approval.
      requiresUser?: boolean
      // The permission changes Claude offers with this approval, the "don't
      // ask again" choices of its own prompt (see permission-suggestions.mts).
      suggestions?: ClaudePermissionUpdate[]
    }
  // Claude refused a tool call without asking (a deny rule, a hook, the
  // permission mode). `autoReview` is set when Claude's auto-mode classifier
  // refused it, with the classifier's reason.
  | {
      type: 'tool_denied'
      toolUseId: string
      toolName?: string
      autoReview?: { rationale: string | null }
    }
  // The thread asked for automatic review, but this session cannot run it:
  // the approvals stay with the user. `reason` says why.
  | { type: 'auto_review_unavailable'; reason: string }
  | {
      type: 'user_input_request'
      requestId: string
      toolUseId: string
      questions: UserInputQuestion[]
    }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  // Claude began compacting the conversation (on its own when the context
  // fills, or for /compact) and finished it: the earlier history is now a
  // summary of `postTokens` tokens, when Claude measured it.
  | { type: 'compaction_started' }
  | {
      type: 'compaction_completed'
      trigger: 'manual' | 'auto'
      preTokens: number | null
      postTokens: number | null
    }
  // Claude could not compact the conversation; `message` says so and why.
  // The history stays as it was.
  | { type: 'compaction_failed'; message: string }
  // A plan-mode turn's finished plan: the text Claude handed to ExitPlanMode.
  // The App shows it as the turn's plan card and offers to implement it.
  | { type: 'proposed_plan'; toolUseId: string; text: string }
  // A result's usage. `child` marks tokens a subagent or workflow spent:
  // they add to the thread's total, not to its context window.
  | {
      type: 'usage'
      usage: Record<string, unknown>
      contextWindow?: number | null
      child?: boolean
    }
  // One API call of the main loop, before the turn's result settles its
  // usage. A message can be reported again with a larger count.
  | {
      type: 'usage_progress'
      messageId: string
      usage: Record<string, unknown>
      failedRequest?: boolean
    }
  // A subagent or workflow the turn waits on is still working: its own
  // output, a task progress frame or a tool_progress heartbeat, which a
  // backend that filters nested events would otherwise keep to itself.
  // `toolUseId` is the call that started it. `failedRequest` marks a frame
  // that tells of a request of the agent's that failed (a retry, or the
  // message naming the error): it keeps the turn alive, but is no sign the
  // agent got on with its work.
  | { type: 'subagent_progress'; toolUseId: string; failedRequest?: boolean }
  // A subagent's own work: its text, thinking, tool calls and their results.
  // `toolUseId` is the Agent call the frame came under and `agentId` the task
  // id of the agent that wrote it, when the CLI reports it (Claude Code sends
  // a nested agent's frames under the nested agent's own call). The server
  // shows it in that agent's own thread.
  | SubagentOutputEvent
  | {
      type: 'metrics'
      durationMs: number | null
      apiDurationMs: number | null
      numTurns: number | null
      costUsd: number | null
    }
  // A Claude Code hook run began or ended; `hookId` pairs the two.
  | {
      type: 'hook_run'
      hookId: string
      // Claude's event name (PreToolUse, Stop, ...).
      hookEvent: string
      status: HookRunStatus
      entries: HookOutputEntry[]
    }
  // A refusal moved the session onto a fallback model. `category` is the
  // API's refusal category ('cyber', 'bio', ...) when it reported one.
  | {
      type: 'model_rerouted'
      fromModel: string
      toModel: string
      category: string | null
      message: string
    }
  // Claude's auto-memory recalled these memories for the prompt.
  | { type: 'memory_recall'; memories: RecalledMemory[] }
  // A model request failed and Claude will send it again after `delayMs`.
  // `status` is the API's HTTP status (null when nothing answered) and
  // `category` the SDK's error category ('overloaded', ...). `toolUseId` is
  // the Agent call of the subagent whose request it was, and `agentId` that
  // subagent's task id; without either the request was the main loop's.
  | {
      type: 'retrying'
      attempt: number
      maxRetries: number
      status: number | null
      category: string | null
      delayMs: number | null
      toolUseId?: string
      agentId?: string
    }
  | {
      type: 'completed'
      claudeSessionId?: string | null
      result?: string | null
      success: boolean
      // Why a failed turn failed, when the backend can tell.
      failure?: RuntimeFailure | null
    }
  | { type: 'error'; message: string }

// Why a Claude turn failed, in Claude's terms. The server maps it onto the
// error codes the Codex App knows.
export interface RuntimeFailure {
  // The result's terminal_reason ('prompt_too_long', 'max_turns', ...).
  terminalReason: string | null
  // The SDK's API error category of the last response ('overloaded', ...).
  category: string | null
  // The HTTP status of the API error that ended the turn.
  status: number | null
  // Why Claude Code refused to start, when it said so: the SDK's
  // startup_failure_reason ('org_config_refused', 'proxy_invalid', ...).
  startupFailure?: string | null
}

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

// Codex's HookRunStatus and HookOutputEntry.
export type HookRunStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'stopped'

export interface HookOutputEntry {
  kind: 'warning' | 'stop' | 'feedback' | 'context' | 'error'
  text: string
}

// An MCP server asked the user for input (MCP elicitation): a form described
// by `requestedSchema`, or a URL to open in the browser.
export interface ElicitationRequest {
  serverName: string
  message: string
  mode: 'form' | 'url'
  requestedSchema: Record<string, unknown> | null
  url: string | null
  elicitationId: string | null
}

export interface ElicitationResponse {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
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
  // What Claude Code applies as it runs the call: the rule the user chose to
  // save, or what "for this session" adds for the session.
  updatedPermissions?: ClaudePermissionUpdate[]
}

// A change to Claude Code's permission settings (the Agent SDK's
// PermissionUpdate): rules to add for a tool, folders to add, or a mode, for
// the session or one of its settings files.
export interface ClaudePermissionUpdate {
  type: string
  destination: string
  behavior?: string
  rules?: { toolName: string; ruleContent?: string }[]
  directories?: string[]
  mode?: string
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
  // Routed when an MCP server elicits input. The server bridges it to
  // Codex's `mcpServer/elicitation/request`; `signal` aborts when Claude
  // gives up waiting. When absent the runtime declines.
  onElicitationRequest?(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<ElicitationResponse>
  // Routed when Claude calls one of RuntimeTurnContext.dynamicTools. The
  // server bridges it to Codex's `item/tool/call`; `signal` aborts when
  // Claude cancels the call. When absent the runtime returns an error result.
  onDynamicToolCall?(
    request: DynamicToolCallRequest,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse>
}

export interface RuntimeTaskUsage {
  totalTokens: number
  toolUses: number
  durationMs: number
}

// Claude Code task lifecycle (background agents, background shells, ...).
// A background task outlives the turn that launched it, so these events are
// routed per thread rather than through a turn's handlers.
export type RuntimeTaskEvent =
  | {
      type: 'task_started'
      taskId: string
      toolUseId: string | null
      taskType: string | null
      description: string
      subagentType: string | null
      prompt: string | null
      backgrounded: boolean | null
      // The task id of the subagent whose agent launched this task. Absent
      // when the main loop launched it, and on CLIs that do not report it.
      parentTaskId?: string
    }
  | {
      type: 'task_progress'
      taskId: string
      toolUseId: string | null
      description: string
      summary: string | null
      lastToolName: string | null
      usage: RuntimeTaskUsage | null
    }
  | {
      type: 'task_updated'
      taskId: string
      status: string | null
      backgrounded: boolean | null
      error: string | null
    }
  | {
      type: 'task_notification'
      taskId: string
      toolUseId: string | null
      status: 'completed' | 'failed' | 'stopped'
      summary: string
      // The task's final report when the backend can recover it (for local
      // agents: the last assistant message of the sidechain transcript).
      result: string | null
      usage: RuntimeTaskUsage | null
    }
  | {
      // Output of a background shell, after the Bash call that started it
      // returned (a call still waiting for its result streams through its
      // turn as tool_output_delta).
      type: 'task_output'
      taskId: string
      toolUseId: string
      delta: string
    }
  // A background subagent's own work while no turn of its thread runs (the
  // same event reaches a running turn's handlers instead).
  | SubagentOutputEvent

export interface RuntimeBackgroundListener {
  onTaskEvent(threadId: string, event: RuntimeTaskEvent): Promise<void> | void
  // Claude began a turn without a user prompt (a background task reported
  // back). The server opens a parent turn and calls runTurn with
  // `continuation: true` to receive it.
  onAutonomousTurn(threadId: string): void
  // The thread's live session ended. `liveTaskIds` are the background tasks
  // it still tracked as running; nothing will report on them any more.
  onSessionReleased(threadId: string, liveTaskIds: string[]): void
  // Something the user should hear about that happened while no turn of the
  // thread was running, such as a tool call refused for want of one.
  onNotice?(threadId: string, message: string): void
}

export interface RuntimeSteerOptions {
  imageInputs?: ImageInput[]
  // As RuntimeTurnContext.promptContext.
  promptContext?: string[]
  // Fires once the backend starts consuming the message (Claude Code folds a
  // steer in at the next tool-round boundary, or runs it as its own turn).
  onAccepted?: () => void
}

// turn/settings/update: model, effort and reviewer for the rest of a running
// turn. `autoReview` as in RuntimeTurnContext.
export interface RuntimeTurnSettings {
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  autoReview?: boolean
}

// A background task of a live session: a backgrounded Bash shell
// (`local_bash`), agent or workflow, with the tool call that started it.
export interface RuntimeLiveTask {
  taskId: string
  taskType: string | null
  toolUseId: string | null
}

// An MCP server as a live Claude session sees it: its connection state
// (connected, failed, needs-auth, pending or disabled) and, once connected,
// the name and version the server gave.
export interface RuntimeMcpServerStatus {
  name: string
  status: string
  serverInfo: { name: string; version: string } | null
}

export interface ClaudeRuntime {
  runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void>
  // false: no running turn took the message. true: delivered, and
  // options.onAccepted fires once it is consumed. undefined: delivered by a
  // backend that cannot tell when it is consumed.
  steer(
    threadId: string,
    prompt: string,
    options?: RuntimeSteerOptions,
  ): Promise<boolean | undefined>
  interrupt(threadId: string): Promise<void>
  // Let go of a turn the server gave up on (its subagents stopped reporting
  // progress) without ending the background agents it handed off, which an
  // interrupt would stop too: the turn's own stuck agents and workflows stop,
  // and the rest of the session keeps running. Resolves false, without
  // waiting on the session, when none of those agents still run; an
  // interrupt then ends no more than the user's stop would.
  abandonTurn?(threadId: string, turnId: string): Promise<boolean>
  stop(): Promise<void>
  // Switch the running turn's model or effort until it ends; the next turn
  // runs on its own settings again. Resolves false when the thread is not
  // running that turn.
  updateTurnSettings?(
    threadId: string,
    turnId: string,
    settings: RuntimeTurnSettings,
  ): Promise<boolean>
  setBackgroundListener?(listener: RuntimeBackgroundListener): void
  // Stop one background task of the thread's live session. Resolves false
  // when no live session owns the task.
  stopTask?(threadId: string, taskId: string): Promise<boolean>
  // Background tasks still running in the thread's live session.
  liveTasks?(threadId: string): RuntimeLiveTask[]
  // The Claude Code version the thread's live session runs, null until its
  // CLI reported one.
  cliVersion?(threadId: string): string | null
  // True while a session outlives its turns: background tasks are running or
  // Claude may still answer one that just reported back.
  hasBackgroundWork?(): boolean
  // True when Claude already produced output for a turn nobody has claimed
  // yet; the server answers it with a `continuation: true` turn.
  hasPendingContinuation?(threadId: string): boolean
  // True when the backend drops a subagent's own events itself, so whatever
  // reaches the server while an Agent call is open belongs to the parent.
  filtersNestedEvents?(threadId: string): boolean
  // Close the thread's live session, background tasks included, so its next
  // turn starts a new one: the thread's history was rewound or deleted.
  resetSession?(threadId: string): void
  // True when a turn whose prompt is `/compact` compacts the Claude session
  // it resumes, reporting it with compaction_started / compaction_completed
  // (compaction_failed when Claude could not).
  compactsSessions?(): boolean
  // The MCP config was reloaded. Sessions still open retry their MCP servers
  // that failed or wait for a sign-in; a session opened later reads the
  // config itself. Never rejects.
  reloadMcpServers?(): Promise<void>
  // The MCP servers of the thread's live session, as Claude Code sees them;
  // null when no live session can say. Never rejects.
  mcpServerStatuses?(threadId: string): Promise<RuntimeMcpServerStatus[] | null>
}
