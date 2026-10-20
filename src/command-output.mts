import { debugLog } from './util.mjs'

// Live output of Claude's Bash commands. The Claude CLI writes a running
// command's output to a file of its own and answers the SDK's get_task_output
// control request with that file's tail: the last few KiB, the total byte
// count, and whether the tail is cut. Polling it turns into output deltas for
// the command's item.
//
// A command becomes a task the CLI can report on when it runs in the
// background, or after about two seconds in the foreground. Its task_started
// names the Bash call by tool_use id, so output only ever goes to the call
// that produced it; a call two tasks claim gets none. Anything unexpected (no
// get_task_output in the SDK, a failed read, output that is not UTF-8, a file
// that shrank) quietly ends that command's stream, and it shows its output
// when it finishes, as it did before.

// How often a running command's output is read.
export const COMMAND_OUTPUT_POLL_MS = 1_000
// How long one read may take before the stream gives up.
const READ_TIMEOUT_MS = 5_000
// Answered Bash calls kept while their background task_started may still come.
const MAX_BACKGROUND_CALLS = 16
const REPLACEMENT = '\uFFFD'
// Stands in for output that came and went between two reads.
export const SKIPPED_OUTPUT = '[earlier output skipped]\n'
// The App keeps the last this many characters of a command's output, after
// this marker.
const OUTPUT_MAX_CHARS = 20_000
const OUTPUT_TRUNCATED = '[output truncated]\n'

export interface TaskOutputTail {
  output: string
  totalBytes: number
  truncated: boolean
}

export type TailStep =
  | { readonly kind: 'wait' }
  | { readonly kind: 'stop'; readonly reason: string }
  | {
      readonly kind: 'emit'
      readonly delta: string
      readonly consumed: number
      // Output between the last read and this tail is missing.
      readonly skipped: boolean
    }

export function parseTaskOutput(value: unknown): TaskOutputTail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { output, total_bytes: totalBytes, truncated } = value as Record<string, unknown>
  if (typeof output !== 'string' || typeof truncated !== 'boolean') return null
  if (typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0)
    return null
  return { output, totalBytes, truncated }
}

// What a tail adds to the `consumed` bytes already shown. Offsets count
// back from the end of the tail, which is the end of the file.
export function nextOutputDelta(consumed: number, tail: TaskOutputTail): TailStep {
  const { totalBytes, truncated } = tail
  if (totalBytes < consumed) return { kind: 'stop', reason: 'output_shrank' }
  if (totalBytes === consumed) return { kind: 'wait' }
  let text = tail.output
  // A tail cut inside a character starts with its last bytes, each decoded
  // as U+FFFD.
  if (truncated) text = text.replace(/^\uFFFD{1,3}/, '')
  // The last character may still be partly written.
  if (text.endsWith(REPLACEMENT)) return { kind: 'wait' }
  const bytes = Buffer.from(text, 'utf8')
  // Bytes that are not UTF-8 do not survive decoding, and offsets into the
  // output stop lining up.
  if (!truncated && bytes.length !== totalBytes) return { kind: 'stop', reason: 'not_utf8' }
  const fresh = totalBytes - consumed
  if (fresh <= bytes.length) {
    const delta = bytes.subarray(bytes.length - fresh).toString('utf8')
    if (truncated && delta.includes(REPLACEMENT)) return { kind: 'stop', reason: 'not_utf8' }
    return { kind: 'emit', delta, consumed: totalBytes, skipped: false }
  }
  // More arrived than the tail holds: show its whole lines.
  if (text.includes(REPLACEMENT)) return { kind: 'stop', reason: 'not_utf8' }
  const newline = text.indexOf('\n')
  const delta = newline >= 0 && newline < text.length - 1 ? text.slice(newline + 1) : text
  return { kind: 'emit', delta, consumed: totalBytes, skipped: true }
}

// A command item's output with `delta` appended, cut the way the App cuts it
// so a reloaded thread shows what the live one did.
export function appendCommandOutput(current: string | null, delta: string): string {
  const previous = current ?? ''
  const kept = previous.startsWith(OUTPUT_TRUNCATED)
    ? previous.slice(OUTPUT_TRUNCATED.length)
    : previous
  const joined = `${kept}${delta}`
  if (joined.length <= OUTPUT_MAX_CHARS && kept === previous) return joined
  return `${OUTPUT_TRUNCATED}${joined.slice(-OUTPUT_MAX_CHARS)}`
}

// Where a command's output goes.
export interface OutputSink {
  // Whether the output still has somewhere to go.
  live(): boolean
  emit(delta: string): Promise<void> | void
}

export type BackgroundSink = (taskId: string) => OutputSink

