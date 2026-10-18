// Visualize lines: the Codex App renders an inline visualization from a line
// holding `visualize` and its JSON between private-use marks, the way its
// visualize skill documents it. The marks are invisible, so Claude sometimes
// writes the line without them and the App shows it as plain text. The
// adapter adds them when an agent message completes. The App replaces the
// streamed text with the completed item, so deltas keep the line as written.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/
const PLAIN_LINE = /^( {0,3})visualize(\{.*\})[ \t]*$/

// The text with the marks added to every unmarked visualize line outside code
// fences, or the same string when there is none. The JSON only has to name a
// path; the App checks the rest itself and shows what it rejects as text.
// App rule: visualize-line
export function markVisualizeLines(text: string): string {
  if (!text.includes('visualize{')) return text
  const lines = text.split('\n')
  let fence: { char: string; length: number } | null = null
  let changed = false
  for (const [index, raw] of lines.entries()) {
    // A CRLF line keeps its \r.
    const cr = raw.endsWith('\r') ? '\r' : ''
    const line = cr ? raw.slice(0, -1) : raw
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1]
      if (close?.[0] === fence.char && close.length >= fence.length) fence = null
      continue
    }
    const open = FENCE_OPEN.exec(line)?.[1]
    if (open) {
      fence = { char: open.charAt(0), length: open.length }
      continue
    }
    const match = PLAIN_LINE.exec(line)
    const [, indent = '', json = ''] = match ?? []
    if (!match || !namesPath(json)) continue
    lines[index] = `${indent}\uE200visualize\uE202${json}\uE201${cr}`
    changed = true
  }
  return changed ? lines.join('\n') : text
}

function namesPath(json: string): boolean {
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const path = (value as Record<string, unknown>).path
    return typeof path === 'string' && path !== ''
  } catch {
    return false
  }
}
