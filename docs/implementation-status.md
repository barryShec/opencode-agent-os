# Implementation Status

## Done

- monorepo scaffold with Bun workspace and Turbo
- local config loader
- SQLite state store
- thread/session/run/message/artifact/approval/event persistence
- task persistence plus dependency edges
- run-to-task linkage in storage and runner
- task lease/claim, attempt counting, retry scheduling, and last-run tracking
- mock provider and AI SDK provider registry
- typed local tool registry
- task readiness graph view and task start/status transitions
- evaluator registry with persisted evaluator results
- workspace binding, snapshot capture, and logical restore for sessions
- single-process task claim-and-run orchestration
- durable automation records and due-run execution
- persistent gateway routes and deliveries
- daemon and cron worker entrypoints
- CLI for thread, session, task, prompt run, tool run, evaluator run/results, workspace, snapshot, automation, gateway, and process flows

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
  - has task objects, statuses, dependencies, readiness calculation, leases, retries, and evaluator-driven repair scheduling
  - does not yet have durable scheduler queues, backoff policy, or parallel worker balancing

- `evaluators`
  - has deterministic built-ins and durable results
  - now gates task completion and retry transitions
  - does not yet expose richer verifier contracts, cross-run comparison, or policy thresholds

- `runtime-process`
  - can start/heartbeat/stop a process and run one ready task through the runner
  - now has a simple daemon worker loop on top
  - does not yet have multi-task concurrency, cancellation, or distributed coordination

- `automation`
  - can schedule `task-prompt` and `process-run-once` actions with persisted due times
  - does not yet support cron expressions, backoff, jitter, or complex workflows

- `gateway-core`
  - can persist routes and deliveries, turn inbound messages into tasks, and optionally auto-dispatch a process
  - does not yet expose HTTP/websocket servers, auth, or channel-specific adapters

- `workers/daemon`
  - can repeatedly invoke `process.runOnce`
  - does not yet have supervision, locks, or lease-aware multi-process balancing

- `workers/cron`
  - can repeatedly execute due automations
  - does not yet have distributed locking, missed-run replay policy, or RRULE/cron parsing

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

- multi-task daemon loop
- backoff policy and retry classes
- cancellation and dead-letter handling
- multi-worker fairness

Why next:

- thread/session/run/task become one coherent runtime only after task execution is first-class

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
2. cron expression support, missed-run policy, and distributed locking in `packages/automation` + `workers/cron`
3. richer repair policies and evaluator bundles
4. `memory` and file-level workspace restore
