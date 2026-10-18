import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { codexNotifyCommand } from './codex-config.mjs'
import { redactSecretLikeText } from './provider-loop-descriptor-schema.mjs'
import { debugLog } from './util.mjs'

// The `notify` program of the user's Codex config.toml, run when a Claude
// thread's turn completes, as Codex runs it for its own: the configured
// argv with the event's JSON appended as one more argument. Codex does not
// wait for it and neither does the adapter; a program still running after
// NOTIFY_TIMEOUT_MS is ended, and what it writes to stderr goes to the
// debug log. A project's .codex/config.toml cannot set it.
//
// Only with CLAUDE_CODEX_CODEX_NOTIFY=1: the Codex App sets `notify` to its
// own turn-ended program for Codex threads, which should not be called
// after every Claude turn unless the user asks for it.

const NOTIFY_TIMEOUT_MS = 30_000
const STDERR_LIMIT = 4000

export interface TurnCompleteNotification {
  readonly threadId: string
  readonly turnId: string
  readonly cwd: string
  // The App's client name from initialize, when it gave one.
  readonly client: string | null
  // What the user sent to start the turn.
  readonly inputMessages: string[]
  readonly lastAssistantMessage: string | null
}

// The JSON argument, with Codex's agent-turn-complete field names.
export function notifyPayload(event: TurnCompleteNotification): string {
  return JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': event.threadId,
    'turn-id': event.turnId,
    cwd: event.cwd,
    ...(event.client ? { client: event.client } : {}),
    'input-messages': event.inputMessages,
    'last-assistant-message': event.lastAssistantMessage,
  })
}

// Starts the notify program, if enabled and configured. Returns whether it
// did.
export function runCodexNotify(event: TurnCompleteNotification): boolean {
  if (process.env.CLAUDE_CODEX_CODEX_NOTIFY !== '1') return false
  const command = codexNotifyCommand()
  if (!command) return false
  const [program = '', ...args] = command
  // The program's name only: its arguments may carry credentials.
  const name = basename(program)
  try {
    const child = spawn(program, [...args, notifyPayload(event)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), NOTIFY_TIMEOUT_MS)
    timer.unref()
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      debugLog('codex_notify_failed', { program: name, error: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const text = stderr.trim()
      if (code === 0 && !text) return
      debugLog('codex_notify_exited', {
        program: name,
        code,
        signal,
        stderr: redactSecretLikeText(text.slice(0, STDERR_LIMIT)),
      })
    })
    child.unref()
  } catch (error) {
    debugLog('codex_notify_failed', {
      program: name,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return true
}
