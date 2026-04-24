#!/usr/bin/env node

import { createServer } from "node:http"
import { parseArgs } from "node:util"
import { ensureConfigLayout, loadConfig } from "@opencode-agent-os/config"
import { RuntimeJanitor } from "@opencode-agent-os/runtime-janitor"
import { RuntimeSupervisor } from "@opencode-agent-os/runtime-supervisor"
import { TaskService } from "@opencode-agent-os/runtime-task"
import type { AutomationRecord, GatewayDeliveryRecord, ProcessRecord, TaskRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    host: { type: "string" },
    port: { type: "string" },
  },
})

const config = await loadConfig()
await ensureConfigLayout(config)

const db = new AgentOsDatabase(config.dbPath)
db.migrate()

const tasks = new TaskService(db)
const janitor = new RuntimeJanitor(db, tasks)
const supervisor = new RuntimeSupervisor(db, tasks)

const host = getString(values.host) ?? "127.0.0.1"
const port = parsePort(getString(values.port)) ?? 8788

const server = createServer(async (request, response) => {
  setCommonHeaders(response)

  if (!request.url) {
    return sendJson(response, 400, { error: "Missing URL" })
  }

  const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`)
  const segments = url.pathname.split("/").filter(Boolean)

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(response, 200, {
        ok: true,
        dbPath: config.dbPath,
        supervisorLease: db.getSupervisorLease(url.searchParams.get("name") ?? "main"),
      })
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const allTasks = db.listTasks()
      const allProcesses = db.listProcesses()
      const allAutomations = db.listAutomations()
      const allDeliveries = db.listGatewayDeliveries()

      return sendJson(response, 200, {
        counts: {
          threads: db.listThreads().length,
          sessions: db.listSessions().length,
          tasks: allTasks.length,
          processes: allProcesses.length,
          automations: allAutomations.length,
          routes: db.listGatewayRoutes().length,
          deliveries: allDeliveries.length,
          deadLetterTasks: allTasks.filter((task) => Boolean(task.deadLetteredAt)).length,
        },
        tasks: {
          byStatus: summarizeByStatus(allTasks),
          byPriority: summarizeByPriority(allTasks),
          bySchedulingClass: summarizeTaskClasses(allTasks),
          byPool: summarizeTaskPools(allTasks),
        },
        processes: {
          byStatus: summarizeByProcessStatus(allProcesses),
          byPool: summarizeProcessPools(allProcesses),
        },
        automations: summarizeByAutomationStatus(allAutomations),
        deliveries: summarizeByDeliveryStatus(allDeliveries),
        supervisorLease: db.getSupervisorLease(url.searchParams.get("name") ?? "main"),
      })
    }

    if (request.method === "GET" && url.pathname === "/threads") {
      return sendJson(response, 200, {
        threads: db.listThreads(),
      })
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      const threadId = getOptionalQuery(url.searchParams, "threadId")
      return sendJson(response, 200, {
        sessions: db.listSessions({
          ...(threadId ? { threadId } : {}),
        }),
      })
    }

    if (request.method === "GET" && url.pathname === "/tasks") {
      return sendJson(response, 200, {
        tasks: tasks.listTasks({
          ...(getOptionalQuery(url.searchParams, "threadId") ? { threadId: getOptionalQuery(url.searchParams, "threadId")! } : {}),
          ...(getOptionalQuery(url.searchParams, "sessionId") ? { sessionId: getOptionalQuery(url.searchParams, "sessionId")! } : {}),
          ...(parseTaskStatus(getOptionalQuery(url.searchParams, "status")) ? { status: parseTaskStatus(getOptionalQuery(url.searchParams, "status"))! } : {}),
        }),
      })
    }

    if (request.method === "GET" && url.pathname === "/tasks/dead-letter") {
      return sendJson(response, 200, {
        tasks: db
          .listTasks()
          .filter((task) => Boolean(task.deadLetteredAt))
          .sort((left, right) => (right.deadLetteredAt ?? "").localeCompare(left.deadLetteredAt ?? "")),
      })
    }

    if (request.method === "GET" && segments[0] === "tasks" && segments.length === 2) {
      const taskId = decodeURIComponent(segments[1] ?? "")
      const task = tasks.getTask(taskId)
      if (!task) {
        return sendJson(response, 404, { error: `Unknown task: ${taskId}` })
      }
      return sendJson(response, 200, task)
    }

    if (request.method === "POST" && segments[0] === "tasks" && segments[2] === "requeue") {
      const taskId = decodeURIComponent(segments[1] ?? "")
      const body = await readJsonBody(request)
      return sendJson(response, 200, tasks.requeueTask({
        taskId,
        ...(asString(body.reason) ? { reason: body.reason } : {}),
        ...(asString(body.availableAt) ? { availableAt: body.availableAt } : {}),
        ...(typeof body.clearCancellation === "boolean" ? { clearCancellation: body.clearCancellation } : {}),
        ...(typeof body.incrementRepairCount === "boolean" ? { incrementRepairCount: body.incrementRepairCount } : {}),
      }))
    }

    if (request.method === "POST" && segments[0] === "tasks" && segments[2] === "retry") {
      const taskId = decodeURIComponent(segments[1] ?? "")
      const body = await readJsonBody(request)
      return sendJson(response, 200, tasks.retryTask({
        taskId,
        ...(asString(body.errorText) ? { errorText: body.errorText } : {}),
        ...(typeof body.incrementRepairCount === "boolean" ? { incrementRepairCount: body.incrementRepairCount } : {}),
      }))
    }

    if (request.method === "POST" && segments[0] === "tasks" && segments[2] === "cancel") {
      const taskId = decodeURIComponent(segments[1] ?? "")
      const body = await readJsonBody(request)
      return sendJson(response, 200, tasks.requestTaskCancellation({
        taskId,
        ...(asString(body.reason) ? { reason: body.reason } : {}),
      }))
    }

    if (request.method === "GET" && url.pathname === "/processes") {
      return sendJson(response, 200, {
        processes: db.listProcesses({
          ...(getOptionalQuery(url.searchParams, "threadId") ? { threadId: getOptionalQuery(url.searchParams, "threadId")! } : {}),
          ...(getOptionalQuery(url.searchParams, "sessionId") ? { sessionId: getOptionalQuery(url.searchParams, "sessionId")! } : {}),
          ...(parseProcessStatus(getOptionalQuery(url.searchParams, "status")) ? { status: parseProcessStatus(getOptionalQuery(url.searchParams, "status"))! } : {}),
        }),
      })
    }

    if (request.method === "GET" && url.pathname === "/automations") {
      return sendJson(response, 200, {
        automations: db.listAutomations({
          ...(parseAutomationStatus(getOptionalQuery(url.searchParams, "status")) ? { status: parseAutomationStatus(getOptionalQuery(url.searchParams, "status"))! } : {}),
          ...(getOptionalQuery(url.searchParams, "threadId") ? { threadId: getOptionalQuery(url.searchParams, "threadId")! } : {}),
          ...(getOptionalQuery(url.searchParams, "sessionId") ? { sessionId: getOptionalQuery(url.searchParams, "sessionId")! } : {}),
          ...(getOptionalQuery(url.searchParams, "processId") ? { processId: getOptionalQuery(url.searchParams, "processId")! } : {}),
        }),
      })
    }

    if (request.method === "GET" && url.pathname === "/supervisor/lease") {
      return sendJson(response, 200, {
        lease: db.getSupervisorLease(url.searchParams.get("name") ?? "main"),
      })
    }

    if (request.method === "POST" && url.pathname === "/supervisor/tick") {
      const body = await readJsonBody(request)
      return sendJson(response, 200, supervisor.scheduleOnce({
        owner: asString(body.owner) ? body.owner : "control-plane-supervisor",
        ...(Array.isArray(body.processIds) ? { processIds: body.processIds.filter((item): item is string => typeof item === "string") } : {}),
        ...(Array.isArray(body.preferredTaskIds)
          ? { preferredTaskIds: body.preferredTaskIds.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(isRecord(body.poolBudgets) ? { poolBudgets: parsePoolBudgets(body.poolBudgets) } : {}),
      }))
    }

    if (request.method === "POST" && url.pathname === "/janitor/tick") {
      const body = await readJsonBody(request)
      return sendJson(response, 200, janitor.runOnce({
        owner: asString(body.owner) ? body.owner : "control-plane-janitor",
        ...(typeof body.now === "string" ? { now: body.now } : {}),
        ...(typeof body.staleProcessMs === "number" ? { staleProcessMs: body.staleProcessMs } : {}),
        ...(typeof body.staleRunMs === "number" ? { staleRunMs: body.staleRunMs } : {}),
        ...(typeof body.automationFailureStreakLimit === "number"
          ? { automationFailureStreakLimit: body.automationFailureStreakLimit }
          : {}),
      }))
    }

    sendJson(response, 404, {
      error: "Not found",
      path: url.pathname,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const statusCode = /Unknown (task|thread|session|process|automation)/.test(message) ? 404 : 500
    sendJson(response, statusCode, {
      error: message,
    })
  }
})

server.listen(port, host, () => {
  console.log(`control-plane listening on http://${host}:${port}`)
})

