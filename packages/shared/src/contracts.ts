import { z } from "zod"
import { permissionRuleSchema } from "./permissions.js"

const metadataSchema = z.record(z.string(), z.unknown()).nullable().optional()

export const threadStatusSchema = z.enum(["active", "archived"])
export const sessionModeSchema = z.enum(["build", "plan", "general"])
export const sessionStatusSchema = z.enum(["active", "archived"])
export const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "blocked", "cancelled"])
export const taskPrioritySchema = z.enum(["low", "normal", "high"])
export const taskEvaluatorGateSchema = z.enum(["none", "required"])
export const runTypeSchema = z.enum(["prompt", "tool"])
export const runStatusSchema = z.enum(["running", "completed", "failed"])
export const taskReadinessSchema = z.enum(["ready", "waiting", "blocked", "done"])
export const evaluatorDecisionSchema = z.enum(["pass", "fail", "warn"])
export const automationKindSchema = z.enum(["process-run-once", "task-prompt"])
export const automationStatusSchema = z.enum(["active", "paused"])
export const gatewayChannelSchema = z.enum(["cli", "webhook", "feishu", "slack"])
export const gatewayDeliveryDirectionSchema = z.enum(["inbound", "outbound"])
export const gatewayDeliveryStatusSchema = z.enum(["received", "processed", "failed"])
export const messageRoleSchema = z.enum(["system", "user", "assistant", "tool"])
export const artifactKindSchema = z.enum(["plan", "verification", "diff", "note", "tool-output"])
export const approvalScopeSchema = z.enum(["once", "always"])
export const processStatusSchema = z.enum(["idle", "assigned", "running", "stopped", "error"])

export const threadRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: threadStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: metadataSchema,
})
export type ThreadRecord = z.infer<typeof threadRecordSchema>

export const sessionRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  mode: sessionModeSchema,
  status: sessionStatusSchema,
  title: z.string().nullable().optional(),
  permissionRules: z.array(permissionRuleSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SessionRecord = z.infer<typeof sessionRecordSchema>

export const taskRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sessionId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  availableAt: z.string().nullable().optional(),
  leaseOwner: z.string().nullable().optional(),
  leaseExpiresAt: z.string().nullable().optional(),
  assignedProcessId: z.string().nullable().optional(),
  scheduledAt: z.string().nullable().optional(),
  lastRunId: z.string().nullable().optional(),
  evaluatorGate: taskEvaluatorGateSchema,
  repairCount: z.number().int().nonnegative(),
  resultText: z.string().nullable().optional(),
  errorText: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  cancelRequestedAt: z.string().nullable().optional(),
  cancelReason: z.string().nullable().optional(),
  deadLetteredAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  metadata: metadataSchema,
})
export type TaskRecord = z.infer<typeof taskRecordSchema>

export const taskEdgeRecordSchema = z.object({
  taskId: z.string(),
  dependsOnTaskId: z.string(),
})
export type TaskEdgeRecord = z.infer<typeof taskEdgeRecordSchema>

export const taskGraphNodeSchema = z.object({
  task: taskRecordSchema,
  dependencies: z.array(taskEdgeRecordSchema),
  readiness: taskReadinessSchema,
})
export type TaskGraphNode = z.infer<typeof taskGraphNodeSchema>

export const runRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sessionId: z.string(),
  taskId: z.string().nullable().optional(),
  type: runTypeSchema,
  status: runStatusSchema,
  providerName: z.string().nullable().optional(),
  modelName: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  inputText: z.string(),
  outputText: z.string().nullable().optional(),
  errorText: z.string().nullable().optional(),
  startedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  metadata: metadataSchema,
})
export type RunRecord = z.infer<typeof runRecordSchema>

