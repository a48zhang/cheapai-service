import { createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import { decodeBillingPage, type BillingPage, type BillingQuery } from './billing.js';

export type AdjustmentKind = 'grant' | 'adjustment';
export interface BalanceAdjustmentInput {
  readonly kind: AdjustmentKind;
  /** Signed integer smallest-unit amount. A grant must be positive. */
  readonly deltaUnits: string;
  readonly reason: string;
  readonly requestId?: string | null;
}
export interface BalanceAdjustmentEntry {
  readonly id: string;
  readonly operationId: string;
  readonly kind: AdjustmentKind;
  readonly userId: string;
  readonly requestId: string | null;
  readonly deltaUnits: string;
  readonly currency: 'USD';
  readonly fingerprint: string;
  readonly createdBy: string;
  readonly reason: string;
  readonly createdAt: number;
}
export interface BalanceAdjustmentResult {
  readonly entry: BalanceAdjustmentEntry;
  readonly outcome: 'inserted' | 'existing';
}
export interface BalanceReconciliation {
  readonly userId: string;
  readonly currency: 'USD';
  readonly balanceUnits: string;
  readonly ledgerUnits: string;
  readonly differenceUnits: string;
  readonly entryCount: number;
  readonly matches: boolean;
  readonly negativeBalance: boolean;
}
export interface BalanceReconciliationPage { readonly items: readonly BalanceReconciliation[]; readonly nextCursor: string | null }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
const amount = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^(?:0|-?[1-9][0-9]*)$/u.test(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function invalid(): never { throw new TypeError('Invalid administrator billing response.'); }

function decodeEntry(value: unknown): BalanceAdjustmentEntry {
  if (!object(value) || !text(value.id) || !text(value.operationId) || !['grant', 'adjustment'].includes(String(value.kind))
    || !text(value.userId) || !(value.requestId === null || text(value.requestId)) || !amount(value.deltaUnits) || value.currency !== 'USD'
    || !text(value.fingerprint, 256) || !text(value.createdBy) || !text(value.reason, 4096) || !count(value.createdAt)) invalid();
  try { if (value.kind === 'grant' && BigInt(value.deltaUnits) <= 0n) invalid(); } catch { invalid(); }
  return { id: value.id, operationId: value.operationId, kind: value.kind as AdjustmentKind, userId: value.userId, requestId: value.requestId,
    deltaUnits: value.deltaUnits, currency: 'USD', fingerprint: value.fingerprint, createdBy: value.createdBy, reason: value.reason, createdAt: value.createdAt };
}

function decodeReconciliation(value: unknown): BalanceReconciliation {
  if (!object(value) || !text(value.userId) || value.currency !== 'USD' || !amount(value.balanceUnits) || !amount(value.ledgerUnits)
    || !amount(value.differenceUnits) || !count(value.entryCount) || typeof value.matches !== 'boolean' || typeof value.negativeBalance !== 'boolean') invalid();
  return { userId: value.userId, currency: 'USD', balanceUnits: value.balanceUnits, ledgerUnits: value.ledgerUnits,
    differenceUnits: value.differenceUnits, entryCount: value.entryCount, matches: value.matches, negativeBalance: value.negativeBalance };
}

export function decodeBalanceAdjustment(value: unknown): BalanceAdjustmentResult {
  if (!object(value) || !object(value.entry) || (value.outcome !== 'inserted' && value.outcome !== 'existing')) invalid();
  return { entry: decodeEntry(value.entry), outcome: value.outcome };
}

const client = createApiClient({ getCsrfToken: async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken });
const balancePath = (userId: string) => `/api/v1/admin/users/${encodeURIComponent(userId)}/balance-adjustments`;

export function createAdminBillingApi(api = client) {
  return Object.freeze({
    async list(options: BillingQuery & { readonly userId?: string } = {}): Promise<BillingPage> {
      return (await api.get('/api/v1/admin/billing/entries', { query: { ...options, limit: 20 }, decode: decodeBillingPage })).data;
    },
    async reconciliation(cursor: string | null = null): Promise<BalanceReconciliationPage> {
      return (await api.get('/api/v1/admin/billing/reconciliation', { query: { cursor, limit: 20 }, decode: value => {
        if (!object(value) || !Array.isArray(value.items) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid();
        return { items: value.items.map(decodeReconciliation), nextCursor: value.nextCursor };
      } })).data;
    },
    async adjust(userId: string, input: BalanceAdjustmentInput, operationId: string): Promise<BalanceAdjustmentResult> {
      const body = { kind: input.kind, deltaUnits: input.deltaUnits, reason: input.reason, ...(input.requestId === undefined ? {} : { requestId: input.requestId }) };
      return (await api.post(balancePath(userId), body, { idempotencyKey: operationId, decode: decodeBalanceAdjustment })).data;
    },
  });
}

export const adminBillingApi = createAdminBillingApi();
