import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { basename } from 'node:path'
import {
  claudeProjectSettingsPaths,
  claudeTrustsProject,
  claudeUserSettingsPath,
  readJsonFile,
  stringList,
} from './claude-config.mjs'
import { asTable } from './codex-config.mjs'
import { redactSecretLikeText } from './provider-loop-descriptor-schema.mjs'
import type { HookCallback, HookMatcher, HookOutput, SdkHooks } from './sdk-hooks.mjs'
import { debugLog } from './util.mjs'

// Claude Code command hooks for a CLI that reads no settings files, run only
// when the user asks for them: with CLAUDE_CODEX_CLAUDE_HOOKS=user the
// `hooks` of the user's settings.json in the bridged config folder, with
// CLAUDE_CODEX_CLAUDE_HOOKS=project also those of a trusted project's
// .claude/settings.json and settings.local.json. Such hooks are often
// status or notification integrations for terminal sessions; running them
// for every App chat unasked would change what they do, and one that waits
// for input would hold up the turn. A repository never gets to run a
// command on its own say.
//
// Each command becomes an SDK hook callback. The CLI matches it as it
// would a settings hook and hands it the same input; the callback runs the
// command with that input as JSON on stdin and turns its exit code and
// output into the answer Claude Code would draw from them: exit 0 passes
// JSON output on (plain output becomes context where Claude Code adds it),
// exit 2 blocks, any other exit is a non-blocking error.
//
// Not carried over: prompt, agent and http hooks, hooks filtered with
// `if`, PowerShell hooks, the asyncRewake wake-up (such a hook just runs in
// the background), CLAUDE_ENV_FILE, and the events whose outcome a callback
// cannot express or that the Codex approval flow owns (PreCompact,
// PermissionRequest and the rest).

export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'Notification',
] as const

// Exit code 2 shows stderr to the user only for these events.
const USER_ONLY_EVENTS = new Set(['SubagentStart', 'SessionStart', 'SessionEnd', 'Notification'])
// Plain output of a successful hook becomes context for these events.
const CONTEXT_EVENTS = new Set(['UserPromptSubmit', 'SessionStart'])
// Claude Code's default for a command hook.
const DEFAULT_TIMEOUT_SEC = 600
const OUTPUT_LIMIT = 1024 * 1024
const OUTPUT_KEYS = [
  'continue',
  'suppressOutput',
  'stopReason',
  'decision',
  'reason',
  'systemMessage',
  'hookSpecificOutput',
]

export interface ClaudeHookSpec {
  readonly event: string
  // The CLI's matcher, or null for every occasion.
  readonly matcher: string | null
  readonly command: string
  // Exec form: command is the program, these its arguments; no shell.
  readonly args: string[] | null
  readonly timeoutSec: number
  readonly async: boolean
  readonly once: boolean
  // The settings file the hook came from.
  readonly source: string
}

// off (the default, and for any other value), user or project.
export function claudeHookScope(): 'off' | 'user' | 'project' {
  const raw = process.env.CLAUDE_CODEX_CLAUDE_HOOKS?.trim().toLowerCase()
  return raw === 'user' || raw === 'project' ? raw : 'off'
}

// The settings files whose hooks run for a thread's folder.
export function claudeHookFiles(cwd: string, configDir: string): string[] {
  const scope = claudeHookScope()
  if (scope === 'off') return []
  const files = [claudeUserSettingsPath(configDir)]
  if (scope === 'project' && claudeTrustsProject(cwd, configDir)) {
    const { shared, local } = claudeProjectSettingsPaths(cwd)
    files.push(shared, ...local)
  }
  return files
}

export function claudeHookSpecs(cwd: string, configDir: string): ClaudeHookSpec[] {
  const settings = claudeHookFiles(cwd, configDir).map((path) => ({
    path,
    data: readJsonFile(path),
  }))
  // As in Claude Code, disableAllHooks turns every hook off.
  if (settings.some(({ data }) => data?.disableAllHooks === true)) return []
  const specs: ClaudeHookSpec[] = []
  const seen = new Set<string>()
  for (const { path, data } of settings) {
    const table = asTable(data?.hooks)
    if (!table) continue
    for (const [event, matchers] of Object.entries(table)) {
      if (!(CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) {
        debugLog('claude_hook_skipped', { source: path, event, reason: 'event not supported' })
        continue
      }
      for (const entry of Array.isArray(matchers) ? matchers : []) {
        const group = asTable(entry)
        const raw = typeof group?.matcher === 'string' ? group.matcher.trim() : ''
        const matcher = raw === '' || raw === '*' ? null : raw
        for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
          const spec = hookSpec(path, event, matcher, asTable(handler))
          if (!spec) continue
          // Claude Code runs an identical command once.
          const key = JSON.stringify([event, matcher, spec.command, spec.args])
          if (seen.has(key)) continue
          seen.add(key)
          specs.push(spec)
        }
      }
    }
  }
  return specs
}

function hookSpec(
  source: string,
  event: string,
  matcher: string | null,
  handler: Record<string, unknown> | null,
): ClaudeHookSpec | null {
  const skip = (reason: string) => {
    debugLog('claude_hook_skipped', { source, event, reason })
    return null
  }
  if (!handler) return null
  if (handler.type !== 'command') return skip(`${String(handler.type)} hooks are not supported`)
  const command = typeof handler.command === 'string' ? handler.command.trim() : ''
  if (!command) return skip('no command')
  if (handler.if !== undefined) return skip('if filters are not supported')
  if (handler.shell === 'powershell') return skip('PowerShell hooks are not supported')
  const timeout = typeof handler.timeout === 'number' ? handler.timeout : Number.NaN
  return {
    event,
    matcher,
    command,
    args: Array.isArray(handler.args) ? stringList(handler.args) : null,
    timeoutSec: timeout > 0 ? timeout : DEFAULT_TIMEOUT_SEC,
    async: handler.async === true || handler.asyncRewake === true,
    once: handler.once === true,
    source,
  }
}

