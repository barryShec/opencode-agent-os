import { z } from "zod"

export const permissionActionSchema = z.enum(["allow", "ask", "deny"])
export type PermissionAction = z.infer<typeof permissionActionSchema>

export const permissionRuleSchema = z.object({
  resource: z.string(),
  action: permissionActionSchema,
})
export type PermissionRule = z.infer<typeof permissionRuleSchema>

export function matchesPermission(resource: string, pattern: string) {
  if (pattern === "*") return true
  if (pattern.endsWith("*")) return resource.startsWith(pattern.slice(0, -1))
  return resource === pattern
}

export function evaluatePermission(rules: PermissionRule[], resource: string, fallback: PermissionAction = "ask") {
  let best = -1
  let action: PermissionAction = fallback

  for (const rule of rules) {
    if (!matchesPermission(resource, rule.resource)) continue
    if (rule.resource.length < best) continue
    best = rule.resource.length
    action = rule.action
  }

  return action
}
