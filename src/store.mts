import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  ThreadItem,
  ThreadRecord,
  ThreadSectionAppearance,
  ThreadSectionRecord,
  ThreadStatus,
  TurnRecord,
  TurnStatus,
} from './types.mjs'
import { adapterHome, jsonClone, nowSeconds } from './util.mjs'

const require = createRequire(import.meta.url)

export const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318'
export const PINNED_SECTION_NAME = 'Pinned'

type DatabaseSync = any

function openDatabase(path: string): DatabaseSync {
  const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => DatabaseSync }
  return new sqlite.DatabaseSync(path)
}

export class SessionStore {
  private db: DatabaseSync

  constructor(path = join(adapterHome(), 'state.sqlite')) {
    mkdirSync(adapterHome(), { recursive: true, mode: 0o700 })
    this.db = openDatabase(path)
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        forked_from_id TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        section_id TEXT,
        section_entered_at INTEGER,
        section_position INTEGER,
        preview TEXT NOT NULL,
        name TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        model_provider TEXT NOT NULL,
        claude_session_id TEXT,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        items_json TEXT NOT NULL,
        diff TEXT NOT NULL DEFAULT '',
        error_json TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, started_at);
      CREATE TABLE IF NOT EXISTS thread_sections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        appearance_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_sections_created ON thread_sections(created_at, id);
    `)
    this.ensureColumn('threads', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('threads', 'section_id', 'TEXT')
    this.ensureColumn('threads', 'section_entered_at', 'INTEGER')
    this.ensureColumn('threads', 'section_position', 'INTEGER')
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_threads_section_position ON threads(section_id, section_position, id)',
    )
    this.ensureColumn('threads', 'reasoning_effort', 'TEXT')
    this.ensureColumn('threads', 'approval_policy', 'TEXT')
    this.ensureColumn('threads', 'sandbox_mode', 'TEXT')
    this.ensureColumn('threads', 'permission_profile_id', 'TEXT')
    this.ensureColumn('threads', 'ephemeral', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('threads', 'thread_source', 'TEXT')
    this.ensureColumn('threads', 'agent_role', 'TEXT')
    this.ensureColumn('threads', 'agent_nickname', 'TEXT')
    this.ensureColumn('threads', 'base_instructions', 'TEXT')
    this.ensureColumn('threads', 'developer_instructions', 'TEXT')
    this.ensureColumn('threads', 'personality', 'TEXT')
    // Which runtime drives this thread — 'claude' (default) or 'codex'.
    // Default 'claude' keeps existing threads on the SDK runtime, new
    // codex-model threads flip to 'codex' at thread/start.
    this.ensureColumn('threads', 'runtime_backend', "TEXT NOT NULL DEFAULT 'claude'")
    // Real Codex session id for runtime_backend='codex' threads (returned
    // by `codex exec` as thread.started.thread_id). NULL until first turn.
    this.ensureColumn('threads', 'codex_session_id', 'TEXT')
    this.ensurePinnedSection()
    this.migrateLegacyPinState()
    this.sanitizeLegacyEnumColumns()
  }

  private ensurePinnedSection(): void {
    const now = nowSeconds()
    this.db
      .prepare(
        `INSERT OR IGNORE INTO thread_sections
         (id, name, appearance_json, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)`,
      )
      .run(PINNED_SECTION_ID, PINNED_SECTION_NAME, now, now)
  }

  private migrateLegacyPinState(): void {
    this.db
      .prepare(
        `UPDATE threads
         SET section_id = ?,
             section_entered_at = COALESCE(section_entered_at, updated_at),
             section_position = COALESCE(section_position, rowid)
         WHERE is_pinned = 1 AND (section_id IS NULL OR section_id = '')`,
      )
      .run(PINNED_SECTION_ID)
    this.db
      .prepare(
        `UPDATE threads
         SET is_pinned = CASE WHEN section_id = ? THEN 1 ELSE 0 END
         WHERE section_id IS NOT NULL OR is_pinned = 1`,
      )
      .run(PINNED_SECTION_ID)
    this.db.exec(
      `UPDATE threads
       SET section_entered_at = NULL, section_position = NULL
       WHERE section_id IS NULL`,
    )
  }

  // Older versions of the adapter stored empty strings (and a snake_case
  // `app_server` source) in columns the Codex App treats as strict enums.
  // Codex App's ts-rs deserializer rejects the invalid values on `thread/list`
  // / `thread/read`, surfacing as the generic "Oops, an error has occurred"
  // toast when reopening a page. Repair the rows in place once on startup so
  // a downgrade-then-upgrade cycle doesn't leave permanent landmines.
  private sanitizeLegacyEnumColumns(): void {
    try {
      this.db.exec(`
        UPDATE threads
        SET thread_source = NULL
        WHERE thread_source IS NOT NULL
          AND thread_source NOT IN ('user', 'subagent', 'memory_consolidation');
        UPDATE threads SET agent_role = NULL WHERE agent_role = '';
        UPDATE threads SET agent_nickname = NULL WHERE agent_nickname = '';
        UPDATE threads SET base_instructions = NULL WHERE base_instructions = '';
        UPDATE threads SET developer_instructions = NULL WHERE developer_instructions = '';
        UPDATE threads SET source = 'appServer' WHERE source = 'app_server';
      `)
    } catch {
      // Migrations are best-effort; never block adapter startup on cleanup.
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all()
    if (rows.some((row: any) => String(row.name) === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  upsertThread(thread: ThreadRecord): void {
    const sectionId =
      thread.sectionId === undefined
        ? thread.isPinned === true
          ? PINNED_SECTION_ID
          : null
        : thread.sectionId
    const isPinned = sectionId === PINNED_SECTION_ID
    const sectionEnteredAt =
      sectionId == null ? null : (thread.sectionEnteredAt ?? thread.updatedAt)
    const sectionPosition = sectionId == null ? null : (thread.sectionPosition ?? null)
    this.db
      .prepare(`
        INSERT INTO threads (
          id, session_id, forked_from_id, is_pinned, section_id, section_entered_at, section_position,
          preview, name, archived, cwd, model, reasoning_effort, model_provider, claude_session_id,
          source, created_at, updated_at, status_json,
          approval_policy, sandbox_mode, permission_profile_id, ephemeral, thread_source, agent_role, agent_nickname,
          base_instructions, developer_instructions, personality, runtime_backend, codex_session_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          session_id=excluded.session_id,
          forked_from_id=excluded.forked_from_id,
          is_pinned=excluded.is_pinned,
          section_id=excluded.section_id,
          section_entered_at=excluded.section_entered_at,
          section_position=excluded.section_position,
          preview=excluded.preview,
          name=excluded.name,
          archived=excluded.archived,
          cwd=excluded.cwd,
          model=excluded.model,
          reasoning_effort=excluded.reasoning_effort,
          model_provider=excluded.model_provider,
          claude_session_id=excluded.claude_session_id,
          source=excluded.source,
          updated_at=excluded.updated_at,
          status_json=excluded.status_json,
          approval_policy=excluded.approval_policy,
          sandbox_mode=excluded.sandbox_mode,
          permission_profile_id=excluded.permission_profile_id,
          ephemeral=excluded.ephemeral,
          thread_source=excluded.thread_source,
          agent_role=excluded.agent_role,
          agent_nickname=excluded.agent_nickname,
          base_instructions=excluded.base_instructions,
          developer_instructions=excluded.developer_instructions,
          personality=excluded.personality,
          runtime_backend=excluded.runtime_backend,
          codex_session_id=excluded.codex_session_id
      `)
      .run(
        thread.id,
        thread.sessionId,
        thread.forkedFromId,
        isPinned ? 1 : 0,
        sectionId,
        sectionEnteredAt,
        sectionPosition,
        thread.preview,
        thread.name,
        thread.archived ? 1 : 0,
        thread.cwd,
        thread.model,
        thread.reasoningEffort,
        thread.modelProvider,
        thread.claudeSessionId,
        thread.source,
        thread.createdAt,
        thread.updatedAt,
        JSON.stringify(thread.status),
        thread.approvalPolicy,
        thread.sandboxMode,
        thread.permissionProfileId ?? null,
        thread.ephemeral ? 1 : 0,
        thread.threadSource,
        thread.agentRole,
        thread.agentNickname,
        thread.baseInstructions,
        thread.developerInstructions,
        thread.personality,
        thread.runtimeBackend,
        thread.codexSessionId,
      )
  }

  getThread(id: string): ThreadRecord | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id)
    return row ? this.rowToThread(row) : null
  }

  listThreads(
    options: {
      archived?: boolean | null
      limit?: number | null
      cursor?: string | null
      isPinned?: boolean | null
      cwd?: string | string[] | null
      includeEphemeral?: boolean
      parentThreadId?: string | null
      ancestorThreadId?: string | null
      sourceKinds?: string[]
      sectionId?: string | null | undefined
      sortKey?: 'created_at' | 'updated_at' | 'recency_at' | 'section_position'
      sortDirection?: 'asc' | 'desc'
    } = {},
  ): ThreadRecord[] {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 200))
    const archived = options.archived === true ? 1 : 0
    const sortKey =
      options.sortKey === 'updated_at' ||
      options.sortKey === 'recency_at' ||
      options.sortKey === 'section_position'
        ? options.sortKey
        : 'created_at'
    const sortExpression =
      sortKey === 'section_position'
        ? 'COALESCE(t.section_position, t.created_at)'
        : `t.${sortKey === 'created_at' ? 'created_at' : 'updated_at'}`
    const sortDirection = options.sortDirection === 'asc' ? 'ASC' : 'DESC'
    const cursor = options.cursor
      ? Number(options.cursor)
      : sortDirection === 'ASC'
        ? -1
        : Number.MAX_SAFE_INTEGER
    const where = ['t.archived = ?', `${sortExpression} ${sortDirection === 'ASC' ? '>' : '<'} ?`]
    const args: unknown[] = [archived, cursor]
    if (options.isPinned != null) {
      where.push('t.is_pinned = ?')
      args.push(options.isPinned ? 1 : 0)
    }
    if (options.sectionId !== undefined) {
      if (options.sectionId === null) {
        where.push('t.section_id IS NULL')
      } else {
        where.push('t.section_id = ?')
        args.push(options.sectionId)
      }
    }
    const parentThreadId = options.parentThreadId ?? null
    const ancestorThreadId = options.ancestorThreadId ?? null
    const sourceKinds = options.sourceKinds ?? []

    if (parentThreadId != null) {
      where.push('t.forked_from_id = ?')
      args.push(parentThreadId)
    }
    if (ancestorThreadId != null) {
      where.push('t.id IN (SELECT id FROM descendants)')
    }

    if (sourceKinds.length > 0) {
      const predicates = sourceKinds.flatMap((kind) => {
        switch (kind) {
          case 'subAgent':
          case 'subAgentThreadSpawn':
            return ["(t.thread_source = 'subagent' AND t.forked_from_id IS NOT NULL)"]
          case 'subAgentReview':
          case 'subAgentCompact':
          case 'subAgentOther':
            // These source kinds need a persisted discriminator that this
            // adapter does not have. Fail closed instead of mislabelling a
            // thread-spawn child as a review/compact/other subagent.
            return []
          case 'user':
            return ["t.thread_source = 'user'"]
          case 'memoryConsolidation':
            return ["t.thread_source = 'memory_consolidation'"]
          case 'appServer':
          case 'cli':
          case 'exec':
          case 'vscode':
          case 'unknown':
            return [`t.source = '${kind}'`]
          default:
            return []
        }
      })
      where.push(predicates.length > 0 ? `(${predicates.join(' OR ')})` : '1 = 0')
    }

    // Ephemeral threads (Codex App's internal title generators, subagent
    // children, memory-consolidation runs) shouldn't appear in the user's
    // session list. Topology queries are the exception: Codex App asks for
    // subagent descendants without sending our legacy includeEphemeral flag.
    const hasSubagentSourceFilter = sourceKinds.some((kind) =>
      ['subAgent', 'subAgentThreadSpawn'].includes(kind),
    )
    const topologyQuery =
      parentThreadId != null || ancestorThreadId != null || hasSubagentSourceFilter
    if (!options.includeEphemeral && !topologyQuery) where.push('t.ephemeral = 0')

    const cwdList = Array.isArray(options.cwd) ? options.cwd : options.cwd ? [options.cwd] : []
    if (cwdList.length > 0) {
      const placeholders = cwdList.map(() => '?').join(',')
      where.push(`t.cwd IN (${placeholders})`)
      args.push(...cwdList)
    }

    const cte =
      ancestorThreadId == null
        ? ''
        : `WITH RECURSIVE descendants(id) AS (
            SELECT id FROM threads WHERE forked_from_id = ?
            UNION
            SELECT child.id FROM threads child JOIN descendants parent ON child.forked_from_id = parent.id
          )`
    const queryArgs = ancestorThreadId == null ? args : [ancestorThreadId, ...args]
    const rows = this.db
      .prepare(
        `${cte} SELECT t.* FROM threads t WHERE ${where.join(' AND ')} ORDER BY ${sortExpression} ${sortDirection}, t.id ${sortDirection} LIMIT ?`,
      )
      .all(...queryArgs, limit)
    return rows.map((row: unknown) => this.rowToThread(row))
  }

  listSections(limit = 100, cursor: string | null = null): ThreadSectionRecord[] {
    const boundedLimit = Math.max(1, Math.min(Number(limit || 100), 200))
    const offset = cursor == null ? 0 : Math.max(0, Number(cursor) || 0)
    const rows = this.db
      .prepare(
        `SELECT * FROM thread_sections
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(PINNED_SECTION_ID, boundedLimit, offset)
    return rows.map((row: unknown) => this.rowToSection(row))
  }