interface CommandStream {
  readonly taskId: string
  readonly toolUseId: string
  sink: OutputSink | null
  // Its output follows the call's result, outside any turn.
  background: boolean
  // The CLI runs it in the background.
  backgrounded: boolean
  consumed: number
  lastChar: string
  // The next output starts on a line of its own.
  separate: boolean
  // Bumped on every new sink; a read started for an older one is dropped.
  generation: number
  timer: NodeJS.Timeout | null
  polling: Promise<void> | null
  // The task ended: one last read, then no more.
  ending: Promise<void> | null
  done: boolean
}

// The commands of one Claude session.
export class CommandOutputs {
  private readonly read: ((taskId: string) => Promise<unknown>) | null
  private readonly intervalMs: number
  private readonly readTimeoutMs: number
  // Bash calls of the main loop still waiting for their result.
  private readonly calls = new Map<string, OutputSink>()
  // Answered calls whose background task_started has not arrived yet.
  private readonly backgroundCalls = new Map<string, BackgroundSink>()
  private readonly streams = new Map<string, CommandStream>()
  private readonly taskByCall = new Map<string, string>()
  // Calls more than one task claimed.
  private readonly ambiguous = new Set<string>()
  private closed = false

  constructor(
    read: ((taskId: string) => Promise<unknown>) | null,
    intervalMs: number = COMMAND_OUTPUT_POLL_MS,
    readTimeoutMs: number = READ_TIMEOUT_MS,
  ) {
    this.read = read
    this.intervalMs = intervalMs
    this.readTimeoutMs = readTimeoutMs
  }

  // A Bash call of the main loop; until its result, its output goes to `sink`.
  call(toolUseId: string, sink: OutputSink): void {
    if (!this.enabled()) return
    for (const [id, other] of this.calls) if (!other.live()) this.calls.delete(id)
    this.calls.set(toolUseId, sink)
  }

  taskStarted(taskId: string, toolUseId: string | null, backgrounded: boolean | null): void {
    if (!this.enabled() || !toolUseId || this.streams.has(taskId)) return
    const claimed = this.taskByCall.get(toolUseId)
    if (claimed !== undefined || this.ambiguous.has(toolUseId)) {
      // Two tasks name one call: neither one's output can be told apart.
      const stream = claimed === undefined ? undefined : this.streams.get(claimed)
      if (stream) this.giveUp(stream, 'ambiguous_call')
      this.ambiguous.add(toolUseId)
      return
    }
    const sink = this.calls.get(toolUseId)
    const later = backgrounded === true ? this.backgroundCalls.get(toolUseId) : undefined
    if (!sink && !later) return
    const stream: CommandStream = {
      taskId,
      toolUseId,
      sink: null,
      background: false,
      backgrounded: backgrounded === true,
      consumed: 0,
      lastChar: '',
      separate: false,
      generation: 0,
      timer: null,
      polling: null,
      ending: null,
      done: false,
    }
    this.streams.set(taskId, stream)
    this.taskByCall.set(toolUseId, taskId)
    if (sink) {
      // A background call returns at once; its output follows the result.
      if (!stream.backgrounded) this.resume(stream, sink, false)
      return
    }
    this.backgroundCalls.delete(toolUseId)
    if (later) this.resume(stream, later(taskId), true)
  }

  // The CLI moved the task to the background.
  taskBackgrounded(taskId: string): void {
    const stream = this.streams.get(taskId)
    if (stream) stream.backgrounded = true
  }

  // The call's result arrived. Its command is over unless it goes on in the
  // background, where `background` (null when nothing can show it) takes its
  // output. `live` tells whether the CLI still runs a task.
  callEnded(
    toolUseId: string,
    background: BackgroundSink | null,
    live: (taskId: string) => boolean,
  ): void {
    this.calls.delete(toolUseId)
    const ambiguous = this.ambiguous.delete(toolUseId)
    const taskId = this.taskByCall.get(toolUseId)
    const stream = taskId === undefined ? undefined : this.streams.get(taskId)
    // Already answered.
    if (stream?.background) return
    if (!stream) {
      if (background && !ambiguous && this.enabled()) {
        this.backgroundCalls.set(toolUseId, background)
        if (this.backgroundCalls.size > MAX_BACKGROUND_CALLS) {
          const oldest = this.backgroundCalls.keys().next().value
          if (oldest !== undefined) this.backgroundCalls.delete(oldest)
        }
      }
      return
    }
    if (background && !stream.done && (stream.backgrounded || live(stream.taskId))) {
      // The call's result replaced what its item showed. The shell's output
      // follows it, from the start.
      this.resume(stream, background(stream.taskId), true)
      return
    }
    this.remove(stream)
  }

