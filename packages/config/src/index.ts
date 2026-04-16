import fs from "node:fs/promises"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"

const providerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
})

const workerConfigSchema = z.object({
  daemonPollMs: z.number().int().positive().default(2000),
  cronPollMs: z.number().int().positive().default(5000),
})

export const configSchema = z.object({
  dataDir: z.string().optional(),
  dbPath: z.string().optional(),
  defaultProvider: z.string().default("mock"),
  defaultModel: z.string().default("mock/default"),
  workers: workerConfigSchema.default({
    daemonPollMs: 2000,
    cronPollMs: 5000,
  }),
  providers: z
    .object({
      mock: providerConfigSchema.default({ enabled: true }),
      openai: providerConfigSchema.optional(),
      anthropic: providerConfigSchema.optional(),
      openaiCompatible: providerConfigSchema.optional(),
    })
    .default({
      mock: { enabled: true },
    }),
})

export type AgentOsConfig = z.infer<typeof configSchema>

export type ResolvedAgentOsConfig = AgentOsConfig & {
  configPath: string
  dataDir: string
  dbPath: string
}

export async function loadConfig(input: { cwd?: string; configPath?: string } = {}): Promise<ResolvedAgentOsConfig> {
  const cwd = input.cwd ?? process.cwd()
  const dataDir = path.join(cwd, ".opencode-agent-os")
  const configPath = input.configPath ?? path.join(dataDir, "config.jsonc")

  let parsed: unknown = {}
  try {
    const content = await fs.readFile(configPath, "utf8")
    parsed = parseJsonc(content)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== "ENOENT") throw error
  }

  const result = configSchema.parse(parsed)
  return {
    ...result,
    configPath,
    dataDir: result.dataDir ?? dataDir,
    dbPath: result.dbPath ?? path.join(result.dataDir ?? dataDir, "state.db"),
  }
}

export async function ensureConfigLayout(config: ResolvedAgentOsConfig) {
  await fs.mkdir(config.dataDir, { recursive: true })
}
