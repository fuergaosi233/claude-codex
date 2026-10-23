import assert from 'node:assert/strict'
import test from 'node:test'
import { INVALID_REQUEST, SERVER_ERROR } from '../src/host-methods.mjs'
import { PINNED_SECTION_ID } from '../src/store.mjs'
import { type InProcessApp, scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

// A request the user can put right (an unknown id, a bad parameter, an option
// the thread cannot take) fails as an invalid request, as in Codex, and the
// App shows its reason; a failure inside the server stays a server error.

async function refused(
  app: InProcessApp,
  method: string,
  params: Record<string, unknown>,
  message: RegExp,
  code = INVALID_REQUEST,
): Promise<void> {
  const reply = await app.call(method, params)
  assert.equal(reply.result, undefined, `${method} succeeded`)
  assert.match(reply.error?.message ?? '', message, method)
  assert.equal(reply.error?.code, code, `${method}: ${reply.error?.message}`)
}

// Turns that end at once, or hold until released when the prompt says so.
function holdingRuntime() {
  const held: Array<() => void> = []
  const runtime = scriptedRuntime(async (context, handlers) => {
    if (context.prompt.includes('hold')) await new Promise<void>((resolve) => held.push(resolve))
    await handlers.onEvent({ type: 'text_delta', delta: 'done' })
    await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
  })
  return { runtime, release: () => held.shift()?.() }
}

const MODELS = { CLAUDE_CODEX_MODELS: 'sonnet,opus,haiku,gpt-5.5' }

test('an unknown thread is an invalid request, whatever the method', async () => {
  await withInProcessApp(holdingRuntime().runtime, async (app) => {
    const threadId = 'nope'
    const input = [{ type: 'text', text: 'hi', text_elements: [] }]
    for (const [method, params] of [
      ['thread/read', { threadId }],
      ['thread/resume', { threadId }],
      ['turn/start', { threadId, input }],
      ['review/start', { threadId, target: { type: 'uncommittedChanges' } }],
      ['thread/compact/start', { threadId }],
      ['thread/settings/update', { threadId, model: 'opus' }],
      ['thread/metadata/update', { threadId, gitInfo: { branch: 'main' } }],
      ['thread/rollback', { threadId, numTurns: 1 }],
      ['thread/revert', { threadId, beforeTurnId: 'x' }],
      ['thread/goal/set', { threadId, objective: 'ship it' }],
      ['thread/queue/add', { threadId, input }],
      ['thread/inject_items', { threadId, items: [] }],
      ['thread/searchOccurrences', { threadId, searchTerm: 'x' }],
      ['thread/attachment/list', { threadId }],
      ['thread/section/move', { threadId, sectionId: null }],
    ] as const)
      await refused(app, method, params, /^unknown thread: nope$/)
  })
})

test('an unknown turn, cursor or id, and a bad parameter, are invalid requests', async () => {
  await withInProcessApp(holdingRuntime().runtime, async (app) => {
    const threadId = await app.startThread()
    await app.turnCompleted(await app.startTurn(threadId, 'hello'))

    await refused(app, 'thread/revert', { threadId, beforeTurnId: 'gone' }, /^unknown turn: gone$/)
    await refused(app, 'thread/turns/list', { threadId, cursor: 'gone' }, /invalid turn cursor/)
    await refused(app, 'thread/items/list', { threadId, turnId: 'gone' }, /turn not found: gone/)
    await refused(app, 'thread/attachment/list', { threadId, cursor: '-1' }, /invalid attachment/)
    await refused(app, 'threadSection/update', { sectionId: 'gone' }, /unknown section: gone/)
    await refused(
      app,
      'thread/section/move',
      { threadId, sectionId: 'gone' },
      /^unknown section: gone$/,
    )
    await refused(app, 'threadSection/delete', { sectionId: 'gone' }, /^unknown section: gone$/)
    await refused(
      app,
      'threadSection/delete',
      { sectionId: PINNED_SECTION_ID },
      /^the pinned section is reserved$/,
    )
    await refused(app, 'threadSection/create', { name: ' ' }, /^section name must not be empty$/)
    const created = await app.call('threadSection/create', { name: 'Work' })
    const { section } = created.result as { section: { id: string } }
    await refused(
      app,
      'threadSection/update',
      { sectionId: section.id, name: ' ' },
      /^section name must not be empty$/,
    )
    // Project errors keep the server error code; the App matches their text.
    await refused(
      app,
      'project/read',
      { projectId: 'gone' },
      /^project not found: gone$/,
      SERVER_ERROR,
    )
    await refused(app, 'thread/goal/set', { threadId, status: 'bogus' }, /invalid goal status/)
    await refused(app, 'thread/goal/set', { threadId, objective: ' ' }, /must not be empty/)
    await refused(
      app,
      'thread/goal/set',
      { threadId, objective: 'ship it', tokenBudget: -1 },
      /goal budgets must be positive integers/,
    )
    await refused(app, 'thread/goal/set', { threadId, status: 'paused' }, /no goal exists/)
    await refused(app, 'thread/queue/add', { threadId, input: [] }, /input must not be empty/)
    await refused(
      app,
      'thread/queue/start',
      { threadId, queuedSubmissionId: 'gone' },
      /unknown queued submission: gone/,
    )
    await refused(
      app,
      'thread/metadata/update',
      { threadId, gitInfo: {} },
      /gitInfo must include at least one field/,
    )
    await refused(app, 'command/exec', { command: [] }, /command\/exec requires command/)
    await refused(app, 'process/kill', { processHandle: 'gone' }, /unknown process handle: gone/)

    const ephemeral = await app.startThread({ ephemeral: true })
    await refused(
      app,
      'thread/queue/add',
      { threadId: ephemeral, input: [{ type: 'text', text: 'later', text_elements: [] }] },
      /queued messages require a persistent thread/,
    )
  })
})

test('a running turn refuses what it cannot change as invalid requests', async () => {
  const { runtime, release } = holdingRuntime()
  await withInProcessApp(
    runtime,
    async (app) => {
      const threadId = await app.startThread({ model: 'sonnet' })
      const turnId = await app.startTurn(threadId, 'hold on')
      await app.waitFor(() => app.notified('turn/started')[0])
      const update = (settings: Record<string, unknown>) => ({ threadId, turnId, ...settings })

      await refused(
        app,
        'turn/settings/update',
        update({ summary: 'detailed' }),
        /a running Claude turn cannot change summary/,
      )
      await refused(
        app,
        'turn/settings/update',
        update({ model: 'claude-opus-9' }),
        /^unknown model: claude-opus-9$/,
      )
      await refused(
        app,
        'turn/settings/update',
        update({ effort: 'extreme' }),
        /^unsupported effort: extreme$/,
      )
      await refused(
        app,
        'turn/settings/update',
        update({ model: 'gpt-5.5' }),
        /a running claude turn cannot switch to gpt-5\.5/,
      )
      // A runtime that cannot change a running turn is the server's failure.
      await refused(
        app,
        'turn/settings/update',
        update({ effort: 'high' }),
        /^this runtime cannot change the settings of a running turn$/,
        SERVER_ERROR,
      )
      // So is a turn that moved on: no error at all.
      assert.deepEqual(
        await app.request('turn/settings/update', { threadId, turnId: 'gone', effort: 'high' }),
        { status: 'targetUnavailable' },
      )

      await refused(
        app,
        'thread/queue/start',
        { threadId, queuedSubmissionId: 'gone' },
        /cannot start a queued message while thread .* has an active turn/,
      )
      await refused(
        app,
        'thread/rollback',
        { threadId, numTurns: 1 },
        /cannot rewind thread .* while a turn is running/,
      )
      release()
      await app.turnCompleted(turnId)
    },
    { env: { ...MODELS, CLAUDE_CODEX_DISABLE_CODEX_PROXY: '' } },
  )
})

// App rule: model-menu-settings
test('the model menu gets the reason a chat cannot take a model, as an invalid request', async () => {
  await withInProcessApp(
    holdingRuntime().runtime,
    async (app) => {
      const threadId = await app.startThread({ model: 'sonnet' })
      await app.turnCompleted(await app.startTurn(threadId, 'hello'))
      const crossing =
        /^cannot change runtime backend from claude to codex for gpt-5\.5; start a new thread$/
      await refused(app, 'thread/settings/update', { threadId, model: 'gpt-5.5' }, crossing)
      await refused(app, 'thread/metadata/update', { threadId, model: 'gpt-5.5' }, crossing)
      await refused(
        app,
        'turn/start',
        { threadId, model: 'gpt-5.5', input: [{ type: 'text', text: 'hi', text_elements: [] }] },
        crossing,
      )
      assert.equal(app.store.getThread(threadId)?.model, 'sonnet')
      // Another Claude model still applies.
      assert.deepEqual(await app.request('thread/settings/update', { threadId, model: 'opus' }), {})
      assert.equal(app.store.getThread(threadId)?.model, 'opus')
    },
    { env: { ...MODELS, CLAUDE_CODEX_DISABLE_CODEX_PROXY: '' } },
  )
})

test('a Codex model with Codex routing off is an invalid request', async () => {
  await withInProcessApp(
    holdingRuntime().runtime,
    async (app) => {
      const routingOff = /^Codex model routing is disabled, so gpt-5\.5 cannot run here/
      await refused(
        app,
        'thread/start',
        { cwd: process.cwd(), model: 'gpt-5.5', experimentalRawEvents: false },
        routingOff,
      )
      const threadId = await app.startThread({ model: 'sonnet' })
      await refused(
        app,
        'turn/start',
        { threadId, model: 'gpt-5.5', input: [{ type: 'text', text: 'hi', text_elements: [] }] },
        routingOff,
      )
    },
    { env: { ...MODELS, CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1' } },
  )
})
