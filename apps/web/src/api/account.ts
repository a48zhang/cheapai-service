import { apiClient } from './client.js';
export interface AccountBalance {
  readonly currency: 'USD'; readonly decimals: 8; readonly balance_units: string; readonly balance_usd: string;
}
/** Exact decimal string slicing; no floating-point/Number conversion of money. */
export function decodeAccountBalance(value: unknown): AccountBalance {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid account balance.');
  const v = value as Record<string, unknown>;
  if (v.currency !== 'USD' || v.decimals !== 8 || typeof v.balance_units !== 'string' || v.balance_units.length > 128
    || !/^(?:0|-?[1-9][0-9]*)$/.test(v.balance_units) || typeof v.balance_usd !== 'string') throw new TypeError('Invalid account balance.');
  const negative = v.balance_units.startsWith('-'); const digits = (negative ? v.balance_units.slice(1) : v.balance_units).padStart(9, '0');
  const expected = `${negative ? '-' : ''}${digits.slice(0, -8)}.${digits.slice(-8)}`;
  if (v.balance_usd !== expected) throw new TypeError('Inconsistent account balance.');
  return { currency: 'USD', decimals: 8, balance_units: v.balance_units, balance_usd: v.balance_usd };
}
export const accountApi = Object.freeze({
  async balance(): Promise<AccountBalance> {
    return (await apiClient.get('/api/v1/account/balance', { decode: decodeAccountBalance })).data;
  },
});
