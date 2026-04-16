#!/usr/bin/env node

import { parseArgs } from "node:util"
import { ensureConfigLayout, loadConfig } from "@opencode-agent-os/config"
import { RuntimeSupervisor } from "@opencode-agent-os/runtime-supervisor"
import { TaskService } from "@opencode-agent-os/runtime-task"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    owner: { type: "string" },
    process: { type: "string", multiple: true },
    "interval-ms": { type: "string" },
    iterations: { type: "string" },
  },
})

const config = await loadConfig()
await ensureConfigLayout(config)

const db = new AgentOsDatabase(config.dbPath)
db.migrate()

const tasks = new TaskService(db)
const supervisor = new RuntimeSupervisor(db, tasks)

const intervalMs = parsePositiveInt(getString(values["interval-ms"])) ?? config.workers.supervisorPollMs
const iterations = parsePositiveInt(getString(values.iterations))
const owner = getString(values.owner) ?? "supervisor-worker"
const processIds = toStringArray(values.process)

let shouldStop = false
process.on("SIGINT", () => {
  shouldStop = true
})
process.on("SIGTERM", () => {
  shouldStop = true
})

console.log(`supervisor owner: ${owner}`)
console.log(`poll interval: ${intervalMs}ms`)

let count = 0
while (!shouldStop) {
  const result = supervisor.scheduleOnce({
    owner,
    ...(processIds.length > 0 ? { processIds } : {}),
  })

  if (result.assignments.length === 0 && result.reclaimed.length === 0) {
    console.log("[supervisor] idle")
  } else {
    for (const item of result.assignments) {
      console.log(`[supervisor] assigned ${item.task.task.id} -> ${item.process.id}`)
    }
    for (const taskId of result.reclaimed) {
      console.log(`[supervisor] reclaimed ${taskId}`)
    }
  }

  count += 1
  if (iterations && count >= iterations) break
  await sleep(intervalMs)
}

console.log("[supervisor] exiting")
db.close()

function getString(value: string | boolean | string[] | undefined) {
  return typeof value === "string" ? value : undefined
}

function toStringArray(value: string | boolean | Array<string | boolean> | undefined) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0)
  if (typeof value === "string" && value.length > 0) return [value]
  return []
}

function parsePositiveInt(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received: ${value}`)
  }
  return parsed
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
