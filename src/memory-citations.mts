import { readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import type { MemoryCitation, MemoryCitationEntry, RecalledMemory } from './types.mjs'

// A memory file larger than this is cited without being read.
const MEMORY_READ_LIMIT = 256 * 1024
const NOTE_LIMIT = 160

// The agentMessage memoryCitation for the memories Claude recalled in a turn,
// as Codex cites the memories its answer drew on; the App lists the notes
// under the answer. Claude recalls whole memories, so an entry spans all of
// its memory's lines, and there are no Codex rollouts to name in threadIds.
export function memoryCitation(memories: readonly RecalledMemory[]): MemoryCitation | null {
  const seen = new Set<string>()
  const entries: MemoryCitationEntry[] = []
  for (const memory of memories) {
    if (seen.has(memory.path)) continue
    seen.add(memory.path)
    entries.push(citationEntry(memory))
  }
  return entries.length > 0 ? { entries, threadIds: [] } : null
}

function citationEntry(memory: RecalledMemory): MemoryCitationEntry {
  const text = memory.content ?? readMemoryFile(memory.path)
  const lines = text ? text.replace(/\s+$/, '').split('\n').length : 1
  return {
    path: memory.path,
    lineStart: 1,
    lineEnd: Math.max(1, lines),
    note: memoryNote(memory.path, text),
  }
}

function readMemoryFile(path: string): string | null {
  if (!isAbsolute(path)) return null
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MEMORY_READ_LIMIT) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// What the memory holds: the description or name in its frontmatter, else its
// first line of text, else the file's name.
function memoryNote(path: string, text: string | null): string {
  const { fields, body } = splitFrontmatter(text ?? '')
  const note = fields.description || fields.name || firstLine(body) || fileLabel(path)
  const flat = note.replace(/\s+/g, ' ').trim()
  return flat.length > NOTE_LIMIT ? `${flat.slice(0, NOTE_LIMIT - 1).trimEnd()}…` : flat
}

function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!field?.[1]) continue
    fields[field[1]] = (field[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  return { fields, body: text.slice(match[0].length) }
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const words = line.replace(/^\s*(?:#+|[-*>])\s*/, '').trim()
    if (words) return words
  }
  return ''
}

function fileLabel(path: string): string {
  const name = basename(path)
  return name.slice(0, name.length - extname(name).length) || path
}