  // The task stopped running. A background shell's output is read once more
  // for what it printed last.
  taskEnded(taskId: string): void {
    const stream = this.streams.get(taskId)
    if (!stream) return
    if (!stream.background) {
      // The call's result brings all of a foreground command's output.
      this.giveUp(stream, null)
      return
    }
    stream.ending ??= this.lastRead(stream)
  }

  // Claude was told the task ended. `note` (how it ended) follows a
  // background shell's output.
  taskNotified(taskId: string, note: string | null): void {
    const stream = this.streams.get(taskId)
    if (!stream) return
    if (!stream.background) {
      this.giveUp(stream, null)
      return
    }
    const ending = (stream.ending ??= this.lastRead(stream))
    this.remove(stream, false)
    void ending.then(async () => {
      const sink = stream.sink
      if (note && !stream.done && sink?.live()) {
        const newline = !stream.separate && stream.lastChar !== '' && stream.lastChar !== '\n'
        await this.emit(stream, sink, `${newline ? '\n' : ''}[${note}]\n`)
      }
      this.stop(stream)
    })
  }

  close(): void {
    this.closed = true
    for (const stream of this.streams.values()) this.stop(stream)
    this.streams.clear()
    this.calls.clear()
    this.backgroundCalls.clear()
    this.taskByCall.clear()
    this.ambiguous.clear()
  }

  private enabled(): boolean {
    return this.read !== null && this.intervalMs > 0 && !this.closed
  }

  private resume(stream: CommandStream, sink: OutputSink, background: boolean): void {
    stream.generation += 1
    stream.sink = sink
    stream.background = background
    if (background) {
      stream.consumed = 0
      stream.lastChar = ''
      stream.separate = true
    }
    this.schedule(stream, 0)
  }

  // One read at a time: the next is scheduled when the latest one is done.
  private schedule(stream: CommandStream, delayMs: number): void {
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = setTimeout(() => {
      stream.timer = null
      const polling: Promise<void> = this.poll(stream).finally(() => {
        if (stream.polling !== polling) return
        stream.polling = null
        if (!stream.done && !stream.ending && !this.closed) this.schedule(stream, this.intervalMs)
      })
      stream.polling = polling
    }, delayMs)
    stream.timer.unref?.()
  }

  private lastRead(stream: CommandStream): Promise<void> {
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = null
    const polling = stream.polling
    return (async () => {
      if (polling) await polling.catch(() => {})
      if (!stream.done) await this.poll(stream)
    })()
  }

  private async poll(stream: CommandStream): Promise<void> {
    const sink = stream.sink
    const read = this.read
    if (stream.done || !sink || !read) return
    if (!sink.live()) {
      this.giveUp(stream, null)
      return
    }
    const generation = stream.generation
    let value: unknown
    try {
      value = await within(read(stream.taskId), this.readTimeoutMs)
    } catch (error) {
      if (stream.generation === generation) this.giveUp(stream, 'read_failed', error)
      return
    }
    if (stream.done || stream.generation !== generation || !sink.live()) return
    const tail = parseTaskOutput(value)
    if (!tail) {
      this.giveUp(stream, 'unexpected_response')
      return
    }
    const step = nextOutputDelta(stream.consumed, tail)
    if (step.kind === 'wait') return
    if (step.kind === 'stop') {
      this.giveUp(stream, step.reason)
      return
    }
    stream.consumed = step.consumed
    const newline = stream.lastChar !== '' && stream.lastChar !== '\n'
    const text = step.skipped ? `${newline ? '\n' : ''}${SKIPPED_OUTPUT}${step.delta}` : step.delta
    await this.emit(stream, sink, text)
  }

  private async emit(stream: CommandStream, sink: OutputSink, text: string): Promise<void> {
    if (!text) return
    const delta = stream.separate ? `\n${text}` : text
    stream.separate = false
    stream.lastChar = delta.slice(-1)
    try {
      await sink.emit(delta)
    } catch (error) {
      this.giveUp(stream, 'emit_failed', error)
    }
  }

  // No more output from this stream. `reason` says why when it is not the
  // ordinary end of the command.
  private giveUp(stream: CommandStream, reason: string | null, error?: unknown): void {
    if (stream.done) return
    if (reason)
      debugLog('native.command_output.stopped', {
        taskId: stream.taskId,
        toolUseId: stream.toolUseId,
        reason,
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      })
    this.stop(stream)
  }

  private stop(stream: CommandStream): void {
    stream.done = true
    if (stream.timer) clearTimeout(stream.timer)
    stream.timer = null
  }

  private remove(stream: CommandStream, stop = true): void {
    if (stop) this.stop(stream)
    if (this.streams.get(stream.taskId) === stream) this.streams.delete(stream.taskId)
    if (this.taskByCall.get(stream.toolUseId) === stream.taskId)
      this.taskByCall.delete(stream.toolUseId)
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
