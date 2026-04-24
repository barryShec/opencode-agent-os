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
    poolBudgets?: Record<string, number>
  }) {
    const lease = this.acquireLeadership({
      owner: input.owner,
      ...(input.name ? { name: input.name } : {}),
      ...(input.leaseMs ? { leaseMs: input.leaseMs } : {}),
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
    const staleProcessMs = input.staleProcessMs ?? defaultProcessStaleMs
    const reclaimed = this.reconcileProcesses({
      now,
      staleProcessMs,
    })

    const candidateProcesses = this.db
      .listProcesses()
      .filter((process) => process.status !== "stopped")
      .filter((process) => process.status !== "error")
      .filter((process) => !process.activeTaskId)
      .filter((process) => process.status === "idle")
      .filter((process) => !isProcessHeartbeatStale(process, staleProcessMs, now))
      .filter((process) => (input.processIds && input.processIds.length > 0 ? input.processIds.includes(process.id) : true))
      .sort(compareProcessPriority)

    const preferredTaskIds = new Set(input.preferredTaskIds ?? [])
    const poolBudgets = normalizePoolBudgets(input.poolBudgets)
    const availableTasks = this.tasks
      .refreshTaskGraph()
      .filter((node) => node.readiness === "ready")
      .filter((node) => isTaskEligibleForScheduling(node, poolBudgets))

    const threadLoads = buildThreadLoadMap(this.db.listTasks())
    const poolLoads = buildPoolLoadMap(this.db.listTasks())
    const assignedTaskIds = new Set<string>()
    const assignments: Array<{ process: ProcessRecord; task: TaskGraphNode }> = []

    for (const process of candidateProcesses) {
      const candidate = pickTaskForProcess({
        process,
        tasks: availableTasks,
        threadLoads,
        poolLoads,
        poolBudgets,
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
      poolLoads.set(readTaskRecordPool(assigned.task), (poolLoads.get(readTaskRecordPool(assigned.task)) ?? 0) + 1)
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

function buildPoolLoadMap(tasks: ReturnType<AgentOsDatabase["listTasks"]>) {
  const loads = new Map<string, number>()
  for (const task of tasks) {
    if (!task.assignedProcessId && task.status !== "running") continue
    const pool = readTaskRecordPool(task)
    loads.set(pool, (loads.get(pool) ?? 0) + 1)
  }
  return loads
}

function pickTaskForProcess(input: {
  process: ProcessRecord
  tasks: TaskGraphNode[]
  threadLoads: Map<string, number>
  poolLoads: Map<string, number>
  poolBudgets: Map<string, number>
  assignedTaskIds: Set<string>
  preferredTaskIds: Set<string>
}) {
  return input.tasks
    .filter((node) => !input.assignedTaskIds.has(node.task.id))
    .filter((node) => matchesProcessScope(node, input.process))
    .filter((node) => isPoolCapacityAvailable(readTaskPool(node), input.poolLoads, input.poolBudgets))
    .sort((left, right) => compareTaskScheduling(left, right, input.threadLoads, input.poolLoads, input.poolBudgets, input.preferredTaskIds))[0]
}

function matchesProcessScope(node: TaskGraphNode, process: ProcessRecord) {
  if (process.threadId && node.task.threadId !== process.threadId) return false
  if (process.sessionId && node.task.sessionId !== process.sessionId) return false
  const acceptedClasses = Array.isArray(process.metadata?.acceptedSchedulingClasses)
    ? process.metadata.acceptedSchedulingClasses.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  if (acceptedClasses.length > 0 && !acceptedClasses.includes(readSchedulingClass(node))) return false
  const acceptedPools = readAcceptedPools(process)
  if (acceptedPools.length > 0 && !acceptedPools.includes(readTaskPool(node))) return false
  return true
}

function compareTaskScheduling(
  left: TaskGraphNode,
  right: TaskGraphNode,
  threadLoads: Map<string, number>,
  poolLoads: Map<string, number>,
  poolBudgets: Map<string, number>,
  preferredTaskIds: Set<string>,
) {
  const leftPreferred = preferredTaskIds.has(left.task.id) ? 1 : 0
  const rightPreferred = preferredTaskIds.has(right.task.id) ? 1 : 0
  if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred

  const leftPoolScore = poolFairnessScore(readTaskPool(left), poolLoads, poolBudgets)
  const rightPoolScore = poolFairnessScore(readTaskPool(right), poolLoads, poolBudgets)
  if (leftPoolScore !== rightPoolScore) return leftPoolScore - rightPoolScore

  const leftLoad = threadLoads.get(left.task.threadId) ?? 0
  const rightLoad = threadLoads.get(right.task.threadId) ?? 0
  if (leftLoad !== rightLoad) return leftLoad - rightLoad

  const leftClass = schedulingClassWeight(readSchedulingClass(left))
  const rightClass = schedulingClassWeight(readSchedulingClass(right))
  if (leftClass !== rightClass) return rightClass - leftClass

  const leftPriority = priorityWeight(left.task.priority)
  const rightPriority = priorityWeight(right.task.priority)
  if (leftPriority !== rightPriority) return rightPriority - leftPriority

  const leftAge = starvationWeight(left.task.availableAt ?? left.task.createdAt)
  const rightAge = starvationWeight(right.task.availableAt ?? right.task.createdAt)
  if (leftAge !== rightAge) return rightAge - leftAge

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

function isProcessHeartbeatStale(process: ProcessRecord, staleProcessMs: number, nowIso: string) {
  return new Date(nowIso).getTime() - new Date(process.heartbeatAt).getTime() >= staleProcessMs
}

function isTaskEligibleForScheduling(node: TaskGraphNode, poolBudgets: Map<string, number>) {
  if (node.task.status === "completed" || node.task.status === "failed" || node.task.status === "cancelled") return false
  if (node.task.assignedProcessId) return false
  if (node.task.cancelRequestedAt) return false
  if (node.task.attempts >= node.task.maxAttempts) return false
  const budget = poolBudgets.get(readTaskPool(node))
  if (budget !== undefined && budget <= 0) return false
  return true
}

function priorityWeight(priority: TaskGraphNode["task"]["priority"]) {
  if (priority === "high") return 3
  if (priority === "normal") return 2
  return 1
}

function readSchedulingClass(node: TaskGraphNode) {
  const value = node.task.metadata?.schedulingClass
  if (value === "interactive" || value === "default" || value === "automation" || value === "background") {
    return value
  }
  return "default"
}

function readTaskPool(node: TaskGraphNode) {
  return readTaskRecordPool(node.task)
}

function readTaskRecordPool(task: TaskGraphNode["task"]) {
  const value = task.metadata?.processPool
  return typeof value === "string" && value.length > 0 ? value : "default"
}

function readAcceptedPools(process: ProcessRecord) {
  const acceptedPools = Array.isArray(process.metadata?.acceptedProcessPools)
    ? process.metadata.acceptedProcessPools.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  if (acceptedPools.length > 0) return acceptedPools
  const processPool = process.metadata?.processPool
  return typeof processPool === "string" && processPool.length > 0 ? [processPool] : []
}

function schedulingClassWeight(value: ReturnType<typeof readSchedulingClass>) {
  if (value === "interactive") return 4
  if (value === "default") return 3
  if (value === "automation") return 2
  return 1
}

function starvationWeight(readyAt: string) {
  const ageMinutes = Math.max(0, (Date.now() - new Date(readyAt).getTime()) / (1000 * 60))
  return Math.min(3, ageMinutes / 10)
}

function normalizePoolBudgets(poolBudgets: Record<string, number> | undefined) {
  const normalized = new Map<string, number>()
  if (!poolBudgets) return normalized

  for (const [pool, value] of Object.entries(poolBudgets)) {
    if (!pool || !Number.isInteger(value) || value < 0) continue
    normalized.set(pool, value)
  }
  return normalized
}

function isPoolCapacityAvailable(pool: string, poolLoads: Map<string, number>, poolBudgets: Map<string, number>) {
  const budget = poolBudgets.get(pool)
  if (budget === undefined) return true
  return (poolLoads.get(pool) ?? 0) < budget
}

function poolFairnessScore(pool: string, poolLoads: Map<string, number>, poolBudgets: Map<string, number>) {
  const load = poolLoads.get(pool) ?? 0
  const budget = poolBudgets.get(pool)
  if (budget === undefined) return load
  if (budget <= 0) return Number.POSITIVE_INFINITY
  return load / budget
}
