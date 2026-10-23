import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { stripQuietTurnHeartbeat } from './quiet-turns.mjs'
import type { SessionStore } from './store.mjs'
import type {
  LeaderToolHandlers,
  ThreadItem,
  ThreadRecord,
  TurnRecord,
  UserInput,
} from './types.mjs'
import { isCodexOpenAiModel } from './util.mjs'

// Leader tools let one Claude chat start other chats, send them messages,
// wait for them and read them. Unlike a subagent, a led chat is an ordinary
// thread: the user sees it in the Codex App sidebar, can open it, answer its
// approvals and keep talking to it. Off unless CLAUDE_CODEX_LEADER_TOOLS=1.

export const LEADER_MCP_SERVER = 'codex_leader'

// How many leaders may stand above a chat that leads. With 1, chats the user
// started may lead and chats a leader started may not, so no chain of chats
// can fan out on its own.
export const LEADER_MAX_DEPTH = 1

// The tools that only look. Plan mode allows these and nothing else.
export const LEADER_READ_ONLY_TOOLS = ['thread_list', 'thread_read', 'thread_wait'] as const
// The Codex App thread tools the leader tools stand in for (thread_start,
// thread_list, thread_read, thread_wait and thread_prompt).
export const LEADER_APP_THREAD_TOOLS = [
  'create_thread',
  'list_threads',
  'read_thread',
  'wait_threads',
  'send_message_to_thread',
] as const

const DEFAULT_MAX_RUNNING = 4
const DEFAULT_WAIT_SECONDS = 300
const MAX_WAIT_SECONDS = 3600
// Waits wake on every thread status change. The poll is a backstop for what
// does not go through one, such as the leader's own turn ending.
const WAIT_POLL_MS = 1000
const MESSAGE_LIMIT = 2000
const ITEM_LIMIT = 4000
const READ_LIMIT = 16_000
const TITLE_LIMIT = 80
const LIST_LIMIT = 50

export type LeaderThreadStatus = 'idle' | 'working' | 'blocked' | 'done-unread'

export const THREAD_LIST_DESCRIPTION = `List the chats you started with thread_start and the status of each: working (a turn is running), blocked (waiting for the user to approve a request or answer a question in that chat), done-unread (finished a turn you have not read yet) or idle. scope "all" lists the user's other recent chats too.
Do not poll it to wait for a chat; thread_wait does that.`

export const THREAD_START_DESCRIPTION = `Start a separate Claude chat that the user sees in the Codex App sidebar, with prompt as its first message. Returns at once with its threadId; use thread_wait to wait for its answer.
Use it only for long-running, independent work the user wants as chats of their own, such as when they ask you to start several pieces of work in parallel. Do not use it to split up, research or review your own task: the Agent tool is faster and cheaper for that and keeps the results here.
The prompt must stand alone: the new chat sees nothing of this one. cwd and model default to this chat's. Chats you start cannot start chats themselves, and only a few of yours may run at once.
The result ends with a ::created-thread line. Put that line, unchanged and on a line of its own, in your final response: the Codex App shows it as a card for the new chat.`

export const THREAD_PROMPT_DESCRIPTION = `Send a message to a chat you started with thread_start, as the user would. While the chat is working, the message joins its running turn (the Codex App's default for follow-ups); otherwise it starts a new turn.
Refused while the chat is blocked: only the user can approve or answer there, so tell them. wait true also waits (up to timeoutSec) for the turn that took the message and returns its result.`

export const THREAD_WAIT_DESCRIPTION = `Wait until chats you started finish their turn or get blocked on the user. until "any" (default) returns as soon as one of them does, "all" once every one has. Returns each chat's status and last agent message, truncated; thread_read has the rest. backgroundWorkRunning means that chat's turn ended with background work still running, which reports back in a later turn.
A blocked chat needs the user to approve a request or answer a question in it, which you cannot do: tell the user which chat to open. Times out after timeoutSec (default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}).`

export const THREAD_READ_DESCRIPTION = `Read a chat's transcript as structured items: user and agent messages, plans, tool call summaries and errors, in pages of bounded size. Pass the returned cursor as sinceCursor to read only what came after it; a turn still running is returned again on the next read.
Use it when the last message thread_wait returns is not enough.`