export const evaluatorResultRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sessionId: z.string().nullable().optional(),
  taskId: z.string(),
  runId: z.string().nullable().optional(),
  evaluatorName: z.string(),
  decision: evaluatorDecisionSchema,
  summary: z.string(),
  score: z.number().nullable().optional(),
  evidence: z.string().nullable().optional(),
  createdAt: z.string(),
  metadata: metadataSchema,
})
export type EvaluatorResultRecord = z.infer<typeof evaluatorResultRecordSchema>

export const automationRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: automationKindSchema,
  status: automationStatusSchema,
  threadId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  processId: z.string().nullable().optional(),
  intervalSeconds: z.number().int().positive(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: metadataSchema,
})
export type AutomationRecord = z.infer<typeof automationRecordSchema>

export const gatewayRouteRecordSchema = z.object({
  id: z.string(),
  channel: gatewayChannelSchema,
  address: z.string(),
  threadId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  processId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: metadataSchema,
})
export type GatewayRouteRecord = z.infer<typeof gatewayRouteRecordSchema>

export const gatewayDeliveryRecordSchema = z.object({
  id: z.string(),
  routeId: z.string(),
  direction: gatewayDeliveryDirectionSchema,
  status: gatewayDeliveryStatusSchema,
  body: z.string(),
  threadId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  processId: z.string().nullable().optional(),
  errorText: z.string().nullable().optional(),
  createdAt: z.string(),
  processedAt: z.string().nullable().optional(),
  metadata: metadataSchema,
})
export type GatewayDeliveryRecord = z.infer<typeof gatewayDeliveryRecordSchema>

export const workspaceFileRecordSchema = z.object({
  path: z.string(),
  size: z.number().nonnegative(),
  mtimeMs: z.number().nonnegative(),
})
export type WorkspaceFileRecord = z.infer<typeof workspaceFileRecordSchema>

export const sessionWorkspaceRecordSchema = z.object({
  sessionId: z.string(),
  rootPath: z.string(),
  snapshotStrategy: z.string(),
  lastSnapshotId: z.string().nullable().optional(),
  boundAt: z.string(),
  updatedAt: z.string(),
  metadata: metadataSchema,
})
export type SessionWorkspaceRecord = z.infer<typeof sessionWorkspaceRecordSchema>

export const sessionSnapshotRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  label: z.string(),
  summary: z.string().nullable().optional(),
  rootPath: z.string(),
  gitBranch: z.string().nullable().optional(),
  gitCommit: z.string().nullable().optional(),
  gitStatus: z.array(z.string()),
  manifest: z.array(workspaceFileRecordSchema),
  createdAt: z.string(),
  restoredAt: z.string().nullable().optional(),
  metadata: metadataSchema,
})
export type SessionSnapshotRecord = z.infer<typeof sessionSnapshotRecordSchema>

export const processRecordSchema = z.object({
  id: z.string(),
  threadId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  label: z.string(),
  owner: z.string(),
  status: processStatusSchema,
  activeTaskId: z.string().nullable().optional(),
  lastAssignedAt: z.string().nullable().optional(),
  heartbeatAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: metadataSchema,
})
export type ProcessRecord = z.infer<typeof processRecordSchema>

export const supervisorLeaseRecordSchema = z.object({
  name: z.string(),
  owner: z.string(),
  leaseExpiresAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: metadataSchema,
})
export type SupervisorLeaseRecord = z.infer<typeof supervisorLeaseRecordSchema>

export const messageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string().nullable().optional(),
  role: messageRoleSchema,
  content: z.string(),
  createdAt: z.string(),
})
export type MessageRecord = z.infer<typeof messageRecordSchema>

export const artifactRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sessionId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  kind: artifactKindSchema,
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
})
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>

export const approvalRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  resource: z.string(),
  decision: z.enum(["allow", "deny"]),
  scope: approvalScopeSchema,
  reason: z.string().nullable().optional(),
  createdAt: z.string(),
})
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>

export const eventRecordSchema = z.object({
  id: z.string(),
  threadId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})
export type EventRecord = z.infer<typeof eventRecordSchema>
