import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import {
  evaluatePermission,
  type PermissionRule,
  type SessionRecord,
  type SessionSnapshotRecord,
  type SessionWorkspaceRecord,
  type WorkspaceFileRecord,
} from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

export type ApprovalDecision = "allow-once" | "allow-always" | "deny"
export type ApprovalHandler = (input: {
  session: SessionRecord
  resource: string
  suggestedAction: "ask"
}) => Promise<ApprovalDecision>

export class SessionService {
  constructor(private readonly db: AgentOsDatabase) {}

  createSession(input: { threadId: string; mode: SessionRecord["mode"]; title?: string | null; permissionRules?: PermissionRule[] }) {
    const session = this.db.createSession({
      threadId: input.threadId,
      mode: input.mode,
      title: input.title ?? null,
      permissionRules: input.permissionRules ?? defaultPermissionRules(input.mode),
    })

    this.db.recordEvent({
      threadId: session.threadId,
      sessionId: session.id,
      type: "session.created",
      payload: {
        mode: session.mode,
        title: session.title,
      },
    })

    return session
  }

  getSession(sessionId: string) {
    return this.db.getSession(sessionId)
  }

  listSessions(input: { threadId?: string } = {}) {
    return this.db.listSessions(input)
  }

  async bindWorkspace(input: {
    sessionId: string
    rootPath: string
    snapshotStrategy?: string
    metadata?: SessionWorkspaceRecord["metadata"]
  }) {
    const session = this.db.getSession(input.sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`)
    }

    const rootPath = path.resolve(input.rootPath)
    const stat = await fs.stat(rootPath)
    if (!stat.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${rootPath}`)
    }

    const workspace = this.db.upsertSessionWorkspace({
      sessionId: session.id,
      rootPath,
      snapshotStrategy: input.snapshotStrategy ?? "manifest+git",
      lastSnapshotId: this.db.getSessionWorkspace(session.id)?.lastSnapshotId ?? null,
      metadata: input.metadata ?? null,
    })

    this.db.recordEvent({
      threadId: session.threadId,
      sessionId: session.id,
      type: "session.workspace.bound",
      payload: {
        rootPath: workspace.rootPath,
        snapshotStrategy: workspace.snapshotStrategy,
      },
    })

