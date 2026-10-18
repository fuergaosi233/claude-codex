import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

// The App methods end to end: each test drives its own mock app-server over
// stdio, the way the App does.

const adapter = resolve('dist/src/adapter.mjs')

class RpcError extends Error {
  readonly data: unknown

  constructor(message: string, data: unknown) {
    super(message)
    this.data = data
  }
}

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
    this.proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
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

  // Where the notifications so far end. The server writes a notification
  // before the response of the request that caused it.
  mark(): number {
    return this.notifications.length
  }

  notified(method: string, from: number): any[] {
    return this.notifications
      .slice(from)
      .filter((entry) => entry.method === method)
      .map((entry) => entry.params)
  }

  async waitFor(method: string, match: (params: any) => boolean, from: number): Promise<any> {
    for (let waited = 0; waited < 10_000; waited += 20) {
      const found = this.notified(method, from).find(match)
      if (found) return found
      await delay(20)
    }
    throw new Error(`no ${method} notification arrived`)
  }

  async startThread(params: Record<string, unknown> = {}): Promise<string> {
    const { thread } = await this.request('thread/start', { cwd: this.home, ...params })
    return thread.id
  }

  startTurn(threadId: string, text: string): Promise<any> {
    return this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  }

  // Runs a turn to its end and returns its id.
  async runTurn(threadId: string, text: string): Promise<string> {
    const from = this.mark()
    const { turn } = await this.startTurn(threadId, text)
    await this.waitFor('turn/completed', (params) => params.turn.id === turn.id, from)
    return turn.id
  }

  // The text of a turn's last agent message.
  async reply(threadId: string, turnId: string): Promise<string | undefined> {
    const { thread } = await this.request('thread/read', { threadId, includeTurns: true })
    const turn = thread.turns.find((entry: any) => entry.id === turnId)
    return turn?.items.findLast((item: any) => item.type === 'agentMessage')?.text
  }

  async close(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill()
      await once(this.proc, 'exit')
    }
    await rm(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
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
      if (message.error) pending.reject(new RpcError(message.error.message, message.error.data))
      else pending.resolve(message.result)
    }
  }
}

async function withServer(run: (server: AppServer) => Promise<void>): Promise<void> {
  const server = new AppServer(await mkdtemp(join(tmpdir(), 'claude-codex-app-methods-')))
  try {
    await run(server)
  } finally {
    await server.close()
  }
}

const ids = (page: { data: Array<{ id: string }> }): string[] => page.data.map((entry) => entry.id)

test('thread history pages turns, items and the timeline', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const turns: string[] = []
    for (const text of ['first', 'second', 'third'])
      turns.push(await server.runTurn(threadId, text))

    const newest = await server.request('thread/turns/list', { threadId })
    assert.deepEqual(ids(newest), turns.toReversed())
    const oldest = await server.request('thread/turns/list', {
      threadId,
      sortDirection: 'asc',
      limit: 2,
    })
    assert.deepEqual(ids(oldest), turns.slice(0, 2))
    assert.equal(oldest.nextCursor, turns[2])
    const rest = await server.request('thread/turns/list', {
      threadId,
      sortDirection: 'asc',
      limit: 2,
      cursor: oldest.nextCursor,
    })
    assert.deepEqual(ids(rest), turns.slice(2))
    assert.equal(rest.nextCursor, null)
    await assert.rejects(
      server.request('thread/turns/list', { threadId, cursor: 'gone' }),
      /invalid turn cursor: gone/,
    )

    const items = await server.request('thread/items/list', { threadId, turnId: turns[1] })
    assert.ok(items.data.every((entry: any) => entry.turnId === turns[1]))
    assert.equal(items.data.at(-1).item.type, 'agentMessage')
    const anchor = items.data[0].item.id
    const after = await server.request('thread/items/list', {
      threadId,
      turnId: turns[1],
      cursor: { type: 'item', itemId: anchor },
    })
    assert.deepEqual(
      after.data.map((entry: any) => entry.item.id),
      items.data.slice(1).map((entry: any) => entry.item.id),
    )

    const timeline = await server.request('thread/timeline/list', { threadId })
    assert.deepEqual(
      timeline.data.filter((entry: any) => entry.type === 'turnStarted').map((e: any) => e.turnId),
      turns,
    )
    assert.deepEqual(
      timeline.data.map((entry: any) => entry.position),
      timeline.data.map((_: unknown, index: number) => index),
    )
    // Paged the way the App loads it: newest page first, then older ones,
    // never the same cursor twice.
    const pages: any[][] = []
    const cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const page: any = await server.request('thread/timeline/list', { threadId, cursor, limit: 4 })
      pages.push(page.data)
      cursor = page.nextCursor
      if (cursor != null) {
        assert.ok(!cursors.has(cursor))
        cursors.add(cursor)
      }
    } while (cursor != null)
    assert.ok(pages.length > 1)
    assert.equal(pages[0]?.at(-1).type, 'turnCompleted')
    assert.equal(pages[0]?.at(-1).turnId, turns[2])
    assert.deepEqual(pages.toReversed().flat(), timeline.data)
  })
})

