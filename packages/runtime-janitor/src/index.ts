import { TaskService } from "@opencode-agent-os/runtime-task"
import type { AutomationRecord, ProcessRecord, RunRecord, TaskRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

const defaultProcessStaleMs = 30_000
const defaultRunStaleMs = 10 * 60 * 1000
const defaultAutomationFailureStreakLimit = 3

export interface JanitorRunResult {
  owner: string
  now: string
  staleProcesses: Array<{ processId: string; status: ProcessRecord["status"]; reason: string }>
  recoveredTasks: Array<{ taskId: string; status: TaskRecord["status"]; action: "requeued" | "failed" | "cancelled" | "released"; reason: string }>
  failedRuns: Array<{ runId: string; taskId?: string | null; reason: string }>
  pausedAutomations: Array<{ automationId: string; reason: string }>
}

export class RuntimeJanitor {
  constructor(
    private readonly db: AgentOsDatabase,
    private readonly tasks: TaskService,
  ) {}

  runOnce(input: {
    owner?: string
    now?: string
    staleProcessMs?: number
    staleRunMs?: number
    automationFailureStreakLimit?: number
  } = {}): JanitorRunResult {
    const owner = input.owner ?? "janitor"
    const now = input.now ?? new Date().toISOString()
    const staleProcessMs = input.staleProcessMs ?? defaultProcessStaleMs
    const staleRunMs = input.staleRunMs ?? defaultRunStaleMs
    const automationFailureStreakLimit = input.automationFailureStreakLimit ?? defaultAutomationFailureStreakLimit
    const handledTaskIds = new Set<string>()

    const result: JanitorRunResult = {
      owner,
      now,
      staleProcesses: [],
      recoveredTasks: [],
      failedRuns: [],
      pausedAutomations: [],
    }

    for (const process of this.db.listProcesses()) {
      if (!isProcessStale(process, staleProcessMs, now)) continue

      if (!process.activeTaskId) {
        if (process.status !== "stopped" && process.status !== "error") {
          this.markProcessError(process, owner, "executor heartbeat stale", result)
        }
        continue
      }

      const task = this.db.getTask(process.activeTaskId)
      if (!task) {
        this.markProcessError(process, owner, "executor referenced missing task", result)
        continue
      }

      if (task.assignedProcessId && task.assignedProcessId !== process.id) {
        this.markProcessError(process, owner, "executor lost task ownership", result)
        continue
      }

      handledTaskIds.add(task.id)
      this.recoverTask({
        task,
        process,
        owner,
        now,
        reason: "executor heartbeat stale",
        result,
      })
    }

    for (const task of this.db.listTasks()) {
      if (!task.assignedProcessId || handledTaskIds.has(task.id)) continue

      const process = this.db.getProcess(task.assignedProcessId)
      if (!process) {
        this.recoverTask({
          task,
          owner,
          now,
          reason: "task assigned to missing process",
          result,
        })
        handledTaskIds.add(task.id)
        continue
      }

      if (process.activeTaskId !== task.id || process.status === "stopped" || process.status === "error") {
        this.recoverTask({
          task,
          process,
          owner,
          now,
          reason:
            process.activeTaskId !== task.id ? "process no longer owns assigned task" : `task assigned to ${process.status} process`,
          result,
        })
        handledTaskIds.add(task.id)
      }
    }

    for (const run of this.db.listRuns({ status: "running" })) {
      if (isRunFresh(run, staleRunMs, now)) continue

      const task = run.taskId ? this.db.getTask(run.taskId) : undefined
      if (task && handledTaskIds.has(task.id)) continue

      if (!task) {
        this.failRun(run, owner, "stale run without recoverable task context", result)
        continue
      }

      if (task.status !== "running") {
        this.failRun(run, owner, `stale run closed because task is ${task.status}`, result)
        continue
      }

      const process = task.assignedProcessId ? this.db.getProcess(task.assignedProcessId) : undefined
      if (process && !isProcessStale(process, staleProcessMs, now) && process.activeTaskId === task.id) {
        continue
      }

      handledTaskIds.add(task.id)
      this.recoverTask({
        task,
        ...(process ? { process } : {}),
        run,
        owner,
        now,
        reason: "stale running task without a healthy executor",
        result,
      })
    }

    for (const automation of this.db.listAutomations({ status: "active" })) {
      const failureStreak = readAutomationFailureStreak(automation)
      const autoPause = automation.metadata?.autoPauseOnFailure !== false
      if (!autoPause || failureStreak < automationFailureStreakLimit) continue

      const reason = `paused after ${failureStreak} consecutive automation failures`
      const updated = this.db.updateAutomation(automation.id, {
        status: "paused",
        lastError: automation.lastError ?? reason,
        metadata: {
          ...(automation.metadata ?? {}),
          pausedBy: owner,
          pausedAt: now,
        },
      })
      this.db.recordEvent({
        threadId: updated.threadId ?? null,
        sessionId: updated.sessionId ?? null,
        type: "janitor.automation.paused",
        payload: {
          automationId: updated.id,
          owner,
          failureStreak,
          reason,
        },
      })
      result.pausedAutomations.push({
        automationId: updated.id,
        reason,
      })
    }

    return result
  }

  private recoverTask(input: {
    task: TaskRecord
    process?: ProcessRecord
    run?: RunRecord
    owner: string
    now: string
    reason: string
    result: JanitorRunResult
  }) {
    const run = input.run ?? resolveLatestRun(this.db, input.task)
    if (run?.status === "running") {
      this.failRun(run, input.owner, input.reason, input.result)
    }

    let recovered: ReturnType<TaskService["getTask"]> | undefined
    let action: JanitorRunResult["recoveredTasks"][number]["action"]

    if (input.task.status === "running") {
      if (input.task.cancelRequestedAt) {
        recovered = this.tasks.cancelTask({
          taskId: input.task.id,
          reason: input.task.cancelReason ?? input.reason,
        })
        action = "cancelled"
      } else if (input.task.attempts < input.task.maxAttempts) {
        const runId = run?.id ?? input.task.lastRunId ?? null
        recovered = this.tasks.retryTask({
          taskId: input.task.id,
          ...(runId ? { runId } : {}),
          errorText: input.reason,
          incrementRepairCount: true,
        })
        action = "requeued"
      } else {
        const runId = run?.id ?? input.task.lastRunId ?? null
        recovered = this.tasks.failTaskExecution({
          taskId: input.task.id,
          ...(runId ? { runId } : {}),
          errorText: input.reason,
        })
        action = "failed"
      }
    } else if (input.task.status === "pending" || input.task.status === "blocked") {
      recovered = this.tasks.requeueTask({
        taskId: input.task.id,
        reason: input.reason,
        availableAt: input.now,
      })
      action = "requeued"
    } else {
      recovered = this.tasks.releaseTaskLease({
        taskId: input.task.id,
      })
      action = "released"
    }

    this.db.recordEvent({
      threadId: input.task.threadId,
      sessionId: input.task.sessionId ?? null,
      runId: run?.id ?? null,
      type: "janitor.task.recovered",
      payload: {
        owner: input.owner,
        taskId: input.task.id,
        processId: input.process?.id ?? input.task.assignedProcessId ?? null,
        action,
        reason: input.reason,
      },
    })

    input.result.recoveredTasks.push({
      taskId: input.task.id,
      status: recovered?.task.status ?? input.task.status,
      action,
      reason: input.reason,
    })

    if (input.process) {
      this.markProcessError(input.process, input.owner, input.reason, input.result)
    }
  }

  private failRun(run: RunRecord, owner: string, reason: string, result: JanitorRunResult) {
    const mergedMetadata = {
      ...(run.metadata ?? {}),
      janitor: {
        owner,
        failedAt: new Date().toISOString(),
        reason,
      },
    }

    this.db.completeRun(run.id, {
      status: "failed",
      errorText: reason,
      metadata: mergedMetadata,
    })

    this.db.recordEvent({
      threadId: run.threadId,
      sessionId: run.sessionId,
      runId: run.id,
      type: "janitor.run.failed",
      payload: {
        owner,
        runId: run.id,
        taskId: run.taskId ?? null,
        reason,
      },
    })

    result.failedRuns.push({
      runId: run.id,
      taskId: run.taskId ?? null,
      reason,
    })
  }

  private markProcessError(process: ProcessRecord, owner: string, reason: string, result: JanitorRunResult) {
    if (process.status === "error" && !process.activeTaskId) return

    const updated = this.db.updateProcess(process.id, {
      status: "error",
      activeTaskId: null,
    })
    this.db.recordEvent({
      threadId: updated.threadId ?? null,
      sessionId: updated.sessionId ?? null,
      type: "janitor.process.marked_error",
      payload: {
        owner,
        processId: updated.id,
        reason,
      },
    })

    result.staleProcesses.push({
      processId: updated.id,
      status: updated.status,
      reason,
    })
  }
}

function resolveLatestRun(db: AgentOsDatabase, task: TaskRecord) {
  return task.lastRunId ? db.getRun(task.lastRunId) : db.getLatestRunForTask(task.id)
}

function isProcessStale(process: ProcessRecord, staleProcessMs: number, nowIso: string) {
  return new Date(nowIso).getTime() - new Date(process.heartbeatAt).getTime() >= staleProcessMs
}

function isRunFresh(run: RunRecord, staleRunMs: number, nowIso: string) {
  return new Date(nowIso).getTime() - new Date(run.startedAt).getTime() < staleRunMs
}

function readAutomationFailureStreak(automation: AutomationRecord) {
  const value = automation.metadata?.failureStreak
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}
