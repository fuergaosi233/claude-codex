import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ClaudeRuntime,
  RuntimeBackgroundListener,
  RuntimeHandlers,
  RuntimeTurnContext,
} from './types.mjs'
import { sleep } from './util.mjs'

const MOCK_BACKGROUND_AGENT_ID = 'a0b1c2d3e4f5a6b7'

export class MockRuntime implements ClaudeRuntime {
  private interrupted = new Set<string>()
  private listener: RuntimeBackgroundListener | null = null
  private backgroundTasks = new Map<string, { threadId: string; timer: NodeJS.Timeout }>()
  // What Claude says, unprompted, once a background agent reports back.
  private continuations = new Map<string, string>()

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    this.interrupted.delete(context.threadId)
    await handlers.onEvent({
      type: 'session',
      claudeSessionId: context.claudeSessionId ?? `mock-${context.threadId}`,
    })

    if (context.continuation) {
      const text = this.continuations.get(context.threadId) ?? null
      this.continuations.delete(context.threadId)
      if (text) await handlers.onEvent({ type: 'text_delta', delta: text })
      await handlers.onEvent({ type: 'completed', success: true, result: text })
      return
    }

    if (/approval|permission|bash/i.test(context.prompt)) {
      const toolUseId = `tool-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Bash',
        input: { command: 'echo mock approval', description: 'mock approval command' },
      })
      // Mirror the real sidecar: when the Codex App pinned approvalPolicy=never
      // or Full access, skip the permission round-trip and run the tool.
      const autoApprove =
        context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access'
      const decision = autoApprove
        ? { decision: 'accept' as const }
        : await handlers.onPermissionRequest({
            type: 'permission_request',
            requestId: `perm-${toolUseId}`,
            toolUseId,
            toolName: 'Bash',
            input: { command: 'echo mock approval' },
          })
      if (decision.decision === 'accept' || decision.decision === 'acceptForSession') {
        await handlers.onEvent({ type: 'tool_output_delta', toolUseId, delta: 'mock approval\n' })
        await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'mock approval\n' })
      } else {
        await handlers.onEvent({
          type: 'tool_result',
          toolUseId,
          content: 'declined',
          isError: true,
        })
      }
    }

    if (/edit|write file|file change|create or overwrite|file named/i.test(context.prompt)) {
      const fileChange = fileChangeFromPrompt(context)
      const toolUseId = `tool-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Write',
        input: { file_path: fileChange.path, content: fileChange.content },
      })
      const decision = await handlers.onPermissionRequest({
        type: 'permission_request',
        requestId: `perm-${toolUseId}`,
        toolUseId,
        toolName: 'Write',
        input: { file_path: fileChange.path, content: fileChange.content },
      })
      if (decision.decision === 'accept' || decision.decision === 'acceptForSession') {
        await writeFile(fileChange.path, fileChange.content)
        await handlers.onEvent({
          type: 'tool_result',
          toolUseId,
          content: `wrote ${fileChange.name}`,
        })
      } else {
        await handlers.onEvent({
          type: 'tool_result',
          toolUseId,
          content: 'declined',
          isError: true,
        })
      }
    }

    if (/todo|checklist|plan list/i.test(context.prompt)) {
      // Claude's TodoWrite tool — the adapter maps this to a Codex
      // turn/plan/updated notification rather than a timeline item.
      const toolUseId = `tool-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'TodoWrite',
        input: {
          todos: [
            { content: 'Investigate', status: 'completed', activeForm: 'Investigating' },
            { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' },
            { content: 'Verify', status: 'pending', activeForm: 'Verifying' },
          ],
        },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'todos updated' })
    }

    if (/generic tool|read tool/i.test(context.prompt)) {
      const toolUseId = `tool-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Read',
        input: { file_path: join(context.cwd, 'README.md') },
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: { text: 'mock read result' },
      })
    }

    if (/model effort check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: `model=${context.model ?? 'default'} effort=${context.effort ?? 'default'}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'model effort check' })
      return
    }

    if (/effort echo/i.test(context.prompt)) {
      // Standalone effort echo so the test for config.model_reasoning_effort
      // can assert the value end-to-end without scraping the model field.
      await handlers.onEvent({ type: 'text_delta', delta: `effort=${context.effort ?? 'null'}` })
      await handlers.onEvent({ type: 'completed', success: true, result: 'effort echo' })
      return
    }

    if (/output schema check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: JSON.stringify({ model: context.model, outputFormat: context.outputFormat }),
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'output schema check' })
      return
    }

    if (/tool policy check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: `allowedTools=${context.allowedTools == null ? 'default' : context.allowedTools.join(',')}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'tool policy check' })
      return
    }

    if (/notice event/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: 'mock rate limit notice',
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'notice event' })
      return
    }

    if (/thinking check/i.test(context.prompt)) {
      await handlers.onEvent({ type: 'reasoning_delta', delta: 'mock thinking' })
      await handlers.onEvent({ type: 'text_delta', delta: 'done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'thinking check' })
      return
    }

    if (/policy check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: `approvalPolicy=${context.approvalPolicy ?? 'null'} sandboxMode=${context.sandboxMode ?? 'null'}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'policy check' })
      return
    }

    if (/system prompt check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: `systemPromptAddendum=${JSON.stringify(context.systemPromptAddendum ?? null)}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'system prompt check' })
      return
    }

    if (/hook check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'hook',
        hookName: 'PreToolUse',
        status: 'started',
        decision: 'allow',
        message: 'Bash about to run echo hi',
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'hook check done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'hook check' })
      return
    }

    if (/summarizing a Codex \/ Claude Code conversation/i.test(context.prompt)) {
      // Compaction turn — produce a fixed marker so tests can prove the
      // summary came from the runtime rather than the local fallback text.
      await handlers.onEvent({
        type: 'text_delta',
        delta: 'MOCK_COMPACT_SUMMARY: thread compacted by Claude.',
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'compact' })
      return
    }

    if (/image input check/i.test(context.prompt)) {
      const summary = context.imageInputs
        .map((img) => `${img.kind}:${img.mediaType}:${img.data.length}`)
        .join(',')
      await handlers.onEvent({
        type: 'text_delta',
        delta: `images=${summary || 'none'}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'image input check' })
      return
    }

    if (/web search check/i.test(context.prompt)) {
      const toolUseId = `ws-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'WebSearch',
        input: { query: 'mock query' },
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: 'Top result: https://example.com/article — overview.',
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'web search check' })
      return
    }

    if (/plan mode check/i.test(context.prompt)) {
      // plan mode should never reach the per-tool approval path; mirror that
      // here by emitting a tool_use *without* invoking onPermissionRequest.
      await handlers.onEvent({
        type: 'text_delta',
        delta: `planMode=${context.planMode}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'plan mode check' })
      return
    }

    if (/background subagent check/i.test(context.prompt)) {
      // Claude Code's run_in_background Agent: the call returns at once with
      // `async_launched`; the agent reports later through a task
      // notification, which also makes Claude answer on its own.
      const toolUseId = `task-${Date.now()}`
      const agentId = MOCK_BACKGROUND_AGENT_ID
      const prompt = 'survey the repo'
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: { description: 'mock background agent', prompt, run_in_background: true },
      })
      await this.listener?.onTaskEvent(context.threadId, {
        type: 'task_started',
        taskId: agentId,
        toolUseId,
        taskType: 'local_agent',
        description: 'mock background agent',
        subagentType: null,
        prompt,
        backgrounded: true,
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `Async agent launched successfully.\nagentId: ${agentId}`,
        structured: { isAsync: true, status: 'async_launched', agentId, prompt },
      })
      this.scheduleBackgroundReport(
        context.threadId,
        agentId,
        toolUseId,
        'background report body',
        backgroundDelayMs(context.prompt),
      )
      await handlers.onEvent({ type: 'text_delta', delta: 'agent launched in background' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'launched' })
      return
    }

    if (/background message check/i.test(context.prompt)) {
      const toolUseId = `send-${Date.now()}`
      const agentId = MOCK_BACKGROUND_AGENT_ID
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'SendMessage',
        input: { to: agentId, message: 'dig deeper' },
      })
      await this.listener?.onTaskEvent(context.threadId, {
        type: 'task_started',
        taskId: agentId,
        toolUseId,
        taskType: 'local_agent',
        description: 'mock background agent',
        subagentType: null,
        prompt: 'dig deeper',
        backgrounded: true,
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `Agent "${agentId}" was resumed in the background.`,
      })
      this.scheduleBackgroundReport(
        context.threadId,
        agentId,
        toolUseId,
        'follow-up report',
        backgroundDelayMs(context.prompt),
      )
      await handlers.onEvent({ type: 'text_delta', delta: 'message sent' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'sent' })
      return
    }

    if (/orphan subagent check/i.test(context.prompt)) {
      const taskId = `task-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: taskId,
        toolName: 'Task',
        input: { description: 'orphaned mock subagent', prompt: 'investigate disconnect' },
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'missing tool result' })
      return
    }

    if (/subagent check/i.test(context.prompt)) {
      // Drive the subagent suppression contract: a Task tool_use opens the
      // subagent context, internal tool_use/text/tool_result are emitted but
      // should be hidden by the runtime, then the matching tool_result on the
      // Task closes it and is forwarded as the visible Agent item completion.
      const taskId = `task-${Date.now()}`
      const innerToolId = `inner-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: taskId,
        toolName: 'Task',
        input: { description: 'mock subagent', prompt: 'investigate' },
      })
      await sleep(75)
      await handlers.onEvent({
        type: 'text_delta',
        delta: 'subagent thinking aloud (should be hidden)',
      })
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: innerToolId,
        toolName: 'Bash',
        input: { command: 'echo inner', description: 'leaked inner call' },
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: innerToolId,
        content: 'inner result',
      })
      // Mirror the real claude-agent-sdk Task tool result format: actual body
      // followed by an `agentId: ...` line and a `<usage>` block. The server
      // should strip both from the visible agentMessage and route the values
      // into agentNickname + tokenUsage instead.
      const trailer = [
        "agentId: deadbeefcafef00d (use SendMessage with to: 'deadbeefcafef00d' to continue this agent)",
        '<usage>total_tokens: 4242',
        'tool_uses: 7',
        'duration_ms: 31415</usage>',
      ].join('\n')
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: taskId,
        content: `subagent final summary\n${trailer}`,
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'main agent summary' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'subagent check' })
      return
    }

    if (/ask user question check/i.test(context.prompt)) {
      // Drive the AskUserQuestion → request_user_input bridge end-to-end via
      // the runtime handler. The mock plays the role the native runtime's
      // canUseTool plays in production: invoke onUserInputRequest, then
      // surface the user's answers as a text_delta so the test can assert
      // the round-trip worked.
      const handler = handlers.onUserInputRequest
      if (typeof handler !== 'function') {
        await handlers.onEvent({ type: 'text_delta', delta: 'no onUserInputRequest handler' })
        await handlers.onEvent({
          type: 'completed',
          success: true,
          result: 'ask user question check',
        })
        return
      }
      const answers = await handler({
        type: 'user_input_request',
        requestId: `askq-${context.threadId}-${context.turnId}`,
        toolUseId: `askq-tool-${Date.now()}`,
        questions: [
          {
            id: 'q0',
            header: 'Auth',
            question: 'Which auth method do you want?',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'OAuth', description: 'Use OAuth' },
              { label: 'API Key', description: 'Use API key' },
            ],
          },
        ],
      })
      const picked = answers.answers.q0?.answers.join(',') ?? ''
      await handlers.onEvent({ type: 'text_delta', delta: `picked=${picked}` })
      await handlers.onEvent({
        type: 'completed',
        success: true,
        result: 'ask user question check',
      })
      return
    }

    if (/usage check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'usage',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      })
      await handlers.onEvent({
        type: 'metrics',
        durationMs: 1234,
        apiDurationMs: 987,
        numTurns: 3,
        costUsd: 0.0042,
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'usage done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'usage check' })
      return
    }

    const text = `Claude Code adapter mock response for: ${context.prompt || '(empty prompt)'}`
    for (const ch of text) {
      if (this.interrupted.has(context.threadId)) {
        await handlers.onEvent({ type: 'completed', success: false, result: 'interrupted' })
        return
      }
      await handlers.onEvent({ type: 'text_delta', delta: ch })
      await sleep(2)
    }
    await handlers.onEvent({ type: 'completed', success: true, result: text })
  }

  async interrupt(threadId: string): Promise<void> {
    this.interrupted.add(threadId)
  }

  async steer(_threadId: string, _prompt: string): Promise<void> {}

  async stop(): Promise<void> {
    for (const { timer } of this.backgroundTasks.values()) clearTimeout(timer)
    this.backgroundTasks.clear()
  }

  setBackgroundListener(listener: RuntimeBackgroundListener): void {
    this.listener = listener
  }

  async stopTask(threadId: string, taskId: string): Promise<boolean> {
    const task = this.backgroundTasks.get(taskId)
    if (!task || task.threadId !== threadId) return false
    clearTimeout(task.timer)
    this.backgroundTasks.delete(taskId)
    // Claude reports the stop asynchronously, and passively: no wakeup.
    setImmediate(() => {
      void this.listener?.onTaskEvent(threadId, {
        type: 'task_notification',
        taskId,
        toolUseId: null,
        status: 'stopped',
        summary: 'Agent stopped',
        result: null,
        usage: null,
      })
    })
    return true
  }

  hasBackgroundWork(): boolean {
    return this.backgroundTasks.size > 0 || this.continuations.size > 0
  }

  hasPendingContinuation(threadId: string): boolean {
    return this.continuations.has(threadId)
  }

  private scheduleBackgroundReport(
    threadId: string,
    taskId: string,
    toolUseId: string,
    report: string,
    delayMs: number,
  ): void {
    const timer = setTimeout(async () => {
      this.backgroundTasks.delete(taskId)
      const listener = this.listener
      if (!listener) return
      await listener.onTaskEvent(threadId, {
        type: 'task_progress',
        taskId,
        toolUseId,
        description: 'mock background agent',
        summary: null,
        lastToolName: 'Read',
        usage: { totalTokens: 1200, toolUses: 3, durationMs: delayMs },
      })
      await listener.onTaskEvent(threadId, {
        type: 'task_notification',
        taskId,
        toolUseId,
        status: 'completed',
        summary: 'Agent "mock background agent" completed',
        result: report,
        usage: { totalTokens: 2400, toolUses: 5, durationMs: delayMs },
      })
      this.continuations.set(threadId, `Background agent reported: ${report}`)
      listener.onAutonomousTurn(threadId)
    }, delayMs)
    this.backgroundTasks.set(taskId, { threadId, timer })
  }
}

// `... check delay=5000` keeps the agent running long enough to interact.
function backgroundDelayMs(prompt: string): number {
  const match = prompt.match(/\bdelay=(\d+)/)
  return match ? Number(match[1]) : 150
}

function fileChangeFromPrompt(context: RuntimeTurnContext): {
  name: string
  path: string
  content: string
} {
  const name = context.prompt.match(/\bfile named ([A-Za-z0-9._-]+)\b/i)?.[1] ?? 'README.md'
  const content =
    context.prompt.match(
      /with exactly this content(?: and no extra whitespace)?:\s*([^\n]+)/i,
    )?.[1] ?? 'changed by mock runtime\n'
  return { name, path: join(context.cwd, name), content }
}
