import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from './types.mjs'
import { sleep } from './util.mjs'

export class MockRuntime implements ClaudeRuntime {
  private interrupted = new Set<string>()

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    this.interrupted.delete(context.threadId)
    await handlers.onEvent({ type: 'session', claudeSessionId: context.claudeSessionId ?? `mock-${context.threadId}` })

    if (/approval|permission|bash/i.test(context.prompt)) {
      const toolUseId = `tool-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Bash',
        input: { command: 'echo mock approval', description: 'mock approval command' },
      })
      const decision = await handlers.onPermissionRequest({
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
        await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'declined', isError: true })
      }
    }

    if (/edit|write file|file change/i.test(context.prompt)) {
      const toolUseId = `tool-${Date.now()}`
      const filePath = join(context.cwd, 'README.md')
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Write',
        input: { file_path: filePath, content: 'changed by mock runtime\n' },
      })
      const decision = await handlers.onPermissionRequest({
        type: 'permission_request',
        requestId: `perm-${toolUseId}`,
        toolUseId,
        toolName: 'Write',
        input: { file_path: filePath, content: 'changed by mock runtime\n' },
      })
      if (decision.decision === 'accept' || decision.decision === 'acceptForSession') {
        await writeFile(filePath, 'changed by mock runtime\n')
        await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'wrote README.md' })
      } else {
        await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'declined', isError: true })
      }
    }

    if (/generic tool|read tool/i.test(context.prompt)) {
      const toolUseId = `tool-${Date.now()}`
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId,
        toolName: 'Read',
        input: { file_path: join(context.cwd, 'README.md') },
      })
      await handlers.onEvent({ type: 'tool_result', toolUseId, content: { text: 'mock read result' } })
    }

    if (/model effort check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'text_delta',
        delta: `model=${context.model ?? 'default'} effort=${context.effort ?? 'default'}`,
      })
      await handlers.onEvent({ type: 'completed', success: true, result: 'model effort check' })
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
      await handlers.onEvent({ type: 'notice', level: 'warning', message: 'mock rate limit notice' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'notice event' })
      return
    }

    if (/thinking check/i.test(context.prompt)) {
      await handlers.onEvent({ type: 'reasoning_delta', delta: 'mock thinking' })
      await handlers.onEvent({ type: 'text_delta', delta: 'done' })
      await handlers.onEvent({ type: 'completed', success: true, result: 'thinking check' })
      return
    }

    if (/usage check/i.test(context.prompt)) {
      await handlers.onEvent({
        type: 'usage',
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
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

  async stop(): Promise<void> {}
}