test('thread/search matches what the user sees and pages past the store prefilter', async () => {
  await withServer(async (server) => {
    // Every stored agent message has "agentMessage" in its JSON, so the
    // store lets all three threads through; only two show the term.
    const said = await server.startThread()
    await server.runTurn(said, 'explain agentMessage')
    const keyOnly = await server.startThread()
    await server.runTurn(keyOnly, 'nothing to see')
    const named = await server.startThread()
    await server.runTurn(named, 'plain notes')
    await server.request('thread/name/set', { threadId: named, name: 'agentMessage notes' })

    // updated_at is in whole seconds, so threads touched in the same second
    // are ordered by id: check which threads match, not their order.
    const all = await server.request('thread/search', { searchTerm: 'AGENTMESSAGE' })
    const found = all.data.map((entry: any) => entry.thread.id)
    assert.deepEqual([...found].sort(), [named, said].sort())
    const snippet = (threadId: string) =>
      all.data.find((entry: any) => entry.thread.id === threadId).snippet
    assert.equal(snippet(named), 'agentMessage notes')
    assert.match(snippet(said), /agentMessage/)
    assert.equal(all.nextCursor, null)

    // One per page: the pages read past keyOnly and show each match once,
    // in the same order as a single page.
    const pages: string[][] = []
    let cursor: string | null = null
    do {
      const page: any = await server.request('thread/search', {
        searchTerm: 'agentMessage',
        limit: 1,
        cursor,
      })
      pages.push(page.data.map((entry: any) => entry.thread.id))
      cursor = page.nextCursor
    } while (cursor !== null && pages.length < 5)
    assert.deepEqual(pages.flat(), found)

    assert.deepEqual(await server.request('thread/search', { searchTerm: '  ' }), {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    })
    await server.request('thread/archive', { threadId: said })
    const live = await server.request('thread/search', { searchTerm: 'agentMessage' })
    assert.deepEqual(
      live.data.map((entry: any) => entry.thread.id),
      [named],
    )
    const archived = await server.request('thread/search', {
      searchTerm: 'agentMessage',
      archived: true,
    })
    assert.deepEqual(
      archived.data.map((entry: any) => entry.thread.id),
      [said],
    )
  })
})

test('thread/list pages through threads created in the same second', async () => {
  await withServer(async (server) => {
    // Every other thread is a chat nothing was sent to, which the list skips.
    const threads: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const threadId = await server.startThread()
      if (index % 2 === 0) continue
      await server.runTurn(threadId, `chat ${index}`)
      threads.push(threadId)
    }
    const pages: string[][] = []
    let cursor: string | null = null
    do {
      const page: any = await server.request('thread/list', { limit: 2, cursor })
      pages.push(ids(page))
      cursor = page.nextCursor
    } while (cursor !== null && pages.length < 10)
    assert.deepEqual(
      pages.map((page) => page.length),
      [2, 2, 1],
    )
    assert.deepEqual(pages.flat().toSorted(), threads.toSorted())
  })
})

