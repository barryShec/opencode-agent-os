import type { EvaluatorResultRecord, RunRecord, TaskRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

export interface EvaluatorContext {
  task: TaskRecord
  latestRun?: RunRecord
  runs: RunRecord[]
  options?: Record<string, unknown>
}

export interface EvaluatorDefinition {
  name: string
  description: string
  evaluate(context: EvaluatorContext): Promise<{
    decision: EvaluatorResultRecord["decision"]
    summary: string
    score?: number | null
    evidence?: string | null
    metadata?: EvaluatorResultRecord["metadata"]
  }>
}

export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, EvaluatorDefinition>()

  register(definition: EvaluatorDefinition) {
    this.evaluators.set(definition.name, definition)
  }

  get(name: string) {
    const evaluator = this.evaluators.get(name)
    if (!evaluator) {
      throw new Error(`Unknown evaluator: ${name}`)
    }
    return evaluator
  }

  list() {
    return Array.from(this.evaluators.values()).map((item) => ({
      name: item.name,
      description: item.description,
    }))
  }
}

export function createDefaultEvaluatorRegistry() {
  const registry = new EvaluatorRegistry()

  registry.register({
    name: "task-has-run",
    description: "Passes when the task has at least one attached run.",
    async evaluate(context) {
      if (context.latestRun) {
        return {
          decision: "pass",
          summary: "Task has at least one run attached.",
          score: 1,
          evidence: context.latestRun.id,
        }
      }
      return {
        decision: "fail",
        summary: "Task has no recorded runs yet.",
        score: 0,
        evidence: null,
      }
    },
  })

  registry.register({
    name: "run-output-nonempty",
    description: "Passes when the latest run has non-empty output.",
    async evaluate(context) {
      const output = context.latestRun?.outputText?.trim()
      if (!context.latestRun) {
        return {
          decision: "fail",
          summary: "No run is available to evaluate.",
          score: 0,
        }
      }
      if (output) {
        return {
          decision: "pass",
          summary: "Latest run produced non-empty output.",
          score: 1,
          evidence: output.slice(0, 200),
        }
      }
      return {
        decision: "fail",
        summary: "Latest run output is empty.",
        score: 0,
      }
    },
  })

  registry.register({
    name: "run-output-contains",
    description: "Checks whether the latest run output contains a required keyword.",
    async evaluate(context) {
      const keyword = String(context.options?.keyword ?? "").trim()
      const output = context.latestRun?.outputText ?? ""
      if (!keyword) {
        return {
          decision: "warn",
          summary: "No keyword was provided; evaluator ran in warning mode.",
          score: null,
        }
      }
      if (!context.latestRun) {
        return {
          decision: "fail",
          summary: "No run is available to evaluate.",
          score: 0,
        }
      }
      if (output.includes(keyword)) {
        return {
          decision: "pass",
          summary: `Latest run output contains keyword '${keyword}'.`,
          score: 1,
          evidence: keyword,
        }
      }
      return {
        decision: "fail",
        summary: `Latest run output does not contain keyword '${keyword}'.`,
        score: 0,
        evidence: output.slice(0, 200),
      }
    },
  })

  registry.register({
    name: "task-status-completed",
    description: "Passes when the task status is completed.",
    async evaluate(context) {
      if (context.task.status === "completed") {
        return {
          decision: "pass",
          summary: "Task status is completed.",
          score: 1,
        }
      }
      return {
        decision: "warn",
        summary: `Task status is ${context.task.status}, not completed.`,
        score: null,
      }
    },
  })

  return registry
}

export class EvaluatorService {
  constructor(private readonly db: AgentOsDatabase, private readonly registry: EvaluatorRegistry) {}

  listEvaluators() {
    return this.registry.list()
  }

  listResults(input: { taskId?: string; runId?: string } = {}) {
    return this.db.listEvaluatorResults(input)
  }

  async evaluateTask(input: { taskId: string; evaluatorName: string; runId?: string; options?: Record<string, unknown> }) {
    const task = this.db.getTask(input.taskId)
    if (!task) {
      throw new Error(`Unknown task: ${input.taskId}`)
    }

    const runs = this.db.listRuns({ taskId: input.taskId })
    const latestRun = input.runId ? this.db.getRun(input.runId) ?? runs[0] : runs[0]
    const evaluator = this.registry.get(input.evaluatorName)
    const result = await evaluator.evaluate({
      task,
      runs,
      ...(latestRun ? { latestRun } : {}),
      ...(input.options ? { options: input.options } : {}),
    })

    const record = this.db.createEvaluatorResult({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      taskId: task.id,
      runId: latestRun?.id ?? null,
      evaluatorName: evaluator.name,
      decision: result.decision,
      summary: result.summary,
      score: result.score ?? null,
      evidence: result.evidence ?? null,
      metadata: result.metadata ?? null,
    })

    this.db.recordEvent({
      threadId: task.threadId,
      sessionId: task.sessionId ?? null,
      runId: latestRun?.id ?? null,
      type: "evaluator.result.created",
      payload: {
        taskId: task.id,
        evaluatorName: evaluator.name,
        decision: record.decision,
      },
    })

    return {
      task,
      latestRun: latestRun ?? null,
      result: record,
    }
  }
}
