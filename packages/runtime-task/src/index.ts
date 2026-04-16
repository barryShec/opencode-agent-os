import { EvaluatorService, EvaluatorRegistry, createDefaultEvaluatorRegistry } from "@opencode-agent-os/evaluators"
import type { RunLifecycleHooks } from "@opencode-agent-os/runtime-runner"
import type { EvaluatorResultRecord, TaskGraphNode, TaskRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

const defaultLeaseMs = 5 * 60 * 1000

export class TaskService {
  constructor(private readonly db: AgentOsDatabase) {}

  createTask(input: {
    threadId: string
    sessionId?: string | null
    parentTaskId?: string | null
    title: string
    description?: string | null
    priority?: TaskRecord["priority"]
    availableAt?: string | null
    owner?: string | null
    metadata?: TaskRecord["metadata"]
    dependsOn?: string[]
    maxAttempts?: number
    evaluatorGate?: TaskRecord["evaluatorGate"]
  }) {
    const task = this.db.createTask({
      threadId: input.threadId,
      sessionId: input.sessionId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: "pending",
      priority: input.priority ?? "normal",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      availableAt: input.availableAt ?? new Date().toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      assignedProcessId: null,
      scheduledAt: null,
      lastRunId: null,
      evaluatorGate: input.evaluatorGate ?? "required",
      repairCount: 0,
      owner: input.owner ?? null,
      cancelRequestedAt: null,
      cancelReason: null,
      deadLetteredAt: null,
      metadata: input.metadata ?? null,
    })

    for (const dependency of input.dependsOn ?? []) {
      this.db.addTaskDependency(task.id, dependency)
    }

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      type: "task.created",
      payload: {
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        maxAttempts: task.maxAttempts,
        evaluatorGate: task.evaluatorGate,
        availableAt: task.availableAt,
        dependsOn: input.dependsOn ?? [],
      },
    })

    return {
      task,
      dependencies: this.db.listTaskDependencies(task.id),
    }
  }

  listTasks(input: { threadId?: string; sessionId?: string; status?: TaskRecord["status"] } = {}) {
    return this.db.listTasks(input).map((task) => this.toGraphNode(task))
  }

  getTask(taskId: string) {
    const task = this.db.getTask(taskId)
    if (!task) return undefined
    return this.toGraphNode(task)
  }

  listReadyTasks(input: { threadId?: string; sessionId?: string } = {}) {
    return this.db
      .listTasks(input)
      .map((task) => this.toGraphNode(task))
      .filter((node) => node.readiness === "ready")
      .filter((node) => isTaskDispatchable(node.task))
  }

  listBlockedTasks(input: { threadId?: string; sessionId?: string } = {}) {
    return this.db
      .listTasks(input)
      .map((task) => this.toGraphNode(task))
      .filter((node) => node.readiness === "blocked" || node.readiness === "waiting")
  }

  claimReadyTask(input: { threadId?: string; sessionId?: string; owner: string; leaseMs?: number }) {
    const expiresAt = new Date(Date.now() + (input.leaseMs ?? defaultLeaseMs)).toISOString()
    const candidates = this.refreshTaskGraph(input)
      .filter((node) => node.readiness === "ready")
      .filter((node) => node.task.status !== "running")
      .filter((node) => isTaskDispatchable(node.task))
      .sort(compareClaimPriority)

    for (const candidate of candidates) {
      const claimed = this.db.claimTaskLease(candidate.task.id, {
        owner: input.owner,
        expiresAt,
      })
      if (!claimed) continue

      this.db.recordEvent({
        threadId: claimed.threadId,
        sessionId: claimed.sessionId ?? null,
        runId: claimed.lastRunId ?? null,
        type: "task.claimed",
        payload: {
          taskId: claimed.id,
          owner: input.owner,
          leaseExpiresAt: expiresAt,
        },
      })

      return this.toGraphNode(claimed)
    }

    return undefined
  }

  assignTaskToProcess(input: { taskId: string; processId: string; leaseMs?: number; scheduledAt?: string }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }
    if (!isTaskDispatchable(current)) {
      return undefined
    }

    const claimed = this.db.claimTaskLease(input.taskId, {
      owner: input.processId,
      expiresAt: new Date(Date.now() + (input.leaseMs ?? defaultLeaseMs)).toISOString(),
    })
    if (!claimed) {
      return undefined
    }

    const task = this.db.updateTask(input.taskId, {
      assignedProcessId: input.processId,
      scheduledAt: input.scheduledAt ?? new Date().toISOString(),
      availableAt: null,
      leaseOwner: claimed.leaseOwner ?? input.processId,
      leaseExpiresAt: claimed.leaseExpiresAt ?? new Date(Date.now() + (input.leaseMs ?? defaultLeaseMs)).toISOString(),
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: task.lastRunId ?? null,
      type: "task.assigned",
      payload: {
        taskId: task.id,
        processId: input.processId,
        scheduledAt: task.scheduledAt,
        leaseExpiresAt: task.leaseExpiresAt,
      },
    })

    return this.toGraphNode(task)
  }

  requeueTask(input: {
    taskId: string
    reason?: string | null
    availableAt?: string | null
    clearCancellation?: boolean
    incrementRepairCount?: boolean
  }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }

    const task = this.db.updateTask(input.taskId, {
      status: "pending",
      errorText: input.reason ?? current.errorText,
      resultText: null,
      availableAt: input.availableAt ?? new Date().toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      assignedProcessId: null,
      scheduledAt: null,
      repairCount: input.incrementRepairCount ? current.repairCount + 1 : current.repairCount,
      cancelRequestedAt: input.clearCancellation ? null : current.cancelRequestedAt,
      cancelReason: input.clearCancellation ? null : current.cancelReason,
      completedAt: null,
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: task.lastRunId ?? null,
      type: "task.requeued",
      payload: {
        taskId: task.id,
        availableAt: task.availableAt,
        reason: task.errorText,
      },
    })

    return this.toGraphNode(task)
  }

  requestTaskCancellation(input: { taskId: string; reason?: string | null }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
      return this.toGraphNode(current)
    }

    if (current.status !== "running") {
      return this.cancelTask({
        taskId: input.taskId,
        reason: input.reason ?? "cancelled before execution",
      })
    }

    const now = new Date().toISOString()
    const task = this.db.updateTask(input.taskId, {
      cancelRequestedAt: current.cancelRequestedAt ?? now,
      cancelReason: input.reason ?? current.cancelReason ?? "cancellation requested",
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: task.lastRunId ?? null,
      type: "task.cancellation.requested",
      payload: {
        taskId: task.id,
        reason: task.cancelReason,
        cancelRequestedAt: task.cancelRequestedAt,
      },
    })

    return this.toGraphNode(task)
  }

  cancelTask(input: { taskId: string; reason?: string | null }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }

    const completedAt = new Date().toISOString()
    const task = this.db.updateTask(input.taskId, {
      status: "cancelled",
      errorText: input.reason ?? current.errorText,
      availableAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      assignedProcessId: null,
      scheduledAt: null,
      cancelRequestedAt: current.cancelRequestedAt ?? completedAt,
      cancelReason: input.reason ?? current.cancelReason ?? "cancelled",
      completedAt,
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: task.lastRunId ?? null,
      type: "task.cancelled",
      payload: {
        taskId: task.id,
        reason: task.cancelReason,
      },
    })

    return this.toGraphNode(task)
  }

  releaseTaskLease(input: { taskId: string; owner?: string | null }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }
    if (input.owner && current.leaseOwner && current.leaseOwner !== input.owner) {
      throw new Error(`Task ${input.taskId} is leased by ${current.leaseOwner}, not ${input.owner}`)
    }

    const task = this.db.updateTask(input.taskId, {
      assignedProcessId: null,
      scheduledAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: task.lastRunId ?? null,
      type: "task.lease.released",
      payload: {
        taskId: task.id,
        owner: input.owner ?? task.leaseOwner ?? null,
      },
    })

    return this.toGraphNode(task)
  }

  renewTaskLease(input: { taskId: string; owner: string; leaseMs?: number }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }
    if (current.leaseOwner && current.leaseOwner !== input.owner) {
      throw new Error(`Task ${input.taskId} is leased by ${current.leaseOwner}, not ${input.owner}`)
    }
    if (current.assignedProcessId && current.assignedProcessId !== input.owner) {
      throw new Error(`Task ${input.taskId} is assigned to ${current.assignedProcessId}, not ${input.owner}`)
    }

    const task = this.db.updateTask(input.taskId, {
      assignedProcessId: input.owner,
      leaseOwner: input.owner,
      leaseExpiresAt: new Date(Date.now() + (input.leaseMs ?? defaultLeaseMs)).toISOString(),
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: task.lastRunId ?? null,
      type: "task.lease.renewed",
      payload: {
        taskId: task.id,
        owner: input.owner,
        leaseExpiresAt: task.leaseExpiresAt,
      },
    })

    return this.toGraphNode(task)
  }

  startTask(input: { taskId: string; owner?: string | null }) {
    const node = this.getTask(input.taskId)
    if (!node) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }

    if (node.readiness === "blocked" || node.readiness === "waiting") {
      throw new Error(`Task ${input.taskId} is not ready; dependencies are incomplete`)
    }

    return this.beginTaskExecution({
      taskId: input.taskId,
      owner: input.owner ?? null,
    })
  }

  beginTaskExecution(input: { taskId: string; owner?: string | null; runId?: string | null }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }

    const attempts = current.status === "running" ? current.attempts : current.attempts + 1
    const task = this.db.updateTask(input.taskId, {
      status: "running",
      attempts,
      availableAt: null,
      owner: input.owner === undefined ? current.owner : input.owner,
      lastRunId: input.runId === undefined ? current.lastRunId : input.runId,
      cancelRequestedAt: current.cancelRequestedAt,
      cancelReason: current.cancelReason,
      completedAt: null,
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: input.runId ?? null,
      type: "task.started",
      payload: {
        taskId: task.id,
        owner: task.owner ?? null,
        attempts: task.attempts,
      },
    })

    return this.toGraphNode(task)
  }

  completeTaskExecution(input: { taskId: string; runId?: string | null; resultText?: string | null }) {
    const task = this.db.updateTask(input.taskId, {
      status: "completed",
      lastRunId: input.runId ?? undefined,
      resultText: input.resultText ?? undefined,
      errorText: null,
      availableAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      assignedProcessId: null,
      scheduledAt: null,
      cancelRequestedAt: null,
      cancelReason: null,
      completedAt: new Date().toISOString(),
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: input.runId ?? null,
      type: "task.completed",
      payload: {
        taskId: task.id,
        attempts: task.attempts,
      },
    })

    return this.toGraphNode(task)
  }

  failTaskExecution(input: { taskId: string; runId?: string | null; errorText?: string | null }) {
    const task = this.db.updateTask(input.taskId, {
      status: "failed",
      lastRunId: input.runId ?? undefined,
      errorText: input.errorText ?? undefined,
      availableAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      assignedProcessId: null,
      scheduledAt: null,
      deadLetteredAt: currentDeadLetterAt(this.db.getTask(input.taskId)),
      completedAt: new Date().toISOString(),
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: input.runId ?? null,
      type: "task.failed",
      payload: {
        taskId: task.id,
        attempts: task.attempts,
        errorText: task.errorText,
      },
    })

    return this.toGraphNode(task)
  }

  retryTask(input: { taskId: string; errorText?: string | null; runId?: string | null; incrementRepairCount?: boolean }) {
    const current = this.db.getTask(input.taskId)
    if (!current) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }

    const task = this.db.updateTask(input.taskId, {
      status: "pending",
      errorText: input.errorText ?? undefined,
      resultText: null,
      availableAt: computeRetryAvailableAt(current),
      leaseOwner: null,
      leaseExpiresAt: null,
      assignedProcessId: null,
      scheduledAt: null,
      lastRunId: input.runId === undefined ? current.lastRunId : input.runId,
      repairCount: input.incrementRepairCount ? current.repairCount + 1 : current.repairCount,
      cancelRequestedAt: null,
      cancelReason: null,
      deadLetteredAt: null,
      completedAt: null,
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: input.runId ?? null,
      type: "task.retry.scheduled",
      payload: {
        taskId: task.id,
        attempts: task.attempts,
        repairCount: task.repairCount,
        errorText: task.errorText,
      },
    })

    return this.toGraphNode(task)
  }

  setTaskStatus(input: {
    taskId: string
    status: TaskRecord["status"]
    resultText?: string | null
    errorText?: string | null
    owner?: string | null
    metadata?: TaskRecord["metadata"]
  }) {
    const completedAt = input.status === "completed" || input.status === "failed" ? new Date().toISOString() : null
    const task = this.db.updateTask(input.taskId, {
      status: input.status,
      resultText: input.resultText ?? undefined,
      errorText: input.errorText ?? undefined,
      owner: input.owner ?? undefined,
      metadata: input.metadata ?? undefined,
      ...(input.status === "completed" || input.status === "failed" || input.status === "cancelled"
        ? {
            availableAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            assignedProcessId: null,
            scheduledAt: null,
            ...(input.status !== "cancelled"
              ? {
                  cancelRequestedAt: null,
                  cancelReason: null,
                }
              : {}),
          }
        : {}),
      completedAt,
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: task.lastRunId ?? null,
      type: "task.status.updated",
      payload: {
        taskId: task.id,
        status: task.status,
        completedAt: task.completedAt,
      },
    })

    return this.toGraphNode(task)
  }

  refreshTaskGraph(input: { threadId?: string; sessionId?: string } = {}) {
    return this.db
      .listTasks(input)
      .map((task) => {
        const node = this.toGraphNode(task)
        if (node.task.status === "pending" && node.readiness === "blocked") {
          return this.db.updateTask(node.task.id, {
            status: "blocked",
            completedAt: null,
          })
        }
        if (node.task.status === "blocked" && node.readiness !== "blocked") {
          return this.db.updateTask(node.task.id, {
            status: "pending",
            completedAt: null,
          })
        }
        return node.task
      })
      .map((task) => this.toGraphNode(task))
  }

  private toGraphNode(task: TaskRecord): TaskGraphNode {
    const dependencies = this.db.listTaskDependencies(task.id)
    return {
      task,
      dependencies,
      readiness: this.computeReadiness(task, dependencies.map((item) => item.dependsOnTaskId)),
    }
  }

  private computeReadiness(task: TaskRecord, dependencyIds: string[]): TaskGraphNode["readiness"] {
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return "done"
    if (task.status === "running") return "ready"
    if (task.availableAt && task.availableAt > new Date().toISOString()) return "waiting"
    if (dependencyIds.length === 0) {
      return task.status === "blocked" ? "blocked" : "ready"
    }

    const dependencies = dependencyIds
      .map((id) => this.db.getTask(id))
      .filter((item): item is TaskRecord => Boolean(item))

    if (dependencies.length !== dependencyIds.length) return "blocked"
    if (dependencies.some((dependency) => dependency.status === "failed" || dependency.status === "blocked")) return "blocked"
    if (dependencies.some((dependency) => dependency.status !== "completed")) return "waiting"
    return "ready"
  }
}

