#!/usr/bin/env node

import { parseArgs } from "node:util"
import path from "node:path"
import { AutomationService } from "@opencode-agent-os/automation"
import { ensureConfigLayout, loadConfig } from "@opencode-agent-os/config"
import { createDefaultEvaluatorRegistry } from "@opencode-agent-os/evaluators"
import { ProviderRegistry } from "@opencode-agent-os/provider"
import { AgentProcessService } from "@opencode-agent-os/runtime-process"
import { RunEngine } from "@opencode-agent-os/runtime-runner"
import { SessionService } from "@opencode-agent-os/runtime-session"
import { TaskExecutionCoordinator, TaskService } from "@opencode-agent-os/runtime-task"
import { ThreadService } from "@opencode-agent-os/runtime-thread"
import { AgentOsDatabase } from "@opencode-agent-os/storage"
import { createDefaultToolRegistry } from "@opencode-agent-os/tools"

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    "interval-ms": { type: "string" },
    iterations: { type: "string" },
  },
})

const config = await loadConfig()
await ensureConfigLayout(config)

const db = new AgentOsDatabase(config.dbPath)
db.migrate()

const threads = new ThreadService(db)
const sessions = new SessionService(db)
const tasks = new TaskService(db)
const evaluatorRegistry = createDefaultEvaluatorRegistry()
const providers = ProviderRegistry.fromConfig(config)
const tools = createDefaultToolRegistry()
const taskCoordinator = new TaskExecutionCoordinator(db, tasks, evaluatorRegistry)
const runner = new RunEngine(db, threads, sessions, providers, tools, taskCoordinator)
const processes = new AgentProcessService(db, tasks, runner)
const automations = new AutomationService(db, tasks, processes)

const intervalMs = parsePositiveInt(getString(values["interval-ms"])) ?? config.workers.cronPollMs
const iterations = parsePositiveInt(getString(values.iterations))
const providerName = getString(values.provider) ?? config.defaultProvider
const modelName = getString(values.model) ?? config.defaultModel
const cwd = getString(values.cwd) ? path.resolve(getString(values.cwd)!) : process.cwd()

let shouldStop = false
process.on("SIGINT", () => {
  shouldStop = true
})
process.on("SIGTERM", () => {
  shouldStop = true
})

console.log(`cron worker interval: ${intervalMs}ms`)

let count = 0
while (!shouldStop) {
  const results = await automations.runDueAutomations({
    providerName,
    modelName,
    cwd,
  })

  if (results.length === 0) {
    console.log("[cron] idle")
  } else {
    for (const item of results) {
      console.log(`[cron] ${item.status} ${item.automation.id} (${item.automation.kind})`)
    }
  }

  count += 1
  if (iterations && count >= iterations) break
  await sleep(intervalMs)
}

console.log("[cron] exiting")
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
