import type { ClaudePermissionUpdate, PermissionDecision } from './types.mjs'

// The permission changes Claude Code offers with an approval: the "don't ask
// again" choices of its own prompt, as rules for the project's local
// settings or as rules and folders for the session. The App's approval cards
// offer them as Codex offers its own:
//
// - "Allow similar commands" on a command card shows the command prefix of
//   the one rule Claude offers to save for a shell command (a Codex
//   execpolicy amendment), and "Always allow" on an MCP tool card saves a
//   rule naming that tool. Claude Code writes the rule itself, always to the
//   project's .claude/settings.local.json, whichever settings file it
//   suggested: nothing goes to the user's settings or the checked-in ones.
// - "Allow for this session" adds what Claude offers for the session, but
//   no switch of permission mode, which stays the App's to make.
//
// Nothing is saved unless the user picks one of the first two.

const SAVED_DESTINATIONS = new Set(['localSettings', 'projectSettings', 'userSettings'])

// Claude's suggestions as the Agent SDK hands them over, the well-formed ones.
export function permissionSuggestions(value: unknown): ClaudePermissionUpdate[] {
  if (!Array.isArray(value)) return []
  return value.filter((update): update is ClaudePermissionUpdate => {
    if (!update || typeof update !== 'object') return false
    const fields = update as Record<string, unknown>
    return typeof fields.type === 'string' && typeof fields.destination === 'string'
  })
}

// The allow rules Claude offers to save, as one addition to the project's
// local settings.
export function savedAllowRules(
  suggestions: ClaudePermissionUpdate[] | null | undefined,
): ClaudePermissionUpdate | null {
  const rules = (suggestions ?? []).flatMap((update) =>
    update.type === 'addRules' &&
    update.behavior === 'allow' &&
    SAVED_DESTINATIONS.has(update.destination) &&
    Array.isArray(update.rules)
      ? update.rules.filter((rule) => typeof rule?.toolName === 'string' && rule.toolName !== '')
      : [],
  )
  if (rules.length === 0) return null
  return {
    type: 'addRules',
    rules: rules.map((rule) =>
      typeof rule.ruleContent === 'string'
        ? { toolName: rule.toolName, ruleContent: rule.ruleContent }
        : { toolName: rule.toolName },
    ),
    behavior: 'allow',
    destination: 'localSettings',
  }
}

// The command prefix "Allow similar commands" shows for the rules to save:
// the words of their one Bash rule. A prefix rule gives the words before its
// wildcard, `npm test *` (or the older `npm test:*`) giving ["npm", "test"]
// as Codex splits a prefix; a rule for the exact command gives all its
// words, and covers less than the card says, never more. The App offers the
// choice for any prefix it gets, so anything else gets none: several rules (a
// compound command line), a wildcard elsewhere, a line break, no words.
export function savedCommandPrefix(update: ClaudePermissionUpdate | null): string[] | null {
  const rules = update?.rules ?? []
  const rule = rules.length === 1 ? rules[0] : undefined
  if (rule?.toolName !== 'Bash' || typeof rule.ruleContent !== 'string') return null
  return bashRulePrefix(rule.ruleContent)
}

export function bashRulePrefix(content: string): string[] | null {
  if (/[\r\n]/.test(content)) return null
  const prefix = content.trim().replace(/(?::\*|\s+\*)$/, '')
  if (prefix.includes('*')) return null
  const words = prefix.split(/\s+/).filter(Boolean)
  return words.length > 0 ? words : null
}

// What "Allow for this session" adds: the rules and folders Claude offers for
// the session. Claude's "allow all edits during this session" switches the
// session's permission mode instead; the thread's mode is the App's to set,
// so that one is left out.
export function sessionPermissionUpdates(
  suggestions: ClaudePermissionUpdate[] | null | undefined,
): ClaudePermissionUpdate[] {
  return (suggestions ?? []).filter(
    (update) =>
      update.destination === 'session' &&
      ((update.type === 'addRules' && update.behavior === 'allow') ||
        update.type === 'addDirectories'),
  )
}

// The answer "Allow for this session" gives Claude Code.
export function sessionApproval(
  suggestions: ClaudePermissionUpdate[] | null | undefined,
): PermissionDecision {
  const updatedPermissions = sessionPermissionUpdates(suggestions)
  return updatedPermissions.length > 0
    ? { decision: 'acceptForSession', updatedPermissions }
    : { decision: 'acceptForSession' }
}

// "Always allow" for an MCP tool saves a rule naming the tool by the full
// name Claude calls it by, mcp__<server>__<tool>. Claude Code matches the
// server name of a rule exactly, so the rule for server `git` covers neither
// `github` nor `git__hub`, and it covers no other tool of the server.
export function mcpToolAllowRule(toolName: string): ClaudePermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName }],
    behavior: 'allow',
    destination: 'localSettings',
  }
}

// The changes Claude Code is let apply, whatever asked for them: to the
// project's local settings and the session, nowhere else.
export function appliedPermissionUpdates(
  updates: ClaudePermissionUpdate[] | null | undefined,
): ClaudePermissionUpdate[] {
  return (updates ?? []).filter(
    (update) => update.destination === 'localSettings' || update.destination === 'session',
  )
}
