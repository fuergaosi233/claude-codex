import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterHome, debugLog } from './util.mjs'

// The MCP servers a CLI session starts with reach the CLI in a file. The SDK
// would put its mcpServers option on the CLI's command line as JSON, where
// any local process can read it, and a server's settings can hold secrets: a
// header, an env value. The file is the user's alone (a 0600 file in a 0700
// folder under the adapter's home), named by the adapter's pid, and removed
// when its CLI session ends or the adapter exits; the next adapter removes
// those a killed one left behind. Values a config takes from the environment stay ${NAME} references
// in it, for the CLI to fill in, so they never reach the disk.
//
// The SDK's in-process servers still go through mcpServers: they have no
// settings to write, and the SDK keeps them off the command line.

// The files this process wrote and has not removed yet.
const written = new Set<string>()
// Whether the exit handler that removes them is in place.
let removedOnExit = false

export function cliMcpConfigDir(): string {
  return join(adapterHome(), 'mcp-config')
}

// Writes `servers` for the CLI's --mcp-config and returns the file, or null
// for no servers.
export function writeCliMcpConfig(servers: unknown, dir = cliMcpConfigDir()): string | null {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
  if (Object.keys(servers).length === 0) return null
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir leaves an existing folder's mode alone.
  chmodSync(dir, 0o700)
  const file = join(dir, `${process.pid}-${randomUUID()}.json`)
  writeFileSync(file, `${JSON.stringify({ mcpServers: servers })}\n`, { mode: 0o600, flag: 'wx' })
  // The adapter may exit before its sessions end. One handler for the
  // process's lifetime, however often the set empties and fills again.
  if (!removedOnExit) {
    removedOnExit = true
    process.on('exit', removeAll)
  }
  written.add(file)
  return file
}

export function removeCliMcpConfig(file: string): void {
  written.delete(file)
  try {
    unlinkSync(file)
  } catch {}
}

function removeAll(): void {
  for (const file of written) removeCliMcpConfig(file)
}

// Removes the files of adapters that are gone.
export function sweepCliMcpConfigs(dir = cliMcpConfigDir()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const owner = Number(/^(\d+)-[0-9a-f-]+\.json$/.exec(name)?.[1])
    if (!owner || owner === process.pid || running(owner)) continue
    removeCliMcpConfig(join(dir, name))
    removed++
  }
  if (removed > 0) debugLog('cli_mcp_configs_swept', { removed })
  return removed
}

// Whether a process with this pid exists; signal 0 only asks.
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