export function leaderToolsEnabled(): boolean {
  return process.env.CLAUDE_CODEX_LEADER_TOOLS === '1'
}

// Chats one leader may have running at once.
export function leaderMaxRunning(): number {
  const value = Number(process.env.CLAUDE_CODEX_LEADER_MAX_RUNNING)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_RUNNING
}

// What the leader tools need from the app-server.
export interface LeaderHost {
  readonly store: SessionStore
  // The thread's running turn, if any.
  activeTurnId(threadId: string): string | null
  // Creates a Claude chat the App lists, links it to `leader` and starts its
  // first turn with `prompt`.
  startThread(
    leader: ThreadRecord,
    options: { prompt: string; cwd: string; model: string; title: string | null },
  ): Promise<{ threadId: string; turnId: string }>
  // Sends text to the thread the way the App sends a message: into the
  // running turn (steered) or as a new turn.
  sendInput(threadId: string, text: string): Promise<{ turnId: string; steered: boolean }>
}

export class LeaderThreads {
  private readonly host: LeaderHost
  private readonly handlers = new Map<string, LeaderToolHandlers>()
  private readonly waiters = new Set<() => void>()
  private stopped = false

  constructor(host: LeaderHost) {
    this.host = host
  }

  // Whether the thread gets the leader tools.
  allowed(thread: ThreadRecord): boolean {
    if (!leaderToolsEnabled()) return false
    if (thread.ephemeral || thread.threadSource === 'subagent') return false
    return this.depth(thread.id) < LEADER_MAX_DEPTH
  }

  // A thread's status changed: waits look again. Deferred, so that a queued
  // follow-up the server starts as a turn ends is already running then.
  threadChanged(): void {
    if (this.waiters.size === 0) return
    setImmediate(() => {
      for (const wake of [...this.waiters]) wake()
    })
  }

  forget(threadId: string): void {
    this.handlers.delete(threadId)
  }

  stop(): void {
    this.stopped = true
    for (const wake of [...this.waiters]) wake()
  }

  // One set of handlers serves the thread's whole session: they look the
  // thread up when called.
  handlersFor(leaderId: string): LeaderToolHandlers {
    const cached = this.handlers.get(leaderId)
    if (cached) return cached
    const handlers: LeaderToolHandlers = {
      list: async (input) => this.list(leaderId, input.scope),
      start: async (input) => this.start(leaderId, input),
      prompt: async (input, signal) => this.prompt(leaderId, input, signal),
      wait: async (input, signal) => this.wait(leaderId, input, signal),
      read: async (input) => this.read(leaderId, input),
    }
    this.handlers.set(leaderId, handlers)
    return handlers
  }

  private list(leaderId: string, scope: string | undefined): string {
    this.leader(leaderId)
    if (scope != null && scope !== 'children' && scope !== 'all')
      throw new Error('scope must be "children" or "all"')
    const store = this.host.store
    const seen = new Map(store.listLeaderThreads(leaderId).map((l) => [l.threadId, l.seenTurnId]))
    const threads =
      scope === 'all'
        ? store
            .listThreads({
              archived: false,
              limit: LIST_LIMIT,
              sortKey: 'updated_at',
              excludeEmpty: true,
            })
            .filter((t) => t.id !== leaderId && t.threadSource !== 'subagent' && !t.ephemeral)
        : [...seen.keys()].flatMap((id) => store.getThread(id) ?? [])
    return JSON.stringify({
      scope: scope ?? 'children',
      running: this.running(leaderId),
      maxRunning: leaderMaxRunning(),
      threads: threads.map((thread) => ({
        ...this.describe(thread, this.status(thread, seen), false),
        ...(scope === 'all' ? { startedByYou: seen.has(thread.id) } : {}),
      })),
    })
  }

