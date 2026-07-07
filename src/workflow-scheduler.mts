import type {
  WorkflowLease,
  WorkflowState,
  WorkflowTask,
  WorkflowTaskStatus,
} from './workflow-state.mjs'

export interface WorkflowSchedulerOptions {
  readonly now: Date
  readonly workerId: string
  readonly leaseTtlMs: number
}

export type WorkflowScheduleDecision =
  | { readonly type: 'claimed'; readonly task: WorkflowTask; readonly state: WorkflowState }
  | { readonly type: 'idle'; readonly reason: 'no-runnable-task'; readonly state: WorkflowState }

export class WorkflowTransitionError extends Error {
  override readonly name = 'WorkflowTransitionError'
  readonly taskId: string
  readonly from: WorkflowTaskStatus
  readonly to: WorkflowTaskStatus

  constructor(taskId: string, from: WorkflowTaskStatus, to: WorkflowTaskStatus) {
    super(`workflow task ${taskId} cannot transition from ${from} to ${to}`)
    this.taskId = taskId
    this.from = from
    this.to = to
  }
}

export class WorkflowTaskNotFoundError extends Error {
  override readonly name = 'WorkflowTaskNotFoundError'
  readonly taskId: string

  constructor(taskId: string) {
    super(`workflow task ${taskId} does not exist`)
    this.taskId = taskId
  }
}

export function scheduleNextWorkflowTask(
  state: WorkflowState,
  options: WorkflowSchedulerOptions,
): WorkflowScheduleDecision {
  const task = runnableTasks(state.tasks, options.now)[0]
  if (!task) return { type: 'idle', reason: 'no-runnable-task', state }
  const claimed = startWorkflowTask(task, options)
  return { type: 'claimed', task: claimed, state: replaceTask(state, claimed) }
}

export function renewWorkflowLease(
  state: WorkflowState,
  taskId: string,
  options: WorkflowSchedulerOptions,
): WorkflowState {
  const task = requireTask(state, taskId)
  if (task.status !== 'running' || task.lease?.workerId !== options.workerId) return state
  return replaceTask(state, {
    ...task,
    updatedAt: options.now.toISOString(),
    lease: newLease(options),
  })
}

export function completeWorkflowTask(
  state: WorkflowState,
  taskId: string,
  at: Date,
): WorkflowState {
  return replaceTask(state, transitionTask(requireTask(state, taskId), 'done', at))
}

export function failWorkflowTask(
  state: WorkflowState,
  taskId: string,
  errorMessage: string,
  at: Date,
): WorkflowState {
  const task = requireTask(state, taskId)
  const nextStatus = task.attempts >= task.maxAttempts ? 'failed' : 'queued'
  return replaceTask(state, {
    ...transitionTask(task, nextStatus, at),
    lastError: errorMessage,
  })
}

export function blockWorkflowTask(
  state: WorkflowState,
  taskId: string,
  reason: string,
  at: Date,
): WorkflowState {
  return replaceTask(state, {
    ...transitionTask(requireTask(state, taskId), 'blocked', at),
    blockedReason: reason,
  })
}

export function enqueueWorkflowTask(state: WorkflowState, task: WorkflowTask): WorkflowState {
  if (state.tasks.some((candidate) => candidate.id === task.id)) return replaceTask(state, task)
  return { ...state, tasks: [...state.tasks, task] }
}

function startWorkflowTask(task: WorkflowTask, options: WorkflowSchedulerOptions): WorkflowTask {
  if (task.status === 'running') {
    return {
      ...task,
      updatedAt: options.now.toISOString(),
      attempts: task.attempts + 1,
      lease: newLease(options),
      blockedReason: null,
    }
  }
  return {
    ...transitionTask(task, 'running', options.now),
    attempts: task.attempts + 1,
    lease: newLease(options),
    blockedReason: null,
  }
}

function transitionTask(task: WorkflowTask, status: WorkflowTaskStatus, at: Date): WorkflowTask {
  if (!canTransition(task.status, status)) {
    throw new WorkflowTransitionError(task.id, task.status, status)
  }
  return {
    ...task,
    status,
    updatedAt: at.toISOString(),
    lease: status === 'running' ? task.lease : null,
  }
}

function canTransition(from: WorkflowTaskStatus, to: WorkflowTaskStatus): boolean {
  switch (from) {
    case 'queued':
      return to === 'running' || to === 'blocked' || to === 'done' || to === 'failed'
    case 'running':
      return to === 'queued' || to === 'blocked' || to === 'done' || to === 'failed'
    case 'blocked':
      return to === 'queued' || to === 'failed'
    case 'done':
    case 'failed':
      return false
    default:
      return assertNever(from)
  }
}

function runnableTasks(tasks: readonly WorkflowTask[], now: Date): readonly WorkflowTask[] {
  return tasks
    .filter((task) => task.status === 'queued' || hasExpiredLease(task, now))
    .filter((task) => task.attempts < task.maxAttempts)
    .toSorted(
      (left, right) =>
        right.priority - left.priority || left.updatedAt.localeCompare(right.updatedAt),
    )
}

function hasExpiredLease(task: WorkflowTask, now: Date): boolean {
  return (
    task.status === 'running' &&
    task.lease !== null &&
    Date.parse(task.lease.expiresAt) <= now.getTime()
  )
}

function newLease(options: WorkflowSchedulerOptions): WorkflowLease {
  return {
    workerId: options.workerId,
    renewedAt: options.now.toISOString(),
    expiresAt: new Date(options.now.getTime() + options.leaseTtlMs).toISOString(),
  }
}

function replaceTask(state: WorkflowState, task: WorkflowTask): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
  }
}

function requireTask(state: WorkflowState, taskId: string): WorkflowTask {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (task) return task
  throw new WorkflowTaskNotFoundError(taskId)
}

function assertNever(value: never): never {
  return value
}
