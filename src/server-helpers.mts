import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { type FSWatcher, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { callMcpTool, readMcpConfig, readMcpResource } from './mcp.mjs'
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

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

// Pull a human-readable line out of a raw Responses-API item. Items are
// free-form JSON; common shapes include {type, content:[{type:'text', text}]}
// for assistant/user turns and {type:'message', role, content} for chat
// segments. Fall back to a stringified JSON snippet otherwise.
export function summarizeInjectedItem(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw.slice(0, 1000)
  if (typeof raw !== 'object') return String(raw).slice(0, 1000)
  const rec = raw as Record<string, unknown>
  const content = rec.content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (typeof b.text === 'string') texts.push(b.text)
      }
    }
    if (texts.length > 0) return texts.join('\n').slice(0, 2000)
  }
  if (typeof rec.text === 'string') return rec.text.slice(0, 2000)
  // Last-resort dump so something shows up in the transcript.
  try {
    return JSON.stringify(raw).slice(0, 500)
  } catch {
    return '[non-serializable item]'
  }
}

export function configEdits(
  params: Record<string, unknown>,
): Array<{ keyPath: string; value: unknown }> {
  if (Array.isArray(params.edits)) {
    return params.edits
      .map((edit) => {
        const rec = asRecord(edit)
        return { keyPath: String(rec.keyPath ?? rec.key ?? ''), value: rec.value }
      })
      .filter((edit) => edit.keyPath.length > 0)
  }
  const keyPath = String(params.keyPath ?? params.key ?? '')
  return keyPath ? [{ keyPath, value: params.value }] : []
}

export function configLayerMetadata(): unknown {
  return {
    name: { type: 'user', file: `${codexHome()}/config.toml` },
    version: `claude-codex-${nowSeconds()}`,
  }
}

export function defaultSelectableModelId(): string {
  const options = claudeModelOptions()
  const defaultModel = process.env.CLAUDE_CODEX_DEFAULT_MODEL
  if (defaultModel && options.some((option) => option.id === defaultModel)) return defaultModel
  return options.find((option) => option.isDefault === true)?.id ?? options[0]?.id ?? 'sonnet'
}

export function normalizeSelectableModelId(value: string, fallback: string): string {
  const options = claudeModelOptions()
  const ids = new Set(options.map((option) => option.id))
  if (ids.has(value)) return value
  if (ids.has(fallback)) return fallback
  const defaultModel = defaultSelectableModelId()
  debugLog('config.model.repaired', { requestedModel: value, repairedModel: defaultModel })
  return defaultModel
}

export function modelFromParams(params: Record<string, unknown>, fallback: string | null): string {
  const config = asRecord(params.config)
  if (typeof params.model === 'string' && params.model.length > 0) return params.model
  if (typeof config.model === 'string' && config.model.length > 0) return config.model
  return fallback ?? ''
}

export function reasoningEffortFromParams(
  params: Record<string, unknown>,
  fallback: string | null,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  const config = asRecord(params.config)
  const effort =
    typeof params.effort === 'string'
      ? params.effort
      : typeof config.model_reasoning_effort === 'string'
        ? config.model_reasoning_effort
        : fallback
  return normalizeCodexReasoningEffort(effort)
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function commandArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((part) => part.length > 0)
  if (typeof value === 'string' && value.trim())
    return [process.env.SHELL || '/bin/sh', '-lc', value]
  return []
}

