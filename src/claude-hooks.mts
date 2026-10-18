import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { askRuleCovers } from './ask-rules.mjs'
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
// exit 2 blocks (or, for events that cannot block, shows stderr to the user
// or nothing), any other exit is a non-blocking error.
//
// Two events never reach a callback. The CLI runs SessionStart hooks for a
// new, resumed or forked session while it loads, before it reads the SDK's
// initialize request that registers the callbacks, and SessionEnd hooks as
// it exits, after the SDK has dropped them. The adapter runs those itself:
// SessionStart when the session takes its first prompt, its context going
// to Claude with that prompt as a UserPromptSubmit hook's would, and
// SessionEnd once the CLI session is over. The CLI still calls SessionStart
// for compact and clear.
//
// A hook's `if`, a permission rule such as Bash(git *), is matched as the
// adapter matches ask rules, erring towards running the hook where it
// cannot take a command apart; as in Claude Code, only a tool event can meet
// one, so a hook with `if` on any other event never runs. `once` means
// nothing in a settings file, as in Claude Code, which honors it only for
// the hooks a skill or agent defines.
//
// Not carried over: prompt, agent and http hooks, PowerShell hooks, the
// asyncRewake wake-up (such a hook just runs in the background),
// CLAUDE_ENV_FILE, and the events whose outcome a callback cannot express or
// that the Codex approval flow owns (PreCompact, PermissionRequest and the
// rest).

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

// Exit code 2 shows stderr to the user only for these events, and does
// nothing for Notification.
const USER_ONLY_EVENTS = new Set(['SubagentStart', 'SessionStart', 'SessionEnd'])
// Plain output of a successful hook becomes context for these events.
const CONTEXT_EVENTS = new Set(['UserPromptSubmit', 'SessionStart'])
// Claude Code's defaults for a command hook: ten minutes, less for the
// events that hold up the user. Each SessionEnd hook gets a second and a
// half unless it says otherwise, and together they get the longest of their
// timeouts, from a second and a half up to a minute; as in Claude Code,
// CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS sets both.
const DEFAULT_TIMEOUT_SEC = 600
const EVENT_TIMEOUT_SEC: Record<string, number> = { UserPromptSubmit: 30 }
const SESSION_END_DEFAULT_SEC = 1.5
const SESSION_END_MAX_SEC = 60
// The events a hook's `if` can apply to: those about a tool call.
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])
// How long a finished hook's output is still read: a background process it
// started may hold its stdout open long after.
const DRAIN_MS = 250
// How often a killed hook is killed again until it is gone.
const KILL_RETRY_MS = 100
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
// The SessionStart sources the CLI reports before the callbacks exist.
const SESSION_ORIGINS = new Set(['startup', 'resume', 'fork'])
// The fields of a hook input that describe the session, not the event.
const SESSION_KEYS = ['session_id', 'transcript_path', 'cwd', 'permission_mode', 'agent_type']

export interface ClaudeHookSpec {
  readonly event: string
  // The CLI's matcher, or null for every occasion.
  readonly matcher: string | null
  readonly command: string
  // Exec form: command is the program, these its arguments; no shell.
  readonly args: string[] | null
  // The shell for a command line: sh, or bash when the hook asks for it.
  readonly shell: 'sh' | 'bash'
  readonly timeoutSec: number
  readonly async: boolean
  // The permission rule a tool call must match for the hook to run, or null.
  readonly if: string | null
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
          const key = JSON.stringify([event, matcher, spec.shell, spec.command, spec.args, spec.if])
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
  if (handler.shell === 'powershell') return skip('PowerShell hooks are not supported')
  let condition: string | null = null
  if (handler.if !== undefined) {
    if (typeof handler.if !== 'string') return skip('if is not a permission rule')
    condition = handler.if.trim() || null
    if (condition && !TOOL_EVENTS.has(event)) return skip('if conditions apply to tool events only')
  }
  const timeout = typeof handler.timeout === 'number' ? handler.timeout : Number.NaN
  const fallback =
    event === 'SessionEnd'
      ? (sessionEndOverrideSec() ?? SESSION_END_DEFAULT_SEC)
      : (EVENT_TIMEOUT_SEC[event] ?? DEFAULT_TIMEOUT_SEC)
  return {
    event,
    matcher,
    command,
    args: Array.isArray(handler.args) ? stringList(handler.args) : null,
    shell: handler.shell === 'bash' ? 'bash' : 'sh',
    timeoutSec: timeout > 0 ? timeout : fallback,
    async: handler.async === true || handler.asyncRewake === true,
    if: condition,
    source,
  }
}

// CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS in seconds, or null when unset.
function sessionEndOverrideSec(): number | null {
  const raw = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS?.trim() ?? ''
  const ms = /^\d+$/.test(raw) ? Number(raw) : 0
  return ms > 0 ? ms / 1000 : null
}

