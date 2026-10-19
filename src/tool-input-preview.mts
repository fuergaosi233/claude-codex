// Live input of Claude's file tools while the model is still writing it.
//
// With partial messages on, the Agent SDK streams a tool call's input as raw
// JSON fragments (input_json_delta) before the finished tool_use arrives in
// the assistant message. For Edit, Write and MultiEdit that input carries the
// new text of the file, which can take Claude a minute to write. Codex streams
// its own apply_patch input the same way and the App draws the patch as it
// grows (item/fileChange/patchUpdated), so the fragments are parsed as far as
// they go and reported at most once per interval, as Codex buffers its patch
// updates.

export const PREVIEW_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit'])

// Codex's apply_patch updates use the same interval.
export const TOOL_INPUT_PREVIEW_INTERVAL_MS = 500

export interface ToolInputPreview {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

interface InputStream {
  toolUseId: string
  toolName: string
  json: string
  sentAt: number | null
  sent: string
}

// The tool calls of one model response, by content block index.
export class ToolInputPreviews {
  private streams = new Map<number, InputStream>()
  private now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  // A content block opened. Only file tool calls are followed.
  start(index: number, toolUseId: string, toolName: string): void {
    if (!toolUseId || !PREVIEW_TOOLS.has(toolName)) return
    this.streams.set(index, { toolUseId, toolName, json: '', sentAt: null, sent: '' })
  }

  // Adds a fragment of a block's input. Returns the input received so far
  // once it names the file, at most once per interval and only when it grew.
  push(index: number, fragment: string): ToolInputPreview | null {
    const stream = this.streams.get(index)
    if (!stream || !fragment) return null
    stream.json += fragment
    const now = this.now()
    if (stream.sentAt !== null && now - stream.sentAt < TOOL_INPUT_PREVIEW_INTERVAL_MS) return null
    const input = previewInput(stream.json)
    if (!input) return null
    const sent = JSON.stringify(input)
    if (sent === stream.sent) return null
    stream.sentAt = now
    stream.sent = sent
    return { toolUseId: stream.toolUseId, toolName: stream.toolName, input }
  }

  // The block closed; the finished call follows in the assistant message.
  stop(index: number): void {
    this.streams.delete(index)
  }

  // A new model response numbers its blocks from zero again.
  clear(): void {
    this.streams.clear()
  }
}

function previewInput(json: string): Record<string, unknown> | null {
  const { value, openString } = parsePartialJson(json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  // A path Claude is still writing names the wrong file.
  if (typeof input.file_path !== 'string' || !input.file_path) return null
  if (openString?.length === 1 && openString[0] === 'file_path') return null
  return input
}

export interface PartialJson {
  // undefined when no value began.
  value: unknown
  // The keys and indexes down to the string the text breaks off in, or null
  // when it breaks off elsewhere.
  openString: Array<string | number> | null
}

const MISSING = Symbol('missing')

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

const LITERAL = /[^\s,\]}]*/y

// Parses the start of a JSON text as far as it goes, never throwing. A string
// cut short keeps what arrived, without an escape sequence cut in half; an
// object keeps the members that have a value, an array its elements. A number
// or literal the text ends in may still grow, so it is left out. Malformed
// text counts as the end of the input.
export function parsePartialJson(text: string): PartialJson {
  let pos = 0
  let openString: Array<string | number> | null = null
  const path: Array<string | number> = []

  const skipSpace = (): void => {
    while (pos < text.length) {
      const code = text.charCodeAt(pos)
      if (code !== 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) return
      pos += 1
    }
  }

  const parseString = (): { value: string; open: boolean } => {
    pos += 1
    let value = ''
    let start = pos
    while (pos < text.length) {
      const char = text[pos]
      if (char === '"') {
        value += text.slice(start, pos)
        pos += 1
        return { value, open: false }
      }
      if (char !== '\\') {
        pos += 1
        continue
      }
      value += text.slice(start, pos)
      const code = text[pos + 1]
      if (code === undefined) return openAt(value)
      if (code === 'u') {
        const hex = text.slice(pos + 2, pos + 6)
        if (hex.length < 4) return openAt(value)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return malformed(value)
        value += String.fromCharCode(Number.parseInt(hex, 16))
        pos += 6
      } else {
        const decoded = ESCAPES[code]
        if (decoded === undefined) return malformed(value)
        value += decoded
        pos += 2
      }
      start = pos
    }
    return openAt(value + text.slice(start))
  }

  // The text ends inside the string. Half of a surrogate pair is not text yet.
  const openAt = (value: string): { value: string; open: boolean } => {
    pos = text.length
    const last = value.charCodeAt(value.length - 1)
    return { value: last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value, open: true }
  }

  const malformed = (value: string): { value: string; open: boolean } => {
    pos = text.length
    return { value, open: false }
  }

  const parseObject = (): Record<string, unknown> => {
    pos += 1
    const object: Record<string, unknown> = {}
    while (true) {
      skipSpace()
      if (pos >= text.length) return object
      const char = text[pos]
      if (char === '}') {
        pos += 1
        return object
      }
      if (char === ',') {
        pos += 1
        continue
      }
      if (char !== '"') {
        pos = text.length
        return object
      }
      const key = parseString()
      if (key.open) return object
      skipSpace()
      if (text[pos] !== ':') {
        pos = text.length
        return object
      }
      pos += 1
      path.push(key.value)
      const value = parseValue()
      path.pop()
      if (value === MISSING) return object
      // Like JSON.parse, a "__proto__" key is an own property.
      Object.defineProperty(object, key.value, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }

  const parseArray = (): unknown[] => {
    pos += 1
    const array: unknown[] = []
    while (true) {
      skipSpace()
      if (pos >= text.length) return array
      const char = text[pos]
      if (char === ']') {
        pos += 1
        return array
      }
      if (char === ',') {
        pos += 1
        continue
      }
      path.push(array.length)
      const value = parseValue()
      path.pop()
      if (value === MISSING) return array
      array.push(value)
    }
  }

  const parseLiteral = (): unknown => {
    LITERAL.lastIndex = pos
    const token = LITERAL.exec(text)?.[0] ?? ''
    pos += token.length
    if (pos >= text.length) return MISSING
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return Number(token)
    pos = text.length
    return MISSING
  }

  const parseValue = (): unknown => {
    skipSpace()
    if (pos >= text.length) return MISSING
    const char = text[pos]
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    if (char === '"') {
      const string = parseString()
      if (string.open) openString = [...path]
      return string.value
    }
    return parseLiteral()
  }

  const value = parseValue()
  return { value: value === MISSING ? undefined : value, openString }
}
