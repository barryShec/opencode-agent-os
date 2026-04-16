import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { z, type ZodType } from "zod"

export interface ToolExecutionContext {
  cwd: string
  authorize(resource: string): Promise<void>
}

export interface ToolExecutionResult {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

export interface ToolDefinition<TArgs> {
  name: string
  description: string
  argsSchema: ZodType<TArgs>
  resource(args: TArgs, ctx: ToolExecutionContext): string
  execute(args: TArgs, ctx: ToolExecutionContext): Promise<ToolExecutionResult>
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown>>()

  register<TArgs>(tool: ToolDefinition<TArgs>) {
    this.tools.set(tool.name, tool as ToolDefinition<unknown>)
  }

  list() {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
    }))
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolExecutionContext) {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }

    const args = tool.argsSchema.parse(rawArgs)
    await ctx.authorize(tool.resource(args, ctx))
    return tool.execute(args, ctx)
  }
}

export function createDefaultToolRegistry() {
  const registry = new ToolRegistry()

  registry.register({
    name: "echo",
    description: "Return text directly. Useful for contract and output plumbing tests.",
    argsSchema: z.object({
      text: z.string(),
    }),
    resource: () => "tool:echo",
    async execute(args) {
      return {
        title: "echo",
        output: args.text,
      }
    },
  })

  registry.register({
    name: "list-files",
    description: "List files in a directory relative to the active workspace.",
    argsSchema: z.object({
      path: z.string().default("."),
    }),
    resource: (args, ctx) => `fs:list:${path.resolve(ctx.cwd, args.path)}`,
    async execute(args, ctx) {
      const target = path.resolve(ctx.cwd, args.path)
      const entries = await fs.readdir(target, { withFileTypes: true })
      const lines = entries.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      return {
        title: `list-files ${args.path}`,
        output: lines.join("\n") || "(empty)",
        metadata: {
          path: target,
          count: entries.length,
        },
      }
    },
  })

  registry.register({
    name: "read-file",
    description: "Read a UTF-8 file from the active workspace.",
    argsSchema: z.object({
      path: z.string(),
      limit: z.number().int().positive().default(4000),
    }),
    resource: (args, ctx) => `fs:read:${path.resolve(ctx.cwd, args.path)}`,
    async execute(args, ctx) {
      const target = path.resolve(ctx.cwd, args.path)
      const content = await fs.readFile(target, "utf8")
      return {
        title: `read-file ${args.path}`,
        output: content.slice(0, args.limit),
        metadata: {
          path: target,
          truncated: content.length > args.limit,
        },
      }
    },
  })

  registry.register({
    name: "bash",
    description: "Run a shell command inside the active workspace.",
    argsSchema: z.object({
      command: z.string(),
      cwd: z.string().optional(),
    }),
    resource: () => "tool:bash",
    async execute(args, ctx) {
      const cwd = args.cwd ? path.resolve(ctx.cwd, args.cwd) : ctx.cwd
      const result = await runShell(args.command, cwd)
      return {
        title: `bash ${args.command}`,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
        metadata: {
          cwd,
          exitCode: result.exitCode,
        },
      }
    },
  })

  return registry
}

function runShell(command: string, cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      })
    })
  })
}
