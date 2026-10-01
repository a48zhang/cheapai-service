import { DEFAULT_CONFIG } from '../config';
import type { RuntimeConfig } from '../config';
import { normalizeEmail } from '../auth/email-proof';
import { MAX_RATE_WINDOW_OPERATIONS } from './rate-window';

interface GateQuotaResult { allowed: boolean; remaining: number; retryAfterMs: number }
export interface AuthGateNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    rateCheck(input: { operationId: string; limit: number; windowMs: number }): Promise<GateQuotaResult>;
    ratePeek(input: { limit: number; windowMs: number }): Promise<GateQuotaResult>;
  };
}
export type AuthRateConfig = Pick<RuntimeConfig,
  'loginWindowMs' | 'loginAccountFailureLimit' | 'loginIpAttemptLimit'
  | 'emailSendWindowMs' | 'emailSendPerAddressLimit' | 'emailSendPerIpLimit'>;
export type RegistrationRateConfig = Pick<RuntimeConfig, 'registrationIpMaxAttempts' | 'registrationWindowMs'>;
export interface AuthRateSubject {
  /** From the trusted Cloudflare connection context; never a body/forwarded header. */
  trustedIp: string;
  email: string;
}
export type AuthRateDecision =
  | { allowed: true; retryAfterMs: 0 }
  | { allowed: false; dimension: 'ip' | 'email'; retryAfterMs: number };
export type LoginRateAdmission =
  | Extract<AuthRateDecision, { allowed: false }>
  | { allowed: true; retryAfterMs: 0; recordFailure(): Promise<AuthRateDecision> };

function policy(config: AuthRateConfig): AuthRateConfig {
  const snapshot: AuthRateConfig = {
    loginWindowMs: config.loginWindowMs,
    loginAccountFailureLimit: config.loginAccountFailureLimit,
    loginIpAttemptLimit: config.loginIpAttemptLimit,
    emailSendWindowMs: config.emailSendWindowMs,
    emailSendPerAddressLimit: config.emailSendPerAddressLimit,
    emailSendPerIpLimit: config.emailSendPerIpLimit,
  };
  for (const [key, value] of Object.entries(snapshot)) {
    if (!Number.isSafeInteger(value) || value <= 0 || (!key.endsWith('WindowMs') && value > MAX_RATE_WINDOW_OPERATIONS)) {
      throw new TypeError('Invalid authentication rate policy');
    }
  }
  return snapshot;
}

function canonicalIp(ip: string): string {
  if (typeof ip !== 'string' || ip.length > 45 || ip !== ip.trim()) throw new TypeError('Invalid trusted client IP');
  if (!ip.includes(':')) {
    const parts = ip.split('.');
    if (parts.length !== 4 || parts.some((part) => part.length < 1 || part.length > 3
      || /[^0-9]/.test(part) || (part.length > 1 && part.startsWith('0')) || Number(part) > 255)) {
      throw new TypeError('Invalid trusted client IP');
    }
    return parts.join('.');
  }
  if (/[^0-9a-fA-F:.]/.test(ip)) throw new TypeError('Invalid trusted client IP');
  let normalized: string;
  try {
    normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    throw new TypeError('Invalid trusted client IP');
  }
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return normalized;
}

function subject(input: AuthRateSubject): { ip: string; email: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(input, 'trustedIp') || !Object.hasOwn(input, 'email')
    || Reflect.ownKeys(input).some((key) => key !== 'trustedIp' && key !== 'email')) {
    throw new TypeError('Expected trusted IP and email only');
  }
  return { ip: canonicalIp(input.trustedIp), email: normalizeEmail(input.email) };
}

