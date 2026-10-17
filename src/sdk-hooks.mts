import { askRulesGuard } from './ask-rules.mjs'
import { type ClaudeHookSession, claudeHookSession, type SessionOrigin } from './claude-hooks.mjs'
import type { RuntimeTurnContext } from './types.mjs'

// The hook callbacks a Claude session registers with the SDK (its `hooks`
// option). The CLI calls them over the control channel, so they work even
// for a CLI that reads no settings files.

export type HookOutput = Record<string, unknown>
export type HookCallback = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookOutput>
export interface HookMatcher {
  matcher?: string
  hooks: HookCallback[]
  // Seconds.
  timeout?: number
}
export type SdkHooks = Record<string, HookMatcher[]>

export interface SessionHooks {
  // The SDK's `hooks` option, or null for none.
  readonly hooks: SdkHooks | null
  // Runs the user's SessionEnd hooks once the CLI session is over.
  readonly end: ClaudeHookSession['end']
}

// `approvals` says whether the user's hooks may approve a tool call, and
// `origin` is how the CLI session begins.
export function sdkHooks(
  context: RuntimeTurnContext,
  approvals = true,
  origin: SessionOrigin = 'startup',
): SessionHooks {
  const hooks: SdkHooks = {}
  const add = (event: string, matcher: HookMatcher): void => {
    hooks[event] = [...(hooks[event] ?? []), matcher]
  }
  const enabled = context.mcpEnabledTools
  if (enabled && Object.keys(enabled).length > 0) add('PreToolUse', enabledToolsGuard(enabled))
  // The CLI settles on the strictest PreToolUse decision (deny, then ask,
  // then allow), so an ask rule holds even against a hook that approves.
  const ask = context.inheritedAskRules
  if (ask && ask.length > 0) add('PreToolUse', askRulesGuard(ask, context.cwd))
  let end: SessionHooks['end'] = null
  if (context.claudeHooks && context.claudeHooks.length > 0) {
    const claude = claudeHookSession(context.claudeHooks, {
      projectDir: context.cwd,
      approvals,
      origin,
      model: context.model,
    })
    for (const [event, matchers] of Object.entries(claude.hooks))
      for (const matcher of matchers) add(event, matcher)
    end = claude.end
  }
  return { hooks: Object.keys(hooks).length > 0 ? hooks : null, end }
}

// The SDK cannot hide some of a server's tools, so a call to a tool outside
// the server's enabled_tools is refused before it runs.
function enabledToolsGuard(enabled: Record<string, string[]>): HookMatcher {
  return {
    hooks: [
      async (input) => {
        const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
        for (const [prefix, tools] of Object.entries(enabled)) {
          if (!tool.startsWith(prefix) || tools.includes(tool)) continue
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `${tool} is not among the tools the Codex config enables for this MCP server.`,
            },
          }
        }
        return {}
      },
    ],
  }
}
