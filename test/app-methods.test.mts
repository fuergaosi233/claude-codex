import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

// The App methods end to end: each test drives its own mock app-server over
// stdio, the way the App does.

const adapter = resolve('dist/src/adapter.mjs')

class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data: unknown) {
    super(message)
    this.code = code
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

  // env adds to or, with undefined values, removes from the adapter's
  // environment.
  constructor(home: string, env: NodeJS.ProcessEnv = {}) {
    this.home = home
    this.proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CLAUDE_CODEX_MOCK: '1',
        NODE_NO_WARNINGS: '1',
        ...env,
      },
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
      if (message.error) {
        const { code, message: text, data } = message.error
        pending.reject(new RpcError(code, text, data))
      } else pending.resolve(message.result)
    }
  }
}

async function withServer(
  run: (server: AppServer) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  const server = new AppServer(await mkdtemp(join(tmpdir(), 'claude-codex-app-methods-')), env)
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

test('attachment owners list the threads holding a worktree, by thread id', async () => {
  await withServer(async (server) => {
    const worktree = { attachmentType: 'worktree', identityKey: '/repo/wt-1' }
    const attach = (threadId: string, attachment: Record<string, string>) =>
      server.request('thread/attachment/add', { threadId, ...attachment, payload: {} })
    const holders = [await server.startThread(), await server.startThread()]
    const other = await server.startThread()
    for (const threadId of holders) await attach(threadId, worktree)
    await attach(other, { attachmentType: 'worktree', identityKey: '/repo/wt-2' })
    await attach(other, { attachmentType: 'pullRequest', identityKey: '/repo/wt-1' })
    const [first, second] = [...holders].sort()
    await server.request('thread/archive', { threadId: second })

    const owners = (params: Record<string, unknown>) =>
      server.request('thread/attachmentOwner/list', { ...worktree, ...params })
    assert.deepEqual(await owners({}), {
      data: [
        { threadId: first, archived: false },
        { threadId: second, archived: true },
      ],
      nextCursor: null,
    })
    assert.deepEqual(await owners({ archived: false }), {
      data: [{ threadId: first, archived: false }],
      nextCursor: null,
    })
    assert.deepEqual(await owners({ archived: true }), {
      data: [{ threadId: second, archived: true }],
      nextCursor: null,
    })

    // The App pages with the cursor until it is null and stops on a cursor
    // it saw before.
    const page = await owners({ limit: 1 })
    assert.deepEqual(page, { data: [{ threadId: first, archived: false }], nextCursor: '1' })
    assert.deepEqual(await owners({ limit: 1, cursor: page.nextCursor }), {
      data: [{ threadId: second, archived: true }],
      nextCursor: null,
    })
    assert.deepEqual(await owners({ cursor: '2' }), { data: [], nextCursor: null })

    // A fork holds what its parent held, as in Codex, so it is an owner too;
    // an ephemeral fork holds nothing.
    const { thread: fork } = await server.request('thread/fork', { threadId: first })
    await server.request('thread/fork', { threadId: first, ephemeral: true })
    assert.deepEqual(
      (await owners({ archived: false })).data,
      [first, fork.id].sort().map((threadId) => ({ threadId, archived: false })),
    )
    const held = async (threadId: string | undefined) =>
      (await server.request('thread/attachment/list', { threadId })).data
    const [original] = await held(first)
    const [copy] = await held(fork.id)
    assert.notEqual(copy.id, original.id)
    assert.deepEqual({ ...copy, id: original.id }, original)

    assert.deepEqual(
      await server.request('thread/attachmentOwner/list', {
        attachmentType: 'worktree',
        identityKey: '/repo/none',
        archived: false,
        limit: 100,
      }),
      { data: [], nextCursor: null },
    )
    await assert.rejects(owners({ attachmentType: ' ' }), /attachmentType must not be empty/)
    await assert.rejects(owners({ identityKey: '' }), /identityKey must not be empty/)
    await assert.rejects(owners({ cursor: 'x' }), /invalid attachment owner cursor/)
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

test("a background shell's output streams into its command item after the turn ended", async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()
    const from = server.mark()
    const turnId = await server.runTurn(threadId, 'background shell check with output')
    const completed = server
      .notified('item/completed', from)
      .find((params) => params.item.type === 'commandExecution')
    assert.ok(completed)
    const itemId = completed.item.id
    const delta = await server.waitFor(
      'item/commandExecution/outputDelta',
      (params) => params.itemId === itemId && params.delta.includes('ready'),
      from,
    )
    assert.deepEqual(delta, { threadId, turnId, itemId, delta: '\nready on :3000\n' })
    const at = (method: string, match: (params: any) => boolean) =>
      server.notifications.findIndex((entry) => entry.method === method && match(entry.params))
    assert.ok(
      at('item/commandExecution/outputDelta', (params) => params.delta.includes('ready')) >
        at('turn/completed', (params) => params.turn.id === turnId),
    )

    const { thread } = await server.request('thread/read', { threadId, includeTurns: true })
    const item = thread.turns
      .find((turn: any) => turn.id === turnId)
      .items.find((entry: any) => entry.id === itemId)
    assert.equal(item.status, 'completed')
    assert.match(
      item.aggregatedOutput,
      /^Command running in background with ID: \S+\nready on :3000\n$/,
    )
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
    // 'none' is the effort of a model that takes none, such as Haiku. It
    // leaves the effort as it was.
    assert.deepEqual(await update({ effort: 'none' }), { status: 'applied' })
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

test('a turn reports the rootTurnId turn/start names, else its own id', async () => {
  await withServer(async (server) => {
    const threadId = await server.startThread()

    // A turn the user starts is its own root, in every turn payload.
    let from = server.mark()
    const { turn: own } = await server.startTurn(threadId, 'first')
    assert.equal(own.rootTurnId, own.id)
    assert.equal(
      (await server.waitFor('turn/started', (params) => params.turn.id === own.id, from)).turn
        .rootTurnId,
      own.id,
    )
    assert.equal(
      (await server.waitFor('turn/completed', (params) => params.turn.id === own.id, from)).turn
        .rootTurnId,
      own.id,
    )

    // Work started for another turn reports that turn's root, and so does
    // the agent it spawns.
    from = server.mark()
    const { turn: linked } = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'subagent check', text_elements: [] }],
      parentTurnId: 'turn-in-another-thread',
      rootTurnId: 'root-of-the-chain',
    })
    assert.equal(linked.rootTurnId, 'root-of-the-chain')
    const completed = await server.waitFor(
      'turn/completed',
      (params) => params.turn.id === linked.id,
      from,
    )
    assert.equal(completed.turn.rootTurnId, 'root-of-the-chain')
    const child = server
      .notified('turn/started', from)
      .find((params) => params.threadId !== threadId)
    assert.equal(child.turn.rootTurnId, 'root-of-the-chain')
    const { thread: childThread } = await server.request('thread/read', {
      threadId: child.threadId,
      includeTurns: true,
    })
    assert.deepEqual(
      childThread.turns.map((turn: any) => turn.rootTurnId),
      ['root-of-the-chain'],
    )

    // History keeps it, in full and in summary.
    const { thread } = await server.request('thread/read', { threadId, includeTurns: true })
    assert.deepEqual(
      thread.turns.map((turn: any) => turn.rootTurnId),
      [own.id, 'root-of-the-chain'],
    )
    const summary = await server.request('thread/turns/list', { threadId, itemsView: 'summary' })
    assert.deepEqual(
      summary.data.map((turn: any) => turn.rootTurnId),
      ['root-of-the-chain', own.id],
    )

    // A blank root names nothing.
    const { turn: blank } = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'third', text_elements: [] }],
      rootTurnId: ' ',
    })
    assert.equal(blank.rootTurnId, blank.id)
    await server.waitFor('turn/completed', (params) => params.turn.id === blank.id, from)

    // Input that joins a running turn keeps that turn's root, as in Codex.
    from = server.mark()
    const { turn: held } = await server.startTurn(threadId, 'hold this turn until released')
    await server.waitFor('item/agentMessage/delta', (params) => params.turnId === held.id, from)
    const joined = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'release', text_elements: [] }],
      rootTurnId: 'root-of-the-chain',
    })
    assert.equal(joined.turn.id, held.id)
    assert.equal(joined.turn.rootTurnId, held.id)
    await server.waitFor('turn/completed', (params) => params.turn.id === held.id, from)

    // A message queued behind work started for another turn is the user's
    // own turn, its own root.
    from = server.mark()
    const { turn: linkedHeld } = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hold this turn until released', text_elements: [] }],
      rootTurnId: 'root-of-the-chain',
    })
    await server.waitFor(
      'item/agentMessage/delta',
      (params) => params.turnId === linkedHeld.id,
      from,
    )
    await server.request('thread/queue/add', {
      threadId,
      input: [{ type: 'text', text: 'queued', text_elements: [] }],
    })
    await server.request('turn/steer', {
      threadId,
      expectedTurnId: linkedHeld.id,
      input: [{ type: 'text', text: 'release', text_elements: [] }],
    })
    const queued = await server.waitFor(
      'turn/started',
      (params) => params.threadId === threadId && params.turn.id !== linkedHeld.id,
      from,
    )
    assert.equal(queued.turn.rootTurnId, queued.turn.id)
    await server.waitFor('turn/completed', (params) => params.turn.id === queued.turn.id, from)
  })
})

