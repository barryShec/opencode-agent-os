import { ProviderRegistry } from "@opencode-agent-os/provider"
import { SessionService, type ApprovalHandler } from "@opencode-agent-os/runtime-session"
import { ThreadService } from "@opencode-agent-os/runtime-thread"
import { AgentOsDatabase } from "@opencode-agent-os/storage"
import { ToolRegistry } from "@opencode-agent-os/tools"

export interface RunLifecycleHooks {
  onRunStarted?(input: {
    taskId: string
    runId: string
    threadId: string
    sessionId: string
    type: "prompt" | "tool"
  }): Promise<void> | void
  onRunCompleted?(input: {
    taskId: string
    runId: string
    threadId: string
    sessionId: string
    type: "prompt" | "tool"
  }): Promise<void> | void
  onRunFailed?(input: {
    taskId: string
    runId: string
    threadId: string
    sessionId: string
    type: "prompt" | "tool"
    errorText: string
  }): Promise<void> | void
}

export class RunEngine {
  constructor(
    private readonly db: AgentOsDatabase,
    private readonly threads: ThreadService,
    private readonly sessions: SessionService,
    private readonly providers: ProviderRegistry,
    private readonly tools: ToolRegistry,
    private readonly hooks?: RunLifecycleHooks,
  ) {}

