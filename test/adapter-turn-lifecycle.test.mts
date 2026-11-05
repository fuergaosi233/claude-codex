import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'
import {
  adapter,
  awaitMessage,
  JsonLineReader,
  json,
  nextNotification,
  readQuiet,
  spawnMockAdapter,
  startMockThread,
  stopProcess,
  textInput,
  waitForExit,
} from './support/adapter-harness.mjs'

// Waits for `turns` turns to complete, then reads until the adapter stays quiet
// for `ms`: a slow runner still sees every expected turn, and a turn too many
// still shows up.
async function readTurns(reader: JsonLineReader, turns: number, ms: number): Promise<any[]> {
  const seen: any[] = []
  for (let i = 0; i < turns; i += 1) {
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
  }
  seen.push(...(await readQuiet(reader, ms)))
  return seen
}

function isUserMessageItem(message: any, method: string, clientId: string): boolean {
  return (
    message.method === method &&
    message.params.item.type === 'userMessage' &&
    message.params.item.clientId === clientId
  )
}

test('turn/steer appends user input to an active Claude turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)

    proc.stdin.write(
      json({ id: 2, method: 'turn/steer', params: { threadId, input: textInput('too early') } }),
    )
    const early = await reader.nextResponse(2)
    assert.equal(early.error.message, 'no active turn to steer')

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: textInput('slow turn for steering') },
      }),
    )
    const turnId = (await reader.nextResponse(3)).result.turn.id
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta')

    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: 'stale-turn', input: textInput('mismatch') },
      }),
    )
    const mismatch = await reader.nextResponse(4)
    assert.equal(
      mismatch.error.message,
      `expected active turn id \`stale-turn\` but found \`${turnId}\``,
    )

    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/steer',
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: 'client-steer-1',
          input: textInput('steered input'),
        },
      }),
    )
    const seen: any[] = []
    const steer = await awaitMessage(reader, (message) => message.id === 5, seen)
    assert.equal(steer.result.turnId, turnId)
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    // The accepted steer surfaces as a userMessage carrying the App's id, so
    // the App can settle its pending steering bubble.
    const started = seen.find((message) =>
      isUserMessageItem(message, 'item/started', 'client-steer-1'),
    )
    assert.equal(started?.params.turnId, turnId)
    assert.equal(started?.params.item.content[0].text, 'steered input')
    assert.ok(
      seen.some((message) => isUserMessageItem(message, 'item/completed', 'client-steer-1')),
    )

    proc.stdin.write(
      json({ id: 6, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    const items = await reader.nextResponse(6)
    assert.equal(
      items.result.data.some(
        (item: any) => item.type === 'userMessage' && item.content?.[0]?.text === 'steered input',
      ),
      true,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn/start during a running turn joins that turn instead of orphaning it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: textInput('hold this turn until released while another turn/start arrives'),
        },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta', seen)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, clientUserMessageId: 'client-late-1', input: textInput('late input') },
      }),
    )
    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/start',
        params: { threadId, input: textInput('/workflows') },
      }),
    )
    // The refusal can answer first: the joined input waits for Claude to take
    // it in.
    const replies = new Map<number, any>()
    await awaitMessage(
      reader,
      (message) => {
        if (message.id === 3 || message.id === 4) replies.set(message.id, message)
        return replies.size === 2
      },
      seen,
    )
    assert.equal(replies.get(3).result.turn.id, turnId)
    assert.equal(
      replies.get(4).error.message,
      '/workflows list can run once the current turn finishes',
    )
    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/steer',
        params: { threadId, expectedTurnId: turnId, input: textInput('release') },
      }),
    )
    const completed = await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed',
      seen,
    )
    assert.equal(completed.params.turn.id, turnId)
    seen.push(...(await readQuiet(reader, 200)))
    assert.deepEqual(
      seen
        .filter((message) => message.method === 'turn/started' && message.params.turn.id !== turnId)
        .map((message) => message.params.turn.id),
      [],
      'no second turn starts',
    )
    const joined = seen.find((message) =>
      isUserMessageItem(message, 'item/started', 'client-late-1'),
    )
    assert.equal(joined?.params.turnId, turnId)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('input for a turn whose session is still coming up waits for it instead of failing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('slow start, then hold this turn until released') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    // The runtime has no turn to steer into yet. Refusing the input here
    // would leave the App showing an error for a turn that runs fine.
    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, clientUserMessageId: 'client-early-1', input: textInput('release') },
      }),
    )
    const seen: any[] = []
    const reply = await awaitMessage(reader, (message) => message.id === 3, seen)
    assert.equal(reply.error, undefined)
    assert.equal(reply.result.turn.id, turnId)
    const completed = await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed',
      seen,
    )
    assert.equal(completed.params.turn.id, turnId)
    assert.equal(completed.params.turn.status, 'completed')
    const joined = seen.find((message) =>
      isUserMessageItem(message, 'item/started', 'client-early-1'),
    )
    assert.equal(joined?.params.turnId, turnId)
    seen.push(...(await readQuiet(reader, 200)))
    assert.deepEqual(
      seen
        .filter((message) => message.method === 'turn/started' && message.params.turn.id !== turnId)
        .map((message) => message.params.turn.id),
      [],
      'no second turn starts',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/queue holds follow-ups during a turn and dispatches them in order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('slow turn before the queue drains') },
      }),
    )
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta')

    const add = (id: number, text: string, clientUserMessageId: string) =>
      call(id, 'thread/queue/add', { threadId, input: textInput(text), clientUserMessageId })
    const first = (await add(3, 'queued one', 'client-1')).result.queuedSubmission
    const second = (await add(4, 'queued two', 'client-2')).result.queuedSubmission
    const third = (await add(5, 'queued three', 'client-3')).result.queuedSubmission
    assert.equal(first.clientUserMessageId, 'client-1')
    assert.deepEqual(first.input, textInput('queued one'))

    const empty = await call(6, 'thread/queue/add', { threadId, input: [] })
    assert.match(empty.error.message, /must not be empty/)

    await call(7, 'thread/queue/reorder', { threadId, queuedSubmissionIds: [second.id] })
    const edited = await call(8, 'thread/queue/update', {
      threadId,
      queuedSubmissionId: third.id,
      input: textInput('queued three edited'),
    })
    assert.deepEqual(edited.result.queuedSubmission.input, textInput('queued three edited'))
    const list = await call(9, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(
      list.result.data.map((entry: any) => entry.id),
      [second.id, first.id, third.id],
    )
    assert.equal(list.result.nextCursor, null)
    assert.equal(
      (await call(10, 'thread/queue/delete', { threadId, queuedSubmissionId: third.id })).result
        .deleted,
      true,
    )
    assert.equal(
      (await call(11, 'thread/queue/delete', { threadId, queuedSubmissionId: third.id })).result
        .deleted,
      false,
    )

    // The queue drains head first once the running turn settles: one user
    // turn per submission, each publishing its message with the client id.
    const seen: any[] = []
    let completedTurns = 0
    await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed' && ++completedTurns === 3,
      seen,
    )
    const userMessages = seen
      .filter(
        (message) =>
          message.method === 'item/started' && message.params.item.type === 'userMessage',
      )
      .map((message) => message.params.item.clientId)
    assert.deepEqual(userMessages, ['client-2', 'client-1'])
    assert.ok(seen.some((message) => message.method === 'thread/queue/changed'))

    const drained = await call(12, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(drained.result.data, [])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/queue pauses after an interrupt until thread/queue/start', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('slow turn that the user stops') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    await awaitMessage(reader, (message) => message.method === 'item/agentMessage/delta')
    const queued = (
      await call(3, 'thread/queue/add', {
        threadId,
        input: textInput('held message'),
        clientUserMessageId: 'client-held',
      })
    ).result.queuedSubmission
    await call(4, 'turn/interrupt', { threadId, turnId })

    const quiet = await readQuiet(reader, 400)
    assert.equal(
      quiet.some((message) => message.method === 'turn/started'),
      false,
    )
    const held = await call(5, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(
      held.result.data.map((entry: any) => entry.id),
      [queued.id],
    )

    const started = await call(6, 'thread/queue/start', {
      threadId,
      queuedSubmissionId: queued.id,
    })
    assert.equal(typeof started.result.turn.id, 'string')
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.ok(seen.some((message) => isUserMessageItem(message, 'item/started', 'client-held')))
    const drained = await call(7, 'thread/queue/list', { threadId, cursor: null })
    assert.deepEqual(drained.result.data, [])
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread/goal/set keeps the thread working until the model completes the goal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    const missing = await call(2, 'thread/goal/set', { threadId, status: 'paused' })
    assert.match(missing.error.message, /no goal exists/)

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/goal/set',
        params: { threadId, objective: 'goal complete check', status: 'active' },
      }),
    )
    const seen: any[] = []
    const set = await awaitMessage(reader, (message) => message.id === 3, seen)
    assert.equal(set.result.goal.status, 'active')
    assert.equal(set.result.goal.tokenBudget, null)
    const started = await awaitMessage(reader, (message) => message.method === 'turn/started', seen)
    const turnId = started.params.turn.id
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    const updates = seen
      .filter((message) => message.method === 'thread/goal/updated')
      .map((message) => message.params)
    const finished = updates.at(-1)
    assert.equal(finished.goal.status, 'complete')
    assert.equal(finished.goal.tokensUsed, 145)
    assert.equal(finished.turnId, turnId)
    // Claude reports usage with the result, after update_goal already marked
    // the goal complete; the turn's tokens still land on the goal.
    assert.equal(
      updates.filter((update) => update.goal.status === 'complete')[0].goal.tokensUsed,
      0,
    )

    // A completed goal ends the run; nothing else starts.
    const quiet = await readQuiet(reader, 400)
    assert.equal(
      quiet.some((message) => message.method === 'turn/started'),
      false,
    )
    // The continuation prompt is hidden: no user message on the turn.
    const items = await call(4, 'thread/turns/items/list', { threadId, turnId })
    assert.equal(
      items.result.data.some((item: any) => item.type === 'userMessage'),
      false,
    )
    const get = await call(5, 'thread/goal/get', { threadId })
    assert.equal(get.result.goal.status, 'complete')
    const clear = await call(6, 'thread/goal/clear', { threadId })
    assert.equal(clear.result.cleared, true)
    assert.equal((await call(7, 'thread/goal/get', { threadId })).result.goal, null)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('goal continuation stops when a hidden turn makes no progress or exhausts the budget', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  const countTurns = (messages: any[]) =>
    messages.filter((message) => message.method === 'turn/started').length
  try {
    const threadId = await startMockThread(reader, proc)
    await call(2, 'thread/goal/set', { threadId, objective: 'keep going', status: 'active' })
    // One hidden continuation with no tool work, then the run stops.
    const first = await readTurns(reader, 1, 500)
    assert.equal(countTurns(first), 1)
    assert.equal((await call(3, 'thread/goal/get', { threadId })).result.goal.status, 'active')

    // A user turn gives the goal another continuation.
    proc.stdin.write(
      json({ id: 4, method: 'turn/start', params: { threadId, input: textInput('nudge') } }),
    )
    const nudged = await readTurns(reader, 2, 500)
    assert.equal(countTurns(nudged), 2)

    // A budget the continuation overruns stops the goal.
    await call(5, 'thread/goal/set', { threadId, tokenBudget: 300, status: 'active' })
    const budgeted = await readTurns(reader, 1, 500)
    assert.equal(countTurns(budgeted), 1)
    const goal = (await call(6, 'thread/goal/get', { threadId })).result.goal
    assert.equal(goal.status, 'budgetLimited')
    assert.equal(goal.tokensUsed, 435)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a goal budget that runs out mid-turn steers the model to wrap up and ends the run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const call = async (id: number, method: string, params: Record<string, unknown>) => {
    proc.stdin.write(json({ id, method, params }))
    return reader.nextResponse(id)
  }
  try {
    const threadId = await startMockThread(reader, proc)
    await call(2, 'thread/goal/set', {
      threadId,
      objective: 'goal budget steer check',
      tokenBudget: 300,
      status: 'active',
    })
    const run = await readTurns(reader, 1, 600)
    assert.equal(run.filter((message) => message.method === 'turn/started').length, 1)
    const limitedAt = run.findIndex(
      (message) =>
        message.method === 'thread/goal/updated' && message.params.goal.status === 'budgetLimited',
    )
    const completedAt = run.findIndex((message) => message.method === 'turn/completed')
    assert.ok(limitedAt >= 0 && limitedAt < completedAt, 'the budget runs out inside the turn')
    assert.ok(
      run.some(
        (message) =>
          message.method === 'item/agentMessage/delta' &&
          message.params.delta === 'wrapping up on budget',
      ),
      'the running turn got the budget-limit steer',
    )
    const goal = (await call(3, 'thread/goal/get', { threadId })).result.goal
    assert.equal(goal.status, 'budgetLimited')
    // 420 streamed, then the result settles the turn at 510.
    assert.equal(goal.tokensUsed, 510)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('editing the goal objective mid-turn steers the running turn instead of starting another', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    const seen: any[] = []
    proc.stdin.write(
      json({
        id: 2,
        method: 'thread/goal/set',
        params: { threadId, objective: 'goal objective steer check', status: 'active' },
      }),
    )
    await awaitMessage(reader, (message) => message.method === 'turn/started', seen)
    const objective = 'goal objective steer check: revised objective'
    proc.stdin.write(json({ id: 3, method: 'thread/goal/set', params: { threadId, objective } }))
    const edit = await awaitMessage(
      reader,
      (message) => message.id === 3 && message.method == null,
      seen,
    )
    assert.equal(edit.result.goal.objective, objective)
    assert.equal(edit.result.goal.status, 'active')
    const ended = seen.some((message) => message.method === 'turn/completed')
    seen.push(...(await readTurns(reader, ended ? 0 : 1, 600)))

    assert.ok(
      seen.some(
        (message) =>
          message.method === 'item/agentMessage/delta' &&
          message.params.delta === 'now on the revised objective',
      ),
      'the running turn got the edited objective',
    )
    assert.equal(seen.filter((message) => message.method === 'turn/started').length, 1)
    assert.equal(seen.filter((message) => message.method === 'turn/completed').length, 1)
    assert.ok(
      !seen.some(
        (message) =>
          message.method === 'item/started' && message.params.item.type === 'userMessage',
      ),
      'the steer stays hidden',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('thread resume, fork, and interrupt lifecycle methods are stable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'session check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    for (let i = 0; i < 500; i += 1) {
      const message = await reader.next()
      if (message.method === 'turn/completed') break
    }

    proc.stdin.write(json({ id: 3, method: 'thread/resume', params: { threadId } }))
    const resume = await reader.nextResponse(3)
    assert.equal(resume.result.thread.id, threadId)
    assert.equal(resume.result.thread.turns.length, 1)

    proc.stdin.write(
      json({ id: 4, method: 'thread/fork', params: { threadId, persistExtendedHistory: false } }),
    )
    const fork = await reader.nextResponse(4)
    assert.equal(fork.result.thread.forkedFromId, threadId)
    assert.equal(fork.result.thread.sessionId, resume.result.thread.sessionId)

    proc.stdin.write(json({ id: 5, method: 'turn/interrupt', params: { threadId } }))
    const interrupt = await reader.nextResponse(5)
    assert.deepEqual(interrupt.result, {})
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('turn interrupt completes requested in-progress turn after reconnect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { randomUUID } from 'node:crypto'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const threadId = randomUUID()
      const turnId = randomUUID()
      const now = Math.floor(Date.now() / 1000)
      store.upsertThread({
        id: threadId,
        sessionId: randomUUID(),
        forkedFromId: null,
        preview: 'interrupt me',
        name: null,
        archived: false,
        cwd: process.cwd(),
        model: 'opus',
        reasoningEffort: 'medium',
        modelProvider: 'claude-code',
        claudeSessionId: null,
        source: 'user',
        createdAt: now,
        updatedAt: now,
        status: { type: 'active', activeFlags: [] },
        approvalPolicy: null,
        sandboxMode: null,
        ephemeral: false,
        threadSource: 'user',
        agentRole: null,
        agentNickname: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        runtimeBackend: 'claude',
        codexSessionId: null,
      })
      store.upsertTurn({
        id: turnId,
        threadId,
        status: 'inProgress',
        startedAt: now,
        completedAt: null,
        durationMs: null,
        items: [],
        diff: '',
        error: null,
      })
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt(id) {
          interrupted.push(id)
        },
        async stop() {},
      })
      const messages = []
      const peer = {
        id: 'peer',
        send(message) {
          messages.push(message)
        },
        close() {},
      }
      await server.handle(peer, { id: 1, method: 'turn/interrupt', params: { threadId, turnId } })
      assert.deepEqual(interrupted, [threadId])
      assert.equal(store.getTurn(turnId)?.status, 'interrupted')
      assert.equal(store.getThread(threadId)?.status.type, 'idle')
      const completed = messages.find((message) => 'method' in message && message.method === 'turn/completed')
      assert.equal(completed?.params.turn.id, turnId)
      assert.equal(completed?.params.turn.status, 'interrupted')
      const status = messages.find((message) => 'method' in message && message.method === 'thread/status/changed')
      assert.deepEqual(status?.params.status, { type: 'idle' })
      const response = messages.find((message) => 'id' in message && message.id === 1)
      assert.deepEqual(response?.result, {})
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('runtime settlement cannot overwrite an interrupted turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const controls = new Map()
      const controlsByThread = new Map()
      const outcomes = new Map()
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'active-' + context.turnId,
            toolName: 'Task',
            input: { description: 'active subagent', prompt: 'wait for interruption' },
          })
          return new Promise((resolve, reject) => {
            const control = { resolve, reject }
            controls.set(context.turnId, control)
            controlsByThread.set(context.threadId, control)
          })
        },
        async steer() {},
        async interrupt(threadId) {
          const control = controlsByThread.get(threadId)
          if (outcomes.get(threadId) === 'resolve') control.resolve()
          else control.reject(new Error('runtime rejected during interrupt'))
          await new Promise((resolve) => setTimeout(resolve, 10))
        },
        async stop() {},
      })
      const messages = []
      const peer = {
        id: 'peer',
        send(message) {
          messages.push({ ...message, deliveredTo: 'peer' })
        },
        close() {},
      }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for runtime control')
      }

      let requestId = 0
      for (const outcome of ['resolve', 'reject']) {
        await server.handle(peer, {
          id: ++requestId,
          method: 'thread/start',
          params: { cwd: process.cwd(), persistExtendedHistory: false },
        })
        const threadId = response(requestId).result.thread.id
        await server.handle(peer, {
          id: ++requestId,
          method: 'turn/start',
          params: {
            threadId,
            input: [{ type: 'text', text: 'interrupt workflow', text_elements: [] }],
          },
        })
        const turnId = response(requestId).result.turn.id
        await waitFor(() => controls.has(turnId))
        outcomes.set(threadId, outcome)
        const interruptPeer = {
          id: 'peer-reconnected',
          send(message) {
            messages.push({ ...message, deliveredTo: 'peer-reconnected' })
          },
          close() {},
        }
        server.closePeer(peer)
        await server.handle(interruptPeer, {
          id: ++requestId,
          method: 'thread/resume',
          params: { threadId },
        })
        await server.handle(interruptPeer, {
          id: ++requestId,
          method: 'turn/interrupt',
          params: { threadId, turnId },
        })
        await new Promise((resolve) => setTimeout(resolve, 25))

        assert.equal(store.getTurn(turnId)?.status, 'interrupted')
        const completions = messages.filter(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        )
        assert.equal(completions.length, 1)
        assert.equal(completions[0].params.turn.status, 'interrupted')
        const interruptedActivityIndex = messages.findIndex(
          (message) =>
            'method' in message &&
            message.method === 'item/completed' &&
            message.params.turnId === turnId &&
            message.params.item.type === 'subAgentActivity' &&
            message.params.item.kind === 'interrupted',
        )
        const terminalIndex = messages.findIndex(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        )
        assert.ok(interruptedActivityIndex >= 0)
        assert.ok(interruptedActivityIndex < terminalIndex)
        assert.equal(messages[interruptedActivityIndex].deliveredTo, 'peer-reconnected')
        assert.equal(messages[terminalIndex].deliveredTo, 'peer-reconnected')
        assert.equal(
          messages
            .filter(
              (message) =>
                'method' in message &&
                message.method === 'item/completed' &&
                message.params.turnId === turnId &&
                message.params.item.type === 'collabAgentToolCall' &&
                message.params.item.tool === 'wait',
            )
            .every((message) => message.deliveredTo === 'peer-reconnected'),
          true,
        )
        assert.equal(
          messages.some(
            (message) =>
              'method' in message &&
              message.method === 'error' &&
              message.params.turnId === turnId,
          ),
          false,
        )
      }
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('subagent watchdog terminalizes a runtime that never returns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'stuck-' + context.turnId,
            toolName: 'Task',
            input: { description: 'stuck subagent', prompt: 'never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for watchdog')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hang', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )

      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /terminal result within 1 second/)
      assert.equal(interrupted.length, 1)
      const child = store
        .listThreads({ includeEphemeral: true })
        .find((candidate) => candidate.threadSource === 'subagent')
      assert.ok(child)
      assert.equal(store.listTurns(child.id)[0].status, 'failed')
      assert.equal(store.listTurns(threadId)[0].items.at(-1).status, 'failed')
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('workflow watchdog terminalizes a launch that never publishes a result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const interrupted = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'workflow-' + context.turnId,
            toolName: 'Workflow',
            input: { command: '/workflows never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for workflow watchdog')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows hang', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )
      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /terminal result within 1 second/)
      assert.equal(interrupted.length, 1)
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'item/started' &&
            message.params.item.type === 'collabAgentToolCall',
        ),
        false,
        'a Workflow launch without projected agents must not fabricate a child card',
      )
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('workflow watchdog disarms when the original Workflow tool result arrives', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '100'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          const toolUseId = 'workflow-launch-' + context.turnId
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Workflow',
            input: { command: '/workflows slow result' },
          })
          await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'launch accepted' })
          await new Promise((resolve) => setTimeout(resolve, 250))
          await handlers.onEvent({ type: 'completed', success: true, result: 'workflow done' })
        },
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for original Workflow result')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: '/workflows slow', text_elements: [] }] },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/completed' &&
            message.params.turn.id === turnId,
        ),
      )
      const completed = messages.find(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completed.params.turn.status, 'completed')
      assert.equal(completed.params.turn.error, null)
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Runs `body` in a child process whose subagent watchdog waits `windowMs`.
// The body builds a server on `store` with the runtime it needs; it gets the
// peer's messages (`receivedAt` holds when each arrived, on the monotonic
// clock) and helpers to start a turn, find its turn/completed and read a
// child agent's status by prompt.
async function runWatchdogScript(windowMs: number, body: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { NativeClaudeRuntime } from './dist/src/native-runtime.mjs'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      process.env.CLAUDE_CODEX_SUBAGENT_TIMEOUT_MS = '${windowMs}'
      process.env.CLAUDE_CODEX_GOAL_TOOLS = '0'
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const messages = []
      const receivedAt = new Map()
      const peer = {
        id: 'peer',
        send: (message) => {
          messages.push(message)
          receivedAt.set(message, performance.now())
        },
        close() {},
      }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const completion = (turnId) =>
        messages.find(
          (message) => message.method === 'turn/completed' && message.params.turn.id === turnId,
        )
      const waitFor = async (probe, label, timeoutMs = 5000) => {
        const deadline = performance.now() + timeoutMs
        while (performance.now() < deadline) {
          const value = probe()
          if (value) return value
          await sleep(10)
        }
        throw new Error('timed out waiting for ' + label)
      }
      const children = () =>
        store
          .listThreads({ includeEphemeral: true })
          .filter((thread) => thread.threadSource === 'subagent')
      const childStatus = (prompt) => {
        const child = children().find((thread) => thread.preview === prompt)
        return child ? store.listTurns(child.id)[0]?.status : 'missing'
      }
      const startTurn = async (server, text) => {
        await server.handle(peer, {
          id: 1,
          method: 'thread/start',
          params: { cwd: process.cwd(), persistExtendedHistory: false },
        })
        const threadId = response(1).result.thread.id
        await server.handle(peer, {
          id: 2,
          method: 'turn/start',
          params: { threadId, input: [{ type: 'text', text, text_elements: [] }] },
        })
        return { threadId, turnId: response(2).result.turn.id }
      }
      ${body}
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

test('subagent watchdog waits as long as a foreground agent keeps reporting progress', async () => {
  await runWatchdogScript(
    300,
    `
      const interrupted = []
      let listener = null
      const server = new CodexClaudeAppServer(store, {
        setBackgroundListener(next) {
          listener = next
        },
        async runTurn(context, handlers) {
          const toolUseId = 'busy-' + context.turnId
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Task',
            input: { description: 'long check', prompt: 'run the long check' },
          })
          // Either kind of report alone spans two windows.
          for (let beat = 0; beat < 6; beat += 1) {
            await sleep(100)
            await handlers.onEvent({ type: 'subagent_progress', toolUseId })
          }
          for (let beat = 0; beat < 6; beat += 1) {
            await sleep(100)
            await listener.onTaskEvent(context.threadId, {
              type: 'task_progress',
              taskId: 'task-1',
              toolUseId,
              description: 'long check',
              summary: null,
              lastToolName: 'Bash',
              usage: null,
            })
          }
          await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'all checks passed' })
          await handlers.onEvent({ type: 'completed', success: true, result: 'checked' })
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const { turnId } = await startTurn(server, 'check everything')
      const completed = await waitFor(() => completion(turnId), 'turn completion')
      assert.equal(completed.params.turn.status, 'completed')
      assert.equal(completed.params.turn.error, null)
      assert.deepEqual(interrupted, [])
      assert.equal(childStatus('run the long check'), 'completed')
      await server.stop()
    `,
  )
})

test('subagent watchdog does not take a jump of the wall clock for a quiet agent', async () => {
  await runWatchdogScript(
    300,
    `
      const interrupted = []
      const wallClock = Date.now
      let jumpedMs = 0
      Date.now = () => wallClock() + jumpedMs
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          const toolUseId = 'busy-' + context.turnId
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Task',
            input: { description: 'long check', prompt: 'run the long check' },
          })
          // The wall clock leaps an hour ahead after every report, as when a
          // laptop wakes from sleep; the agent itself never goes quiet.
          for (let beat = 0; beat < 6; beat += 1) {
            await sleep(100)
            await handlers.onEvent({ type: 'subagent_progress', toolUseId })
            jumpedMs += 3_600_000
          }
          await handlers.onEvent({ type: 'tool_result', toolUseId, content: 'all checks passed' })
          await handlers.onEvent({ type: 'completed', success: true, result: 'checked' })
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const { turnId } = await startTurn(server, 'check everything')
      const completed = await waitFor(() => completion(turnId), 'turn completion')
      assert.equal(completed.params.turn.status, 'completed')
      assert.equal(completed.params.turn.error, null)
      assert.deepEqual(interrupted, [])
      await server.stop()
      Date.now = wallClock
    `,
  )
})

test('workflow watchdog waits while overlapping workflow agents keep starting and finishing', async () => {
  // A tick is a twelfth of the window, so a slow machine that stretches one
  // still leaves the next start or finish well inside it; each agent runs
  // fourteen ticks, longer than the window however slow the ticks are.
  const windowMs = 1_200
  await runWatchdogScript(
    windowMs,
    `
      const interrupted = []
      const ranMs = []
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          const launch = 'workflow-' + context.turnId
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: launch,
            toolName: 'Workflow',
            input: { command: '/workflows review' },
          })
          await handlers.onEvent({ type: 'tool_result', toolUseId: launch, content: 'launch accepted' })
          // Projected from the workflow journal: twenty agents, each running
          // longer than the window and always one running, while one starts
          // or finishes every tick.
          const agents = 20
          const runsTicks = 14
          const agent = (index) => 'workflow-agent:task-1:a' + index
          const startedAt = []
          for (let tick = 0; tick < agents + runsTicks; tick += 1) {
            if (tick < agents) {
              startedAt[tick] = performance.now()
              await handlers.onEvent({
                type: 'tool_use',
                toolUseId: agent(tick),
                toolName: 'Agent',
                input: {
                  description: 'part ' + tick,
                  prompt: 'review part ' + tick,
                  subagent_type: 'workflow',
                },
              })
            }
            if (tick >= runsTicks) {
              const index = tick - runsTicks
              await handlers.onEvent({
                type: 'tool_result',
                toolUseId: agent(index),
                content: 'part ' + index + ' reviewed',
              })
              ranMs.push(performance.now() - startedAt[index])
            }
            await sleep(100)
          }
          await handlers.onEvent({ type: 'completed', success: true, result: 'review done' })
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async stop() {},
      })
      const { turnId } = await startTurn(server, '/workflows review')
      const completed = await waitFor(() => completion(turnId), 'turn completion', 60_000)
      assert.equal(completed.params.turn.status, 'completed')
      assert.equal(completed.params.turn.error, null)
      assert.deepEqual(interrupted, [])
      assert.equal(ranMs.length, 20)
      for (const ran of ranMs) assert.ok(ran > ${windowMs}, 'an agent ran ' + ran + ' ms')
      for (let index = 0; index < 20; index += 1)
        assert.equal(childStatus('review part ' + index), 'completed')
      await server.stop()
    `,
  )
})

test('subagent watchdog fails a turn whose agent goes quiet for a whole window', async () => {
  await runWatchdogScript(
    300,
    `
      const interrupted = []
      const abandoned = []
      let turnHandlers = null
      let lastProgressAt = 0
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          turnHandlers = handlers
          const toolUseId = 'quiet-' + context.turnId
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId,
            toolName: 'Task',
            input: { description: 'flaky check', prompt: 'goes quiet' },
          })
          for (let beat = 0; beat < 4; beat += 1) {
            await sleep(100)
            await handlers.onEvent({ type: 'subagent_progress', toolUseId })
            lastProgressAt = performance.now()
          }
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        // The turn handed nothing off: the backend leaves it to an interrupt.
        async abandonTurn(_threadId, turnId) {
          abandoned.push(turnId)
          return false
        },
        async stop() {},
      })
      const startedAt = performance.now()
      const { threadId, turnId } = await startTurn(server, 'check, then hang')
      const completed = await waitFor(() => completion(turnId), 'watchdog')
      const failedAt = receivedAt.get(completed)
      assert.equal(completed.params.turn.status, 'failed')
      assert.match(completed.params.turn.error.message, /terminal result within 1 second/)
      assert.ok(failedAt - startedAt >= 650, 'each report starts the window over')
      assert.ok(failedAt - lastProgressAt >= 250, 'the turn fails a window after the last report')
      await waitFor(() => interrupted.length === 1, 'interrupt')
      assert.deepEqual(abandoned, [turnId])
      assert.equal(childStatus('goes quiet'), 'failed')
      assert.equal(store.listTurns(threadId)[0].items.at(-1).status, 'failed')
      // A frame the runtime still delivers does not bring the turn back.
      await turnHandlers.onEvent({
        type: 'tool_use',
        toolUseId: 'late',
        toolName: 'Task',
        input: { description: 'late', prompt: 'too late' },
      })
      assert.equal(children().length, 1)
      await server.stop()
    `,
  )
})

test('subagent watchdog leaves the background agents a stalled turn handed off running', async () => {
  await runWatchdogScript(
    300,
    `
      const interrupted = []
      const abandoned = []
      let listener = null
      const server = new CodexClaudeAppServer(store, {
        setBackgroundListener(next) {
          listener = next
        },
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'bg-use',
            toolName: 'Agent',
            input: { description: 'survey', prompt: 'survey the code', run_in_background: true },
          })
          await listener.onTaskEvent(context.threadId, {
            type: 'task_started',
            taskId: 'bg-task',
            toolUseId: 'bg-use',
            taskType: 'local_agent',
            description: 'survey',
            subagentType: null,
            prompt: 'survey the code',
            backgrounded: true,
          })
          await handlers.onEvent({
            type: 'tool_result',
            toolUseId: 'bg-use',
            content: 'Async agent launched successfully. agentId: bg-task',
            structured: { status: 'async_launched', agentId: 'bg-task', isAsync: true },
          })
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'stuck-use',
            toolName: 'Agent',
            input: { description: 'stuck', prompt: 'never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        // The session still runs the background agent: the backend lets the
        // turn go without interrupting Claude.
        async abandonTurn(_threadId, turnId) {
          abandoned.push(turnId)
          return true
        },
        async stop() {},
      })
      const { threadId, turnId } = await startTurn(server, 'survey in the background, then check')
      // The background agent reports all along; that is no sign of the stuck one.
      const beats = setInterval(() => {
        void listener.onTaskEvent(threadId, {
          type: 'task_progress',
          taskId: 'bg-task',
          toolUseId: 'bg-use',
          description: 'survey',
          summary: null,
          lastToolName: 'Grep',
          usage: null,
        })
      }, 100)
      try {
        const completed = await waitFor(() => completion(turnId), 'watchdog')
        assert.equal(completed.params.turn.status, 'failed')
        assert.match(completed.params.turn.error.message, /terminal result within 1 second/)
        await waitFor(() => abandoned.length === 1, 'abandon')
        assert.deepEqual(abandoned, [turnId])
        assert.deepEqual(interrupted, [], 'an interrupt would end the background agent too')
        assert.equal(childStatus('never returns'), 'failed')
        assert.equal(childStatus('survey the code'), 'inProgress')
      } finally {
        clearInterval(beats)
      }
      await listener.onTaskEvent(threadId, {
        type: 'task_notification',
        taskId: 'bg-task',
        toolUseId: 'bg-use',
        status: 'completed',
        summary: 'Agent "survey" completed',
        result: 'Found three modules.',
        usage: null,
      })
      assert.equal(childStatus('survey the code'), 'completed')
      await server.stop()
    `,
  )
})

test('subagent watchdog does not take background agents finishing for progress of a stuck one', async () => {
  await runWatchdogScript(
    300,
    `
      const interrupted = []
      const abandoned = []
      let listener = null
      const server = new CodexClaudeAppServer(store, {
        setBackgroundListener(next) {
          listener = next
        },
        async runTurn(context, handlers) {
          for (let index = 0; index < 10; index += 1) {
            const toolUseId = 'bg-use-' + index
            await handlers.onEvent({
              type: 'tool_use',
              toolUseId,
              toolName: 'Agent',
              input: {
                description: 'survey ' + index,
                prompt: 'survey part ' + index,
                run_in_background: true,
              },
            })
            await listener.onTaskEvent(context.threadId, {
              type: 'task_started',
              taskId: 'bg-task-' + index,
              toolUseId,
              taskType: 'local_agent',
              description: 'survey ' + index,
              subagentType: null,
              prompt: 'survey part ' + index,
              backgrounded: true,
            })
            await handlers.onEvent({
              type: 'tool_result',
              toolUseId,
              content: 'Async agent launched successfully. agentId: bg-task-' + index,
              structured: { status: 'async_launched', agentId: 'bg-task-' + index, isAsync: true },
            })
          }
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'stuck-use',
            toolName: 'Agent',
            input: { description: 'stuck', prompt: 'never returns' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt(threadId) {
          interrupted.push(threadId)
        },
        async abandonTurn(_threadId, turnId) {
          abandoned.push(turnId)
          return true
        },
        async stop() {},
      })
      const { threadId, turnId } = await startTurn(server, 'survey in the background, then check')
      await waitFor(() => childStatus('never returns') === 'inProgress', 'stuck agent')
      // The agents the turn handed off finish one by one, faster than the
      // window; none of that is a sign of life from the stuck one.
      let finished = 0
      while (!completion(turnId) && finished < 10) {
        await sleep(100)
        await listener.onTaskEvent(threadId, {
          type: 'task_notification',
          taskId: 'bg-task-' + finished,
          toolUseId: 'bg-use-' + finished,
          status: 'completed',
          summary: 'Agent "survey ' + finished + '" completed',
          result: 'Part ' + finished + ' surveyed.',
          usage: null,
        })
        finished += 1
      }
      const completed = await waitFor(() => completion(turnId), 'watchdog')
      assert.equal(completed.params.turn.status, 'failed')
      assert.ok(finished < 10, 'the turn fails while the agents it handed off still finish')
      await waitFor(() => abandoned.length === 1, 'abandon')
      assert.deepEqual(interrupted, [])
      assert.equal(childStatus('never returns'), 'failed')
      assert.equal(childStatus('survey part 0'), 'completed')
      await server.stop()
    `,
  )
})

test('subagent watchdog counts tool_progress heartbeats of a quiet agent as progress', async () => {
  await runWatchdogScript(
    600,
    `
      const runtime = new NativeClaudeRuntime()
      let interrupts = 0
      // The CLI's frames: an Agent call whose only sign of life is
      // tool_progress, first for the subagent's quiet Bash call, then for the
      // Agent call itself. Either kind alone spans two windows.
      const frames = async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-1' }
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'm1',
            content: [
              {
                type: 'tool_use',
                id: 'agent-1',
                name: 'Agent',
                input: { description: 'slow build', prompt: 'run the slow build' },
              },
            ],
          },
        }
        for (let beat = 0; beat < 24; beat += 1) {
          await sleep(100)
          yield beat < 12
            ? {
                type: 'tool_progress',
                tool_use_id: 'bash-1',
                tool_name: 'Bash',
                parent_tool_use_id: 'agent-1',
                elapsed_time_seconds: beat / 10,
              }
            : {
                type: 'tool_progress',
                tool_use_id: 'agent-1',
                tool_name: 'Agent',
                parent_tool_use_id: null,
                elapsed_time_seconds: beat / 10,
              }
        }
        yield {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'build passed' }],
          },
        }
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'm2', content: [{ type: 'text', text: 'The build passed.' }] },
        }
        yield { type: 'result', subtype: 'success', result: 'The build passed.' }
      }
      Reflect.set(runtime, 'sdk', {
        query: ({ prompt }) => {
          void (async () => {
            for await (const _message of prompt) {
            }
          })()
          return Object.assign(frames(), {
            interrupt: async () => {
              interrupts += 1
            },
            close() {},
            setModel: async () => {},
            setPermissionMode: async () => {},
          })
        },
      })
      const server = new CodexClaudeAppServer(store, runtime)
      const { turnId } = await startTurn(server, 'build it')
      const completed = await waitFor(() => completion(turnId), 'turn completion')
      assert.equal(completed.params.turn.status, 'completed')
      assert.equal(completed.params.turn.error, null)
      assert.equal(interrupts, 0)
      assert.equal(childStatus('run the slow build'), 'completed')
      await server.stop()
    `,
  )
})

test('server shutdown terminalizes active child turns before closing the store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const database = join(home, 'state.sqlite')
  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(${JSON.stringify(database)})
      const server = new CodexClaudeAppServer(store, {
        async runTurn(context, handlers) {
          await handlers.onEvent({
            type: 'tool_use',
            toolUseId: 'shutdown-child-' + context.turnId,
            toolName: 'Task',
            input: { description: 'child survives shutdown', prompt: 'investigate shutdown' },
          })
          return new Promise(() => {})
        },
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('timed out waiting for child creation')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const parentThreadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId: parentThreadId, input: [{ type: 'text', text: 'hang', text_elements: [] }] },
      })
      await waitFor(() =>
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'item/completed' &&
            message.params.item?.tool === 'spawnAgent',
        ),
      )
      await server.stop()

      const reopened = new SessionStore(${JSON.stringify(database)})
      try {
        const child = reopened
          .listThreads({ includeEphemeral: true })
          .find((candidate) => candidate.threadSource === 'subagent')
        assert.ok(child)
        assert.equal(reopened.listTurns(child.id)[0].status, 'failed')
        assert.equal(reopened.listTurns(parentThreadId)[0].status, 'interrupted')
        assert.equal(reopened.listTurns(parentThreadId)[0].items.at(-1).status, 'failed')
        assert.equal(
          reopened.listThreads({ includeEphemeral: true }).flatMap((thread) => reopened.listTurns(thread.id)).some((turn) => turn.status === 'inProgress'),
          false,
        )
      } finally {
        reopened.close()
      }
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// A repo whose `git diff` blocks until the release file exists, so a test can
// act while the adapter waits on a turn's diff. The done file marks its return.
async function blockingGitDiff(home: string): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
  const repo = join(home, 'repo')
  const bin = join(home, 'bin')
  await mkdir(repo, { recursive: true })
  await mkdir(bin, { recursive: true })
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const fakeGit = join(bin, 'git')
  await writeFile(
    fakeGit,
    [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then',
      "  printf 'true\\n'",
      '  exit 0',
      'fi',
      'if [ "$1" = "diff" ]; then',
      '  : > "$CLAUDE_CODEX_TEST_GIT_DIFF_STARTED"',
      '  while [ ! -f "$CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE" ]; do sleep 0.01; done',
      "  printf 'diff --git a/file b/file\\n--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-old\\n+new\\n'",
      '  : > "$CLAUDE_CODEX_TEST_GIT_DIFF_DONE"',
      '  exit 0',
      'fi',
      'exec "$CLAUDE_CODEX_REAL_GIT" "$@"',
      '',
    ].join('\n'),
  )
  await chmod(fakeGit, 0o755)
  return {
    repo,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CLAUDE_CODEX_REAL_GIT: realGit,
      CLAUDE_CODEX_TEST_GIT_DIFF_STARTED: join(home, 'git-diff-started'),
      CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE: join(home, 'git-diff-release'),
      CLAUDE_CODEX_TEST_GIT_DIFF_DONE: join(home, 'git-diff-done'),
    },
  }
}

