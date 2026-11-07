import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord, TurnRecord } from '../src/types.mjs'

async function withStore(run: (store: SessionStore) => void): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-store-search-'))
  const previousHome = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = home
  const store = new SessionStore(join(home, 'state.sqlite'))
  try {
    run(store)
  } finally {
    store.close()
    if (previousHome === undefined) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

function addThread(store: SessionStore, fields: Partial<ThreadRecord> = {}): string {
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  store.upsertThread({
    id,
    sessionId: id,
    forkedFromId: null,
    preview: 'chat',
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
    ...fields,
  })
  return id
}

function addTurn(store: SessionStore, threadId: string, text: string): void {
  const now = Math.floor(Date.now() / 1000)
  const turn: TurnRecord = {
    id: randomUUID(),
    threadId,
    status: 'completed',
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    items: [
      {
        type: 'userMessage',
        id: randomUUID(),
        content: [{ type: 'text', text, text_elements: [] }],
      },
    ],
    diff: '',
    error: null,
  }
  store.upsertTurn(turn)
}

const found = (store: SessionStore, searchTerm: string): string[] =>
  store
    .listThreads({ searchTerm })
    .map((thread) => thread.id)
    .toSorted()

test('thread search ignores case outside ASCII in names, previews and messages', async () => {
  await withStore((store) => {
    const named = addThread(store, { name: 'Привет мир' })
    const previewed = addThread(store, { preview: 'Über alles' })
    const said = addThread(store)
    addTurn(store, said, 'и снова привет')
    const parent = addThread(store)
    addTurn(store, parent, 'ÜBER DEN WOLKEN')
    // Its only match is in the history it was forked with.
    const fork = addThread(store, { forkedFromId: parent })
    store.copyInheritedHistory(fork, parent, 1)
    const greek = addThread(store, { preview: 'οδοστρωτήρας' })
    const cjk = addThread(store, { name: '你好世界' })
    const path = addThread(store)
    addTurn(store, path, 'saved to D:\\Daten\\Ärger')

    assert.deepEqual(found(store, 'привет'), [named, said].toSorted())
    assert.deepEqual(found(store, 'ПРИВЕТ'), [named, said].toSorted())
    assert.deepEqual(found(store, 'über'), [previewed, parent, fork].toSorted())
    assert.deepEqual(found(store, 'ÜBER ALLES'), [previewed])
    // Lowercased on its own, ΟΔΟΣ ends in ς; the text has σ there.
    assert.deepEqual(found(store, 'ΟΔΟΣ'), [greek])
    assert.deepEqual(found(store, '你好'), [cjk])
    assert.deepEqual(found(store, 'd:\\daten\\ärger'), [path])
  })
})

test('thread search still ignores ASCII case and reads %, _ and \\ literally', async () => {
  await withStore((store) => {
    const hello = addThread(store, { name: 'Hello World' })
    const percent = addThread(store, { name: '100% done' })
    addThread(store, { name: '1000 done' })
    const underscore = addThread(store, { name: 'snake_case' })
    addThread(store, { name: 'snakeXcase' })
    const backslash = addThread(store, { name: 'C:\\Temp' })
    addThread(store, { name: 'C:Temp' })
    const path = addThread(store)
    addTurn(store, path, 'saved to D:\\Data\\Notes')
    const other = addThread(store)
    addTurn(store, other, 'saved to D:DataNotes')

    assert.deepEqual(found(store, 'HELLO'), [hello])
    assert.deepEqual(found(store, '100%'), [percent])
    assert.deepEqual(found(store, 'E_C'), [underscore])
    assert.deepEqual(found(store, 'c:\\temp'), [backslash])
    assert.deepEqual(found(store, 'd:\\data\\notes'), [path])
  })
})
