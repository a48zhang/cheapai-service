import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';

export type BillingKind = 'consumption' | 'grant' | 'adjustment';
export interface BillingEntry {
  readonly id: string;
  readonly operationId: string;
  readonly kind: BillingKind;
  readonly userId: string;
  readonly requestId: string | null;
  readonly currency: 'USD';
  /** Signed ledger delta in the smallest USD unit; never a number. */
  readonly deltaUnits: string;
  readonly createdBy: string | null;
  readonly reason: string | null;
  /** The server serializes ledger time as an ISO string. */
  readonly createdAt: string;
}
export interface BillingQuery {
  readonly cursor?: string | null;
  readonly kind?: BillingKind;
  readonly requestId?: string;
  readonly createdFrom?: number;
  readonly createdBefore?: number;
  readonly userId?: string;
}
export interface BillingPage { readonly items: readonly BillingEntry[]; readonly nextCursor: string | null }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const amount = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^(?:0|-?[1-9][0-9]*)$/u.test(value);
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
function invalid(): never { throw new TypeError('Invalid billing response.'); }

export function decodeBillingEntry(value: unknown): BillingEntry {
  if (!object(value) || !text(value.id) || !text(value.operationId) || !['consumption', 'grant', 'adjustment'].includes(String(value.kind))
    || !text(value.userId) || !(value.requestId === null || text(value.requestId)) || value.currency !== 'USD' || !amount(value.deltaUnits)
    || !(value.createdBy === null || text(value.createdBy)) || !(value.reason === null || text(value.reason, 4096)) || !time(value.createdAt)) invalid();
  return { id: value.id, operationId: value.operationId, kind: value.kind as BillingKind, userId: value.userId, requestId: value.requestId,
    currency: 'USD', deltaUnits: value.deltaUnits, createdBy: value.createdBy, reason: value.reason, createdAt: value.createdAt };
}

export function decodeBillingPage(value: unknown): BillingPage {
  if (!object(value) || !Array.isArray(value.items) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid();
  return { items: value.items.map(decodeBillingEntry), nextCursor: value.nextCursor };
}

/** Exact USD display from integer units. This is string slicing around a
 * BigInt conversion; no floating point or Number arithmetic is used. */
export function formatUnitsToUsd(value: string): string {
  if (!amount(value)) throw new TypeError('Invalid amount.');
  const units = BigInt(value);
  const negative = units < 0n;
  const digits = (negative ? (-units).toString() : units.toString()).padStart(9, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

export function isCanonicalUnits(value: string): boolean { return amount(value); }

const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
export function createBillingApi(api = client, admin = false) {
  const collection = admin ? '/api/v1/admin/billing/entries' : '/api/v1/billing/entries';
  return Object.freeze({
    async list(options: BillingQuery = {}): Promise<BillingPage> {
      return (await api.get(collection, { query: { ...options, limit: 20 }, decode: decodeBillingPage })).data;
    },
  });
}

export const billingApi = createBillingApi();
