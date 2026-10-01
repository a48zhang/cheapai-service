import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import type { Page } from './types.js';

export type ChannelStatus = 'active' | 'disabled';
export interface ChannelModel { readonly publicModelId: string; readonly upstreamModel: string; readonly protocol: 'chat' | 'responses' | 'messages'; readonly mappingVersion: number; readonly priceVersion: number }
export interface ChannelView {
  readonly models: readonly ChannelModel[];
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly status: ChannelStatus;
  readonly priority: number;
  readonly concurrencyLimit: number;
  readonly rpmLimit: number;
  readonly configVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly hasCredential: boolean;
}
export interface ChannelInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly upstreamKey: string;
  readonly concurrencyLimit: number;
  readonly rpmLimit: number;
  readonly priority?: number;
  readonly status?: ChannelStatus;
}
export type ChannelPatch = Partial<ChannelInput>;
export type ChannelPage = Page<ChannelView>;
export type ProbeProtocol = 'chat' | 'responses' | 'messages';
export interface ChannelProbeInput {
  readonly publicModelId: string;
  readonly protocol: ProbeProtocol;
  readonly channelVersion: number;
  readonly mappingVersion: number;
  readonly priceVersion: number;
}
export interface ChannelProbeResult extends ChannelProbeInput {
  readonly diagnosticId: string;
  readonly channelId: string;
  readonly outcome: 'responded' | 'http_error' | 'invalid_response' | 'timeout' | 'cancelled' | 'transport_error';
  readonly upstreamStatus: number | null;
  readonly maxOutputTokens: number;
  readonly mayIncurUpstreamCost: true;
  readonly userBalanceCharged: false;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function invalid(): never { throw new TypeError('Invalid administrator channel response.'); }
function decodeChannel(value: unknown): ChannelView {
  if (!object(value) || !text(value.id) || !text(value.name, 200) || !text(value.baseUrl, 2048) || (value.status !== 'active' && value.status !== 'disabled')
    || !count(value.priority) || !count(value.concurrencyLimit) || value.concurrencyLimit < 1 || !count(value.rpmLimit) || value.rpmLimit < 1
    || !count(value.configVersion) || value.configVersion < 1 || !count(value.createdAt) || !count(value.updatedAt) || value.updatedAt < value.createdAt
    || typeof value.hasCredential !== 'boolean' || !Array.isArray(value.models)) invalid();
  const models: ChannelModel[] = value.models.map(model => { if (!object(model) || !text(model.publicModelId) || !text(model.upstreamModel) || !['chat','responses','messages'].includes(String(model.protocol)) || !count(model.mappingVersion) || !count(model.priceVersion)) invalid(); return { publicModelId:model.publicModelId,upstreamModel:model.upstreamModel,protocol:model.protocol as ChannelModel['protocol'],mappingVersion:model.mappingVersion,priceVersion:model.priceVersion }; });
  return { id: value.id, name: value.name, baseUrl: value.baseUrl, status: value.status, priority: value.priority,
    concurrencyLimit: value.concurrencyLimit, rpmLimit: value.rpmLimit, configVersion: value.configVersion,
    createdAt: value.createdAt, updatedAt: value.updatedAt, hasCredential: value.hasCredential, models };
}
export function decodeChannelPage(value: unknown): ChannelPage {
  if (!object(value) || !Array.isArray(value.items) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid();
  return { items: value.items.map(decodeChannel), nextCursor: value.nextCursor };
}
function decodeProbe(value: unknown): ChannelProbeResult {
  if (!object(value) || !text(value.diagnosticId) || !text(value.channelId) || !text(value.publicModelId)
    || !['chat', 'responses', 'messages'].includes(String(value.protocol)) || !['responded', 'http_error', 'invalid_response', 'timeout', 'cancelled', 'transport_error'].includes(String(value.outcome))
    || !(value.upstreamStatus === null || (count(value.upstreamStatus) && value.upstreamStatus >= 100 && value.upstreamStatus <= 599))
    || !count(value.channelVersion) || value.channelVersion < 1 || !count(value.mappingVersion) || value.mappingVersion < 1
    || !count(value.priceVersion) || value.priceVersion < 1 || !count(value.maxOutputTokens) || value.maxOutputTokens < 1
    || value.mayIncurUpstreamCost !== true || value.userBalanceCharged !== false) invalid();
  return { diagnosticId: value.diagnosticId, channelId: value.channelId, publicModelId: value.publicModelId,
    protocol: value.protocol as ProbeProtocol, outcome: value.outcome as ChannelProbeResult['outcome'], upstreamStatus: value.upstreamStatus,
    channelVersion: value.channelVersion, mappingVersion: value.mappingVersion, priceVersion: value.priceVersion,
    maxOutputTokens: value.maxOutputTokens, mayIncurUpstreamCost: true, userBalanceCharged: false };
}

const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
const path = (id: string) => `/api/v1/admin/channels/${encodeURIComponent(id)}`;
export function createAdminChannelsApi(api = client) {
  return Object.freeze({
    async list(options: { readonly cursor?: string | null; readonly status?: ChannelStatus } = {}): Promise<ChannelPage> {
      return (await api.get('/api/v1/admin/channels', { query: { ...options, limit: 20 }, decode: decodeChannelPage })).data;
    },
    async create(input: ChannelInput): Promise<ChannelView> {
      return (await api.post('/api/v1/admin/channels', { ...input }, { decode: decodeChannel })).data;
    },
    async update(id: string, version: number, input: ChannelPatch): Promise<ChannelView> {
      return (await api.patch(path(id), { version, ...input }, { decode: decodeChannel })).data;
    },
    async test(id: string, input: ChannelProbeInput): Promise<ChannelProbeResult> {
      return (await api.post(`${path(id)}/test`, { ...input }, { decode: decodeProbe })).data;
    },
  });
}
export const adminChannelsApi = createAdminChannelsApi();
