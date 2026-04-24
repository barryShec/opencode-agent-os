import { RuntimeSupervisor } from "@opencode-agent-os/runtime-supervisor"
import { TaskService } from "@opencode-agent-os/runtime-task"
import type { GatewayDeliveryRecord, GatewayRouteRecord, TaskRecord } from "@opencode-agent-os/shared"
import { AgentOsDatabase } from "@opencode-agent-os/storage"

export class GatewayService {
  constructor(
    private readonly db: AgentOsDatabase,
    private readonly tasks: TaskService,
    private readonly supervisor: RuntimeSupervisor,
  ) {}

  createRoute(input: {
    channel: GatewayRouteRecord["channel"]
    address: string
    threadId?: string | null
    sessionId?: string | null
    processId?: string | null
    metadata?: GatewayRouteRecord["metadata"]
  }) {
    const route = this.db.createGatewayRoute({
      channel: input.channel,
      address: input.address,
      threadId: input.threadId ?? null,
      sessionId: input.sessionId ?? null,
      processId: input.processId ?? null,
      metadata: input.metadata ?? null,
    })

    this.db.recordEvent({
      threadId: route.threadId ?? null,
      sessionId: route.sessionId ?? null,
      type: "gateway.route.created",
      payload: {
        routeId: route.id,
        channel: route.channel,
        address: route.address,
      },
    })

    return route
  }

  listRoutes(input: { channel?: GatewayRouteRecord["channel"]; threadId?: string; sessionId?: string; processId?: string } = {}) {
    return this.db.listGatewayRoutes(input)
  }

  listDeliveries(input: { routeId?: string; status?: GatewayDeliveryRecord["status"] } = {}) {
    return this.db.listGatewayDeliveries(input)
  }

  async receiveMessage(input: {
    channel: GatewayRouteRecord["channel"]
    address: string
    body: string
    supervisorOwner?: string
  }) {
    const route = this.db.findGatewayRoute(input.channel, input.address)
    if (!route) {
      throw new Error(`No gateway route for ${input.channel}:${input.address}`)
    }

    const delivery = this.db.createGatewayDelivery({
      routeId: route.id,
      direction: "inbound",
      status: "received",
      body: input.body,
      threadId: route.threadId ?? null,
      sessionId: route.sessionId ?? null,
      processId: route.processId ?? null,
      metadata: null,
    })

    try {
      const detail = await this.dispatchInboundRoute(route, delivery, {
        supervisorOwner: input.supervisorOwner ?? `gateway:${route.id}`,
      })
      const updatedDelivery = this.db.updateGatewayDelivery(delivery.id, {
        status: "processed",
        processedAt: new Date().toISOString(),
      })
      this.db.recordEvent({
        threadId: route.threadId ?? null,
        sessionId: route.sessionId ?? null,
        type: "gateway.delivery.processed",
        payload: {
          routeId: route.id,
          deliveryId: updatedDelivery.id,
        },
      })
      return {
        route,
        delivery: updatedDelivery,
        detail,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const updatedDelivery = this.db.updateGatewayDelivery(delivery.id, {
        status: "failed",
        errorText: message,
        processedAt: new Date().toISOString(),
      })
      this.db.recordEvent({
        threadId: route.threadId ?? null,
        sessionId: route.sessionId ?? null,
        type: "gateway.delivery.failed",
        payload: {
          routeId: route.id,
          deliveryId: updatedDelivery.id,
          error: message,
        },
      })
      throw error
    }
  }

  private async dispatchInboundRoute(
    route: GatewayRouteRecord,
    delivery: GatewayDeliveryRecord,
    input: {
      supervisorOwner: string
    },
  ) {
    const process = route.processId ? this.db.getProcess(route.processId) : undefined
    const threadId = route.threadId ?? process?.threadId ?? null
    const sessionId = route.sessionId ?? process?.sessionId ?? null
    if (!threadId && !sessionId) {
      throw new Error(`Gateway route ${route.id} has no thread or session target`)
    }
    const resolvedThreadId = threadId ?? resolveThreadIdFromSession(this.db, sessionId)

    const task = this.tasks.createTask({
      threadId: resolvedThreadId,
      ...(sessionId ? { sessionId } : {}),
      title: summarizeInboundBody(delivery.body),
      description: delivery.body,
      metadata: buildGatewayTaskMetadata(route, delivery.body),
      evaluatorGate: "required",
      maxAttempts: 3,
    })

    const autoDispatch = route.processId || route.metadata?.autoDispatch === true
    if (!autoDispatch || !route.processId) {
      return task
    }

    return {
      task,
      schedule: this.supervisor.scheduleOnce({
        owner: input.supervisorOwner,
        processIds: [route.processId],
        preferredTaskIds: [task.task.id],
      }),
    }
  }
}

function summarizeInboundBody(body: string) {
  const normalized = body.replace(/\s+/g, " ").trim()
  if (normalized.length <= 48) return normalized || "Gateway message"
  return `${normalized.slice(0, 45)}...`
}

function buildGatewayTaskMetadata(route: GatewayRouteRecord, prompt: string): TaskRecord["metadata"] {
  return {
    source: "gateway",
    routeId: route.id,
    channel: route.channel,
    address: route.address,
    schedulingClass: "interactive",
    prompt,
  }
}

function resolveThreadIdFromSession(db: AgentOsDatabase, sessionId: string | null | undefined) {
  if (!sessionId) {
    throw new Error("Missing sessionId while resolving threadId")
  }
  const session = db.getSession(sessionId)
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`)
  }
  return session.threadId
}