test('interrupt during final git diff cannot overwrite an interrupted turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const { repo, env } = await blockingGitDiff(home)

  try {
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import { existsSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for final git diff')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: ${JSON.stringify(repo)}, persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'interrupt during final diff', text_elements: [] }],
        },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() => existsSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_STARTED))

      await server.handle(peer, {
        id: 3,
        method: 'turn/interrupt',
        params: { threadId, turnId },
      })
      writeFileSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE, 'continue')
      // Assert only once the diff has returned, so its late result is what
      // gets checked rather than a loaded machine's slow fake git.
      await waitFor(() => existsSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_DONE))
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(store.getTurn(turnId)?.status, 'interrupted')
      const completions = messages.filter(
        (message) =>
          'method' in message &&
          message.method === 'turn/completed' &&
          message.params.turn.id === turnId,
      )
      assert.equal(completions.length, 1)
      assert.equal(completions[0].params.turn.status, 'interrupted')
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'turn/diff/updated' &&
            message.params.turnId === turnId,
        ),
        false,
      )
      assert.equal(
        messages.some(
          (message) =>
            'method' in message &&
            message.method === 'error' &&
            message.params.turnId === turnId,
        ),
        false,
      )
      await server.stop()
    `,
      ],
      { cwd: resolve('.'), stdio: 'pipe', env },
    )
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop during final git diff leaves the closed store alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const { repo, env } = await blockingGitDiff(home)

  try {
    // The diff finishes after stop() closed SQLite. A turn that touched the
    // store then would throw from its failure path and crash the process.
    const turnId = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { existsSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const store = new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite'))
      const server = new CodexClaudeAppServer(store, {
        async runTurn() {},
        async steer() {},
        async interrupt() {},
        async stop() {},
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)
      const waitFor = async (condition) => {
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        throw new Error('timed out waiting for final git diff')
      }

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: ${JSON.stringify(repo)}, persistExtendedHistory: false },
      })
      const threadId = response(1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'stop during final diff', text_elements: [] }],
        },
      })
      const turnId = response(2).result.turn.id
      await waitFor(() => existsSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_STARTED))

      await server.stop()
      writeFileSync(process.env.CLAUDE_CODEX_TEST_GIT_DIFF_RELEASE, 'continue')
      process.stdout.write(turnId)
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe', env },
    )

    const store = new SessionStore(join(home, 'state.sqlite'))
    try {
      const turn = store.getTurn(turnId)
      assert.equal(turn?.status, 'interrupted')
      assert.equal(turn?.diff, '')
    } finally {
      store.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('adapter exits on SIGTERM even when stopping fails to record the running turn', {
  timeout: 30_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false, permissions: ':workspace' },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    // The turn stays in progress until its approval is answered.
    await nextNotification(reader, 'item/commandExecution/requestApproval')

    // With its database deleted, stop() cannot record the interrupted turn,
    // as when a test removes the adapter's home before the signal lands.
    await rm(join(home, 'claude-codex-adapter', 'state.sqlite'))
    proc.kill('SIGTERM')
    assert.equal(await waitForExit(proc, 20_000), 1, 'the adapter must not linger')
    assert.match(stderr, /\[claude-codex-adapter\] shutdown failed: /)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop still stops the runtime when the running turn cannot be recorded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const result = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { rmSync } from 'node:fs'
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const dbPath = join(${JSON.stringify(home)}, 'state.sqlite')
      let runtimeStopped = false
      const server = new CodexClaudeAppServer(new SessionStore(dbPath), {
        runTurn: () => new Promise(() => {}),
        async steer() {},
        async interrupt() {},
        async stop() {
          runtimeStopped = true
        },
      })
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)

      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: {
          threadId: response(1).result.thread.id,
          input: [{ type: 'text', text: 'never finishes', text_elements: [] }],
        },
      })
      rmSync(dbPath)
      const error = await server.stop().then(
        () => null,
        (error) => error.message,
      )
      process.stdout.write(JSON.stringify({ error, runtimeStopped }))
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe' },
    )
    const { error, runtimeStopped } = JSON.parse(result)
    assert.notEqual(error, null, 'recording the interrupted turn fails without its database')
    assert.equal(runtimeStopped, true)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop keeps a queued turn, review or compaction from starting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const result = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      const launches = []
      const server = new CodexClaudeAppServer(
        new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite')),
        {
          runTurn: (context) => {
            launches.push(context.purpose)
            return new Promise(() => {})
          },
          async steer() {},
          async interrupt() {},
          async stop() {},
        },
      )
      const messages = []
      const peer = { id: 'peer', send: (message) => messages.push(message), close() {} }
      const response = (id) => messages.find((message) => 'id' in message && message.id === id)

      const threadIds = []
      for (const id of [1, 2, 3]) {
        await server.handle(peer, {
          id,
          method: 'thread/start',
          params: { cwd: process.cwd(), persistExtendedHistory: false },
        })
        threadIds.push(response(id).result.thread.id)
      }
      // Each of these answers first and starts on the next tick, after stop().
      await server.handle(peer, {
        id: 4,
        method: 'turn/start',
        params: {
          threadId: threadIds[0],
          input: [{ type: 'text', text: 'never starts', text_elements: [] }],
        },
      })
      await server.handle(peer, {
        id: 5,
        method: 'review/start',
        params: {
          threadId: threadIds[1],
          delivery: 'inline',
          target: { type: 'custom', instructions: 'never starts' },
        },
      })
      await server.handle(peer, {
        id: 6,
        method: 'thread/compact/start',
        params: { threadId: threadIds[2] },
      })
      await server.stop()
      await new Promise((resolve) => setTimeout(resolve, 100))
      process.stdout.write(JSON.stringify({ launches }))
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe' },
    )
    assert.deepEqual(JSON.parse(result).launches, [], 'nothing reaches Claude after stop')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