test('a chat nothing was sent to stays out of the thread list and search', async () => {
  await withServer(async (server) => {
    const used = await server.startThread()
    await server.runTurn(used, 'find the needle')
    const empty = await server.startThread()
    await server.request('thread/name/set', { threadId: empty, name: 'needle notes' })
    assert.deepEqual(ids(await server.request('thread/list')), [used])
    const search = async () =>
      (await server.request('thread/search', { searchTerm: 'needle' })).data
        .map((entry: any) => entry.thread.id)
        .toSorted()
    assert.deepEqual(await search(), [used])

    // It still reads and resumes, and the App still finds it loaded.
    const { thread } = await server.request('thread/read', { threadId: empty, includeTurns: true })
    assert.equal(thread.id, empty)
    assert.deepEqual(thread.turns, [])
    const resumed = await server.request('thread/resume', { threadId: empty })
    assert.equal(resumed.thread.id, empty)
    assert.ok((await server.request('thread/loaded/list')).data.includes(empty))

    // Its first turn lists it.
    await server.runTurn(empty, 'now it starts')
    assert.deepEqual(ids(await server.request('thread/list')).toSorted(), [used, empty].toSorted())
    assert.deepEqual(await search(), [used, empty].toSorted())

    // The archive lists every thread, as Codex does.
    const archived = await server.startThread()
    await server.request('thread/archive', { threadId: archived })
    assert.deepEqual(ids(await server.request('thread/list', { archived: true })), [archived])
  })
})

test('thread/searchOccurrences finds every match with the turn that loads it', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const turnId = await server.runTurn(threadId, 'where is the Needle?')
    const found = await server.request('thread/searchOccurrences', {
      threadId,
      searchTerm: 'needle',
    })
    // The prompt, and the mock's echo of it.
    assert.equal(found.data.length, 2)
    for (const entry of found.data) {
      assert.equal(entry.turnCursor, turnId)
      const { start, end } = entry.snippetMatchRange
      assert.equal(entry.snippet.slice(start, end), 'Needle')
    }
    const first = await server.request('thread/searchOccurrences', {
      threadId,
      searchTerm: 'needle',
      limit: 1,
    })
    assert.equal(first.nextCursor, '1')
    const second = await server.request('thread/searchOccurrences', {
      threadId,
      searchTerm: 'needle',
      limit: 1,
      cursor: '1',
    })
    assert.deepEqual(second.data, found.data.slice(1))
    assert.equal(second.nextCursor, null)
    await assert.rejects(
      server.request('thread/searchOccurrences', { threadId: 'nope', searchTerm: 'x' }),
      /unknown thread: nope/,
    )
  })
})

test('thread attachments are kept per type and key, with notifications', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const add = (identityKey: string) =>
      server.request('thread/attachment/add', {
        threadId,
        attachmentType: 'pullRequest',
        identityKey,
        payload: { url: `https://example.com/${identityKey}` },
      })
    let from = server.mark()
    const added = await add('pr-1')
    assert.equal(added.outcome, 'created')
    assert.deepEqual(server.notified('thread/attachment/updated', from), [
      {
        threadId,
        attachmentType: 'pullRequest',
        identityKey: 'pr-1',
        attachmentId: added.attachment.id,
        operation: 'created',
      },
    ])
    from = server.mark()
    const again = await add('pr-1')
    assert.equal(again.outcome, 'existing')
    assert.equal(again.attachment.id, added.attachment.id)
    assert.deepEqual(server.notified('thread/attachment/updated', from), [])
    await add('pr-2')

    const first = await server.request('thread/attachment/list', { threadId, limit: 1 })
    assert.deepEqual(
      first.data.map((entry: any) => entry.identityKey),
      ['pr-1'],
    )
    assert.deepEqual(first.data[0].payload, { url: 'https://example.com/pr-1' })
    assert.equal(first.nextCursor, '1')
    const second = await server.request('thread/attachment/list', {
      threadId,
      limit: 1,
      cursor: '1',
    })
    assert.deepEqual(
      second.data.map((entry: any) => entry.identityKey),
      ['pr-2'],
    )
    assert.equal(second.nextCursor, null)

    const remove = { threadId, attachmentType: 'pullRequest', identityKey: 'pr-1' }
    from = server.mark()
    assert.deepEqual(await server.request('thread/attachment/remove', remove), {})
    assert.equal(server.notified('thread/attachment/updated', from)[0]?.operation, 'deleted')
    from = server.mark()
    assert.deepEqual(await server.request('thread/attachment/remove', remove), {})
    assert.deepEqual(server.notified('thread/attachment/updated', from), [])
    await assert.rejects(
      server.request('thread/attachment/add', {
        threadId: 'nope',
        attachmentType: 'pullRequest',
        identityKey: 'pr-1',
      }),
      /unknown thread: nope/,
    )
    await assert.rejects(
      server.request('thread/attachment/add', { threadId, attachmentType: '', identityKey: 'x' }),
      /attachmentType and identityKey must not be empty/,
    )
  })
})

