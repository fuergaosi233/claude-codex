import { open } from 'node:fs/promises'

// A background local_agent task reports back through a task_notification
// that carries only a one-line summary. Its real report is the last assistant
// message of the sidechain transcript, which the notification's output_file
// points at (a symlink to subagents/agent-<id>.jsonl). Only the tail matters,
// so long transcripts are read from their last few MiB.

const MAX_TAIL_BYTES = 4 * 1024 * 1024

export async function readTaskResult(outputFile: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(outputFile, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return null
    const length = Math.min(size, MAX_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    // A partial first line of a truncated tail is not valid JSON; it is
    // skipped along with anything else that does not parse. One model
    // response is written as one line per content block, so the blocks that
    // share the final response's id are joined back together.
    let finalId: unknown
    const parts: string[] = []
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]?.trim()
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const message = recordOrNull(recordOrNull(parsed)?.message)
      if (message?.role !== 'assistant') {
        if (parts.length > 0) break
        continue
      }
      if (parts.length > 0 && (finalId === undefined || message.id !== finalId)) break
      const text = messageText(message.content)
      if (!text) continue
      if (parts.length === 0) finalId = message.id
      parts.unshift(text)
    }
    return parts.length > 0 ? parts.join('\n') : null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => {
      const record = recordOrNull(block)
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
