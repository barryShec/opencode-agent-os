import type { ThreadRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

export class ThreadService {
  constructor(private readonly db: AgentOsDatabase) {}

  createThread(input: { title: string; metadata?: ThreadRecord["metadata"] }) {
    const thread = this.db.createThread({
      title: input.title,
      metadata: input.metadata,
    })
    this.db.recordEvent({
      threadId: thread.id,
      type: "thread.created",
      payload: {
        title: thread.title,
      },
    })
    return thread
  }

  getThread(threadId: string) {
    return this.db.getThread(threadId)
  }

  listThreads() {
    return this.db.listThreads()
  }
}
