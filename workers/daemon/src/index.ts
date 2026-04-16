#!/usr/bin/env node

import { parseArgs } from "node:util"
import path from "node:path"
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
    process: { type: "string" },
    thread: { type: "string" },
    session: { type: "string" },
    owner: { type: "string" },
    label: { type: "string" },
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

const intervalMs = parsePositiveInt(getString(values["interval-ms"])) ?? config.workers.daemonPollMs
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

const processRecord =
  (getString(values.process) ? processes.getProcess(getString(values.process)!) : undefined) ??
  processes.startProcess({
    label: getString(values.label) ?? "daemon-process",
    owner: getString(values.owner) ?? "daemon-worker",
    ...(getString(values.thread) ? { threadId: getString(values.thread)! } : {}),
    ...(getString(values.session) ? { sessionId: getString(values.session)! } : {}),
  })

if (!processRecord) {
  throw new Error("Unable to resolve or create process")
}

console.log(`daemon process: ${processRecord.id}`)
console.log(`poll interval: ${intervalMs}ms`)

let count = 0
while (!shouldStop) {
  const result = await processes.runOnce({
    processId: processRecord.id,
    providerName,
    modelName,
    cwd,
  })

  if (result.claimed) {
    console.log(`[daemon] claimed ${result.claimed.task.id} -> ${result.process.status}`)
  } else {
    console.log("[daemon] idle")
  }

  count += 1
  if (iterations && count >= iterations) break
  await sleep(intervalMs)
}

console.log("[daemon] exiting")
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