// How long a session's SessionEnd hooks get together, as Claude Code works
// it out: what CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS says, or else the
// longest of their timeouts, from a second and a half up to a minute.
export function sessionEndBudgetSec(specs: readonly ClaudeHookSpec[]): number {
  const override = sessionEndOverrideSec()
  if (override !== null) return override
  const timeouts = specs
    .filter((spec) => spec.event === 'SessionEnd')
    .map((spec) => spec.timeoutSec)
  return Math.max(SESSION_END_DEFAULT_SEC, Math.min(Math.max(0, ...timeouts), SESSION_END_MAX_SEC))
}

export interface ClaudeHookOptions {
  // The project folder: CLAUDE_PROJECT_DIR, and where a hook runs when the
  // CLI does not say.
  readonly projectDir: string
  // Whether a hook may approve a tool call; false in plan mode and a
  // read-only sandbox, where only Codex approves.
  readonly approvals: boolean
  // How the CLI session began: the source its SessionStart hooks run for.
  // Without one they run only when the CLI calls them (compact, clear).
  readonly origin?: SessionOrigin
  // The session's model, for SessionStart's input.
  readonly model?: string | null
}

export type SessionOrigin = 'startup' | 'resume' | 'fork'

export interface ClaudeHookSession {
  // The SDK hook matchers.
  readonly hooks: SdkHooks
  // Runs the SessionEnd hooks once the CLI session is over (null when there
  // are none); only the first call counts, and only for a session that took
  // a prompt. They share the session's budget, or `budget` when sessions
  // end together. Resolves when the hooks that are not async are done.
  readonly end: ((reason: string, budget?: AbortSignal) => Promise<void>) | null
  // The seconds the session's SessionEnd hooks get together; 0 for none.
  readonly endBudgetSec: () => number
}

// The hooks of one CLI session.
export function claudeHookSession(
  specs: readonly ClaudeHookSpec[],
  options: ClaudeHookOptions,
): ClaudeHookSession {
  const hooks: SdkHooks = {}
  const add = (event: string, matcher: HookMatcher): void => {
    hooks[event] = [...(hooks[event] ?? []), matcher]
  }
  // An async hook runs in the background, its outcome only logged.
  const run = async (
    spec: ClaudeHookSpec,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HookOutput> => {
    if (spec.async) {
      void runHookCommand(spec, input, options.projectDir).then((result) => logResult(spec, result))
      return {}
    }
    const result = await runHookCommand(spec, input, options.projectDir, signal)
    logResult(spec, result)
    return hookOutput(spec.event, result, options.approvals)
  }

  const { origin } = options
  const starts = origin
    ? specs.filter((spec) => spec.event === 'SessionStart' && matches(spec.matcher, origin))
    : []
  const ends = specs.filter((spec) => spec.event === 'SessionEnd')
  // The session as hook inputs describe it, known from its first prompt on.
  let session: Record<string, unknown> | null = null
  if (starts.length > 0 || ends.length > 0) {
    let begun = false
    const waits = starts.filter((spec) => !spec.async).map((spec) => spec.timeoutSec)
    const first: HookCallback = async (input, _toolUseId, { signal }) => {
      const current = sessionFields(input)
      session = current
      if (begun || starts.length === 0) return {}
      begun = true
      const start: Record<string, unknown> = {
        ...current,
        hook_event_name: 'SessionStart',
        source: origin,
      }
      if (options.model) start.model = options.model
      // Each runs in parallel within its own timeout, as Claude Code runs them.
      const outputs = await Promise.all(starts.map((spec) => run(spec, start, signal)))
      return startOutput(outputs)
    }
    add('UserPromptSubmit', {
      hooks: [first],
      // Room for the slowest, and for its output to drain.
      timeout: Math.max(EVENT_TIMEOUT_SEC.UserPromptSubmit ?? 30, ...waits) + 1,
    })
  }
  for (const spec of specs) {
    if (spec.event === 'SessionEnd') continue
    const callback: HookCallback = async (input, _toolUseId, { signal }) => {
      if (spec.event === 'SessionStart' && SESSION_ORIGINS.has(String(input.source))) return {}
      if (spec.if && !conditionMet(spec.if, input, options.projectDir)) return {}
      return run(spec, input, signal)
    }
    const matcher: HookMatcher = { hooks: [callback], timeout: spec.timeoutSec }
    if (spec.matcher) matcher.matcher = spec.matcher
    add(spec.event, matcher)
  }

  const endBudgetSec = () => (ends.length > 0 ? sessionEndBudgetSec(ends) : 0)
  let ended = false
  const end = async (reason: string, budget?: AbortSignal): Promise<void> => {
    if (ended || !session) return
    ended = true
    const input = { ...session, hook_event_name: 'SessionEnd', reason }
    const due = ends.filter((spec) => matches(spec.matcher, reason))
    // One budget for them all: what is still running when it is spent is
    // stopped.
    const signal = budget ?? AbortSignal.timeout(endBudgetSec() * 1000)
    await Promise.all(due.map((spec) => run(spec, input, signal)))
  }
  return { hooks, end: ends.length > 0 ? end : null, endBudgetSec }
}

// Whether a tool call meets a hook's `if`: the call an ask rule written the
// same way would cover. Relative paths start from the call's folder.
function conditionMet(rule: string, input: Record<string, unknown>, projectDir: string): boolean {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : projectDir
  return askRuleCovers(rule, tool, asTable(input.tool_input) ?? {}, cwd)
}

// Whether a hook's matcher takes a query, as the CLI decides: every query
// when it has none (or * or .*), a name in a list split on |, otherwise a
// regular expression.
function matches(matcher: string | null, query: string): boolean {
  if (!matcher || matcher === '*' || matcher === '.*') return true
  if (/^[a-zA-Z0-9_|]+$/.test(matcher))
    return matcher.split('|').some((name) => name.trim() === query)
  try {
    return new RegExp(matcher).test(query)
  } catch {
    return false
  }
}

function sessionFields(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    SESSION_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
  )
}