export function summarizeRpcParams(method: string, params: unknown): unknown {
  const rec = asRecord(params)
  if (method === 'turn/start') {
    return {
      threadId: rec.threadId,
      cwd: rec.cwd,
      model: rec.model,
      effort: rec.effort,
      configEffort: asRecord(rec.config).model_reasoning_effort,
      hasOutputSchema: rec.outputSchema != null,
      inputTypes: Array.isArray(rec.input) ? rec.input.map((item) => asRecord(item).type) : [],
    }
  }
  if (method === 'process/spawn' || method === 'command/exec') {
    return {
      processHandle: rec.processHandle,
      processId: rec.processId,
      cwd: rec.cwd,
      command: commandArray(rec.command),
      streamStdoutStderr: rec.streamStdoutStderr,
      streamStdin: rec.streamStdin,
      tty: rec.tty,
      timeoutMs: rec.timeoutMs,
    }
  }
  if (method.includes('outputDelta')) {
    return {
      processHandle: rec.processHandle,
      processId: rec.processId,
      itemId: rec.itemId,
      stream: rec.stream,
      deltaBytes:
        typeof rec.deltaBase64 === 'string'
          ? Buffer.from(rec.deltaBase64, 'base64').byteLength
          : typeof rec.delta === 'string'
            ? rec.delta.length
            : 0,
      capReached: rec.capReached,
    }
  }
  if (method === 'item/agentMessage/delta') {
    return {
      threadId: rec.threadId,
      turnId: rec.turnId,
      itemId: rec.itemId,
      deltaChars: typeof rec.delta === 'string' ? rec.delta.length : 0,
    }
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = asRecord(rec.item)
    return {
      threadId: rec.threadId,
      turnId: rec.turnId,
      item: { id: item.id, type: item.type },
    }
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const turn = asRecord(rec.turn)
    const items = Array.isArray(turn.items)
      ? turn.items.map((item) => ({ id: asRecord(item).id, type: asRecord(item).type }))
      : []
    return {
      threadId: rec.threadId,
      turn: { id: turn.id, status: turn.status, items },
    }
  }
  return rec
}

export function reviewLabel(target: unknown): string {
  const rec = asRecord(target)
  const type = stringOr(rec.type, 'uncommittedChanges')
  if (type === 'commit')
    return (
      'commit ' + stringOr(rec.sha, '') + (typeof rec.title === 'string' ? ': ' + rec.title : '')
    )
  if (type === 'baseBranch') return 'base branch ' + stringOr(rec.branch, 'main')
  if (type === 'custom') return stringOr(rec.instructions, 'custom review')
  return 'uncommitted changes'
}

export function reviewPrompt(target: unknown): string {
  const label = reviewLabel(target)
  return [
    'Review the code changes for: ' + label,
    '',
    'Prioritize correctness bugs, regressions, security issues, and missing tests.',
    'Return findings first, ordered by severity, with file and line references when available.',
    'If there are no actionable issues, say so clearly and mention residual risk.',
  ].join('\n')
}

export function compactSummary(thread: ThreadRecord, turns: TurnRecord[]): string {
  const snippets = turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === 'userMessage' || item.type === 'agentMessage')
    .slice(-12)
    .map((item) => {
      if (item.type === 'userMessage') return 'User: ' + textFromInput(item.content).slice(0, 500)
      if (item.type === 'agentMessage') return 'Assistant: ' + item.text.slice(0, 500)
      return ''
    })
    .filter(Boolean)
  return [
    'Context compacted for thread ' + thread.id + '.',
    '',
    snippets.length > 0
      ? snippets.join('\n')
      : 'No prior conversation content was available to summarize.',
  ].join('\n')
}

export function commandEnv(value: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return env
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null) delete env[key]
    else env[key] = String(raw)
  }
  return env
}

export function stringListFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {}
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
  }
  return ''
}

export function fallbackStructuredText(outputSchema: unknown, prompt: string): string {
  return JSON.stringify(coerceStructuredValue(outputSchema, prompt), null, 0)
}

// claude-agent-sdk has shipped the subagent-spawning tool under both `Task`
// (older) and `Agent` (current 0.2.x) names; accept both plus a few common
// variants so the native collabAgentToolCall path triggers regardless of
// which name the model emits. Without this, an `Agent` tool_use falls
// through to the generic mcpToolCall branch and its inner Bash calls leak
// into the parent thread as a flat list (the bug seen on mac-mini).
export function isSubagentToolName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  const n = name.trim().toLowerCase()
  return (
    n === 'task' || n === 'agent' || n === 'subagent' || n === 'spawn_agent' || n === 'spawnagent'
  )
}

export function normalizeApprovalPolicy(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  // Codex AskForApproval enum: untrusted | on-failure | on-request | never.
  // (We previously had "unless-trusted" which never appeared in the wire enum.)
  if (v === 'untrusted' || v === 'on-failure' || v === 'on-request' || v === 'never') return v
  // Some early App builds shipped the longer form; normalize forward.
  if (v === 'unless-trusted') return 'untrusted'
  return null
}

