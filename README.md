# opencode-agent-os

`opencode-agent-os` is a TypeScript-first agent operating system design that keeps
`opencode` as the session-native kernel and layers in the strongest long-running
capabilities from `hermes-agent`.

The implementation plan lives in [docs/opencode-agent-os-architecture.md](docs/opencode-agent-os-architecture.md).

Current repo status:

- Phase 4 outer runtime baseline implemented
- Bun workspace scaffold plus Node runtime execution
- architecture and phase plan for a runtime-native hybrid harness

Implemented now:

- `shared`: ids, record contracts, permission rules
- `config`: local JSONC config loader
- `storage`: SQLite-backed thread/session/run/message/artifact store
- `provider`: mock plus AI SDK provider registry
- `tools`: typed tool registry with `echo`, `list-files`, `read-file`, `bash`
- `runtime-thread`: thread ledger service
- `runtime-session`: session lifecycle, permission approval flow, workspace binding, snapshot capture, and logical restore
- `runtime-task`: task records, dependency edges, readiness view, lease/claim, attempts/retry, and run lifecycle coordination
- `runtime-runner`: prompt runs and explicit tool runs with task lifecycle hooks
- `runtime-process`: single-process claim-and-run orchestration for session-scoped tasks
- `automation`: durable recurring actions for `task-prompt` and `process-run-once`
- `gateway-core`: persistent routes and deliveries with task creation plus optional process auto-dispatch
- `evaluators`: evaluator registry plus persisted evaluator results
- `workers/daemon`: loop-based process host for repeated `runOnce`
- `workers/cron`: loop-based due automation runner
- `apps/cli`: single-session/process CLI with thread, session, task, run, tool, evaluator, workspace, snapshot, automation, gateway, and process commands

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
node apps/cli/dist/apps/cli/src/index.js process run-once --process <processId> --provider mock --model mock/default
node apps/cli/dist/apps/cli/src/index.js automation create task-prompt --session <sessionId> --process <processId> --interval-seconds 60 --prompt "..."
node apps/cli/dist/apps/cli/src/index.js gateway route create --channel cli --address demo --process <processId>
node workers/daemon/dist/workers/daemon/src/index.js --process <processId> --iterations 1
node workers/cron/dist/workers/cron/src/index.js --iterations 1
```

Open status and remaining work:

- [implementation-status.md](docs/implementation-status.md)
