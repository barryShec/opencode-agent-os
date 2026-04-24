# Implementation Status

## Done

- monorepo scaffold with Bun workspace and Turbo
- local config loader
- SQLite state store
- thread/session/run/message/artifact/approval/event persistence
- task persistence plus dependency edges
- run-to-task linkage in storage and runner
- task assignment leases, attempt counting, retry scheduling/backoff, cancellation markers, scheduling classes, dead-letter markers, and last-run tracking
- mock provider and AI SDK provider registry
- typed local tool registry
- task readiness graph view and task start/status transitions
- evaluator registry with persisted evaluator results
- workspace binding, snapshot capture, and logical restore for sessions
- supervisor lease plus fair task-to-process assignment with class-aware and starvation-aware weighting
- janitor runtime recovery for stale processes, orphaned task assignments, stale runs, and automation failure streaks
- executor-only process orchestration for assigned tasks
- durable automation records and due-run execution
- persistent gateway routes and deliveries
- deterministic thread memory recall, search, and summary
- HTTP control-plane app for runtime status, process/task inspection, and operator interventions
- HTTP gateway app for threads, tasks, routes, deliveries, memory, and supervisor tick
- daemon, cron, janitor, and supervisor worker entrypoints
- CLI for thread, session, task, prompt run, tool run, evaluator run/results, workspace, snapshot, automation, gateway, memory, process, and supervisor flows
- end-to-end verified flow: gateway message -> task -> supervisor assignment -> daemon execution -> memory recall
- end-to-end verified runtime hygiene flow: stale idle process not scheduled, stale assigned process requeued, broken automation auto-paused

## Partially Done

These exist, but are still below the intended architecture bar:

- `runtime-thread`
  - has ledger objects and events
  - does not yet have summaries, rollback checkpoints, or handoff records

- `runtime-session`
  - has mode, permission handling, workspace binding, snapshot capture, and logical restore
  - does not yet have file-level revert, snapshot diffing, compaction, or true workspace sync semantics

- `runtime-runner`
  - can run prompts and explicit tools
  - can attach runs to tasks
  - can drive task lifecycle hooks
  - does not yet implement a full agent loop with tool planning, multi-step repair, or stop-policy control

- `runtime-task`
  - has task objects, statuses, dependencies, readiness calculation, leases, retries/backoff, cancellation flags, scheduling classes, dead-letter markers, and evaluator-driven repair scheduling
  - does not yet have explicit pool hierarchies, hard preemption checkpoints, or richer dead-letter replay policy

- `evaluators`
  - has deterministic built-ins and durable results
  - now gates task completion and retry transitions
  - does not yet expose richer verifier contracts, cross-run comparison, or policy thresholds

- `runtime-supervisor`
  - has a single active leader lease, stale assignment recovery, stale-idle-process exclusion, accepted scheduling class filtering, starvation-aware weighting, and fair assignment across idle processes
  - does not yet have hierarchical pools, true preemption, or distributed election beyond SQLite lease semantics

- `runtime-janitor`
  - can mark stale processes unhealthy, recover orphaned task assignments, fail stale orphaned runs, and pause automations after repeated failures
  - is reusable from both the CLI/control-plane and the background worker
  - does not yet implement policy-driven replay, escalation routing, or summary compaction

- `runtime-process`
  - can start/heartbeat/stop a process and execute only the task assigned to it
  - renews assignment leases while running and leaves scheduling to the supervisor
  - does not yet have multi-slot local concurrency or mid-run hard preemption

- `automation`
  - can schedule `task-prompt` and `process-run-once` actions with persisted due times
  - now enqueues work and optionally nudges the supervisor instead of directly running a process
  - tracks consecutive failure streaks for janitor-driven pausing
  - does not yet support cron expressions, jitter, or complex workflows

- `gateway-core`
  - can persist routes and deliveries, turn inbound messages into tasks, stamp interactive scheduling class, and optionally nudge the supervisor
  - does not yet handle auth, channel-specific adapters, or websocket push

- `memory`
  - can deterministically reconstruct thread context from tasks, messages, artifacts, and snapshots
  - exposes recall, keyword search, and summary generation surfaces
  - does not yet support semantic retrieval, compaction policy, or background indexing

- `apps/gateway`
  - exposes HTTP routes for health, thread/task inspection, memory operations, route management, delivery listing, inbound message dispatch, and manual supervisor ticks
  - does not yet expose auth, websocket streaming, or multi-tenant policy enforcement

- `apps/control-plane`
  - exposes HTTP routes for runtime status, thread/session/task/process/automation inspection, dead-letter listing, task cancel/requeue/retry, manual supervisor ticks, and janitor ticks
  - keeps task/process state aligned when operator actions detach a task from an assigned executor
  - does not yet expose auth, RBAC, or batch remediation workflows

- `workers/daemon`
  - can repeatedly execute the task currently assigned to one process
  - does not yet host multiple local slots per process

- `workers/cron`
  - can repeatedly enqueue due automations
  - does not yet have distributed locking, missed-run replay policy, or RRULE/cron parsing

- `workers/janitor`
  - can repeatedly execute runtime hygiene passes over stale processes, orphaned tasks/runs, and unhealthy automations
  - does not yet implement tenant-aware policies or escalation sinks

- `workers/supervisor`
  - can repeatedly acquire leadership and assign ready tasks to idle processes
  - does not yet have shard-aware fairness, process classes, or remote queue backplanes

- `storage`
  - good enough for early Phase 4
  - still uses Node experimental SQLite, basic locking semantics, and a rough dist layout for workspace packages

## Not Started Yet

- `skills`

## Highest-Leverage Next Work

### 1. Strengthen supervisor orchestration

Missing:

- process pool hierarchies and fair-share budgets
- stronger cancellation checkpoints inside multi-step runs
- dead-letter routing policies and replay controls
- process sharding beyond single SQLite lease

Why next:

- thread/session/run/task/process become one coherent runtime only after supervisor-led execution is first-class beyond the current single-node lease model

### 2. Add richer evaluator surfaces

Missing:

- richer deterministic verification contract
- actual repair execution policies beyond retry scheduling
- gating policies on task transitions

Why next:

- this is the real bridge from Phase 1 to Phase 2

### 3. Add workspace-native session state

Missing:

- file-level restore
- diffed snapshots
- checkpoint compaction
- sync / checkout semantics

Why next:

- this is the most important missing piece if the goal is to stay faithful to `opencode` as kernel

### 4. Replace current runtime rough edges

Missing:

- non-experimental SQLite path or better DB adapter abstraction
- cleaner package build layout
- stronger multi-process DB contention handling

Why next:

- gateway, cron, and daemon work will stress these hard

## Suggested Immediate Next Phase

Build these next, in order:

1. process pools, preemption checkpoints, and dead-letter replay policy in `packages/runtime-supervisor` + `packages/runtime-task`
2. cron expression support, missed-run policy, and distributed locking in `packages/automation` + `workers/cron`
3. file-level workspace restore, diffed snapshots, and checkpoint compaction in `packages/runtime-session`
4. richer memory indexing / compaction, escalation/replay policy on top of janitor, and auth/RBAC for the HTTP surfaces
