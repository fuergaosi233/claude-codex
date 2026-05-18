// Per-turn proxy to the real OpenAI Codex CLI. Used for threads whose
// runtimeBackend is 'codex' (picked at thread/start when the user selects a
// gpt-* model in the App's model dropdown). Shells out to `codex exec --json`
// per turn — Codex's headless mode emits JSONL events whose shape is almost
// 1:1 with our RuntimeEvent surface, so translation is mostly a rename.
//
// Multi-turn continuity: Codex's `thread.started.thread_id` returned on the
// first turn is persisted on our ThreadRecord.codexSessionId; subsequent
// turns invoke `codex exec resume <id>` so the conversation history survives.
//
// Auth: relies on real Codex's own auth state (login via the Codex desktop
// app or `codex login`). We don't manage tokens for it — just forward what
// the OS user has.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type {
  ClaudeRuntime,
  RuntimeHandlers,
  RuntimeTurnContext,
} from './types.mjs'
import { resolveCodexBinary, debugLog } from './util.mjs'

interface PendingTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  proc: ChildProcessWithoutNullStreams
  rl: Interface
  resolved: boolean
  resolve: () => void
  reject: (error: Error) => void
  // Emitted to caller when the SDK first reports the session — caller's
  // `onEvent({type:'completed', claudeSessionId})` carries it back up so the
  // server can persist as `codexSessionId` on the thread.
  capturedCodexSessionId: string | null
  // We track item ids opened by codex (item.started → item.completed) so we
  // can correctly map streaming text and tool events. Codex emits items
  // already typed as agent_message / command_execution / file_change /
  // mcp_tool_call — we project onto our RuntimeEvent set.
}

// When the server calls onEvent('completed') we pass capturedCodexSessionId
// via the existing claudeSessionId slot. The server already stores it on
// `thread.claudeSessionId` for Claude turns; for codex threads we treat the
// SAME slot as the codex session id (the field name is just historical).
// Persistence to `thread.codexSessionId` happens in server.mts based on
// thread.runtimeBackend.

export class CodexProxyRuntime implements ClaudeRuntime {
  private turns = new Map<string, PendingTurn>()

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const binary = resolveCodexBinary()
    if (!binary) {
      // No real codex on host — surface as a turn failure so the App shows
      // a clear error instead of hanging.
      await handlers.onEvent({
        type: 'error',
        message: 'Real Codex CLI not found. Set CODEX_REAL=/abs/path/to/codex.',
      })
      await handlers.onEvent({ type: 'completed', success: false, result: 'codex binary missing' })
      throw new Error('CODEX_REAL not set and no `codex` on PATH')
    }

    return new Promise<void>((resolve, reject) => {
      // `codex exec --json` emits one JSONL event per line. Flags:
      //   --skip-git-repo-check        run anywhere, mirroring App behavior
      //   --dangerously-bypass-...     skip codex's own approval modal — our
      //                                adapter handles policies upstream via
      //                                approvalPolicy/sandboxMode; codex
      //                                would otherwise prompt on stdin and
      //                                deadlock the JSONL stream.
      //   -m <model>                   the model the user picked in the App
      //   -C <cwd>                     anchor the workspace
      //   resume <sessionId>           multi-turn continuity
      const args: string[] = ['exec', '--json', '--skip-git-repo-check']
      // Translate Codex sandbox enum from our internal naming.
      if (context.sandboxMode === 'danger-full-access') {
        args.push('--dangerously-bypass-approvals-and-sandbox')
      } else if (context.sandboxMode === 'read-only' || context.sandboxMode === 'workspace-write') {
        args.push('-s', context.sandboxMode)
      } else {
        // Default to bypass — App's policy already vetted this turn.
        args.push('--dangerously-bypass-approvals-and-sandbox')
      }
      if (context.model) args.push('-m', context.model)
      if (context.cwd) args.push('-C', context.cwd)
      if (context.addDirs && context.addDirs.length > 0) {
        for (const dir of context.addDirs) args.push('--add-dir', dir)
      }
      // Codex's `resume` subcommand expects: `codex exec resume <id> [prompt]`.
      // The session id is the value we captured as claudeSessionId on the
      // first turn (server passes it through the same field for codex threads).
      const resumeId = context.claudeSessionId
      if (resumeId) {
        args.splice(1, 0, 'resume', resumeId)
      }
      args.push(context.prompt)

      debugLog('codex-proxy.spawn', { binary, args, threadId: context.threadId, turnId: context.turnId })

      const proc = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })

