import { claudeMcpServers } from './claude-config.mjs'
import { codexMcpServers, type InheritedMcpServer } from './codex-config.mjs'
import { bridgedClaudeConfigDir } from './project-instructions.mjs'
import { debugLog } from './util.mjs'

// What a Claude thread takes over from the user's Codex and Claude Code
// configs beyond instructions (project-instructions.mts covers those).
//
// MCP servers: the Codex config's with CLAUDE_CODEX_CODEX_MCP_SERVERS=1,
// and, when CLAUDE_CODEX_CLAUDE_CONFIG_DIR is set, the Claude Code config's.
// Claude Code's win a name over Codex's, being meant for Claude; the
// explicit CLAUDE_CODEX_MCP_SERVERS wins over both (see mcp.mts).

export function inheritedMcpServers(cwd: string | null): InheritedMcpServer[] {
  const bridged = bridgedClaudeConfigDir()
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
