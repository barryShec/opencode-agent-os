import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const namespaceDir = path.join(root, "node_modules", "@opencode-agent-os")

const packages = [
  ["automation", "packages/automation"],
  ["config", "packages/config"],
  ["evaluators", "packages/evaluators"],
  ["gateway-core", "packages/gateway-core"],
  ["provider", "packages/provider"],
  ["runtime-process", "packages/runtime-process"],
  ["runtime-runner", "packages/runtime-runner"],
  ["runtime-session", "packages/runtime-session"],
  ["runtime-supervisor", "packages/runtime-supervisor"],
  ["runtime-task", "packages/runtime-task"],
  ["runtime-thread", "packages/runtime-thread"],
  ["shared", "packages/shared"],
  ["storage", "packages/storage"],
  ["tools", "packages/tools"],
]

await fs.mkdir(namespaceDir, { recursive: true })

for (const [name, relativeTarget] of packages) {
  const target = path.join(root, relativeTarget)
  const linkPath = path.join(namespaceDir, name)

  await fs.rm(linkPath, { recursive: true, force: true })
  await fs.symlink(target, linkPath, "dir")
}
