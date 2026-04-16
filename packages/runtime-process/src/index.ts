import type { ApprovalHandler } from "@opencode-agent-os/runtime-session"
import { RunEngine } from "@opencode-agent-os/runtime-runner"
import { TaskService } from "@opencode-agent-os/runtime-task"
import type { ProcessRecord, TaskGraphNode, TaskRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

const defaultLeaseMs = 5 * 60 * 1000

export class AgentProcessService {
  constructor(
    private readonly db: AgentOsDatabase,
    private readonly tasks: TaskService,
    private readonly runner: RunEngine,
  ) {}

  startProcess(input: {
    label: string
    owner: string
    threadId?: string | null
    sessionId?: string | null
    metadata?: ProcessRecord["metadata"]
  }) {
    const session = input.sessionId ? this.db.getSession(input.sessionId) : undefined
    const process = this.db.createProcess({
      threadId: input.threadId ?? session?.threadId ?? null,
      sessionId: input.sessionId ?? null,
      label: input.label,
      owner: input.owner,
      status: "idle",
      activeTaskId: null,
      lastAssignedAt: null,
      metadata: input.metadata ?? null,
    })

    this.db.recordEvent({
      threadId: process.threadId ?? null,
      sessionId: process.sessionId ?? null,
      type: "process.started",
      payload: {
        processId: process.id,
        label: process.label,
        owner: process.owner,
      },
    })

    return process
  }

  getProcess(processId: string) {
    return this.db.getProcess(processId)
  }

  listProcesses(input: { threadId?: string; sessionId?: string; status?: ProcessRecord["status"] } = {}) {
    return this.db.listProcesses(input)
  }

  heartbeat(
    processId: string,
    input: {
      status?: ProcessRecord["status"]
      activeTaskId?: string | null
      lastAssignedAt?: string | null
    } = {},
  ) {
    const process = this.db.updateProcess(processId, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.activeTaskId !== undefined ? { activeTaskId: input.activeTaskId } : {}),
      ...(input.lastAssignedAt !== undefined ? { lastAssignedAt: input.lastAssignedAt } : {}),
      heartbeatAt: new Date().toISOString(),
    })

    this.db.recordEvent({
      threadId: process.threadId ?? null,
      sessionId: process.sessionId ?? null,
      runId: null,
      type: "process.heartbeat",
      payload: {
        processId: process.id,
        status: process.status,
        activeTaskId: process.activeTaskId,
      },
    })

    return process
  }

  stopProcess(processId: string) {
    const process = this.db.updateProcess(processId, {
      status: "stopped",
      activeTaskId: null,
      heartbeatAt: new Date().toISOString(),
    })

    this.db.recordEvent({
      threadId: process.threadId ?? null,
      sessionId: process.sessionId ?? null,
      type: "process.stopped",
      payload: {
        processId: process.id,
      },
    })

    return process
  }

  async runOnce(input: {
    processId: string
    providerName: string
    modelName: string
    cwd?: string
    leaseMs?: number
    approvalHandler?: ApprovalHandler
  }) {
    const process = this.db.getProcess(input.processId)
    if (!process) {
      throw new Error(`Unknown process: ${input.processId}`)
    }
    if (process.status === "stopped") {
      throw new Error(`Process ${input.processId} is stopped`)
    }

    const activeTaskId = process.activeTaskId
    if (!activeTaskId) {
      const updated = this.heartbeat(process.id, { status: "idle", activeTaskId: null })
      return {
        process: updated,
        task: null,
        execution: null,
        error: null,
      }
    }

    const task = this.db.getTask(activeTaskId)
    if (!task || task.assignedProcessId !== process.id) {
      const updated = this.heartbeat(process.id, {
        status: "idle",
        activeTaskId: null,
      })
      return {
        process: updated,
        task: null,
        execution: null,
        error: task ? `Task ${task.id} is not assigned to process ${process.id}` : `Unknown task: ${activeTaskId}`,
      }
    }

    if (task.cancelRequestedAt && task.status !== "running") {
      const cancelled = this.tasks.cancelTask({
        taskId: task.id,
        reason: task.cancelReason ?? "cancelled before execution",
      })
      const updated = this.heartbeat(process.id, {
        status: "idle",
        activeTaskId: null,
      })
      return {
        process: updated,
        task: cancelled,
        execution: null,
        error: null,
      }
    }

    const runningProcess = this.heartbeat(process.id, {
      status: "running",
      activeTaskId: task.id,
    })
    const stopLeaseHeartbeat = startLeaseHeartbeat({
      leaseMs: input.leaseMs,
      renewLease: () =>
        this.tasks.renewTaskLease({
          taskId: task.id,
          owner: process.id,
          ...(input.leaseMs ? { leaseMs: input.leaseMs } : {}),
        }),
      heartbeat: () =>
        this.heartbeat(process.id, {
          status: "running",
          activeTaskId: task.id,
        }),
    })

    try {
      const execution = await this.executeTask(task, {
        process: runningProcess,
        providerName: input.providerName,
        modelName: input.modelName,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.approvalHandler ? { approvalHandler: input.approvalHandler } : {}),
      })

      stopLeaseHeartbeat()
      const updated = this.heartbeat(process.id, {
        status: "idle",
        activeTaskId: null,
      })

      return {
        process: updated,
        task: this.tasks.getTask(task.id),
        execution,
        error: null,
      }
    } catch (error) {
      stopLeaseHeartbeat()
      const updated = this.heartbeat(process.id, {
        status: "idle",
        activeTaskId: null,
      })
      const message = error instanceof Error ? error.message : String(error)

      this.db.recordEvent({
        threadId: process.threadId ?? task.threadId ?? null,
        sessionId: process.sessionId ?? task.sessionId ?? null,
        type: "process.task.execution_failed",
        payload: {
          processId: process.id,
          taskId: task.id,
          error: message,
        },
      })

      return {
        process: updated,
        task: this.tasks.getTask(task.id),
        execution: null,
        error: message,
      }
    }
  }

  private async executeTask(
    task: TaskRecord,
    input: {
      process: ProcessRecord
      providerName: string
      modelName: string
      cwd?: string
      approvalHandler?: ApprovalHandler
    },
  ) {
    const metadata = task.metadata ?? {}
    const executionMode = typeof metadata.executionMode === "string" ? metadata.executionMode : "prompt"

    if (executionMode === "tool") {
      const sessionId = task.sessionId ?? input.process.sessionId
      if (!sessionId) {
        throw new Error(`Task ${task.id} requires a session for tool execution`)
      }
      const toolName = typeof metadata.toolName === "string" ? metadata.toolName : null
      if (!toolName) {
        throw new Error(`Task ${task.id} is missing metadata.toolName`)
      }

      return this.runner.executeTool({
        sessionId,
        taskId: task.id,
        toolName,
        args: metadata.toolArgs ?? {},
        cwd: input.cwd ?? process.cwd(),
        ...(input.approvalHandler ? { approvalHandler: input.approvalHandler } : {}),
      })
    }

    return this.runner.runPrompt({
      prompt: buildTaskPrompt(task),
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(!task.sessionId && task.threadId ? { threadId: task.threadId } : {}),
      taskId: task.id,
      providerName: input.providerName,
      modelName: input.modelName,
      ...(typeof metadata.systemPrompt === "string" ? { systemPrompt: metadata.systemPrompt } : {}),
    })
  }
}

function buildTaskPrompt(task: TaskRecord) {
  const metadataPrompt = typeof task.metadata?.prompt === "string" ? task.metadata.prompt : null
  if (metadataPrompt) return metadataPrompt
  if (task.description && task.description.trim().length > 0) return task.description
  return task.title
}

function startLeaseHeartbeat(input: {
  leaseMs?: number
  renewLease: () => TaskGraphNode
  heartbeat: () => ProcessRecord
}) {
  const intervalMs = Math.max(1000, Math.floor((input.leaseMs ?? defaultLeaseMs) / 2))
  const timer = setInterval(() => {
    input.renewLease()
    input.heartbeat()
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