test('Claude threads report the claude-code model provider', async () => {
  await withServer(async (server) => {
    // The App runs composer predictions (a thread/fork with
    // experimentalPredictionMode) only for threads whose modelProvider is
    // openai, so a Claude thread must never claim it.
    const started = await server.request('thread/start', { cwd: server.home })
    assert.equal(started.modelProvider, 'claude-code')
    assert.equal(started.thread.modelProvider, 'claude-code')
    const threadId = started.thread.id
    await server.runTurn(threadId, 'first')

    const resumed = await server.request('thread/resume', { threadId })
    assert.equal(resumed.modelProvider, 'claude-code')
    assert.equal(resumed.thread.modelProvider, 'claude-code')
    const { thread } = await server.request('thread/read', { threadId })
    assert.equal(thread.modelProvider, 'claude-code')
    const forked = await server.request('thread/fork', { threadId })
    assert.equal(forked.modelProvider, 'claude-code')
    assert.equal(forked.thread.modelProvider, 'claude-code')
  })
})

test('host methods answer truthfully: empty, disabled or unavailable', async () => {
  await withServer(async (server) => {
    // The App treats -32601 as "not supported here" and falls back quietly;
    // these three are Codex methods its App builds do not use.
    for (const method of [
      'x/y',
      'thread/items/read',
      'thread/prediction/request',
      'thread/readState/update',
    ]) {
      await assert.rejects(server.request(method), (error: unknown) => {
        assert.ok(error instanceof RpcError)
        assert.equal(error.code, -32601)
        assert.equal(error.message, `method not found: ${method}`)
        assert.equal(error.data, undefined)
        return true
      })
    }
    await assert.rejects(server.request('userVerification/enroll'), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, -32000)
      assert.deepEqual(error.data, { type: 'unavailable', reason: 'providerUnavailable' })
      return true
    })
    await assert.rejects(server.request('remoteControl/enable'), (error: unknown) => {
      assert.ok(error instanceof RpcError)
      assert.equal(error.code, -32000)
      assert.equal(error.data, undefined)
      return true
    })
    assert.deepEqual(await server.request('account/bedrock/checkGovCloudRequirements', {}), {
      isGovCloud: false,
      shouldWarn: false,
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

test('without CLAUDE_CODEX_MEMORIES the memories settings stay hidden and inert', async () => {
  await withServer(
    async (server) => {
      const autoMemory = async (threadId: string) =>
        server.reply(threadId, await server.runTurn(threadId, 'auto memory check'))
      const unlisted = async (params: Record<string, unknown> = {}) =>
        assert.deepEqual(await server.request('experimentalFeature/list', params), {
          data: [],
          nextCursor: null,
        })

      // No feature is listed, so the App hides its Memories settings, and
      // turns leave auto-memory to Claude Code's own settings.
      await unlisted()
      const thread = await server.startThread({
        config: { 'memories.generate_memories': true, 'memories.use_memories': true },
      })
      assert.equal(await autoMemory(thread), 'autoMemory=unset')

      // Neither the connection's enablement nor the config turns it on.
      assert.deepEqual(
        await server.request('experimentalFeature/enablement/set', {
          enablement: { memories: true },
        }),
        { enablement: { memories: true } },
      )
      await server.request('config/batchWrite', {
        edits: [
          { keyPath: 'features.memories', value: true, mergeStrategy: 'upsert' },
          { keyPath: 'memories.generate_memories', value: true, mergeStrategy: 'upsert' },
        ],
      })
      await unlisted({ threadId: thread })
      const { config } = await server.request('config/read', {})
      assert.equal('memories' in config, false)
      assert.deepEqual(
        await server.request('thread/memoryMode/set', { threadId: thread, mode: 'enabled' }),
        {},
      )
      assert.deepEqual(
        await server.request('thread/memoryMode/set', { threadId: 'missing', mode: 'polluted' }),
        {},
      )
      assert.equal(await autoMemory(thread), 'autoMemory=unset')
      const { thread: fork } = await server.request('thread/fork', { threadId: thread })
      assert.equal(await autoMemory(fork.id), 'autoMemory=unset')

      // memory/reset and memory/status answer as they do with the switch.
      await assert.rejects(
        server.request('memory/status', { minConsolidatedThreads: 4097 }),
        /minConsolidatedThreads must be between 1 and 4096/,
      )
      await assert.rejects(server.request('memory/reset'), /memory\/reset is not supported/)
    },
    { CLAUDE_CODEX_MEMORIES: undefined },
  )
})

test("with CLAUDE_CODEX_MEMORIES the App's switches decide which threads get auto-memory", async () => {
  await withServer(
    async (server) => {
      const memories = async (params: Record<string, unknown> = {}) => {
        const list = await server.request('experimentalFeature/list', params)
        assert.equal(list.nextCursor, null)
        assert.deepEqual(
          list.data.map((feature: any) => feature.name),
          ['memories'],
        )
        return list.data[0]
      }
      const autoMemory = async (threadId: string) =>
        server.reply(threadId, await server.runTurn(threadId, 'auto memory check'))
      const write = (edits: Array<[string, unknown]>) =>
        server.request('config/batchWrite', {
          edits: edits.map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: 'upsert' })),
        })

      // Off until the user turns it on, as in Codex.
      const feature = await memories()
      assert.equal(feature.stage, 'beta')
      assert.equal(feature.enabled, false)
      assert.equal(feature.defaultEnabled, false)
      assert.deepEqual(await server.request('experimentalFeature/list', { cursor: '1' }), {
        data: [],
        nextCursor: null,
      })
      await assert.rejects(
        server.request('experimentalFeature/list', { cursor: '2' }),
        /cursor 2 exceeds total feature flags 1/,
      )
      await assert.rejects(
        server.request('experimentalFeature/list', { cursor: 'next' }),
        /invalid cursor: next/,
      )
      await assert.rejects(
        server.request('experimentalFeature/list', { threadId: 'missing' }),
        /thread not found: missing/,
      )
      const first = await server.startThread()
      assert.equal(await autoMemory(first), 'autoMemory=false')
      assert.equal((await memories({ threadId: first })).enabled, false)

      // The App sets its defaults for the connection; the user's config wins.
      assert.deepEqual(
        await server.request('experimentalFeature/enablement/set', {
          enablement: { memories: true, apps: false },
        }),
        { enablement: { memories: true, apps: false } },
      )
      assert.equal((await memories()).enabled, true)
      await write([['features.memories', false]])
      assert.equal((await memories()).enabled, false)
      assert.equal(await autoMemory(first), 'autoMemory=false')

      // Settings > Personalization turns it on and reads its switches back.
      await write([
        ['features.memories', true],
        ['memories.generate_memories', true],
        ['memories.use_memories', true],
      ])
      assert.equal((await memories()).enabled, true)
      const { config } = await server.request('config/read', {})
      assert.deepEqual(config.memories, { generate_memories: true, use_memories: true })
      assert.equal(await autoMemory(first), 'autoMemory=true')

      // A chat started with its own switch off, then turned on with /memories.
      const optedOut = await server.startThread({ config: { 'memories.generate_memories': false } })
      assert.equal(await autoMemory(optedOut), 'autoMemory=false')
      assert.deepEqual(
        await server.request('thread/memoryMode/set', { threadId: optedOut, mode: 'enabled' }),
        {},
      )
      assert.equal(await autoMemory(optedOut), 'autoMemory=true')
      await server.request('thread/memoryMode/set', { threadId: first, mode: 'disabled' })
      assert.equal(await autoMemory(first), 'autoMemory=false')
      await assert.rejects(
        server.request('thread/memoryMode/set', { threadId: first, mode: 'polluted' }),
        /invalid memory mode: polluted/,
      )
      await assert.rejects(
        server.request('thread/memoryMode/set', { threadId: 'missing', mode: 'enabled' }),
        /unknown thread: missing/,
      )

      // A fork remembers like its parent; the ephemeral one the App describes a
      // chat with never does.
      const { thread: fork } = await server.request('thread/fork', { threadId: optedOut })
      assert.equal(await autoMemory(fork.id), 'autoMemory=true')
      const { thread: helper } = await server.request('thread/fork', {
        threadId: optedOut,
        ephemeral: true,
        threadSource: 'thread_description',
      })
      assert.equal(await autoMemory(helper.id), 'autoMemory=false')

      // Claude Code reads and writes its memory as one switch: a new chat gets
      // it only while both generating and using memories are on.
      await write([['memories.use_memories', false]])
      assert.equal(await autoMemory(await server.startThread()), 'autoMemory=false')

      // Turning the feature off stops it everywhere.
      await write([['features.memories', false]])
      assert.equal(await autoMemory(optedOut), 'autoMemory=false')

      // memory/status keeps Codex's bounds and reports nothing consolidated;
      // memory/reset leaves Claude Code's memory folders alone and says so.
      assert.deepEqual(await server.request('memory/status', { minConsolidatedThreads: 4096 }), {
        v2ConsolidatedThreads: 0,
        v2Ready: false,
      })
      await assert.rejects(
        server.request('memory/status', { minConsolidatedThreads: 0 }),
        /minConsolidatedThreads must be between 1 and 4096/,
      )
      await assert.rejects(server.request('memory/reset'), /memory\/reset is not supported/)
    },
    { CLAUDE_CODEX_MEMORIES: '1' },
  )
})

test("Codex's model_auto_compact_token_limit becomes the compaction window of Claude threads", async () => {
  await withServer(async (server) => {
    const window = async (threadId: string) =>
      server.reply(threadId, await server.runTurn(threadId, 'compact window check'))
    const reported = async (params: Record<string, unknown> = {}) =>
      (await server.request('config/read', params)).config.model_auto_compact_token_limit
    const write = (value: unknown) =>
      server.request('config/batchWrite', {
        edits: [{ keyPath: 'model_auto_compact_token_limit', value, mergeStrategy: 'upsert' }],
      })

    // Unset, Claude Code keeps its own window and config/read has none.
    const thread = await server.startThread()
    assert.equal(await window(thread), 'autoCompactWindow=unset')
    assert.equal(await reported(), null)

    // The Codex config file sets it, and a trusted project's file overrides
    // it for threads in the project.
    const project = join(server.home, 'project')
    await mkdir(join(project, '.codex'), { recursive: true })
    await writeFile(
      join(server.home, 'config.toml'),
      [
        'model_auto_compact_token_limit = 300_000',
        '',
        `[projects.${JSON.stringify(project)}]`,
        'trust_level = "trusted"',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(project, '.codex', 'config.toml'),
      'model_auto_compact_token_limit = 600000\n',
    )
    assert.equal(await window(thread), 'autoCompactWindow=300000')
    assert.equal(await reported(), 300_000)
    const inProject = await server.startThread({ cwd: project })
    assert.equal(await window(inProject), 'autoCompactWindow=600000')
    assert.equal(await reported({ cwd: project }), 600_000)

    // What the App writes wins over the files. The window stays within the
    // range Claude Code takes, and config/read reports the one in effect.
    await write(50_000)
    assert.equal(await window(thread), 'autoCompactWindow=100000')
    assert.equal(await window(inProject), 'autoCompactWindow=100000')
    assert.equal(await reported(), 100_000)
    // A value that is not a token count counts as unset.
    await write('lots')
    assert.equal(await window(thread), 'autoCompactWindow=300000')
    await write(null)
    assert.equal(await reported(), 300_000)

    // The config a thread starts or resumes with wins for that thread, and
    // its forks.
    const own = await server.startThread({ config: { model_auto_compact_token_limit: 2_000_000 } })
    assert.equal(await window(own), 'autoCompactWindow=1000000')
    assert.equal(await window(thread), 'autoCompactWindow=300000')
    assert.equal(await reported(), 300_000)
    const { thread: fork } = await server.request('thread/fork', { threadId: own })
    assert.equal(await window(fork.id), 'autoCompactWindow=1000000')
    const { thread: retuned } = await server.request('thread/fork', {
      threadId: own,
      config: { model_auto_compact_token_limit: 400_000 },
    })
    assert.equal(await window(retuned.id), 'autoCompactWindow=400000')
    await server.request('thread/resume', {
      threadId: thread,
      config: { model_auto_compact_token_limit: 150_000 },
    })
    assert.equal(await window(thread), 'autoCompactWindow=150000')
    assert.equal(await window(inProject), 'autoCompactWindow=600000')
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

test('a fork from a turn keeps the turns up to it, and Claude resumes there', async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    const turns: string[] = []
    for (const text of ['one', 'two', 'three']) turns.push(await server.runTurn(parent, text))

    // lastTurnId keeps its turn; beforeTurnId stops short of it.
    const forks: string[] = []
    for (const cutoff of [{ lastTurnId: turns[0] }, { beforeTurnId: turns[1] }]) {
      const { thread: fork } = await server.request('thread/fork', { threadId: parent, ...cutoff })
      assert.deepEqual(ids({ data: fork.turns }), turns.slice(0, 1))
      const check = await server.runTurn(fork.id, 'rewind check')
      assert.equal(
        await server.reply(fork.id, check),
        `resumed mock-${parent} at ${turns[0]}-entry after 0 resets`,
      )
      forks.push(fork.id)
    }

    // excludeTurns still leaves the turns out of the response.
    const { thread: bare } = await server.request('thread/fork', {
      threadId: parent,
      lastTurnId: turns[1],
      excludeTurns: true,
    })
    assert.deepEqual(bare.turns, [])
    const bareCheck = await server.runTurn(bare.id, 'rewind check')
    assert.equal(
      await server.reply(bare.id, bareCheck),
      `resumed mock-${parent} at ${turns[1]}-entry after 0 resets`,
    )

    // A fork of a fork from before its own first turn branches where it did.
    const [early] = forks
    const [own] = ids(await server.request('thread/turns/list', { threadId: early }))
    const { thread: inner } = await server.request('thread/fork', {
      threadId: early,
      beforeTurnId: own,
    })
    assert.deepEqual(inner.turns, [])
    const innerCheck = await server.runTurn(inner.id, 'rewind check')
    assert.equal(
      await server.reply(inner.id, innerCheck),
      `resumed mock-${parent} at ${turns[0]}-entry after 0 resets`,
    )

    // The parent keeps its turns and its whole session.
    assert.deepEqual(
      ids(await server.request('thread/turns/list', { threadId: parent, sortDirection: 'asc' })),
      turns,
    )
    const parentCheck = await server.runTurn(parent, 'rewind check')
    assert.equal(
      await server.reply(parent, parentCheck),
      `resumed mock-${parent} at end after 0 resets`,
    )
  })
})

test("a fork before a thread's first turn starts Claude over, and so does its full rollback", async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    const first = await server.runTurn(parent, 'one')
    await server.runTurn(parent, 'two')
    const { thread: fork } = await server.request('thread/fork', {
      threadId: parent,
      beforeTurnId: first,
    })
    assert.deepEqual(fork.turns, [])

    const check = await server.runTurn(fork.id, 'rewind check')
    assert.equal(await server.reply(fork.id, check), 'resumed nothing at end after 0 resets')
    // Not the parent's session, which remembers the turns the fork left out.
    await server.request('thread/rollback', { threadId: fork.id, numTurns: 1 })
    const again = await server.runTurn(fork.id, 'rewind check')
    assert.equal(await server.reply(fork.id, again), 'resumed nothing at end after 1 resets')
  })
})

