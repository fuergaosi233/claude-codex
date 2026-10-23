// How a subagent thread is named, kept apart from the server so the wording
// can be tested on its own.

// The CLI puts a provenance header in front of the task text a workflow
// computes for its agents (and of the user request it relays to them): one
// line starting like this, then the text indented by two spaces.
const WORKFLOW_HARNESS_HEADER = '[Workflow harness'
const WORKFLOW_COMPUTED_TASK_HEADER = '[Workflow harness — computed task]'
const WORKFLOW_USER_REQUEST_HEADER = '[Workflow harness — user request]'

// Longest thread name the adapter gives a subagent. The App truncates a long
// title on screen; the limit only keeps a pasted paragraph out of the record.
export const SUBAGENT_NAME_MAX_CHARS = 120

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
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