export class TaskExecutionCoordinator implements RunLifecycleHooks {
  private readonly evaluators: EvaluatorService

  constructor(
    private readonly db: AgentOsDatabase,
    private readonly tasks: TaskService,
    registry: EvaluatorRegistry = createDefaultEvaluatorRegistry(),
  ) {
    this.evaluators = new EvaluatorService(db, registry)
  }

  async onRunStarted(input: { taskId: string; runId: string }) {
    this.tasks.beginTaskExecution({
      taskId: input.taskId,
      runId: input.runId,
    })
  }

  async onRunCompleted(input: { taskId: string; runId: string }) {
    const task = this.db.getTask(input.taskId)
    const run = this.db.getRun(input.runId)
    if (!task || !run) {
      throw new Error(`Unable to reconcile completed run ${input.runId} for task ${input.taskId}`)
    }

    const evaluatorNames = resolveRequiredEvaluators(task)
    const results: EvaluatorResultRecord[] = []

    for (const evaluatorName of evaluatorNames) {
      const evaluation = await this.evaluators.evaluateTask({
        taskId: task.id,
        runId: run.id,
        evaluatorName,
      })
      results.push(evaluation.result)
    }

    const failed = results.filter((result) => result.decision === "fail")
    if (failed.length === 0) {
      this.tasks.completeTaskExecution({
        taskId: task.id,
        runId: run.id,
        resultText: run.outputText ?? summarizeEvaluatorResults(results),
      })
      return
    }

    const errorText = summarizeEvaluatorResults(failed)
    const latestTask = this.db.getTask(task.id)
    if (latestTask && latestTask.attempts < latestTask.maxAttempts) {
      this.tasks.retryTask({
        taskId: task.id,
        runId: run.id,
        errorText,
        incrementRepairCount: true,
      })
      this.db.recordEvent({
        threadId: task.threadId,
        sessionId: task.sessionId ?? null,
        runId: run.id,
        type: "task.repair.requested",
        payload: {
          taskId: task.id,
          reason: errorText,
          nextAttempt: latestTask.attempts + 1,
        },
      })
      return
    }

    this.tasks.failTaskExecution({
      taskId: task.id,
      runId: run.id,
      errorText,
    })
  }

