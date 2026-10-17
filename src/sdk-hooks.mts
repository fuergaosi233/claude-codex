import { claudeHookMatchers } from './claude-hooks.mjs'
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

// `approvals` says whether the user's hooks may approve a tool call.
export function sdkHooks(context: RuntimeTurnContext, approvals = true): SdkHooks | null {
  const hooks: SdkHooks = {}
  const add = (event: string, matcher: HookMatcher): void => {
    hooks[event] = [...(hooks[event] ?? []), matcher]
  }
  const enabled = context.mcpEnabledTools
  if (enabled && Object.keys(enabled).length > 0) add('PreToolUse', enabledToolsGuard(enabled))
  if (context.claudeHooks && context.claudeHooks.length > 0) {
    const claude = claudeHookMatchers(context.claudeHooks, { projectDir: context.cwd, approvals })
    for (const [event, matchers] of Object.entries(claude))
      for (const matcher of matchers) add(event, matcher)
  }
  return Object.keys(hooks).length > 0 ? hooks : null
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
