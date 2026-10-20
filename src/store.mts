import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  ClaudeCheckpoint,
  ImportHistoryRecord,
  ProjectRecord,
  QueuedSubmission,
  ThreadAttachmentRecord,
  ThreadGoal,
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

// How long a statement waits for another connection's lock before SQLite
// gives up with "database is locked". Without a wait, anything that reads the
// file at the wrong moment (a backup, a sqlite3 shell, a status script) fails
// whichever turn happens to write then. Python's sqlite3 uses the same 5s.
const DEFAULT_BUSY_TIMEOUT_MS = 5_000

function busyTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODEX_STATE_DB_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_BUSY_TIMEOUT_MS
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_BUSY_TIMEOUT_MS
}

function openDatabase(path: string): DatabaseSync {
  const sqlite = require('node:sqlite') as {
    DatabaseSync: new (filename: string, options?: { timeout?: number }) => DatabaseSync
  }
  return new sqlite.DatabaseSync(path, { timeout: busyTimeoutMs() })
}

// The terminal form of a turn. completeTurn writes it; a caller whose write
// the store refused still needs it to tell the client the turn ended.
export function settledTurn(
  turn: TurnRecord,
  status: TurnStatus,
  error: unknown | null = null,
): TurnRecord {
  const completedAt = nowSeconds()
  return {
    ...turn,
    status,
    completedAt,
    durationMs: turn.startedAt == null ? null : Math.max(0, (completedAt - turn.startedAt) * 1000),
    error,
  }
}

const PROJECT_SELECT = `SELECT p.*, (
  SELECT MAX(t.updated_at) FROM threads t WHERE t.project_id = p.id AND t.archived = 0
) AS recency_at FROM projects p`