  async onRunFailed(input: { taskId: string; runId: string; errorText: string }) {
    const task = this.db.getTask(input.taskId)
    if (!task) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }

    if (task.attempts < task.maxAttempts) {
      this.tasks.retryTask({
        taskId: task.id,
        runId: input.runId,
        errorText: input.errorText,
        incrementRepairCount: true,
      })
      this.db.recordEvent({
        threadId: task.threadId,
        sessionId: task.sessionId ?? null,
        runId: input.runId,
        type: "task.repair.requested",
        payload: {
          taskId: task.id,
          reason: input.errorText,
          nextAttempt: task.attempts + 1,
        },
      })
      return
    }

    this.tasks.failTaskExecution({
      taskId: task.id,
      runId: input.runId,
      errorText: input.errorText,
    })
  }
}

function resolveRequiredEvaluators(task: TaskRecord) {
  if (task.evaluatorGate === "none") return []

  const metadataEvaluators = Array.isArray(task.metadata?.requiredEvaluators)
    ? task.metadata.requiredEvaluators.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []

  if (metadataEvaluators.length > 0) return metadataEvaluators
  return ["task-has-run", "run-output-nonempty"]
}

function summarizeEvaluatorResults(results: EvaluatorResultRecord[]) {
  return results.map((result) => `${result.evaluatorName}: ${result.summary}`).join("; ")
}

