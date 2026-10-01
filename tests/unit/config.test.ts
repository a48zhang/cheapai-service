import { describe, expect, it } from 'vitest';
import {
  ConfigError, DEFAULT_CONFIG, parseAdmissionMinBalanceUnits,
  parseChannelLimits, parseModelLimits, parseRuntimeConfig,
} from '../../apps/worker/config';

describe('runtime configuration', () => {
  it('starts closed with verification enabled and balance KV disabled', () => {
    const config = parseRuntimeConfig();
    expect(config).toMatchObject({ registrationMode: 'closed', emailVerificationEnabled: true, balanceCacheEnabled: false });
    expect(config.gateRenewIntervalMs).toBeLessThan(config.gateLeaseTtlMs);
    expect(config.requestMaxDurationMs + config.abandonedRequestGraceMs).toBe(20 * 60_000);
    expect(config.admissionMinBalanceUnits).toBe('0');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('applies overrides without changing defaults or retaining the input object', () => {
    const input = { defaultUserConcurrency: 4, balanceCacheEnabled: true };
    const config = parseRuntimeConfig(input);
    input.defaultUserConcurrency = 8;
    expect(config.defaultUserConcurrency).toBe(4);
    expect(config.balanceCacheEnabled).toBe(true);
    expect(DEFAULT_CONFIG.defaultUserConcurrency).toBe(Number.MAX_SAFE_INTEGER);
    expect(DEFAULT_CONFIG.balanceCacheEnabled).toBe(false);
  });

  it.each(['open', 'invite'])('requires explicit email readiness for %s with verification', (registrationMode) => {
    expect(() => parseRuntimeConfig({ registrationMode })).toThrow(ConfigError);
    expect(parseRuntimeConfig({ registrationMode }, { emailAvailable: true }).registrationMode).toBe(registrationMode);
    expect(parseRuntimeConfig({ registrationMode, emailVerificationEnabled: false }).registrationMode).toBe(registrationMode);
  });

  it.each(['OPEN', 'invalid', '', null, 0, true])('rejects an invalid registration mode %s', (registrationMode) => {
    expect(() => parseRuntimeConfig({ registrationMode })).toThrow(ConfigError);
  });

  it.each([null, [], 'config', 1, new Date()])('requires a plain object (%s)', (input) => {
    expect(() => parseRuntimeConfig(input)).toThrow(ConfigError);
  });

  it.each(['emailVerificationEnabled', 'balanceCacheEnabled'])('does not coerce boolean %s', (key) => {
    for (const value of ['false', 0, 1, null, undefined]) {
      expect(() => parseRuntimeConfig({ [key]: value })).toThrow(ConfigError);
    }
  });

  it('rejects every numeric field when negative, zero, fractional, unsafe or nonnumeric', () => {
    for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG)) {
      if (typeof defaultValue !== 'number') continue;
      for (const value of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
        if ((key === 'defaultUserConcurrency' || key === 'defaultUserRpm') && (value === 0 || value === null)) { expect(parseRuntimeConfig({ [key]: value })[key]).toBe(Number.MAX_SAFE_INTEGER); continue; }
        expect(() => parseRuntimeConfig({ [key]: value }), `${key}=${String(value)}`).toThrow(ConfigError);
      }
    }
  });

  it.each([
    { emailCodeDigits: 5 },
    { emailCodeResendIntervalMs: 600_000 },
    { gateRenewIntervalMs: 90_000 },
    { gateLeaseTtlMs: 20_000 },
    { upstreamHeadersTimeoutMs: 900_001 },
    { upstreamIdleTimeoutMs: 900_001 },
    { settlementRetryBudgetMs: 900_001 },
    { requestMaxDurationMs: Number.MAX_SAFE_INTEGER },
  ])('rejects incompatible values %j', (input) => {
    expect(() => parseRuntimeConfig(input)).toThrow(ConfigError);
  });

  it('allows timeout equality and a shorter renewal interval', () => {
    expect(parseRuntimeConfig({ upstreamIdleTimeoutMs: 900_000, gateRenewIntervalMs: 89_999 }).upstreamIdleTimeoutMs).toBe(900_000);
  });

  it('rejects unknown fields, symbols, and prototype-pollution keys', () => {
    for (const input of [{ balanceCacheEnable: true }, { [Symbol('extra')]: 1 }, JSON.parse('{"__proto__":{}}')]) {
      expect(() => parseRuntimeConfig(input)).toThrow(ConfigError);
    }
    expect(parseRuntimeConfig(Object.create(null))).toEqual(DEFAULT_CONFIG);
  });
});

describe('explicit channel/model limits and integer admission units', () => {
  it.each(['0', '1', '100000000', '9007199254740991'])('preserves exact units %s', (value) => {
    expect(parseAdmissionMinBalanceUnits(value)).toBe(value);
    expect(parseRuntimeConfig({ admissionMinBalanceUnits: value }).admissionMinBalanceUnits).toBe(value);
  });

  it.each([0, 0.01, 1n, '-1', '01', '+1', '1.0', '1e8', ' 1', '1 ', '\t1', '1\t', '\n1', '1\n', '1\r\n', '\u00a01', '1\u00a0', '9007199254740992', '', null, undefined])('rejects invalid units %s', (value) => {
    expect(() => parseAdmissionMinBalanceUnits(value)).toThrow(ConfigError);
    expect(() => parseRuntimeConfig({ admissionMinBalanceUnits: value })).toThrow(ConfigError);
    expect(() => parseModelLimits({ maxOutputTokens: 4, admissionMinBalanceUnits: value })).toThrow(ConfigError);
  });

  it('defaults concurrency and RPM to unlimited and preserves explicit finite limits', () => {
    expect(parseChannelLimits({})).toEqual({ concurrencyLimit: Number.MAX_SAFE_INTEGER, rpmLimit: Number.MAX_SAFE_INTEGER });
    expect(parseChannelLimits({ rpmLimit: 0 }).rpmLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseRuntimeConfig().defaultUserRpm).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseChannelLimits({ concurrencyLimit: 3, rpmLimit: 80 })).toEqual({ concurrencyLimit: 3, rpmLimit: 80 });
    expect(parseChannelLimits({ rpmLimit: 80 }).concurrencyLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseChannelLimits({ concurrencyLimit: 0, rpmLimit: 80 }).concurrencyLimit).toBe(Number.MAX_SAFE_INTEGER);
    for (const input of [{ concurrencyLimit: -1, rpmLimit: 80 }, { concurrencyLimit: 3, rpmLimit: Infinity }, { concurrencyLimit: 3, rpmLimit: 80, extra: true }]) {
      expect(() => parseChannelLimits(input)).toThrow(ConfigError);
    }
  });

  it('requires an output maximum without a platform output default', () => {
    expect(parseModelLimits({ maxOutputTokens: 4096 })).toEqual({ maxOutputTokens: 4096, admissionMinBalanceUnits: '0' });
    expect(parseModelLimits({ maxOutputTokens: 4096, admissionMinBalanceUnits: '50000000' }).admissionMinBalanceUnits).toBe('50000000');
    for (const input of [{}, { maxOutputTokens: 4096, defaultOutputTokens: 1024 }, { maxOutputTokens: -1 }, { maxOutputTokens: 4, admissionMinBalanceUnits: undefined }, { maxOutputTokens: 4, price: 0 }]) {
      expect(() => parseModelLimits(input)).toThrow(ConfigError);
    }
  });
});