test('background shells are listed and stopped as background terminals', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    await server.runTurn(threadId, 'background shell check')
    const { data, nextCursor } = await server.request('thread/backgroundTerminals/list', {
      threadId,
    })
    assert.equal(nextCursor, null)
    assert.equal(data.length, 1)
    assert.equal(data[0].command, 'npm run dev')
    assert.match(data[0].processId, /^claude:shell-/)
    assert.equal(data[0].osPid, null)

    const terminate = { threadId, processId: data[0].processId }
    assert.deepEqual(await server.request('thread/backgroundTerminals/terminate', terminate), {
      terminated: true,
    })
    assert.deepEqual(await server.request('thread/backgroundTerminals/list', { threadId }), {
      data: [],
      nextCursor: null,
    })
    assert.deepEqual(await server.request('thread/backgroundTerminals/terminate', terminate), {
      terminated: false,
    })
  })
})

test('turn/settings/update switches model and effort for the running turn only', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const ended = await server.runTurn(threadId, 'short')
    assert.deepEqual(
      await server.request('turn/settings/update', { threadId, turnId: ended, effort: 'high' }),
      { status: 'targetUnavailable' },
    )

    const from = server.mark()
    const { turn } = await server.startTurn(threadId, 'hold this turn until released')
    await server.waitFor('item/agentMessage/delta', (params) => params.turnId === turn.id, from)
    const update = (settings: Record<string, unknown>) =>
      server.request('turn/settings/update', { threadId, turnId: turn.id, ...settings })
    // The user already reviews every approval.
    assert.deepEqual(await update({ approvalsReviewer: 'user' }), { status: 'applied' })
    await assert.rejects(
      update({ approvalsReviewer: 'auto_review', summary: 'detailed' }),
      /a running Claude turn cannot change approvalsReviewer auto_review, summary/,
    )
    await assert.rejects(update({ effort: 'extreme' }), /unsupported effort: extreme/)
    await assert.rejects(update({ model: 'claude-opus-9' }), /unknown model: claude-opus-9/)
    assert.deepEqual(await update({ model: 'Opus', effort: 'high' }), {
      status: 'applied',
    })
    await server.request('turn/steer', {
      threadId,
      expectedTurnId: turn.id,
      input: [{ type: 'text', text: 'release', text_elements: [] }],
    })
    await server.waitFor('turn/completed', (params) => params.turn.id === turn.id, from)
    assert.match(
      (await server.reply(threadId, turn.id)) ?? '',
      /released on model=opus effort=high$/,
    )
  })
})

