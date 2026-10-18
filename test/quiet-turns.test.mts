import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QUIET_TURN_HEARTBEAT,
  type QuietTurnFacts,
  quietBackgroundTurnsEnabled,
  quietTurnReasons,
  stripQuietTurnHeartbeat,
  withQuietTurnHeartbeat,
} from '../src/quiet-turns.mjs'
import { compactSummary } from '../src/server-helpers.mjs'
import { findOccurrences } from '../src/thread-history.mjs'
import type { ThreadItem, ThreadRecord, TurnRecord } from '../src/types.mjs'

const idle: QuietTurnFacts = {
  enabled: true,
  structured: false,
  subagentThread: false,
  backgroundAgentRunning: false,
  liveTasks: [],
}

const workflow = { taskId: 'w1', taskType: 'local_workflow', toolUseId: null }
const shell = { taskId: 'bash-1', taskType: 'local_bash', toolUseId: 'toolu_1' }

test('a turn is quiet while background agents or workflows run', () => {
  assert.deepEqual(quietTurnReasons(idle), [])
  assert.deepEqual(quietTurnReasons({ ...idle, backgroundAgentRunning: true }), [
    'background_agent',
  ])
  assert.deepEqual(quietTurnReasons({ ...idle, liveTasks: [workflow] }), ['local_workflow'])
  assert.deepEqual(
    quietTurnReasons({
      ...idle,
      backgroundAgentRunning: true,
      liveTasks: [
        { taskId: 'a1', taskType: 'local_agent', toolUseId: null },
        workflow,
        { taskId: 'w2', taskType: 'local_workflow', toolUseId: null },
        shell,
      ],
    }),
    ['background_agent', 'local_agent', 'local_workflow'],
  )
})

test('background shells and tasks of unknown type never keep a turn quiet', () => {
  assert.deepEqual(quietTurnReasons({ ...idle, liveTasks: [shell] }), [])
  assert.deepEqual(
    quietTurnReasons({
      ...idle,
      liveTasks: [
        shell,
        { taskId: 'x1', taskType: null, toolUseId: null },
        { taskId: 'x2', taskType: 'remote_agent', toolUseId: null },
      ],
    }),
    [],
  )
})

test('structured turns, subagent threads and the opt-out are never quiet', () => {
  const running = { ...idle, backgroundAgentRunning: true, liveTasks: [workflow] }
  assert.deepEqual(quietTurnReasons({ ...running, structured: true }), [])
  assert.deepEqual(quietTurnReasons({ ...running, subagentThread: true }), [])
  assert.deepEqual(quietTurnReasons({ ...running, enabled: false }), [])
})

test('CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0 is the only opt-out', () => {
  assert.equal(quietBackgroundTurnsEnabled({}), true)
  assert.equal(quietBackgroundTurnsEnabled({ CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '1' }), true)
  assert.equal(quietBackgroundTurnsEnabled({ CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '' }), true)
  assert.equal(quietBackgroundTurnsEnabled({ CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '0' }), false)
})

// The App's own parser for a non-automation turn (Az in its bundle): strip
// every heartbeat block for the visible text, then read the decision and the
// message from the last one.
function appHeartbeat(text: string) {
  const trimmed = text.trim()
  const visible = trimmed
    .replace(/```(?:xml)?\s*<heartbeat>[\s\S]*?<\/heartbeat>\s*```/gi, '')
    .replace(/<heartbeat>[\s\S]*?<\/heartbeat>/gi, '')
    .trim()
  const last = Array.from(trimmed.matchAll(/<heartbeat>[\s\S]*?<\/heartbeat>/gi)).at(-1)?.[0]
  if (visible === trimmed || last == null) return null
  const decision = last.match(/<decision>\s*(NOTIFY|DONT_NOTIFY)\s*<\/decision>/i)?.[1]
  if (decision == null) return null
  const message = last.match(/<message>\s*([\s\S]*?)\s*<\/message>/i)?.[1]?.trim() ?? ''
  return { decision: decision.toUpperCase(), visibleText: visible, message }
}

test('the appended heartbeat parses as DONT_NOTIFY and leaves the answer visible', () => {
  const answer = 'Started the survey agent; it will report back.\n\n```js\nx()\n```'
  const marked = withQuietTurnHeartbeat(answer)
  assert.ok(marked)
  assert.ok(marked.endsWith(QUIET_TURN_HEARTBEAT))
  assert.deepEqual(appHeartbeat(marked), {
    decision: 'DONT_NOTIFY',
    visibleText: answer.trim(),
    message: 'Background work is still running.',
  })
  assert.equal(appHeartbeat(answer), null)
})

test('a blank message or one with its own heartbeat is left alone', () => {
  assert.equal(withQuietTurnHeartbeat(''), null)
  assert.equal(withQuietTurnHeartbeat('  \n'), null)
  const own = 'Checked.\n<heartbeat><decision>NOTIFY</decision></heartbeat>'
  assert.equal(withQuietTurnHeartbeat(own), null)
  assert.equal(withQuietTurnHeartbeat(own.toUpperCase()), null)
})

test('stripping takes out exactly the appended heartbeat, raw or escaped', () => {
  const answer = 'dev server started'
  const marked = withQuietTurnHeartbeat(answer) ?? ''
  assert.equal(stripQuietTurnHeartbeat(marked), answer)
  assert.equal(stripQuietTurnHeartbeat(`quote: ${marked}\nthanks`), `quote: ${answer}\nthanks`)
  const escaped = marked.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  assert.equal(
    stripQuietTurnHeartbeat(`<input>${escaped}</input>`),
    '<input>dev server started</input>',
  )
  assert.equal(stripQuietTurnHeartbeat(QUIET_TURN_HEARTBEAT), '')
  // Anything else stays as written, a heartbeat of Claude's own included.
  const own = 'ok\n<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>'
  assert.equal(stripQuietTurnHeartbeat(own), own)
  assert.equal(stripQuietTurnHeartbeat(answer), answer)
})

function agentItem(id: string, text: string): ThreadItem {
  return { type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null }
}

function completedTurn(id: string, items: ThreadItem[]): TurnRecord {
  return {
    id,
    threadId: 'thread',
    status: 'completed',
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
    items,
    diff: '',
    error: null,
  }
}

test('summaries and search never see the heartbeat', () => {
  const marked = withQuietTurnHeartbeat('agent launched in background') ?? ''
  const turns = [completedTurn('t1', [agentItem('a1', marked)])]
  const summary = compactSummary({ id: 'thread' } as ThreadRecord, turns)
  assert.match(summary, /Assistant: agent launched in background$/m)
  assert.doesNotMatch(summary, /heartbeat|DONT_NOTIFY/)
  assert.deepEqual(findOccurrences(turns, 'DONT_NOTIFY'), [])
  assert.deepEqual(findOccurrences(turns, 'still running'), [])
  assert.equal(findOccurrences(turns, 'launched').length, 1)
})