process.on("SIGINT", () => {
  server.close(() => db.close())
})

process.on("SIGTERM", () => {
  server.close(() => db.close())
})

function setCommonHeaders(response: import("node:http").ServerResponse) {
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  response.setHeader("access-control-allow-headers", "content-type")
}

function sendJson(response: import("node:http").ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode
  response.end(JSON.stringify(body, null, 2))
}

async function readJsonBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) return {}
  const content = Buffer.concat(chunks).toString("utf8")
  return JSON.parse(content) as Record<string, unknown>
}

function getString(value: string | boolean | undefined) {
  return typeof value === "string" ? value : undefined
}

function getOptionalQuery(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function parsePort(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Expected valid port, received: ${value}`)
  }
  return parsed
}

function asString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseTaskStatus(value: string | undefined) {
  if (!value) return undefined
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled"
  ) {
    return value
  }
  throw new Error(`Unsupported task status: ${value}`)
}

function parseProcessStatus(value: string | undefined) {
  if (!value) return undefined
  if (value === "idle" || value === "assigned" || value === "running" || value === "stopped" || value === "error") {
    return value
  }
  throw new Error(`Unsupported process status: ${value}`)
}

function parseAutomationStatus(value: string | undefined) {
  if (!value) return undefined
  if (value === "active" || value === "paused") {
    return value
  }
  throw new Error(`Unsupported automation status: ${value}`)
}

function summarizeByStatus(tasks: TaskRecord[]) {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1
    return counts
  }, {})
}

function summarizeByPriority(tasks: TaskRecord[]) {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.priority] = (counts[task.priority] ?? 0) + 1
    return counts
  }, {})
}

function summarizeTaskClasses(tasks: TaskRecord[]) {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    const schedulingClass =
      typeof task.metadata?.schedulingClass === "string" && task.metadata.schedulingClass.length > 0
        ? task.metadata.schedulingClass
        : "default"
    counts[schedulingClass] = (counts[schedulingClass] ?? 0) + 1
    return counts
  }, {})
}

function summarizeByProcessStatus(processes: ProcessRecord[]) {
  return processes.reduce<Record<string, number>>((counts, process) => {
    counts[process.status] = (counts[process.status] ?? 0) + 1
    return counts
  }, {})
}

function summarizeTaskPools(tasks: TaskRecord[]) {
  return tasks.reduce<Record<string, number>>((counts, task) => {
    const pool = typeof task.metadata?.processPool === "string" && task.metadata.processPool.length > 0 ? task.metadata.processPool : "default"
    counts[pool] = (counts[pool] ?? 0) + 1
    return counts
  }, {})
}

function summarizeProcessPools(processes: ProcessRecord[]) {
  return processes.reduce<Record<string, number>>((counts, process) => {
    const pool = typeof process.metadata?.processPool === "string" && process.metadata.processPool.length > 0 ? process.metadata.processPool : "default"
    counts[pool] = (counts[pool] ?? 0) + 1
    return counts
  }, {})
}

function summarizeByAutomationStatus(automations: AutomationRecord[]) {
  return automations.reduce<Record<string, number>>((counts, automation) => {
    counts[automation.status] = (counts[automation.status] ?? 0) + 1
    return counts
  }, {})
}

function summarizeByDeliveryStatus(deliveries: GatewayDeliveryRecord[]) {
  return deliveries.reduce<Record<string, number>>((counts, delivery) => {
    counts[delivery.status] = (counts[delivery.status] ?? 0) + 1
    return counts
  }, {})
}

function parsePoolBudgets(value: Record<string, unknown>) {
  const budgets: Record<string, number> = {}
  for (const [pool, rawValue] of Object.entries(value)) {
    if (!pool) continue
    if (typeof rawValue !== "number" || !Number.isInteger(rawValue) || rawValue < 0) {
      throw new Error(`Unsupported pool budget value for ${pool}`)
    }
    budgets[pool] = rawValue
  }
  return budgets
}