      const pending: PendingTurn = {
        context,
        handlers,
        proc,
        rl: createInterface({ input: proc.stdout }),
        resolved: false,
        resolve,
        reject,
        capturedCodexSessionId: resumeId, // pre-populated if resuming
      }
      this.turns.set(context.turnId, pending)

      // Surface real codex's stderr into the adapter log so users can debug
      // auth/network failures from one place.
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        debugLog('codex-proxy.stderr', { turnId: context.turnId, chunk: chunk.slice(0, 400) })
      })

      pending.rl.on('line', (line: string) => {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('{')) return // skip blank lines + stray TUI noise
        let event: Record<string, unknown>
        try {
          event = JSON.parse(trimmed)
        } catch (err) {
          debugLog('codex-proxy.parseError', { turnId: context.turnId, line: trimmed.slice(0, 200), err: String(err) })
          return
        }
        void this.handleEvent(pending, event)
      })

      proc.on('exit', (code, signal) => {
        debugLog('codex-proxy.exit', { turnId: context.turnId, code, signal })
        if (pending.resolved) return
        // No turn.completed seen — synthesize one so the server doesn't hang.
        pending.resolved = true
        this.turns.delete(context.turnId)
        const success = code === 0 && signal == null
        void (async () => {
          try {
            await handlers.onEvent({
              type: 'completed',
              success,
              result: success ? null : `codex exec exited ${code ?? signal}`,
              claudeSessionId: pending.capturedCodexSessionId,
            })
            if (success) resolve()
            else reject(new Error(`codex exec exited ${code ?? signal}`))
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })()
      })

      proc.on('error', (err) => {
        if (pending.resolved) return
        pending.resolved = true
        this.turns.delete(context.turnId)
        reject(err)
      })
    })
  }

  async steer(threadId: string, prompt: string): Promise<void> {
    // codex exec doesn't expose mid-turn input. Cleanest behavior: queue the
    // text for the next turn. The server already records the steer in items;
    // we just no-op here so the proxy doesn't crash.
    debugLog('codex-proxy.steer.unsupported', { threadId, promptLen: prompt.length })
  }

  async interrupt(threadId: string): Promise<void> {
    for (const pending of this.turns.values()) {
      if (pending.context.threadId !== threadId) continue
      try {
        pending.proc.kill('SIGTERM')
      } catch {}
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.turns.values()) {
      try {
        pending.proc.kill('SIGTERM')
      } catch {}
    }
    this.turns.clear()
  }

  // ── private ──

  private async handleEvent(pending: PendingTurn, event: Record<string, unknown>): Promise<void> {
    const type = String(event.type ?? '')
    const { handlers, context } = pending
    switch (type) {
      case 'thread.started': {
        const id = stringOr(event.thread_id)
        if (id && !pending.capturedCodexSessionId) {
          pending.capturedCodexSessionId = id
          // Mirror the Claude-side 'session' event so the server can persist
          // it. Server-side, when thread.runtimeBackend === 'codex' this
          // value is routed into thread.codexSessionId instead of claudeSessionId.
          await handlers.onEvent({ type: 'session', claudeSessionId: id })
        }
        break
      }
      case 'turn.started':
        // No-op — server already emitted its own turn/started before calling
        // runTurn(). Codex's notion of turn.started is internal.
        break
      case 'item.started': {
        const item = asRecord(event.item)
        const itemType = String(item.type ?? '')
        if (itemType === 'command_execution') {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: String(item.id ?? `codex-${Date.now()}`),
            toolName: 'Bash',
            input: { command: String(item.command ?? ''), description: stringOr(item.label) },
          })
        } else if (itemType === 'file_change') {
          // Surface the modification as a tool_use so server's file-change
          // pipeline (diff capture + approval flow) lights up.
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: String(item.id ?? `codex-${Date.now()}`),
            toolName: 'Edit',
            input: { file_path: stringOr(item.path) ?? '', changes: item.changes ?? [] },
          })
        } else if (itemType === 'mcp_tool_call') {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: String(item.id ?? `codex-${Date.now()}`),
            toolName: String(item.tool ?? 'mcp_tool'),
            input: asRecord(item.arguments),
          })
        }
        // agent_message / reasoning are streamed via item.delta below.
        break
      }
      case 'item.delta': {
        // Codex streams agent_message and reasoning text via incremental
        // deltas. Forward to text_delta / reasoning_delta so the App's
        // typewriter UI lights up.
        const item = asRecord(event.item)
        const itemType = String(item.type ?? '')
        if (itemType === 'agent_message') {
          const delta = stringOr(item.text) ?? stringOr(event.delta) ?? ''
          if (delta) await handlers.onEvent({ type: 'text_delta', delta })
        } else if (itemType === 'reasoning') {
          const delta = stringOr(item.text) ?? stringOr(event.delta) ?? ''
          if (delta) await handlers.onEvent({ type: 'reasoning_delta', delta })
        }
        break
      }
      case 'item.completed': {
        const item = asRecord(event.item)
        const itemType = String(item.type ?? '')
        const itemId = String(item.id ?? `codex-${Date.now()}`)
        if (itemType === 'agent_message') {
          // Non-streaming path: codex sometimes emits the full text in one
          // item.completed without prior deltas. Forward it once.
          const text = stringOr(item.text) ?? ''
          if (text) await handlers.onEvent({ type: 'text_delta', delta: text })
        } else if (itemType === 'reasoning') {
          const text = stringOr(item.text) ?? ''
          if (text) await handlers.onEvent({ type: 'reasoning_delta', delta: text })
        } else if (itemType === 'command_execution' || itemType === 'file_change' || itemType === 'mcp_tool_call') {
          // Tool result side — synthesize a tool_result so the server's
          // matching tool item closes properly.
          await handlers.onEvent({
            type: 'tool_result',
            toolUseId: itemId,
            content: stringOr(item.aggregated_output) ?? stringOr(item.summary) ?? stringOr(item.result) ?? null,
            isError: Boolean(item.error ?? item.is_error),
          })
        }
        break
      }
      case 'turn.completed': {
        if (pending.resolved) return
        const usage = asRecord(event.usage)
        if (Object.keys(usage).length > 0) {
          await handlers.onEvent({
            type: 'usage',
            usage: {
              input_tokens: usage.input_tokens ?? 0,
              cache_read_input_tokens: usage.cached_input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
              reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
            },
          })
        }
        pending.resolved = true
        this.turns.delete(context.turnId)
        try {
          await handlers.onEvent({
            type: 'completed',
            success: true,
            result: null,
            claudeSessionId: pending.capturedCodexSessionId,
          })
          pending.resolve()
        } catch (err) {
          pending.reject(err instanceof Error ? err : new Error(String(err)))
        }
        break
      }
      case 'turn.failed':
      case 'error': {
        if (pending.resolved) return
        const message = stringOr(event.message) ?? stringOr(asRecord(event.error).message) ?? 'codex turn failed'
        pending.resolved = true
        this.turns.delete(context.turnId)
        try {
          await handlers.onEvent({ type: 'error', message })
          await handlers.onEvent({
            type: 'completed',
            success: false,
            result: message,
            claudeSessionId: pending.capturedCodexSessionId,
          })
        } catch {}
        pending.reject(new Error(message))
        break
      }
      default:
        // Unknown event types — log so we can spot protocol drift, but don't
        // fail. Codex may add fields in newer versions.
        debugLog('codex-proxy.unknownEvent', { type, turnId: context.turnId })
    }
  }
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