  private async start(
    leaderId: string,
    input: Parameters<LeaderToolHandlers['start']>[0],
  ): Promise<string> {
    const leader = this.leader(leaderId)
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('prompt must not be empty')
    this.checkCapacity(leaderId)
    const cwd = input.cwd?.trim() || leader.cwd
    if (!isAbsolute(cwd) || !isDirectory(cwd))
      throw new Error(`cwd must be an existing directory, as an absolute path: ${cwd}`)
    const model = input.model?.trim() || leader.model
    // Claude chats only. A GPT chat would run on the Codex proxy backend:
    // the place to add it is here and in the host's startThread.
    if (isCodexOpenAiModel(model))
      throw new Error(`thread_start starts Claude chats only, and ${model} is not a Claude model`)
    // One line, as the sidebar shows it. Without one the App titles the chat.
    const title = input.title?.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) || null
    const { threadId, turnId } = await this.host.startThread(leader, { prompt, cwd, model, title })
    const thread = this.host.store.getThread(threadId)
    const started = JSON.stringify({
      threadId,
      turnId,
      title: thread ? titleOf(thread) : title,
      status: 'working',
      cwd: thread?.cwd ?? cwd,
      model: thread?.model ?? model,
    })
    return `${started}\n${createdThreadLine(threadId)}`
  }

  private async prompt(
    leaderId: string,
    input: Parameters<LeaderToolHandlers['prompt']>[0],
    signal?: AbortSignal,
  ): Promise<string> {
    this.leader(leaderId)
    const thread = this.child(leaderId, input.threadId)
    const text = input.text.trim()
    if (!text) throw new Error('text must not be empty')
    const status = this.status(thread, this.seenTurns(leaderId))
    if (status === 'blocked') throw new Error(blockedMessage(thread))
    if (status !== 'working') this.checkCapacity(leaderId)
    const timeout = waitSeconds(input.timeoutSec)
    const { turnId, steered } = await this.host.sendInput(thread.id, text)
    const sent = { threadId: thread.id, turnId, delivered: steered ? 'steered' : 'newTurn' }
    if (input.wait !== true) return JSON.stringify(sent)
    const settled = await this.waitFor(
      () => this.host.store.getTurn(turnId)?.status !== 'inProgress' || this.isBlocked(thread.id),
      timeout,
      signal,
      leaderId,
    )
    const turn = this.host.store.getTurn(turnId)
    // The result carries the finished turn, so the leader has read it.
    if (turn && turn.status !== 'inProgress') this.markSeen(thread.id, turn.id)
    const current = this.host.store.getThread(thread.id) ?? thread
    return JSON.stringify({
      ...sent,
      timedOut: !settled,
      status: this.status(current, this.seenTurns(leaderId)),
      turnStatus: turn?.status ?? null,
      ...(turn ? lastAgentMessage(turn) : { lastAgentMessage: null }),
      ...turnError(turn),
    })
  }

  private async wait(
    leaderId: string,
    input: Parameters<LeaderToolHandlers['wait']>[0],
    signal?: AbortSignal,
  ): Promise<string> {
    this.leader(leaderId)
    const ids = [...new Set(input.threadIds)]
    if (ids.length === 0) throw new Error('threadIds must name at least one chat you started')
    const until = input.until ?? 'any'
    if (until !== 'any' && until !== 'all') throw new Error('until must be "any" or "all"')
    for (const id of ids) this.child(leaderId, id)
    const timeout = waitSeconds(input.timeoutSec)
    const statuses = (): LeaderThreadStatus[] => {
      const seen = this.seenTurns(leaderId)
      return ids.map((id) => {
        const thread = this.host.store.getThread(id)
        return thread ? this.status(thread, seen) : 'idle'
      })
    }
    const settled = await this.waitFor(
      () => {
        const now = statuses()
        if (!now.includes('working')) return true
        return until === 'any' && now.some((s) => s === 'done-unread' || s === 'blocked')
      },
      timeout,
      signal,
      leaderId,
    )
    const seen = this.seenTurns(leaderId)
    const threads = ids.map((id) => {
      const thread = this.host.store.getThread(id)
      if (!thread) return { threadId: id, status: 'idle', deleted: true }
      const status = this.status(thread, seen)
      const entry = this.describe(thread, status, true)
      if (status === 'done-unread' && typeof entry.turnId === 'string')
        this.markSeen(id, entry.turnId)
      return entry
    })
    return JSON.stringify({ until, timedOut: !settled, threads })
  }

  private read(leaderId: string, input: Parameters<LeaderToolHandlers['read']>[0]): string {
    this.leader(leaderId)
    const store = this.host.store
    const thread = store.getThread(input.threadId)
    if (!thread || thread.ephemeral) throw new Error(`unknown thread: ${input.threadId}`)
    const tracked = store.leaderOf(thread.id) === leaderId
    const status = this.status(thread, this.seenTurns(leaderId))
    // A fork reads with the turns it was forked with, as the App shows it.
    const turns = store.historyTurns(thread.id)
    let first = 0
    let firstItem = 0
    let cursorReset = false
    if (input.sinceCursor) {
      const at = parseCursor(input.sinceCursor, turns)
      if (at) [first, firstItem] = at
      else cursorReset = true
    }
    const page: Array<Record<string, unknown>> = []
    let budget = READ_LIMIT
    let cursor: string | null = null
    let hasMore = false
    for (let index = first; index < turns.length && !hasMore; index += 1) {
      const turn = turns[index] as TurnRecord
      const start = index === first ? firstItem : 0
      const items: Array<Record<string, unknown>> = []
      let next = start
      for (; next < turn.items.length; next += 1) {
        const summary = summarizeItem(turn.items[next] as ThreadItem)
        if (!summary) continue
        const size = JSON.stringify(summary).length
        if (size > budget && (items.length > 0 || page.length > 0)) {
          hasMore = true
          break
        }
        budget -= size
        items.push(summary)
      }
      const error = hasMore ? {} : turnError(turn)
      if (items.length > 0 || 'error' in error)
        page.push({ turnId: turn.id, status: turn.status, items, ...error })
      // A running turn is read again from where this read began in it: its
      // items are still changing.
      if (hasMore) cursor = `${turn.id}:${next}`
      else if (turn.status === 'inProgress') cursor = `${turn.id}:${start}`
      else cursor = `${turn.id}:${turn.items.length}`
    }
    // Only a turn of the chat's own counts as read: markSeen passes over an
    // inherited one.
    const last = turns.at(-1)
    if (tracked && !hasMore && last && last.status !== 'inProgress')
      this.markSeen(thread.id, last.id)
    return JSON.stringify({
      threadId: thread.id,
      title: titleOf(thread),
      status,
      turns: page,
      cursor,
      hasMore,
      ...(cursorReset ? { cursorReset: true } : {}),
    })
  }

  // Resolves true once `settled` holds; false on timeout, when Claude's tool
  // call is cancelled, when the leader's turn has ended or the adapter stops.
  private waitFor(
    settled: () => boolean,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
    leaderId: string,
  ): Promise<boolean> {
    if (settled()) return Promise.resolve(true)
    const leaderTurn = this.host.activeTurnId(leaderId)
    return new Promise((resolve) => {
      let done = false
      const finish = (value: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(poll)
        this.waiters.delete(check)
        signal?.removeEventListener('abort', abort)
        resolve(value)
      }
      const check = (): void => {
        if (settled()) finish(true)
        else if (
          this.stopped ||
          signal?.aborted ||
          (leaderTurn !== null && this.host.activeTurnId(leaderId) !== leaderTurn)
        )
          finish(false)
      }
      const abort = (): void => finish(false)
      const timer = setTimeout(() => finish(settled()), timeoutSeconds * 1000)
      const poll = setInterval(check, WAIT_POLL_MS)
      timer.unref()
      poll.unref()
      this.waiters.add(check)
      signal?.addEventListener('abort', abort, { once: true })
      if (this.stopped || signal?.aborted) finish(false)
    })
  }

  private leader(leaderId: string): ThreadRecord {
    const thread = this.host.store.getThread(leaderId)
    if (!thread) throw new Error(`unknown thread: ${leaderId}`)
    if (!this.allowed(thread)) throw new Error('this chat cannot use the leader tools')
    return thread
  }

  private child(leaderId: string, threadId: string): ThreadRecord {
    if (threadId === leaderId) throw new Error('that is this chat; pass a chat you started')
    const thread = this.host.store.getThread(threadId)
    if (!thread || this.host.store.leaderOf(threadId) !== leaderId)
      throw new Error(`${threadId} is not a chat you started with thread_start`)
    return thread
  }

  // Leaders above the thread. A fork of a led chat counts as led too, so
  // forking one cannot lift the limit.
  private depth(threadId: string): number {
    const store = this.host.store
    const visited = new Set<string>()
    let depth = 0
    let current: string | null = threadId
    while (current && !visited.has(current)) {
      visited.add(current)
      const leader = store.leaderOf(current)
      if (leader) {
        depth += 1
        current = leader
      } else {
        current = store.getThread(current)?.forkedFromId ?? null
      }
    }
    return depth
  }

  private running(leaderId: string): number {
    return this.host.store
      .listLeaderThreads(leaderId)
      .filter((link) => this.host.activeTurnId(link.threadId) !== null).length
  }

  private checkCapacity(leaderId: string): void {
    const max = leaderMaxRunning()
    const running = this.running(leaderId)
    if (running >= max)
      throw new Error(
        `${running} chats you started are still working (the limit is ${max}); wait for one with thread_wait first`,
      )
  }

  private seenTurns(leaderId: string): Map<string, string | null> {
    return new Map(
      this.host.store.listLeaderThreads(leaderId).map((link) => [link.threadId, link.seenTurnId]),
    )
  }

  // Unread completions only exist for the leader's own chats (in `seen`).
  private status(thread: ThreadRecord, seen: Map<string, string | null>): LeaderThreadStatus {
    if (this.host.activeTurnId(thread.id)) return this.isBlocked(thread.id) ? 'blocked' : 'working'
    if (!seen.has(thread.id)) return 'idle'
    const last = this.host.store.lastTurnRef(thread.id)
    return last && last.status !== 'inProgress' && last.id !== seen.get(thread.id)
      ? 'done-unread'
      : 'idle'
  }

  // Waiting on the user to approve a request or answer a question.
  private isBlocked(threadId: string): boolean {
    if (!this.host.activeTurnId(threadId)) return false
    const status = this.host.store.getThread(threadId)?.status
    return status?.type === 'active' && status.activeFlags.length > 0
  }

  private markSeen(threadId: string, turnId: string): void {
    // Never step back to an older turn than the newest finished one.
    if (this.host.store.lastTurnRef(threadId)?.id === turnId)
      this.host.store.markLeaderSeen(threadId, turnId)
  }

  private describe(
    thread: ThreadRecord,
    status: LeaderThreadStatus,
    withMessage: boolean,
  ): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      threadId: thread.id,
      title: titleOf(thread),
      status,
    }
    if (status === 'blocked') entry.blockedOn = blockedOn(thread)
    entry.cwd = thread.cwd
    entry.model = thread.model
    // A fork that has no turn of its own yet shows the last one it inherited.
    // Unread completions (status) count only its own turns.
    const last = this.host.store.lastHistoryTurnRef(thread.id)
    if (last) {
      entry.turnId = last.id
      entry.turnStatus = last.status
    }
    if (withMessage && last) {
      const turn = this.host.store.historyTurn(thread.id, last.id)
      if (turn) {
        Object.assign(entry, lastAgentMessage(turn), turnError(turn))
      }
    }
    return entry
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// The line a reply carries for the Codex App to show a card for a chat that
// was just started, as the App asks of its own thread tools. The tool result
// only hands it to Claude: the App reads it from Claude's completed reply.
// App rule: created-thread-card
function createdThreadLine(threadId: string): string {
  return `::created-thread{threadId="${threadId}"}`
}