test('thread/fork rejects a fork point it cannot honor', async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    const done = await server.runTurn(parent, 'one')
    for (const model of [undefined, 'gpt-5.4-mini']) {
      const fork = (params: Record<string, unknown>) =>
        server.request('thread/fork', { threadId: parent, model, ...params })
      await assert.rejects(
        fork({ lastTurnId: done, beforeTurnId: done }),
        /`beforeTurnId` cannot be combined with `lastTurnId`/,
      )
      await assert.rejects(
        fork({ lastTurnId: 'nope' }),
        /lastTurnId 'nope' was not found in the source thread/,
      )
      await assert.rejects(
        fork({ beforeTurnId: 'nope' }),
        /beforeTurnId 'nope' was not found in the source thread/,
      )
    }

    const from = server.mark()
    const { turn } = await server.startTurn(parent, `busy ${'x'.repeat(300)}`)
    await assert.rejects(
      server.request('thread/fork', { threadId: parent, lastTurnId: turn.id }),
      new RegExp(`lastTurnId '${turn.id}' identifies an in-progress turn`),
    )
    // A fork from before the running turn leaves it out.
    const { thread: fork } = await server.request('thread/fork', {
      threadId: parent,
      beforeTurnId: turn.id,
    })
    assert.deepEqual(ids({ data: fork.turns }), [done])
    await server.waitFor('turn/completed', (params) => params.turn.id === turn.id, from)
    // The rejected forks made no threads.
    assert.deepEqual(
      ids(await server.request('thread/list')).toSorted(),
      [parent, fork.id].toSorted(),
    )
  })
})

