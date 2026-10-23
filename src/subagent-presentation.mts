// How a subagent thread is named and how its failure is told, kept apart from
// the server so the wording can be tested on its own.

import { appendSentence } from './util.mjs'

// The CLI puts a provenance header in front of the task text a workflow
// computes for its agents (and of the user request it relays to them): one
// line starting like this, then the text indented by two spaces.
const WORKFLOW_HARNESS_HEADER = '[Workflow harness'
const WORKFLOW_COMPUTED_TASK_HEADER = '[Workflow harness — computed task]'
const WORKFLOW_USER_REQUEST_HEADER = '[Workflow harness — user request]'

// Longest thread name the adapter gives a subagent. The App truncates a long
// title on screen; the limit only keeps a pasted paragraph out of the record.
export const SUBAGENT_NAME_MAX_CHARS = 120
// Longest failure reason; the full text stays in the child's last message.
const SUBAGENT_REASON_MAX_CHARS = 400
// How much of the first reason a parent turn's error repeats.
const SUMMARY_REASON_MAX_CHARS = 200

export const SUBAGENT_FAILED_WITHOUT_REASON = 'The subagent failed without saying why.'
export const SUBAGENT_STOPPED_BY_USER = 'Stopped by the user.'
export const SUBAGENT_STOPPED = 'Stopped before it finished.'

// One line of plain text: terminal escape sequences and bidirectional
// embedding, override and isolate marks go, runs of whitespace and other
// control characters become one space, and the ends are trimmed. Names and
// reasons come from model output and error text the App shows as they are.
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
}

