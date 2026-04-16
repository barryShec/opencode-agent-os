import { generateText, type LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { ResolvedAgentOsConfig } from "@opencode-agent-os/config"

export interface TextGenerationInput {
  prompt: string
  systemPrompt?: string
  modelName: string
  temperature?: number
  maxTokens?: number
}

export interface TextGenerationResult {
  providerName: string
  modelName: string
  text: string
  finishReason?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
}

export interface TextProvider {
  readonly name: string
  generate(input: TextGenerationInput): Promise<TextGenerationResult>
}

class MockProvider implements TextProvider {
  readonly name = "mock"

  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const system = input.systemPrompt ? ` [system:${input.systemPrompt.slice(0, 60)}]` : ""
    return {
      providerName: this.name,
      modelName: input.modelName,
      text: `MOCK${system} ${input.prompt}`.trim(),
      finishReason: "stop",
      usage: {
        inputTokens: input.prompt.length,
        outputTokens: input.prompt.length,
        totalTokens: input.prompt.length * 2,
      },
    }
  }
}

class OpenAIProvider implements TextProvider {
  readonly name = "openai"
  private readonly client

  constructor(apiKey: string, baseURL?: string) {
    this.client = createOpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    })
  }

  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const result = await generateText(buildGenerateArgs(this.client(input.modelName), input))

    return {
      providerName: this.name,
      modelName: input.modelName,
      text: result.text,
      finishReason: result.finishReason,
      usage: {
        inputTokens: result.usage?.promptTokens,
        outputTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
      },
    }
  }
}

class AnthropicProvider implements TextProvider {
  readonly name = "anthropic"
  private readonly client

  constructor(apiKey: string, baseURL?: string) {
    this.client = createAnthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    })
  }

  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const result = await generateText(buildGenerateArgs(this.client(input.modelName), input))

    return {
      providerName: this.name,
      modelName: input.modelName,
      text: result.text,
      finishReason: result.finishReason,
      usage: {
        inputTokens: result.usage?.promptTokens,
        outputTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
      },
    }
  }
}

class OpenAICompatibleProvider implements TextProvider {
  readonly name = "openaiCompatible"
  private readonly client

  constructor(apiKey: string, baseURL: string) {
    this.client = createOpenAICompatible({
      apiKey,
      baseURL,
      name: "opencode-agent-os",
    })
  }

  async generate(input: TextGenerationInput): Promise<TextGenerationResult> {
    const result = await generateText(buildGenerateArgs(this.client(input.modelName), input))

    return {
      providerName: this.name,
      modelName: input.modelName,
      text: result.text,
      finishReason: result.finishReason,
      usage: {
        inputTokens: result.usage?.promptTokens,
        outputTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens,
      },
    }
  }
}

function buildGenerateArgs(model: LanguageModel, input: TextGenerationInput) {
  return {
    model,
    prompt: input.prompt,
    ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, TextProvider>()

  static fromConfig(config: ResolvedAgentOsConfig) {
    const registry = new ProviderRegistry()
    registry.register(new MockProvider())

    const openai = config.providers.openai
    if (openai?.enabled !== false && openai?.apiKey) {
      registry.register(new OpenAIProvider(openai.apiKey, openai.baseURL))
    }

    const anthropic = config.providers.anthropic
    if (anthropic?.enabled !== false && anthropic?.apiKey) {
      registry.register(new AnthropicProvider(anthropic.apiKey, anthropic.baseURL))
    }

    const compatible = config.providers.openaiCompatible
    if (compatible?.enabled !== false && compatible?.apiKey && compatible?.baseURL) {
      registry.register(new OpenAICompatibleProvider(compatible.apiKey, compatible.baseURL))
    }

    return registry
  }

  register(provider: TextProvider) {
    this.providers.set(provider.name, provider)
  }

  get(providerName: string) {
    const provider = this.providers.get(providerName)
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`)
    }
    return provider
  }

  list() {
    return Array.from(this.providers.keys()).sort()
  }
}
