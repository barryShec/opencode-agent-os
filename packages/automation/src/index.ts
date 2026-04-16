import { RuntimeSupervisor } from "@opencode-agent-os/runtime-supervisor"
import { TaskService } from "@opencode-agent-os/runtime-task"
import type { AutomationRecord, TaskRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

export class AutomationService {
  constructor(
    private readonly db: AgentOsDatabase,
    private readonly tasks: TaskService,
    private readonly supervisor: RuntimeSupervisor,
  ) {}

  createAutomation(input: {
    label: string
    kind: AutomationRecord["kind"]
    intervalSeconds: number
    threadId?: string | null
    sessionId?: string | null
    processId?: string | null
    nextRunAt?: string
    status?: AutomationRecord["status"]
    metadata?: AutomationRecord["metadata"]
  }) {
    const record = this.db.createAutomation({
      label: input.label,
      kind: input.kind,
      status: input.status ?? "active",
      threadId: input.threadId ?? null,
      sessionId: input.sessionId ?? null,
      processId: input.processId ?? null,
      intervalSeconds: input.intervalSeconds,
      nextRunAt: input.nextRunAt ?? new Date().toISOString(),
      metadata: input.metadata ?? null,
    })

    this.db.recordEvent({
      threadId: record.threadId ?? null,
      sessionId: record.sessionId ?? null,
      type: "automation.created",
      payload: {
        automationId: record.id,
        kind: record.kind,
        processId: record.processId,
      },
    })

    return record
  }

  listAutomations(input: { status?: AutomationRecord["status"]; threadId?: string; sessionId?: string; processId?: string } = {}) {
    return this.db.listAutomations(input)
  }

  pauseAutomation(automationId: string) {
    return this.db.updateAutomation(automationId, {
      status: "paused",
    })
  }

  resumeAutomation(automationId: string, nextRunAt = new Date().toISOString()) {
    return this.db.updateAutomation(automationId, {
      status: "active",
      nextRunAt,
      lastError: null,
    })
  }

  async runDueAutomations(input: {
    now?: string
    limit?: number
    supervisorOwner?: string
  }) {
    const now = input.now ?? new Date().toISOString()
    const due = this.db.listDueAutomations(now, input.limit ?? 20)
    const results: Array<{ automation: AutomationRecord; status: "processed" | "failed"; detail: unknown }> = []

    for (const automation of due) {
      try {
        const detail = await this.executeAutomation(automation, {
          supervisorOwner: input.supervisorOwner ?? `automation:${automation.id}`,
        })
        const updated = this.db.updateAutomation(automation.id, {
          nextRunAt: computeNextRunAt(now, automation.intervalSeconds),
          lastRunAt: now,
          lastError: null,
        })
        this.db.recordEvent({
          threadId: updated.threadId ?? null,
          sessionId: updated.sessionId ?? null,
          type: "automation.executed",
          payload: {
            automationId: updated.id,
            kind: updated.kind,
          },
        })
        results.push({
          automation: updated,
          status: "processed",
          detail,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const updated = this.db.updateAutomation(automation.id, {
          nextRunAt: computeNextRunAt(now, automation.intervalSeconds),
          lastRunAt: now,
          lastError: message,
        })
        this.db.recordEvent({
          threadId: updated.threadId ?? null,
          sessionId: updated.sessionId ?? null,
          type: "automation.failed",
          payload: {
            automationId: updated.id,
            error: message,
          },
        })
        results.push({
          automation: updated,
          status: "failed",
          detail: message,
        })
      }
    }

    return results
  }

  private async executeAutomation(
    automation: AutomationRecord,
    input: {
      supervisorOwner: string
    },
  ) {
    if (automation.kind === "process-run-once") {
      if (!automation.processId) {
        throw new Error(`Automation ${automation.id} requires processId`)
      }
      return this.supervisor.scheduleOnce({
        owner: input.supervisorOwner,
        processIds: [automation.processId],
      })
    }

    const sessionId = automation.sessionId ?? readStringMetadata(automation.metadata, "sessionId")
    const threadId = automation.threadId ?? readStringMetadata(automation.metadata, "threadId")
    if (!sessionId && !threadId) {
      throw new Error(`Automation ${automation.id} requires threadId or sessionId`)
    }

    const prompt = readStringMetadata(automation.metadata, "prompt")
    if (!prompt) {
      throw new Error(`Automation ${automation.id} is missing metadata.prompt`)
    }

    const title = readStringMetadata(automation.metadata, "title") ?? summarizePrompt(prompt)
    const resolvedThreadId = threadId ?? resolveThreadIdFromSession(this.db, sessionId)
    const task = this.tasks.createTask({
      threadId: resolvedThreadId,
      ...(sessionId ? { sessionId } : {}),
      title,
      description: prompt,
      maxAttempts: readPositiveIntMetadata(automation.metadata, "maxAttempts") ?? 3,
      evaluatorGate: readEvaluatorGateMetadata(automation.metadata, "evaluatorGate") ?? "required",
      metadata: buildPromptTaskMetadata(automation, prompt),
    })

    const autoProcessId = automation.processId ?? readStringMetadata(automation.metadata, "processId")
    if (!autoProcessId) {
      return task
    }

    return {
      task,
      schedule: this.supervisor.scheduleOnce({
        owner: input.supervisorOwner,
        processIds: [autoProcessId],
        preferredTaskIds: [task.task.id],
      }),
    }
  }
}

function computeNextRunAt(nowIso: string, intervalSeconds: number) {
  const now = new Date(nowIso).getTime()
  return new Date(now + intervalSeconds * 1000).toISOString()
}

function summarizePrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim()
  if (normalized.length <= 48) return normalized || "Automation task"
  return `${normalized.slice(0, 45)}...`
}

function buildPromptTaskMetadata(automation: AutomationRecord, prompt: string): TaskRecord["metadata"] {
  return {
    source: "automation",
    automationId: automation.id,
    prompt,
  }
}

function readStringMetadata(metadata: AutomationRecord["metadata"], key: string) {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readPositiveIntMetadata(metadata: AutomationRecord["metadata"], key: string) {
  const value = metadata?.[key]
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function readEvaluatorGateMetadata(metadata: AutomationRecord["metadata"], key: string) {
  const value = metadata?.[key]
  return value === "none" || value === "required" ? value : undefined
}

function resolveThreadIdFromSession(db: AgentOsDatabase, sessionId: string | null | undefined) {
  if (!sessionId) {
    throw new Error("Missing sessionId while resolving threadId")
  }
  const session = db.getSession(sessionId)
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`)
  }
  return session.threadId
}
