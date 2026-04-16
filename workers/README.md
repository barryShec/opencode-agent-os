# workers

Background workers stay separate from user-facing apps.

Current workers:

- `daemon`: long-lived loop over `runtime-process.runOnce`
- `cron`: loop over due automations in `packages/automation`

Still planned:

- `janitor`: cleanup, drift control, and governance loops