  getSection(id: string): ThreadSectionRecord | null {
    const row = this.db.prepare('SELECT * FROM thread_sections WHERE id = ?').get(id)
    if (row) return this.rowToSection(row)
    // Keep the reserved section available even if a hand-created legacy DB was
    // opened before the migration seed ran.
    if (id === PINNED_SECTION_ID) {
      return { id: PINNED_SECTION_ID, name: PINNED_SECTION_NAME, appearance: null }
    }
    return null
  }

  createSection(
    id: string,
    name: string,
    appearance: ThreadSectionAppearance | null = null,
  ): ThreadSectionRecord {
    const normalizedName = name.trim()
    if (!normalizedName) throw new Error('section name must not be empty')
    if (id === PINNED_SECTION_ID) throw new Error('the pinned section is reserved')
    const now = nowSeconds()
    this.db
      .prepare(
        `INSERT INTO thread_sections
         (id, name, appearance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, normalizedName, appearance == null ? null : JSON.stringify(appearance), now, now)
    return this.getSection(id) as ThreadSectionRecord
  }

  updateSection(
    id: string,
    name: string,
    appearance: ThreadSectionAppearance | null = null,
  ): ThreadSectionRecord {
    if (!this.getSection(id)) throw new Error(`unknown section: ${id}`)
    const normalizedName = id === PINNED_SECTION_ID ? PINNED_SECTION_NAME : name.trim()
    if (!normalizedName) throw new Error('section name must not be empty')
    this.db
      .prepare(
        `UPDATE thread_sections
         SET name = ?, appearance_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(normalizedName, appearance == null ? null : JSON.stringify(appearance), nowSeconds(), id)
    return this.getSection(id) as ThreadSectionRecord
  }

  deleteSection(id: string): void {
    if (id === PINNED_SECTION_ID) throw new Error('the pinned section is reserved')
    if (!this.getSection(id)) throw new Error(`unknown section: ${id}`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `UPDATE threads
           SET section_id = NULL,
               section_entered_at = NULL,
               section_position = NULL,
               is_pinned = 0
           WHERE section_id = ?`,
        )
        .run(id)
      this.db.prepare('DELETE FROM thread_sections WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw error
    }
  }

  moveThreadToSection(
    threadId: string,
    sectionId: string | null,
    beforeThreadId: string | null = null,
  ): ThreadRecord {
    const thread = this.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    if (sectionId != null && !this.getSection(sectionId))
      throw new Error(`unknown section: ${sectionId}`)

    const oldSectionId =
      thread.sectionId === undefined
        ? thread.isPinned === true
          ? PINNED_SECTION_ID
          : null
        : (thread.sectionId ?? null)
    const oldIds = this.sectionThreadIds(oldSectionId, threadId)
    const targetIds = sectionId == null ? [] : this.sectionThreadIds(sectionId, threadId)
    let targetPosition: number | null = null
    if (sectionId != null) {
      const beforeIndex = beforeThreadId == null ? -1 : targetIds.indexOf(beforeThreadId)
      targetPosition = beforeIndex >= 0 ? beforeIndex : targetIds.length
      targetIds.splice(targetPosition, 0, threadId)
    }

    const enteredAt =
      sectionId == null
        ? null
        : oldSectionId === sectionId
          ? (thread.sectionEnteredAt ?? nowSeconds())
          : nowSeconds()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (oldSectionId !== sectionId && oldSectionId != null) this.renumberSection(oldIds)
      if (sectionId != null) this.renumberSection(targetIds)
      this.db
        .prepare(
          `UPDATE threads
           SET section_id = ?,
               section_entered_at = ?,
               section_position = ?,
               is_pinned = ?
           WHERE id = ?`,
        )
        .run(
          sectionId,
          enteredAt,
          targetPosition,
          sectionId === PINNED_SECTION_ID ? 1 : 0,
          threadId,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw error
    }
    const moved = this.getThread(threadId)
    if (!moved) throw new Error(`unknown thread: ${threadId}`)
    return moved
  }

  private sectionThreadIds(sectionId: string | null, excludeThreadId: string): string[] {
    const rows =
      sectionId == null
        ? this.db
            .prepare(
              `SELECT id FROM threads
               WHERE section_id IS NULL AND id <> ?
               ORDER BY COALESCE(section_position, created_at), updated_at, id`,
            )
            .all(excludeThreadId)
        : this.db
            .prepare(
              `SELECT id FROM threads
               WHERE section_id = ? AND id <> ?
               ORDER BY COALESCE(section_position, created_at), updated_at, id`,
            )
            .all(sectionId, excludeThreadId)
    return rows.map((row: any) => String(row.id))
  }

  private renumberSection(threadIds: string[]): void {
    const update = this.db.prepare('UPDATE threads SET section_position = ? WHERE id = ?')
    for (const [position, threadId] of threadIds.entries()) update.run(position, threadId)
  }

  updateThreadStatus(threadId: string, status: ThreadStatus): void {
    this.db
      .prepare('UPDATE threads SET status_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(status), nowSeconds(), threadId)
  }

  updateThreadName(threadId: string, name: string | null): void {
    this.db
      .prepare('UPDATE threads SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, nowSeconds(), threadId)
  }

  updateClaudeSessionId(threadId: string, claudeSessionId: string | null): void {
    this.db
      .prepare('UPDATE threads SET claude_session_id = ?, updated_at = ? WHERE id = ?')
      .run(claudeSessionId, nowSeconds(), threadId)
  }

  // Stored separately from Claude's session id so a thread that was
  // codex-backed can be later inspected without confusing its provenance,
  // and so a codex thread's resume id never collides with a claude session id.
  updateCodexSessionId(threadId: string, codexSessionId: string | null): void {
    this.db
      .prepare('UPDATE threads SET codex_session_id = ?, updated_at = ? WHERE id = ?')
      .run(codexSessionId, nowSeconds(), threadId)
  }

  setArchived(threadId: string, archived: boolean): void {
    this.db
      .prepare('UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, nowSeconds(), threadId)
  }

  upsertTurn(turn: TurnRecord): void {
    this.db
      .prepare(`
        INSERT INTO turns (id, thread_id, status, started_at, completed_at, duration_ms, items_json, diff, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          started_at=excluded.started_at,
          completed_at=excluded.completed_at,
          duration_ms=excluded.duration_ms,
          items_json=excluded.items_json,
          diff=excluded.diff,
          error_json=excluded.error_json
      `)
      .run(
        turn.id,
        turn.threadId,
        turn.status,
        turn.startedAt,
        turn.completedAt,
        turn.durationMs,
        JSON.stringify(turn.items),
        turn.diff,
        turn.error == null ? null : JSON.stringify(turn.error),
      )
  }

  getTurn(id: string): TurnRecord | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id)
    return row ? this.rowToTurn(row) : null
  }

  listTurns(threadId: string): TurnRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at ASC')
      .all(threadId)
    return rows.map((row: unknown) => this.rowToTurn(row))
  }

  // Used by thread/rollback to drop the N most recent turns from a thread's
  // history. Codex App's rewind UI calls this when the user wants to redo a
  // turn — without it our handler used to no-op and the App's "Rewind" button
  // appeared dead. Returns the number of turns actually removed.
  deleteRecentTurns(threadId: string, numTurns: number): number {
    if (numTurns <= 0) return 0
    const ids = this.db
      .prepare('SELECT id FROM turns WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(threadId, numTurns) as Array<{ id: string }>
    if (ids.length === 0) return 0
    const stmt = this.db.prepare('DELETE FROM turns WHERE id = ?')
    for (const row of ids) stmt.run(row.id)
    return ids.length
  }

  appendItem(turnId: string, item: ThreadItem): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    turn.items.push(jsonClone(item))
    this.upsertTurn(turn)
    return turn
  }

  updateItem(
    turnId: string,
    itemId: string,
    updater: (item: ThreadItem) => ThreadItem,
  ): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    turn.items = turn.items.map((item) => (item.id === itemId ? updater(jsonClone(item)) : item))
    this.upsertTurn(turn)
    return turn
  }

