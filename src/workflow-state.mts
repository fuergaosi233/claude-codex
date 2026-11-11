import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const WORKFLOW_STATE_VERSION = 1
export const WORKFLOW_TASK_STATUSES = ['queued', 'running', 'blocked', 'done', 'failed'] as const

export type WorkflowStateVersion = typeof WORKFLOW_STATE_VERSION
export type WorkflowTaskStatus = (typeof WORKFLOW_TASK_STATUSES)[number]

export interface WorkflowLease {
  readonly workerId: string
  readonly expiresAt: string
  readonly renewedAt: string
}

export interface WorkflowTask {
  readonly id: string
  readonly status: WorkflowTaskStatus
  readonly updatedAt: string
  readonly prompt: string
  readonly priority: number
  readonly attempts: number
  readonly maxAttempts: number
  readonly lease: WorkflowLease | null
  readonly blockedReason: string | null
  readonly lastError: string | null
}

export interface WorkflowState {
  readonly version: WorkflowStateVersion
  readonly tasks: readonly WorkflowTask[]
}

export class WorkflowStateParseError extends Error {
  override readonly name = 'WorkflowStateParseError'
  readonly path: readonly string[]

  constructor(path: readonly string[], reason: string) {
    super(`invalid workflow state at ${formatPath(path)}: ${reason}`)
    this.path = path
  }
}

export class WorkflowStateSerializeError extends Error {
  override readonly name = 'WorkflowStateSerializeError'

  constructor() {
    super('workflow state could not be serialized')
  }
}

export interface WorkflowStateLockRecord {
  readonly pid: number
  readonly hostname: string
  readonly acquiredAt: string
  readonly token: string
}

export interface WorkflowStateStoreOptions {
  readonly lockTimeoutMs?: number
  readonly lockStaleMs?: number
}

export class WorkflowStateLockTimeoutError extends Error {
  override readonly name = 'WorkflowStateLockTimeoutError'

  constructor(path: string, timeoutMs: number, holder: WorkflowStateLockRecord | null) {
    super(
      `workflow state lock acquisition timed out after ${timeoutMs}ms for ${path}; ` +
        `holder pid ${holder?.pid ?? 'unknown'} on ${holder?.hostname ?? 'unknown host'} ` +
        `since ${holder?.acquiredAt ?? 'unknown time'}`,
    )
  }
}

export class WorkflowStateStore {
  readonly path: string
  private readonly lockTimeoutMs: number
  private readonly lockStaleMs: number

  constructor(path: string, options: WorkflowStateStoreOptions = {}) {
    this.path = path
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000
    this.lockStaleMs = options.lockStaleMs ?? 5 * 60 * 1000
  }

  async read(): Promise<WorkflowState | null> {
    try {
      return parseWorkflowStateJson(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null
      throw error
    }
  }

  async transact<T>(
    fallback: WorkflowState,
    transition: (state: WorkflowState) => { state: WorkflowState; value: T },
  ): Promise<T> {
    const release = await acquireWorkflowStateLock(this.path, {
      timeoutMs: this.lockTimeoutMs,
      staleMs: this.lockStaleMs,
    })
    try {
      const current = (await this.read()) ?? fallback
      const next = transition(current)
      await this.write(next.state)
      return next.value
    } finally {
      await release()
    }
  }

  async write(state: WorkflowState): Promise<void> {
    await writeWorkflowStateFile(this.path, state)
  }
}

interface WorkflowStateLockSnapshot {
  readonly record: WorkflowStateLockRecord | null
  readonly mtimeMs: number
}

const localHostname = hostname()
const lockRetryMs = 10

async function acquireWorkflowStateLock(
  path: string,
  options: { readonly timeoutMs: number; readonly staleMs: number },
): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  const startedAt = Date.now()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  while (true) {
    const acquired = await tryCreateWorkflowStateLock(lockPath)
    if (acquired) {
      return () => releaseWorkflowStateLock(lockPath, acquired.token)
    }

    const holder = await readWorkflowStateLock(lockPath)
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= options.timeoutMs) {
      throw new WorkflowStateLockTimeoutError(lockPath, options.timeoutMs, holder?.record ?? null)
    }
    if (!holder) {
      await delay(Math.min(lockRetryMs, options.timeoutMs - elapsedMs))
      continue
    }

    if (isWorkflowStateLockStale(holder, options.staleMs)) {
      await quarantineStaleWorkflowStateLock(lockPath, holder)
      // Let concurrent stale-lock observations finish their quarantine attempts before
      // racing to install the next generation.
      await delay(lockRetryMs)
      continue
    }
    await delay(Math.min(lockRetryMs, options.timeoutMs - elapsedMs))
  }
}