export interface ClaudeHookOptions {
  // The project folder: CLAUDE_PROJECT_DIR, and where a hook runs when the
  // CLI does not say.
  readonly projectDir: string
  // Whether a hook may approve a tool call; false in plan mode and a
  // read-only sandbox, where only Codex approves.
  readonly approvals: boolean
}

// The SDK hook matchers for a session. `once` hooks run once per session.
export function claudeHookMatchers(
  specs: readonly ClaudeHookSpec[],
  options: ClaudeHookOptions,
): SdkHooks {
  const hooks: SdkHooks = {}
  const ran = new Set<ClaudeHookSpec>()
  for (const spec of specs) {
    const callback: HookCallback = async (input, _toolUseId, { signal }) => {
      if (spec.once) {
        if (ran.has(spec)) return {}
        ran.add(spec)
      }
      if (spec.async) {
        void runHookCommand(spec, input, options.projectDir).then((result) =>
          logResult(spec, result),
        )
        return {}
      }
      const result = await runHookCommand(spec, input, options.projectDir, signal)
      logResult(spec, result)
      return hookOutput(spec.event, result, options.approvals)
    }
    const matcher: HookMatcher = { hooks: [callback], timeout: spec.timeoutSec }
    if (spec.matcher) matcher.matcher = spec.matcher
    hooks[spec.event] = [...(hooks[spec.event] ?? []), matcher]
  }
  return hooks
}

export interface HookCommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly error: string | null
  readonly durationMs: number
}

// Runs a hook command as Claude Code does: in a POSIX shell (exec form
// without one), with the hook input as JSON on stdin, CLAUDE_PROJECT_DIR
// set, and killed with its children when it outlives its timeout or the
// CLI gives up on it.
export function runHookCommand(
  spec: ClaudeHookSpec,
  input: Record<string, unknown>,
  projectDir: string,
  signal?: AbortSignal,
): Promise<HookCommandResult> {
  const started = Date.now()
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : projectDir
  const substitute = (text: string) => text.replaceAll('${CLAUDE_PROJECT_DIR}', projectDir)
  const [program, args] = spec.args
    ? [substitute(spec.command), spec.args.map(substitute)]
    : [hookShell(), ['-c', spec.command]]
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let error: string | null = null
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({ code, stdout, stderr, timedOut, error, durationMs: Date.now() - started })
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(program, args, {
        cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so a timeout ends what it started too.
        detached: process.platform !== 'win32',
      })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
      finish(null)
      return
    }
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const abort = () => kill()
    timer = setTimeout(() => {
      timedOut = true
      kill()
    }, spec.timeoutSec * 1000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (cause) => {
      error = cause.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
    // A hook that does not read its input must not fail the write.
    child.stdin.on('error', () => {})
    child.stdin.end(`${JSON.stringify(input)}\n`)
  })
}

// Claude Code's shell for hooks: the user's, when it is a POSIX one.
function hookShell(): string {
  const shell = process.env.SHELL
  return shell && /^(bash|zsh|sh)$/.test(basename(shell)) ? shell : '/bin/sh'
}

// What a finished command tells the CLI, as Claude Code reads its exit code
// and output.
export function hookOutput(event: string, result: HookCommandResult, approvals = true): HookOutput {
  if (result.code === 0) {
    const text = result.stdout.trim()
    const json = text.startsWith('{') ? jsonObject(text) : null
    if (json) return withoutApproval(pick(json), approvals)
    if (text && CONTEXT_EVENTS.has(event))
      return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
    return {}
  }
  if (result.code !== 2) return {}
  const reason = result.stderr.trim() || `The ${event} hook exited with code 2.`
  if (event === 'PreToolUse')
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }
  if (event === 'PostToolUseFailure')
    return { hookSpecificOutput: { hookEventName: event, additionalContext: reason } }
  if (USER_ONLY_EVENTS.has(event)) return { systemMessage: reason }
  return { decision: 'block', reason }
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    return asTable(JSON.parse(text))
  } catch {
    return null
  }
}

function pick(json: Record<string, unknown>): HookOutput {
  return Object.fromEntries(Object.entries(json).filter(([key]) => OUTPUT_KEYS.includes(key)))
}

// Where only Codex approves, a hook's approval is dropped; the call then
// goes through the Codex approval flow as if the hook had not decided.
function withoutApproval(output: HookOutput, approvals: boolean): HookOutput {
  if (approvals) return output
  const next = { ...output }
  if (next.decision === 'approve') delete next.decision
  const specific = asTable(next.hookSpecificOutput)
  if (specific?.permissionDecision === 'allow') {
    const { permissionDecision: _, permissionDecisionReason: __, ...rest } = specific
    next.hookSpecificOutput = rest
  }
  return next
}

function logResult(spec: ClaudeHookSpec, result: HookCommandResult): void {
  if (result.code === 0 && !result.timedOut) return
  debugLog('claude_hook_run', {
    event: spec.event,
    source: spec.source,
    code: result.code,
    timedOut: result.timedOut,
    error: result.error,
    durationMs: result.durationMs,
    stderr: redactSecretLikeText(result.stderr.trim().slice(0, 2000)),
  })
}
