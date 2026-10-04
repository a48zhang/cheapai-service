import {
  normalizeCheapAiBaseURL,
} from './provider.ts'
import { DesktopAccountApiError } from './account-client.ts'
import type {
  CheapAiApiProtocol,
  CheapAiModelProfile,
} from './provider.ts'

const MAX_MODEL_CATALOG_BYTES = 4 * 1024 * 1024
const ANTHROPIC_MODEL_PAGE_LIMIT = 1000
const ANTHROPIC_VERSION = '2023-06-01'

export interface DiscoverCheapAiModelsOptions {
  /** DSH provider base URL, including any API prefix such as `/v1`. */
  baseURL: string
  /** Explicit provider protocol; discovery does not infer it from the URL. */
  api: CheapAiApiProtocol
  /** Resolve the currently valid private key for this discovery request. */
  getKey: () => Promise<string | undefined>
  signal?: AbortSignal
}

interface ModelListingEntry extends Record<string, unknown> {
  id?: unknown
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  max_tokens?: unknown
  limit?: { context?: unknown; output?: unknown } | null
  top_provider?: { max_completion_tokens?: unknown } | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function label(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function positiveInteger(...values: readonly unknown[]): number | undefined {
  return values.find((value): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0)
}

function listingUrl(baseURL: string, api: CheapAiApiProtocol): string {
  const base = normalizeCheapAiBaseURL(baseURL)
  if (api !== 'anthropic-messages') return `${base}/models`

  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${ANTHROPIC_MODEL_PAGE_LIMIT}`
}

function authorizationHeaders(api: CheapAiApiProtocol, key: string): HeadersInit {
  if (key.length === 0 || /[\r\n]/.test(key)) {
    throw new Error('CheapAI credential is empty or contains invalid header characters')
  }
  return api === 'anthropic-messages'
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    : { authorization: `Bearer ${key}` }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_CATALOG_BYTES) {
    await response.body?.cancel()
    throw new Error(`CheapAI model catalog exceeds ${MAX_MODEL_CATALOG_BYTES} bytes`)
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MODEL_CATALOG_BYTES) {
        throw new Error(`CheapAI model catalog exceeds ${MAX_MODEL_CATALOG_BYTES} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function parseModels(body: unknown): CheapAiModelProfile[] {
  const listing = record(body)
  const rows = listing?.data
  let entries: { mapKey?: string; value: unknown }[]
  if (Array.isArray(rows)) {
    entries = rows.map((value) => ({ value }))
  } else {
    const models = record(listing?.models)
    if (models === undefined) {
      throw new Error('CheapAI model catalog must contain a data array or models object')
    }
    entries = Object.entries(models)
      .filter(([, value]) => record(value) !== undefined)
      .map(([mapKey, value]) => ({ mapKey, value }))
  }

  const result: CheapAiModelProfile[] = []
  const seen = new Set<string>()
  for (const { mapKey, value } of entries) {
    const entry = record(value) as ModelListingEntry | undefined
    const id = label(mapKey, entry?.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)

    const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id
    const contextWindow = positiveInteger(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = positiveInteger(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    result.push({
      id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
  }
  return result
}

/**
 * Fetch one page of the endpoint's advertised model directory. The key source
 * runs for every invocation and the key is used only in that HTTP request; the
 * result contains no credential and makes no claims about unlisted context,
 * modalities, or model-specific tool support.
 */
export async function discoverCheapAiModels(
  options: DiscoverCheapAiModelsOptions,
): Promise<CheapAiModelProfile[]> {
  const url = listingUrl(options.baseURL, options.api)
  const key = await options.getKey()
  if (key === undefined || key.length === 0) {
    throw new Error('CheapAI model discovery requires a current API key')
  }
  if (options.signal?.aborted) throw options.signal.reason

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: authorizationHeaders(options.api, key),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    throw new DesktopAccountApiError('network')
  }

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`CheapAI model catalog returned HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = JSON.parse(await readBoundedBody(response)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('CheapAI model catalog returned invalid JSON', { cause: error })
    }
    throw error
  }

  const models = parseModels(body)
  if (models.length === 0) throw new DesktopAccountApiError('noModels')
  return models
}
