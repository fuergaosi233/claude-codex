import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord } from '../src/types.mjs'

function thread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: id,
    name: null,
    archived: false,
    cwd: '/work',
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    claudeSessionId: null,
    source: 'appServer',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    status: { type: 'idle' },
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
    ...overrides,
  }
}

async function withStore(body: (store: SessionStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-codex-store-indexes-'))
  const previousHome = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = directory
  try {
    await body(new SessionStore(join(directory, 'state.sqlite')))
  } finally {
    if (previousHome === undefined) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

// The store keeps its handle private; the plan is what this suite checks.
function queryPlan(store: SessionStore, sql: string, ...args: Array<string | number>): string[] {
  const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => String((row as { detail: unknown }).detail))
}

test('the default thread list page and fork lookups use an index', async () => {
  await withStore((store) => {
    const page = queryPlan(
      store,
      `SELECT t.* FROM threads t WHERE t.archived = ? AND t.created_at < ? AND t.ephemeral = 0
       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      0,
      Number.MAX_SAFE_INTEGER,
      50,
    )
    assert.ok(
      page.some((detail) => detail.includes('idx_threads_created')),
      page.join('\n'),
    )
    assert.ok(!page.some((detail) => detail.includes('TEMP B-TREE')), page.join('\n'))

    const children = queryPlan(
      store,
      `SELECT t.* FROM threads t WHERE t.archived = ? AND t.created_at > ? AND t.forked_from_id = ?
       ORDER BY t.created_at ASC, t.id ASC LIMIT ?`,
      0,
      -1,
      'root',
      50,
    )
    assert.ok(
      children.some((detail) => detail.includes('idx_threads_forked_from')),
      children.join('\n'),
    )
    assert.ok(!children.some((detail) => /^SCAN t\b/.test(detail)), children.join('\n'))

    // A project's list keeps narrowing by its own index first.
    const project = queryPlan(
      store,
      `SELECT t.* FROM threads t WHERE t.archived = ? AND t.created_at < ? AND t.project_id = ?
       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      0,
      Number.MAX_SAFE_INTEGER,
      'project',
      50,
    )
    assert.ok(
      project.some((detail) => detail.includes('idx_threads_project')),
      project.join('\n'),
    )

    const walk = queryPlan(
      store,
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM threads WHERE forked_from_id = ? AND archived = 0
         UNION
         SELECT child.id FROM descendants parent CROSS JOIN threads child
           ON child.forked_from_id = parent.id WHERE child.archived = 0
       )
       SELECT id FROM descendants WHERE id <> ?`,
      'root',
      'root',
    )
    assert.ok(!walk.some((detail) => /^SCAN (threads|child)\b/.test(detail)), walk.join('\n'))
    assert.equal(
      walk.filter((detail) => detail.includes('idx_threads_forked_from')).length,
      2,
      walk.join('\n'),
    )
  })
})

test('descendantThreadIds walks the whole unarchived fork tree without a page cap', async () => {
  await withStore((store) => {
    store.upsertThread(thread('root'))
    // More children than one listThreads page holds (50 by default).
    for (let index = 0; index < 75; index += 1) {
      store.upsertThread(
        thread(`child-${index}`, {
          forkedFromId: 'root',
          ephemeral: true,
          threadSource: 'subagent',
          createdAt: 1_700_000_000 + index,
        }),
      )
    }
    store.upsertThread(thread('grandchild', { forkedFromId: 'child-3', ephemeral: true }))
    // An archived child is skipped along with what hangs below it.
    store.upsertThread(thread('archived-child', { forkedFromId: 'root', archived: true }))
    store.upsertThread(thread('below-archived', { forkedFromId: 'archived-child' }))
    store.upsertThread(thread('unrelated'))

    const ids = store.descendantThreadIds('root')
    assert.equal(ids.length, 76)
    assert.equal(new Set(ids).size, 76)
    assert.ok(ids.includes('child-74'))
    assert.ok(ids.includes('grandchild'))
    for (const absent of ['root', 'archived-child', 'below-archived', 'unrelated']) {
      assert.ok(!ids.includes(absent), absent)
    }
    assert.deepEqual(store.descendantThreadIds('unrelated'), [])
  })
})

test('descendantThreadIds stops on a fork cycle', async () => {
  await withStore((store) => {
    store.upsertThread(thread('a', { forkedFromId: 'b' }))
    store.upsertThread(thread('b', { forkedFromId: 'a' }))
    assert.deepEqual(store.descendantThreadIds('a'), ['b'])
  })
})
