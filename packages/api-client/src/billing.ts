import { decodeBalanceReconciliationPage, decodeBillingPage } from '@cheapai/contracts/billing';
import type { AdminBillingQuery, BalanceReconciliationPage, BillingPage, BillingQuery } from '@cheapai/contracts/billing';
import type { ApiClient } from './types.js';

export type {
  AdminBillingQuery,
  BalanceReconciliation,
  BalanceReconciliationPage,
  BillingEntry,
  BillingKind,
  BillingPage,
  BillingQuery,
} from '@cheapai/contracts/billing';
export { decodeBalanceReconciliationPage, decodeBillingEntry, decodeBillingPage } from '@cheapai/contracts/billing';

export interface BillingApi {
  list(options?: BillingQuery): Promise<BillingPage>;
}

export interface AdminBillingApi {
  list(options?: AdminBillingQuery): Promise<BillingPage>;
  reconciliation(cursor?: string | null): Promise<BalanceReconciliationPage>;
}

const BILLING_PAGE_LIMIT = 20;

export function createBillingApi(api: ApiClient, admin?: false): BillingApi;
export function createBillingApi(api: ApiClient, admin: true): AdminBillingApi;
export function createBillingApi(api: ApiClient, admin: boolean): BillingApi | AdminBillingApi;
export function createBillingApi(api: ApiClient, admin = false): BillingApi | AdminBillingApi {
  const collection = admin ? '/api/v1/admin/billing/entries' : '/api/v1/billing/entries';
  const list = async (options: BillingQuery | AdminBillingQuery = {}): Promise<BillingPage> =>
    (await api.get(collection, { query: { ...options, limit: BILLING_PAGE_LIMIT }, decode: decodeBillingPage })).data;

  if (!admin) return Object.freeze({ list: list as BillingApi['list'] });
  return Object.freeze({
    list: list as AdminBillingApi['list'],
    async reconciliation(cursor: string | null = null): Promise<BalanceReconciliationPage> {
      return (await api.get('/api/v1/admin/billing/reconciliation', {
        query: { cursor, limit: BILLING_PAGE_LIMIT }, decode: decodeBalanceReconciliationPage,
      })).data;
    },
  });
}

/** Explicit admin factory retained for pages that bind administrator-only operations. */
export function createAdminBillingApi(api: ApiClient): AdminBillingApi {
  return createBillingApi(api, true);
}
