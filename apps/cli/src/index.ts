#!/usr/bin/env node

import { parseArgs } from "node:util"
import path from "node:path"
import readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { AutomationService } from "@opencode-agent-os/automation"
import { ensureConfigLayout, loadConfig } from "@opencode-agent-os/config"
import { EvaluatorService, createDefaultEvaluatorRegistry } from "@opencode-agent-os/evaluators"
import { GatewayService } from "@opencode-agent-os/gateway-core"
import { ProviderRegistry } from "@opencode-agent-os/provider"
import { AgentProcessService } from "@opencode-agent-os/runtime-process"
import { RunEngine } from "@opencode-agent-os/runtime-runner"
import { SessionService, type ApprovalDecision } from "@opencode-agent-os/runtime-session"
import { TaskExecutionCoordinator, TaskService } from "@opencode-agent-os/runtime-task"
import { ThreadService } from "@opencode-agent-os/runtime-thread"
import { AgentOsDatabase } from "@opencode-agent-os/storage"
import { createDefaultToolRegistry } from "@opencode-agent-os/tools"

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      title: { type: "string" },
      label: { type: "string" },
      summary: { type: "string" },
      channel: { type: "string" },
      address: { type: "string" },
      thread: { type: "string" },
      session: { type: "string" },
      process: { type: "string" },
      snapshot: { type: "string" },
      prompt: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      mode: { type: "string" },
      task: { type: "string" },
      tool: { type: "string" },
      name: { type: "string" },
      args: { type: "string" },
      cwd: { type: "string" },
      root: { type: "string" },
      description: { type: "string" },
      keyword: { type: "string" },
      priority: { type: "string" },
      "interval-seconds": { type: "string" },
      "max-attempts": { type: "string" },
      "evaluator-gate": { type: "string" },
      "lease-ms": { type: "string" },
      "depends-on": { type: "string" },
      status: { type: "string" },
      result: { type: "string" },
      error: { type: "string" },
      owner: { type: "string" },
      "parent-task": { type: "string" },
      "auto-approve": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  const [scope, action, target] = positionals
  if (values.help || !scope) {
    printHelp()
    return
  }

  const config = await loadConfig()
  await ensureConfigLayout(config)

  const db = new AgentOsDatabase(config.dbPath)
  db.migrate()

  const threads = new ThreadService(db)
  const sessions = new SessionService(db)
  const tasks = new TaskService(db)
  const evaluatorRegistry = createDefaultEvaluatorRegistry()
  const evaluators = new EvaluatorService(db, evaluatorRegistry)
  const providers = ProviderRegistry.fromConfig(config)
  const tools = createDefaultToolRegistry()
  const taskCoordinator = new TaskExecutionCoordinator(db, tasks, evaluatorRegistry)
  const runner = new RunEngine(db, threads, sessions, providers, tools, taskCoordinator)
  const processes = new AgentProcessService(db, tasks, runner)
  const automations = new AutomationService(db, tasks, processes)
  const gateway = new GatewayService(db, tasks, processes)

  try {
    switch (`${scope}:${action ?? ""}:${target ?? ""}`) {
      case "init::":
        console.log(`Initialized data dir: ${config.dataDir}`)
        console.log(`Database path: ${config.dbPath}`)
        console.log(`Providers: ${providers.list().join(", ")}`)
        return

      case "thread:create:": {
        const title = getString(values.title) ?? "New thread"
        const thread = threads.createThread({ title })
        console.log(thread.id)
        return
      }

      case "thread:list:": {
        const list = threads.listThreads()
        for (const item of list) {
          console.log(`${item.id}\t${item.status}\t${item.title}`)
        }
        return
      }

      case "session:create:": {
        const threadId = getRequiredString(values.thread, "--thread is required")
        const title = getString(values.title) ?? null
        const mode = parseMode(getString(values.mode))

        if (!threadId) {
          throw new Error("--thread is required")
        }
        const session = sessions.createSession({
          threadId,
          mode,
          title,
        })
        console.log(session.id)
        return
      }

      case "session:list:": {
        const threadId = getString(values.thread)
        const list = sessions.listSessions({
          ...(threadId ? { threadId } : {}),
        })
        for (const item of list) {
          console.log(`${item.id}\t${item.threadId}\t${item.mode}\t${item.status}\t${item.title ?? ""}`)
        }
        return
      }

      case "session:workspace:bind": {
        const sessionId = getRequiredString(values.session, "--session is required")
        const rootPath = getRequiredString(values.root, "--root is required")
        const workspace = await sessions.bindWorkspace({
          sessionId,
          rootPath,
        })
        console.log(JSON.stringify(workspace, null, 2))
        return
      }

      case "session:workspace:show": {
        const sessionId = getRequiredString(values.session, "--session is required")
        const workspace = sessions.getWorkspace(sessionId)
        if (!workspace) {
          throw new Error(`No workspace bound to session: ${sessionId}`)
        }
        console.log(JSON.stringify(workspace, null, 2))
        return
      }

      case "session:snapshot:create": {
        const sessionId = getRequiredString(values.session, "--session is required")
        const label = getRequiredString(values.label, "--label is required")
        const summary = getString(values.summary)
        const snapshot = await sessions.captureSnapshot({
          sessionId,
          label,
          ...(summary ? { summary } : {}),
        })
        console.log(JSON.stringify(snapshot, null, 2))
        return
      }

      case "session:snapshot:list": {
        const sessionId = getRequiredString(values.session, "--session is required")
        const list = sessions.listSnapshots(sessionId)
        for (const item of list) {
          console.log(`${item.id}\t${item.label}\t${item.rootPath}\t${item.createdAt}`)
        }
        return
      }

      case "session:snapshot:restore": {
        const sessionId = getRequiredString(values.session, "--session is required")
        const snapshotId = getRequiredString(values.snapshot, "--snapshot is required")
        const result = sessions.restoreSnapshot({
          sessionId,
          snapshotId,
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }

      case "task:create:": {
        const threadId = getRequiredString(values.thread, "--thread is required")
        const title = getRequiredString(values.title, "--title is required")
        const sessionId = getString(values.session)
        const description = getString(values.description) ?? null
        const parentTaskId = getString(values["parent-task"]) ?? null
        const priority = parsePriority(getString(values.priority))
        const dependsOn = parseCommaList(getString(values["depends-on"]))
        const maxAttempts = parsePositiveInt(getString(values["max-attempts"]), "--max-attempts must be a positive integer")
        const evaluatorGate = parseEvaluatorGate(getString(values["evaluator-gate"]))

        const result = tasks.createTask({
          threadId,
          ...(sessionId ? { sessionId } : {}),
          ...(parentTaskId ? { parentTaskId } : {}),
          title,
          description,
          priority,
          dependsOn,
          ...(maxAttempts ? { maxAttempts } : {}),
          ...(evaluatorGate ? { evaluatorGate } : {}),
        })
        console.log(result.task.id)
        return
      }

      case "task:list:": {
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const status = parseTaskStatus(getString(values.status))
        const list = tasks.listTasks({
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(status ? { status } : {}),
        })

        for (const item of list) {
          const deps = item.dependencies.map((edge) => edge.dependsOnTaskId).join(",")
          console.log(
            `${item.task.id}\t${item.task.threadId}\t${item.task.status}\t${item.task.priority}\t${item.task.attempts}/${item.task.maxAttempts}\t${item.task.leaseOwner ?? ""}\t${item.task.title}\t${deps}`,
          )
        }
        return
      }

      case "task:ready:": {
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const list = tasks.listReadyTasks({
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
        })

        for (const item of list) {
          console.log(
            `${item.task.id}\t${item.task.status}\t${item.task.priority}\t${item.task.attempts}/${item.task.maxAttempts}\t${item.task.title}`,
          )
        }
        return
      }

      case "task:show:": {
        const taskId = getRequiredString(values.task, "--task is required")
        const result = tasks.getTask(taskId)
        if (!result) {
          throw new Error(`Unknown task: ${taskId}`)
        }
        console.log(JSON.stringify(result, null, 2))
        return
      }

      case "task:start:": {
        const taskId = getRequiredString(values.task, "--task is required")
        const owner = getString(values.owner)
        const result = tasks.startTask({
          taskId,
          ...(owner ? { owner } : {}),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }

      case "task:set-status:": {
        const taskId = getRequiredString(values.task, "--task is required")
        const status = parseTaskStatus(getRequiredString(values.status, "--status is required"))
        const owner = getString(values.owner)
        const resultText = getString(values.result)
        const errorText = getString(values.error)

        if (!status) {
          throw new Error("--status is required")
        }

        const result = tasks.setTaskStatus({
          taskId,
          status,
          ...(owner ? { owner } : {}),
          ...(resultText ? { resultText } : {}),
          ...(errorText ? { errorText } : {}),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }

      case "task:claim:": {
        const owner = getRequiredString(values.owner, "--owner is required")
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const leaseMs = parsePositiveInt(getString(values["lease-ms"]), "--lease-ms must be a positive integer")
        const claimed = tasks.claimReadyTask({
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          owner,
          ...(leaseMs ? { leaseMs } : {}),
        })
        if (!claimed) {
          console.log("(none)")
          return
        }
        console.log(JSON.stringify(claimed, null, 2))
        return
      }

      case "task:release:": {
        const taskId = getRequiredString(values.task, "--task is required")
        const owner = getString(values.owner)
        const released = tasks.releaseTaskLease({
          taskId,
          ...(owner ? { owner } : {}),
        })
        console.log(JSON.stringify(released, null, 2))
        return
      }

      case "task:retry:": {
        const taskId = getRequiredString(values.task, "--task is required")
        const errorText = getString(values.error)
        const result = tasks.retryTask({
          taskId,
          ...(errorText ? { errorText } : {}),
          incrementRepairCount: true,
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }

      case "run:prompt:": {
        const prompt = getRequiredString(values.prompt, "--prompt is required")
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const taskId = getString(values.task)
        const providerName = getString(values.provider) ?? config.defaultProvider
        const modelName = getString(values.model) ?? config.defaultModel

        if (!prompt) {
          throw new Error("--prompt is required")
        }
        const result = await runner.runPrompt({
          prompt,
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(taskId ? { taskId } : {}),
          providerName,
          modelName,
        })
        console.log(`thread: ${result.thread.id}`)
        console.log(`session: ${result.session.id}`)
        console.log(`run: ${result.runId}`)
        console.log("")
        console.log(result.output)
        return
      }

      case "tool:exec:": {
        const sessionId = getRequiredString(values.session, "--session is required")
        const toolName = getRequiredString(values.tool, "--tool is required")
        const taskId = getString(values.task)
        const rawArgs = getString(values.args)
        const cwdArg = getString(values.cwd)

        if (!sessionId) {
          throw new Error("--session is required")
        }
        if (!toolName) {
          throw new Error("--tool is required")
        }
        const parsedArgs = rawArgs ? JSON.parse(rawArgs) : {}
        const cwd = cwdArg ? path.resolve(cwdArg) : process.cwd()
        const result = await runner.executeTool({
          sessionId,
          ...(taskId ? { taskId } : {}),
          toolName,
          args: parsedArgs,
          cwd,
          approvalHandler: values["auto-approve"] ? () => Promise.resolve("allow-once") : promptApproval,
        })
        console.log(`thread: ${result.thread.id}`)
        console.log(`session: ${result.session.id}`)
        console.log(`run: ${result.runId}`)
        console.log(`title: ${result.result.title}`)
        console.log("")
        console.log(result.result.output)
        return
      }

      case "evaluator:list:": {
        const list = evaluators.listEvaluators()
        for (const item of list) {
          console.log(`${item.name}\t${item.description}`)
        }
        return
      }

      case "evaluator:run:": {
        const taskId = getRequiredString(values.task, "--task is required")
        const evaluatorName = getRequiredString(values.name, "--name is required")
        const keyword = getString(values.keyword)

        const result = await evaluators.evaluateTask({
          taskId,
          evaluatorName,
          ...(keyword ? { options: { keyword } } : {}),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }

      case "evaluator:results:": {
        const taskId = getString(values.task)
        const list = evaluators.listResults({
          ...(taskId ? { taskId } : {}),
        })
        for (const item of list) {
          console.log(`${item.id}\t${item.taskId}\t${item.evaluatorName}\t${item.decision}\t${item.summary}`)
        }
        return
      }

      case "automation:create:process-run-once": {
        const processId = getRequiredString(values.process, "--process is required")
        const label = getString(values.label) ?? "process-run-once"
        const intervalSeconds = parsePositiveInt(
          getRequiredString(values["interval-seconds"], "--interval-seconds is required"),
          "--interval-seconds must be a positive integer",
        )
        const providerName = getString(values.provider)
        const modelName = getString(values.model)
        const cwd = getString(values.cwd)
        const automation = automations.createAutomation({
          label,
          kind: "process-run-once",
          processId,
          intervalSeconds: intervalSeconds!,
          metadata: {
            ...(providerName ? { providerName } : {}),
            ...(modelName ? { modelName } : {}),
            ...(cwd ? { cwd: path.resolve(cwd) } : {}),
          },
        })
        console.log(automation.id)
        return
      }

      case "automation:create:task-prompt": {
        const label = getString(values.label) ?? "task-prompt"
        const intervalSeconds = parsePositiveInt(
          getRequiredString(values["interval-seconds"], "--interval-seconds is required"),
          "--interval-seconds must be a positive integer",
        )
        const prompt = getRequiredString(values.prompt, "--prompt is required")
        const title = getString(values.title)
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const processId = getString(values.process)
        if (!threadId && !sessionId) {
          throw new Error("--thread or --session is required")
        }
        const automation = automations.createAutomation({
          label,
          kind: "task-prompt",
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(processId ? { processId } : {}),
          intervalSeconds: intervalSeconds!,
          metadata: {
            prompt,
            ...(title ? { title } : {}),
          },
        })
        console.log(automation.id)
        return
      }

      case "automation:list:": {
        const status = parseAutomationStatus(getString(values.status))
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const processId = getString(values.process)
        const list = automations.listAutomations({
          ...(status ? { status } : {}),
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(processId ? { processId } : {}),
        })
        for (const item of list) {
          console.log(
            `${item.id}\t${item.kind}\t${item.status}\t${item.intervalSeconds}s\t${item.nextRunAt}\t${item.processId ?? ""}\t${item.label}`,
          )
        }
        return
      }

      case "automation:pause:": {
        const automationId = getRequiredString(values.name, "--name is required")
        const automation = automations.pauseAutomation(automationId)
        console.log(JSON.stringify(automation, null, 2))
        return
      }

      case "automation:resume:": {
        const automationId = getRequiredString(values.name, "--name is required")
        const automation = automations.resumeAutomation(automationId)
        console.log(JSON.stringify(automation, null, 2))
        return
      }

      case "automation:run-due:": {
        const providerName = getString(values.provider) ?? config.defaultProvider
        const modelName = getString(values.model) ?? config.defaultModel
        const cwd = getString(values.cwd)
        const results = await automations.runDueAutomations({
          providerName,
          modelName,
          ...(cwd ? { cwd: path.resolve(cwd) } : {}),
        })
        console.log(JSON.stringify(results, null, 2))
        return
      }

      case "gateway:route:create": {
        const channel = parseGatewayChannel(getRequiredString(values.channel, "--channel is required"))
        if (!channel) {
          throw new Error("--channel is required")
        }
        const address = getRequiredString(values.address, "--address is required")
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const processId = getString(values.process)
        if (!threadId && !sessionId && !processId) {
          throw new Error("--thread, --session, or --process is required")
        }
        const route = gateway.createRoute({
          channel,
          address,
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(processId ? { processId } : {}),
          metadata: {
            autoDispatch: Boolean(processId),
          },
        })
        console.log(route.id)
        return
      }

      case "gateway:route:list": {
        const channel = parseGatewayChannel(getString(values.channel))
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const processId = getString(values.process)
        const list = gateway.listRoutes({
          ...(channel ? { channel } : {}),
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(processId ? { processId } : {}),
        })
        for (const item of list) {
          console.log(
            `${item.id}\t${item.channel}\t${item.address}\t${item.threadId ?? ""}\t${item.sessionId ?? ""}\t${item.processId ?? ""}`,
          )
        }
        return
      }

      case "gateway:send:": {
        const channel = parseGatewayChannel(getRequiredString(values.channel, "--channel is required"))
        if (!channel) {
          throw new Error("--channel is required")
        }
        const address = getRequiredString(values.address, "--address is required")
        const prompt = getRequiredString(values.prompt, "--prompt is required")
        const providerName = getString(values.provider) ?? config.defaultProvider
        const modelName = getString(values.model) ?? config.defaultModel
        const cwd = getString(values.cwd)
        const result = await gateway.receiveMessage({
          channel,
          address,
          body: prompt,
          providerName,
          modelName,
          ...(cwd ? { cwd: path.resolve(cwd) } : {}),
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }

      case "gateway:deliveries:": {
        const routeId = getString(values.name)
        const status = parseGatewayDeliveryStatus(getString(values.status))
        const list = gateway.listDeliveries({
          ...(routeId ? { routeId } : {}),
          ...(status ? { status } : {}),
        })
        for (const item of list) {
          console.log(`${item.id}\t${item.routeId}\t${item.direction}\t${item.status}\t${item.body}`)
        }
        return
      }

      case "process:start:": {
        const owner = getRequiredString(values.owner, "--owner is required")
        const label = getString(values.label) ?? "default-process"
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const processRecord = processes.startProcess({
          label,
          owner,
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
        })
        console.log(processRecord.id)
        return
      }

      case "process:list:": {
        const threadId = getString(values.thread)
        const sessionId = getString(values.session)
        const list = processes.listProcesses({
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { sessionId } : {}),
        })
        for (const item of list) {
          console.log(
            `${item.id}\t${item.status}\t${item.owner}\t${item.threadId ?? ""}\t${item.sessionId ?? ""}\t${item.activeTaskId ?? ""}\t${item.label}`,
          )
        }
        return
      }

      case "process:heartbeat:": {
        const processId = getRequiredString(values.process, "--process is required")
        const status = parseProcessStatus(getString(values.status))
        const activeTaskId = getString(values.task)
        const processRecord = processes.heartbeat(processId, {
          ...(status ? { status } : {}),
          ...(activeTaskId !== undefined ? { activeTaskId } : {}),
        })
        console.log(JSON.stringify(processRecord, null, 2))
        return
      }

      case "process:stop:": {
        const processId = getRequiredString(values.process, "--process is required")
        const processRecord = processes.stopProcess(processId)
        console.log(JSON.stringify(processRecord, null, 2))
        return
      }

      case "process:run-once:": {
        const processId = getRequiredString(values.process, "--process is required")
        const providerName = getString(values.provider) ?? config.defaultProvider
        const modelName = getString(values.model) ?? config.defaultModel
        const leaseMs = parsePositiveInt(getString(values["lease-ms"]), "--lease-ms must be a positive integer")
        const cwd = getString(values.cwd)
        const result = await processes.runOnce({
          processId,
          providerName,
          modelName,
          ...(cwd ? { cwd: path.resolve(cwd) } : {}),
          ...(leaseMs ? { leaseMs } : {}),
          approvalHandler: values["auto-approve"] ? () => Promise.resolve("allow-once") : promptApproval,
        })
        console.log(JSON.stringify(result, null, 2))
        return
      }

      default:
        printHelp()
    }
  } finally {
    db.close()
  }
}

function parseMode(value: string | undefined) {
  if (!value) return "build"
  if (value === "build" || value === "plan" || value === "general") return value
  throw new Error(`Unsupported session mode: ${value}`)
}

function parsePriority(value: string | undefined) {
  if (!value) return "normal"
  if (value === "low" || value === "normal" || value === "high") return value
  throw new Error(`Unsupported task priority: ${value}`)
}

function parseTaskStatus(value: string | undefined) {
  if (!value) return undefined
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "blocked") {
    return value
  }
  throw new Error(`Unsupported task status: ${value}`)
}

function parseEvaluatorGate(value: string | undefined) {
  if (!value) return undefined
  if (value === "none" || value === "required") return value
  throw new Error(`Unsupported evaluator gate: ${value}`)
}

function parseProcessStatus(value: string | undefined) {
  if (!value) return undefined
  if (value === "idle" || value === "running" || value === "stopped" || value === "error") return value
  throw new Error(`Unsupported process status: ${value}`)
}

function parseAutomationStatus(value: string | undefined) {
  if (!value) return undefined
  if (value === "active" || value === "paused") return value
  throw new Error(`Unsupported automation status: ${value}`)
}

function parseGatewayChannel(value: string | undefined) {
  if (!value) return undefined
  if (value === "cli" || value === "webhook" || value === "feishu" || value === "slack") return value
  throw new Error(`Unsupported gateway channel: ${value}`)
}

function parseGatewayDeliveryStatus(value: string | undefined) {
  if (!value) return undefined
  if (value === "received" || value === "processed" || value === "failed") return value
  throw new Error(`Unsupported gateway delivery status: ${value}`)
}

function parsePositiveInt(value: string | undefined, message: string) {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(message)
  }
  return parsed
}

function parseCommaList(value: string | undefined) {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function getString(value: string | boolean | undefined) {
  return typeof value === "string" ? value : undefined
}

function getRequiredString(value: string | boolean | undefined, message: string) {
  const result = getString(value)
  if (!result) throw new Error(message)
  return result
}

async function promptApproval(inputData: { resource: string }): Promise<ApprovalDecision> {
  const rl = readline.createInterface({ input, output })
  try {
    const answer = (
      await rl.question(`Permission required for ${inputData.resource}. Allow [o]nce, [a]lways, or [n]o? `)
    )
      .trim()
      .toLowerCase()

    if (answer === "a" || answer === "always") return "allow-always"
    if (answer === "o" || answer === "once" || answer === "y" || answer === "yes") return "allow-once"
    return "deny"
  } finally {
    rl.close()
  }
}

function printHelp() {
  console.log(`oaos - opencode-agent-os Phase 4 CLI

Commands:
  oaos init
  oaos thread create --title "My thread"
  oaos thread list
  oaos session create --thread <threadId> [--mode build|plan|general] [--title "..."]
  oaos session list [--thread <threadId>]
  oaos session workspace bind --session <sessionId> --root <path>
  oaos session workspace show --session <sessionId>
  oaos session snapshot create --session <sessionId> --label "..."
  oaos session snapshot list --session <sessionId>
  oaos session snapshot restore --session <sessionId> --snapshot <snapshotId>
  oaos task create --thread <threadId> --title "..." [--session <sessionId>] [--priority low|normal|high] [--depends-on task1,task2] [--max-attempts 3] [--evaluator-gate required|none]
  oaos task list [--thread <threadId>] [--session <sessionId>] [--status pending|running|completed|failed|blocked]
  oaos task ready [--thread <threadId>] [--session <sessionId>]
  oaos task show --task <taskId>
  oaos task start --task <taskId> [--owner "..."]
  oaos task set-status --task <taskId> --status pending|running|completed|failed|blocked [--result "..."] [--error "..."]
  oaos task claim [--thread <threadId>] [--session <sessionId>] --owner "process-1" [--lease-ms 300000]
  oaos task release --task <taskId> [--owner "..."]
  oaos task retry --task <taskId> [--error "..."]
  oaos run prompt --prompt "..." [--thread <threadId> | --session <sessionId>] [--task <taskId>] [--provider mock] [--model mock/default]
  oaos tool exec --session <sessionId> --tool <toolName> [--task <taskId>] [--args '{"key":"value"}'] [--auto-approve]
  oaos evaluator list
  oaos evaluator run --task <taskId> --name <evaluatorName> [--keyword "..."]
  oaos evaluator results [--task <taskId>]
  oaos automation create process-run-once --process <processId> --interval-seconds 60 [--label "..."] [--provider mock] [--model mock/default]
  oaos automation create task-prompt [--thread <threadId> | --session <sessionId>] --interval-seconds 60 --prompt "..." [--process <processId>] [--title "..."] [--label "..."]
  oaos automation list [--status active|paused] [--thread <threadId>] [--session <sessionId>] [--process <processId>]
  oaos automation pause --name <automationId>
  oaos automation resume --name <automationId>
  oaos automation run-due [--provider mock] [--model mock/default] [--cwd /path]
  oaos gateway route create --channel cli|webhook|feishu|slack --address <address> [--thread <threadId> | --session <sessionId> | --process <processId>]
  oaos gateway route list [--channel cli|webhook|feishu|slack]
  oaos gateway send --channel cli|webhook|feishu|slack --address <address> --prompt "..." [--provider mock] [--model mock/default]
  oaos gateway deliveries [--name <routeId>] [--status received|processed|failed]
  oaos process start [--thread <threadId>] [--session <sessionId>] --owner "runner" [--label "default-process"]
  oaos process list [--thread <threadId>] [--session <sessionId>]
  oaos process heartbeat --process <processId> [--status idle|running|stopped|error] [--task <taskId>]
  oaos process stop --process <processId>
  oaos process run-once --process <processId> [--provider mock] [--model mock/default] [--lease-ms 300000] [--auto-approve]
`)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
