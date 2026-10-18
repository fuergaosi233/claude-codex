// Quiet turns: a turn that ends while background agents or workflows of the
// thread are still running does not light the Codex App's unread dot. The
// work reports back in a turn of its own, and that turn lights it.
//
// The App marks a thread unread on every turn/completed unless the turn's
// last agent message ends with a heartbeat block deciding DONT_NOTIFY (the
// same block its automations use). It hides the block once the message is
// complete and skips the desktop notification as well. The adapter appends
// the block only to the message it publishes: Claude's own transcript never
// has it, and the helpers below take it back out of anything that could
// reach a prompt.

import type { RuntimeLiveTask } from './types.mjs'

// The <message> is what the App shows when nothing else of the message is
// visible, so it has to read well on its own.
// App rule: quiet-turn-heartbeat
export const QUIET_TURN_HEARTBEAT =
  '<heartbeat><decision>DONT_NOTIFY</decision><message>Background work is still running.</message></heartbeat>'

const QUIET_TURN_SUFFIX = `\n\n${QUIET_TURN_HEARTBEAT}`

// The block as the App's thread handoff writes it: input text HTML-escaped
// inside <codex_delegation>.
const ESCAPED_QUIET_TURN_HEARTBEAT = QUIET_TURN_HEARTBEAT.replaceAll('<', '&lt;').replaceAll(
  '>',
  '&gt;',
)

// CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0 lights the dot on every turn again.
export function quietBackgroundTurnsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODEX_QUIET_BACKGROUND_TURNS !== '0'
}

export interface QuietTurnFacts {
  enabled: boolean
  // turn/start asked for structured output: the answer has to stay JSON.
  structured: boolean
  // A subagent's own thread. The adapter finishes those itself; the quiet
  // decision belongs to the parent's turns.
  subagentThread: boolean
  // A background agent of the thread has not reported back yet.
  backgroundAgentRunning: boolean
  // The runtime's background tasks for the thread: agents, workflows and
  // backgrounded Bash shells.
  liveTasks: readonly RuntimeLiveTask[]
}

// Only agents and workflows report back when they finish. A backgrounded
// shell such as a dev server or a watcher can run for the rest of the chat,
// and would keep every later turn quiet, so shells and tasks of unknown type
// never count: a missed dot costs more than an extra one.
const QUIET_TASK_TYPES = new Set(['local_agent', 'local_workflow'])

// What keeps a finished turn quiet, as short labels for the debug log; empty
// when the turn should light the dot.
export function quietTurnReasons(facts: QuietTurnFacts): string[] {
  if (!facts.enabled || facts.structured || facts.subagentThread) return []
  const reasons = new Set<string>()
  if (facts.backgroundAgentRunning) reasons.add('background_agent')
  for (const { taskType } of facts.liveTasks)
    if (taskType != null && QUIET_TASK_TYPES.has(taskType)) reasons.add(taskType)
  return [...reasons]
}

// The agent message with the heartbeat appended, or null to leave it alone:
// a blank message has nothing to hide the block behind, and one that already
// carries a heartbeat keeps its own decision (the App reads the last block).
export function withQuietTurnHeartbeat(text: string): string | null {
  if (!text.trim() || /<heartbeat>/i.test(text)) return null
  return `${text}${QUIET_TURN_SUFFIX}`
}

// The text without any heartbeat this adapter appended, raw or escaped.
export function stripQuietTurnHeartbeat(text: string): string {
  let result = text
  for (const block of [QUIET_TURN_HEARTBEAT, ESCAPED_QUIET_TURN_HEARTBEAT]) {
    if (!result.includes(block)) continue
    result = result.replaceAll(`\n\n${block}`, '').replaceAll(block, '')
  }
  return result
}