test('a turn/start carrying toolOutput prompts Claude with it and records a functionCallOutput', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const handoff = {
      name: 'handoff_thread',
      namespace: 'codex_app',
      output: 'Continue the parser refactor from these notes.',
    }
    const from = server.mark()
    const { turn } = await server.request('turn/start', {
      threadId,
      input: [],
      toolOutput: handoff,
      clientUserMessageId: 'client-handoff',
    })
    await server.waitFor('turn/completed', (params) => params.turn.id === turn.id, from)
    assert.equal(
      await server.reply(threadId, turn.id),
      'Claude Code adapter mock response for: Continue the parser refactor from these notes.',
    )
    // The App drew the message itself when it sent the turn.
    assert.deepEqual(
      server
        .notified('item/started', from)
        .filter((params) => params.item.type === 'functionCallOutput'),
      [],
    )
    const { thread } = await server.request('thread/read', { threadId, includeTurns: true })
    const { id, ...recorded } = thread.turns[0].items[0]
    assert.equal(typeof id, 'string')
    assert.deepEqual(recorded, { type: 'functionCallOutput', ...handoff })
    assert.equal(thread.preview, handoff.output)
    const summary = await server.request('thread/turns/list', { threadId, itemsView: 'summary' })
    assert.deepEqual(
      summary.data[0].items.map((item: any) => item.type),
      ['functionCallOutput', 'agentMessage'],
    )

    // Content items: Claude reads the text (and any images).
    const second = server.mark()
    const { turn: next } = await server.request('turn/start', {
      threadId,
      input: [],
      toolOutput: {
        name: 'send_message',
        namespace: null,
        output: [
          { type: 'input_text', text: 'A note from another thread.' },
          { type: 'encrypted_content', encrypted_content: 'opaque' },
        ],
      },
    })
    await server.waitFor('turn/completed', (params) => params.turn.id === next.id, second)
    assert.equal(
      await server.reply(threadId, next.id),
      'Claude Code adapter mock response for: A note from another thread.',
    )
  })
})

test('Continue with no input re-sends the message of a turn that did not finish', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const from = server.mark()
    const { turn } = await server.startTurn(threadId, 'slow turn that the user stops')
    await server.waitFor('item/agentMessage/delta', (params) => params.turnId === turn.id, from)
    await server.request('turn/interrupt', { threadId, turnId: turn.id })
    await server.waitFor('turn/completed', (params) => params.turn.id === turn.id, from)

    // The message may never have reached Claude, so it goes along.
    const second = server.mark()
    const { turn: resumed } = await server.request('turn/start', { threadId, input: [] })
    await server.waitFor('turn/completed', (params) => params.turn.id === resumed.id, second)
    assert.equal(
      await server.reply(threadId, resumed.id),
      'answering: slow turn that the user stops',
    )

    // After a turn that finished there is nothing to re-send.
    const third = server.mark()
    const { turn: next } = await server.request('turn/start', { threadId, input: [] })
    await server.waitFor('turn/completed', (params) => params.turn.id === next.id, third)
    assert.equal(await server.reply(threadId, next.id), 'picking up where I left off')
    const { thread } = await server.request('thread/read', { threadId, includeTurns: false })
    assert.equal(thread.preview, 'slow turn that the user stops')
  })
})

test('toolOutput sent while a turn runs joins that turn as its input', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const from = server.mark()
    const { turn } = await server.startTurn(threadId, 'hold this turn until released')
    await server.waitFor('item/agentMessage/delta', (params) => params.turnId === turn.id, from)
    // The held turn ends once Claude reads "release" from the tool output.
    const joined = await server.request('turn/start', {
      threadId,
      input: [],
      toolOutput: { name: 'send_message', namespace: null, output: 'please release now' },
    })
    assert.equal(joined.turn.id, turn.id)
    await server.waitFor('turn/completed', (params) => params.turn.id === turn.id, from)
    const started = await server.waitFor(
      'item/started',
      (params) => params.item.type === 'functionCallOutput',
      from,
    )
    assert.equal(started.turnId, turn.id)
    assert.equal(started.item.output, 'please release now')
  })
})