async function digestSubject(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decision(result: GateQuotaResult, dimension: 'ip' | 'email'): AuthRateDecision {
  return result.allowed ? { allowed: true, retryAfterMs: 0 } : { allowed: false, dimension, retryAfterMs: result.retryAfterMs };
}

/**
 * Call before user lookup / KDF. Every attempt consumes IP quota; account quota
 * contains failures only. Success and KDF overload must NOT call recordFailure.
 * The quota peek is not a reservation: already-admitted in-flight checks may finish.
 * Gate failures propagate; callers must fail closed rather than proceed to KDF.
 */
export async function beginLoginAttempt(
  gates: AuthGateNamespace,
  input: AuthRateSubject,
  config: AuthRateConfig = DEFAULT_CONFIG,
): Promise<LoginRateAdmission> {
  const limits = policy(config);
  const normalized = subject(input);
  const [ipHash, emailHash] = await Promise.all([digestSubject(normalized.ip), digestSubject(normalized.email)]);
  // Never accept an operation ID from an HTTP client: replay would bypass attempts.
  const operationId = crypto.randomUUID();
  const ip = gates.get(gates.idFromName(`auth:login-ip:v1:${ipHash}`));
  const ipResult = decision(await ip.rateCheck({ operationId, windowMs: limits.loginWindowMs, limit: limits.loginIpAttemptLimit }), 'ip');
  if (!ipResult.allowed) return ipResult;
  const account = gates.get(gates.idFromName(`auth:login-failure:v1:${emailHash}`));
  const accountResult = decision(await account.ratePeek({ windowMs: limits.loginWindowMs, limit: limits.loginAccountFailureLimit }), 'email');
  if (!accountResult.allowed) return accountResult;
  let pending: Promise<AuthRateDecision> | undefined;
  return {
    allowed: true,
    retryAfterMs: 0,
    recordFailure() {
      if (!pending) {
        pending = account.rateCheck({ operationId, windowMs: limits.loginWindowMs, limit: limits.loginAccountFailureLimit })
          .then((result) => decision(result, 'email'))
          .catch((error: unknown) => { pending = undefined; throw error; });
      }
      return pending;
    },
  };
}

/**
 * Call before persisting/sending a verification code. Both dimensions must allow.
 * They are independent DOs: an email denial still counts the IP attempt. No rollback
 * or cross-DO atomicity is claimed. Gate failures propagate and never allow sending.
 */
export async function checkEmailSendRate(
  gates: AuthGateNamespace,
  input: AuthRateSubject,
  config: AuthRateConfig = DEFAULT_CONFIG,
): Promise<AuthRateDecision> {
  const limits = policy(config);
  const normalized = subject(input);
  const [ipHash, emailHash] = await Promise.all([digestSubject(normalized.ip), digestSubject(normalized.email)]);
  const operationId = crypto.randomUUID();
  const ip = gates.get(gates.idFromName(`auth:email-send-ip:v1:${ipHash}`));
  const ipResult = decision(await ip.rateCheck({ operationId, windowMs: limits.emailSendWindowMs, limit: limits.emailSendPerIpLimit }), 'ip');
  if (!ipResult.allowed) return ipResult;
  const email = gates.get(gates.idFromName(`auth:email-send-address:v1:${emailHash}`));
  return decision(await email.rateCheck({ operationId, windowMs: limits.emailSendWindowMs, limit: limits.emailSendPerAddressLimit }), 'email');
}

/** Registration submissions have their own IP window; sending a code cannot spend it. */
export async function checkRegistrationRate(
  gates: AuthGateNamespace,
  input: Pick<AuthRateSubject, 'trustedIp'>,
  config: RegistrationRateConfig = DEFAULT_CONFIG,
): Promise<AuthRateDecision> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(input, 'trustedIp') || Reflect.ownKeys(input).some((key) => key !== 'trustedIp')) {
    throw new TypeError('Expected trusted IP only');
  }
  const ip = canonicalIp(input.trustedIp);
  const limit = config.registrationIpMaxAttempts;
  const windowMs = config.registrationWindowMs;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RATE_WINDOW_OPERATIONS
    || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new TypeError('Invalid registration rate policy');
  }
  const subjectHash = await digestSubject(ip);
  const gate = gates.get(gates.idFromName(`auth:register-ip:v1:${subjectHash}`));
  return decision(await gate.rateCheck({ operationId: crypto.randomUUID(), limit, windowMs }), 'ip');
}
