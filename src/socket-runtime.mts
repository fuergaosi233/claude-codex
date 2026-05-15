import { createInterface } from 'node:readline'
import net from 'node:net'
import type { ClaudeRuntime, PermissionDecision, RuntimeHandlers, RuntimeTurnContext } from './types.mjs'
import { newId } from './util.mjs'

interface PendingTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  resolve: () => void
  reject: (error: Error) => void
}

interface PendingPermission {
  handlers: RuntimeHandlers
}

export class ClaudeSdkSocketRuntime implements ClaudeRuntime {
  private socket: net.Socket | null = null
  private turns = new Map<string, PendingTurn>()
  private permissions = new Map<string, PendingPermission>()

  constructor(private socketPath: string) {}

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    await this.ensureSocket()
    return new Promise<void>((resolveTurn, rejectTurn) => {
      this.turns.set(context.turnId, { context, handlers, resolve: resolveTurn, reject: rejectTurn })
      this.send({
        type: 'query',
        thread_id: context.threadId,
        turn_id: context.turnId,
        prompt: context.prompt,
        cwd: context.cwd,
        model: context.model,
        effort: context.effort,
        resume: context.claudeSessionId,
        fork_session: context.forkSession,
        mcp_servers: context.mcpServers,
        allowed_tools: context.allowedTools,
        add_dirs: context.addDirs,
        enable_file_checkpointing: context.enableFileCheckpointing,
        output_format: context.outputFormat,
        approval_policy: context.approvalPolicy,
        sandbox_mode: context.sandboxMode,
        system_prompt_addendum: context.systemPromptAddendum,
      })
    })
  }

  async interrupt(threadId: string): Promise<void> {
    await this.ensureSocket()
    this.send({ type: 'interrupt', thread_id: threadId })
  }

  async steer(threadId: string, prompt: string): Promise<void> {
    await this.ensureSocket()
    this.send({ type: 'steer', thread_id: threadId, prompt })
  }

  async stop(): Promise<void> {
    this.socket?.destroy()
    this.socket = null
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    const socket = net.createConnection(this.socketPath)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.on('error', (error) => this.failAll(error))
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      this.failAll(new Error(`Claude runtime socket closed: ${this.socketPath}`))
    })

    const rl = createInterface({ input: socket })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        void this.handleMessage(JSON.parse(line))
      } catch (error) {
        process.stderr.write(`[claude-runtime-socket] bad JSON: ${String(error)}\n`)
      }
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.turns.values()) pending.reject(error)
    this.turns.clear()
    this.permissions.clear()
  }

  private async handleMessage(message: any): Promise<void> {
    const turnId = String(message.turn_id ?? '')
    const pending = this.turns.get(turnId)
    if (message.type === 'permission_request') {
      if (!pending) {
        this.send({ type: 'permission_response', request_id: message.request_id, decision: 'decline' })
        return
      }
      const requestId = String(message.request_id ?? newId())
      this.permissions.set(requestId, { handlers: pending.handlers })
      const decision = await pending.handlers.onPermissionRequest({
        type: 'permission_request',
        requestId,
        toolUseId: String(message.tool_use_id ?? requestId),
        toolName: String(message.tool_name ?? 'unknown'),
        input: asRecord(message.input),
      })
      this.sendPermissionResponse(requestId, decision)
      return
    }

    if (!pending) return

    switch (message.type) {
      case 'session':
        await pending.handlers.onEvent({ type: 'session', claudeSessionId: String(message.claude_session_id) })
        break
      case 'text_delta':
        await pending.handlers.onEvent({ type: 'text_delta', delta: String(message.delta ?? '') })
        break
      case 'reasoning_delta':
        await pending.handlers.onEvent({ type: 'reasoning_delta', delta: String(message.delta ?? '') })
        break
      case 'tool_use':
        await pending.handlers.onEvent({
          type: 'tool_use',
          toolUseId: String(message.tool_use_id),
          toolName: String(message.tool_name),
          input: asRecord(message.input),
        })
        break
      case 'tool_output_delta':
        await pending.handlers.onEvent({
          type: 'tool_output_delta',
          toolUseId: String(message.tool_use_id),
          delta: String(message.delta ?? ''),
        })
        break
      case 'tool_result':
        await pending.handlers.onEvent({
          type: 'tool_result',
          toolUseId: String(message.tool_use_id),
          content: message.content,
          isError: Boolean(message.is_error),
        })
        break
      case 'notice':
        await pending.handlers.onEvent({
          type: 'notice',
          level: message.level === 'error' || message.level === 'warning' ? message.level : 'info',
          message: String(message.message ?? ''),
        })
        break
      case 'usage':
        await pending.handlers.onEvent({ type: 'usage', usage: asRecord(message.usage) })
        break
      case 'completed':
        await pending.handlers.onEvent({
          type: 'completed',
          success: Boolean(message.success),
          result: message.result == null ? null : String(message.result),
          claudeSessionId: message.claude_session_id == null ? null : String(message.claude_session_id),
        })
        this.turns.delete(turnId)
        pending.resolve()
        break
      case 'error': {
        const error = new Error(String(message.message ?? 'Claude runtime socket error'))
        await pending.handlers.onEvent({ type: 'error', message: error.message })
        this.turns.delete(turnId)
        pending.reject(error)
        break
      }
    }
  }

  private sendPermissionResponse(requestId: string, decision: PermissionDecision): void {
    this.permissions.delete(requestId)
    this.send({
      type: 'permission_response',
      request_id: requestId,
      decision: decision.decision,
      updated_input: decision.updatedInput ?? null,
    })
  }

  private send(message: unknown): void {
    this.socket?.write(`${JSON.stringify(message)}\n`)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
