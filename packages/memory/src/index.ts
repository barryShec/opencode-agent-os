import type {
  ArtifactRecord,
  MessageRecord,
  SessionRecord,
  SessionSnapshotRecord,
  TaskRecord,
  ThreadRecord,
} from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

export type MemoryEntryKind = "task" | "artifact" | "message" | "snapshot"

export interface MemoryEntry {
  id: string
  kind: MemoryEntryKind
  threadId: string
  sessionId?: string | null
  taskId?: string | null
  title: string
  body: string
  timestamp: string
  score: number
  tags: string[]
}

export interface ThreadMemoryRecall {
  thread: ThreadRecord
  sessions: SessionRecord[]
  stats: {
    totalTasks: number
    activeTasks: number
    failedTasks: number
    completedTasks: number
    recentArtifacts: number
    recentMessages: number
  }
  items: MemoryEntry[]
  recallText: string
}

export class MemoryService {
  constructor(private readonly db: AgentOsDatabase) {}

  recallThread(input: {
    threadId: string
    query?: string
    limit?: number
  }): ThreadMemoryRecall {
    const thread = this.db.getThread(input.threadId)
    if (!thread) {
      throw new Error(`Unknown thread: ${input.threadId}`)
    }

    const sessions = this.db.listSessions({ threadId: thread.id })
    const tasks = this.db.listTasks({ threadId: thread.id })
    const artifacts = this.db.listArtifacts(thread.id)
    const messages = sessions.flatMap((session) => this.db.listMessages(session.id))
    const snapshots = sessions.flatMap((session) => this.db.listSessionSnapshots(session.id))

    const entries = rankEntries(
      [
        ...tasks.map((task) => toTaskEntry(task)),
        ...artifacts.map((artifact) => toArtifactEntry(artifact)),
        ...messages.map((message) => toMessageEntry(message, thread.id)),
        ...snapshots.map((snapshot) => toSnapshotEntry(snapshot, thread.id)),
      ],
      input.query,
    ).slice(0, input.limit ?? 10)

    return {
      thread,
      sessions,
      stats: {
        totalTasks: tasks.length,
        activeTasks: tasks.filter((task) => task.status === "pending" || task.status === "running" || task.status === "blocked").length,
        failedTasks: tasks.filter((task) => task.status === "failed").length,
        completedTasks: tasks.filter((task) => task.status === "completed").length,
        recentArtifacts: Math.min(artifacts.length, 10),
        recentMessages: Math.min(messages.length, 10),
      },
      items: entries,
      recallText: formatRecall({
        thread,
        sessions,
        tasks,
        entries,
      }),
    }
  }

  searchThread(input: {
    threadId: string
    query: string
    limit?: number
  }) {
    const recall = this.recallThread({
      threadId: input.threadId,
      query: input.query,
      limit: input.limit ?? 12,
    })

    return {
      thread: recall.thread,
      query: input.query,
      items: recall.items,
    }
  }

  summarizeThread(input: {
    threadId: string
    limit?: number
    recordArtifact?: boolean
  }) {
    const recall = this.recallThread({
      threadId: input.threadId,
      limit: input.limit ?? 8,
    })

    const summary = [
      `Thread: ${recall.thread.title}`,
      `Sessions: ${recall.sessions.length}`,
      `Tasks: ${recall.stats.totalTasks} total, ${recall.stats.activeTasks} active, ${recall.stats.completedTasks} completed, ${recall.stats.failedTasks} failed`,
      "",
      "Key context:",
      ...recall.items.map((item) => `- [${item.kind}] ${item.title}: ${compact(item.body, 160)}`),
    ].join("\n")

    const artifact =
      input.recordArtifact === false
        ? null
        : this.db.recordArtifact({
            threadId: recall.thread.id,
            kind: "note",
            title: "thread-summary",
            body: summary,
          })

    return {
      thread: recall.thread,
      summary,
      artifact,
    }
  }