test('host methods answer truthfully: empty, disabled or unavailable', async () => {
  await withServer(async (server) => {
    await assert.rejects(server.request('x/y'), /method not implemented: x\/y/)
    await assert.rejects(server.request('userVerification/enroll'), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.deepEqual(error.data, { type: 'unavailable', reason: 'providerUnavailable' })
      return true
    })
    assert.deepEqual(await server.request('app/read', { appIds: ['calendar'] }), {
      apps: [],
      missingAppIds: ['calendar'],
    })
    assert.deepEqual(await server.request('memory/status'), {
      v2ConsolidatedThreads: 0,
      v2Ready: false,
    })
    const diagnostics = await server.request('server/diagnostics')
    assert.equal(typeof diagnostics.process.id, 'number')
    assert.ok(diagnostics.gauges.some((gauge: any) => gauge.name === 'active_turns'))
    const environment = await server.request('environment/info')
    assert.match(environment.cwd, /^file:\/\//)

    const record = (source: string) =>
      server.request('externalAgentConfig/import/recordHistory', {
        providerId: 'claude',
        itemTypeResults: [
          {
            itemType: 'SKILLS',
            successes: [{ itemType: 'SKILLS', cwd: null, source, target: '/b' }],
            failures: [],
          },
        ],
      })
    const older = await record('/a1')
    const newer = await record('/a2')
    const histories = await server.request('externalAgentConfig/import/readHistories')
    assert.deepEqual(histories.connectors, [])
    assert.deepEqual(
      histories.data.map((entry: any) => entry.importId),
      [newer.importId, older.importId],
    )
    assert.deepEqual(histories.data[0].successes, [
      { title: null, itemType: 'SKILLS', cwd: null, source: '/a2', target: '/b' },
    ])
  })
})

test('account/usage/read reports turn history and no token counts', async () => {
  await withServer(async (server) => {
    const empty = await server.request('account/usage/read')
    assert.deepEqual(empty, {
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: 0,
        longestStreakDays: 0,
      },
      dailyUsageBuckets: null,
      threadUsage: null,
    })
    await server.runTurn(await server.startThread(), 'hello')
    const { summary } = await server.request('account/usage/read')
    assert.equal(typeof summary.longestRunningTurnSec, 'number')
    assert.equal(summary.currentStreakDays, 1)
    assert.equal(summary.longestStreakDays, 1)
    assert.equal(summary.lifetimeTokens, null)
  })
})

test('projects persist, order, and carry their threads', async () => {
  await withServer(async (server) => {
    const create = (name: string, idempotencyKey: string) =>
      server.request('project/create', {
        name,
        idempotencyKey,
        roots: [{ path: server.home }],
      })
    let from = server.mark()
    const { project: alpha } = await create('  Alpha  ', 'key-a')
    assert.equal(alpha.name, 'Alpha')
    assert.deepEqual(alpha.roots, [{ path: server.home }])
    assert.deepEqual(server.notified('project/changed', from), [
      { projectId: alpha.id, changeType: 'created' },
    ])
    from = server.mark()
    assert.equal((await create('Alpha', 'key-a')).project.id, alpha.id)
    assert.deepEqual(server.notified('project/changed', from), [])
    const { project: beta } = await create('Beta', 'key-b')
    const { project: gamma } = await create('Gamma', 'key-c')

    await assert.rejects(create('Delta', ''), /idempotencyKey must not be empty/)
    await assert.rejects(create('   ', 'key-d'), /project name must not be empty/)
    await assert.rejects(
      server.request('project/create', {
        name: 'Delta',
        idempotencyKey: 'key-d',
        roots: [{ path: 'relative/path' }],
      }),
      /project root must be an absolute path: relative\/path/,
    )

    const list = async (params: Record<string, unknown> = {}) =>
      ids(await server.request('project/list', params))
    assert.deepEqual(await list(), [alpha.id, beta.id, gamma.id])
    const page = await server.request('project/list', { limit: 2 })
    assert.equal(page.nextCursor, '2')
    assert.deepEqual(await list({ limit: 2, cursor: '2' }), [gamma.id])
    await assert.rejects(server.request('project/list', { cursor: 'x' }), /invalid project cursor/)

    await server.request('project/move', { projectId: gamma.id, beforeProjectId: alpha.id })
    assert.deepEqual(await list(), [gamma.id, alpha.id, beta.id])
    const updated = await server.request('project/update', { projectId: beta.id, name: 'Beta 2' })
    assert.equal(updated.project.name, 'Beta 2')
    assert.equal(
      (await server.request('project/read', { projectId: beta.id })).project.name,
      'Beta 2',
    )
    for (const method of ['project/read', 'project/update', 'project/delete', 'project/move'])
      await assert.rejects(server.request(method, { projectId: 'nope' }), /project not found: nope/)

    const started = await server.request('thread/start', { cwd: server.home, projectId: alpha.id })
    const inAlpha = started.thread.id
    assert.equal(started.thread.projectId, alpha.id)
    await assert.rejects(server.startThread({ projectId: 'nope' }), /project not found: nope/)
    await server.runTurn(inAlpha, 'in alpha')
    const { thread: fork } = await server.request('thread/fork', { threadId: inAlpha })
    assert.equal(fork.projectId, alpha.id)

    const loose = await server.startThread()
    await server.runTurn(loose, 'loose')
    from = server.mark()
    await server.request('thread/metadata/update', { threadId: loose, projectId: beta.id })
    assert.deepEqual(server.notified('thread/project/updated', from), [
      { threadId: loose, projectId: beta.id },
    ])
    const threadsIn = async (projectId: string | null) =>
      ids(await server.request('thread/list', { projectId })).toSorted()
    assert.deepEqual(await threadsIn(alpha.id), [inAlpha, fork.id].toSorted())
    assert.deepEqual(await threadsIn(beta.id), [loose])
    assert.deepEqual(await threadsIn(null), [])
    // null leaves the project, '' clears it.
    from = server.mark()
    await server.request('thread/metadata/update', { threadId: loose, projectId: null })
    assert.deepEqual(server.notified('thread/project/updated', from), [])
    await server.request('thread/metadata/update', { threadId: loose, projectId: '' })
    assert.deepEqual(server.notified('thread/project/updated', from), [
      { threadId: loose, projectId: null },
    ])
    assert.deepEqual(await threadsIn(null), [loose])

    from = server.mark()
    assert.deepEqual(await server.request('project/delete', { projectId: alpha.id }), {})
    assert.deepEqual(
      server
        .notified('thread/project/updated', from)
        .map((params) => params.threadId)
        .toSorted(),
      [inAlpha, fork.id].toSorted(),
    )
    assert.deepEqual(server.notified('project/changed', from), [
      { projectId: alpha.id, changeType: 'deleted' },
    ])
    assert.deepEqual(await threadsIn(null), [inAlpha, fork.id, loose].toSorted())
    await assert.rejects(
      create('Alpha', 'key-a'),
      new RegExp(`idempotency key refers to deleted project: ${alpha.id}`),
    )
  })
})