async function tryCreateWorkflowStateLock(
  lockPath: string,
): Promise<WorkflowStateLockRecord | null> {
  const record: WorkflowStateLockRecord = {
    pid: process.pid,
    hostname: localHostname,
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  }
  const tempPath = `${lockPath}.${process.pid}.${record.token}.tmp`
  try {
    const handle = await open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Hard-linking a complete record avoids exposing a partially written lock while
    // retaining exclusive-create semantics across processes.
    await link(tempPath, lockPath)
    return record
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) return null
    throw error
  } finally {
    await rm(tempPath, { force: true })
  }
}

async function readWorkflowStateLock(lockPath: string): Promise<WorkflowStateLockSnapshot | null> {
  try {
    const info = await stat(lockPath)
    const text = await readFile(lockPath, 'utf8')
    return { record: parseWorkflowStateLockRecord(text), mtimeMs: info.mtimeMs }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function parseWorkflowStateLockRecord(text: string): WorkflowStateLockRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isRecord(value) ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.hostname !== 'string' ||
    typeof value.acquiredAt !== 'string' ||
    typeof value.token !== 'string'
  ) {
    return null
  }
  return {
    pid: value.pid,
    hostname: value.hostname,
    acquiredAt: value.acquiredAt,
    token: value.token,
  }
}

function isWorkflowStateLockStale(snapshot: WorkflowStateLockSnapshot, staleMs: number): boolean {
  const record = snapshot.record
  if (record?.hostname === localHostname) {
    try {
      process.kill(record.pid, 0)
    } catch (error) {
      if (hasErrorCode(error, 'ESRCH')) return true
    }
  }
  const acquiredAtMs = record ? Date.parse(record.acquiredAt) : snapshot.mtimeMs
  return Number.isFinite(acquiredAtMs) && Date.now() - acquiredAtMs >= staleMs
}