// A LIKE pattern matching the text anywhere, with `\` as the escape.
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`
}

function checkpointFrom(sessionId: unknown, messageUuid: unknown): ClaudeCheckpoint | null {
  return typeof sessionId === 'string' && typeof messageUuid === 'string'
    ? { sessionId, messageUuid }
    : null
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
      CREATE TABLE IF NOT EXISTS thread_goals (
        thread_id TEXT PRIMARY KEY,
        goal_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_queues (
        thread_id TEXT PRIMARY KEY,
        items_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        roots_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        position INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        attachment_type TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(thread_id, attachment_type, identity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_attachments_identity
        ON thread_attachments(attachment_type, identity_key, thread_id);
      CREATE TABLE IF NOT EXISTS import_histories (
        id TEXT PRIMARY KEY,
        provider_id TEXT,
        completed_at_ms INTEGER NOT NULL,
        successes_json TEXT NOT NULL,
        failures_json TEXT NOT NULL
      );
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
    // Claude transcript checkpoints for thread/rollback, thread/revert and
    // thread/fork: see setTurnCheckpoint and rewindClaudeSession.
    this.ensureColumn('threads', 'claude_resume_at', 'TEXT')
    this.ensureColumn('threads', 'claude_fork_session_id', 'TEXT')
    this.ensureColumn('threads', 'claude_fork_message_uuid', 'TEXT')
    this.ensureColumn('turns', 'claude_session_id', 'TEXT')
    this.ensureColumn('turns', 'claude_message_uuid', 'TEXT')
    // Project membership; written only by setThreadProject and deleteProject.
    this.ensureColumn('threads', 'project_id', 'TEXT')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id)')
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
      projectId?: string | null | undefined
      // Keeps threads whose name, preview or stored items contain the text.
      // A prefilter: a match inside item JSON may be a key, not visible text.
      searchTerm?: string | undefined
      // Leaves out threads that have no turn and no preview yet.
      excludeEmpty?: boolean
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
    // A cursor is "<sort value>:<thread id>" of the last thread a page showed.
    // Sort values are whole seconds, so the id keeps the rest of that second's
    // threads on the next page. A bare value skips them all.
    const separator = options.cursor ? options.cursor.indexOf(':') : -1
    const cursor = options.cursor
      ? Number(separator < 0 ? options.cursor : options.cursor.slice(0, separator))
      : sortDirection === 'ASC'
        ? -1
        : Number.MAX_SAFE_INTEGER
    const cursorId = options.cursor && separator >= 0 ? options.cursor.slice(separator + 1) : null
    const comparison = sortDirection === 'ASC' ? '>' : '<'
    const where = [
      't.archived = ?',
      cursorId == null
        ? `${sortExpression} ${comparison} ?`
        : `(${sortExpression} ${comparison} ? OR (${sortExpression} = ? AND t.id ${comparison} ?))`,
    ]
    const args: unknown[] =
      cursorId == null ? [archived, cursor] : [archived, cursor, cursor, cursorId]
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
    if (options.projectId !== undefined) {
      if (options.projectId === null) {
        where.push('t.project_id IS NULL')
      } else {
        where.push('t.project_id = ?')
        args.push(options.projectId)
      }
    }
    if (options.searchTerm) {
      const text = likePattern(options.searchTerm)
      const json = likePattern(JSON.stringify(options.searchTerm).slice(1, -1))
      where.push(
        `(t.name LIKE ? ESCAPE '\\' OR t.preview LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.items_json LIKE ? ESCAPE '\\'))`,
      )
      args.push(text, text, json)
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
    // Codex lists a thread once it has a preview, except in the archive, a
    // chosen section or a topology query. A turn counts too, since an image or
    // handoff turn leaves the preview empty.
    // App rule: prewarmed-threads
    if (
      options.excludeEmpty &&
      !topologyQuery &&
      archived === 0 &&
      typeof options.sectionId !== 'string'
    ) {
      where.push("(t.preview <> '' OR EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id))")
    }

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

  // Live projects in `sortKey` order. Recency puts projects without unarchived
  // threads last in either direction, as Codex does.
  listProjects(
    sortKey: 'position' | 'recencyAt',
    sortDirection: 'asc' | 'desc',
    limit: number,
    offset: number,
  ): ProjectRecord[] {
    const direction = sortDirection === 'asc' ? 'ASC' : 'DESC'
    const order =
      sortKey === 'recencyAt'
        ? `recency_at IS NULL, recency_at ${direction}, p.position ASC, p.id ASC`
        : `p.position ${direction}, p.id ${direction}`
    const rows = this.db
      .prepare(`${PROJECT_SELECT} WHERE p.deleted = 0 ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(limit, offset)
    return rows.map((row: unknown) => this.rowToProject(row))
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare(`${PROJECT_SELECT} WHERE p.id = ? AND p.deleted = 0`).get(id)
    return row ? this.rowToProject(row) : null
  }

  // One project per idempotency key: a retried create returns the project the
  // first call made (`created: false`), and the key of a deleted project stays
  // spent. New projects go last.
  createProject(
    id: string,
    idempotencyKey: string,
    fields: Pick<ProjectRecord, 'name' | 'roots' | 'metadata'>,
  ): { project: ProjectRecord; created: boolean } {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT id, deleted FROM projects WHERE idempotency_key = ?')
        .get(idempotencyKey) as { id: string; deleted: number } | undefined
      if (existing && Number(existing.deleted) === 1)
        throw new Error(`idempotency key refers to deleted project: ${existing.id}`)
      if (existing)
        return { project: this.getProject(String(existing.id)) as ProjectRecord, created: false }
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM projects WHERE deleted = 0')
        .get() as { next: number }
      const now = nowSeconds()
      this.db
        .prepare(
          `INSERT INTO projects
           (id, name, roots_json, metadata_json, position, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fields.name,
          JSON.stringify(fields.roots),
          JSON.stringify(fields.metadata),
          Number(next),
          idempotencyKey,
          now,
          now,
        )
      return { project: this.getProject(id) as ProjectRecord, created: true }
    })
  }

  // Replaces the fields given; metadata is replaced as a whole.
  updateProject(
    id: string,
    fields: Partial<Pick<ProjectRecord, 'name' | 'roots' | 'metadata'>>,
  ): ProjectRecord {
    const project = this.getProject(id)
    if (!project) throw new Error(`project not found: ${id}`)
    this.db
      .prepare(
        `UPDATE projects SET name = ?, roots_json = ?, metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.name ?? project.name,
        JSON.stringify(fields.roots ?? project.roots),
        JSON.stringify(fields.metadata ?? project.metadata),
        nowSeconds(),
        id,
      )
    return this.getProject(id) as ProjectRecord
  }

  // Leaves a tombstone so the idempotency key stays spent, and unassigns the
  // project's threads. Returns their ids.
  deleteProject(id: string): string[] {
    if (!this.getProject(id)) throw new Error(`project not found: ${id}`)
    return this.transaction(() => {
      const threadIds = (
        this.db.prepare('SELECT id FROM threads WHERE project_id = ?').all(id) as Array<{
          id: string
        }>
      ).map((row) => String(row.id))
      this.db.prepare('UPDATE threads SET project_id = NULL WHERE project_id = ?').run(id)
      this.db
        .prepare('UPDATE projects SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(nowSeconds(), id)
      this.renumberProjects(this.projectIds())
      return threadIds
    })
  }

  // Moves a project in front of `beforeProjectId`, or last when that is null.
  moveProject(id: string, beforeProjectId: string | null): void {
    if (!this.getProject(id)) throw new Error(`project not found: ${id}`)
    if (beforeProjectId != null && !this.getProject(beforeProjectId))
      throw new Error(`project not found: ${beforeProjectId}`)
    if (beforeProjectId === id) return
    const ids = this.projectIds().filter((projectId) => projectId !== id)
    const before = beforeProjectId == null ? -1 : ids.indexOf(beforeProjectId)
    ids.splice(before >= 0 ? before : ids.length, 0, id)
    this.transaction(() => this.renumberProjects(ids))
  }

  // Returns whether the thread's project changed.
  setThreadProject(threadId: string, projectId: string | null): boolean {
    const result = this.db
      .prepare('UPDATE threads SET project_id = ? WHERE id = ? AND project_id IS NOT ?')
      .run(projectId, threadId, projectId)
    return Number(result.changes) > 0
  }

  private projectIds(): string[] {
    return (
      this.db
        .prepare('SELECT id FROM projects WHERE deleted = 0 ORDER BY position, id')
        .all() as Array<{ id: string }>
    ).map((row) => String(row.id))
  }

  private renumberProjects(projectIds: string[]): void {
    const update = this.db.prepare('UPDATE projects SET position = ? WHERE id = ?')
    for (const [position, projectId] of projectIds.entries()) update.run(position, projectId)
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {}
      throw error
    }
  }

  // Adds the attachment unless the thread already has one with its type and
  // key, which is returned unchanged instead.
  addThreadAttachment(
    threadId: string,
    attachment: Omit<ThreadAttachmentRecord, 'createdAt'>,
  ): { attachment: ThreadAttachmentRecord; created: boolean } {
    return this.transaction(() => {
      const existing = this.threadAttachment(
        threadId,
        attachment.attachmentType,
        attachment.identityKey,
      )
      if (existing) return { attachment: existing, created: false }
      this.db
        .prepare(
          `INSERT INTO thread_attachments
             (id, thread_id, attachment_type, identity_key, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attachment.id,
          threadId,
          attachment.attachmentType,
          attachment.identityKey,
          JSON.stringify(attachment.payload ?? null),
          nowSeconds(),
        )
      const created = this.threadAttachment(
        threadId,
        attachment.attachmentType,
        attachment.identityKey,
      )
      if (!created) throw new Error(`thread attachment was not saved: ${attachment.id}`)
      return { attachment: created, created: true }
    })
  }

  // Oldest first.
  listThreadAttachments(threadId: string, limit: number, offset: number): ThreadAttachmentRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM thread_attachments WHERE thread_id = ?
           ORDER BY created_at, rowid LIMIT ? OFFSET ?`,
        )
        .all(threadId, limit, offset) as unknown[]
    ).map((row) => this.rowToAttachment(row))
  }

  // The threads holding an attachment with this type and key, by thread id;
  // archived null lists archived and live threads alike.
  listAttachmentOwners(
    owner: { attachmentType: string; identityKey: string; archived: boolean | null },
    limit: number,
    offset: number,
  ): { threadId: string; archived: boolean }[] {
    const archived = owner.archived == null ? '' : 'AND t.archived = ?'
    const params = owner.archived == null ? [] : [owner.archived ? 1 : 0]
    const rows = this.db
      .prepare(
        `SELECT a.thread_id AS thread_id, t.archived AS archived
         FROM thread_attachments a JOIN threads t ON t.id = a.thread_id
         WHERE a.attachment_type = ? AND a.identity_key = ? ${archived}
         ORDER BY a.thread_id LIMIT ? OFFSET ?`,
      )
      .all(owner.attachmentType, owner.identityKey, ...params, limit, offset) as Array<{
      thread_id: string
      archived: unknown
    }>
    return rows.map((row) => ({ threadId: row.thread_id, archived: Number(row.archived) === 1 }))
  }

  // Returns the removed attachment, or null when there was none.
  removeThreadAttachment(
    threadId: string,
    attachmentType: string,
    identityKey: string,
  ): ThreadAttachmentRecord | null {
    const existing = this.threadAttachment(threadId, attachmentType, identityKey)
    if (existing) this.db.prepare('DELETE FROM thread_attachments WHERE id = ?').run(existing.id)
    return existing
  }

  private threadAttachment(
    threadId: string,
    attachmentType: string,
    identityKey: string,
  ): ThreadAttachmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM thread_attachments
         WHERE thread_id = ? AND attachment_type = ? AND identity_key = ?`,
      )
      .get(threadId, attachmentType, identityKey)
    return row ? this.rowToAttachment(row) : null
  }

  addImportHistory(history: ImportHistoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO import_histories
           (id, provider_id, completed_at_ms, successes_json, failures_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        history.importId,
        history.providerId,
        history.completedAtMs,
        JSON.stringify(history.successes),
        JSON.stringify(history.failures),
      )
  }

  // Newest first.
  listImportHistories(): ImportHistoryRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM import_histories ORDER BY completed_at_ms DESC, rowid DESC')
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      importId: String(row.id),
      providerId: row.provider_id == null ? null : String(row.provider_id),
      completedAtMs: Number(row.completed_at_ms),
      successes: JSON.parse(String(row.successes_json)) as unknown[],
      failures: JSON.parse(String(row.failures_json)) as unknown[],
    }))
  }

  // The local days (YYYY-MM-DD, oldest first) on which any turn started, and
  // the longest a turn ran.
  turnActivity(): { days: string[]; longestTurnMs: number | null } {
    const days = this.db
      .prepare(
        `SELECT DISTINCT date(started_at, 'unixepoch', 'localtime') AS day FROM turns
         WHERE started_at IS NOT NULL ORDER BY day`,
      )
      .all() as Array<{ day: unknown }>
    const longest = this.db.prepare('SELECT MAX(duration_ms) AS longest FROM turns').get() as
      | { longest?: unknown }
      | undefined
    return {
      days: days.map((row) => String(row.day)),
      longestTurnMs: longest?.longest == null ? null : Number(longest.longest),
    }
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

  // Status of the thread's newest turn, without decoding any turn's items.
  lastTurnStatus(threadId: string): TurnRecord['status'] | null {
    const row = this.db
      .prepare(
        'SELECT status FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      )
      .get(threadId) as { status?: unknown } | undefined
    return typeof row?.status === 'string' ? (row.status as TurnRecord['status']) : null
  }

  lastTurn(threadId: string): TurnRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
      )
      .get(threadId)
    return row ? this.rowToTurn(row) : null
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

  // thread/revert: drops `turnId` and every later turn. Returns the number of
  // turns removed (0 when the turn is not part of the thread).
  deleteTurnsFrom(threadId: string, turnId: string): number {
    const ids = (
      this.db
        .prepare('SELECT id FROM turns WHERE thread_id = ? ORDER BY started_at ASC, rowid ASC')
        .all(threadId) as Array<{ id: string }>
    ).map((row) => row.id)
    const start = ids.indexOf(turnId)
    if (start < 0) return 0
    const stmt = this.db.prepare('DELETE FROM turns WHERE id = ?')
    for (const id of ids.slice(start)) stmt.run(id)
    return ids.length - start
  }

  // The newest transcript entry Claude wrote for a turn. Resuming its session
  // at that entry restores the context the thread had when the turn ended.
  setTurnCheckpoint(turnId: string, checkpoint: ClaudeCheckpoint): void {
    this.db
      .prepare('UPDATE turns SET claude_session_id = ?, claude_message_uuid = ? WHERE id = ?')
      .run(checkpoint.sessionId, checkpoint.messageUuid, turnId)
  }

  turnCheckpoint(turnId: string): ClaudeCheckpoint | null {
    const row = this.db
      .prepare('SELECT claude_session_id, claude_message_uuid FROM turns WHERE id = ?')
      .get(turnId) as { claude_session_id?: unknown; claude_message_uuid?: unknown } | undefined
    return checkpointFrom(row?.claude_session_id, row?.claude_message_uuid)
  }

  // Where a forked thread branched off its parent's Claude session; a rewind
  // past the thread's own first turn returns there.
  setForkCheckpoint(threadId: string, checkpoint: ClaudeCheckpoint | null): void {
    this.db
      .prepare(
        'UPDATE threads SET claude_fork_session_id = ?, claude_fork_message_uuid = ? WHERE id = ?',
      )
      .run(checkpoint?.sessionId ?? null, checkpoint?.messageUuid ?? null, threadId)
  }

  forkCheckpoint(threadId: string): ClaudeCheckpoint | null {
    const row = this.db
      .prepare('SELECT claude_fork_session_id, claude_fork_message_uuid FROM threads WHERE id = ?')
      .get(threadId) as
      | { claude_fork_session_id?: unknown; claude_fork_message_uuid?: unknown }
      | undefined
    return checkpointFrom(row?.claude_fork_session_id, row?.claude_fork_message_uuid)
  }

  // Points the thread's next Claude turn at `sessionId`, resumed only up to
  // the `resumeAt` entry (in a forked session) when given. A null session
  // starts a new one.
  rewindClaudeSession(threadId: string, sessionId: string | null, resumeAt: string | null): void {
    this.db
      .prepare(
        'UPDATE threads SET claude_session_id = ?, claude_resume_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(sessionId, sessionId ? resumeAt : null, nowSeconds(), threadId)
  }

  // The pending rewind target within claude_session_id, if any.
  claudeResumeAt(threadId: string): string | null {
    const row = this.db
      .prepare('SELECT claude_resume_at FROM threads WHERE id = ?')
      .get(threadId) as { claude_resume_at?: unknown } | undefined
    return typeof row?.claude_resume_at === 'string' ? row.claude_resume_at : null
  }

  clearClaudeResumeAt(threadId: string): void {
    this.db.prepare('UPDATE threads SET claude_resume_at = NULL WHERE id = ?').run(threadId)
  }

  // thread/delete: the thread, the subagent threads it spawned (recursively)
  // and everything stored for them. Returns the deleted thread ids.
  deleteThread(threadId: string): string[] {
    const ids = (
      this.db
        .prepare(
          `WITH RECURSIVE doomed(id) AS (
             SELECT id FROM threads WHERE id = ?
             UNION
             SELECT child.id FROM threads child JOIN doomed parent ON child.forked_from_id = parent.id
             WHERE child.thread_source = 'subagent'
           )
           SELECT id FROM doomed`,
        )
        .all(threadId) as Array<{ id: string }>
    ).map((row) => row.id)
    for (const id of ids) {
      this.db.prepare('DELETE FROM turns WHERE thread_id = ?').run(id)
      this.db.prepare('DELETE FROM thread_goals WHERE thread_id = ?').run(id)
      this.db.prepare('DELETE FROM thread_queues WHERE thread_id = ?').run(id)
      this.db.prepare('DELETE FROM thread_attachments WHERE thread_id = ?').run(id)
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
    }
    return ids
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
    const completed = settledTurn(turn, status, error)
    this.upsertTurn(completed)
    return completed
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
    // Agents whose own turn the restart cut off, or that never got one. Any
    // marker that still shows one of them working, here or in an earlier
    // parent turn, is stale.
    const cutOff = new Set(rows.map((row) => String(row.thread_id)))
    const hasTurn = this.db.prepare('SELECT 1 FROM turns WHERE thread_id = ? LIMIT 1')
    const isDead = (threadId: string) => cutOff.has(threadId) || hasTurn.get(threadId) === undefined
    for (const row of rows) {
      const startedAt = row.started_at == null ? null : Number(row.started_at)
      const durationMs = startedAt == null ? null : Math.max(0, (completedAt - startedAt) * 1000)
      updateTurn.run(
        'interrupted',
        completedAt,
        durationMs,
        errorJson,
        this.terminalizeStaleItems(row.items_json, message, isDead),
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
      // A background agent outlives the parent turn that spawned it, so its
      // markers can sit in a turn that ended long before the restart.
      const itemsJson = this.terminalizeStaleItems(row.items_json, message, isDead)
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

  // A recovered turn is also replayed from its persisted item list. Clear the
  // item-level liveness markers of agents the restart killed so the App's
  // spinner projection cannot keep them `working`. Markers of agents that
  // finished stay as they were streamed, so a reload matches the live view.
  private terminalizeStaleItems(
    itemsJson: string,
    message: string,
    isDead: (threadId: string) => boolean,
  ): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(itemsJson)
    } catch {
      return '[]'
    }
    if (!Array.isArray(parsed)) return '[]'

    const items = parsed.map((raw) => {
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return raw
      const item = raw as Record<string, unknown>
      if (
        item.type === 'subAgentActivity' &&
        (item.kind === 'started' || item.kind === 'interacted') &&
        isDead(String(item.agentThreadId))
      ) {
        return { ...item, kind: 'interrupted' }
      }
      if (item.type === 'collabAgentToolCall') {
        const agentsStates = item.agentsStates
        const nextStates =
          agentsStates && typeof agentsStates === 'object' && !Array.isArray(agentsStates)
            ? Object.fromEntries(
                Object.entries(agentsStates as Record<string, unknown>).map(
                  ([threadId, rawState]) => {
                    if (rawState == null || typeof rawState !== 'object' || Array.isArray(rawState))
                      return [threadId, rawState]
                    const state = rawState as Record<string, unknown>
                    if (
                      (state.status !== 'pendingInit' && state.status !== 'running') ||
                      !isDead(threadId)
                    )
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
    return JSON.stringify(items)
  }

  updateTurnDiff(turnId: string, diff: string): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    turn.diff = diff
    this.upsertTurn(turn)
    return turn
  }

  getGoal(threadId: string): ThreadGoal | null {
    const row = this.db
      .prepare('SELECT goal_json FROM thread_goals WHERE thread_id = ?')
      .get(threadId) as { goal_json: string } | undefined
    return row ? (JSON.parse(row.goal_json) as ThreadGoal) : null
  }

  putGoal(goal: ThreadGoal): void {
    this.db
      .prepare(
        `INSERT INTO thread_goals (thread_id, goal_json) VALUES (?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET goal_json = excluded.goal_json`,
      )
      .run(goal.threadId, JSON.stringify(goal))
  }

  deleteGoal(threadId: string): boolean {
    const result = this.db.prepare('DELETE FROM thread_goals WHERE thread_id = ?').run(threadId)
    return Number(result.changes) > 0
  }

  listQueue(threadId: string): QueuedSubmission[] {
    const row = this.db
      .prepare('SELECT items_json FROM thread_queues WHERE thread_id = ?')
      .get(threadId) as { items_json: string } | undefined
    return row ? (JSON.parse(row.items_json) as QueuedSubmission[]) : []
  }

  saveQueue(threadId: string, items: QueuedSubmission[]): void {
    if (items.length === 0) {
      this.db.prepare('DELETE FROM thread_queues WHERE thread_id = ?').run(threadId)
      return
    }
    this.db
      .prepare(
        `INSERT INTO thread_queues (thread_id, items_json) VALUES (?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET items_json = excluded.items_json`,
      )
      .run(threadId, JSON.stringify(items))
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
      projectId: row.project_id == null ? null : String(row.project_id),
    }
  }

  private rowToProject(row: any): ProjectRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      roots: JSON.parse(String(row.roots_json)),
      metadata: JSON.parse(String(row.metadata_json)),
      position: Number(row.position),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      recencyAt: row.recency_at == null ? null : Number(row.recency_at),
    }
  }

  private rowToAttachment(row: any): ThreadAttachmentRecord {
    return {
      id: String(row.id),
      attachmentType: String(row.attachment_type),
      identityKey: String(row.identity_key),
      payload: JSON.parse(String(row.payload_json)),
      createdAt: Number(row.created_at),
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