test('rollback and revert rewind Claude to the newest remaining turn', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const turns: string[] = []
    for (const text of ['one', 'two', 'three']) turns.push(await server.runTurn(threadId, text))

    await server.request('thread/rollback', { threadId, numTurns: 1 })
    assert.deepEqual(
      ids(await server.request('thread/turns/list', { threadId, sortDirection: 'asc' })),
      turns.slice(0, 2),
    )
    const afterRollback = await server.runTurn(threadId, 'rewind check')
    assert.equal(
      await server.reply(threadId, afterRollback),
      `resumed mock-${threadId} at ${turns[1]}-entry after 1 resets`,
    )

    const from = server.mark()
    const reverted = await server.request('thread/revert', { threadId, beforeTurnId: turns[1] })
    assert.deepEqual(server.notified('thread/reverted', from), [{ threadId }])
    assert.equal(reverted.thread.id, threadId)
    assert.equal(reverted.turnsBackwardsCursor, turns[0])
    assert.equal(typeof reverted.itemsBackwardsCursor, 'string')
    assert.deepEqual(
      ids(await server.request('thread/turns/list', { threadId, sortDirection: 'asc' })),
      turns.slice(0, 1),
    )
    const afterRevert = await server.runTurn(threadId, 'rewind check')
    assert.equal(
      await server.reply(threadId, afterRevert),
      `resumed mock-${threadId} at ${turns[0]}-entry after 2 resets`,
    )

    await assert.rejects(
      server.request('thread/revert', { threadId: 'nope', beforeTurnId: turns[0] }),
      /unknown thread: nope/,
    )
    await assert.rejects(
      server.request('thread/revert', { threadId, beforeTurnId: turns[2] }),
      new RegExp(`unknown turn: ${turns[2]}`),
    )

    const running = server.mark()
    const { turn } = await server.startTurn(threadId, `busy ${'x'.repeat(300)}`)
    await assert.rejects(
      server.request('thread/rollback', { threadId, numTurns: 1 }),
      new RegExp(`cannot rewind thread ${threadId} while a turn is running`),
    )
    await server.waitFor('turn/completed', (params) => params.turn.id === turn.id, running)
  })
})