export function normalizeSandboxMode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v === 'read-only' || v === 'workspace-write' || v === 'danger-full-access' ? v : null
}

// turn/start uses `sandboxPolicy: SandboxPolicy` (a struct) instead of the
// thread/start `sandbox: SandboxMode` string. Translate the struct's `type`
// back to the internal canonical mode string the sidecar understands.
export function sandboxFromTurnParams(params: Record<string, unknown>): string | null {
  if (typeof params.sandbox === 'string') return normalizeSandboxMode(params.sandbox)
  const policy = params.sandboxPolicy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
  const type = (policy as Record<string, unknown>).type
  if (type === 'dangerFullAccess') return 'danger-full-access'
  if (type === 'readOnly') return 'read-only'
  if (type === 'workspaceWrite' || type === 'externalSandbox') return 'workspace-write'
  return null
}

export function normalizePersonality(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (
    v === 'none' ||
    v === 'friendly' ||
    v === 'pragmatic' ||
    v === 'cynic' ||
    v === 'robot' ||
    v === 'nerd'
  )
    return v
  return null
}

// Codex v2 ReasoningEffort enum (top-level, used by collabAgentToolCall and
// elsewhere). No serde(other) fallback — anything outside this set crashes
// the App's deserializer (same trap as threadSource = ""). Pass any value
// through here before emitting it on the wire.
export function normalizeReasoningEffortEnum(
  value: string | null | undefined,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (
    v === 'none' ||
    v === 'minimal' ||
    v === 'low' ||
    v === 'medium' ||
    v === 'high' ||
    v === 'xhigh'
  )
    return v
  return null
}

// Codex App's settings sheet writes the persistent reasoning-effort default
// under `params.config.model_reasoning_effort` (the same shape as the Codex
// CLI's `config.toml`). turn/start's top-level `effort` is only set when the
// user overrides for a single turn — the chosen value from the model picker
// otherwise lives in the config bag. Read both so the App's effort dropdown
// actually changes Claude's thinking budget instead of silently no-op'ing.
export function readConfigReasoningEffort(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null
  const cfg = config as Record<string, unknown>
  const direct = cfg.model_reasoning_effort ?? cfg['model_reasoning_effort']
  if (typeof direct === 'string' && direct.length > 0) return direct
  return null
}

// Codex v2 `ThreadSource` is a strict 3-variant enum with no `serde(other)`
// fallback. Anything outside this set (including an empty string) makes the
// App's ts-rs deserializer panic on `thread/list` / `thread/read` — which the
// user sees as the generic "Oops, an error has occurred" toast. Force every
// write/read through this gate so we never persist or ship an invalid value.
export function normalizeThreadSource(
  value: unknown,
): 'user' | 'subagent' | 'memory_consolidation' | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v === 'user' || v === 'subagent' || v === 'memory_consolidation') return v
  return null
}

// Codex v2 `SessionSource` is camelCase (`appServer`, not `app_server`); it
// has `serde(other) Unknown` so the wrong casing won't crash the App, just
// silently fall back to `unknown`. Convert to the wire form to keep the
// thread metadata UI honest.
export function normalizeSessionSource(value: unknown): string {
  if (typeof value !== 'string') return 'appServer'
  const v = value.trim()
  if (v === 'cli' || v === 'vscode' || v === 'exec' || v === 'appServer' || v === 'unknown')
    return v
  if (v === 'app_server' || v === 'app-server') return 'appServer'
  return 'unknown'
}

// `agentRole` / `agentNickname` are `string | null` on the wire (not enums),
// so an empty string doesn't crash — but the App treats `""` as "present"
// and renders an empty chip. Coerce to null so the field is just absent.
export function nullIfEmpty(value: string | null | undefined): string | null {
  if (value == null) return null
  return value === '' ? null : value
}