function hasActiveLease(task: TaskRecord) {
  return Boolean(task.leaseOwner && task.leaseExpiresAt && task.leaseExpiresAt > new Date().toISOString())
}

function isTaskDispatchable(task: TaskRecord) {
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return false
  if (task.assignedProcessId) return false
  if (task.cancelRequestedAt) return false
  if (hasActiveLease(task)) return false
  if (task.attempts >= task.maxAttempts) return false
  if (task.availableAt && task.availableAt > new Date().toISOString()) return false
  return true
}

function computeRetryAvailableAt(task: TaskRecord) {
  const backoffSeconds = Math.min(300, Math.max(5, 15 * 2 ** Math.max(0, task.attempts - 1)))
  return new Date(Date.now() + backoffSeconds * 1000).toISOString()
}

function currentDeadLetterAt(task: TaskRecord | undefined) {
  if (!task) return new Date().toISOString()
  return task.attempts >= task.maxAttempts ? new Date().toISOString() : null
}

function compareClaimPriority(left: TaskGraphNode, right: TaskGraphNode) {
  const leftPriority = priorityWeight(left.task.priority)
  const rightPriority = priorityWeight(right.task.priority)
  if (leftPriority !== rightPriority) return rightPriority - leftPriority
  const leftAvailableAt = left.task.availableAt ?? left.task.createdAt
  const rightAvailableAt = right.task.availableAt ?? right.task.createdAt
  if (leftAvailableAt !== rightAvailableAt) return leftAvailableAt.localeCompare(rightAvailableAt)
  return left.task.createdAt.localeCompare(right.task.createdAt)
}

function priorityWeight(priority: TaskRecord["priority"]) {
  if (priority === "high") return 3
  if (priority === "normal") return 2
  return 1
}
