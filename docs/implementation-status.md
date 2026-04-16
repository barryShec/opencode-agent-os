# Implementation Status

## Done

- monorepo scaffold with Bun workspace and Turbo
- local config loader
- SQLite state store
- thread/session/run/message/artifact/approval/event persistence
- task persistence plus dependency edges
- run-to-task linkage in storage and runner
- task assignment leases, attempt counting, retry scheduling/backoff, cancellation markers, and last-run tracking
- mock provider and AI SDK provider registry
- typed local tool registry
- task readiness graph view and task start/status transitions
- evaluator registry with persisted evaluator results
- workspace binding, snapshot capture, and logical restore for sessions
- supervisor lease plus fair task-to-process assignment
- executor-only process orchestration for assigned tasks
- durable automation records and due-run execution
- persistent gateway routes and deliveries
- daemon, cron, and supervisor worker entrypoints
- CLI for thread, session, task, prompt run, tool run, evaluator run/results, workspace, snapshot, automation, gateway, process, and supervisor flows

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
  - has task objects, statuses, dependencies, readiness calculation, leases, retries/backoff, cancellation flags, and evaluator-driven repair scheduling
  - does not yet have scheduler class lanes, priority aging policy, or richer dead-letter routing

- `evaluators`
  - has deterministic built-ins and durable results
  - now gates task completion and retry transitions
  - does not yet expose richer verifier contracts, cross-run comparison, or policy thresholds

- `runtime-supervisor`
  - has a single active leader lease, stale assignment recovery, and fair assignment across idle processes
  - does not yet have hierarchical pools, preemption classes, or distributed election beyond SQLite lease semantics

- `runtime-process`
  - can start/heartbeat/stop a process and execute only the task assigned to it
  - renews assignment leases while running and leaves scheduling to the supervisor
  - does not yet have multi-slot local concurrency or mid-run hard preemption

- `automation`
  - can schedule `task-prompt` and `process-run-once` actions with persisted due times
  - now enqueues work and optionally nudges the supervisor instead of directly running a process
  - does not yet support cron expressions, jitter, or complex workflows

- `gateway-core`
  - can persist routes and deliveries, turn inbound messages into tasks, and optionally nudge the supervisor
  - does not yet expose HTTP/websocket servers, auth, or channel-specific adapters

- `workers/daemon`
  - can repeatedly execute the task currently assigned to one process
  - does not yet host multiple local slots per process

- `workers/cron`
  - can repeatedly enqueue due automations
  - does not yet have distributed locking, missed-run replay policy, or RRULE/cron parsing

- `workers/supervisor`
  - can repeatedly acquire leadership and assign ready tasks to idle processes
  - does not yet have shard-aware fairness, process classes, or remote queue backplanes

- `storage`
  - good enough for early Phase 4
  - still uses Node experimental SQLite, basic locking semantics, and a rough dist layout for workspace packages

## Not Started Yet

- `memory`
- `skills`
- `apps/gateway`
- `apps/control-plane`
- `workers/janitor`

## Highest-Leverage Next Work

### 1. Connect tasks to execution

Missing:

- richer fairness classes and pools
- stronger cancellation checkpoints inside multi-step runs
- dead-letter routing policies and replay controls
- process sharding beyond single SQLite lease

Why next:

- thread/session/run/task/process become one coherent runtime only after supervisor-led execution is first-class

### 2. Add evaluator surfaces

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

1. HTTP/websocket adapters in `apps/gateway` on top of `packages/gateway-core`
2. richer fairness lanes, cancellation checkpoints, and dead-letter policy in `packages/runtime-supervisor` + `packages/runtime-task`
3. cron expression support, missed-run policy, and distributed locking in `packages/automation` + `workers/cron`
4. `memory` and file-level workspace restore