// Assemble the per-thread system prompt addendum from Codex App's instruction
// surface. Sidecar concatenates this onto Claude's default system prompt so
// the user's project / developer / personality settings actually take effect.
export function buildSystemPromptAddendum(input: {
  baseInstructions: string | null
  developerInstructions: string | null
  personality: string | null
}): string | null {
  const sections: string[] = []
  const base = (input.baseInstructions ?? '').trim()
  if (base) sections.push(`# Project instructions\n${base}`)
  const dev = (input.developerInstructions ?? '').trim()
  if (dev) sections.push(`# Developer instructions\n${dev}`)
  const cue = personalityPromptCue(input.personality)
  if (cue) sections.push(cue)
  return sections.length > 0 ? sections.join('\n\n') : null
}

export function personalityPromptCue(personality: string | null): string | null {
  switch (personality) {
    case 'friendly':
      return 'Personality: friendly. Communicate in a warm, encouraging tone; default to plain language and short paragraphs.'
    case 'pragmatic':
      return 'Personality: pragmatic. Be concise and direct; lead with the answer, skip pleasantries, prefer concrete code or commands.'
    case 'cynic':
      return 'Personality: cynic. Be terse and wry; surface trade-offs and risks plainly; avoid hype.'
    case 'robot':
      return 'Personality: robot. Reply in clipped, structured prose; prefer bullet points and exact field names; minimise filler.'
    case 'nerd':
      return 'Personality: nerd. Get into mechanism and detail; explain underlying assumptions and edge cases when relevant.'
    case 'none':
    case null:
    default:
      return null
  }
}

// Codex App's thread envelope expects a sandbox object whose `type` matches the
// chosen tier. Returning the right shape lets the App render the correct badge
// (Read-only / Workspace / Full access) and stops it from over-prompting.
export function sandboxEnvelope(mode: string | null, cwd: string): unknown {
  if (mode === 'read-only') return { type: 'readOnly' }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  // Default: workspace-write (or null/legacy).
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

export function emptyTokenBreakdown(): TokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
}

// claude-agent-sdk's Task tool appends a fixed metadata trailer to the
// subagent's tool_result content:
//   `agentId: <hex> (use SendMessage with to: '<hex>' to continue this agent)`
//   `<usage>total_tokens: N\ntool_uses: M\nduration_ms: K</usage>`
// Codex App renders neither natively — they just show as raw text after the
// real result. Strip both from the visible body and surface the values via
// agentNickname / token usage / metrics so the subagent timeline carries the
// SDK-reported identity and cost.
interface SubagentTrailer {
  cleanText: string
  agentId: string | null
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null
}

// Codex v2 McpToolCallResult requires {content[], structuredContent, _meta}.
// Claude SDK tool_result.content is one of: a string, an array of Anthropic
// content blocks ({type:'text'|'image', ...}), or a structured JsonValue.
// Wrap into the protocol shape — if content is already an array, use it; if
// it's a primitive/object, materialize as a single text block so the App
// renders something useful instead of an empty result.
export function wrapMcpToolResult(content: unknown): {
  content: unknown[]
  structuredContent: unknown | null
  _meta: unknown | null
} {
  if (content == null) return { content: [], structuredContent: null, _meta: null }
  if (Array.isArray(content)) return { content, structuredContent: null, _meta: null }
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof content === 'object' ? content : null,
    _meta: null,
  }
}