test('a fork resumes at its fork point, and a full rollback returns there', async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    await server.runTurn(parent, 'parent one')
    const forkPoint = await server.runTurn(parent, 'parent two')
    const { thread: fork } = await server.request('thread/fork', { threadId: parent })

    const first = await server.runTurn(fork.id, 'rewind check')
    assert.equal(
      await server.reply(fork.id, first),
      `resumed mock-${parent} at ${forkPoint}-entry after 0 resets`,
    )
    await server.request('thread/rollback', { threadId: fork.id, numTurns: 1 })
    const again = await server.runTurn(fork.id, 'rewind check')
    assert.equal(
      await server.reply(fork.id, again),
      `resumed mock-${parent} at ${forkPoint}-entry after 1 resets`,
    )
  })
})

test("a fork's Claude session leaves the parent what it scheduled before the fork", async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    await server.runTurn(parent, 'parent one')
    const { thread: fork } = await server.request('thread/fork', { threadId: parent })

    const first = await server.runTurn(fork.id, 'fork check')
    const forkedAt = new Date((fork.createdAt + 1) * 1000).toISOString()
    assert.equal(await server.reply(fork.id, first), `forked at ${forkedAt}`)
    const later = await server.runTurn(fork.id, 'fork check')
    assert.equal(await server.reply(fork.id, later), `forked at ${forkedAt}`)
    const own = await server.runTurn(parent, 'fork check')
    assert.equal(await server.reply(parent, own), 'not a fork')
  })
})

test('the ephemeral fork the App describes a thread with stays out of the thread list', async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    await server.runTurn(parent, 'parent one')
    const { thread: fork } = await server.request('thread/fork', {
      threadId: parent,
      ephemeral: true,
      excludeTurns: true,
      threadSource: 'thread_description',
    })
    assert.equal(fork.ephemeral, true)
    assert.deepEqual(ids(await server.request('thread/list')), [parent])
    // A plain fork is the user's own thread.
    const { thread: kept } = await server.request('thread/fork', { threadId: parent })
    assert.equal(kept.ephemeral, false)
    assert.deepEqual(
      ids(await server.request('thread/list')).toSorted(),
      [parent, kept.id].toSorted(),
    )
  })
})

test('thread/delete removes a thread with its subagents, even mid-turn', async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    await server.runTurn(parent, 'subagent check')
    const children = ids(await server.request('thread/list', { parentThreadId: parent }))
    assert.equal(children.length, 1)
    const { thread: fork } = await server.request('thread/fork', { threadId: parent })

    let from = server.mark()
    assert.deepEqual(await server.request('thread/delete', { threadId: parent }), {})
    assert.deepEqual(
      server
        .notified('thread/deleted', from)
        .map((params) => params.threadId)
        .toSorted(),
      [parent, ...children].toSorted(),
    )
    await assert.rejects(server.request('thread/read', { threadId: parent }), /unknown thread/)
    // A fork is the user's own thread and stays.
    assert.equal((await server.request('thread/read', { threadId: fork.id })).thread.id, fork.id)

    await assert.rejects(
      server.request('thread/delete', { threadId: parent }),
      new RegExp(`no rollout found for thread id ${parent}`),
    )
    assert.deepEqual(
      await server.request('thread/delete', { threadId: parent, missingRolloutRecovery: true }),
      {},
    )

    const busy = await server.startThread()
    await server.startTurn(busy, `busy ${'x'.repeat(300)}`)
    from = server.mark()
    assert.deepEqual(await server.request('thread/delete', { threadId: busy }), {})
    assert.deepEqual(server.notified('thread/deleted', from), [{ threadId: busy }])
    // The interrupted turn's late events find no thread, and the server
    // carries on.
    await delay(300)
    await assert.rejects(server.request('thread/read', { threadId: busy }), /unknown thread/)
    assert.deepEqual(ids(await server.request('thread/list')), [fork.id])
  })
})
