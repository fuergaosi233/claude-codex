import assert from 'node:assert/strict'
import test from 'node:test'
import type { PermissionDecision, UserInputAnswers } from '../src/types.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

for (const kind of ['command', 'question', 'mcp'] as const) {
  test(`cancelled ${kind} request withdraws its card without interrupting the turn`, async () => {
    const controller = new AbortController()
    let resumeTurn: () => void = () => {}
    const continued = new Promise<void>((resolve) => {
      resumeTurn = resolve
    })
    let outcome: PermissionDecision | UserInputAnswers | undefined
    let interrupts = 0
    const runtime = scriptedRuntime(
      async (_context, handlers) => {
        if (kind === 'question') {
          assert.ok(handlers.onUserInputRequest)
          outcome = await handlers.onUserInputRequest(
            {
              type: 'user_input_request',
              requestId: 'cancel-question',
              toolUseId: 'question',
              questions: [
                {
                  id: 'choice',
                  header: 'Choice',
                  question: 'Continue?',
                  isOther: true,
                  isSecret: false,
                  options: [{ label: 'Yes', description: 'Continue the work' }],
                },
              ],
            },
            controller.signal,
          )
        } else {
          outcome = await handlers.onPermissionRequest(
            {
              type: 'permission_request',
              requestId: 'cancel-permission',
              requiresUser: true,
              toolUseId: 'permission',
              toolName: kind === 'mcp' ? 'mcp__fixture__write' : 'Bash',
              input: kind === 'mcp' ? { text: 'hello' } : { command: 'echo hello' },
            },
            controller.signal,
          )
        }
        await continued
        await handlers.onEvent({ type: 'text_delta', delta: 'The turn is still healthy.' })
        await handlers.onEvent({ type: 'completed', success: true })
      },
      {
        interrupt: async () => {
          interrupts++
        },
      },
    )
    await withInProcessApp(runtime, async (app) => {
      const threadId = await app.startThread({ approvalPolicy: 'untrusted', model: 'sonnet' })
      const turnId = await app.startTurn(threadId, 'Ask before running the tool')
      const method =
        kind === 'question'
          ? 'item/tool/requestUserInput'
          : kind === 'mcp'
            ? 'mcpServer/elicitation/request'
            : 'item/commandExecution/requestApproval'
      try {
        const request = await app.waitFor(() =>
          app.messages.find((message) => message.method === method),
        )
        controller.abort()
        await app.waitFor(() =>
          app
            .notified('serverRequest/resolved')
            .find((message) => message.requestId === request.id && message.threadId === threadId),
        )
        await app.waitFor(() => outcome)
        assert.deepEqual(outcome, kind === 'question' ? { answers: {} } : { decision: 'decline' })
        // The card is gone while the turn is still alive. An already-in-flight
        // click on Cancel must not be allowed to interrupt that healthy turn.
        assert.equal(app.notified('turn/completed').length, 0)
        await app.respond(
          request.id,
          kind === 'mcp' ? { action: 'cancel' } : { decision: 'cancel' },
        )
        assert.equal(interrupts, 0)
        resumeTurn()
        assert.equal((await app.turnCompleted(turnId)).status, 'completed')
        assert.equal(interrupts, 0)
        assert.equal(
          app
            .notified('serverRequest/resolved')
            .filter((message) => message.requestId === request.id).length,
          1,
        )
      } finally {
        controller.abort()
        resumeTurn()
      }
    })
  })
}