// Codex v2 McpToolCallError requires { message: string } — and nothing else.
// Coerce any tool_result body the SDK gave us into that single-field shape.
export function wrapMcpToolError(content: unknown): { message: string } {
  if (content == null) return { message: 'tool call failed' }
  if (typeof content === 'string') return { message: content }
  if (Array.isArray(content)) {
    // Concatenate any text blocks; fall back to a JSON dump.
    const text = content
      .map((b) =>
        b && typeof b === 'object' && (b as any).type === 'text'
          ? String((b as any).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n')
    return { message: text || JSON.stringify(content) }
  }
  if (typeof content === 'object' && content && typeof (content as any).message === 'string') {
    return { message: (content as any).message }
  }
  return { message: JSON.stringify(content) }
}

export function parseSubagentTrailer(text: string): SubagentTrailer {
  if (!text) return { cleanText: '', agentId: null, usage: null }
  let cleanText = text
  let agentId: string | null = null
  let usage: SubagentTrailer['usage'] = null

  const usageMatch = cleanText.match(
    /<usage>\s*total_tokens:\s*(\d+)\s*\n\s*tool_uses:\s*(\d+)\s*\n\s*duration_ms:\s*(\d+)\s*<\/usage>\s*$/,
  )
  if (usageMatch) {
    usage = {
      totalTokens: Number(usageMatch[1]) || 0,
      toolUses: Number(usageMatch[2]) || 0,
      durationMs: Number(usageMatch[3]) || 0,
    }
    cleanText = cleanText.slice(0, usageMatch.index).replace(/\s+$/, '')
  }

  const agentMatch = cleanText.match(/\n?agentId:\s*([0-9a-f]{8,32})\b[^\n]*\s*$/i)
  if (agentMatch) {
    agentId = agentMatch[1] ?? null
    cleanText = cleanText.slice(0, agentMatch.index).replace(/\s+$/, '')
  }

  return { cleanText, agentId, usage }
}

// Best-effort parse of a Claude Bash tool_result for the real shell exit
// code. Claude's tool result content is usually plain stdout/stderr, but in
// some failure modes (and via custom wrappers / Codex CLI shims) the SDK
// suffixes a `Exit code: N` / `exit status N` marker. Returning null lets
// the caller fall back to 0/1 from event.isError.
// Map Claude's TodoWrite input to Codex v2 TurnPlanStep[]. Claude todos carry
// { content, status, activeForm } with status pending|in_progress|completed;
// the wire TurnPlanStepStatus is camelCase pending|inProgress|completed.
export function todoWriteToPlanSteps(
  input: Record<string, unknown>,
): Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> | null {
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  return todos.map((raw) => {
    const todo = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const step =
      typeof todo.content === 'string' && todo.content.length > 0
        ? todo.content
        : typeof todo.activeForm === 'string'
          ? todo.activeForm
          : ''
    const status =
      todo.status === 'in_progress'
        ? 'inProgress'
        : todo.status === 'completed'
          ? 'completed'
          : 'pending'
    return { step, status }
  })
}

export function parseExitCodeFromResult(content: unknown): number | null {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((p) => (typeof p === 'string' ? p : ((p as Record<string, unknown>)?.text ?? '')))
            .join('')
        : ''
  if (!text) return null
  const match = text.match(/(?:Exit code|exit status|exit code):\s*(-?\d+)/i)
  if (!match) return null
  const code = Number(match[1])
  return Number.isFinite(code) ? code : null
}

// Best-effort: when the WebSearch tool returns a result, sniff whether the
// first result was an explicit page open vs a result list. Codex App's
// `webSearch` ThreadItem renders the action badge accordingly.
export function parseWebSearchAction(
  query: string,
  resultText: string,
):
  | { type: 'search'; query: string | null; queries: string[] | null }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; pattern: string | null; url: string | null }
  | { type: 'other' } {
  // Codex v2 WebSearchAction variants are tagged but the inner fields are NOT
  // optional in Rust — they're `Option<...>` with NO `#[serde(default)]`, so
  // App rejects an item that ships a bare {type:'search'} (missing required
  // fields). Always populate every field of the chosen variant, even if null.
  if (!resultText) return { type: 'search', query: query || null, queries: null }
  const urlMatch = resultText.match(/https?:\/\/[^\s)\]"'<]+/)
  if (urlMatch && query) return { type: 'openPage', url: urlMatch[0] }
  return { type: 'search', query: query || null, queries: null }
}

// Maps the raw Anthropic usage block carried on the Claude Agent SDK
// ResultMessage onto the Codex `TokenUsageBreakdown` shape. Cache-creation
// tokens count as input; Claude does not separate reasoning output tokens.
export function tokenBreakdownFromClaudeUsage(usage: Record<string, unknown>): TokenUsageBreakdown {
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheCreation = num(usage.cache_creation_input_tokens)
  const inputTokens = num(usage.input_tokens) + cacheCreation
  const outputTokens = num(usage.output_tokens)
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cacheRead + outputTokens,
  }
}

