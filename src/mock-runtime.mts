import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ClaudeRuntime,
  RuntimeBackgroundListener,
  RuntimeHandlers,
  RuntimeLiveTask,
  RuntimeSteerOptions,
  RuntimeTurnContext,
  RuntimeTurnSettings,
} from './types.mjs'
import { sleep } from './util.mjs'

const MOCK_BACKGROUND_AGENT_ID = 'a0b1c2d3e4f5a6b7'
const MOCK_FOREGROUND_AGENT_ID = 'deadbeefcafef00d'

export class MockRuntime implements ClaudeRuntime {
  private interrupted = new Set<string>()
  private running = new Set<string>()
  // The running turn of each thread, and the settings turn/settings/update
  // gave it.
  private runningTurns = new Map<string, string>()
  private turnSettings = new Map<string, RuntimeTurnSettings>()
  private listener: RuntimeBackgroundListener | null = null
  private backgroundTasks = new Map<string, { threadId: string; timer: NodeJS.Timeout }>()
  // What Claude says, unprompted, once a background agent reports back.
  private continuations = new Map<string, string>()
  private steered = new Map<string, string[]>()
  // Foreground agents waiting to be stopped by task id.
  private foregroundStops = new Map<string, () => void>()
  // Threads whose scenario plays the native runtime, which drops a
  // subagent's own events before they reach the server.
  private nestedFiltered = new Set<string>()
  // resetSession calls per thread, echoed by the rewind check scenario.
  private resets = new Map<string, number>()
  // reloadMcpServers calls, echoed by the mcp reload check scenario.
  private mcpReloads = 0
  // Background Bash shells by task id.
  private shells = new Map<string, { threadId: string; toolUseId: string }>()
  // Background workflows: task id to thread id.
  private workflows = new Map<string, string>()
  // Threads whose next /compact fails, as when Claude cannot compact, or
  // runs until it is interrupted.
  private failingCompactions = new Set<string>()
  private holdingCompactions = new Set<string>()

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    // A session slow to come up (the CLI's, while an interrupted turn is
    // still draining): input cannot reach the turn yet.
    if (/slow start/i.test(context.prompt)) await sleep(500)
    this.running.add(context.threadId)
    this.runningTurns.set(context.threadId, context.turnId)
    try {
      await this.playTurn(context, handlers)
    } finally {
      this.running.delete(context.threadId)
      this.runningTurns.delete(context.threadId)
      this.turnSettings.delete(context.turnId)
    }
  }

  async updateTurnSettings(
    threadId: string,
    turnId: string,
    settings: RuntimeTurnSettings,
  ): Promise<boolean> {
    if (this.runningTurns.get(threadId) !== turnId) return false
    this.turnSettings.set(turnId, { ...this.turnSettings.get(turnId), ...settings })
    return true
  }

  private async playTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    this.interrupted.delete(context.threadId)
    // Resuming at a checkpoint forks the session, like the CLI does.
    const sessionId =
      context.claudeSessionId && context.resumeSessionAt
        ? `${context.claudeSessionId}~${context.turnId}`
        : (context.claudeSessionId ?? `mock-${context.threadId}`)
    await handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
    // A turn from before the adapter kept checkpoints left none.
    if (!/no checkpoint/i.test(context.prompt))
      await handlers.onEvent({
        type: 'checkpoint',
        claudeSessionId: sessionId,
        messageUuid: `${context.turnId}-entry`,
      })

    // Claude Code's /compact in the thread's session: the summary replaces
    // the conversation, reported by the status and compact_boundary messages.
    if (context.prompt === '/compact') {
      await handlers.onEvent({ type: 'compaction_started' })
      if (this.holdingCompactions.delete(context.threadId)) {
        for (let i = 0; i < 1000 && !this.interrupted.has(context.threadId); i += 1) await sleep(10)
        await handlers.onEvent({ type: 'completed', success: false, result: 'interrupted' })
        return
      }
      if (this.failingCompactions.delete(context.threadId)) {
        await handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message: 'Claude could not compact the conversation: mock compaction failure',
        })
        await handlers.onEvent({ type: 'completed', success: true, result: '' })
        return
      }
      await handlers.onEvent({
        type: 'compaction_completed',
        trigger: 'manual',
        preTokens: 150_000,
        postTokens: 12_000,
      })
      // The summary's own call; it does not measure the context.
      await handlers.onEvent({
        type: 'usage',
        usage: { input_tokens: 150_000, output_tokens: 3_000 },
        contextWindow: 200_000,
      })
      await handlers.onEvent({
        type: 'completed',
        success: true,
        result: '',
        claudeSessionId: sessionId,
      })
      return
    }
    // Not from a summary, whose prompt quotes the thread's earlier turns.
    if (context.purpose !== 'compact') {
      if (/next compaction fails/i.test(context.prompt))
        this.failingCompactions.add(context.threadId)
      if (/next compaction holds/i.test(context.prompt))
        this.holdingCompactions.add(context.threadId)
    }

    // Claude compacting on its own partway through a turn. "boundary only"
    // leaves out the status message before the boundary; "stalls" never
    // reaches it, until an interrupt; "then hold" keeps the turn running
    // afterwards until a steer says "release".
    if (/auto compaction check/i.test(context.prompt)) {
      await handlers.onEvent({ type: 'text_delta', delta: 'Reading the files.' })
      if (!/boundary only/i.test(context.prompt))
        await handlers.onEvent({ type: 'compaction_started' })
      if (/stalls/i.test(context.prompt)) {
        for (let i = 0; i < 1000 && !this.interrupted.has(context.threadId); i += 1) await sleep(10)
        await handlers.onEvent({ type: 'completed', success: false, result: 'interrupted' })
        return
      }
      await handlers.onEvent({
        type: 'compaction_completed',
        trigger: 'auto',
        preTokens: 180_000,
        postTokens: 20_000,
      })
      let released = false
      if (/then hold/i.test(context.prompt)) {
        for (let i = 0; i < 1000 && !released; i += 1) {
          if (this.interrupted.has(context.threadId)) {
            await handlers.onEvent({ type: 'completed', success: false, result: 'interrupted' })
            return
          }
          released =
            this.steered.get(context.threadId)?.some((prompt) => /release/i.test(prompt)) === true
          if (!released) await sleep(10)
        }
        this.steered.delete(context.threadId)
      }
      await handlers.onEvent({
        type: 'text_delta',
        delta: released ? 'Released after compacting.' : 'Done after compacting.',
      })
      await handlers.onEvent({
        type: 'usage',
        usage: { input_tokens: 500, output_tokens: 50 },
        contextWindow: 200_000,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'compacted' })
      return
    }

    if (/rewind check/i.test(context.prompt)) {
      const text = `resumed ${context.claudeSessionId ?? 'nothing'} at ${context.resumeSessionAt ?? 'end'} after ${this.resets.get(context.threadId) ?? 0} resets`
      await handlers.onEvent({ type: 'text_delta', delta: text })
      await handlers.onEvent({ type: 'completed', success: true, result: text })
      return
    }

    if (/mcp reload check/i.test(context.prompt)) {
      const text = `${this.mcpReloads} MCP reloads`
      await handlers.onEvent({ type: 'text_delta', delta: text })
      await handlers.onEvent({ type: 'completed', success: true, result: text })
      return
    }

    // "memory recall check <file>": Claude recalls that memory file twice and
    // a synthesized summary, remarks on it, then answers.
    const recall = /memory recall check (\S+)/i.exec(context.prompt)
    if (recall) {
      const path = recall[1] ?? ''
      await handlers.onEvent({
        type: 'memory_recall',
        memories: [
          { path, scope: 'personal', content: null },
          {
            path: '<synthesis:/memories>',
            scope: 'team',
            content: 'The team ships on Fridays.\nReleases need a changelog.',
          },
        ],
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'Checking what I remember.' })
      await handlers.onEvent({ type: 'message_boundary' })
      await handlers.onEvent({
        type: 'memory_recall',
        memories: [{ path, scope: 'personal', content: null }],
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'You prefer short answers.' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'memory recall check' })
      return
    }

    if (/fork check/i.test(context.prompt)) {
      const text =
        context.forkedAt != null
          ? `forked at ${new Date(context.forkedAt).toISOString()}`
          : 'not a fork'
      await handlers.onEvent({ type: 'text_delta', delta: text })
      await handlers.onEvent({ type: 'completed', success: true, result: text })
      return
    }

    if (context.continuation) {
      const text = this.continuations.get(context.threadId) ?? null
      this.continuations.delete(context.threadId)
      if (text) await handlers.onEvent({ type: 'text_delta', delta: text })
      await handlers.onEvent({ type: 'completed', success: true, result: text })
      return
    }

    // Codex App's Continue button: say what Claude was asked to pick up.
    if (context.prompt.includes('pressed Continue')) {
      const message = /<interrupted_user_message>\n([\s\S]*?)\n<\/interrupted_user_message>/.exec(
        context.prompt,
      )?.[1]
      const text = message ? `answering: ${message}` : 'picking up where I left off'
      await handlers.onEvent({ type: 'text_delta', delta: text })
      await handlers.onEvent({ type: 'completed', success: true, result: text })
      return
    }

    // Goal continuation (hidden internal-context prompt). Its template text
    // would trip the keyword branches below, so answer it first: report usage,
    // and finish the goal when the objective asks for it.
    if (context.prompt.includes('<codex_internal_context>')) {
      if (
        /goal objective steer check/i.test(context.prompt) &&
        !/revised objective/i.test(context.prompt)
      ) {
        // Still running when the user edits the objective, so the edit has to
        // reach this turn as a steer.
        let edit: string | undefined
        for (let i = 0; i < 200 && !edit; i += 1) {
          await sleep(10)
          edit = this.steered
            .get(context.threadId)
            ?.find((prompt) => prompt.includes('objective was edited'))
        }
        this.steered.delete(context.threadId)
        await handlers.onEvent({
          type: 'text_delta',
          delta: edit?.includes('revised objective')
            ? 'now on the revised objective'
            : 'never steered',
        })
        await handlers.onEvent({ type: 'usage', usage: { input_tokens: 40, output_tokens: 10 } })
        await handlers.onEvent({ type: 'completed', success: true, result: 'switched' })
        return
      }
      if (/goal budget steer check/i.test(context.prompt)) {
        // One long API call overruns the budget before the turn's result.
        await handlers.onEvent({
          type: 'usage_progress',
          messageId: 'mock-call-1',
          usage: { input_tokens: 400, output_tokens: 20 },
        })
        await sleep(20)
        const steers = this.steered.get(context.threadId) ?? []
        this.steered.delete(context.threadId)
        const wrapUp = steers.some((prompt) => prompt.includes('has reached its token budget'))
        await handlers.onEvent({
          type: 'text_delta',
          delta: wrapUp ? 'wrapping up on budget' : 'kept working',
        })
        await handlers.onEvent({ type: 'usage', usage: { input_tokens: 450, output_tokens: 60 } })
        await handlers.onEvent({ type: 'completed', success: true, result: 'wrapped up' })
        return
      }
      if (/goal complete check/i.test(context.prompt) && context.goalTools) {
        const toolUseId = `goal-${Date.now()}`
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId,
          toolName: 'mcp__codex_goal__update_goal',
          input: { status: 'complete' },
        })
        const result = await context.goalTools.updateGoal('complete')
        await handlers.onEvent({ type: 'tool_result', toolUseId, content: result })
      }
      await handlers.onEvent({ type: 'text_delta', delta: 'goal continuation' })
      // Like the CLI, usage arrives with the result, after any goal tool call.
      await handlers.onEvent({
        type: 'usage',
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'goal continuation' })
      return
    }

    // A Write whose input streams in before the finished call, as the native
    // runtime reports it. With "approval first" the permission request
    // overtakes the finished call; with "abandoned" a first response breaks
    // off in the middle of a call and Claude asks again; with "nested" a
    // subagent streams a call of its own.
    if (/live patch check/i.test(context.prompt)) {
      const path = join(context.cwd, 'live.txt')
      const content = 'one\ntwo\nthree\n'
      const toolUseId = `tool-live-${Date.now()}`
      const progress = (id: string, input: Record<string, unknown>) =>
        handlers.onEvent({ type: 'tool_input_progress', toolUseId: id, toolName: 'Write', input })
      if (/abandoned/i.test(context.prompt)) {
        await progress(`${toolUseId}-lost`, { file_path: path, content: 'on' })
        await handlers.onEvent({ type: 'message_boundary' })
      }
      if (/nested/i.test(context.prompt)) {
        const taskId = `task-live-${Date.now()}`
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId: taskId,
          toolName: 'Task',
          input: { description: 'writes a file', prompt: 'write the other file' },
        })
        await progress(`${toolUseId}-nested`, { file_path: join(context.cwd, 'nested.txt') })
        await handlers.onEvent({ type: 'tool_result', toolUseId: taskId, content: 'nested done' })
      }
      await handlers.onEvent({ type: 'text_delta', delta: 'writing live.txt' })
      await progress(toolUseId, { file_path: path })
      await progress(toolUseId, { file_path: path, content: 'one\ntw' })
      const input = { file_path: path, content }
      const approvalFirst = /approval first/i.test(context.prompt)
      if (!approvalFirst)
        await handlers.onEvent({ type: 'tool_use', toolUseId, toolName: 'Write', input })
      const decision = await handlers.onPermissionRequest({
        type: 'permission_request',
        requestId: `perm-${toolUseId}`,
        toolUseId,
        toolName: 'Write',
        input,
      })
      if (approvalFirst)
        await handlers.onEvent({ type: 'tool_use', toolUseId, toolName: 'Write', input })
      const accepted = decision.decision === 'accept' || decision.decision === 'acceptForSession'
      if (accepted) await writeFile(path, content)
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: accepted ? 'wrote live.txt' : 'declined',
        isError: !accepted,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'wrote live.txt' })
      return
    }

    // Keeps running until a steer says "release", so a test can count on the
    // turn still running when its next requests arrive.
    if (/hold this turn until released/i.test(context.prompt)) {
      await handlers.onEvent({ type: 'text_delta', delta: 'holding' })
      for (let i = 0; i < 1000; i += 1) {
        if (this.interrupted.has(context.threadId)) {
          await handlers.onEvent({ type: 'completed', success: false, result: 'interrupted' })
          return
        }
        if (this.steered.get(context.threadId)?.some((prompt) => /release/i.test(prompt))) break
        await sleep(10)
      }
      this.steered.delete(context.threadId)
      const settings = this.turnSettings.get(context.turnId)
      this.turnSettings.delete(context.turnId)
      await handlers.onEvent({
        type: 'text_delta',
        delta: settings
          ? ` released on model=${settings.model ?? 'unchanged'} effort=${settings.effort ?? 'unchanged'}`
          : ' released',
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'released' })
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

    if (/inherited config check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: JSON.stringify({
          mcpServers: context.mcpServers ?? null,
          allowedTools: context.allowedTools ?? null,
          inheritedAllowedTools: context.inheritedAllowedTools ?? null,
          inheritedAskRules: context.inheritedAskRules ?? null,
          claudeHooks: context.claudeHooks ?? null,
          disallowedTools: context.disallowedTools ?? null,
          mcpEnabledTools: context.mcpEnabledTools ?? null,
          agents: context.agents ?? null,
        }),
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'inherited config check' })
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

    if (/auto memory check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: `autoMemory=${context.autoMemory ?? 'unset'}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'auto memory check' })
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
      const hook = { type: 'hook_run' as const, hookId: 'mock-hook', hookEvent: 'PreToolUse' }
      await handlers.onEvent({ ...hook, status: 'running', entries: [] })
      await handlers.onEvent({
        ...hook,
        status: 'blocked',
        entries: [{ kind: 'feedback', text: 'Bash about to run echo hi' }],
      })
      // Codex has no name for Notification hooks, so they never reach the App.
      await handlers.onEvent({
        type: 'hook_run',
        hookId: 'mock-notification',
        hookEvent: 'Notification',
        status: 'completed',
        entries: [],
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'hook check done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'hook check' })
      return
    }

    if (/elicitation check/i.test(context.prompt)) {
      const url = /elicitation check url/i.test(context.prompt)
      const response = await handlers.onElicitationRequest?.(
        {
          serverName: 'mock-mcp',
          message: url ? 'Sign in to continue' : 'Pick a region',
          mode: url ? 'url' : 'form',
          requestedSchema: url
            ? null
            : { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
          url: url ? 'https://example.com/auth' : null,
          elicitationId: url ? 'mock-elicitation' : null,
        },
        new AbortController().signal,
      )
      await handlers.onEvent({
        type: 'text_delta',
        delta: `elicitation=${JSON.stringify(response)}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'elicitation check' })
      return
    }

    // Lists the dynamic tools the turn offers, then calls the first one the
    // way Claude would.
    if (/dynamic tool check/i.test(context.prompt)) {
      const servers = context.dynamicTools ?? []
      const offered = servers.map(
        (server) => `${server.server}:${server.tools.map((tool) => tool.name).join(',')}`,
      )
      await handlers.onEvent({ type: 'text_delta', delta: `tools=${offered.join(';') || 'none'}` })
      const server = servers[0]
      const tool = server?.tools[0]
      if (server && tool && handlers.onDynamicToolCall) {
        const response = await handlers.onDynamicToolCall(
          {
            callId: `call-${context.turnId}`,
            namespace: server.namespace,
            tool: tool.name,
            arguments: { query: 'mock' },
          },
          new AbortController().signal,
        )
        await handlers.onEvent({
          type: 'text_delta',
          delta: ` dynamic=${JSON.stringify(response)}`,
        })
      }
      await handlers.onEvent({ type: 'completed', success: true, result: 'dynamic tool check' })
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

    if (/auto background check/i.test(context.prompt)) {
      // A foreground Agent that Claude Code moves to the background while
      // the parent is still waiting on it (auto-background after a timeout).
      const toolUseId = `task-${Date.now()}`
      const agentId = MOCK_BACKGROUND_AGENT_ID
      const prompt = 'long survey'
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: { description: 'mock slow agent', prompt },
      })
      await sleep(50)
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
        'auto background report',
        backgroundDelayMs(context.prompt),
      )
      await handlers.onEvent({ type: 'text_delta', delta: 'agent moved to background' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'backgrounded' })
      return
    }

    if (/foreground stop check/i.test(context.prompt)) {
      // A foreground Agent call. Stopping its task makes the call return
      // early with an error, and the parent goes on without it.
      const toolUseId = `task-${Date.now()}`
      const taskId = 'mock-foreground-task'
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: { description: 'mock foreground agent', prompt: 'take your time' },
      })
      const stopped = new Promise<void>((resolve) => this.foregroundStops.set(taskId, resolve))
      await this.listener?.onTaskEvent(context.threadId, {
        type: 'task_started',
        taskId,
        toolUseId,
        taskType: 'local_agent',
        description: 'mock foreground agent',
        subagentType: null,
        prompt: 'take your time',
        backgrounded: false,
      })
      await stopped
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: '[Request interrupted by user for tool use]',
        isError: true,
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'carried on without it' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'carried on without it' })
      return
    }

    if (/parallel agent tool check/i.test(context.prompt)) {
      // One assistant message calls Agent and Bash together. Claude runs them
      // side by side; the Bash call is the parent's own.
      this.nestedFiltered.add(context.threadId)
      const agentId = `task-${Date.now()}`
      const bashId = `bash-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: agentId,
        toolName: 'Agent',
        input: { description: 'mock parallel agent', prompt: 'look around' },
      })
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: bashId,
        toolName: 'Bash',
        input: { command: 'echo beside', description: 'parallel shell' },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId: bashId, content: 'beside' })
      await handlers.onEvent({ type: 'tool_result', toolUseId: agentId, content: 'agent report' })
      await handlers.onEvent({ type: 'text_delta', delta: 'both finished' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'both finished' })
      return
    }

    if (/mixed agents check/i.test(context.prompt)) {
      // One message launches a background agent and a foreground one. The
      // foreground agent finishes inside the turn; the background one reports
      // after it.
      const bgId = `task-bg-${Date.now()}`
      const fgId = `task-fg-${Date.now()}`
      const agentId = MOCK_BACKGROUND_AGENT_ID
      const prompt = 'sleep then report'
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: bgId,
        toolName: 'Agent',
        input: { description: 'mock background agent', prompt, run_in_background: true },
      })
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: fgId,
        toolName: 'Agent',
        input: { description: 'mock foreground agent', prompt: 'answer now' },
      })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: bgId,
        content: `Async agent launched successfully.\nagentId: ${agentId}`,
        structured: { isAsync: true, status: 'async_launched', agentId, prompt },
      })
      this.scheduleBackgroundReport(
        context.threadId,
        agentId,
        bgId,
        'mixed background report',
        backgroundDelayMs(context.prompt),
      )
      await sleep(50)
      await handlers.onEvent({ type: 'tool_result', toolUseId: fgId, content: 'foreground report' })
      await handlers.onEvent({ type: 'text_delta', delta: 'foreground done, background running' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'mixed' })
      return
    }

    if (/sibling agents check/i.test(context.prompt)) {
      // Two foreground agents launched in one message; the first one to
      // finish must not end the other.
      const firstId = `task-a-${Date.now()}`
      const secondId = `task-b-${Date.now()}`
      for (const [toolUseId, description] of [
        [firstId, 'quick agent'],
        [secondId, 'slow agent'],
      ] as const) {
        await handlers.onEvent({
          type: 'tool_use',
          toolUseId,
          toolName: 'Agent',
          input: { description, prompt: description },
        })
      }
      await sleep(30)
      await handlers.onEvent({ type: 'tool_result', toolUseId: firstId, content: 'quick report' })
      await sleep(30)
      await handlers.onEvent({ type: 'tool_result', toolUseId: secondId, content: 'slow report' })
      await handlers.onEvent({ type: 'text_delta', delta: 'both agents reported' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'siblings' })
      return
    }

    if (/background shell check/i.test(context.prompt)) {
      // A Bash call Claude runs in the background: the call returns at once
      // and the shell stays live until it is stopped.
      const toolUseId = `shell-${Date.now()}`
      const taskId = `bash-${this.shells.size + 1}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Bash',
        input: { command: 'npm run dev', run_in_background: true },
      })
      this.shells.set(taskId, { threadId: context.threadId, toolUseId })
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `Command running in background with ID: ${taskId}`,
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'dev server started' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'started' })
      return
    }

    if (/background workflow check/i.test(context.prompt)) {
      // A Workflow Claude runs in the background: the call returns at once
      // and the run stays a live task of the thread until "workflow stop
      // check". Only the live task is played, not the workflow's agents. With
      // "text first" Claude's only text comes before the call; "silent"
      // sends none.
      const textFirst = /text first/i.test(context.prompt)
      const silent = /silent/i.test(context.prompt)
      const toolUseId = `workflow-${Date.now()}`
      const taskId = `workflow-${this.workflows.size + 1}`
      if (textFirst)
        await handlers.onEvent({ type: 'text_delta', delta: 'starting the review workflow' })
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Workflow',
        input: { workflow: 'review', run_in_background: true },
      })
      this.workflows.set(taskId, context.threadId)
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `Workflow running in background with ID: ${taskId}`,
      })
      if (!textFirst && !silent)
        await handlers.onEvent({ type: 'text_delta', delta: 'review workflow started' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'started' })
      return
    }

    if (/workflow stop check/i.test(context.prompt)) {
      // Claude stops the thread's background workflows.
      for (const [taskId, threadId] of this.workflows)
        if (threadId === context.threadId) this.workflows.delete(taskId)
      await handlers.onEvent({ type: 'text_delta', delta: 'workflows stopped' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'stopped' })
      return
    }

    if (/background close check/i.test(context.prompt)) {
      // Claude stops its own background agent; no notification follows.
      const toolUseId = `stop-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'TaskStop',
        input: { task_id: MOCK_BACKGROUND_AGENT_ID },
      })
      const task = this.backgroundTasks.get(MOCK_BACKGROUND_AGENT_ID)
      if (task) clearTimeout(task.timer)
      this.backgroundTasks.delete(MOCK_BACKGROUND_AGENT_ID)
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId,
        content: `Successfully stopped task: ${MOCK_BACKGROUND_AGENT_ID}`,
        isError: !task,
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'stopped it' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'stopped it' })
      return
    }

    if (/(background|foreground) message check/i.test(context.prompt)) {
      // A foreground agent is the one `subagent check` ran; the CLI resumes
      // it in the background just the same.
      const toolUseId = `send-${Date.now()}`
      const agentId = /foreground/i.test(context.prompt)
        ? MOCK_FOREGROUND_AGENT_ID
        : MOCK_BACKGROUND_AGENT_ID
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

    if (/model workflow check/i.test(context.prompt)) {
      // Claude runs a workflow of its own accord: the native runtime shows it
      // as an agent with the workflow role.
      const toolUseId = `workflow-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: {
          description: 'Workflow: review',
          prompt: 'review the diff',
          subagent_type: 'workflow',
        },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'review done' })
      await handlers.onEvent({ type: 'text_delta', delta: 'workflow finished' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'workflow finished' })
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
      // Mirror the CLI 2.1.283 Task tool result: the report inside its
      // hand-back frame (every line indented, a harness note above it),
      // then an `agentId: ...` line and a `<usage>` block. The server should
      // show only the report and route the values into agentNickname +
      // tokenUsage instead.
      const report = ['subagent final summary', '', '```', 'indented detail', '```']
      const handback = [
        '  [harness: a note for the parent model]',
        '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:',
        ...report.map((line) => `  ${line}`),
      ].join('\n')
      const trailer = [
        `agentId: ${MOCK_FOREGROUND_AGENT_ID} (use SendMessage with to: '${MOCK_FOREGROUND_AGENT_ID}', summary: '<5-10 word recap>' to continue this agent)`,
        '<usage>subagent_tokens: 4242',
        'tool_uses: 7',
        'duration_ms: 31415</usage>',
      ].join('\n')
      await handlers.onEvent({
        type: 'tool_result',
        toolUseId: taskId,
        content: `${handback}\n${trailer}`,
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

    if (/context usage check/i.test(context.prompt)) {
      // Two API calls, then the result that sums them, then what a workflow's
      // agents spent beside the main loop.
      await handlers.onEvent({
        type: 'usage_progress',
        messageId: 'call-1',
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      await handlers.onEvent({
        type: 'usage_progress',
        messageId: 'call-2',
        usage: { input_tokens: 30, cache_read_input_tokens: 120, output_tokens: 50 },
      })
      await handlers.onEvent({ type: 'text_delta', delta: 'measured' })
      await handlers.onEvent({
        type: 'usage',
        usage: { input_tokens: 130, cache_read_input_tokens: 120, output_tokens: 70 },
        contextWindow: 200_000,
      })
      await handlers.onEvent({ type: 'usage', usage: { output_tokens: 1000 }, child: true })
      await handlers.onEvent({ type: 'completed', success: true, result: 'measured' })
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

    // A reply naming a visualization the way the visualize skill shows it,
    // without the invisible marks around `visualize`.
    if (/visualize line check/i.test(context.prompt)) {
      const deltas = ['Here is the chart.\n\nvisual', 'ize{"path":"/tmp/chart.html","mode":"wide"}']
      for (const delta of deltas) await handlers.onEvent({ type: 'text_delta', delta })
      await handlers.onEvent({ type: 'completed', success: true, result: deltas.join('') })
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

  // Claude takes a steer at its next tool-round boundary.
  async steer(threadId: string, prompt: string, options?: RuntimeSteerOptions): Promise<boolean> {
    if (!this.running.has(threadId)) return false
    this.steered.set(threadId, [...(this.steered.get(threadId) ?? []), prompt])
    setImmediate(() => options?.onAccepted?.())
    return true
  }

  filtersNestedEvents(threadId: string): boolean {
    return this.nestedFiltered.has(threadId)
  }

  async stop(): Promise<void> {
    for (const { timer } of this.backgroundTasks.values()) clearTimeout(timer)
    this.backgroundTasks.clear()
    this.shells.clear()
    this.workflows.clear()
  }

  setBackgroundListener(listener: RuntimeBackgroundListener): void {
    this.listener = listener
  }

  async stopTask(threadId: string, taskId: string): Promise<boolean> {
    const foreground = this.foregroundStops.get(taskId)
    if (foreground) {
      this.foregroundStops.delete(taskId)
      setImmediate(foreground)
      return true
    }
    const shell = this.shells.get(taskId)
    if (shell?.threadId === threadId) {
      this.shells.delete(taskId)
      return true
    }
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

  liveTasks(threadId: string): RuntimeLiveTask[] {
    const agents = [...this.backgroundTasks]
      .filter(([, task]) => task.threadId === threadId)
      .map(([taskId]) => ({ taskId, taskType: 'local_agent', toolUseId: null }))
    const shells = [...this.shells]
      .filter(([, shell]) => shell.threadId === threadId)
      .map(([taskId, shell]) => ({ taskId, taskType: 'local_bash', toolUseId: shell.toolUseId }))
    const workflows = [...this.workflows]
      .filter(([, owner]) => owner === threadId)
      .map(([taskId]) => ({ taskId, taskType: 'local_workflow', toolUseId: null }))
    return [...agents, ...shells, ...workflows]
  }

  hasBackgroundWork(): boolean {
    return this.backgroundTasks.size > 0 || this.continuations.size > 0
  }

  hasPendingContinuation(threadId: string): boolean {
    return this.continuations.has(threadId)
  }

  resetSession(threadId: string): void {
    this.resets.set(threadId, (this.resets.get(threadId) ?? 0) + 1)
  }

  compactsSessions(): boolean {
    return true
  }

  async reloadMcpServers(): Promise<void> {
    this.mcpReloads += 1
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
