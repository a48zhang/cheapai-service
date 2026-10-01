import { DEFAULT_CONFIG } from '../config';
import type { RuntimeConfig } from '../config';
import { prepare } from '../db';
import { ApiError } from '../http';
import { parseUnits } from '../billing/money';
import { readSnapshot, writeSnapshot } from './snapshot';
import type { Snapshot } from './snapshot';

export const MAX_BALANCE_SNAPSHOT_AGE_MS = 15_000;
export interface BalanceData {
  readonly user_id: string;
  readonly balance_units: string;
  /** User-row configuration version, not a ledger revision or CAS token. */
  readonly user_version: number;
}
export interface BalanceRead {
  readonly snapshot: Snapshot<BalanceData>;
  readonly source: 'cache' | 'd1';
  /** This result never replaces final D1 authorization/request registration. */
  readonly requiresAuthoritativeAdmission: true;
}
export type BalanceCacheConfig = Pick<RuntimeConfig, 'balanceCacheEnabled' | 'balanceCacheTtlMs' | 'admissionMinBalanceUnits'>;

export function balanceCacheKey(userId: string): string {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 128 || /[\u0000-\u001f\u007f]/.test(userId)) throw new ApiError('invalid_request');
  return `v1:balance:${encodeURIComponent(userId)}`;
}

function validData(value: unknown, userId: string): value is BalanceData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || row.user_id !== userId ||
      typeof row.user_version !== 'number' || !Number.isSafeInteger(row.user_version) || row.user_version < 1) return false;
  try { parseUnits(row.balance_units); return true; } catch { return false; }
}

/** Optional soft balance check only. Missing/low/stale cache always rechecks D1,
 * so an old low balance cannot reject a recently credited user. Database failure
 * never falls back to a cached value. If admission already read a D1 balance,
 * use that directly instead of calling this helper and querying KV again.
 */
export async function readBalance(
  database: D1Database,
  kv: KVNamespace,
  userId: string,
  config: BalanceCacheConfig = DEFAULT_CONFIG,
  now: () => number = Date.now,
): Promise<BalanceRead | null> {
  const key = balanceCacheKey(userId);
  let threshold: bigint;
  try { threshold = parseUnits(config.admissionMinBalanceUnits); } catch { throw new ApiError('invalid_request'); }
  if (threshold < 0n || typeof config.balanceCacheEnabled !== 'boolean' ||
      !Number.isSafeInteger(config.balanceCacheTtlMs) || config.balanceCacheTtlMs <= 0) throw new ApiError('invalid_request');
  const maxAgeMs = Math.min(config.balanceCacheTtlMs, MAX_BALANCE_SNAPSHOT_AGE_MS);
  const clock = (): number => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new ApiError('service_unavailable');
    return time;
  };
  const validate = (value: unknown): value is BalanceData => validData(value, userId);
  if (config.balanceCacheEnabled) {
    const cached = await readSnapshot(kv, key, { now: clock(), maxAgeMs }, validate);
    if (cached) {
      // Recheck after the asynchronous read so KV latency cannot extend freshness.
      const age = clock() - cached.observed_at;
      const balance = parseUnits(cached.data.balance_units);
      if (age >= 0 && age < maxAgeMs && balance > 0n && balance >= threshold) {
        return { snapshot: cached, source: 'cache', requiresAuthoritativeAdmission: true };
      }
    }
  }
  const observedAt = clock();
  let data: BalanceData | null;
  try {
    // Current architecture uses D1 primary reads; no read-replica session here.
    data = await prepare<BalanceData>(database,
      'SELECT id AS user_id, CAST(balance_units AS TEXT) AS balance_units, version AS user_version FROM users WHERE id=?', [userId]).first();
    if (data !== null && !validate(data)) throw new Error('Invalid D1 balance row');
  } catch { throw new ApiError('service_unavailable'); }
  if (data === null) return null;
  const snapshot: Snapshot<BalanceData> = { schema_version: 1, observed_at: observedAt, data };
  // Best effort, no retries or KV balance arithmetic. Preserve read-start age.
  if (config.balanceCacheEnabled) await writeSnapshot(kv, key, snapshot, { now: clock(), maxAgeMs }, validate);
  return { snapshot, source: 'd1', requiresAuthoritativeAdmission: true };
}
