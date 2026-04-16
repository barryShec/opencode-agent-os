import { TaskService } from "@opencode-agent-os/runtime-task"
import type { ProcessRecord, SupervisorLeaseRecord, TaskGraphNode } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

const defaultSupervisorName = "main"
const defaultSupervisorLeaseMs = 15_000
const defaultAssignmentLeaseMs = 5 * 60 * 1000
const defaultProcessStaleMs = 30_000

export class RuntimeSupervisor {
  constructor(
    private readonly db: AgentOsDatabase,
    private readonly tasks: TaskService,
  ) {}

  acquireLeadership(input: {
    owner: string
    name?: string
    leaseMs?: number
    metadata?: SupervisorLeaseRecord["metadata"]
  }) {
    const expiresAt = new Date(Date.now() + (input.leaseMs ?? defaultSupervisorLeaseMs)).toISOString()
    return this.db.acquireSupervisorLease(input.name ?? defaultSupervisorName, {
      owner: input.owner,
      expiresAt,
      metadata: input.metadata ?? null,
    })
  }

  releaseLeadership(input: { owner: string; name?: string }) {
    return this.db.releaseSupervisorLease(input.name ?? defaultSupervisorName, input.owner)
  }

  scheduleOnce(input: {
    owner: string
    name?: string
    leaseMs?: number
    assignmentLeaseMs?: number
    processIds?: string[]
    preferredTaskIds?: string[]
    staleProcessMs?: number
  }) {
    const lease = this.acquireLeadership({
      owner: input.owner,
      name: input.name,
      leaseMs: input.leaseMs,
      metadata: {
        processIds: input.processIds ?? [],
      },
    })

    if (!lease) {
      return {
        lease: null,
        assignments: [] as Array<{ process: ProcessRecord; task: TaskGraphNode }>,
        reclaimed: [] as string[],
      }
    }

    const now = new Date().toISOString()
    const reclaimed = this.reconcileProcesses({
      now,
      staleProcessMs: input.staleProcessMs ?? defaultProcessStaleMs,
    })

    const candidateProcesses = this.db
      .listProcesses()
      .filter((process) => process.status !== "stopped")
      .filter((process) => process.status !== "error")
      .filter((process) => !process.activeTaskId)
      .filter((process) => process.status === "idle")
      .filter((process) => (input.processIds && input.processIds.length > 0 ? input.processIds.includes(process.id) : true))
      .sort(compareProcessPriority)

    const preferredTaskIds = new Set(input.preferredTaskIds ?? [])
    const availableTasks = this.tasks
      .refreshTaskGraph()
      .filter((node) => node.readiness === "ready")
      .filter((node) => isTaskEligibleForScheduling(node))

    const threadLoads = buildThreadLoadMap(this.db.listTasks())
    const assignedTaskIds = new Set<string>()
    const assignments: Array<{ process: ProcessRecord; task: TaskGraphNode }> = []

    for (const process of candidateProcesses) {
      const candidate = pickTaskForProcess({
        process,
        tasks: availableTasks,
        threadLoads,
        assignedTaskIds,
        preferredTaskIds,
      })
      if (!candidate) continue

      const assigned = this.tasks.assignTaskToProcess({
        taskId: candidate.task.id,
        processId: process.id,
        leaseMs: input.assignmentLeaseMs ?? defaultAssignmentLeaseMs,
        scheduledAt: now,
      })
      if (!assigned) continue

      const updatedProcess = this.db.updateProcess(process.id, {
        status: "assigned",
        activeTaskId: assigned.task.id,
        lastAssignedAt: now,
        heartbeatAt: now,
      })

      this.db.recordEvent({
        threadId: updatedProcess.threadId ?? assigned.task.threadId,
        sessionId: updatedProcess.sessionId ?? assigned.task.sessionId ?? null,
        type: "process.assigned",
        payload: {
          processId: updatedProcess.id,
          taskId: assigned.task.id,
          supervisorOwner: input.owner,
          lastAssignedAt: now,
        },
      })

      assignments.push({
        process: updatedProcess,
        task: assigned,
      })
      threadLoads.set(assigned.task.threadId, (threadLoads.get(assigned.task.threadId) ?? 0) + 1)
      assignedTaskIds.add(assigned.task.id)
    }

    return {
      lease,
      assignments,
      reclaimed,
    }
  }

