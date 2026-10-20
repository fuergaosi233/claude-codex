// Codex's model_auto_compact_token_limit on Claude threads. Codex compacts a
// conversation once it holds that many tokens; Claude Code compacts when the
// conversation nears its auto-compact window, a little before the window is
// full so the summary fits. The limit becomes that window, through
// CLAUDE_CODE_AUTO_COMPACT_WINDOW, which wins over the window in the user's
// Claude Code settings. Without the key nothing is set and Claude Code keeps
// its own window.

export const AUTO_COMPACT_KEY = 'model_auto_compact_token_limit'

// The windows Claude Code accepts; it clamps any other value to this range.
const MIN_WINDOW = 100_000
const MAX_WINDOW = 1_000_000

// A limit as Codex takes it, a positive whole number of tokens; anything else
// counts as unset.
export function autoCompactTokenLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

// The window for the first of the sources that sets a limit, in the range
// Claude Code accepts. Null when none does.
export function autoCompactWindow(...sources: unknown[]): number | null {
  for (const source of sources) {
    const limit = autoCompactTokenLimit(source)
    if (limit != null) return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, limit))
  }
  return null
}

// The CLI environment for a session's window. This avoids --settings, which
// pinned launchers reject.
export function autoCompactWindowEnv(window: number | null | undefined): Record<string, string> {
  return window ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) } : {}
}
