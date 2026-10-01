import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import type { Page } from './types.js';

export type Protocol = 'chat' | 'responses' | 'messages';
export type CapabilityFeature = 'streaming' | 'stream_usage' | 'tools' | 'tool_choice' | 'parallel_tools' | 'parallel_tool_control' | 'strict_tools'
  | 'image_url' | 'image_base64' | 'image_file_id' | 'image_detail' | 'tool_result_images' | 'tool_result_error' | 'refusal_history'
  | 'json_object' | 'json_schema' | 'reasoning_effort' | 'reasoning_summary' | 'reasoning_history' | 'thinking_budget' | 'thinking_adaptive' | 'thinking_control'
  | 'signed_thinking' | 'redacted_thinking' | 'encrypted_reasoning' | 'cache_control' | 'response_history' | 'item_references' | 'file_inputs' | 'file_references'
  | 'temperature' | 'top_p' | 'top_k' | 'stop_sequences' | 'seed' | 'penalties' | 'multiple_choices' | 'service_tier' | 'metadata' | 'message_names' | 'store'
  | 'verbosity' | 'citations' | 'logprobs' | 'system_developer_priority';
export type ExtensionScope = 'request' | 'message' | 'content' | 'image_source' | 'tool' | 'tool_function' | 'tool_call' | 'tool_choice' | 'response_format'
  | 'reasoning' | 'text' | 'thinking' | 'cache_control' | 'stream_options' | 'metadata' | 'output_config';