  updateItemAndMoveToEnd(
    turnId: string,
    itemId: string,
    updater: (item: ThreadItem) => ThreadItem,
  ): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    const index = turn.items.findIndex((item) => item.id === itemId)
    if (index < 0) return turn
    const current = turn.items[index]
    if (!current) return turn
    const updated = updater(jsonClone(current))
    turn.items = [...turn.items.slice(0, index), ...turn.items.slice(index + 1), updated]
    this.upsertTurn(turn)
    return turn
  }

  completeTurn(
    turnId: string,
    status: TurnStatus,
    error: unknown | null = null,
  ): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    const completedAt = nowSeconds()
    turn.status = status
    turn.completedAt = completedAt
    turn.durationMs =
      turn.startedAt == null ? null : Math.max(0, (completedAt - turn.startedAt) * 1000)
    turn.error = error
    this.upsertTurn(turn)
    return turn
  }

  recoverStaleInProgressTurns(message = 'server restarted before completing turn'): number {
    const rows = this.db
      .prepare('SELECT id, thread_id, started_at, items_json FROM turns WHERE status = ?')
      .all('inProgress') as Array<{
      id: string
      thread_id: string
      started_at: number | null
      items_json: string
    }>
    const completedAt = nowSeconds()
    const errorJson = JSON.stringify({ message })
    const updateTurn = this.db.prepare(`
      UPDATE turns
      SET status = ?, completed_at = ?, duration_ms = ?, error_json = ?, items_json = ?
      WHERE id = ?
    `)
    const updateThread = this.db.prepare(
      'UPDATE threads SET status_json = ?, updated_at = ? WHERE id = ?',
    )
    const seenThreads = new Set<string>()
    let recoveredCount = 0
    for (const row of rows) {
      const startedAt = row.started_at == null ? null : Number(row.started_at)
      const durationMs = startedAt == null ? null : Math.max(0, (completedAt - startedAt) * 1000)
      updateTurn.run(
        'interrupted',
        completedAt,
        durationMs,
        errorJson,
        this.terminalizeStaleItems(row.items_json, message),
        row.id,
      )
      seenThreads.add(String(row.thread_id))
      recoveredCount += 1
    }
    for (const threadId of seenThreads) {
      updateThread.run(JSON.stringify({ type: 'idle' }), completedAt, threadId)
    }
    const terminalRows = this.db
      .prepare('SELECT id, thread_id, status, items_json FROM turns WHERE status <> ?')
      .all('inProgress') as Array<{
      id: string
      thread_id: string
      status: TurnStatus
      items_json: string
    }>
    const updateItems = this.db.prepare('UPDATE turns SET items_json = ? WHERE id = ?')
    const repairThreadIds = new Set<string>()
    for (const row of terminalRows) {
      // A successful legacy Codex cc turn may contain only a
      // `subAgentActivity: started` marker. Remove that optional marker during
      // recovery so the canonical spawnAgent/wait terminal state is used and
      // a cold-opened child cannot be revived as working.
      const itemsJson = this.terminalizeStaleItems(
        row.items_json,
        message,
        row.status !== 'completed',
        row.status === 'completed',
      )
      if (itemsJson === row.items_json) continue
      updateItems.run(itemsJson, row.id)
      repairThreadIds.add(String(row.thread_id))
      recoveredCount += 1
    }
    const reconcileThread = this.db.prepare(
      `UPDATE threads SET status_json = ?, updated_at = ?
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM turns WHERE thread_id = threads.id AND status = ?)`,
    )
    for (const threadId of repairThreadIds) {
      reconcileThread.run(JSON.stringify({ type: 'idle' }), completedAt, threadId, 'inProgress')
    }
    // A crash can land between completeTurn() and the following
    // setThreadStatus(..., idle). In that window every turn is already
    // terminal, so the item JSON is unchanged and the repairThreadIds path
    // above has nothing to trigger. Reconcile those active threads directly;
    // never touch a thread that still owns an in-progress turn.
    const reconcileTerminalActiveThreads = this.db.prepare(
      `UPDATE threads SET status_json = ?, updated_at = ?
       WHERE json_extract(status_json, '$.type') = 'active'
         AND NOT EXISTS (SELECT 1 FROM turns WHERE thread_id = threads.id AND status = ?)`,
    )
    const reconciled = reconcileTerminalActiveThreads.run(
      JSON.stringify({ type: 'idle' }),
      completedAt,
      'inProgress',
    ) as { changes?: number }
    recoveredCount += Number(reconciled.changes ?? 0)
    return recoveredCount
  }

  // A recovered turn is also replayed from its persisted item list. Clear any
  // item-level liveness markers so the App's spinner projection cannot keep a
  // child agent in `working` after the turn/thread has been terminalized.
  private terminalizeStaleItems(
    itemsJson: string,
    message: string,
    terminalizeActivity = true,
    stripCompletedActivity = false,
  ): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(itemsJson)
    } catch {
      return '[]'
    }
    if (!Array.isArray(parsed)) return '[]'

    const items = parsed
      .map((raw) => {
        if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const item = raw as Record<string, unknown>
        if (stripCompletedActivity && item.type === 'subAgentActivity') return null
        if (
          terminalizeActivity &&
          item.type === 'subAgentActivity' &&
          (item.kind === 'started' || item.kind === 'interacted')
        ) {
          return { ...item, kind: 'interrupted' }
        }
        // Older adapter builds persisted the newer `completed` activity kind,
        // which Codex cc 26.x cannot deserialize. `interrupted` is the legacy
        // terminal marker understood by the App reducer and prevents a cold
        // open from reviving the child as working.
        if (item.type === 'subAgentActivity' && item.kind === 'completed') {
          return { ...item, kind: 'interrupted' }
        }
        if (item.type === 'collabAgentToolCall') {
          const agentsStates = item.agentsStates
          const nextStates =
            agentsStates && typeof agentsStates === 'object' && !Array.isArray(agentsStates)
              ? Object.fromEntries(
                  Object.entries(agentsStates as Record<string, unknown>).map(
                    ([threadId, rawState]) => {
                      if (
                        rawState == null ||
                        typeof rawState !== 'object' ||
                        Array.isArray(rawState)
                      )
                        return [threadId, rawState]
                      const state = rawState as Record<string, unknown>
                      if (state.status !== 'pendingInit' && state.status !== 'running')
                        return [threadId, state]
                      return [
                        threadId,
                        { ...state, status: 'errored', message: state.message ?? message },
                      ]
                    },
                  ),
                )
              : agentsStates
          return {
            ...item,
            ...(item.status === 'inProgress' ? { status: 'failed' } : {}),
            agentsStates: nextStates,
          }
        }
        if (item.status === 'inProgress') return { ...item, status: 'failed' }
        return item
      })
      .filter((item) => item != null)
    return JSON.stringify(items)
  }

  updateTurnDiff(turnId: string, diff: string): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    turn.diff = diff
    this.upsertTurn(turn)
    return turn
  }

  close(): void {
    this.db.close()
  }

  private rowToThread(row: any): ThreadRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      forkedFromId: row.forked_from_id == null ? null : String(row.forked_from_id),
      isPinned:
        String(row.section_id ?? '') === PINNED_SECTION_ID || Number(row.is_pinned ?? 0) === 1,
      sectionId: row.section_id == null ? null : String(row.section_id),
      sectionEnteredAt: row.section_entered_at == null ? null : Number(row.section_entered_at),
      sectionPosition: row.section_position == null ? null : Number(row.section_position),
      preview: String(row.preview ?? ''),
      name: row.name == null ? null : String(row.name),
      archived: Number(row.archived) === 1,
      cwd: String(row.cwd),
      model: String(row.model),
      reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
      modelProvider: String(row.model_provider),
      claudeSessionId: row.claude_session_id == null ? null : String(row.claude_session_id),
      source: String(row.source),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      status: JSON.parse(String(row.status_json)),
      approvalPolicy: row.approval_policy == null ? null : String(row.approval_policy),
      sandboxMode: row.sandbox_mode == null ? null : String(row.sandbox_mode),
      permissionProfileId:
        row.permission_profile_id == null ? null : String(row.permission_profile_id),
      ephemeral: Number(row.ephemeral ?? 0) === 1,
      threadSource: row.thread_source == null ? null : String(row.thread_source),
      agentRole: row.agent_role == null ? null : String(row.agent_role),
      agentNickname: row.agent_nickname == null ? null : String(row.agent_nickname),
      baseInstructions: row.base_instructions == null ? null : String(row.base_instructions),
      developerInstructions:
        row.developer_instructions == null ? null : String(row.developer_instructions),
      personality: row.personality == null ? null : String(row.personality),
      runtimeBackend: row.runtime_backend === 'codex' ? 'codex' : 'claude',
      codexSessionId: row.codex_session_id == null ? null : String(row.codex_session_id),
    }
  }

  private rowToSection(row: any): ThreadSectionRecord {
    let appearance: ThreadSectionAppearance | null = null
    if (row.appearance_json != null) {
      try {
        const parsed: unknown = JSON.parse(String(row.appearance_json))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const value = parsed as Record<string, unknown>
          appearance = {
            color: typeof value.color === 'string' ? value.color : null,
            icon: typeof value.icon === 'string' ? value.icon : null,
          }
        }
      } catch {}
    }
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      appearance,
    }
  }

  private rowToTurn(row: any): TurnRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      status: String(row.status) as TurnStatus,
      startedAt: row.started_at == null ? null : Number(row.started_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      items: JSON.parse(String(row.items_json)),
      diff: String(row.diff ?? ''),
      error: row.error_json == null ? null : JSON.parse(String(row.error_json)),
    }
  }
}
