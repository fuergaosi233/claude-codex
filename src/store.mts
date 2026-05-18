import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { ThreadItem, ThreadRecord, ThreadStatus, TurnRecord, TurnStatus } from './types.mjs'
import { adapterHome, jsonClone, nowSeconds } from './util.mjs'

const require = createRequire(import.meta.url)

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
    `)
    this.ensureColumn('threads', 'reasoning_effort', 'TEXT')
    this.ensureColumn('threads', 'approval_policy', 'TEXT')
    this.ensureColumn('threads', 'sandbox_mode', 'TEXT')
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
    this.sanitizeLegacyEnumColumns()
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
    this.db
      .prepare(`
        INSERT INTO threads (
          id, session_id, forked_from_id, preview, name, archived, cwd, model, reasoning_effort,
          model_provider, claude_session_id, source, created_at, updated_at, status_json,
          approval_policy, sandbox_mode, ephemeral, thread_source, agent_role, agent_nickname,
          base_instructions, developer_instructions, personality, runtime_backend, codex_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_id=excluded.session_id,
          forked_from_id=excluded.forked_from_id,
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

  listThreads(options: {
    archived?: boolean | null
    limit?: number | null
    cursor?: string | null
    cwd?: string | string[] | null
    includeEphemeral?: boolean
  } = {}): ThreadRecord[] {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 200))
    const archived = options.archived === true ? 1 : 0
    const cursor = options.cursor ? Number(options.cursor) : Number.MAX_SAFE_INTEGER
    // Ephemeral threads (Codex App's internal title generators, subagent
    // children, memory-consolidation runs) shouldn't appear in the user's
    // session list. Callers can opt back in for diagnostic flows.
    const ephemeralFilter = options.includeEphemeral ? '' : ' AND ephemeral = 0'
    const cwdList = Array.isArray(options.cwd) ? options.cwd : options.cwd ? [options.cwd] : []
    if (cwdList.length > 0) {
      const placeholders = cwdList.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT * FROM threads WHERE archived = ? AND updated_at < ? AND cwd IN (${placeholders})${ephemeralFilter} ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(archived, cursor, ...cwdList, limit)
      return rows.map((row: unknown) => this.rowToThread(row))
    }
    const rows = this.db
      .prepare(`SELECT * FROM threads WHERE archived = ? AND updated_at < ?${ephemeralFilter} ORDER BY updated_at DESC LIMIT ?`)
      .all(archived, cursor, limit)
    return rows.map((row: unknown) => this.rowToThread(row))
  }

  updateThreadStatus(threadId: string, status: ThreadStatus): void {
    this.db
      .prepare('UPDATE threads SET status_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(status), nowSeconds(), threadId)
  }

  updateThreadName(threadId: string, name: string | null): void {
    this.db.prepare('UPDATE threads SET name = ?, updated_at = ? WHERE id = ?').run(name, nowSeconds(), threadId)
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
    this.db.prepare('UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, nowSeconds(), threadId)
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
    const rows = this.db.prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at ASC').all(threadId)
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

  updateItem(turnId: string, itemId: string, updater: (item: ThreadItem) => ThreadItem): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    turn.items = turn.items.map((item) => (item.id === itemId ? updater(jsonClone(item)) : item))
    this.upsertTurn(turn)
    return turn
  }

  completeTurn(turnId: string, status: TurnStatus, error: unknown | null = null): TurnRecord | null {
    const turn = this.getTurn(turnId)
    if (!turn) return null
    const completedAt = nowSeconds()
    turn.status = status
    turn.completedAt = completedAt
    turn.durationMs = turn.startedAt == null ? null : Math.max(0, (completedAt - turn.startedAt) * 1000)
    turn.error = error
    this.upsertTurn(turn)
    return turn
  }

  recoverStaleInProgressTurns(message = 'server restarted before completing turn'): number {
    const rows = this.db
      .prepare('SELECT id, thread_id, started_at FROM turns WHERE status = ?')
      .all('inProgress') as Array<{ id: string; thread_id: string; started_at: number | null }>
    if (rows.length === 0) return 0

    const completedAt = nowSeconds()
    const errorJson = JSON.stringify({ message })
    const updateTurn = this.db.prepare(`
      UPDATE turns
      SET status = ?, completed_at = ?, duration_ms = ?, error_json = ?
      WHERE id = ?
    `)
    const updateThread = this.db.prepare('UPDATE threads SET status_json = ?, updated_at = ? WHERE id = ?')
    const seenThreads = new Set<string>()
    for (const row of rows) {
      const startedAt = row.started_at == null ? null : Number(row.started_at)
      const durationMs = startedAt == null ? null : Math.max(0, (completedAt - startedAt) * 1000)
      updateTurn.run('interrupted', completedAt, durationMs, errorJson, row.id)
      seenThreads.add(String(row.thread_id))
    }
    for (const threadId of seenThreads) {
      updateThread.run(JSON.stringify({ type: 'idle' }), completedAt, threadId)
    }
    return rows.length
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
      ephemeral: Number(row.ephemeral ?? 0) === 1,
      threadSource: row.thread_source == null ? null : String(row.thread_source),
      agentRole: row.agent_role == null ? null : String(row.agent_role),
      agentNickname: row.agent_nickname == null ? null : String(row.agent_nickname),
      baseInstructions: row.base_instructions == null ? null : String(row.base_instructions),
      developerInstructions: row.developer_instructions == null ? null : String(row.developer_instructions),
      personality: row.personality == null ? null : String(row.personality),
      runtimeBackend: row.runtime_backend === 'codex' ? 'codex' : 'claude',
      codexSessionId: row.codex_session_id == null ? null : String(row.codex_session_id),
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
