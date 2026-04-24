# opencode-agent-os

`opencode-agent-os` is a TypeScript-first agent operating system design that keeps
`opencode` as the session-native kernel and layers in the strongest long-running
capabilities from `hermes-agent`.

The implementation plan lives in [docs/opencode-agent-os-architecture.md](docs/opencode-agent-os-architecture.md).

Current repo status:

- supervisor-led Phase 4 runtime baseline implemented
- HTTP gateway app and deterministic thread memory surfaces implemented
- janitor runtime package and worker implemented for stale-runtime recovery
- Bun workspace scaffold plus Node runtime execution
- end-to-end single-machine flow verified: gateway -> supervisor -> executor -> memory
- end-to-end runtime hygiene verified: stale processes recovered, orphaned task assignments requeued, broken automations auto-paused
- architecture and phase plan for a runtime-native hybrid harness

Implemented now:

- `shared`: ids, record contracts, permission rules
- `config`: local JSONC config loader
- `storage`: SQLite-backed thread/session/run/message/artifact store
- `provider`: mock plus AI SDK provider registry
- `tools`: typed tool registry with `echo`, `list-files`, `read-file`, `bash`
- `runtime-thread`: thread ledger service
- `runtime-session`: session lifecycle, permission approval flow, workspace binding, snapshot capture, and logical restore
- `runtime-task`: task records, dependency edges, readiness view, assignment leases, scheduling classes, retry/backoff, cancellation flags, dead-letter markers, and run lifecycle coordination
- `runtime-runner`: prompt runs and explicit tool runs with task lifecycle hooks
- `runtime-janitor`: stale process recovery, orphaned task/run cleanup, and automation failure-streak pausing
- `runtime-process`: executor host that only runs supervisor-assigned tasks
- `runtime-supervisor`: leader lease, stale assignment recovery, stale-idle-process exclusion, process-class filtering, starvation-aware weighting, and fair task-to-process scheduling
- `automation`: durable recurring actions that enqueue work, stamp scheduling class, track failure streaks, and optionally nudge the supervisor
- `gateway-core`: persistent routes and deliveries with task creation, interactive scheduling class defaults, and optional supervisor wakeup
- `memory`: deterministic thread recall, keyword search, and summary generation over tasks, messages, artifacts, and snapshots
- `evaluators`: evaluator registry plus persisted evaluator results
- `workers/daemon`: executor worker for repeated assigned-task execution
- `workers/cron`: due automation worker that enqueues work
- `workers/janitor`: runtime hygiene worker for stale executor recovery and automation pausing
- `workers/supervisor`: single active scheduler loop
- `apps/cli`: CLI with thread, session, task, run, tool, evaluator, workspace, snapshot, automation, gateway, memory, process, and supervisor commands
- `apps/control-plane`: HTTP admin API for runtime status, process/task inspection, dead-letter visibility, task replay/cancel operations, and manual supervisor ticks
- `apps/gateway`: HTTP API for health, threads/tasks, gateway routes/deliveries, memory recall/search/summary, and manual supervisor ticks

Build and verify:

```bash
bun install
bun run typecheck
bun run build
```

Run the compiled CLI:

```bash
node apps/cli/dist/apps/cli/src/index.js init
node apps/cli/dist/apps/cli/src/index.js run prompt --prompt "Design a session kernel" --provider mock --model mock/default
node apps/cli/dist/apps/cli/src/index.js thread list
node apps/cli/dist/apps/cli/src/index.js task create --thread <threadId> --title "Implement task graph"
node apps/cli/dist/apps/cli/src/index.js task list --thread <threadId>
node apps/cli/dist/apps/cli/src/index.js session workspace bind --session <sessionId> --root /path/to/repo
node apps/cli/dist/apps/cli/src/index.js session snapshot create --session <sessionId> --label baseline
node apps/cli/dist/apps/cli/src/index.js task ready --thread <threadId>
node apps/cli/dist/apps/cli/src/index.js evaluator list
node apps/cli/dist/apps/cli/src/index.js evaluator run --task <taskId> --name task-has-run
node apps/cli/dist/apps/cli/src/index.js process start --session <sessionId> --owner runner
node apps/cli/dist/apps/cli/src/index.js supervisor tick
node apps/cli/dist/apps/cli/src/index.js process run-once --process <processId> --provider mock --model mock/default
node apps/cli/dist/apps/cli/src/index.js memory recall --thread <threadId>
node apps/cli/dist/apps/cli/src/index.js memory search --thread <threadId> --keyword "gateway"
node apps/cli/dist/apps/cli/src/index.js memory summarize --thread <threadId> --record
node apps/cli/dist/apps/cli/src/index.js janitor tick
node apps/cli/dist/apps/cli/src/index.js automation create task-prompt --session <sessionId> --process <processId> --interval-seconds 60 --prompt "..."
node apps/cli/dist/apps/cli/src/index.js gateway route create --channel cli --address demo --process <processId>
node apps/control-plane/dist/apps/control-plane/src/index.js --port 8788
node apps/gateway/dist/apps/gateway/src/index.js --port 8787
node workers/janitor/dist/workers/janitor/src/index.js --iterations 1
node workers/supervisor/dist/workers/supervisor/src/index.js --iterations 1
node workers/daemon/dist/workers/daemon/src/index.js --process <processId> --iterations 1
node workers/cron/dist/workers/cron/src/index.js --iterations 1
```

Recently verified end-to-end:

- create a thread and process from the compiled CLI
- submit a prompt through `apps/gateway`
- turn the inbound delivery into a task
- assign it via `/supervisor/tick`
- execute it once through `workers/daemon`
- inspect the resulting thread state through both HTTP memory endpoints and CLI memory commands
- inspect and intervene on runtime state through `apps/control-plane`
- run janitor recovery through `/janitor/tick` and pause unhealthy automations

Open status and remaining work:

- [implementation-status.md](docs/implementation-status.md)