export function coerceStructuredValue(schema: unknown, prompt: string): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return prompt
  const record = schema as Record<string, unknown>
  if (record.type === 'string') return conciseStructuredString(prompt)
  if (record.type === 'array') {
    const itemSchema =
      record.items && typeof record.items === 'object' && !Array.isArray(record.items)
        ? record.items
        : { type: 'string' }
    const values = prompt
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*\d.、)\s]+/, ''))
      .filter(Boolean)
    return (values.length > 0 ? values : prompt.trim() ? [prompt.trim()] : [])
      .slice(0, 10)
      .map((value) => coerceStructuredValue(itemSchema, value))
  }
  if (record.type !== 'object') return null
  const properties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(record.required)
    ? record.required.map(String)
    : Object.keys(properties)
  const result: Record<string, unknown> = {}
  for (const key of required) {
    const property = properties[key]
    result[key] = coerceStructuredValue(property, prompt)
  }
  return result
}

export function conciseStructuredString(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const source = lines.at(-1) ?? prompt.trim()
  const colon = Math.max(source.lastIndexOf('：'), source.lastIndexOf(':'))
  const value = colon >= 0 ? source.slice(colon + 1).trim() : source
  return value
    .replace(/^[-*\d.、)\s]+/, '')
    .slice(0, 80)
    .trim()
}

export function normalizeDecision(response: unknown): PermissionDecision['decision'] {
  const decision = asRecord(response).decision
  if (
    decision === 'accept' ||
    decision === 'acceptForSession' ||
    decision === 'decline' ||
    decision === 'cancel'
  )
    return decision
  if (
    decision &&
    typeof decision === 'object' &&
    ('acceptWithExecpolicyAmendment' in decision || 'applyNetworkPolicyAmendment' in decision)
  ) {
    return 'acceptForSession'
  }
  return 'decline'
}

export function fileChangeFromTool(
  toolName: string,
  input: Record<string, unknown>,
): FileUpdateChange[] {
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((edit, index) => {
      const rec = asRecord(edit)
      return {
        path: String(input.file_path ?? input.path ?? `edit-${index}`),
        kind: { type: 'update', move_path: null },
        diff: simpleDiff(
          String(input.file_path ?? input.path ?? `edit-${index}`),
          String(rec.old_string ?? ''),
          String(rec.new_string ?? ''),
        ),
      }
    })
  }
  const path = String(input.file_path ?? input.path ?? input.filename ?? 'unknown')
  if (toolName === 'Write') {
    return [
      { path, kind: { type: 'add' }, diff: simpleDiff(path, '', String(input.content ?? '')) },
    ]
  }
  return [
    {
      path,
      kind: { type: 'update', move_path: null },
      diff: simpleDiff(path, String(input.old_string ?? ''), String(input.new_string ?? '')),
    },
  ]
}

export function simpleDiff(path: string, oldText: string, newText: string): string {
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@',
    ...oldText
      .split('\n')
      .filter(Boolean)
      .map((line) => `-${line}`),
    ...newText
      .split('\n')
      .filter(Boolean)
      .map((line) => `+${line}`),
    '',
  ].join('\n')
}

// `git diff` failing is expected outside a repo, so we still return '' to keep
// turns working — but the reason is written to the debug log instead of being
// dropped silently, and a genuine git error is flagged as such.
export function isNotAGitRepo(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not a git repository/i.test(message)
}

// Cheap upfront check — if cwd isn't in a git work-tree, skip the expensive
// `git diff` spawn entirely. Without this guard a non-git workspace (App
// Remote pointing at $HOME or any arbitrary dir) was spamming debug.jsonl
// with multi-KB "not a git repository" failures on every turn cycle, since
// gitDiff runs from runRuntimeTurn after each tool result.
const gitRepoCache = new Map<string, boolean>()
export async function isGitWorkTree(cwd: string): Promise<boolean> {
  if (gitRepoCache.has(cwd)) return gitRepoCache.get(cwd) as boolean
  let inside = false
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: 3_000,
      maxBuffer: 1024,
    })
    inside = stdout.trim() === 'true'
  } catch {
    inside = false
  }
  gitRepoCache.set(cwd, inside)
  return inside
}

