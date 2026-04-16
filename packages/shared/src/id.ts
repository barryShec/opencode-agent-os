import { ulid } from "ulid"

export type RuntimeObjectKind =
  | "thread"
  | "session"
  | "task"
  | "run"
  | "snapshot"
  | "process"
  | "automation"
  | "route"
  | "delivery"
  | "message"
  | "artifact"
  | "approval"
  | "event"

export function createId(kind: RuntimeObjectKind) {
  return `${kind}_${ulid().toLowerCase()}`
}

export function nowIso() {
  return new Date().toISOString()
}
