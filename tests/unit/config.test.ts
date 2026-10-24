import { describe, expect, it } from 'vitest';
import {
  ConfigError, DEFAULT_CONFIG,
  parseChannelLimits, parseRuntimeConfig,
} from '../../apps/worker/config';

describe('runtime configuration', () => {
  it('starts closed with verification enabled and balance KV disabled', () => {
    const config = parseRuntimeConfig();
    expect(config).toMatchObject({ registrationMode: 'closed', emailVerificationEnabled: true, balanceCacheEnabled: false });
    expect(config.gateRenewIntervalMs).toBeLessThan(config.gateLeaseTtlMs);
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

  it.each(['OPEN', null])('rejects an invalid registration mode %s', (registrationMode) => {
    expect(() => parseRuntimeConfig({ registrationMode })).toThrow(ConfigError);
  });

  it.each([null, []])('requires an object (%s)', (input) => {
    expect(() => parseRuntimeConfig(input)).toThrow(ConfigError);
  });

  it.each(['emailVerificationEnabled', 'balanceCacheEnabled'])('does not coerce boolean %s', (key) => {
    for (const value of ['false', 0, null]) {
      expect(() => parseRuntimeConfig({ [key]: value })).toThrow(ConfigError);
    }
  });

  it('validates every numeric field and rejects invalid numeric representations', () => {
    for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG)) {
      if (typeof defaultValue !== 'number') continue;
      expect(() => parseRuntimeConfig({ [key]: -1 }), key).toThrow(ConfigError);
    }
    for (const value of [0, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(() => parseRuntimeConfig({ gateLeaseTtlMs: value })).toThrow(ConfigError);
    }
    for (const key of ['defaultUserConcurrency', 'defaultUserRpm'] as const) {
      for (const value of [0, null]) {
        expect(parseRuntimeConfig({ [key]: value })[key]).toBe(Number.MAX_SAFE_INTEGER);
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

  it('ignores unrecognized settings without copying them into runtime config', () => {
    expect(parseRuntimeConfig({ balanceCacheEnable: true })).toEqual(DEFAULT_CONFIG);
  });
});

describe('explicit channel limits', () => {
  it('defaults concurrency and RPM to unlimited and preserves explicit finite limits', () => {
    expect(parseChannelLimits({})).toEqual({ concurrencyLimit: Number.MAX_SAFE_INTEGER, rpmLimit: Number.MAX_SAFE_INTEGER });
    expect(parseChannelLimits({ rpmLimit: 0 }).rpmLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseRuntimeConfig().defaultUserRpm).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseChannelLimits({ concurrencyLimit: 3, rpmLimit: 80 })).toEqual({ concurrencyLimit: 3, rpmLimit: 80 });
    expect(parseChannelLimits({ rpmLimit: 80 }).concurrencyLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseChannelLimits({ concurrencyLimit: 0, rpmLimit: 80 }).concurrencyLimit).toBe(Number.MAX_SAFE_INTEGER);
    for (const input of [{ concurrencyLimit: -1, rpmLimit: 80 }, { concurrencyLimit: 3, rpmLimit: 0.5 }]) {
      expect(() => parseChannelLimits(input)).toThrow(ConfigError);
    }
  });


});
