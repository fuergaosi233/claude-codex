import assert from 'node:assert/strict'
import test from 'node:test'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

test('thread shell commands emit a standalone turn and item lifecycle but hide the item in history', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      assert.deepEqual(
        await app.request('thread/shellCommand', {
          threadId,
          command: 'printf shell-output; printf shell-error >&2; exit 3',
        }),
        {},
      )
      const completed = await app.waitFor(() =>
        app.notified('item/completed').find((event) => event.item.source === 'userShell'),
      )
      const item = completed.item
      assert.equal(completed.threadId, threadId)
      assert.equal(item.type, 'commandExecution')
      assert.equal(item.exitCode, 3)
      assert.equal(item.status, 'failed')
      assert.equal(item.cwd, app.home)
      assert.match(item.aggregatedOutput, /shell-output/)
      assert.match(item.aggregatedOutput, /shell-error/)
      assert.equal(typeof item.durationMs, 'number')
      assert.ok(item.durationMs >= 0)
      const started = app.notified('item/started').find((event) => event.item.id === item.id)
      assert.equal(started.item.status, 'inProgress')
      assert.equal(started.item.source, 'userShell')
      assert.equal(started.turnId, completed.turnId)
      const deltas = app
        .notified('item/commandExecution/outputDelta')
        .filter((event) => event.itemId === item.id)
      assert.ok(deltas.length > 0)
      assert.ok(
        deltas.every((event) => event.threadId === threadId && event.turnId === completed.turnId),
      )
      assert.match(deltas.map((event) => event.delta).join(''), /shell-output/)
      const turn = await app.turnCompleted(completed.turnId)
      assert.equal(turn.status, 'completed')
      assert.equal(app.notified('turn/started').length, 1)
      const methods = app.messages
        .filter((message) => message.method)
        .map((message) => message.method)
      assert.ok(methods.indexOf('turn/started') < methods.indexOf('item/started'))
      assert.ok(
        methods.indexOf('item/started') < methods.indexOf('item/commandExecution/outputDelta'),
      )
      assert.ok(
        methods.indexOf('item/commandExecution/outputDelta') < methods.indexOf('item/completed'),
      )
      assert.ok(methods.indexOf('item/completed') < methods.indexOf('turn/completed'))
      const read = await app.request('thread/read', { threadId, includeTurns: true })
      assert.equal(read.thread.turns.length, 1)
      assert.equal(read.thread.turns[0].id, completed.turnId)
      assert.deepEqual(read.thread.turns[0].items, [])
      const listed = await app.request('thread/turns/list', { threadId, itemsView: 'full' })
      assert.equal(listed.data.length, 1)
      assert.deepEqual(listed.data[0].items, [])
    },
  )
})

test('thread shell command timeout reports exit code -1 and settles its turn', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      await app.request('thread/shellCommand', { threadId, command: 'sleep 30', timeoutMs: 100 })
      const completed = await app.waitFor(() =>
        app.notified('item/completed').find((event) => event.item.source === 'userShell'),
      )
      assert.equal(completed.item.exitCode, -1)
      assert.equal(completed.item.status, 'failed')
      assert.equal((await app.turnCompleted(completed.turnId)).status, 'completed')
    },
  )
})

test('thread shell command rejects unknown threads and invalid timeout before execution', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      for (const timeoutMs of [-1, '100', null, Number.NaN, Number.POSITIVE_INFINITY]) {
        const reply = await app.call('thread/shellCommand', {
          threadId,
          command: 'printf should-not-run',
          timeoutMs,
        })
        assert.equal(reply.error?.code, -32602)
        assert.match(reply.error?.message ?? '', /timeoutMs must be non-negative/)
      }
      const unknown = await app.call('thread/shellCommand', {
        threadId: 'missing-thread',
        command: 'printf should-not-run',
      })
      assert.match(unknown.error?.message ?? '', /unknown thread: missing-thread/)
      assert.equal(app.notified('turn/started').length, 0)
      assert.equal(app.notified('item/started').length, 0)
    },
  )
})

test('thread shell command joins an active turn without completing it', async () => {
  let finishRuntime: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    finishRuntime = resolve
  })
  const runtime = scriptedRuntime(async (_context, handlers) => {
    await running
    await handlers.onEvent({ type: 'completed', success: true })
  })
  await withInProcessApp(runtime, async (app) => {
    try {
      const threadId = await app.startThread({ cwd: app.home })
      const turnId = await app.startTurn(threadId, 'Remain active')
      await app.request('thread/shellCommand', { threadId, command: 'printf joined' })
      const completed = await app.waitFor(() =>
        app.notified('item/completed').find((event) => event.item.source === 'userShell'),
      )
      assert.equal(completed.turnId, turnId)
      assert.equal(completed.item.exitCode, 0)
      assert.equal(completed.item.status, 'completed')
      assert.equal(app.notified('turn/started').length, 1)
      assert.equal(app.notified('turn/completed').length, 0)
      finishRuntime()
      assert.equal((await app.turnCompleted(turnId)).status, 'completed')
    } finally {
      finishRuntime()
    }
  })
})

test('server shutdown stops an active user shell and releases its idle hold', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const threadId = await app.startThread({ cwd: app.home })
      await app.request('thread/shellCommand', { threadId, command: 'sleep 30' })
      const started = await app.waitFor(() =>
        app.notified('item/started').find((event) => event.item.source === 'userShell'),
      )
      const processes = Reflect.get(app.server, 'commandProcesses') as Map<string, { pid?: number }>
      const pid = processes.get(started.item.processId)?.pid
      assert.ok(pid, 'shell must have spawned before shutdown')
      assert.equal(app.server.hasActiveTurns(), true)
      await app.server.stop()
      assert.equal(app.server.hasActiveTurns(), false)
      await app.waitFor(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
          throw error
        }
      })
      await app.waitFor(() => (processes.size === 0 ? true : undefined))
    },
  )
})