  resolveThreadId(input: {
    threadId?: string
    sessionId?: string
  }) {
    if (input.threadId) return input.threadId
    if (!input.sessionId) {
      throw new Error("threadId or sessionId is required")
    }
    const session = this.db.getSession(input.sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`)
    }
    return session.threadId
  }
}

function toTaskEntry(task: TaskRecord): MemoryEntry {
  return {
    id: task.id,
    kind: "task",
    threadId: task.threadId,
    sessionId: task.sessionId ?? null,
    taskId: task.id,
    title: task.title,
    body: [
      task.description,
      task.resultText,
      task.errorText,
      task.cancelReason,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n"),
    timestamp: task.completedAt ?? task.updatedAt,
    score: taskPriorityBoost(task),
    tags: [task.status, task.priority],
  }
}

function toArtifactEntry(artifact: ArtifactRecord): MemoryEntry {
  return {
    id: artifact.id,
    kind: "artifact",
    threadId: artifact.threadId,
    sessionId: artifact.sessionId ?? null,
    taskId: null,
    title: artifact.title,
    body: artifact.body,
    timestamp: artifact.createdAt,
    score: 1.5,
    tags: [artifact.kind],
  }
}

function toMessageEntry(message: MessageRecord, threadId: string): MemoryEntry {
  return {
    id: message.id,
    kind: "message",
    threadId,
    sessionId: message.sessionId,
    taskId: null,
    title: `message:${message.role}`,
    body: message.content,
    timestamp: message.createdAt,
    score: message.role === "assistant" ? 1.3 : 1,
    tags: [message.role],
  }
}

function toSnapshotEntry(snapshot: SessionSnapshotRecord, threadId: string): MemoryEntry {
  return {
    id: snapshot.id,
    kind: "snapshot",
    threadId,
    sessionId: snapshot.sessionId,
    taskId: null,
    title: snapshot.label,
    body: [
      snapshot.summary,
      snapshot.rootPath,
      snapshot.gitBranch ? `branch=${snapshot.gitBranch}` : null,
      snapshot.gitCommit ? `commit=${snapshot.gitCommit}` : null,
      snapshot.gitStatus.length > 0 ? snapshot.gitStatus.join("\n") : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n"),
    timestamp: snapshot.restoredAt ?? snapshot.createdAt,
    score: 1.1,
    tags: ["snapshot"],
  }
}

function rankEntries(entries: MemoryEntry[], query?: string) {
  const tokens = tokenize(query)
  return entries
    .map((entry) => ({
      ...entry,
      score: entry.score + queryBoost(entry, tokens) + recencyBoost(entry.timestamp),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      return right.timestamp.localeCompare(left.timestamp)
    })
}

function formatRecall(input: {
  thread: ThreadRecord
  sessions: SessionRecord[]
  tasks: TaskRecord[]
  entries: MemoryEntry[]
}) {
  const openTasks = input.tasks
    .filter((task) => task.status === "pending" || task.status === "running" || task.status === "blocked")
    .slice(0, 5)

  const failedTasks = input.tasks.filter((task) => task.status === "failed").slice(0, 3)

  return [
    `Thread "${input.thread.title}"`,
    `Sessions: ${input.sessions.length}`,
    `Open tasks: ${openTasks.length}`,
    ...(openTasks.length > 0
      ? ["Open task focus:", ...openTasks.map((task) => `- ${task.title} [${task.status}/${task.priority}]`)]
      : []),
    ...(failedTasks.length > 0
      ? ["Recent failures:", ...failedTasks.map((task) => `- ${task.title}: ${compact(task.errorText ?? "", 120)}`)]
      : []),
    "Recall items:",
    ...input.entries.map((entry) => `- [${entry.kind}] ${entry.title}: ${compact(entry.body, 180)}`),
  ].join("\n")
}

function tokenize(query: string | undefined) {
  if (!query) return []
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function queryBoost(entry: MemoryEntry, tokens: string[]) {
  if (tokens.length === 0) return 0
  const haystack = `${entry.title}\n${entry.body}\n${entry.tags.join(" ")}`.toLowerCase()
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 3 : 0), 0)
}

function recencyBoost(timestamp: string) {
  const ageHours = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60))
  return Math.max(0, 2 - ageHours / 24)
}

function taskPriorityBoost(task: TaskRecord) {
  if (task.status === "failed") return 3
  if (task.status === "running") return 2.5
  if (task.status === "pending" || task.status === "blocked") return 2
  if (task.priority === "high") return 1.75
  if (task.priority === "normal") return 1.25
  return 1
}

function compact(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}
