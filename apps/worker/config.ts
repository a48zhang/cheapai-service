import { isFiniteRpmLimit, MAX_RATE_WINDOW_OPERATIONS } from './limits/rate-window';

export type RegistrationMode = 'closed' | 'open' | 'invite';
// Internal sentinel keeps old positive-integer storage/RPC formats compatible.
// The public configuration uses 0 (or null) to express no business concurrency cap.
export const UNLIMITED_CONCURRENCY = Number.MAX_SAFE_INTEGER;
export const UNLIMITED_RPM = Number.MAX_SAFE_INTEGER;
export function parseRpmLimit(value: unknown): number {
  if (value === undefined || value === null || value === 0 || value === UNLIMITED_RPM) return UNLIMITED_RPM;
  if (!isFiniteRpmLimit(value)) throw new ConfigError('rpmLimit', `must be a safe integer from 1 to ${MAX_RATE_WINDOW_OPERATIONS}, or unlimited`);
  return value;
}
export function parseConcurrencyLimit(value: unknown): number {
  if (value === undefined || value === null || value === 0) return UNLIMITED_CONCURRENCY;
  return positiveInteger(value, 'concurrencyLimit');
}

export interface RuntimeConfig {
  registrationMode: RegistrationMode;
  registrationIpMaxAttempts: number;
  registrationWindowMs: number;
  emailVerificationEnabled: boolean;
  emailCodeDigits: number;
  emailCodeTtlMs: number;
  emailCodeResendIntervalMs: number;
  emailCodeMaxAttempts: number;
  emailSendWindowMs: number;
  emailSendPerAddressLimit: number;
  emailSendPerIpLimit: number;
  loginWindowMs: number;
  loginAccountFailureLimit: number;
  loginIpAttemptLimit: number;
  sessionTtlMs: number;
  defaultUserConcurrency: number;
  defaultUserRpm: number;
  gateLeaseTtlMs: number;
  gateRenewIntervalMs: number;
  /** Decimal integer units (1 USD = 100,000,000 units), never floating USD. */
  admissionMinBalanceUnits: string;
  balanceCacheEnabled: boolean;
  balanceCacheTtlMs: number;
  routingCacheTtlMs: number;
  gatewayBodyMaxBytes: number;
  adminBodyMaxBytes: number;
  upstreamHeadersTimeoutMs: number;
  upstreamIdleTimeoutMs: number;
  requestMaxDurationMs: number;
  streamFrameMaxBytes: number;
  toolArgumentsMaxBytes: number;
  settlementMaxAttempts: number;
  settlementRetryBudgetMs: number;
  cronIntervalMs: number;
  abandonedRequestGraceMs: number;
  requestDetailsRetentionMs: number;
  debugLogsRetentionMs: number;
}

/** Proposed first-release parameters; parsing does not initialize any resource. */
export const DEFAULT_CONFIG: Readonly<RuntimeConfig> = Object.freeze({
  registrationMode: 'closed',
  registrationIpMaxAttempts: 20,
  registrationWindowMs: 3_600_000,
  emailVerificationEnabled: true,
  emailCodeDigits: 6,
  emailCodeTtlMs: 600_000,
  emailCodeResendIntervalMs: 60_000,
  emailCodeMaxAttempts: 5,
  emailSendWindowMs: 3_600_000,
  emailSendPerAddressLimit: 5,
  emailSendPerIpLimit: 20,
  loginWindowMs: 900_000,
  loginAccountFailureLimit: 10,
  loginIpAttemptLimit: 50,
  sessionTtlMs: 604_800_000,
  defaultUserConcurrency: UNLIMITED_CONCURRENCY,
  defaultUserRpm: UNLIMITED_RPM,
  gateLeaseTtlMs: 90_000,
  gateRenewIntervalMs: 30_000,
  admissionMinBalanceUnits: '0',
  balanceCacheEnabled: false,
  balanceCacheTtlMs: 15_000,
  routingCacheTtlMs: 60_000,
  gatewayBodyMaxBytes: 8 * 1024 * 1024,
  adminBodyMaxBytes: 64 * 1024,
  upstreamHeadersTimeoutMs: 60_000,
  upstreamIdleTimeoutMs: 120_000,
  requestMaxDurationMs: 900_000,
  streamFrameMaxBytes: 1024 * 1024,
  toolArgumentsMaxBytes: 4 * 1024 * 1024,
  settlementMaxAttempts: 3,
  settlementRetryBudgetMs: 6_000,
  cronIntervalMs: 300_000,
  abandonedRequestGraceMs: 300_000,
  requestDetailsRetentionMs: 90 * 86_400_000,
  debugLogsRetentionMs: 7 * 86_400_000,
});

export class ConfigError extends Error {
  constructor(public readonly field: string, reason: string) {
    super(`Invalid configuration: ${field} ${reason}`);
    this.name = 'ConfigError';
  }
}

