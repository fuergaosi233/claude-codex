import { randomUUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

// Prompt channel for one native turn.
//
// The Agent SDK reads an AsyncIterable prompt for as long as the CLI's stdin
// is open: once the iterable ends, Query.streamInput() waits for the first
// `result` and then closes stdin. A one-shot iterable is therefore too short
// for a resumed session. The CLI may answer queued work of its own before our
// prompt (e.g. the <task-notification> for a background task the previous
// process left unfinished). Once stdin is closed, every later control round
// trip of the turn, such as canUseTool, fails with "Stream closed". Keeping
// the channel open until the turn settles keeps those round trips alive and
// gives steer() a live input to push into.
//
// Every message sent here is stamped with a client uuid. The CLI echoes the
// uuids a turn consumed on its `result` (user_message_uuids), so
// classifyResult() can tell this turn's own result apart from results the
// session produced for work we never sent.

export type TurnInputMessage = Omit<SDKUserMessage, 'uuid'>

// final   — answers everything this turn sent; the turn can complete.
// pending — answers part of it; a steer is still queued as its own turn.
// foreign — answers input this turn did not send; ignore it.
export type TurnResultKind = 'final' | 'pending' | 'foreign'

export class TurnInput implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  private sent = new Set<string>()
  private unanswered = new Set<string>()

  send(message: TurnInputMessage): boolean {
    if (this.closed) return false
    const uuid = randomUUID()
    this.sent.add(uuid)
    this.unanswered.add(uuid)
    this.queue.push({ ...message, uuid })
    this.notify()
    return true
  }

  // The turn has settled: end the prompt stream so the SDK can release the
  // CLI's stdin. Anything not yet written has no turn left to answer it.
  close(): void {
    this.closed = true
    this.queue.length = 0
    this.notify()
  }

  classifyResult(result: Record<string, unknown>): TurnResultKind {
    const echoed = echoedUuids(result)
    let answered = false
    for (const uuid of echoed) {
      if (!this.sent.has(uuid)) continue
      answered = true
      this.unanswered.delete(uuid)
    }
    if (!answered) {
      // Names someone else's sends, or was started by a non-human origin
      // (task notification, channel, peer): not a reply to this turn.
      if (echoed.length > 0) return 'foreign'
      const kind = (result.origin as { kind?: unknown } | undefined)?.kind
      if (typeof kind === 'string' && kind !== 'human') return 'foreign'
      // Older CLIs echo nothing, so keep the historical rule: the first
      // result ends the turn.
      return 'final'
    }
    // A steer either folds into the running turn (and is echoed with it) or
    // queues behind it as a turn of its own whose result is still coming.
    return this.unanswered.size > 0 ? 'pending' : 'final'
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

function echoedUuids(result: Record<string, unknown>): string[] {
  const uuids = Array.isArray(result.user_message_uuids)
    ? result.user_message_uuids.filter((uuid): uuid is string => typeof uuid === 'string')
    : []
  // user_message_uuids is absent on delivery-failure results and from older
  // producers that only echo the single triggering uuid.
  if (typeof result.user_message_uuid === 'string') uuids.push(result.user_message_uuid)
  return uuids
}