// Cuts by code point so an emoji or CJK character is never split.
export function clipText(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars
    .slice(0, Math.max(0, maxChars - 1))
    .join('')
    .trimEnd()}…`
}

// The task text a workflow agent was given, from the user messages that
// started its transcript. The CLI sends a workflow agent the relayed user
// request and the computed task as two messages (one for a remote agent),
// each behind a provenance header; the computed task is what the agent is
// asked to do, so it is the agent's prompt, without its header and the
// indent the header promises. Without that header the first message that is
// not the relay is taken as it is.
export function workflowAgentPrompt(userMessages: readonly string[]): string | null {
  for (const message of userMessages) {
    const task = computedTaskText(message)
    if (task) return task
  }
  const present = userMessages.map((message) => message.trim()).filter(Boolean)
  return present.find((message) => !isRelayedUserRequest(message)) ?? present[0] ?? null
}

// A message that only relays the user's request to a workflow agent.
export function isRelayedUserRequest(message: string): boolean {
  return message.trimStart().startsWith(WORKFLOW_USER_REQUEST_HEADER) && !computedTaskText(message)
}

function computedTaskText(message: string): string | null {
  const lines = message.split('\n')
  const header = lines.findIndex((line) =>
    line.trimStart().startsWith(WORKFLOW_COMPUTED_TASK_HEADER),
  )
  if (header < 0) return null
  const body = lines.slice(header + 1)
  const indented = body.every((line) => line.length === 0 || line.startsWith('  '))
  const text = (indented ? body.map((line) => line.slice(2)) : body).join('\n').trim()
  return text || null
}

// The first line of a prompt worth a title: harness headers are skipped and
// Markdown heading, quote, list and emphasis marks dropped.
export function firstPromptLine(prompt: string): string {
  let lines = prompt.split('\n')
  const header = lines.findIndex((line) =>
    line.trimStart().startsWith(WORKFLOW_COMPUTED_TASK_HEADER),
  )
  if (header >= 0) lines = lines.slice(header + 1)
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith(WORKFLOW_HARNESS_HEADER)) continue
    const line = collapseWhitespace(
      trimmed
        .replace(/^(?:#{1,6}|>+|[-*+]|\d{1,3}[.)])\s+/, '')
        .replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)(?=\s|$)/, '$1'),
    )
    if (line) return line
  }
  return ''
}

// The name a subagent thread gets when it is spawned: what the parent called
// the agent (the Agent tool's description, a workflow agent's label), else
// its type and the first line of its prompt, else its type.
export function subagentThreadName(input: {
  description?: unknown
  subType?: string | null
  prompt?: unknown
}): string {
  const description =
    typeof input.description === 'string' ? collapseWhitespace(input.description) : ''
  if (description) return clipText(description, SUBAGENT_NAME_MAX_CHARS)
  const subType = collapseWhitespace(input.subType ?? '')
  const line = typeof input.prompt === 'string' ? firstPromptLine(input.prompt) : ''
  if (line) return clipText(subType ? `${subType}: ${line}` : line, SUBAGENT_NAME_MAX_CHARS)
  return clipText(subType || 'Subagent', SUBAGENT_NAME_MAX_CHARS)
}

// Why a subagent failed, in one paragraph, from the text its run ended with:
// the CLI's error tags, the result trailer and stack frames are dropped, and
// a JSON error body is told by its message.
export function subagentFailureReason(
  text: string,
  fallback = SUBAGENT_FAILED_WITHOUT_REASON,
): string {
  const jsonMessage = jsonErrorMessage(text)
  const source = jsonMessage ?? text
  const kept = source
    .replace(/<usage>[\s\S]*?<\/usage>/g, '\n')
    .replace(/<\/?tool_use_error>/g, '\n')
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line) && !/^\s*agentId:\s*\S+\s*$/.test(line))
    .join('\n')
  const reason = collapseWhitespace(kept)
  return reason ? clipText(reason, SUBAGENT_REASON_MAX_CHARS) : fallback
}

// Why a background subagent's task ended without completing, from its task
// notification. The CLI puts the error that ended a local agent (a stall, an
// API error) or the cause of a stop (a worker restart) in the summary, which
// otherwise falls back to the task's description; the result is only the
// last thing the agent said. `name` is the child thread's name, which a
// description summary matches.
export function taskEndReason(
  status: 'failed' | 'stopped',
  summary: string,
  result: string | null,
  name: string | null,
): string {
  const told = collapseWhitespace(summary)
  const description = !told || clipText(told, SUBAGENT_NAME_MAX_CHARS) === name
  if (!description) return subagentFailureReason(summary)
  if (status === 'stopped') return SUBAGENT_STOPPED
  return subagentFailureReason(result ?? '')
}

function jsonErrorMessage(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return typeof record.message === 'string' && record.message.trim() ? record.message : null
}

// A failed parent turn's error, told with the subagents that failed in it:
// how many, and why the first one did, unless the error says so already.
export function subagentFailureSummary(
  parentMessage: string,
  failures: { count: number; firstReason: string | null },
): string {
  const base = parentMessage.trim()
  if (failures.count <= 0) return base
  const reason = clipText(collapseWhitespace(failures.firstReason ?? ''), SUMMARY_REASON_MAX_CHARS)
  const known = reason.length > 0 && collapseWhitespace(base).includes(reason)
  const told =
    failures.count === 1
      ? known || !reason
        ? 'A subagent failed.'
        : `A subagent failed: ${reason}`
      : known || !reason
        ? `${failures.count} subagents failed.`
        : `${failures.count} subagents failed; the first: ${reason}`
  return appendSentence(base, told)
}

// The error a failed parent turn ends with, told with its failed subagents.
// It keeps the Codex error code and details the original error carries.
export function withSubagentFailures(
  error: Error,
  failures: { count: number; firstReason: string | null },
): Error {
  if (failures.count <= 0) return error
  const message = subagentFailureSummary(error.message, failures)
  if (message === error.message) return error
  const carried = error as Error & { codexErrorInfo?: unknown; additionalDetails?: unknown }
  return Object.assign(new Error(message, { cause: error }), {
    ...('codexErrorInfo' in carried ? { codexErrorInfo: carried.codexErrorInfo } : {}),
    ...('additionalDetails' in carried ? { additionalDetails: carried.additionalDetails } : {}),
  })
}