function waitSeconds(value: number | undefined): number {
  if (value == null) return DEFAULT_WAIT_SECONDS
  if (!Number.isFinite(value) || value < 0) throw new Error('timeoutSec must not be negative')
  return Math.min(value, MAX_WAIT_SECONDS)
}

function titleOf(thread: ThreadRecord): string | null {
  return thread.name || (thread.preview ? clip(thread.preview, TITLE_LIMIT) : null)
}

function blockedOn(thread: ThreadRecord): 'approval' | 'userInput' {
  const flags = thread.status.type === 'active' ? thread.status.activeFlags : []
  return flags.includes('waitingOnApproval') ? 'approval' : 'userInput'
}

function blockedMessage(thread: ThreadRecord): string {
  const what = blockedOn(thread) === 'approval' ? 'approve a request' : 'answer a question'
  return `chat ${thread.id} is waiting for the user to ${what} in it. Only the user can do that: tell them which chat to open, then thread_wait for it.`
}

export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… [${text.length - limit} more characters]`
}

function lastAgentText(turn: TurnRecord): string {
  const message = turn.items.findLast((item) => item.type === 'agentMessage')
  return message?.type === 'agentMessage' ? message.text : ''
}

// The turn's last agent message without the heartbeat a quiet turn's answer
// carries for the App. That heartbeat means background work of the chat was
// still running when the turn ended; it reports back in a turn of its own.
// App rule: quiet-turn-heartbeat
function lastAgentMessage(turn: TurnRecord): {
  lastAgentMessage: string
  backgroundWorkRunning?: true
} {
  const text = lastAgentText(turn)
  const visible = stripQuietTurnHeartbeat(text)
  return {
    lastAgentMessage: clip(visible, MESSAGE_LIMIT),
    ...(visible === text ? {} : { backgroundWorkRunning: true as const }),
  }
}

function turnError(turn: TurnRecord | null | undefined): { error?: string } {
  if (!turn?.error) return {}
  const message = (turn.error as { message?: unknown }).message
  return { error: clip(typeof message === 'string' ? message : JSON.stringify(turn.error), 500) }
}

// "<turn id>:<item index>": where the next read starts.
function parseCursor(cursor: string, turns: TurnRecord[]): [number, number] | null {
  const separator = cursor.lastIndexOf(':')
  if (separator <= 0) return null
  const turnIndex = turns.findIndex((turn) => turn.id === cursor.slice(0, separator))
  const itemIndex = Number(cursor.slice(separator + 1))
  if (turnIndex < 0 || !Number.isInteger(itemIndex) || itemIndex < 0) return null
  return [turnIndex, itemIndex]
}

function userText(content: UserInput[]): string {
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text
        case 'image':
        case 'localImage':
          return '[image]'
        case 'skill':
        case 'mention':
          return part.name
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n')
}

function toolStatus(status: string): Record<string, unknown> {
  return status === 'completed' ? {} : { status }
}

// What thread_read shows of an item; null skips it (reasoning, hooks and
// other activity a leader does not need).
function summarizeItem(item: ThreadItem): Record<string, unknown> | null {
  switch (item.type) {
    case 'userMessage':
      return { type: 'user', text: clip(userText(item.content), ITEM_LIMIT) }
    case 'functionCallOutput':
      return {
        type: 'user',
        text: clip(typeof item.output === 'string' ? item.output : '[tool output]', ITEM_LIMIT),
      }
    case 'agentMessage':
      return { type: 'agent', text: clip(stripQuietTurnHeartbeat(item.text), ITEM_LIMIT) }
    case 'plan':
      return { type: 'plan', text: clip(item.text, ITEM_LIMIT) }
    case 'commandExecution':
      return {
        type: 'tool',
        tool: 'command',
        summary: clip(item.command, 300),
        ...toolStatus(item.status),
        ...(item.exitCode ? { exitCode: item.exitCode } : {}),
      }
    case 'fileChange':
      return {
        type: 'tool',
        tool: 'fileChange',
        summary: clip(
          item.changes.map((change) => `${change.kind.type} ${change.path}`).join(', '),
          300,
        ),
        ...toolStatus(item.status),
      }
    case 'mcpToolCall':
      return {
        type: 'tool',
        tool: item.tool,
        summary: clip(JSON.stringify(item.arguments ?? {}), 200),
        ...toolStatus(item.status),
        ...(item.error ? { error: clip(item.error.message, 500) } : {}),
      }
    case 'dynamicToolCall':
      return {
        type: 'tool',
        tool: item.tool,
        summary: clip(JSON.stringify(item.arguments ?? {}), 200),
        ...toolStatus(item.status),
      }
    case 'webSearch':
      return { type: 'tool', tool: 'webSearch', summary: clip(item.query, 300) }
    case 'collabAgentToolCall':
      return {
        type: 'tool',
        tool: `agent.${item.tool}`,
        summary: clip(item.prompt ?? '', 300),
        ...toolStatus(item.status),
      }
    default:
      return null
  }
}
