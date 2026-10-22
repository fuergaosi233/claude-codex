import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

// A fork's history end to end: what every history read returns for a fork,
// across restarts, forks of forks, rewinds and changes to the parent. Each
// test drives mock app-servers over stdio on its own state dir.

const adapter = resolve('dist/src/adapter.mjs')

class AppServer {
  readonly home: string
  readonly notifications: Array<{ method: string; params: any }> = []
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >()
  private nextId = 1
  private buffer = ''

  constructor(home: string) {
    this.home = home
    const env = { ...process.env }
    delete env.CLAUDE_CODEX_HOME
    this.proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    this.proc.stderr.resume()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.read(chunk))
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async startThread(): Promise<string> {
    const { thread } = await this.request('thread/start', { cwd: this.home })
    return thread.id
  }

  // Runs a turn to its end and returns its id.
  async runTurn(threadId: string, text: string): Promise<string> {
    const from = this.notifications.length
    const { turn } = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    for (let waited = 0; waited < 10_000; waited += 20) {
      const done = this.notifications
        .slice(from)
        .some((entry) => entry.method === 'turn/completed' && entry.params.turn.id === turn.id)
      if (done) return turn.id
      await delay(20)
    }
    throw new Error(`turn ${turn.id} did not complete`)
  }

  // The text of a turn's last agent message.
  async reply(threadId: string, turnId: string): Promise<string | undefined> {
    const { thread } = await this.request('thread/read', { threadId, includeTurns: true })
    const turn = thread.turns.find((entry: any) => entry.id === turnId)
    return turn?.items.findLast((item: any) => item.type === 'agentMessage')?.text
  }

  // The ids of a thread's turns as thread/resume returns them.
  async resumed(threadId: string): Promise<string[]> {
    const { thread } = await this.request('thread/resume', { threadId })
    return ids(thread.turns)
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill()
      await once(this.proc, 'exit')
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method != null) {
        if (message.id == null) this.notifications.push(message)
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }
}