async function quarantineStaleWorkflowStateLock(
  lockPath: string,
  expected: WorkflowStateLockSnapshot,
): Promise<void> {
  // Recheck before renaming so a waiter acting on an old observation does not
  // normally move a live next-generation lock.
  const current = await readWorkflowStateLock(lockPath)
  if (!current || !sameWorkflowStateLock(current, expected)) return

  const quarantinePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`
  try {
    await rename(lockPath, quarantinePath)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }

  const quarantined = await readWorkflowStateLock(quarantinePath)
  if (quarantined && sameWorkflowStateLock(quarantined, expected)) {
    await rm(quarantinePath, { force: true })
    return
  }

  // Another waiter installed a new generation between our check and rename.
  // Put that generation back without overwriting any lock created since.
  if (quarantined) await restoreQuarantinedWorkflowStateLock(quarantinePath, lockPath)
}

function sameWorkflowStateLock(
  left: WorkflowStateLockSnapshot,
  right: WorkflowStateLockSnapshot,
): boolean {
  if (left.record || right.record) return left.record?.token === right.record?.token
  return left.mtimeMs === right.mtimeMs
}

async function restoreQuarantinedWorkflowStateLock(
  quarantinePath: string,
  lockPath: string,
): Promise<void> {
  try {
    await link(quarantinePath, lockPath)
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST') && !hasErrorCode(error, 'ENOENT')) throw error
  } finally {
    await rm(quarantinePath, { force: true })
  }
}

async function releaseWorkflowStateLock(lockPath: string, token: string): Promise<void> {
  const current = await readWorkflowStateLock(lockPath)
  if (current?.record?.token !== token) return

  const releasePath = `${lockPath}.${process.pid}.${randomUUID()}.release`
  try {
    await rename(lockPath, releasePath)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw error
  }

  const released = await readWorkflowStateLock(releasePath)
  if (released?.record?.token === token) {
    await rm(releasePath, { force: true })
    return
  }
  // A conservative stale takeover may have replaced our generation while a
  // long transition was still finishing. Never delete its lock.
  if (released) await restoreQuarantinedWorkflowStateLock(releasePath, lockPath)
}

export function parseWorkflowStateJson(text: string): WorkflowState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WorkflowStateParseError([], `invalid JSON: ${error.message}`)
    }
    throw error
  }
  return parseWorkflowState(value, [])
}

export async function writeWorkflowStateFile(path: string, state: WorkflowState): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(formatWorkflowStateJson(state), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

function parseWorkflowState(value: unknown, path: readonly string[]): WorkflowState {
  const record = requireRecord(value, path)
  if (record.version !== WORKFLOW_STATE_VERSION) {
    throw new WorkflowStateParseError(pathFor(path, 'version'), 'version must be 1')
  }
  const tasks = requireArray(record, 'tasks', path)
  return {
    version: WORKFLOW_STATE_VERSION,
    tasks: tasks.map((task, index) =>
      parseWorkflowTask(task, pathFor(pathFor(path, 'tasks'), index)),
    ),
  }
}

function parseWorkflowTask(value: unknown, path: readonly string[]): WorkflowTask {
  const record = requireRecord(value, path)
  return {
    id: requireNonEmptyString(record, 'id', path),
    status: requireWorkflowTaskStatus(record, path),
    updatedAt: requireIsoString(record, 'updatedAt', path),
    prompt: requireNonEmptyString(record, 'prompt', path),
    priority: requireInteger(record, 'priority', path),
    attempts: requireInteger(record, 'attempts', path),
    maxAttempts: requirePositiveInteger(record, 'maxAttempts', path),
    lease: parseNullableLease(record.lease, pathFor(path, 'lease')),
    blockedReason: requireNullableString(record, 'blockedReason', path),
    lastError: requireNullableString(record, 'lastError', path),
  }
}

function parseNullableLease(value: unknown, path: readonly string[]): WorkflowLease | null {
  if (value === null) return null
  const record = requireRecord(value, path)
  return {
    workerId: requireNonEmptyString(record, 'workerId', path),
    expiresAt: requireIsoString(record, 'expiresAt', path),
    renewedAt: requireIsoString(record, 'renewedAt', path),
  }
}

function formatWorkflowStateJson(state: WorkflowState): string {
  const text = JSON.stringify(state, null, 2)
  if (text === undefined) throw new WorkflowStateSerializeError()
  return `${text}\n`
}

function requireRecord(value: unknown, path: readonly string[]): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new WorkflowStateParseError(path, 'expected an object')
}

function requireArray(
  record: Record<string, unknown>,
  field: string,
  path: readonly string[],
): readonly unknown[] {
  const value = record[field]
  if (Array.isArray(value)) return value
  throw new WorkflowStateParseError(pathFor(path, field), 'expected an array')
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  path: readonly string[],
): string {
  const value = record[field]
  if (typeof value === 'string' && value.trim() !== '') return value
  throw new WorkflowStateParseError(pathFor(path, field), 'expected a non-empty string')
}

function requireNullableString(
  record: Record<string, unknown>,
  field: string,
  path: readonly string[],
): string | null {
  const value = record[field]
  if (value === null || typeof value === 'string') return value
  throw new WorkflowStateParseError(pathFor(path, field), 'expected a string or null')
}

function requireIsoString(
  record: Record<string, unknown>,
  field: string,
  path: readonly string[],
): string {
  const value = requireNonEmptyString(record, field, path)
  if (!Number.isNaN(Date.parse(value))) return value
  throw new WorkflowStateParseError(pathFor(path, field), 'expected an ISO timestamp')
}

function requireInteger(
  record: Record<string, unknown>,
  field: string,
  path: readonly string[],
): number {
  const value = record[field]
  if (typeof value === 'number' && Number.isInteger(value)) return value
  throw new WorkflowStateParseError(pathFor(path, field), 'expected an integer')
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  field: string,
  path: readonly string[],
): number {
  const value = requireInteger(record, field, path)
  if (value > 0) return value
  throw new WorkflowStateParseError(pathFor(path, field), 'expected a positive integer')
}

function requireWorkflowTaskStatus(
  record: Record<string, unknown>,
  path: readonly string[],
): WorkflowTaskStatus {
  const value = record.status
  if (isWorkflowTaskStatus(value)) return value
  throw new WorkflowStateParseError(
    pathFor(path, 'status'),
    `status must be one of ${WORKFLOW_TASK_STATUSES.join(', ')}`,
  )
}

function hasErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWorkflowTaskStatus(value: unknown): value is WorkflowTaskStatus {
  return typeof value === 'string' && workflowTaskStatusSet.has(value)
}

function pathFor(path: readonly string[], segment: string | number): readonly string[] {
  return [...path, String(segment)]
}

function formatPath(path: readonly string[]): string {
  if (path.length === 0) return '$'
  return `$.${path.join('.')}`
}

const workflowTaskStatusSet: ReadonlySet<string> = new Set(WORKFLOW_TASK_STATUSES)
