import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'
import type { ThreadItem, ThreadRecord, TurnRecord } from '../src/types.mjs'

const DELTAS = 500

function thread(id: string): ThreadRecord {
  const now = Math.floor(Date.now() / 1000)
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: 'streaming',
    name: null,
    archived: false,
    cwd: process.cwd(),
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    claudeSessionId: null,
    source: 'appServer',
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' },
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    runtimeBackend: 'claude',
    codexSessionId: null,
  } as ThreadRecord
}

function turn(id: string, threadId: string): TurnRecord {
  return {
    id,
    threadId,
    status: 'inProgress',
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null,
    items: [
      { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'hi' }] },
      { type: 'agentMessage', id: 'agent', text: '', phase: null, memoryCitation: null },
    ] as ThreadItem[],
    diff: '',
    error: null,
  }
}

const delta = (index: number) => `d${index} `
const fullText = Array.from({ length: DELTAS }, (_, index) => delta(index)).join('')

function appendText(item: ThreadItem, text: string): ThreadItem {
  return item.type === 'agentMessage' ? { ...item, text: item.text + text } : item
}

function stream(store: SessionStore, turnId: string, count = DELTAS): void {
  for (let index = 0; index < count; index += 1) {
    assert.equal(
      store.streamItem(turnId, 'agent', (item) => appendText(item, delta(index))),
      true,
    )
  }
}

function agentText(record: TurnRecord | null | undefined): string | null {
  const item = record?.items.find((entry) => entry.id === 'agent')
  return item?.type === 'agentMessage' ? item.text : null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withStore(
  body: (context: {
    path: string
    store: SessionStore
    threadId: string
    turnId: string
  }) => Promise<void> | void,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-stream-'))
  const path = join(home, 'state.sqlite')
  const store = new SessionStore(path)
  const threadId = randomUUID()
  const turnId = randomUUID()
  try {
    store.upsertThread(thread(threadId))
    store.upsertTurn(turn(turnId, threadId))
    await body({ path, store, threadId, turnId })
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

// What another process sees: its own connection, outside the store.
function storedText(path: string, turnId: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT items_json FROM turns WHERE id = ?').get(turnId) as
      | { items_json: string }
      | undefined
    if (!row) return null
    const items = JSON.parse(row.items_json) as ThreadItem[]
    return agentText({ items } as TurnRecord)
  } finally {
    db.close()
  }
}

test('streamed deltas show in every read of the turn', async () => {
  await withStore(({ store, threadId, turnId }) => {
    stream(store, turnId)
    assert.equal(agentText(store.getTurn(turnId)), fullText)
    stream(store, turnId, 1)
    assert.equal(agentText(store.listTurns(threadId)[0]), fullText + delta(0))
    stream(store, turnId, 1)
    assert.equal(agentText(store.historyTurns(threadId)[0]), fullText + delta(0) + delta(0))
    stream(store, turnId, 1)
    assert.equal(agentText(store.lastTurn(threadId)), fullText + delta(0).repeat(3))
    stream(store, turnId, 1)
    assert.equal(agentText(store.historyTurn(threadId, turnId)), fullText + delta(0).repeat(4))
  })
})

test('a store write after deltas keeps them', async () => {
  await withStore(({ store, threadId, turnId }) => {
    stream(store, turnId)
    const appended = store.appendItem(turnId, {
      type: 'agentMessage',
      id: 'second',
      text: 'next',
      phase: null,
      memoryCitation: null,
    })
    assert.equal(agentText(appended), fullText)
    stream(store, turnId, 1)
    // A transaction on another table writes the turn first, too.
    store.addInjectedItems(threadId, [{ note: 'x' }])
    assert.equal(agentText(store.getTurn(turnId)), fullText + delta(0))
  })
})

test('completeTurn right after deltas persists the final text', async () => {
  await withStore(({ path, store, turnId }) => {
    stream(store, turnId)
    const completed = store.completeTurn(turnId, 'completed')
    assert.equal(completed?.status, 'completed')
    assert.equal(agentText(completed), fullText)
    assert.equal(storedText(path, turnId), fullText)
  })
})

test('close writes pending deltas, and a reopened store sees them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-stream-'))
  const path = join(home, 'state.sqlite')
  const threadId = randomUUID()
  const turnId = randomUUID()
  try {
    const store = new SessionStore(path)
    store.upsertThread(thread(threadId))
    store.upsertTurn(turn(turnId, threadId))
    stream(store, turnId)
    store.close()
    const reopened = new SessionStore(path)
    try {
      assert.equal(agentText(reopened.getTurn(turnId)), fullText)
    } finally {
      reopened.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('another connection sees streamed deltas within the flush window', async () => {
  await withStore(async ({ path, store, turnId }) => {
    stream(store, turnId)
    const other = new SessionStore(path)
    try {
      await delay(200)
      assert.equal(agentText(other.getTurn(turnId)), fullText)
      assert.equal(storedText(path, turnId), fullText)
    } finally {
      other.close()
    }
  })
})

test('streamItem on an unknown turn changes nothing', async () => {
  await withStore(({ store }) => {
    assert.equal(
      store.streamItem('missing', 'agent', (item) => appendText(item, 'x')),
      false,
    )
    assert.equal(store.getTurn('missing'), null)
  })
})

test('a flush a reader blocks is retried, not lost', async () => {
  const previous = process.env.CLAUDE_CODEX_STATE_DB_TIMEOUT_MS
  // No busy wait, so the timer's write fails at once while the reader holds the file.
  process.env.CLAUDE_CODEX_STATE_DB_TIMEOUT_MS = '0'
  try {
    await withStore(async ({ path, store, turnId }) => {
      const reader = new DatabaseSync(path, { readOnly: true, timeout: 2_000 })
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM turns').get()
      try {
        stream(store, turnId)
        await delay(200)
      } finally {
        reader.exec('COMMIT')
        reader.close()
      }
      assert.equal(storedText(path, turnId), '')
      assert.equal(agentText(store.getTurn(turnId)), fullText)
      assert.equal(storedText(path, turnId), fullText)
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODEX_STATE_DB_TIMEOUT_MS
    else process.env.CLAUDE_CODEX_STATE_DB_TIMEOUT_MS = previous
  }
})
