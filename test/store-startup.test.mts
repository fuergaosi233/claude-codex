import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PINNED_SECTION_ID, SessionStore } from '../src/store.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void
    prepare(sql: string): { all(...params: unknown[]): any[] }
    close(): void
  }
}

// SQLite bumps the file change counter (header bytes 24..27) on every write
// transaction that commits a change to the file.
function changeCounter(path: string): number {
  return readFileSync(path).readUInt32BE(24)
}

function insertThread(db: InstanceType<typeof DatabaseSync>, id: string, columns: string): void {
  db.exec(`INSERT INTO threads (id, session_id, preview, cwd, model, model_provider, source,
    created_at, updated_at, status_json) VALUES ('${id}', '${id}', '', '/w', 'm', 'claude',
    'appServer', 0, 7, '{"type":"idle"}')`)
  if (columns) db.exec(`UPDATE threads SET ${columns} WHERE id = '${id}'`)
}

test('startup repairs legacy thread rows once and leaves a clean store unwritten', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-store-startup-'))
  const path = join(home, 'state.sqlite')
  try {
    new SessionStore(path).close()
    const raw = new DatabaseSync(path)
    // What older adapter versions wrote: a pin flag with no section, a stale
    // flag on a custom section, ordering on an unsectioned row, and empty or
    // snake_case values in the enum-like columns.
    raw.exec(`INSERT INTO thread_sections (id, name, created_at, updated_at)
      VALUES ('custom', 'Custom', 0, 0)`)
    insertThread(raw, 'pinned', 'is_pinned = 1')
    insertThread(raw, 'custom', `is_pinned = 1, section_id = 'custom', section_position = 0`)
    insertThread(raw, 'stray', 'section_entered_at = 5, section_position = 3')
    insertThread(
      raw,
      'enums',
      `source = 'app_server', thread_source = '', agent_role = '', agent_nickname = '',
       base_instructions = '', developer_instructions = ''`,
    )
    insertThread(raw, 'clean', `thread_source = 'user', base_instructions = 'keep'`)
    raw.close()

    new SessionStore(path).close()
    const check = new DatabaseSync(path)
    const rows = new Map(
      check
        .prepare(`SELECT * FROM threads ORDER BY id`)
        .all()
        .map((row) => [row.id, row]),
    )
    check.close()
    const pinned = rows.get('pinned')
    assert.equal(pinned.section_id, PINNED_SECTION_ID)
    assert.equal(pinned.is_pinned, 1)
    assert.equal(pinned.section_entered_at, 7)
    assert.notEqual(pinned.section_position, null)
    assert.equal(rows.get('custom').is_pinned, 0)
    assert.equal(rows.get('custom').section_position, 0)
    assert.equal(rows.get('stray').section_entered_at, null)
    assert.equal(rows.get('stray').section_position, null)
    const enums = rows.get('enums')
    assert.equal(enums.source, 'appServer')
    for (const column of [
      'thread_source',
      'agent_role',
      'agent_nickname',
      'base_instructions',
      'developer_instructions',
    ]) {
      assert.equal(enums[column], null, column)
    }
    assert.equal(rows.get('clean').thread_source, 'user')
    assert.equal(rows.get('clean').base_instructions, 'keep')

    const before = changeCounter(path)
    new SessionStore(path).close()
    new SessionStore(path).close()
    assert.equal(changeCounter(path), before, 'reopening a repaired store must not write')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
