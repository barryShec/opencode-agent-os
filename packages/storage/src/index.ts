import { DatabaseSync } from "node:sqlite"
import type {
  ApprovalRecord,
  AutomationRecord,
  ArtifactRecord,
  EvaluatorResultRecord,
  EventRecord,
  GatewayDeliveryRecord,
  GatewayRouteRecord,
  MessageRecord,
  PermissionRule,
  ProcessRecord,
  RunRecord,
  SessionRecord,
  SessionSnapshotRecord,
  SessionWorkspaceRecord,
  SupervisorLeaseRecord,
  TaskEdgeRecord,
  TaskRecord,
  ThreadRecord,
  WorkspaceFileRecord,
} from "@opencode-agent-os/shared"
import { createId, nowIso } from "@opencode-agent-os/shared"

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback
  return JSON.parse(value) as T
}

function stringifyJsonValue(value: unknown) {
  return JSON.stringify(value ?? null)
}

function nullableText(value: string | null | undefined) {
  return value ?? null
}

export class AgentOsDatabase {
  private readonly sqlite: DatabaseSync

  constructor(dbPath: string) {
    this.sqlite = new DatabaseSync(dbPath)
    this.sqlite.exec("PRAGMA journal_mode = WAL;")
    this.sqlite.exec("PRAGMA foreign_keys = ON;")
    this.sqlite.exec("PRAGMA busy_timeout = 5000;")
  }

  migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        permission_rules TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_name TEXT,
        model_name TEXT,
        tool_name TEXT,
        input_text TEXT NOT NULL,
        output_text TEXT,
        error_text TEXT,
        metadata TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        assigned_process_id TEXT,
        scheduled_at TEXT,
        last_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        evaluator_gate TEXT NOT NULL DEFAULT 'required',
        repair_count INTEGER NOT NULL DEFAULT 0,
        result_text TEXT,
        error_text TEXT,
        owner TEXT,
        cancel_requested_at TEXT,
        cancel_reason TEXT,
        dead_lettered_at TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_edges (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id)
      );

      CREATE TABLE IF NOT EXISTS evaluator_results (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        evaluator_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        summary TEXT NOT NULL,
        score REAL,
        evidence TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        process_id TEXT REFERENCES agent_processes(id) ON DELETE SET NULL,
        interval_seconds INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        last_error TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gateway_routes (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        address TEXT NOT NULL,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        process_id TEXT REFERENCES agent_processes(id) ON DELETE SET NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gateway_deliveries (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL REFERENCES gateway_routes(id) ON DELETE CASCADE,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        process_id TEXT REFERENCES agent_processes(id) ON DELETE SET NULL,
        error_text TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS session_workspaces (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL,
        snapshot_strategy TEXT NOT NULL,
        last_snapshot_id TEXT,
        metadata TEXT,
        bound_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        summary TEXT,
        root_path TEXT NOT NULL,
        git_branch TEXT,
        git_commit TEXT,
        git_status TEXT NOT NULL,
        manifest TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        restored_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_processes (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        owner TEXT NOT NULL,
        status TEXT NOT NULL,
        active_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        last_assigned_at TEXT,
        heartbeat_at TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS supervisor_leases (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        resource TEXT NOT NULL,
        decision TEXT NOT NULL,
        scope TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

    `)

    this.ensureColumn("runs", "task_id", "TEXT REFERENCES tasks(id) ON DELETE SET NULL")
    this.ensureColumn("tasks", "attempts", "INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("tasks", "max_attempts", "INTEGER NOT NULL DEFAULT 3")
    this.ensureColumn("tasks", "available_at", "TEXT")
    this.ensureColumn("tasks", "lease_owner", "TEXT")
    this.ensureColumn("tasks", "lease_expires_at", "TEXT")
    this.ensureColumn("tasks", "assigned_process_id", "TEXT")
    this.ensureColumn("tasks", "scheduled_at", "TEXT")
    this.ensureColumn("tasks", "last_run_id", "TEXT REFERENCES runs(id) ON DELETE SET NULL")
    this.ensureColumn("tasks", "evaluator_gate", "TEXT NOT NULL DEFAULT 'required'")
    this.ensureColumn("tasks", "repair_count", "INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("tasks", "cancel_requested_at", "TEXT")
    this.ensureColumn("tasks", "cancel_reason", "TEXT")
    this.ensureColumn("tasks", "dead_lettered_at", "TEXT")
    this.ensureColumn("agent_processes", "last_assigned_at", "TEXT")

    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_thread_id ON sessions(thread_id);
      CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id);
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread_id ON tasks(thread_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_available_at ON tasks(available_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_lease_owner ON tasks(lease_owner);
      CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires_at ON tasks(lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned_process_id ON tasks(assigned_process_id);
      CREATE INDEX IF NOT EXISTS idx_eval_task_id ON evaluator_results(task_id);
      CREATE INDEX IF NOT EXISTS idx_eval_run_id ON evaluator_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_automations_status_next_run_at ON automations(status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_process_id ON automations(process_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_routes_channel_address ON gateway_routes(channel, address);
      CREATE INDEX IF NOT EXISTS idx_gateway_deliveries_route_id ON gateway_deliveries(route_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_deliveries_status ON gateway_deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_session_snapshots_session_id ON session_snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_processes_thread_id ON agent_processes(thread_id);
      CREATE INDEX IF NOT EXISTS idx_agent_processes_session_id ON agent_processes(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_processes_status ON agent_processes(status);
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_thread_id ON artifacts(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread_id);
      CREATE INDEX IF NOT EXISTS idx_supervisor_leases_owner ON supervisor_leases(owner);
    `)
  }

  close() {
    this.sqlite.close()
  }

  createThread(input: { title: string; status?: ThreadRecord["status"]; metadata?: ThreadRecord["metadata"] }) {
    const record: ThreadRecord = {
      id: createId("thread"),
      title: input.title,
      status: input.status ?? "active",
      metadata: input.metadata ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO threads (id, title, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(record.id, record.title, record.status, stringifyJsonValue(record.metadata), record.createdAt, record.updatedAt)

    return record
  }

  listThreads() {
    const rows = this.sqlite.prepare("SELECT * FROM threads ORDER BY created_at DESC").all() as Record<string, unknown>[]
    return rows.map((row) => this.mapThread(row))
  }

  getThread(threadId: string) {
    const row = this.sqlite.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as Record<string, unknown> | undefined
    return row ? this.mapThread(row) : undefined
  }

  createSession(input: {
    threadId: string
    mode: SessionRecord["mode"]
    title?: string | null
    permissionRules: PermissionRule[]
    status?: SessionRecord["status"]
  }) {
    const record: SessionRecord = {
      id: createId("session"),
      threadId: input.threadId,
      mode: input.mode,
      status: input.status ?? "active",
      title: input.title ?? null,
      permissionRules: input.permissionRules,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO sessions (id, thread_id, mode, status, title, permission_rules, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.threadId,
        record.mode,
        record.status,
        record.title ?? null,
        stringifyJsonValue(record.permissionRules),
        record.createdAt,
        record.updatedAt,
      )

    return record
  }

  updateSessionPermissionRules(sessionId: string, permissionRules: PermissionRule[]) {
    const updatedAt = nowIso()
    this.sqlite
      .prepare("UPDATE sessions SET permission_rules = ?, updated_at = ? WHERE id = ?")
      .run(stringifyJsonValue(permissionRules), updatedAt, sessionId)
  }

  listSessions(input: { threadId?: string } = {}) {
    const rows = input.threadId
      ? (this.sqlite.prepare("SELECT * FROM sessions WHERE thread_id = ? ORDER BY created_at DESC").all(input.threadId) as Record<
          string,
          unknown
        >[])
      : (this.sqlite.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as Record<string, unknown>[])
    return rows.map((row) => this.mapSession(row))
  }

  getSession(sessionId: string) {
    const row = this.sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined
    return row ? this.mapSession(row) : undefined
  }

  createRun(input: Omit<RunRecord, "id" | "startedAt" | "completedAt"> & { startedAt?: string }) {
    const record: RunRecord = {
      ...input,
      id: createId("run"),
      startedAt: input.startedAt ?? nowIso(),
      completedAt: null,
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO runs (
          id, thread_id, session_id, task_id, type, status, provider_name, model_name, tool_name, input_text, output_text, error_text, metadata, started_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.threadId,
        record.sessionId,
        nullableText(record.taskId),
        record.type,
        record.status,
        nullableText(record.providerName),
        nullableText(record.modelName),
        nullableText(record.toolName),
        record.inputText,
        nullableText(record.outputText),
        nullableText(record.errorText),
        stringifyJsonValue(record.metadata),
        record.startedAt,
        nullableText(record.completedAt),
      )

    return record
  }

  createTask(
    input: Omit<TaskRecord, "id" | "createdAt" | "updatedAt" | "completedAt" | "resultText" | "errorText"> & {
      createdAt?: string
      updatedAt?: string
      completedAt?: string | null
      resultText?: string | null
      errorText?: string | null
    },
  ) {
    const record: TaskRecord = {
      ...input,
      id: createId("task"),
      createdAt: input.createdAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso(),
      completedAt: input.completedAt ?? null,
      resultText: input.resultText ?? null,
      errorText: input.errorText ?? null,
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO tasks (
          id, thread_id, session_id, parent_task_id, title, description, status, priority, attempts, max_attempts, available_at, lease_owner, lease_expires_at, assigned_process_id, scheduled_at, last_run_id, evaluator_gate, repair_count, result_text, error_text, owner, cancel_requested_at, cancel_reason, dead_lettered_at, metadata, created_at, updated_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.threadId,
        record.sessionId ?? null,
        record.parentTaskId ?? null,
        record.title,
        record.description ?? null,
        record.status,
        record.priority,
        record.attempts,
        record.maxAttempts,
        record.availableAt ?? null,
        record.leaseOwner ?? null,
        record.leaseExpiresAt ?? null,
        record.assignedProcessId ?? null,
        record.scheduledAt ?? null,
        record.lastRunId ?? null,
        record.evaluatorGate,
        record.repairCount,
        record.resultText ?? null,
        record.errorText ?? null,
        record.owner ?? null,
        record.cancelRequestedAt ?? null,
        record.cancelReason ?? null,
        record.deadLetteredAt ?? null,
        stringifyJsonValue(record.metadata),
        record.createdAt,
        record.updatedAt,
        record.completedAt ?? null,
      )

    return record
  }

  addTaskDependency(taskId: string, dependsOnTaskId: string) {
    this.sqlite
      .prepare(
        `
        INSERT OR IGNORE INTO task_edges (task_id, depends_on_task_id)
        VALUES (?, ?)
      `,
      )
      .run(taskId, dependsOnTaskId)
  }

  getTask(taskId: string) {
    const row = this.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined
    return row ? this.mapTask(row) : undefined
  }

  listTasks(input: { threadId?: string; sessionId?: string; status?: TaskRecord["status"] } = {}) {
    const clauses: string[] = []
    const params: Array<string> = []

    if (input.threadId) {
      clauses.push("thread_id = ?")
      params.push(input.threadId)
    }
    if (input.sessionId) {
      clauses.push("session_id = ?")
      params.push(input.sessionId)
    }
    if (input.status) {
      clauses.push("status = ?")
      params.push(input.status)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.sqlite
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[]

    return rows.map((row) => this.mapTask(row))
  }

  listTaskDependencies(taskId: string): TaskEdgeRecord[] {
    const rows = this.sqlite
      .prepare("SELECT task_id, depends_on_task_id FROM task_edges WHERE task_id = ? ORDER BY depends_on_task_id ASC")
      .all(taskId) as Record<string, unknown>[]

    return rows.map((row) => ({
      taskId: String(row.task_id),
      dependsOnTaskId: String(row.depends_on_task_id),
    }))
  }

  claimTaskLease(taskId: string, input: { owner: string; expiresAt: string }) {
    this.sqlite.exec("BEGIN IMMEDIATE")
    try {
      const row = this.sqlite
        .prepare("SELECT lease_owner, lease_expires_at FROM tasks WHERE id = ?")
        .get(taskId) as Record<string, unknown> | undefined

      if (!row) {
        this.sqlite.exec("ROLLBACK")
        return undefined
      }

      const leaseOwner = row.lease_owner === null ? null : String(row.lease_owner)
      const leaseExpiresAt = row.lease_expires_at === null ? null : String(row.lease_expires_at)
      const leaseActive = Boolean(leaseOwner && leaseExpiresAt && leaseExpiresAt > nowIso())

      if (leaseActive && leaseOwner !== input.owner) {
        this.sqlite.exec("ROLLBACK")
        return undefined
      }

      const updatedAt = nowIso()
      this.sqlite
        .prepare("UPDATE tasks SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(input.owner, input.expiresAt, updatedAt, taskId)
      this.sqlite.exec("COMMIT")
      return this.getTask(taskId)
    } catch (error) {
      this.sqlite.exec("ROLLBACK")
      throw error
    }
  }

  updateTask(
    taskId: string,
    input: Partial<
      Pick<
        TaskRecord,
        | "title"
        | "description"
        | "status"
        | "priority"
        | "attempts"
        | "maxAttempts"
        | "availableAt"
        | "leaseOwner"
        | "leaseExpiresAt"
        | "assignedProcessId"
        | "scheduledAt"
        | "lastRunId"
        | "evaluatorGate"
        | "repairCount"
        | "resultText"
        | "errorText"
        | "owner"
        | "cancelRequestedAt"
        | "cancelReason"
        | "deadLetteredAt"
        | "metadata"
      >
    > & {
      completedAt?: string | null
    },
  ) {
    const current = this.getTask(taskId)
    if (!current) {
      throw new Error(`Unknown task: ${taskId}`)
    }

    const next: TaskRecord = {
      ...current,
      title: input.title ?? current.title,
      description: input.description === undefined ? current.description : input.description,
      status: input.status ?? current.status,
      priority: input.priority ?? current.priority,
      attempts: input.attempts ?? current.attempts,
      maxAttempts: input.maxAttempts ?? current.maxAttempts,
      availableAt: input.availableAt === undefined ? current.availableAt : input.availableAt,
      leaseOwner: input.leaseOwner === undefined ? current.leaseOwner : input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt === undefined ? current.leaseExpiresAt : input.leaseExpiresAt,
      assignedProcessId: input.assignedProcessId === undefined ? current.assignedProcessId : input.assignedProcessId,
      scheduledAt: input.scheduledAt === undefined ? current.scheduledAt : input.scheduledAt,
      lastRunId: input.lastRunId === undefined ? current.lastRunId : input.lastRunId,
      evaluatorGate: input.evaluatorGate ?? current.evaluatorGate,
      repairCount: input.repairCount ?? current.repairCount,
      resultText: input.resultText === undefined ? current.resultText : input.resultText,
      errorText: input.errorText === undefined ? current.errorText : input.errorText,
      owner: input.owner === undefined ? current.owner : input.owner,
      cancelRequestedAt: input.cancelRequestedAt === undefined ? current.cancelRequestedAt : input.cancelRequestedAt,
      cancelReason: input.cancelReason === undefined ? current.cancelReason : input.cancelReason,
      deadLetteredAt: input.deadLetteredAt === undefined ? current.deadLetteredAt : input.deadLetteredAt,
      metadata: input.metadata === undefined ? current.metadata : input.metadata,
      updatedAt: nowIso(),
      completedAt: input.completedAt === undefined ? current.completedAt ?? null : input.completedAt,
    }

    this.sqlite
      .prepare(
        `
        UPDATE tasks
        SET title = ?, description = ?, status = ?, priority = ?, attempts = ?, max_attempts = ?, available_at = ?, lease_owner = ?, lease_expires_at = ?, assigned_process_id = ?, scheduled_at = ?, last_run_id = ?, evaluator_gate = ?, repair_count = ?, result_text = ?, error_text = ?, owner = ?, cancel_requested_at = ?, cancel_reason = ?, dead_lettered_at = ?, metadata = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `,
      )
      .run(
        next.title,
        next.description ?? null,
        next.status,
        next.priority,
        next.attempts,
        next.maxAttempts,
        next.availableAt ?? null,
        next.leaseOwner ?? null,
        next.leaseExpiresAt ?? null,
        next.assignedProcessId ?? null,
        next.scheduledAt ?? null,
        next.lastRunId ?? null,
        next.evaluatorGate,
        next.repairCount,
        next.resultText ?? null,
        next.errorText ?? null,
        next.owner ?? null,
        next.cancelRequestedAt ?? null,
        next.cancelReason ?? null,
        next.deadLetteredAt ?? null,
        stringifyJsonValue(next.metadata),
        next.updatedAt,
        next.completedAt ?? null,
        taskId,
      )

    return next
  }

  completeRun(runId: string, input: { status: RunRecord["status"]; outputText?: string; errorText?: string; metadata?: RunRecord["metadata"] }) {
    const completedAt = nowIso()
    this.sqlite
      .prepare(
        `
        UPDATE runs
        SET status = ?, output_text = ?, error_text = ?, metadata = ?, completed_at = ?
        WHERE id = ?
      `,
      )
      .run(input.status, input.outputText ?? null, input.errorText ?? null, stringifyJsonValue(input.metadata), completedAt, runId)
  }

  listRuns(input: { sessionId?: string; taskId?: string; status?: RunRecord["status"] } = {}) {
    const clauses: string[] = []
    const params: Array<string> = []

    if (input.sessionId) {
      clauses.push("session_id = ?")
      params.push(input.sessionId)
    }
    if (input.taskId) {
      clauses.push("task_id = ?")
      params.push(input.taskId)
    }
    if (input.status) {
      clauses.push("status = ?")
      params.push(input.status)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.sqlite
      .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC`)
      .all(...params) as Record<string, unknown>[]
    return rows.map((row) => this.mapRun(row))
  }

  getRun(runId: string) {
    const row = this.sqlite.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined
    return row ? this.mapRun(row) : undefined
  }

  getLatestRunForTask(taskId: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(taskId) as Record<string, unknown> | undefined
    return row ? this.mapRun(row) : undefined
  }

  appendMessage(input: Omit<MessageRecord, "id" | "createdAt"> & { createdAt?: string }) {
    const record: MessageRecord = {
      ...input,
      id: createId("message"),
      createdAt: input.createdAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO messages (id, session_id, run_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(record.id, record.sessionId, record.runId ?? null, record.role, record.content, record.createdAt)

    return record
  }

  listMessages(sessionId: string) {
    const rows = this.sqlite.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as Record<
      string,
      unknown
    >[]
    return rows.map((row) => this.mapMessage(row))
  }

  recordArtifact(input: Omit<ArtifactRecord, "id" | "createdAt"> & { createdAt?: string }) {
    const record: ArtifactRecord = {
      ...input,
      id: createId("artifact"),
      createdAt: input.createdAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO artifacts (id, thread_id, session_id, run_id, kind, title, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(record.id, record.threadId, record.sessionId ?? null, record.runId ?? null, record.kind, record.title, record.body, record.createdAt)

    return record
  }

  listArtifacts(threadId: string) {
    const rows = this.sqlite.prepare("SELECT * FROM artifacts WHERE thread_id = ? ORDER BY created_at DESC").all(threadId) as Record<
      string,
      unknown
    >[]
    return rows.map((row) => this.mapArtifact(row))
  }

  recordApproval(input: Omit<ApprovalRecord, "id" | "createdAt"> & { createdAt?: string }) {
    const record: ApprovalRecord = {
      ...input,
      id: createId("approval"),
      createdAt: input.createdAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO approvals (id, session_id, resource, decision, scope, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(record.id, record.sessionId, record.resource, record.decision, record.scope, record.reason ?? null, record.createdAt)

    return record
  }

  listApprovals(sessionId: string) {
    const rows = this.sqlite.prepare("SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as Record<
      string,
      unknown
    >[]
    return rows.map((row) => this.mapApproval(row))
  }

  recordEvent(input: Omit<EventRecord, "id" | "createdAt"> & { createdAt?: string }) {
    const record: EventRecord = {
      ...input,
      id: createId("event"),
      createdAt: input.createdAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO events (id, thread_id, session_id, run_id, type, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.threadId ?? null,
        record.sessionId ?? null,
        record.runId ?? null,
        record.type,
        stringifyJsonValue(record.payload),
        record.createdAt,
      )

    return record
  }

  createEvaluatorResult(
    input: Omit<EvaluatorResultRecord, "id" | "createdAt"> & {
      createdAt?: string
    },
  ) {
    const record: EvaluatorResultRecord = {
      ...input,
      id: createId("event").replace(/^event_/, "eval_"),
      createdAt: input.createdAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO evaluator_results (
          id, thread_id, session_id, task_id, run_id, evaluator_name, decision, summary, score, evidence, metadata, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.threadId,
        nullableText(record.sessionId),
        record.taskId,
        nullableText(record.runId),
        record.evaluatorName,
        record.decision,
        record.summary,
        record.score ?? null,
        nullableText(record.evidence),
        stringifyJsonValue(record.metadata),
        record.createdAt,
      )

    return record
  }

  listEvaluatorResults(input: { taskId?: string; runId?: string } = {}) {
    const clauses: string[] = []
    const params: Array<string> = []

    if (input.taskId) {
      clauses.push("task_id = ?")
      params.push(input.taskId)
    }
    if (input.runId) {
      clauses.push("run_id = ?")
      params.push(input.runId)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.sqlite
      .prepare(`SELECT * FROM evaluator_results ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[]

    return rows.map((row) => this.mapEvaluatorResult(row))
  }

  createAutomation(
    input: Omit<AutomationRecord, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "lastError"> & {
      createdAt?: string
      updatedAt?: string
      lastRunAt?: string | null
      lastError?: string | null
    },
  ) {
    const record: AutomationRecord = {
      ...input,
      id: createId("automation"),
      createdAt: input.createdAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso(),
      lastRunAt: input.lastRunAt ?? null,
      lastError: input.lastError ?? null,
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO automations (
          id, label, kind, status, thread_id, session_id, process_id, interval_seconds, next_run_at, last_run_at, last_error, metadata, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.label,
        record.kind,
        record.status,
        nullableText(record.threadId),
        nullableText(record.sessionId),
        nullableText(record.processId),
        record.intervalSeconds,
        record.nextRunAt,
        nullableText(record.lastRunAt),
        nullableText(record.lastError),
        stringifyJsonValue(record.metadata),
        record.createdAt,
        record.updatedAt,
      )

    return record
  }

  getAutomation(automationId: string) {
    const row = this.sqlite.prepare("SELECT * FROM automations WHERE id = ?").get(automationId) as Record<string, unknown> | undefined
    return row ? this.mapAutomation(row) : undefined
  }

  listAutomations(input: { status?: AutomationRecord["status"]; threadId?: string; sessionId?: string; processId?: string } = {}) {
    const clauses: string[] = []
    const params: string[] = []
    if (input.status) {
      clauses.push("status = ?")
      params.push(input.status)
    }
    if (input.threadId) {
      clauses.push("thread_id = ?")
      params.push(input.threadId)
    }
    if (input.sessionId) {
      clauses.push("session_id = ?")
      params.push(input.sessionId)
    }
    if (input.processId) {
      clauses.push("process_id = ?")
      params.push(input.processId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.sqlite
      .prepare(`SELECT * FROM automations ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[]
    return rows.map((row) => this.mapAutomation(row))
  }

  listDueAutomations(now = nowIso(), limit = 20) {
    const rows = this.sqlite
      .prepare(
        `
        SELECT *
        FROM automations
        WHERE status = 'active' AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
      `,
      )
      .all(now, limit) as Record<string, unknown>[]
    return rows.map((row) => this.mapAutomation(row))
  }

  updateAutomation(
    automationId: string,
    input: Partial<
      Pick<
        AutomationRecord,
        "label" | "kind" | "status" | "threadId" | "sessionId" | "processId" | "intervalSeconds" | "nextRunAt" | "lastRunAt" | "lastError" | "metadata"
      >
    >,
  ) {
    const current = this.getAutomation(automationId)
    if (!current) {
      throw new Error(`Unknown automation: ${automationId}`)
    }

    const next: AutomationRecord = {
      ...current,
      label: input.label ?? current.label,
      kind: input.kind ?? current.kind,
      status: input.status ?? current.status,
      threadId: input.threadId === undefined ? current.threadId : input.threadId,
      sessionId: input.sessionId === undefined ? current.sessionId : input.sessionId,
      processId: input.processId === undefined ? current.processId : input.processId,
      intervalSeconds: input.intervalSeconds ?? current.intervalSeconds,
      nextRunAt: input.nextRunAt ?? current.nextRunAt,
      lastRunAt: input.lastRunAt === undefined ? current.lastRunAt : input.lastRunAt,
      lastError: input.lastError === undefined ? current.lastError : input.lastError,
      metadata: input.metadata === undefined ? current.metadata : input.metadata,
      updatedAt: nowIso(),
    }

    this.sqlite
      .prepare(
        `
        UPDATE automations
        SET label = ?, kind = ?, status = ?, thread_id = ?, session_id = ?, process_id = ?, interval_seconds = ?, next_run_at = ?, last_run_at = ?, last_error = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        next.label,
        next.kind,
        next.status,
        nullableText(next.threadId),
        nullableText(next.sessionId),
        nullableText(next.processId),
        next.intervalSeconds,
        next.nextRunAt,
        nullableText(next.lastRunAt),
        nullableText(next.lastError),
        stringifyJsonValue(next.metadata),
        next.updatedAt,
        automationId,
      )

    return next
  }

  createGatewayRoute(
    input: Omit<GatewayRouteRecord, "id" | "createdAt" | "updatedAt"> & {
      createdAt?: string
      updatedAt?: string
    },
  ) {
    const record: GatewayRouteRecord = {
      ...input,
      id: createId("route"),
      createdAt: input.createdAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO gateway_routes (id, channel, address, thread_id, session_id, process_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.channel,
        record.address,
        nullableText(record.threadId),
        nullableText(record.sessionId),
        nullableText(record.processId),
        stringifyJsonValue(record.metadata),
        record.createdAt,
        record.updatedAt,
      )

    return record
  }

  getGatewayRoute(routeId: string) {
    const row = this.sqlite.prepare("SELECT * FROM gateway_routes WHERE id = ?").get(routeId) as Record<string, unknown> | undefined
    return row ? this.mapGatewayRoute(row) : undefined
  }

  findGatewayRoute(channel: GatewayRouteRecord["channel"], address: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM gateway_routes WHERE channel = ? AND address = ? ORDER BY created_at ASC LIMIT 1")
      .get(channel, address) as Record<string, unknown> | undefined
    return row ? this.mapGatewayRoute(row) : undefined
  }

  listGatewayRoutes(input: { channel?: GatewayRouteRecord["channel"]; threadId?: string; sessionId?: string; processId?: string } = {}) {
    const clauses: string[] = []
    const params: string[] = []
    if (input.channel) {
      clauses.push("channel = ?")
      params.push(input.channel)
    }
    if (input.threadId) {
      clauses.push("thread_id = ?")
      params.push(input.threadId)
    }
    if (input.sessionId) {
      clauses.push("session_id = ?")
      params.push(input.sessionId)
    }
    if (input.processId) {
      clauses.push("process_id = ?")
      params.push(input.processId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.sqlite
      .prepare(`SELECT * FROM gateway_routes ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[]
    return rows.map((row) => this.mapGatewayRoute(row))
  }

  createGatewayDelivery(
    input: Omit<GatewayDeliveryRecord, "id" | "createdAt" | "processedAt" | "errorText"> & {
      createdAt?: string
      processedAt?: string | null
      errorText?: string | null
    },
  ) {
    const record: GatewayDeliveryRecord = {
      ...input,
      id: createId("delivery"),
      createdAt: input.createdAt ?? nowIso(),
      processedAt: input.processedAt ?? null,
      errorText: input.errorText ?? null,
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO gateway_deliveries (
          id, route_id, direction, status, body, thread_id, session_id, process_id, error_text, metadata, created_at, processed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.routeId,
        record.direction,
        record.status,
        record.body,
        nullableText(record.threadId),
        nullableText(record.sessionId),
        nullableText(record.processId),
        nullableText(record.errorText),
        stringifyJsonValue(record.metadata),
        record.createdAt,
        nullableText(record.processedAt),
      )

    return record
  }

  updateGatewayDelivery(
    deliveryId: string,
    input: Partial<Pick<GatewayDeliveryRecord, "status" | "errorText" | "processedAt" | "metadata">>,
  ) {
    const current = this.getGatewayDelivery(deliveryId)
    if (!current) {
      throw new Error(`Unknown gateway delivery: ${deliveryId}`)
    }

    const next: GatewayDeliveryRecord = {
      ...current,
      status: input.status ?? current.status,
      errorText: input.errorText === undefined ? current.errorText : input.errorText,
      processedAt: input.processedAt === undefined ? current.processedAt : input.processedAt,
      metadata: input.metadata === undefined ? current.metadata : input.metadata,
    }

    this.sqlite
      .prepare("UPDATE gateway_deliveries SET status = ?, error_text = ?, metadata = ?, processed_at = ? WHERE id = ?")
      .run(next.status, nullableText(next.errorText), stringifyJsonValue(next.metadata), nullableText(next.processedAt), deliveryId)

    return next
  }

  getGatewayDelivery(deliveryId: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM gateway_deliveries WHERE id = ?")
      .get(deliveryId) as Record<string, unknown> | undefined
    return row ? this.mapGatewayDelivery(row) : undefined
  }

  listGatewayDeliveries(input: { routeId?: string; status?: GatewayDeliveryRecord["status"] } = {}) {
    const clauses: string[] = []
    const params: string[] = []
    if (input.routeId) {
      clauses.push("route_id = ?")
      params.push(input.routeId)
    }
    if (input.status) {
      clauses.push("status = ?")
      params.push(input.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.sqlite
      .prepare(`SELECT * FROM gateway_deliveries ${where} ORDER BY created_at DESC`)
      .all(...params) as Record<string, unknown>[]
    return rows.map((row) => this.mapGatewayDelivery(row))
  }

  upsertSessionWorkspace(
    input: Omit<SessionWorkspaceRecord, "boundAt" | "updatedAt"> & {
      boundAt?: string
      updatedAt?: string
    },
  ) {
    const current = this.getSessionWorkspace(input.sessionId)
    const record: SessionWorkspaceRecord = {
      ...input,
      boundAt: current?.boundAt ?? input.boundAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO session_workspaces (session_id, root_path, snapshot_strategy, last_snapshot_id, metadata, bound_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          root_path = excluded.root_path,
          snapshot_strategy = excluded.snapshot_strategy,
          last_snapshot_id = excluded.last_snapshot_id,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        record.sessionId,
        record.rootPath,
        record.snapshotStrategy,
        nullableText(record.lastSnapshotId),
        stringifyJsonValue(record.metadata),
        record.boundAt,
        record.updatedAt,
      )

    return record
  }

  getSessionWorkspace(sessionId: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM session_workspaces WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined
    return row ? this.mapSessionWorkspace(row) : undefined
  }

  listSessionWorkspaces() {
    const rows = this.sqlite.prepare("SELECT * FROM session_workspaces ORDER BY updated_at DESC").all() as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionWorkspace(row))
  }

  createSessionSnapshot(
    input: Omit<SessionSnapshotRecord, "id" | "createdAt" | "restoredAt"> & {
      createdAt?: string
      restoredAt?: string | null
    },
  ) {
    const record: SessionSnapshotRecord = {
      ...input,
      id: createId("snapshot"),
      createdAt: input.createdAt ?? nowIso(),
      restoredAt: input.restoredAt ?? null,
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO session_snapshots (
          id, session_id, label, summary, root_path, git_branch, git_commit, git_status, manifest, metadata, created_at, restored_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.sessionId,
        record.label,
        nullableText(record.summary),
        record.rootPath,
        nullableText(record.gitBranch),
        nullableText(record.gitCommit),
        stringifyJsonValue(record.gitStatus),
        stringifyJsonValue(record.manifest),
        stringifyJsonValue(record.metadata),
        record.createdAt,
        nullableText(record.restoredAt),
      )

    return record
  }

  getSessionSnapshot(snapshotId: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM session_snapshots WHERE id = ?")
      .get(snapshotId) as Record<string, unknown> | undefined
    return row ? this.mapSessionSnapshot(row) : undefined
  }

  listSessionSnapshots(sessionId: string) {
    const rows = this.sqlite
      .prepare("SELECT * FROM session_snapshots WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((row) => this.mapSessionSnapshot(row))
  }

  markSessionSnapshotRestored(snapshotId: string, restoredAt = nowIso()) {
    this.sqlite.prepare("UPDATE session_snapshots SET restored_at = ? WHERE id = ?").run(restoredAt, snapshotId)
  }

  createProcess(
    input: Omit<ProcessRecord, "id" | "createdAt" | "updatedAt" | "heartbeatAt"> & {
      createdAt?: string
      updatedAt?: string
      heartbeatAt?: string
    },
  ) {
    const record: ProcessRecord = {
      ...input,
      id: createId("process"),
      createdAt: input.createdAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso(),
      heartbeatAt: input.heartbeatAt ?? nowIso(),
    }

    this.sqlite
      .prepare(
        `
        INSERT INTO agent_processes (
          id, thread_id, session_id, label, owner, status, active_task_id, last_assigned_at, heartbeat_at, metadata, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        nullableText(record.threadId),
        nullableText(record.sessionId),
        record.label,
        record.owner,
        record.status,
        nullableText(record.activeTaskId),
        nullableText(record.lastAssignedAt),
        record.heartbeatAt,
        stringifyJsonValue(record.metadata),
        record.createdAt,
        record.updatedAt,
      )

    return record
  }

  getProcess(processId: string) {
    const row = this.sqlite
      .prepare("SELECT * FROM agent_processes WHERE id = ?")
      .get(processId) as Record<string, unknown> | undefined
    return row ? this.mapProcess(row) : undefined
  }

  listProcesses(input: { threadId?: string; sessionId?: string; status?: ProcessRecord["status"] } = {}) {
    const clauses: string[] = []
    const params: string[] = []
    if (input.threadId) {
      clauses.push("thread_id = ?")
      params.push(input.threadId)
    }
    if (input.sessionId) {
      clauses.push("session_id = ?")
      params.push(input.sessionId)
    }
    if (input.status) {
      clauses.push("status = ?")
      params.push(input.status)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = this.sqlite
      .prepare(`SELECT * FROM agent_processes ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[]
    return rows.map((row) => this.mapProcess(row))
  }

  updateProcess(
    processId: string,
    input: Partial<
      Pick<ProcessRecord, "threadId" | "sessionId" | "label" | "owner" | "status" | "activeTaskId" | "lastAssignedAt" | "metadata" | "heartbeatAt">
    >,
  ) {
    const current = this.getProcess(processId)
    if (!current) {
      throw new Error(`Unknown process: ${processId}`)
    }

    const next: ProcessRecord = {
      ...current,
      threadId: input.threadId === undefined ? current.threadId : input.threadId,
      sessionId: input.sessionId === undefined ? current.sessionId : input.sessionId,
      label: input.label ?? current.label,
      owner: input.owner ?? current.owner,
      status: input.status ?? current.status,
      activeTaskId: input.activeTaskId === undefined ? current.activeTaskId : input.activeTaskId,
      lastAssignedAt: input.lastAssignedAt === undefined ? current.lastAssignedAt : input.lastAssignedAt,
      metadata: input.metadata === undefined ? current.metadata : input.metadata,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      updatedAt: nowIso(),
    }

    this.sqlite
      .prepare(
        `
        UPDATE agent_processes
        SET thread_id = ?, session_id = ?, label = ?, owner = ?, status = ?, active_task_id = ?, last_assigned_at = ?, heartbeat_at = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        nullableText(next.threadId),
        nullableText(next.sessionId),
        next.label,
        next.owner,
        next.status,
        nullableText(next.activeTaskId),
        nullableText(next.lastAssignedAt),
        next.heartbeatAt,
        stringifyJsonValue(next.metadata),
        next.updatedAt,
        processId,
      )

    return next
  }

  getSupervisorLease(name: string) {
    const row = this.sqlite.prepare("SELECT * FROM supervisor_leases WHERE name = ?").get(name) as Record<string, unknown> | undefined
    return row ? this.mapSupervisorLease(row) : undefined
  }

  acquireSupervisorLease(
    name: string,
    input: {
      owner: string
      expiresAt: string
      metadata?: SupervisorLeaseRecord["metadata"]
    },
  ) {
    this.sqlite.exec("BEGIN IMMEDIATE")
    try {
      const current = this.getSupervisorLease(name)
      const now = nowIso()
      const leaseActive = Boolean(current && current.leaseExpiresAt > now)

      if (current && leaseActive && current.owner !== input.owner) {
        this.sqlite.exec("ROLLBACK")
        return undefined
      }

      if (!current) {
        this.sqlite
          .prepare(
            `
            INSERT INTO supervisor_leases (name, owner, lease_expires_at, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          )
          .run(name, input.owner, input.expiresAt, stringifyJsonValue(input.metadata), now, now)
      } else {
        this.sqlite
          .prepare(
            `
            UPDATE supervisor_leases
            SET owner = ?, lease_expires_at = ?, metadata = ?, updated_at = ?
            WHERE name = ?
          `,
          )
          .run(input.owner, input.expiresAt, stringifyJsonValue(input.metadata), now, name)
      }

      this.sqlite.exec("COMMIT")
      return this.getSupervisorLease(name)
    } catch (error) {
      this.sqlite.exec("ROLLBACK")
      throw error
    }
  }

  releaseSupervisorLease(name: string, owner: string) {
    this.sqlite.exec("BEGIN IMMEDIATE")
    try {
      const current = this.getSupervisorLease(name)
      if (!current || current.owner !== owner) {
        this.sqlite.exec("ROLLBACK")
        return undefined
      }
      this.sqlite.prepare("DELETE FROM supervisor_leases WHERE name = ?").run(name)
      this.sqlite.exec("COMMIT")
      return current
    } catch (error) {
      this.sqlite.exec("ROLLBACK")
      throw error
    }
  }

  private mapThread(row: Record<string, unknown>): ThreadRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      status: row.status as ThreadRecord["status"],
      metadata: parseJsonValue(row.metadata, null),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private mapSession(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      mode: row.mode as SessionRecord["mode"],
      status: row.status as SessionRecord["status"],
      title: row.title === null ? null : String(row.title),
      permissionRules: parseJsonValue<PermissionRule[]>(row.permission_rules, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private mapRun(row: Record<string, unknown>): RunRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      sessionId: String(row.session_id),
      taskId: row.task_id === null ? null : String(row.task_id),
      type: row.type as RunRecord["type"],
      status: row.status as RunRecord["status"],
      providerName: row.provider_name === null ? null : String(row.provider_name),
      modelName: row.model_name === null ? null : String(row.model_name),
      toolName: row.tool_name === null ? null : String(row.tool_name),
      inputText: String(row.input_text),
      outputText: row.output_text === null ? null : String(row.output_text),
      errorText: row.error_text === null ? null : String(row.error_text),
      metadata: parseJsonValue(row.metadata, null),
      startedAt: String(row.started_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
    }
  }

  private mapMessage(row: Record<string, unknown>): MessageRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: row.run_id === null ? null : String(row.run_id),
      role: row.role as MessageRecord["role"],
      content: String(row.content),
      createdAt: String(row.created_at),
    }
  }

  private mapArtifact(row: Record<string, unknown>): ArtifactRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      runId: row.run_id === null ? null : String(row.run_id),
      kind: row.kind as ArtifactRecord["kind"],
      title: String(row.title),
      body: String(row.body),
      createdAt: String(row.created_at),
    }
  }

  private mapApproval(row: Record<string, unknown>): ApprovalRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      resource: String(row.resource),
      decision: row.decision as ApprovalRecord["decision"],
      scope: row.scope as ApprovalRecord["scope"],
      reason: row.reason === null ? null : String(row.reason),
      createdAt: String(row.created_at),
    }
  }

  private mapTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      parentTaskId: row.parent_task_id === null ? null : String(row.parent_task_id),
      title: String(row.title),
      description: row.description === null ? null : String(row.description),
      status: row.status as TaskRecord["status"],
      priority: row.priority as TaskRecord["priority"],
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      availableAt: row.available_at === null ? null : String(row.available_at),
      leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
      leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
      assignedProcessId: row.assigned_process_id === null ? null : String(row.assigned_process_id),
      scheduledAt: row.scheduled_at === null ? null : String(row.scheduled_at),
      lastRunId: row.last_run_id === null ? null : String(row.last_run_id),
      evaluatorGate: (row.evaluator_gate ?? "required") as TaskRecord["evaluatorGate"],
      repairCount: Number(row.repair_count ?? 0),
      resultText: row.result_text === null ? null : String(row.result_text),
      errorText: row.error_text === null ? null : String(row.error_text),
      owner: row.owner === null ? null : String(row.owner),
      cancelRequestedAt: row.cancel_requested_at === null ? null : String(row.cancel_requested_at),
      cancelReason: row.cancel_reason === null ? null : String(row.cancel_reason),
      deadLetteredAt: row.dead_lettered_at === null ? null : String(row.dead_lettered_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapEvaluatorResult(row: Record<string, unknown>): EvaluatorResultRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      taskId: String(row.task_id),
      runId: row.run_id === null ? null : String(row.run_id),
      evaluatorName: String(row.evaluator_name),
      decision: row.decision as EvaluatorResultRecord["decision"],
      summary: String(row.summary),
      score: row.score === null ? null : Number(row.score),
      evidence: row.evidence === null ? null : String(row.evidence),
      createdAt: String(row.created_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapAutomation(row: Record<string, unknown>): AutomationRecord {
    return {
      id: String(row.id),
      label: String(row.label),
      kind: row.kind as AutomationRecord["kind"],
      status: row.status as AutomationRecord["status"],
      threadId: row.thread_id === null ? null : String(row.thread_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      processId: row.process_id === null ? null : String(row.process_id),
      intervalSeconds: Number(row.interval_seconds),
      nextRunAt: String(row.next_run_at),
      lastRunAt: row.last_run_at === null ? null : String(row.last_run_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapGatewayRoute(row: Record<string, unknown>): GatewayRouteRecord {
    return {
      id: String(row.id),
      channel: row.channel as GatewayRouteRecord["channel"],
      address: String(row.address),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      processId: row.process_id === null ? null : String(row.process_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapGatewayDelivery(row: Record<string, unknown>): GatewayDeliveryRecord {
    return {
      id: String(row.id),
      routeId: String(row.route_id),
      direction: row.direction as GatewayDeliveryRecord["direction"],
      status: row.status as GatewayDeliveryRecord["status"],
      body: String(row.body),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      processId: row.process_id === null ? null : String(row.process_id),
      errorText: row.error_text === null ? null : String(row.error_text),
      createdAt: String(row.created_at),
      processedAt: row.processed_at === null ? null : String(row.processed_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapSessionWorkspace(row: Record<string, unknown>): SessionWorkspaceRecord {
    return {
      sessionId: String(row.session_id),
      rootPath: String(row.root_path),
      snapshotStrategy: String(row.snapshot_strategy),
      lastSnapshotId: row.last_snapshot_id === null ? null : String(row.last_snapshot_id),
      boundAt: String(row.bound_at),
      updatedAt: String(row.updated_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapSessionSnapshot(row: Record<string, unknown>): SessionSnapshotRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      label: String(row.label),
      summary: row.summary === null ? null : String(row.summary),
      rootPath: String(row.root_path),
      gitBranch: row.git_branch === null ? null : String(row.git_branch),
      gitCommit: row.git_commit === null ? null : String(row.git_commit),
      gitStatus: parseJsonValue<string[]>(row.git_status, []),
      manifest: parseJsonValue<WorkspaceFileRecord[]>(row.manifest, []),
      createdAt: String(row.created_at),
      restoredAt: row.restored_at === null ? null : String(row.restored_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapProcess(row: Record<string, unknown>): ProcessRecord {
    return {
      id: String(row.id),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      label: String(row.label),
      owner: String(row.owner),
      status: row.status as ProcessRecord["status"],
      activeTaskId: row.active_task_id === null ? null : String(row.active_task_id),
      lastAssignedAt: row.last_assigned_at === null ? null : String(row.last_assigned_at),
      heartbeatAt: String(row.heartbeat_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private mapSupervisorLease(row: Record<string, unknown>): SupervisorLeaseRecord {
    return {
      name: String(row.name),
      owner: String(row.owner),
      leaseExpiresAt: String(row.lease_expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      metadata: parseJsonValue(row.metadata, null),
    }
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const rows = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
    const exists = rows.some((row) => row.name === column)
    if (exists) return
    this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  }
}