export interface ChannelCapabilities {
  readonly protocol: Protocol;
  readonly features: readonly CapabilityFeature[];
  readonly maxOutputTokens?: number;
  readonly reasoningEfforts?: readonly string[];
  readonly cacheTtls?: readonly ('5m' | '1h')[];
  readonly nativeExtensions?: readonly { readonly scope: ExtensionScope; readonly name: string }[];
}
export interface ModelView {
  readonly publicModelId: string;
  readonly status: 'active' | 'disabled';
  /** USD per million tokens, kept as decimal strings. */
  readonly sellPrices: Readonly<Record<string, string>>;
  readonly priceVersion: number;
  /** Integer USD smallest units, kept as a string. */
  readonly admissionMinBalanceUnits: string;
  readonly maxOutputTokens: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ModelInput {
  readonly publicModelId: string;
  readonly status?: 'active' | 'disabled';
  readonly sellPrices: Readonly<Record<string, string>>;
  readonly admissionMinBalanceUnits: string;
  readonly maxOutputTokens: number;
}
export type ModelPatch = Partial<Omit<ModelInput, 'publicModelId'>>;
export interface ModelMappingView {
  readonly channelId: string;
  readonly publicModelId: string;
  readonly protocol: Protocol;
  readonly upstreamModel: string;
  readonly capabilities: ChannelCapabilities;
  readonly configVersion: number;
}
export interface ModelMappingInput {
  readonly channelId: string;
  readonly protocol: Protocol;
  readonly upstreamModel: string;
  readonly capabilities: ChannelCapabilities;
}
export type ModelMappingPatch = Partial<Pick<ModelMappingInput, 'upstreamModel' | 'capabilities'>>;
export type ModelPage = Page<ModelView>;

export const BILLABLE_BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning'] as const;
export const CAPABILITY_FEATURES: readonly CapabilityFeature[] = ['streaming', 'stream_usage', 'tools', 'tool_choice', 'parallel_tools', 'parallel_tool_control', 'strict_tools',
  'image_url', 'image_base64', 'image_file_id', 'image_detail', 'tool_result_images', 'tool_result_error', 'refusal_history', 'json_object', 'json_schema', 'reasoning_effort',
  'reasoning_summary', 'reasoning_history', 'thinking_budget', 'thinking_adaptive', 'thinking_control', 'signed_thinking', 'redacted_thinking', 'encrypted_reasoning', 'cache_control',
  'response_history', 'item_references', 'file_inputs', 'file_references', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'seed', 'penalties', 'multiple_choices', 'service_tier',
  'metadata', 'message_names', 'store', 'verbosity', 'citations', 'logprobs', 'system_developer_priority'];
export const EXTENSION_SCOPES: readonly ExtensionScope[] = ['request', 'message', 'content', 'image_source', 'tool', 'tool_function', 'tool_call', 'tool_choice', 'response_format', 'reasoning', 'text', 'thinking', 'cache_control', 'stream_options', 'metadata', 'output_config'];

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const units = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^(?:0|-?[1-9][0-9]*)$/u.test(value);
const protocol = (value: unknown): value is Protocol => value === 'chat' || value === 'responses' || value === 'messages';
function invalid(): never { throw new TypeError('Invalid administrator model response.'); }
function prices(value: unknown): Readonly<Record<string, string>> {
  if (!object(value) || !Object.hasOwn(value, 'input') || !Object.hasOwn(value, 'output') || Object.keys(value).some(key => !BILLABLE_BUCKETS.includes(key as typeof BILLABLE_BUCKETS[number]))) invalid();
  for (const key of Object.keys(value)) if (!text(value[key], 18) || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u.test(value[key])) invalid();
  return Object.freeze(Object.fromEntries(Object.keys(value).map(key => [key, value[key]])) as Record<string, string>);
}
function decodeModel(value: unknown): ModelView {
  if (!object(value) || !text(value.publicModelId) || (value.status !== 'active' && value.status !== 'disabled') || !Object.hasOwn(value, 'sellPrices')
    || !count(value.priceVersion) || value.priceVersion < 1 || !units(value.admissionMinBalanceUnits) || value.admissionMinBalanceUnits.startsWith('-')
    || !count(value.maxOutputTokens) || value.maxOutputTokens < 1
    || !count(value.createdAt) || !count(value.updatedAt) || value.updatedAt < value.createdAt) invalid();
  return { publicModelId: value.publicModelId, status: value.status, sellPrices: prices(value.sellPrices), priceVersion: value.priceVersion,
    admissionMinBalanceUnits: value.admissionMinBalanceUnits, maxOutputTokens: value.maxOutputTokens,
    createdAt: value.createdAt, updatedAt: value.updatedAt };
}
export function decodeModelPage(value: unknown): ModelPage {
  if (!object(value) || !Array.isArray(value.items) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid();
  return { items: value.items.map(decodeModel), nextCursor: value.nextCursor };
}
function decodeCapabilities(value: unknown): ChannelCapabilities {
  if (!object(value) || !protocol(value.protocol) || !Array.isArray(value.features) || value.features.length > CAPABILITY_FEATURES.length
    || value.features.some(feature => typeof feature !== 'string' || !CAPABILITY_FEATURES.includes(feature as CapabilityFeature)) || new Set(value.features).size !== value.features.length) invalid();
  const result: { protocol: Protocol; features: CapabilityFeature[]; maxOutputTokens?: number; reasoningEfforts?: string[]; cacheTtls?: ('5m' | '1h')[]; nativeExtensions?: { scope: ExtensionScope; name: string }[] } = { protocol: value.protocol, features: [...value.features] as CapabilityFeature[] };
  if (Object.hasOwn(value, 'maxOutputTokens')) { if (!count(value.maxOutputTokens) || value.maxOutputTokens < 1) invalid(); result.maxOutputTokens = value.maxOutputTokens; }
  if (Object.hasOwn(value, 'reasoningEfforts')) { if (!Array.isArray(value.reasoningEfforts) || value.reasoningEfforts.length > 16 || value.reasoningEfforts.some(item => !text(item, 64))) invalid(); result.reasoningEfforts = [...value.reasoningEfforts] as string[]; }
  if (Object.hasOwn(value, 'cacheTtls')) { if (!Array.isArray(value.cacheTtls) || value.cacheTtls.length > 2 || value.cacheTtls.some(item => item !== '5m' && item !== '1h') || new Set(value.cacheTtls).size !== value.cacheTtls.length) invalid(); result.cacheTtls = [...value.cacheTtls] as ('5m' | '1h')[]; }
  if (Object.hasOwn(value, 'nativeExtensions')) {
    if (!Array.isArray(value.nativeExtensions) || value.nativeExtensions.length > 32) invalid();
    const seen = new Set<string>(); const extensions = value.nativeExtensions.map(entry => { if (!object(entry) || !EXTENSION_SCOPES.includes(entry.scope as ExtensionScope) || !text(entry.name, 64) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(entry.name)) invalid(); const id = `${entry.scope}:${entry.name}`; if (seen.has(id)) invalid(); seen.add(id); return { scope: entry.scope as ExtensionScope, name: entry.name }; });
    result.nativeExtensions = extensions;
  }
  return result;
}
function decodeMapping(value: unknown): ModelMappingView {
  if (!object(value) || !text(value.channelId) || !text(value.publicModelId) || !protocol(value.protocol) || !text(value.upstreamModel) || !count(value.configVersion) || value.configVersion < 1 || !Object.hasOwn(value, 'capabilities')) invalid();
  const capabilities = decodeCapabilities(value.capabilities); if (capabilities.protocol !== value.protocol) invalid();
  return { channelId: value.channelId, publicModelId: value.publicModelId, protocol: value.protocol, upstreamModel: value.upstreamModel, capabilities, configVersion: value.configVersion };
}
function decodeMappings(value: unknown): { items: readonly ModelMappingView[] } {
  if (!object(value) || !Array.isArray(value.items)) invalid(); return { items: value.items.map(decodeMapping) };
}

const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
const modelPath = (id: string) => `/api/v1/admin/models/${encodeURIComponent(id)}`;
const mappingPath = (id: string) => `${modelPath(id)}/mappings`;
function capabilitiesBody(value: ChannelCapabilities) {
  return { protocol: value.protocol, features: [...value.features], ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(value.reasoningEfforts === undefined ? {} : { reasoningEfforts: [...value.reasoningEfforts] }),
    ...(value.cacheTtls === undefined ? {} : { cacheTtls: [...value.cacheTtls] }),
    ...(value.nativeExtensions === undefined ? {} : { nativeExtensions: value.nativeExtensions.map(extension => ({ scope: extension.scope, name: extension.name })) }) };
}
export function createAdminModelsApi(api = client) {
  const listMappings = async (publicModelId: string, options: { readonly protocol?: Protocol; readonly activeOnly?: boolean } = {}) => (await api.get(mappingPath(publicModelId), { query: options, decode: decodeMappings })).data;
  return Object.freeze({
    async list(options: { readonly cursor?: string | null; readonly status?: 'active' | 'disabled' } = {}): Promise<ModelPage> { return (await api.get('/api/v1/admin/models', { query: { ...options, limit: 20 }, decode: decodeModelPage })).data; },
    async create(input: ModelInput): Promise<ModelView> { return (await api.post('/api/v1/admin/models', { ...input }, { decode: decodeModel })).data; },
    async update(id: string, version: number, input: ModelPatch): Promise<ModelView> { return (await api.patch(modelPath(id), { version, ...input }, { decode: decodeModel })).data; },
    async listMappings(publicModelId: string, options: { readonly protocol?: Protocol; readonly activeOnly?: boolean } = {}) { return listMappings(publicModelId, options); },
    async mappings(publicModelId: string, options: { readonly protocol?: Protocol; readonly activeOnly?: boolean } = {}) { return listMappings(publicModelId, options); },
    async createMapping(publicModelId: string, input: ModelMappingInput): Promise<ModelMappingView> { return (await api.post(mappingPath(publicModelId), { channelId: input.channelId, protocol: input.protocol, upstreamModel: input.upstreamModel, capabilities: capabilitiesBody(input.capabilities) }, { decode: decodeMapping })).data; },
    async updateMapping(publicModelId: string, channelId: string, protocolName: Protocol, version: number, input: ModelMappingPatch): Promise<ModelMappingView> {
      return (await api.patch(`${mappingPath(publicModelId)}/${encodeURIComponent(channelId)}/${protocolName}`, { version, ...(input.upstreamModel === undefined ? {} : { upstreamModel: input.upstreamModel }), ...(input.capabilities === undefined ? {} : { capabilities: capabilitiesBody(input.capabilities) }) }, { decode: decodeMapping })).data;
    },
  });
}
export const adminModelsApi = createAdminModelsApi();

export { decodeModel, decodeMapping, decodeCapabilities };
