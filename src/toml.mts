// A TOML reader for the Codex config file, so Claude threads can follow the
// settings in it without a TOML dependency. It covers the TOML 1.0 grammar
// Codex writes and reads: tables, arrays of tables, dotted and quoted keys,
// every string form, numbers, booleans, arrays and inline tables. Dates and
// times come back as their source text; nothing here needs them parsed.

type Table = Record<string, unknown>

export function parseToml(source: string): Table {
  const text = source.replace(/^\uFEFF/, '')
  const root: Table = {}
  // Arrays made by [[headers]], the only arrays a header may extend.
  const tableArrays = new Set<unknown[]>()
  let pos = 0
  let current = root

  const fail = (message: string): never => {
    const line = text.slice(0, pos).split('\n').length
    throw new Error(`TOML line ${line}: ${message}`)
  }
  const skipSpaces = (): void => {
    while (text[pos] === ' ' || text[pos] === '\t') pos++
  }
  const skipComment = (): void => {
    if (text[pos] !== '#') return
    while (pos < text.length && text[pos] !== '\n') pos++
  }
  // Spaces, comments and newlines, as arrays and inline tables allow.
  const skipBlank = (): void => {
    for (;;) {
      skipSpaces()
      skipComment()
      if (text[pos] === '\n') pos++
      else if (text[pos] === '\r' && text[pos + 1] === '\n') pos += 2
      else return
    }
  }
  const endOfLine = (): void => {
    skipSpaces()
    skipComment()
    if (pos >= text.length) return
    if (text[pos] === '\n') pos++
    else if (text[pos] === '\r' && text[pos + 1] === '\n') pos += 2
    else fail(`unexpected ${JSON.stringify(text[pos])}`)
  }

  const key = (): string => {
    const ch = text[pos]
    if (ch === '"') return basicString()
    if (ch === "'") return literalString()
    const start = pos
    while (pos < text.length && /[A-Za-z0-9_-]/.test(text[pos] ?? '')) pos++
    if (pos === start) fail('expected a key')
    return text.slice(start, pos)
  }
  const keyPath = (): string[] => {
    const path = [key()]
    for (;;) {
      skipSpaces()
      if (text[pos] !== '.') return path
      pos++
      skipSpaces()
      path.push(key())
    }
  }

  const escapeSequence = (): string => {
    const ch = text[pos++]
    const simple: Record<string, string> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      e: '\x1b',
      '"': '"',
      '\\': '\\',
    }
    if (ch && Object.hasOwn(simple, ch)) return simple[ch] ?? ''
    const width = ch === 'x' ? 2 : ch === 'u' ? 4 : ch === 'U' ? 8 : 0
    if (width === 0) fail(`invalid escape \\${ch ?? ''}`)
    const hex = text.slice(pos, pos + width)
    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) fail('invalid unicode escape')
    pos += width
    return String.fromCodePoint(Number.parseInt(hex, 16))
  }
  const basicString = (): string => {
    pos++
    let out = ''
    for (;;) {
      const ch = text[pos]
      if (ch === undefined || ch === '\n') fail('unterminated string')
      pos++
      if (ch === '"') return out
      out += ch === '\\' ? escapeSequence() : ch
    }
  }
  const literalString = (): string => {
    pos++
    const end = text.indexOf("'", pos)
    const newline = text.indexOf('\n', pos)
    if (end < 0 || (newline >= 0 && newline < end)) fail('unterminated string')
    const out = text.slice(pos, end)
    pos = end + 1
    return out
  }
  // """ or ''' strings: a newline right after the opening is dropped, and up
  // to two quotes before the closing ones belong to the string.
  const multilineString = (quote: '"' | "'"): string => {
    pos += 3
    if (text[pos] === '\n') pos++
    else if (text[pos] === '\r' && text[pos + 1] === '\n') pos += 2
    let out = ''
    for (;;) {
      if (pos >= text.length) fail('unterminated string')
      if (text.startsWith(quote.repeat(3), pos)) {
        let run = 3
        while (text[pos + run] === quote && run < 5) run++
        out += quote.repeat(run - 3)
        pos += run
        return out
      }
      const ch = text[pos++]
      if (quote === '"' && ch === '\\') {
        // A backslash ending a line trims the whitespace that follows.
        const rest = /^[ \t]*\r?\n/.exec(text.slice(pos))
        if (rest) {
          pos += rest[0].length
          while (/[ \t\r\n]/.test(text[pos] ?? '')) pos++
        } else out += escapeSequence()
      } else out += ch
    }
  }

  const scalar = (): unknown => {
    const start = pos
    while (pos < text.length && /[0-9A-Za-z_:.+-]/.test(text[pos] ?? '')) pos++
    // A date and a time may be split by one space.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, pos)) && /^ \d/.test(text.slice(pos))) {
      pos++
      while (pos < text.length && /[0-9A-Za-z_:.+-]/.test(text[pos] ?? '')) pos++
    }
    const token = text.slice(start, pos)
    if (token === 'true') return true
    if (token === 'false') return false
    if (/^[+-]?inf$/.test(token)) return token.startsWith('-') ? -Infinity : Infinity
    if (/^[+-]?nan$/.test(token)) return Number.NaN
    const digits = token.replace(/_/g, '')
    const radix = /^0([xob])/.exec(digits)?.[1]
    if (radix) {
      const value = Number.parseInt(digits.slice(2), radix === 'x' ? 16 : radix === 'o' ? 8 : 2)
      if (!Number.isNaN(value)) return value
    }
    if (/^[+-]?\d+$/.test(digits)) return Number(digits)
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(digits)) return Number(digits)
    if (/^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2})/.test(token)) return token
    return fail(`invalid value ${JSON.stringify(token || text[pos] || '')}`)
  }

  const value = (): unknown => {
    const ch = text[pos]
    if (text.startsWith('"""', pos)) return multilineString('"')
    if (text.startsWith("'''", pos)) return multilineString("'")
    if (ch === '"') return basicString()
    if (ch === "'") return literalString()
    if (ch === '[') {
      pos++
      const items: unknown[] = []
      for (;;) {
        skipBlank()
        if (text[pos] === ']') break
        items.push(value())
        skipBlank()
        if (text[pos] === ',') pos++
        else if (text[pos] !== ']') fail('expected , or ] in array')
      }
      pos++
      return items
    }
    if (ch === '{') {
      pos++
      const table: Table = {}
      for (;;) {
        skipBlank()
        if (text[pos] === '}') break
        keyValue(table)
        skipBlank()
        if (text[pos] === ',') pos++
        else if (text[pos] !== '}') fail('expected , or } in inline table')
      }
      pos++
      return table
    }
    return scalar()
  }

  // The table `path` names under `base`, made on the way when missing. A
  // [[header]] array stands for its last table.
  const tableAt = (base: Table, path: readonly string[]): Table => {
    let table = base
    for (const part of path) {
      let next = Object.hasOwn(table, part) ? table[part] : undefined
      if (next === undefined) {
        next = {}
        setKey(table, part, next)
      }
      if (Array.isArray(next) && tableArrays.has(next)) next = next[next.length - 1]
      if (!isTable(next)) fail(`${part} is not a table`)
      table = next as Table
    }
    return table
  }
  function keyValue(table: Table): void {
    const path = keyPath()
    skipSpaces()
    if (text[pos] !== '=') fail('expected =')
    pos++
    skipSpaces()
    const last = path[path.length - 1] ?? ''
    const parent = tableAt(table, path.slice(0, -1))
    if (Object.hasOwn(parent, last)) fail(`duplicate key ${last}`)
    setKey(parent, last, value())
  }
  const header = (): void => {
    const many = text.startsWith('[[', pos)
    pos += many ? 2 : 1
    skipSpaces()
    const path = keyPath()
    skipSpaces()
    if (!text.startsWith(many ? ']]' : ']', pos)) fail('unterminated table header')
    pos += many ? 2 : 1
    const last = path[path.length - 1] ?? ''
    const parent = tableAt(root, path.slice(0, -1))
    if (!many) {
      current = tableAt(parent, [last])
      return
    }
    let list = Object.hasOwn(parent, last) ? parent[last] : undefined
    if (list === undefined) {
      list = []
      tableArrays.add(list as unknown[])
      setKey(parent, last, list)
    }
    if (!Array.isArray(list) || !tableArrays.has(list)) fail(`${last} is not an array of tables`)
    const table: Table = {}
    ;(list as unknown[]).push(table)
    current = table
  }

  for (;;) {
    skipBlank()
    if (pos >= text.length) return root
    if (text[pos] === '[') header()
    else keyValue(current)
    endOfLine()
  }
}

function isTable(value: unknown): value is Table {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

// Keys come from the file, so "__proto__" must stay an ordinary key.
function setKey(table: Table, key: string, value: unknown): void {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true })
}