// Runs `run` with a way to start servers on one state dir; every server it
// started is stopped, and the dir removed, at the end.
async function withHome(run: (start: () => AppServer, home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-fork-history-'))
  const servers: AppServer[] = []
  try {
    await run(() => {
      const server = new AppServer(home)
      servers.push(server)
      return server
    }, home)
  } finally {
    for (const server of servers) await server.stop()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

const ids = (turns: Array<{ id: string }>): string[] => turns.map((turn) => turn.id)

// Every turn of thread/turns/list, page by page.
async function listedTurns(
  server: AppServer,
  threadId: string,
  sortDirection: 'asc' | 'desc',
): Promise<string[]> {
  const listed: string[] = []
  let cursor: string | null = null
  do {
    const page: any = await server.request('thread/turns/list', {
      threadId,
      sortDirection,
      limit: 2,
      cursor,
    })
    listed.push(...ids(page.data))
    cursor = page.nextCursor
  } while (cursor != null && listed.length < 50)
  return listed
}

test('a kept fork returns the turns it was forked with on every history read', async () => {
  await withHome(async (start) => {
    const server = start()
    const parent = await server.startThread()
    const turns: string[] = []
    for (const text of ['alpha one', 'alpha two', 'alpha three'])
      turns.push(await server.runTurn(parent, text))

    // The App forks with excludeTurns, then shows what thread/resume returns.
    const { thread: fork } = await server.request('thread/fork', {
      threadId: parent,
      lastTurnId: turns[1],
      excludeTurns: true,
    })
    assert.deepEqual(fork.turns, [])
    const inherited = turns.slice(0, 2)
    assert.deepEqual(await server.resumed(fork.id), inherited)
    const own = await server.runTurn(fork.id, 'fork own')
    const history = [...inherited, own]

    const { thread: read } = await server.request('thread/read', {
      threadId: fork.id,
      includeTurns: true,
    })
    assert.deepEqual(ids(read.turns), history)
    assert.deepEqual(await listedTurns(server, fork.id, 'asc'), history)
    assert.deepEqual(await listedTurns(server, fork.id, 'desc'), history.toReversed())

    // Inherited turns keep their ids and their items' ids, as in Codex.
    const { thread: parentRead } = await server.request('thread/read', {
      threadId: parent,
      includeTurns: true,
    })
    const parentItems = parentRead.turns[0].items.map((item: any) => item.id)
    const items = await server.request('thread/items/list', { threadId: fork.id, turnId: turns[0] })
    assert.deepEqual(
      items.data.map((entry: any) => entry.item.id),
      parentItems,
    )
    const after = await server.request('thread/items/list', {
      threadId: fork.id,
      turnId: turns[0],
      cursor: { type: 'item', itemId: parentItems[0] },
    })
    assert.equal(after.data[0].item.id, parentItems[1])
    const turnItems = await server.request('thread/turns/items/list', {
      threadId: fork.id,
      turnId: turns[0],
    })
    assert.deepEqual(
      turnItems.data.map((item: any) => item.id),
      parentItems,
    )
    const timeline = await server.request('thread/timeline/list', { threadId: fork.id })
    assert.deepEqual(
      timeline.data.filter((entry: any) => entry.type === 'turnStarted').map((e: any) => e.turnId),
      history,
    )

    // Find in the conversation and thread/search see the inherited messages.
    const occurrences = await server.request('thread/searchOccurrences', {
      threadId: fork.id,
      searchTerm: 'alpha two',
    })
    assert.ok(occurrences.data.length > 0)
    assert.ok(occurrences.data.every((entry: any) => entry.turnCursor === turns[1]))
    const found = await server.request('thread/search', { searchTerm: 'alpha two' })
    assert.deepEqual(
      found.data.map((entry: any) => entry.thread.id).toSorted(),
      [parent, fork.id].toSorted(),
    )

    // The fork holds its own copy: a rewind or delete of the parent leaves it.
    await server.request('thread/rollback', { threadId: parent, numTurns: 3 })
    await server.request('thread/delete', { threadId: parent })
    assert.deepEqual(await server.resumed(fork.id), history)

    // A new server on the same state dir returns the same history.
    await server.stop()
    const restarted = start()
    assert.deepEqual(await restarted.resumed(fork.id), history)
    assert.deepEqual(await listedTurns(restarted, fork.id, 'desc'), history.toReversed())
  })
})

test('a fork of a fork inherits its whole history and can branch at an inherited turn', async () => {
  await withHome(async (start) => {
    const server = start()
    const parent = await server.startThread()
    const first = await server.runTurn(parent, 'one')
    const second = await server.runTurn(parent, 'two')
    const { thread: middle } = await server.request('thread/fork', { threadId: parent })
    const middleTurn = await server.runTurn(middle.id, 'middle')

    const { thread: whole } = await server.request('thread/fork', { threadId: middle.id })
    assert.deepEqual(ids(whole.turns), [first, second, middleTurn])
    assert.deepEqual(await server.resumed(whole.id), [first, second, middleTurn])
    const wholeCheck = await server.runTurn(whole.id, 'rewind check')
    assert.match(
      (await server.reply(whole.id, wholeCheck)) ?? '',
      new RegExp(`at ${middleTurn}-entry after 0 resets`),
    )

    // beforeTurnId and lastTurnId may name a turn the fork inherited; Claude
    // resumes after the last turn kept.
    const { thread: early } = await server.request('thread/fork', {
      threadId: whole.id,
      beforeTurnId: second,
    })
    assert.deepEqual(ids(early.turns), [first])
    const earlyCheck = await server.runTurn(early.id, 'rewind check')
    assert.equal(
      await server.reply(early.id, earlyCheck),
      `resumed mock-${parent} at ${first}-entry after 0 resets`,
    )
    const { thread: atMiddle } = await server.request('thread/fork', {
      threadId: whole.id,
      lastTurnId: middleTurn,
    })
    assert.deepEqual(await server.resumed(atMiddle.id), [first, second, middleTurn])

    // Before every inherited turn is before the first turn of the thread
    // the history began in: a new session.
    const { thread: none } = await server.request('thread/fork', {
      threadId: whole.id,
      beforeTurnId: first,
    })
    assert.deepEqual(none.turns, [])
    const noneCheck = await server.runTurn(none.id, 'rewind check')
    assert.equal(await server.reply(none.id, noneCheck), 'resumed nothing at end after 0 resets')
  })
})

test('thread/rollback and thread/revert reach into the turns a fork inherited', async () => {
  await withHome(async (start) => {
    const server = start()
    const parent = await server.startThread()
    const turns: string[] = []
    for (const text of ['one', 'two', 'three']) turns.push(await server.runTurn(parent, text))
    const { thread: fork } = await server.request('thread/fork', { threadId: parent })
    await server.runTurn(fork.id, 'fork own')

    // Its own turn goes first, then the newest inherited one.
    const rolled = await server.request('thread/rollback', { threadId: fork.id, numTurns: 2 })
    assert.deepEqual(ids(rolled.thread.turns), turns.slice(0, 2))
    const check = await server.runTurn(fork.id, 'rewind check')
    assert.equal(
      await server.reply(fork.id, check),
      `resumed mock-${parent} at ${turns[1]}-entry after 1 resets`,
    )

    await assert.rejects(
      server.request('thread/revert', { threadId: fork.id, beforeTurnId: turns[2] }),
      new RegExp(`unknown turn: ${turns[2]}`),
    )
    const reverted = await server.request('thread/revert', {
      threadId: fork.id,
      beforeTurnId: turns[1],
    })
    assert.equal(reverted.turnsBackwardsCursor, turns[0])
    assert.deepEqual(await listedTurns(server, fork.id, 'asc'), turns.slice(0, 1))
    const again = await server.runTurn(fork.id, 'rewind check')
    assert.equal(
      await server.reply(fork.id, again),
      `resumed mock-${parent} at ${turns[0]}-entry after 2 resets`,
    )

    // Back past every inherited turn: a new session, not the parent's.
    await server.request('thread/revert', { threadId: fork.id, beforeTurnId: turns[0] })
    assert.deepEqual(await server.resumed(fork.id), [])
    const fresh = await server.runTurn(fork.id, 'rewind check')
    assert.equal(await server.reply(fork.id, fresh), 'resumed nothing at end after 3 resets')

    // The parent keeps every turn.
    assert.deepEqual(await listedTurns(server, parent, 'asc'), turns)
  })
})

test('an ephemeral fork returns its inherited turns in the fork response only', async () => {
  await withHome(async (start) => {
    const server = start()
    const parent = await server.startThread()
    const first = await server.runTurn(parent, 'one')
    const { thread: fork } = await server.request('thread/fork', {
      threadId: parent,
      ephemeral: true,
    })
    assert.deepEqual(ids(fork.turns), [first])
    const { thread: read } = await server.request('thread/read', {
      threadId: fork.id,
      includeTurns: true,
    })
    assert.deepEqual(read.turns, [])
  })
})

test('a fork made before forks kept their history gets it when its fork point is certain', async () => {
  await withHome(async (start, home) => {
    const server = start()
    const parent = await server.startThread()
    const turns: string[] = []
    for (const text of ['one', 'two', 'three']) turns.push(await server.runTurn(parent, text))
    const fork = async (params: Record<string, unknown>) =>
      (await server.request('thread/fork', { threadId: parent, ...params })).thread.id as string
    const atSecond = await fork({ lastTurnId: turns[1] })
    const atSecondOwn = await server.runTurn(atSecond, 'own')
    const beforeAll = await fork({ beforeTurnId: turns[0] })
    const atThird = await fork({ lastTurnId: turns[2] })
    const atThirdOwn = await server.runTurn(atThird, 'own')
    const ofFork = (
      await server.request('thread/fork', { threadId: atSecond, lastTurnId: atSecondOwn })
    ).thread.id as string
    // The turn atThird was forked at goes from the parent: nothing shows
    // where it branched off any more.
    await server.request('thread/rollback', { threadId: parent, numTurns: 1 })
    await server.stop()

    // As an earlier version left them: no copy of the history.
    const db = new DatabaseSync(join(home, 'claude-codex-adapter', 'state.sqlite'))
    for (const id of [atSecond, beforeAll, atThird, ofFork]) {
      db.prepare('DELETE FROM thread_inherited_turns WHERE thread_id = ?').run(id)
      db.prepare(
        'UPDATE threads SET inherited_history = NULL, inherited_base_json = NULL WHERE id = ?',
      ).run(id)
    }
    db.close()

    const restarted = start()
    // A fork of a fork reads its parent's history first.
    assert.deepEqual(await restarted.resumed(ofFork), [turns[0], turns[1], atSecondOwn])
    assert.deepEqual(await restarted.resumed(atSecond), [turns[0], turns[1], atSecondOwn])
    assert.deepEqual(await restarted.resumed(beforeAll), [])
    assert.deepEqual(await restarted.resumed(atThird), [atThirdOwn])
    // Once settled, a fork's history stays put, even when its parent changes.
    await restarted.request('thread/rollback', { threadId: parent, numTurns: 2 })
    assert.deepEqual(await restarted.resumed(atSecond), [turns[0], turns[1], atSecondOwn])
    assert.deepEqual(await restarted.resumed(atThird), [atThirdOwn])
  })
})
