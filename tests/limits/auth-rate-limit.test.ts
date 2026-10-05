import { evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, parseRuntimeConfig } from '../../apps/worker/config';
import { beginLoginAttempt, checkEmailSendRate, checkRegistrationRate } from '../../apps/worker/limits/auth-rate-limit';
import type { AuthGateNamespace, AuthRateSubject, RegistrationRateConfig } from '../../apps/worker/limits/auth-rate-limit';
import { testEnv } from '../helpers/database';

let now: number;
beforeEach(() => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

describe('independent registration submission IP quota', () => {
  const registration = { registrationIpMaxAttempts: 2, registrationWindowMs: 60_000 };

  it('centralizes defaults and applies the exact registration capacity/window boundary', async () => {
    expect(parseRuntimeConfig().registrationIpMaxAttempts).toBe(20);
    expect(parseRuntimeConfig().registrationWindowMs).toBe(3_600_000);
    for (let index = 0; index < 2; index++) {
      expect(await checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, registration)).toEqual({ allowed: true, retryAfterMs: 0 });
    }
    expect(await checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, registration)).toEqual({ allowed: false, dimension: 'ip', retryAfterMs: 60_000 });
    expect((await checkRegistrationRate(testEnv.GATE, { trustedIp: '198.51.100.2' }, registration)).allowed).toBe(true);
    now += 60_000;
    expect((await checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, registration)).allowed).toBe(true);
  });

  it('does not spend registration quota when email-send quota is exhausted', async () => {
    for (let index = 0; index < 2; index++) await checkEmailSendRate(testEnv.GATE, base, config);
    expect((await checkEmailSendRate(testEnv.GATE, base, config)).allowed).toBe(false);
    expect((await checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, registration)).allowed).toBe(true);
    expect((await checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, registration)).allowed).toBe(true);
  });

  it('does not spend login or send quota when registration quota is exhausted', async () => {
    for (let index = 0; index < 2; index++) await checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, registration);
    expect((await checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, registration)).allowed).toBe(false);
    expect((await beginLoginAttempt(testEnv.GATE, base, config)).allowed).toBe(true);
    expect((await checkEmailSendRate(testEnv.GATE, base, config)).allowed).toBe(true);
  });

  it('uses a separate hashed namespace and internal, fresh operation IDs', async () => {
    const names: string[] = [];
    const operations: string[] = [];
    const gates: AuthGateNamespace = {
      idFromName(name) { names.push(name); return testEnv.GATE.idFromName(name); },
      get(id) {
        const native = testEnv.GATE.get(id);
        return {
          ratePeek: (input) => native.ratePeek(input),
          rateCheck(input) { operations.push(input.operationId); return native.rateCheck(input); },
        };
      },
    };
    await checkRegistrationRate(gates, { trustedIp: '2001:db8::1' }, registration);
    await checkRegistrationRate(gates, { trustedIp: '2001:0db8:0:0:0:0:0:1' }, registration);
    expect(names[0]).toMatch(/^auth:register-ip:v1:[a-f0-9]{64}$/);
    expect(names[1]).toBe(names[0]);
    expect(operations[0]).not.toBe(operations[1]);
  });

  it.each(['registrationIpMaxAttempts', 'registrationWindowMs'] as const)('validates new config field %s through F10 and the quota helper', async (field) => {
    const gates = { idFromName: vi.fn(), get: vi.fn() } as unknown as AuthGateNamespace;
    for (const value of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined]) {
      expect(() => parseRuntimeConfig({ [field]: value })).toThrow();
      await expect(checkRegistrationRate(gates, { trustedIp: base.trustedIp }, { ...registration, [field]: value } as unknown as RegistrationRateConfig)).rejects.toThrow();
    }
    expect(gates.idFromName).not.toHaveBeenCalled();
  });

  it('rejects a quota beyond the Gate cap and malformed trusted IP', async () => {
    await expect(checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp }, { ...registration, registrationIpMaxAttempts: 4097 })).rejects.toThrow();
    await expect(checkRegistrationRate(testEnv.GATE, { trustedIp: base.trustedIp, operationId: 'client-replay' } as { trustedIp: string }, registration)).resolves.toMatchObject({ allowed: true });
    await expect(checkRegistrationRate(testEnv.GATE, { trustedIp: '198.51.100.1, 10.0.0.1' }, registration)).rejects.toThrow();
  });
});
afterEach(() => vi.restoreAllMocks());
const base = { trustedIp: '198.51.100.1', email: 'user@example.com' };
const config = { ...DEFAULT_CONFIG, loginWindowMs: 60_000, loginAccountFailureLimit: 2, loginIpAttemptLimit: 3, emailSendWindowMs: 60_000, emailSendPerAddressLimit: 2, emailSendPerIpLimit: 2 };