export async function gitDiff(cwd: string): Promise<string> {
  if (!(await isGitWorkTree(cwd))) return ''
  let trackedDiff = ''
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], {
      cwd,
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    trackedDiff = stdout
  } catch (error) {
    debugLog('git.diff.failed', {
      cwd,
      reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    return ''
  }
  const untrackedDiff = await gitUntrackedDiff(cwd)
  return [trackedDiff, untrackedDiff].filter(Boolean).join('\n')
}

export async function gitUntrackedDiff(cwd: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      {
        cwd,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    )
    const paths = stdout.split('\0').filter(Boolean).slice(0, 50)
    const diffs: string[] = []
    for (const path of paths) {
      const bytes = await readFile(`${cwd}/${path}`)
      if (bytes.includes(0)) continue
      diffs.push(addedFileDiff(path, bytes.toString('utf8')))
    }
    return diffs.join('\n')
  } catch (error) {
    debugLog('git.untrackedDiff.failed', {
      cwd,
      reason: isNotAGitRepo(error) ? 'notAGitRepository' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
    return ''
  }
}

export function addedFileDiff(path: string, text: string): string {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n')
}

export async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('rg', ['--files'], {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024,
    })
    return stdout.split('\n').filter(Boolean)
  } catch (rgError) {
    debugLog('listFiles.rgFailed', {
      root,
      error: rgError instanceof Error ? rgError.message : String(rgError),
    })
    try {
      const { stdout } = await execFileAsync('find', ['.', '-type', 'f'], {
        cwd: root,
        timeout: 10_000,
        maxBuffer: 5 * 1024 * 1024,
      })
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((path) => path.replace(/^\.\//, ''))
    } catch (findError) {
      debugLog('listFiles.findFailed', {
        root,
        error: findError instanceof Error ? findError.message : String(findError),
      })
      return []
    }
  }
}

// Normalise the App's item/tool/requestUserInput response into the shape the
// runtime expects. The Codex wire schema is
// `{answers: {[questionId]: {answers: string[]}}}` — we accept that plus a
// couple of forgiving variants (the App's experimental field set changes over
// time) and fall back to empty per-question selections when nothing parses.
export function normalizeUserInputAnswers(
  response: unknown,
  questions: UserInputQuestion[],
): UserInputAnswers {
  const empty: UserInputAnswers = {
    answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [] as string[] }])),
  }
  if (!response || typeof response !== 'object') return empty
  const root = response as Record<string, unknown>
  const slot = (root.answers ?? root) as Record<string, unknown>
  if (!slot || typeof slot !== 'object') return empty
  const out: UserInputAnswers['answers'] = {}
  for (const q of questions) {
    const raw = (slot as Record<string, unknown>)[q.id]
    if (!raw) {
      out[q.id] = { answers: [] }
      continue
    }
    if (Array.isArray(raw)) {
      out[q.id] = { answers: raw.map(String) }
      continue
    }
    if (typeof raw === 'string') {
      out[q.id] = { answers: [raw] }
      continue
    }
    const entry = raw as Record<string, unknown>
    const list = Array.isArray(entry.answers) ? entry.answers.map(String) : []
    const notes = typeof entry.notes === 'string' ? entry.notes : null
    out[q.id] = notes != null ? { answers: list, notes } : { answers: list }
  }
  return { answers: out }
}

// Build the Codex dynamicToolCall contentItems body for the answered question.
// One inputText item per question, formatted as `Header: answer`. This is what
// the App renders under the choice card after the user picks an option.
export function userInputAnswersAsContent(
  questions: UserInputQuestion[],
  answers: UserInputAnswers,
): Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }> {
  const out: Array<{ type: 'inputText'; text: string }> = []
  for (const q of questions) {
    const slot = answers.answers[q.id]
    const picked = slot?.answers?.filter((s) => s && s !== 'Other') ?? []
    const notes = slot?.notes ?? null
    const body =
      notes && (picked.length === 0 || picked.includes('Other'))
        ? notes
        : picked.join(', ') || '(no answer)'
    out.push({ type: 'inputText', text: `${q.header}: ${body}` })
  }
  return out
}