// What the first prompt's hook passes on from the SessionStart hooks: their
// context for Claude and their messages for the user.
function startOutput(outputs: readonly HookOutput[]): HookOutput {
  const context: string[] = []
  const messages: string[] = []
  for (const output of outputs) {
    const extra = asTable(output.hookSpecificOutput)?.additionalContext
    if (typeof extra === 'string' && extra.trim()) context.push(extra.trim())
    const message = output.systemMessage
    if (typeof message === 'string' && message.trim()) messages.push(message.trim())
  }
  const answer: HookOutput = {}
  if (context.length > 0)
    answer.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context.join('\n\n'),
    }
  if (messages.length > 0) answer.systemMessage = messages.join('\n')
  return answer
}

export interface HookCommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly error: string | null
  readonly durationMs: number
}

// Runs a hook command as Claude Code does: with sh -c (bash -c when the hook
// asks for bash, no shell in exec form), the hook input as JSON on stdin and
// CLAUDE_PROJECT_DIR set. It is done when its own process exits, once the
// output still on its way is read: a background process it started keeps
// running, and what it still writes is read and dropped, so that it gets
// no SIGPIPE, without holding the adapter open. When the hook outlives its
// timeout or the CLI gives up on it, it is killed with everything it
// started.
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
    : [spec.shell === 'bash' ? 'bash' : '/bin/sh', ['-c', spec.command]]
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let error: string | null = null
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let drain: NodeJS.Timeout | undefined
    let retry: NodeJS.Timeout | undefined
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      clearTimeout(retry)
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
    // Whether the hook timed out or the CLI gave up on it.
    let killed = false
    const killGroup = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    // The whole group, again until the shell is gone: macOS can miss a shell
    // that is just forking, which then carries on after its killed command.
    const kill = () => {
      killed = true
      killGroup()
      clearTimeout(retry)
      retry = setTimeout(kill, KILL_RETRY_MS)
      retry.unref()
    }
    const abort = () => kill()
    timer = setTimeout(() => {
      timedOut = true
      kill()
    }, spec.timeoutSec * 1000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (!settled && stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (!settled && stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (cause) => {
      error = cause.message
      finish(null)
    })
    child.on('exit', (code) => {
      // Done: what it started is its own business now, unless it was killed.
      // Then the group goes once more: a child it forked as the last kill
      // came in can have missed it, and nothing kills it later.
      clearTimeout(timer)
      clearTimeout(retry)
      if (killed) killGroup()
      signal?.removeEventListener('abort', abort)
      drain = setTimeout(() => {
        // The pipes stay open for a background process that still writes
        // to them, but no longer keep the adapter running.
        for (const stream of [child.stdout, child.stderr]) {
          stream.on('error', () => {})
          if (stream instanceof Socket) stream.unref()
        }
        finish(code)
      }, DRAIN_MS)
    })
    child.on('close', (code) => finish(code))
    // A hook that does not read its input must not fail the write.
    child.stdin.on('error', () => {})
    child.stdin.end(`${JSON.stringify(input)}\n`)
  })
}

// What a finished command tells the CLI, as Claude Code reads its exit code
// and output.
export function hookOutput(event: string, result: HookCommandResult, approvals = true): HookOutput {
  // A hook that timed out is cancelled, whatever it printed.
  if (result.timedOut) return {}
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
  if (event === 'Notification') return {}
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
