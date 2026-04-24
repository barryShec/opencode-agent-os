#!/usr/bin/env node

import { createServer } from "node:http"
import { parseArgs } from "node:util"
import { ensureConfigLayout, loadConfig } from "@opencode-agent-os/config"
import { GatewayService } from "@opencode-agent-os/gateway-core"
import { MemoryService } from "@opencode-agent-os/memory"
import { RuntimeSupervisor } from "@opencode-agent-os/runtime-supervisor"
import { TaskService } from "@opencode-agent-os/runtime-task"
import { ThreadService } from "@opencode-agent-os/runtime-thread"
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
const threads = new ThreadService(db)
const supervisor = new RuntimeSupervisor(db, tasks)
const gateway = new GatewayService(db, tasks, supervisor)
const memory = new MemoryService(db)

const host = getString(values.host) ?? "127.0.0.1"
const port = parsePort(getString(values.port)) ?? 8787

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
      })
    }

    if (request.method === "GET" && url.pathname === "/threads") {
      return sendJson(response, 200, {
        threads: threads.listThreads(),
      })
    }

    if (request.method === "GET" && segments[0] === "threads" && segments[2] === "tasks") {
      const threadId = decodeURIComponent(segments[1] ?? "")
      return sendJson(response, 200, {
        tasks: tasks.listTasks({ threadId }),
      })
    }

    if (request.method === "GET" && segments[0] === "memory" && segments[1] === "threads" && segments[3] === "recall") {
      const threadId = decodeURIComponent(segments[2] ?? "")
      const keyword = url.searchParams.get("keyword") ?? undefined
      const limit = parsePort(url.searchParams.get("limit") ?? undefined)
      return sendJson(response, 200, memory.recallThread({
        threadId,
        ...(keyword ? { query: keyword } : {}),
        ...(limit ? { limit } : {}),
      }))
    }

    if (request.method === "GET" && segments[0] === "memory" && segments[1] === "threads" && segments[3] === "search") {
      const threadId = decodeURIComponent(segments[2] ?? "")
      const keyword = url.searchParams.get("q")
      if (!keyword) {
        return sendJson(response, 400, { error: "Missing q query parameter" })
      }
      const limit = parsePort(url.searchParams.get("limit") ?? undefined)
      return sendJson(response, 200, memory.searchThread({
        threadId,
        query: keyword,
        ...(limit ? { limit } : {}),
      }))
    }

    if (request.method === "POST" && segments[0] === "memory" && segments[1] === "threads" && segments[3] === "summarize") {
      const threadId = decodeURIComponent(segments[2] ?? "")
      const body = await readJsonBody(request)
      return sendJson(response, 200, memory.summarizeThread({
        threadId,
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
        ...(typeof body.recordArtifact === "boolean" ? { recordArtifact: body.recordArtifact } : {}),
      }))
    }

    if (request.method === "GET" && url.pathname === "/routes") {
      return sendJson(response, 200, {
        routes: gateway.listRoutes({
          ...(asString(url.searchParams.get("channel")) ? { channel: asChannel(url.searchParams.get("channel")) } : {}),
          ...(asString(url.searchParams.get("threadId")) ? { threadId: url.searchParams.get("threadId")! } : {}),
          ...(asString(url.searchParams.get("sessionId")) ? { sessionId: url.searchParams.get("sessionId")! } : {}),
          ...(asString(url.searchParams.get("processId")) ? { processId: url.searchParams.get("processId")! } : {}),
        }),
      })
    }

    if (request.method === "POST" && url.pathname === "/routes") {
      const body = await readJsonBody(request)
      if (!asString(body.channel) || !asString(body.address)) {
        return sendJson(response, 400, { error: "channel and address are required" })
      }

      const route = gateway.createRoute({
        channel: asChannel(body.channel),
        address: body.address,
        ...(asString(body.threadId) ? { threadId: body.threadId } : {}),
        ...(asString(body.sessionId) ? { sessionId: body.sessionId } : {}),
        ...(asString(body.processId) ? { processId: body.processId } : {}),
        ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}),
      })
      return sendJson(response, 201, route)
    }

    if (request.method === "GET" && url.pathname === "/deliveries") {
      return sendJson(response, 200, {
        deliveries: gateway.listDeliveries({
          ...(asString(url.searchParams.get("routeId")) ? { routeId: url.searchParams.get("routeId")! } : {}),
          ...(asString(url.searchParams.get("status")) ? { status: asDeliveryStatus(url.searchParams.get("status")) } : {}),
        }),
      })
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      const body = await readJsonBody(request)
      if (!asString(body.channel) || !asString(body.address) || !asString(body.body)) {
        return sendJson(response, 400, { error: "channel, address, and body are required" })
      }

      const result = await gateway.receiveMessage({
        channel: asChannel(body.channel),
        address: body.address,
        body: body.body,
        ...(asString(body.supervisorOwner) ? { supervisorOwner: body.supervisorOwner } : {}),
      })
      return sendJson(response, 202, result)
    }

    if (request.method === "POST" && url.pathname === "/supervisor/tick") {
      const body = await readJsonBody(request)
      const result = supervisor.scheduleOnce({
        owner: asString(body.owner) ? body.owner : "gateway-supervisor",
        ...(Array.isArray(body.processIds) ? { processIds: body.processIds.filter((item): item is string => typeof item === "string") } : {}),
        ...(Array.isArray(body.preferredTaskIds)
          ? { preferredTaskIds: body.preferredTaskIds.filter((item): item is string => typeof item === "string") }
          : {}),
      })
      return sendJson(response, 200, result)
    }

    sendJson(response, 404, {
      error: "Not found",
      path: url.pathname,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 500, {
      error: message,
    })
  }
})

server.listen(port, host, () => {
  console.log(`gateway listening on http://${host}:${port}`)
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

function asChannel(value: unknown) {
  if (value === "cli" || value === "webhook" || value === "feishu" || value === "slack") {
    return value
  }
  throw new Error(`Unsupported gateway channel: ${String(value)}`)
}

function asDeliveryStatus(value: unknown) {
  if (value === "received" || value === "processed" || value === "failed") {
    return value
  }
  throw new Error(`Unsupported gateway delivery status: ${String(value)}`)
}