    return workspace
  }

  getWorkspace(sessionId: string) {
    return this.db.getSessionWorkspace(sessionId)
  }

  listWorkspaces() {
    return this.db.listSessionWorkspaces()
  }

  async captureSnapshot(input: {
    sessionId: string
    label: string
    summary?: string | null
    metadata?: SessionSnapshotRecord["metadata"]
    limit?: number
  }) {
    const session = this.db.getSession(input.sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`)
    }

    const workspace = this.db.getSessionWorkspace(session.id)
    if (!workspace) {
      throw new Error(`Session ${session.id} has no bound workspace`)
    }

    const manifest = await collectWorkspaceManifest(workspace.rootPath, input.limit ?? 200)
    const git = await collectGitState(workspace.rootPath)
    const snapshot = this.db.createSessionSnapshot({
      sessionId: session.id,
      label: input.label,
      summary: input.summary ?? null,
      rootPath: workspace.rootPath,
      gitBranch: git.branch,
      gitCommit: git.commit,
      gitStatus: git.status,
      manifest,
      metadata: input.metadata ?? null,
    })

    this.db.upsertSessionWorkspace({
      ...workspace,
      lastSnapshotId: snapshot.id,
    })

    this.db.recordEvent({
      threadId: session.threadId,
      sessionId: session.id,
      type: "session.snapshot.created",
      payload: {
        snapshotId: snapshot.id,
        label: snapshot.label,
        rootPath: snapshot.rootPath,
        fileCount: snapshot.manifest.length,
      },
    })

    return snapshot
  }

  listSnapshots(sessionId: string) {
    return this.db.listSessionSnapshots(sessionId)
  }

  restoreSnapshot(input: { sessionId: string; snapshotId: string }) {
    const session = this.db.getSession(input.sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${input.sessionId}`)
    }

    const snapshot = this.db.getSessionSnapshot(input.snapshotId)
    if (!snapshot || snapshot.sessionId !== input.sessionId) {
      throw new Error(`Unknown snapshot for session ${input.sessionId}: ${input.snapshotId}`)
    }

    const current = this.db.getSessionWorkspace(session.id)
    const workspace = this.db.upsertSessionWorkspace({
      sessionId: session.id,
      rootPath: snapshot.rootPath,
      snapshotStrategy: current?.snapshotStrategy ?? "manifest+git",
      lastSnapshotId: snapshot.id,
      metadata: current?.metadata ?? null,
    })
    this.db.markSessionSnapshotRestored(snapshot.id)

    this.db.recordEvent({
      threadId: session.threadId,
      sessionId: session.id,
      type: "session.snapshot.restored",
      payload: {
        snapshotId: snapshot.id,
        rootPath: snapshot.rootPath,
        mode: "logical",
      },
    })

    return {
      workspace,
      snapshot: this.db.getSessionSnapshot(snapshot.id) ?? snapshot,
    }
  }

  async authorize(sessionId: string, resource: string, handler?: ApprovalHandler) {
    const session = this.db.getSession(sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }

    const decision = evaluatePermission(session.permissionRules, resource)
    if (decision === "allow") return
    if (decision === "deny") {
      this.db.recordApproval({
        sessionId,
        resource,
        decision: "deny",
        scope: "once",
        reason: "Denied by session rules",
      })
      throw new Error(`Permission denied for resource: ${resource}`)
    }
    if (!handler) {
      throw new Error(`Permission requires approval for resource: ${resource}`)
    }

    const approved = await handler({
      session,
      resource,
      suggestedAction: "ask",
    })

    if (approved === "deny") {
      this.db.recordApproval({
        sessionId,
        resource,
        decision: "deny",
        scope: "once",
        reason: "Rejected by approver",
      })
      throw new Error(`Permission rejected for resource: ${resource}`)
    }

    if (approved === "allow-always") {
      const updatedRules = [...session.permissionRules, { resource, action: "allow" as const }]
      this.db.updateSessionPermissionRules(sessionId, updatedRules)
      this.db.recordApproval({
        sessionId,
        resource,
        decision: "allow",
        scope: "always",
        reason: "Approved permanently by approver",
      })
      return
    }

    this.db.recordApproval({
      sessionId,
      resource,
      decision: "allow",
      scope: "once",
      reason: "Approved once by approver",
    })
  }
}

const ignoredWorkspaceEntries = new Set([".git", "node_modules", "dist", ".turbo", ".opencode-agent-os"])

async function collectWorkspaceManifest(rootPath: string, limit: number) {
  const manifest: WorkspaceFileRecord[] = []

  async function walk(currentPath: string, relativeDir = ""): Promise<void> {
    if (manifest.length >= limit) return
    const entries = await fs.readdir(currentPath, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (manifest.length >= limit) return
      if (ignoredWorkspaceEntries.has(entry.name)) continue

      const absolutePath = path.join(currentPath, entry.name)
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name

      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }

      if (!entry.isFile()) continue
      const stat = await fs.stat(absolutePath)
      manifest.push({
        path: relativePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
    }
  }

  await walk(rootPath)
  return manifest
}

async function collectGitState(rootPath: string): Promise<{ branch: string | null; commit: string | null; status: string[] }> {
  const insideWorkTree = await runGit(rootPath, ["rev-parse", "--is-inside-work-tree"])
  if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout !== "true") {
    return {
      branch: null,
      commit: null,
      status: [],
    }
  }

  const [branch, commit, status] = await Promise.all([
    runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(rootPath, ["rev-parse", "HEAD"]),
    runGit(rootPath, ["status", "--short"]),
  ])

  return {
    branch: branch.exitCode === 0 ? branch.stdout || null : null,
    commit: commit.exitCode === 0 ? commit.stdout || null : null,
    status: status.exitCode === 0 ? splitLines(status.stdout) : [],
  }
}

function runGit(cwd: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      })
    })
  })
}

function splitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export function defaultPermissionRules(mode: SessionRecord["mode"]): PermissionRule[] {
  const shared: PermissionRule[] = [
    { resource: "tool:echo", action: "allow" },
    { resource: "fs:list:*", action: "allow" },
    { resource: "fs:read:*", action: "allow" },
  ]

  if (mode === "plan") {
    return [...shared, { resource: "tool:bash", action: "deny" }, { resource: "*", action: "ask" }]
  }

  return [...shared, { resource: "tool:bash", action: "ask" }, { resource: "*", action: "ask" }]
}
