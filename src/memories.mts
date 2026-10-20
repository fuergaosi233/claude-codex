// Codex memories on Claude threads. Codex distills past chats into memories
// of its own; Claude Code has auto-memory instead: notes it keeps per project
// under its config folder, reads when a session starts and updates as it
// works. With CLAUDE_CODEX_MEMORIES=1 the App's memories switches drive that.
// As in Codex, the feature is then off until the user turns it on (Settings >
// Personalization), and each thread carries its own mode, which picks whether
// its sessions run with auto-memory. Without the switch the adapter lists no
// memories feature and leaves auto-memory to Claude Code's own settings.
// App rule: memories-settings

export const MEMORIES_FEATURE = 'memories'

// Whether the App's memories settings drive Claude Code's auto-memory. Off
// unless CLAUDE_CODEX_MEMORIES=1, because turning the mapping on changes what
// every App chat remembers: the App sets the feature off when it connects.
export function memoriesMappingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODEX_MEMORIES === '1'
}

export type MemoryMode = 'enabled' | 'disabled'

// The Codex feature list entry. The App shows its memories settings, and the
// /memories command, only for a listed feature.
export function memoriesFeature(enabled: boolean): Record<string, unknown> {
  return {
    name: MEMORIES_FEATURE,
    stage: 'beta',
    displayName: 'Memories',
    description:
      "Let Claude Code keep notes on each project with its auto-memory, and recall them in later chats. The notes live in Claude Code's own per-project memory folders.",
    announcement: null,
    enabled,
    defaultEnabled: false,
  }
}

// experimentalFeature/list, paged the way Codex pages its feature flags.
export function experimentalFeatureList(
  memories: boolean,
  params: Record<string, unknown>,
): { data: Array<Record<string, unknown>>; nextCursor: string | null } {
  const features = [memoriesFeature(memories)]
  const start = params.cursor == null ? 0 : Number(params.cursor)
  if (!Number.isInteger(start) || start < 0)
    throw new Error(`invalid cursor: ${String(params.cursor)}`)
  if (start > features.length)
    throw new Error(`cursor ${start} exceeds total feature flags ${features.length}`)
  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : features.length
  const end = Math.min(features.length, start + limit)
  return {
    data: features.slice(start, end),
    nextCursor: end < features.length ? String(end) : null,
  }
}

// memory/status. Claude Code never consolidates chats into Codex memories, so
// none are ever ready; the bounds on minConsolidatedThreads are Codex's.
export function memoryStatus(params: Record<string, unknown>): {
  v2ConsolidatedThreads: number
  v2Ready: boolean
} {
  const minimum = params.minConsolidatedThreads ?? 20
  if (typeof minimum !== 'number' || !Number.isInteger(minimum) || minimum < 1 || minimum > 4096)
    throw new Error('minConsolidatedThreads must be between 1 and 4096')
  return { v2ConsolidatedThreads: 0, v2Ready: false }
}

// A value of the App's config, written as a dotted key path (the adapter
// keeps those flat) or inside a table.
function configValue(config: Record<string, unknown>, table: string, key: string): unknown {
  const flat = config[`${table}.${key}`]
  if (flat !== undefined) return flat
  const nested = config[table]
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)[key]
    : undefined
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

// Whether the feature is on. The user's config wins over what the App sets for
// the connection with experimentalFeature/enablement/set, as in Codex.
export function memoriesEnabled(
  config: Record<string, unknown>,
  connectionDefault: boolean | null,
): boolean {
  const configured = configValue(config, 'features', MEMORIES_FEATURE)
  if (typeof configured === 'boolean') return configured
  return connectionDefault ?? false
}

// The [memories] table the App reads its switches from, with the keys it
// writes. Codex defaults both generate_memories and use_memories to true.
export function memoriesConfigTable(config: Record<string, unknown>): Record<string, unknown> {
  const table: Record<string, unknown> = {}
  for (const key of [
    'generate_memories',
    'use_memories',
    'disable_on_external_context',
    'no_memories_if_mcp_or_web_search',
  ]) {
    const value = configValue(config, 'memories', key)
    if (value !== undefined && value !== null) table[key] = value
  }
  return table
}

// The mode of a new thread: from the memories.* overrides of its thread/start
// (the App's per-chat switches) over the user's config. Claude Code reads and
// writes its memory as one switch, so the thread gets it only when both
// generating and using memories are on.
export function newThreadMemoryMode(
  overrides: Record<string, unknown>,
  config: Record<string, unknown>,
): MemoryMode {
  const setting = (key: string) =>
    booleanOr(
      configValue(overrides, 'memories', key),
      booleanOr(configValue(config, 'memories', key), true),
    )
  return setting('generate_memories') && setting('use_memories') ? 'enabled' : 'disabled'
}

export function parseMemoryMode(value: unknown): MemoryMode | null {
  return value === 'enabled' || value === 'disabled' ? value : null
}

// The CLI environment for a session. Auto-memory is on in Claude Code unless
// something turns it off, so a session the mapping keeps from it gets
// CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, even over a value the user exported. This
// avoids --settings, which pinned launchers reject. A session with it, or one
// the mapping has no say over (undefined: the switch is off), adds nothing, so
// Claude Code's own autoMemoryEnabled setting, or the variable set to turn it
// off, still wins.
export function autoMemoryEnv(autoMemory: boolean | undefined): Record<string, string> {
  return autoMemory === false ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}
}
