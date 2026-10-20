import { connect } from 'node:net'
import { join } from 'node:path'
import { codexCompatVersion, codexHome } from './util.mjs'

// One-shot `app-server` commands a host runs to learn about the server
// before, or instead of, starting one. They are answered before anything
// opens the state database or touches the processes and files a running
// server owns, so a probe never disturbs a server already running on the
// same state dir.

export interface ProbeResult {
  code: number
  stdout: string
  stderr: string
}

const STARTUP_FLAGS = ['--print-startup-config', '--startup-sign-out', '--startup-client-info']
const SERVER_FLAGS = ['--listen', '--stdio', '--remote-control', '--managed-daemon']
const SUBCOMMANDS = ['daemon', 'proxy']

// configRequirements/read. Claude threads take no requirements.toml or
// managed policy, so there are none to report.
export function configRequirements(): { requirements: null } {
  return { requirements: null }
}

// `app-server --print-startup-config [--startup-sign-out]
// [--startup-client-info <json>]` (codex 0.164): one JSON line with the
// app-server version and the config requirements, without starting a server.
// Null when `args` holds none of these flags. Usage errors go to stderr, like
// codex's, and leave stdout empty.
export function startupConfigProbe(args: readonly string[]): ProbeResult | null {
  if (!args.some((arg) => STARTUP_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))))
    return null
  const usageError = (message: string, code = 2): ProbeResult => ({
    code,
    stdout: '',
    stderr: `error: ${message}\n`,
  })
  if (!args.includes('--print-startup-config')) {
    const flag = STARTUP_FLAGS.find((name) =>
      args.some((arg) => arg === name || arg.startsWith(`${name}=`)),
    )
    return usageError(`${flag} requires --print-startup-config`)
  }
  const server = SERVER_FLAGS.find((name) =>
    args.some((arg) => arg === name || arg.startsWith(`${name}=`)),
  )
  if (server) return usageError(`--print-startup-config cannot be used with ${server}`)
  if (args.some((arg) => SUBCOMMANDS.includes(arg)))
    return usageError('--print-startup-config cannot run a subcommand', 1)
  const clientInfo = optionValue(args, '--startup-client-info')
  if (clientInfo !== undefined && !isClientInfo(clientInfo))
    return usageError(
      "invalid value for '--startup-client-info <STARTUP_CLIENT_INFO>': expected ClientInfo JSON with string name and version",
    )
  // --startup-sign-out signs the ChatGPT account out before the requirements
  // are read. Claude threads have no ChatGPT account, so there is nothing to
  // sign out, and the client info only names the client in codex's own
  // requests; both are accepted and change nothing.
  const output = {
    appServerVersion: codexCompatVersion(),
    configRequirements: configRequirements(),
  }
  return { code: 0, stdout: `${JSON.stringify(output)}\n`, stderr: '' }
}

// `app-server daemon <command>`. Only `version` is answered: what the server
// at the control socket reports, or a failure when none listens there, which
// is what codex does. The Codex App asks it before connecting to that socket
// instead of starting a server over stdio (with
// CODEX_APP_SERVER_USE_LOCAL_DAEMON=1), and starts its own server when the
// probe fails. The adapter's unix daemon (`--listen unix://`) listens there.
// Null when `args` names no daemon command.
// App rule: daemon-version
export async function daemonProbe(args: readonly string[]): Promise<ProbeResult | null> {
  const index = args.indexOf('daemon')
  if (index < 0) return null
  const command = args[index + 1]
  if (command !== 'version') {
    return {
      code: 1,
      stdout: '',
      stderr: `error: app-server daemon ${command ?? ''} is not supported; run \`app-server --listen unix://\` to start a daemon\n`,
    }
  }
  const socketPath = join(codexHome(), 'app-server-control', 'app-server-control.sock')
  if (!(await listening(socketPath))) {
    return {
      code: 1,
      stdout: '',
      stderr: `Error: no app-server daemon is running at ${socketPath}\n`,
    }
  }
  const output = { status: 'running', socketPath, appServerVersion: codexCompatVersion() }
  return { code: 0, stdout: `${JSON.stringify(output)}\n`, stderr: '' }
}

// Whether a server accepts connections on the unix socket. The connection
// closes before it sends anything, so the server sees no client.
function listening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    const done = (result: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => done(false), 1000)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1] ?? ''
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  return inline === undefined ? undefined : inline.slice(name.length + 1)
}

// codex's ClientInfo: { name, title?, version }.
function isClientInfo(text: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const info = value as Record<string, unknown>
  return (
    typeof info.name === 'string' &&
    typeof info.version === 'string' &&
    (info.title == null || typeof info.title === 'string')
  )
}
