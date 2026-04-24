#!/usr/bin/env node

import { parseArgs } from "node:util"
import { ensureConfigLayout, loadConfig } from "@opencode-agent-os/config"
import { RuntimeJanitor } from "@opencode-agent-os/runtime-janitor"
import { TaskService } from "@opencode-agent-os/runtime-task"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    owner: { type: "string" },
    "interval-ms": { type: "string" },
    iterations: { type: "string" },
    "stale-process-ms": { type: "string" },
    "stale-run-ms": { type: "string" },
    "automation-failure-streak": { type: "string" },
  },
})

const config = await loadConfig()
await ensureConfigLayout(config)

const db = new AgentOsDatabase(config.dbPath)
db.migrate()

const tasks = new TaskService(db)
const janitor = new RuntimeJanitor(db, tasks)

const intervalMs = parsePositiveInt(getString(values["interval-ms"])) ?? config.workers.janitorPollMs
const iterations = parsePositiveInt(getString(values.iterations))
const staleProcessMs = parsePositiveInt(getString(values["stale-process-ms"]))
const staleRunMs = parsePositiveInt(getString(values["stale-run-ms"]))
const automationFailureStreakLimit = parsePositiveInt(getString(values["automation-failure-streak"]))
const owner = getString(values.owner) ?? "janitor-worker"

let shouldStop = false
process.on("SIGINT", () => {
  shouldStop = true
})
process.on("SIGTERM", () => {
  shouldStop = true
})

console.log(`janitor owner: ${owner}`)
console.log(`poll interval: ${intervalMs}ms`)

let count = 0
while (!shouldStop) {
  const result = janitor.runOnce({
    owner,
    ...(staleProcessMs ? { staleProcessMs } : {}),
    ...(staleRunMs ? { staleRunMs } : {}),
    ...(automationFailureStreakLimit ? { automationFailureStreakLimit } : {}),
  })

  if (
    result.staleProcesses.length === 0 &&
    result.recoveredTasks.length === 0 &&
    result.failedRuns.length === 0 &&
    result.pausedAutomations.length === 0
  ) {
    console.log("[janitor] idle")
  } else {
    for (const item of result.staleProcesses) {
      console.log(`[janitor] process ${item.processId} -> ${item.status} (${item.reason})`)
    }
    for (const item of result.recoveredTasks) {
      console.log(`[janitor] task ${item.taskId} -> ${item.action}/${item.status} (${item.reason})`)
    }
    for (const item of result.failedRuns) {
      console.log(`[janitor] run ${item.runId} failed (${item.reason})`)
    }
    for (const item of result.pausedAutomations) {
      console.log(`[janitor] automation ${item.automationId} paused (${item.reason})`)
    }
  }

  count += 1
  if (iterations && count >= iterations) break
  await sleep(intervalMs)
}

console.log("[janitor] exiting")
db.close()

function getString(value: string | boolean | undefined) {
  return typeof value === "string" ? value : undefined
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