  private reconcileProcesses(input: { now: string; staleProcessMs: number }) {
    const reclaimed: string[] = []

    for (const process of this.db.listProcesses()) {
      const heartbeatAgeMs = Date.now() - new Date(process.heartbeatAt).getTime()
      const task = process.activeTaskId ? this.db.getTask(process.activeTaskId) : undefined

      if (!process.activeTaskId) {
        if (process.status === "assigned" || process.status === "running") {
          this.db.updateProcess(process.id, {
            status: "idle",
            activeTaskId: null,
          })
        }
        continue
      }

      if (!task) {
        this.db.updateProcess(process.id, {
          status: "idle",
          activeTaskId: null,
        })
        reclaimed.push(process.activeTaskId)
        continue
      }

      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        this.db.updateProcess(process.id, {
          status: "idle",
          activeTaskId: null,
        })
        continue
      }

      if (task.assignedProcessId !== process.id) {
        this.db.updateProcess(process.id, {
          status: "idle",
          activeTaskId: null,
        })
        reclaimed.push(task.id)
        continue
      }

      const leaseExpired = Boolean(task.leaseExpiresAt && task.leaseExpiresAt <= input.now)
      const processStale = heartbeatAgeMs >= input.staleProcessMs
      if (!leaseExpired && !processStale) {
        continue
      }

      if (task.cancelRequestedAt && task.status !== "running") {
        this.tasks.cancelTask({
          taskId: task.id,
          reason: task.cancelReason ?? "cancelled during reconciliation",
        })
      } else {
        this.tasks.requeueTask({
          taskId: task.id,
          reason: processStale ? "executor heartbeat stale" : "assignment lease expired",
          availableAt: input.now,
        })
      }

      this.db.updateProcess(process.id, {
        status: "idle",
        activeTaskId: null,
      })
      reclaimed.push(task.id)
    }

    return reclaimed
  }
}

function buildThreadLoadMap(tasks: ReturnType<AgentOsDatabase["listTasks"]>) {
  const loads = new Map<string, number>()
  for (const task of tasks) {
    if (!task.assignedProcessId && task.status !== "running") continue
    loads.set(task.threadId, (loads.get(task.threadId) ?? 0) + 1)
  }
  return loads
}

function pickTaskForProcess(input: {
  process: ProcessRecord
  tasks: TaskGraphNode[]
  threadLoads: Map<string, number>
  assignedTaskIds: Set<string>
  preferredTaskIds: Set<string>
}) {
  return input.tasks
    .filter((node) => !input.assignedTaskIds.has(node.task.id))
    .filter((node) => matchesProcessScope(node, input.process))
    .sort((left, right) => compareTaskScheduling(left, right, input.threadLoads, input.preferredTaskIds))[0]
}

function matchesProcessScope(node: TaskGraphNode, process: ProcessRecord) {
  if (process.threadId && node.task.threadId !== process.threadId) return false
  if (process.sessionId && node.task.sessionId !== process.sessionId) return false
  return true
}

function compareTaskScheduling(
  left: TaskGraphNode,
  right: TaskGraphNode,
  threadLoads: Map<string, number>,
  preferredTaskIds: Set<string>,
) {
  const leftPreferred = preferredTaskIds.has(left.task.id) ? 1 : 0
  const rightPreferred = preferredTaskIds.has(right.task.id) ? 1 : 0
  if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred

  const leftLoad = threadLoads.get(left.task.threadId) ?? 0
  const rightLoad = threadLoads.get(right.task.threadId) ?? 0
  if (leftLoad !== rightLoad) return leftLoad - rightLoad

  const leftPriority = priorityWeight(left.task.priority)
  const rightPriority = priorityWeight(right.task.priority)
  if (leftPriority !== rightPriority) return rightPriority - leftPriority

  const leftReadyAt = left.task.availableAt ?? left.task.createdAt
  const rightReadyAt = right.task.availableAt ?? right.task.createdAt
  if (leftReadyAt !== rightReadyAt) return leftReadyAt.localeCompare(rightReadyAt)

  return left.task.createdAt.localeCompare(right.task.createdAt)
}

function compareProcessPriority(left: ProcessRecord, right: ProcessRecord) {
  const leftAssignedAt = left.lastAssignedAt ?? left.createdAt
  const rightAssignedAt = right.lastAssignedAt ?? right.createdAt
  if (leftAssignedAt !== rightAssignedAt) return leftAssignedAt.localeCompare(rightAssignedAt)
  return left.createdAt.localeCompare(right.createdAt)
}

function isTaskEligibleForScheduling(node: TaskGraphNode) {
  if (node.task.status === "completed" || node.task.status === "failed" || node.task.status === "cancelled") return false
  if (node.task.assignedProcessId) return false
  if (node.task.cancelRequestedAt) return false
  if (node.task.attempts >= node.task.maxAttempts) return false
  return true
}

function priorityWeight(priority: TaskGraphNode["task"]["priority"]) {
  if (priority === "high") return 3
  if (priority === "normal") return 2
  return 1
}
