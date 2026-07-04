import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

export class WorkflowStateStore {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async read(): Promise<WorkflowState | null> {
    try {
      return parseWorkflowStateJson(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null
      throw error
    }
  }

  async write(state: WorkflowState): Promise<void> {
    await writeWorkflowStateFile(this.path, state)
  }
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