function objectInput(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new ConfigError('config', 'must be a plain object');
  }
  // Reject typos and unknown keys rather than silently ignoring policy settings.
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      throw new ConfigError('config', 'contains an unknown field');
    }
  }
  return input as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(field, 'must be a positive safe integer');
  }
  return value;
}

/** Canonical nonnegative units, limited to D1/JS safe integer round trips. */
export function parseAdmissionMinBalanceUnits(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !/^(0|[1-9][0-9]*)$/.test(value)
      || value.length > 16 || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConfigError('admissionMinBalanceUnits', 'must be a nonnegative safe integer units string');
  }
  return value;
}

/** Accepts partial overrides. Omitted fields default; explicit undefined is invalid.
 * Email availability is supplied by the caller, never discovered by sending mail.
 * Cron scheduling, data retention, and balance admission still require consumers;
 * a zero threshold never authorizes a zero/negative balance (balance must be > 0).
 */
export function parseRuntimeConfig(
  input: unknown = {},
  readiness: { emailAvailable?: boolean } = {},
): Readonly<RuntimeConfig> {
  const values = objectInput(input, Object.keys(DEFAULT_CONFIG));
  const config: RuntimeConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(values) as (keyof RuntimeConfig)[]) {
    const value = values[key];
    if (key === 'registrationMode') {
      if (value !== 'closed' && value !== 'open' && value !== 'invite') {
        throw new ConfigError(key, 'must be closed, open, or invite');
      }
      config[key] = value;
    } else if (key === 'emailVerificationEnabled' || key === 'balanceCacheEnabled') {
      if (typeof value !== 'boolean') throw new ConfigError(key, 'must be a boolean');
      config[key] = value;
    } else if (key === 'admissionMinBalanceUnits') {
      config[key] = parseAdmissionMinBalanceUnits(value);
    } else if (key === 'defaultUserConcurrency') {
      if (value === undefined) throw new ConfigError(key, 'must not be explicitly undefined');
      config[key] = parseConcurrencyLimit(value);
    } else if (key === 'defaultUserRpm') {
      if (value === undefined) throw new ConfigError(key, 'must not be explicitly undefined');
      config[key] = parseRpmLimit(value);
    } else {
      config[key] = positiveInteger(value, key);
    }
  }
  if (config.emailCodeDigits !== 6) {
    throw new ConfigError('emailCodeDigits', 'must be six in the first-release code format');
  }
  if (config.registrationMode !== 'closed' && config.emailVerificationEnabled && readiness.emailAvailable !== true) {
    throw new ConfigError('registrationMode', 'requires available email when verification is enabled');
  }
  if (config.emailCodeResendIntervalMs >= config.emailCodeTtlMs) {
    throw new ConfigError('emailCodeResendIntervalMs', 'must be shorter than emailCodeTtlMs');
  }
  if (config.gateRenewIntervalMs >= config.gateLeaseTtlMs) {
    throw new ConfigError('gateRenewIntervalMs', 'must be shorter than gateLeaseTtlMs');
  }
  for (const key of ['upstreamHeadersTimeoutMs', 'upstreamIdleTimeoutMs', 'settlementRetryBudgetMs'] as const) {
    if (config[key] > config.requestMaxDurationMs) {
      throw new ConfigError(key, 'must not exceed requestMaxDurationMs');
    }
  }
  if (!Number.isSafeInteger(config.requestMaxDurationMs + config.abandonedRequestGraceMs)) {
    throw new ConfigError('abandonedRequestGraceMs', 'makes the abandoned-request threshold unsafe');
  }
  return Object.freeze(config);
}

export interface ChannelLimits {
  concurrencyLimit: number;
  rpmLimit: number;
}

/** Supplier-specific limits are mandatory; no invented channel capacity defaults. */
export function parseChannelLimits(input: unknown): Readonly<ChannelLimits> {
  const values = objectInput(input, ['concurrencyLimit', 'rpmLimit']);
  return Object.freeze({
    concurrencyLimit: parseConcurrencyLimit(values.concurrencyLimit),
    rpmLimit: parseRpmLimit(values.rpmLimit),
  });
}

export interface ModelLimits {
  maxOutputTokens: number;
  admissionMinBalanceUnits: string;
}

/** Model maximum must be explicit; requests have no platform output default. Price validation belongs to pricing. */
export function parseModelLimits(input: unknown): Readonly<ModelLimits> {
  const values = objectInput(input, ['maxOutputTokens', 'admissionMinBalanceUnits']);
  const limits = {
    maxOutputTokens: positiveInteger(values.maxOutputTokens, 'maxOutputTokens'),
    admissionMinBalanceUnits: parseAdmissionMinBalanceUnits(
      Object.hasOwn(values, 'admissionMinBalanceUnits') ? values.admissionMinBalanceUnits : DEFAULT_CONFIG.admissionMinBalanceUnits,
    ),
  };
  return Object.freeze(limits);
}
