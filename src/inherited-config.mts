import { claudeAgents } from './claude-agents.mjs'
import {
  type ClaudePermissionRules,
  claudeMcpServers,
  claudePermissionRules,
} from './claude-config.mjs'
import { type ClaudeHookSpec, claudeHookSpecs } from './claude-hooks.mjs'
import { codexMcpServers, type InheritedMcpServer } from './codex-config.mjs'
import { bridgedClaudeConfigDir } from './project-instructions.mjs'
import { debugLog } from './util.mjs'

// What a Claude thread takes over from the user's Codex and Claude Code
// configs beyond instructions (project-instructions.mts covers those). Each
// part comes along only when asked for, so a bridged Claude Code config
// folder (CLAUDE_CODEX_CLAUDE_CONFIG_DIR) brings its instructions alone
// unless a switch below adds more.
//
// MCP servers: the Codex config's with CLAUDE_CODEX_CODEX_MCP_SERVERS=1,
// and the bridged Claude Code config's with CLAUDE_CODEX_CLAUDE_MCP_SERVERS=1.
// Claude Code's win a name over Codex's, being meant for Claude; the
// explicit CLAUDE_CODEX_MCP_SERVERS wins over both (see mcp.mts). The App's
// MCP panel lists the same servers.
//
// Subagents: with CLAUDE_CODEX_CLAUDE_AGENTS=1, the user's and the
// project's Claude Code agents (see claude-agents.mts).
//
// Permission rules: with CLAUDE_CODEX_CLAUDE_PERMISSIONS=1, the allow, ask
// and deny rules of the user's and the project's Claude Code settings. Deny
// rules always apply. Allow rules let a tool skip the Codex approval, so
// the runtime drops them in plan mode and in a read-only sandbox. Ask rules
// have no command-line form; a PreToolUse callback sends the calls they
// cover to the Codex approval (see ask-rules.mts).
//
// Hooks: the command hooks of the user's Claude Code settings with
// CLAUDE_CODEX_CLAUDE_HOOKS=user, and also a trusted project's with
// CLAUDE_CODEX_CLAUDE_HOOKS=project (see claude-hooks.mts).
//
// The Claude Code switches need the bridged folder; without it they do
// nothing.

// The bridged Claude Code config folder when `variable` asks for a part of
// it with exactly 1, as the Codex switches do; null otherwise.
function bridgedFor(variable: string): string | null {
  return process.env[variable] === '1' ? bridgedClaudeConfigDir() : null
}

export function inheritedMcpServers(cwd: string | null): InheritedMcpServer[] {
  const bridged = bridgedFor('CLAUDE_CODEX_CLAUDE_MCP_SERVERS')
  const servers = new Map<string, InheritedMcpServer>()
  for (const server of [
    ...codexMcpServers(cwd),
    ...(bridged ? claudeMcpServers(cwd, bridged) : []),
  ]) {
    servers.delete(server.name)
    servers.set(server.name, server)
  }
  const list = [...servers.values()]
  logOnChange(`mcp:${cwd ?? ''}`, 'inherited_mcp_servers', {
    cwd,
    // Names and origins only: env and headers carry credentials.
    servers: list.map((server) => ({
      name: server.name,
      source: server.source,
      type: server.config.type ?? 'stdio',
    })),
  })
  return list
}

// The Claude Code agents for a thread's folder, as the SDK's agents option,
// or null when there are none to bring.
export function inheritedAgents(cwd: string): Record<string, Record<string, unknown>> | null {
  const bridged = bridgedFor('CLAUDE_CODEX_CLAUDE_AGENTS')
  if (!bridged) return null
  const agents = claudeAgents(cwd, bridged)
  logOnChange(`agents:${cwd}`, 'inherited_agents', {
    cwd,
    agents: agents.map((agent) => ({ name: agent.name, source: agent.source })),
  })
  if (agents.length === 0) return null
  return Object.fromEntries(agents.map((agent) => [agent.name, agent.definition]))
}

// The Claude Code permission rules for a thread's folder, or null when they
// are not asked for.
export function inheritedPermissionRules(cwd: string): ClaudePermissionRules | null {
  const bridged = bridgedFor('CLAUDE_CODEX_CLAUDE_PERMISSIONS')
  if (!bridged) return null
  const rules = claudePermissionRules(cwd, bridged)
  // Counts only: a rule can quote a command line, credentials included.
  logOnChange(`permissions:${cwd}`, 'inherited_permission_rules', {
    cwd,
    allow: rules.allow.length,
    deny: rules.deny.length,
    ask: rules.ask.length,
  })
  return rules
}

// The Claude Code command hooks for a thread's folder, or null when there
// are none to run.
export function inheritedHooks(cwd: string): ClaudeHookSpec[] | null {
  const bridged = bridgedClaudeConfigDir()
  if (!bridged) return null
  const hooks = claudeHookSpecs(cwd, bridged)
  // Events and origins only: a command line can carry credentials.
  logOnChange(`hooks:${cwd}`, 'inherited_hooks', {
    cwd,
    hooks: hooks.map((hook) => ({ event: hook.event, matcher: hook.matcher, source: hook.source })),
  })
  return hooks.length > 0 ? hooks : null
}

export interface McpToolRules {
  // Tools to withhold from Claude, as --disallowedTools entries.
  readonly disallowedTools: string[]
  // Servers whose config lists the only tools Claude may call, by the
  // server's tool-name prefix.
  readonly enabledTools: Record<string, string[]>
}

// The Codex config's enabled_tools and disabled_tools, in CLI tool names.
export function mcpToolRules(servers: readonly InheritedMcpServer[]): McpToolRules {
  const disallowedTools: string[] = []
  const enabledTools: Record<string, string[]> = {}
  for (const server of servers) {
    for (const tool of server.disabledTools ?? [])
      disallowedTools.push(mcpToolName(server.name, tool))
    if (server.enabledTools)
      enabledTools[mcpToolName(server.name, '')] = server.enabledTools.map((tool) =>
        mcpToolName(server.name, tool),
      )
  }
  return { disallowedTools, enabledTools }
}

// The CLI's name for an MCP tool: mcp__<server>__<tool>, each part with
// characters outside [A-Za-z0-9_-] replaced.
export function mcpToolName(server: string, tool: string): string {
  const clean = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`
}

const logged = new Map<string, string>()

// Logs what a thread inherits when it changes, not on every read.
export function logOnChange(slot: string, event: string, data: Record<string, unknown>): void {
  const text = JSON.stringify(data)
  if (logged.get(slot) === text) return
  logged.set(slot, text)
  debugLog(event, data)
}
