import { CHEAPAI_API_KEY_CREDENTIAL_REF } from '../dsh/config.ts'

/** Protocols the pinned DSH pi-ai provider accepts for a custom route. */
export type CheapAiApiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'

/** Facts the DSH model profile can describe without inventing capabilities. */
export interface CheapAiModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface CheapAiProviderProfileOptions {
  /** DSH provider base URL, including any API prefix such as `/v1`. */
  baseURL: string
  /** Wire protocol selected for this gateway. */
  api: CheapAiApiProtocol
  /** Models already discovered or explicitly configured for this route. */
  models: readonly CheapAiModelProfile[]
}

export interface CheapAiProviderProfileFragment {
  providers: {
    cheapai: {
      displayName: 'cheapai'
      apiKeyEnv: typeof CHEAPAI_API_KEY_CREDENTIAL_REF
      baseURL: string
      api: CheapAiApiProtocol
      models: CheapAiModelProfile[]
    }
  }
}

/**
 * Validate and normalize a DSH provider base URL without dropping path prefixes.
 * Credentials belong in the credential store, never in the endpoint URL.
 */
export function normalizeCheapAiBaseURL(baseURL: string): string {
  if (baseURL.length === 0 || baseURL.trim() !== baseURL) {
    throw new Error('CheapAI base URL must be a non-empty URL without surrounding whitespace')
  }

  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error('CheapAI base URL must be an absolute HTTP or HTTPS URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CheapAI base URL must use HTTP or HTTPS')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('CheapAI base URL cannot contain credentials, a query, or a fragment')
  }

  return baseURL.replace(/\/+$/, '')
}

/**
 * Build the pinned DSH `llm-pi-ai` profile fragment for the cheapai route.
 * The route is only admitted after discovery or explicit model configuration;
 * its `apiKeyEnv` is a credential reference, not a key snapshot.
 */
export function createCheapAiProviderProfile(
  options: CheapAiProviderProfileOptions,
): CheapAiProviderProfileFragment {
  const baseURL = normalizeCheapAiBaseURL(options.baseURL)
  if (options.models.length === 0) {
    throw new Error('CheapAI provider requires at least one discovered or configured model')
  }

  const ids = new Set<string>()
  const models = options.models.map((model) => {
    if (model.id.length === 0 || model.id.trim() !== model.id) {
      throw new Error('CheapAI model ids must be non-empty strings without surrounding whitespace')
    }
    if (ids.has(model.id)) throw new Error(`CheapAI model id is duplicated: ${model.id}`)
    ids.add(model.id)

    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`CheapAI model ${model.id} has an empty display name`)
    }
    for (const [field, value] of [
      ['contextWindow', model.contextWindow],
      ['maxTokens', model.maxTokens],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new Error(`CheapAI model ${model.id} has an invalid ${field}`)
      }
    }

    return { ...model }
  })

  return {
    providers: {
      cheapai: {
        displayName: 'cheapai',
        apiKeyEnv: CHEAPAI_API_KEY_CREDENTIAL_REF,
        baseURL,
        api: options.api,
        models,
      },
    },
  }
}
