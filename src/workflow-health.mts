import type { WorkflowState, WorkflowTaskStatus } from './workflow-state.mjs'

export interface WorkflowHealthInput {
  readonly state: WorkflowState
  readonly now: Date
  readonly runLogUpdatedAt: Date | null
}

export interface WorkflowHealthReport {
  readonly status: 'healthy' | 'stalled' | 'failed'
  readonly counts: Record<WorkflowTaskStatus, number>
  readonly runningTaskIds: readonly string[]
  readonly staleLeaseTaskIds: readonly string[]
  readonly nextLeaseExpiresAt: string | null
  readonly runRegistryLagMs: number | null
}

export function workflowHealth(input: WorkflowHealthInput): WorkflowHealthReport {
  const counts = taskCounts()
  const runningTaskIds: string[] = []
  const staleLeaseTaskIds: string[] = []
  const leaseExpiries: string[] = []

  for (const task of input.state.tasks) {
    counts[task.status] += 1
    if (task.status !== 'running') continue
    runningTaskIds.push(task.id)
    if (task.lease === null || Date.parse(task.lease.expiresAt) <= input.now.getTime()) {
      staleLeaseTaskIds.push(task.id)
    } else {
      leaseExpiries.push(task.lease.expiresAt)
    }
  }

  return {
    status: healthStatus(counts.failed, staleLeaseTaskIds.length),
    counts,
    runningTaskIds,
    staleLeaseTaskIds,
    nextLeaseExpiresAt: leaseExpiries.toSorted()[0] ?? null,
    runRegistryLagMs:
      input.runLogUpdatedAt === null
        ? null
        : Math.max(0, input.now.getTime() - input.runLogUpdatedAt.getTime()),
  }
}

function healthStatus(
  failedCount: number,
  staleLeaseCount: number,
): WorkflowHealthReport['status'] {
  if (failedCount > 0) return 'failed'
  if (staleLeaseCount > 0) return 'stalled'
  return 'healthy'
}

function taskCounts(): Record<WorkflowTaskStatus, number> {
  return {
    queued: 0,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
  }
}