  async runPrompt(input: {
    prompt: string
    threadId?: string
    sessionId?: string
    taskId?: string
    providerName: string
    modelName: string
    systemPrompt?: string
  }) {
    const { thread, session } = this.resolveThreadAndSession(input)

    this.db.appendMessage({
      sessionId: session.id,
      role: "user",
      content: input.prompt,
    })

    const run = this.db.createRun({
      threadId: thread.id,
      sessionId: session.id,
      taskId: input.taskId ?? null,
      type: "prompt",
      status: "running",
      providerName: input.providerName,
      modelName: input.modelName,
      toolName: null,
      inputText: input.prompt,
      outputText: null,
      errorText: null,
      metadata: null,
    })

    this.db.recordEvent({
      threadId: thread.id,
      sessionId: session.id,
      runId: run.id,
      type: "run.started",
      payload: {
        kind: "prompt",
        providerName: input.providerName,
        modelName: input.modelName,
        taskId: input.taskId ?? null,
      },
    })

    if (input.taskId) {
      await this.hooks?.onRunStarted?.({
        taskId: input.taskId,
        runId: run.id,
        threadId: thread.id,
        sessionId: session.id,
        type: "prompt",
      })
    }

    try {
      const provider = this.providers.get(input.providerName)
      const result = await provider.generate({
        prompt: input.prompt,
        modelName: input.modelName,
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      })

      this.db.completeRun(run.id, {
        status: "completed",
        outputText: result.text,
        metadata: {
          usage: result.usage ?? null,
          finishReason: result.finishReason ?? null,
        },
      })

      this.db.appendMessage({
        sessionId: session.id,
        runId: run.id,
        role: "assistant",
        content: result.text,
      })

      this.db.recordArtifact({
        threadId: thread.id,
        sessionId: session.id,
        runId: run.id,
        kind: "note",
        title: "provider-response",
        body: result.text,
      })

      this.db.recordEvent({
        threadId: thread.id,
        sessionId: session.id,
        runId: run.id,
        type: "run.completed",
        payload: {
          kind: "prompt",
          providerName: result.providerName,
          modelName: result.modelName,
          taskId: input.taskId ?? null,
        },
      })

      if (input.taskId) {
        await this.hooks?.onRunCompleted?.({
          taskId: input.taskId,
          runId: run.id,
          threadId: thread.id,
          sessionId: session.id,
          type: "prompt",
        })
      }

      return {
        thread,
        session,
        runId: run.id,
        output: result.text,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.completeRun(run.id, {
        status: "failed",
        errorText: message,
      })
      this.db.recordEvent({
        threadId: thread.id,
        sessionId: session.id,
        runId: run.id,
        type: "run.failed",
        payload: {
          kind: "prompt",
          error: message,
          taskId: input.taskId ?? null,
        },
      })
      if (input.taskId) {
        await this.hooks?.onRunFailed?.({
          taskId: input.taskId,
          runId: run.id,
          threadId: thread.id,
          sessionId: session.id,
          type: "prompt",
          errorText: message,
        })
      }
      throw error
    }
  }

  async executeTool(input: {
    sessionId: string
    taskId?: string
    toolName: string
    args: unknown
    cwd: string
    approvalHandler?: ApprovalHandler
  }) {
    const session = this.sessions.getSession(input.sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`)
    }
    const thread = this.threads.getThread(session.threadId)
    if (!thread) {
      throw new Error(`Unknown thread: ${session.threadId}`)
    }

    const run = this.db.createRun({
      threadId: thread.id,
      sessionId: session.id,
      taskId: input.taskId ?? null,
      type: "tool",
      status: "running",
      providerName: null,
      modelName: null,
      toolName: input.toolName,
      inputText: JSON.stringify(input.args),
      outputText: null,
      errorText: null,
      metadata: null,
    })

    this.db.recordEvent({
      threadId: thread.id,
      sessionId: session.id,
      runId: run.id,
      type: "run.started",
      payload: {
        kind: "tool",
        toolName: input.toolName,
        taskId: input.taskId ?? null,
      },
    })

    if (input.taskId) {
      await this.hooks?.onRunStarted?.({
        taskId: input.taskId,
        runId: run.id,
        threadId: thread.id,
        sessionId: session.id,
        type: "tool",
      })
    }

    try {
      const result = await this.tools.execute(input.toolName, input.args, {
        cwd: input.cwd,
        authorize: (resource) => this.sessions.authorize(session.id, resource, input.approvalHandler),
      })

      this.db.completeRun(run.id, {
        status: "completed",
        outputText: result.output,
        metadata: result.metadata ?? null,
      })

      this.db.appendMessage({
        sessionId: session.id,
        runId: run.id,
        role: "tool",
        content: result.output,
      })

      this.db.recordArtifact({
        threadId: thread.id,
        sessionId: session.id,
        runId: run.id,
        kind: "tool-output",
        title: result.title,
        body: result.output,
      })

      this.db.recordEvent({
        threadId: thread.id,
        sessionId: session.id,
        runId: run.id,
        type: "run.completed",
        payload: {
          kind: "tool",
          toolName: input.toolName,
          taskId: input.taskId ?? null,
        },
      })

      if (input.taskId) {
        await this.hooks?.onRunCompleted?.({
          taskId: input.taskId,
          runId: run.id,
          threadId: thread.id,
          sessionId: session.id,
          type: "tool",
        })
      }

      return {
        thread,
        session,
        runId: run.id,
        result,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.completeRun(run.id, {
        status: "failed",
        errorText: message,
      })
      this.db.recordEvent({
        threadId: thread.id,
        sessionId: session.id,
        runId: run.id,
        type: "run.failed",
        payload: {
          kind: "tool",
          toolName: input.toolName,
          error: message,
          taskId: input.taskId ?? null,
        },
      })
      if (input.taskId) {
        await this.hooks?.onRunFailed?.({
          taskId: input.taskId,
          runId: run.id,
          threadId: thread.id,
          sessionId: session.id,
          type: "tool",
          errorText: message,
        })
      }
      throw error
    }
  }

  private resolveThreadAndSession(input: { threadId?: string; sessionId?: string; prompt: string }) {
    if (input.sessionId) {
      const session = this.sessions.getSession(input.sessionId)
      if (!session) {
        throw new Error(`Unknown session: ${input.sessionId}`)
      }
      const thread = this.threads.getThread(session.threadId)
      if (!thread) {
        throw new Error(`Unknown thread: ${session.threadId}`)
      }
      return { thread, session }
    }

    const thread = input.threadId
      ? this.threads.getThread(input.threadId) ?? (() => {
          throw new Error(`Unknown thread: ${input.threadId}`)
        })()
      : this.threads.createThread({
          title: summarizeTitle(input.prompt),
        })

    const session = this.sessions.createSession({
      threadId: thread.id,
      mode: "build",
      title: "Primary session",
    })

    return { thread, session }
  }
}

function summarizeTitle(prompt: string) {
  const trimmed = prompt.replace(/\s+/g, " ").trim()
  if (trimmed.length <= 48) return trimmed || "New thread"
  return `${trimmed.slice(0, 45)}...`
}