test('a fork from turns without checkpoints keeps all of Claude context and warns', async () => {
  await withServer(async (server) => {
    const parent = await server.startThread()
    const turns: string[] = []
    for (const text of ['no checkpoint one', 'no checkpoint two'])
      turns.push(await server.runTurn(parent, text))

    let from = server.mark()
    const { thread: fork } = await server.request('thread/fork', {
      threadId: parent,
      lastTurnId: turns[0],
    })
    assert.deepEqual(ids({ data: fork.turns }), turns.slice(0, 1))
    const warnings = server.notified('configWarning', from)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].summary, /remembers the turns after the fork point/)
    assert.match(warnings[0].details, new RegExp(`${parent}.*${fork.id}`))
    const check = await server.runTurn(fork.id, 'rewind check')
    assert.equal(await server.reply(fork.id, check), `resumed mock-${parent} at end after 0 resets`)

    // No warning when the fork leaves nothing out, or Claude has nothing to
    // forget: a fork onto a Codex model starts its own session.
    from = server.mark()
    await server.request('thread/fork', { threadId: parent, lastTurnId: turns[1] })
    await server.request('thread/fork', { threadId: parent })
    const { thread: codexFork } = await server.request('thread/fork', {
      threadId: parent,
      beforeTurnId: turns[1],
      model: 'gpt-5.4-mini',
    })
    assert.deepEqual(ids({ data: codexFork.turns }), turns.slice(0, 1))
    assert.deepEqual(server.notified('configWarning', from), [])
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