describe('authentication rate limits through real Gate DOs', () => {
  it('counts all IP login attempts but successful logins never consume failure quota', async () => {
    for (let index = 0; index < 3; index++) expect((await beginLoginAttempt(testEnv.GATE, base, config)).allowed).toBe(true);
    expect(await beginLoginAttempt(testEnv.GATE, base, config)).toEqual({ allowed: false, dimension: 'ip', retryAfterMs: 60_000 });
    // Same account, fresh IP: successful prior attempts did not count as failures.
    expect((await beginLoginAttempt(testEnv.GATE, { ...base, trustedIp: '198.51.100.2' }, config)).allowed).toBe(true);
  });

  it('blocks account failures before the next KDF and deduplicates failure recording', async () => {
    const first = await beginLoginAttempt(testEnv.GATE, base, config);
    if (!first.allowed) throw new Error('Expected preflight admission');
    await Promise.all([first.recordFailure(), first.recordFailure()]);
    const second = await beginLoginAttempt(testEnv.GATE, { ...base, trustedIp: '198.51.100.2' }, config);
    if (!second.allowed) throw new Error('Failure recording must count once');
    await second.recordFailure();
    const wouldRunKdf = vi.fn();
    const third = await beginLoginAttempt(testEnv.GATE, { ...base, trustedIp: '198.51.100.3' }, config);
    if (third.allowed) wouldRunKdf();
    expect(third).toEqual({ allowed: false, dimension: 'email', retryAfterMs: 60_000 });
    expect(wouldRunKdf).not.toHaveBeenCalled();
  });

  it('normalizes mailbox case/whitespace but does not merge plus tags', async () => {
    const strict = { ...config, loginAccountFailureLimit: 1 };
    const first = await beginLoginAttempt(testEnv.GATE, base, strict);
    if (!first.allowed) throw new Error('Expected admission');
    await first.recordFailure();
    expect((await beginLoginAttempt(testEnv.GATE, { trustedIp: '198.51.100.2', email: ' USER@EXAMPLE.COM ' }, strict)).allowed).toBe(false);
    expect((await beginLoginAttempt(testEnv.GATE, { trustedIp: '198.51.100.3', email: 'user+tag@example.com' }, strict)).allowed).toBe(true);
  });

  it('canonicalizes IPv6 aliases and IPv4-mapped IPv6 before counting IP attempts', async () => {
    const strict = { ...config, loginIpAttemptLimit: 1 };
    expect((await beginLoginAttempt(testEnv.GATE, { ...base, trustedIp: '2001:0DB8:0000:0000:0000:0000:0000:0001' }, strict)).allowed).toBe(true);
    expect(await beginLoginAttempt(testEnv.GATE, { ...base, trustedIp: '2001:db8::1', email: 'other@example.com' }, strict)).toMatchObject({ allowed: false, dimension: 'ip' });
    expect((await beginLoginAttempt(testEnv.GATE, base, strict)).allowed).toBe(true);
    expect(await beginLoginAttempt(testEnv.GATE, { ...base, trustedIp: '::ffff:198.51.100.1' }, strict)).toMatchObject({ allowed: false, dimension: 'ip' });
  });

  it('enforces send-IP quota across different email addresses', async () => {
    expect((await checkEmailSendRate(testEnv.GATE, base, config)).allowed).toBe(true);
    expect((await checkEmailSendRate(testEnv.GATE, { ...base, email: 'other@example.com' }, config)).allowed).toBe(true);
    expect(await checkEmailSendRate(testEnv.GATE, { ...base, email: 'third@example.com' }, config)).toEqual({ allowed: false, dimension: 'ip', retryAfterMs: 60_000 });
  });

  it('enforces send-email quota across IPs without mixing login counters', async () => {
    expect((await checkEmailSendRate(testEnv.GATE, base, config)).allowed).toBe(true);
    expect((await checkEmailSendRate(testEnv.GATE, { ...base, trustedIp: '198.51.100.2' }, config)).allowed).toBe(true);
    expect(await checkEmailSendRate(testEnv.GATE, { ...base, trustedIp: '198.51.100.3' }, config)).toEqual({ allowed: false, dimension: 'email', retryAfterMs: 60_000 });
    expect((await beginLoginAttempt(testEnv.GATE, base, config)).allowed).toBe(true);
  });

  it('uses hashed object names and restores failure limits after eviction until the exact boundary', async () => {
    const names: string[] = [];
    const gates: AuthGateNamespace = {
      idFromName(name) { names.push(name); return testEnv.GATE.idFromName(name); },
      get: (id) => testEnv.GATE.get(id),
    };
    const strict = { ...config, loginAccountFailureLimit: 1 };
    const admission = await beginLoginAttempt(gates, base, strict);
    if (!admission.allowed) throw new Error('Expected admission');
    await admission.recordFailure();
    for (const name of names) {
      expect(name).toMatch(/^auth:login-(ip|failure):v1:[a-f0-9]{64}$/);
      expect(name).not.toContain(base.email);
      expect(name).not.toContain(base.trustedIp);
    }
    const accountName = names.find((name) => name.startsWith('auth:login-failure:'))!;
    await evictDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(accountName)));
    expect((await beginLoginAttempt(gates, { ...base, trustedIp: '198.51.100.2' }, strict)).allowed).toBe(false);
    now += 60_000;
    expect((await beginLoginAttempt(gates, base, strict)).allowed).toBe(true);
  });

  it.each(['', '198.51.100.1, 10.0.0.1', 'example.com', ' 198.51.100.1', '198\n.51.100.1', '010.0.0.1', '256.1.1.1', '[2001:db8::1]', 'fe80::1%eth0'])(
    'rejects untrusted/ambiguous IP forms before contacting a Gate (case %#)', async (trustedIp) => {
      const idFromName = vi.fn();
      const gates = { idFromName, get: vi.fn() } as unknown as AuthGateNamespace;
      await expect(beginLoginAttempt(gates, { ...base, trustedIp }, config)).rejects.toThrow();
      expect(idFromName).not.toHaveBeenCalled();
    },
  );

  it('ignores metadata while requiring a trusted IP/email subject', async () => {
    await expect(beginLoginAttempt(testEnv.GATE, { ...base, headers: { 'x-forwarded-for': '198.51.100.2' } } as AuthRateSubject, config)).resolves.toMatchObject({ allowed: true });
    await expect(beginLoginAttempt(testEnv.GATE, { ...base, operationId: 'replay-bypass' } as AuthRateSubject, config)).resolves.toMatchObject({ allowed: true });
    await expect(checkEmailSendRate(testEnv.GATE, new Request('https://local.test') as unknown as AuthRateSubject, config)).rejects.toThrow();
  });

  it('propagates binding failures without granting KDF or sending access', async () => {
    const failure = new Error('injected unavailable binding');
    const gates: AuthGateNamespace = {
      idFromName: (name) => testEnv.GATE.idFromName(name),
      get: () => ({ rateCheck: async () => { throw failure; }, ratePeek: async () => { throw failure; } }),
    };
    await expect(beginLoginAttempt(gates, base, config)).rejects.toBe(failure);
    await expect(checkEmailSendRate(gates, base, config)).rejects.toBe(failure);
  });

  it('retries an unconfirmed failure record with the same server-generated operation ID', async () => {
    const subjects = new Map<string, string>();
    let loseReply = true;
    const gates: AuthGateNamespace = {
      idFromName(name) {
        const id = testEnv.GATE.idFromName(name);
        subjects.set(id.toString(), name);
        return id;
      },
      get(id) {
        const native = testEnv.GATE.get(id);
        return {
          ratePeek: (input) => native.ratePeek(input),
          async rateCheck(input) {
            const result = await native.rateCheck(input);
            if (subjects.get(id.toString())?.startsWith('auth:login-failure:') && loseReply) {
              loseReply = false;
              throw new Error('injected lost acknowledgement');
            }
            return result;
          },
        };
      },
    };
    const first = await beginLoginAttempt(gates, base, config);
    if (!first.allowed) throw new Error('Expected admission');
    await expect(first.recordFailure()).rejects.toThrow('lost acknowledgement');
    expect((await first.recordFailure()).allowed).toBe(true);
    const second = await beginLoginAttempt(gates, { ...base, trustedIp: '198.51.100.2' }, config);
    if (!second.allowed) throw new Error('A retried failure must count once');
    await second.recordFailure();
    expect((await beginLoginAttempt(gates, { ...base, trustedIp: '198.51.100.3' }, config)).allowed).toBe(false);
  });

  it('admits only the configured email quota under simultaneous requests from distinct IPs', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      checkEmailSendRate(testEnv.GATE, { ...base, trustedIp: `198.51.100.${index + 1}` }, config),
    ));
    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect(results.filter((result) => !result.allowed && result.dimension === 'email')).toHaveLength(4);
  });
});
