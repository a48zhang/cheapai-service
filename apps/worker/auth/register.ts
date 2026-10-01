import { DEFAULT_CONFIG } from "../config";
import { prepare } from "../db";
import type { DbValue } from "../db";
import { ApiError } from "../http";
import { checkRegistrationRate } from "../limits/auth-rate-limit";
import type { AuthGateNamespace, RegistrationRateConfig } from "../limits/auth-rate-limit";
import { findEmailChallenge, getChallengeVerificationState, recordWrongChallengeAttempt } from "./challenge-repository";
import type { StoredEmailChallenge } from "./challenge-repository";
import { normalizeEmail, verifyEmailCode } from "./email-proof";
import { hashPassword, validatePasswordInput } from "./password";
import { readDefaultGroupId, readRegistrationSettings } from "./registration-settings";
import { createCookieSession } from "./sessions";
import { hashToken } from "./tokens";

export interface RegisterInput {
  email: string;
  password: string;
  registrationCode?: string;
  emailCode?: string;
}

export interface RegisterDependencies {
  database: D1Database;
  gates: AuthGateNamespace;
  trustedIp: string;
  hmacKey?: Uint8Array;
  emailAvailable: boolean;
  now(): number;
  rateConfig?: RegistrationRateConfig;
}

interface RegisteredUser { id: string; email_normalized: string }
export type RegisterResult =
  | { status: "created"; user: RegisteredUser; session: "created"; setCookie: string }
  | { status: "created"; user: RegisteredUser; session: "login_required" };

export class RegistrationRateError extends ApiError {
  constructor(readonly retryAfterMs: number) { super("rate_limited"); }
}

// D12's current guard and consumption contract is fixed at five attempts.
const MAX_CHALLENGE_ATTEMPTS = 5;

function time(dependencies: RegisterDependencies): number {
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError("service_unavailable");
  return now;
}

function validateInput(input: RegisterInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !["email", "password", "registrationCode", "emailCode"].includes(key)) ||
    !validatePasswordInput(input.password).valid) throw new ApiError("invalid_request");
}

function isRegistrationConflict(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error instanceof Error; depth += 1, error = error.cause) {
    if (/registration_(?:policy_rejected|invitation_rejected|email_rejected|invitation_consumption_failed|email_consumption_failed)/.test(error.message) ||
      error.message.includes("UNIQUE constraint failed: users.email_normalized")) return true;
  }
  return false;
}

/**
 * Registration service only; HTTP CSRF/body parsing is the later route's duty.
 * One final INSERT SELECT rechecks all authoritative conditions; D12 consumes
 * proofs atomically. Wrong-code attempts are separately committed before KDF.
 * No credential is refunded and no user is removed if session creation fails.
 */
export async function registerUser(dependencies: RegisterDependencies, input: RegisterInput): Promise<RegisterResult> {
  try {
    if (!dependencies?.database || !dependencies.gates || typeof dependencies.now !== "function" ||
      typeof dependencies.emailAvailable !== "boolean") throw new ApiError("service_unavailable");
    const rate = await checkRegistrationRate(dependencies.gates, { trustedIp: dependencies.trustedIp }, dependencies.rateConfig);
    if (!rate.allowed) throw new RegistrationRateError(rate.retryAfterMs);
    const policy = await readRegistrationSettings(dependencies.database, { emailAvailable: dependencies.emailAvailable });
    if (!policy.valid || policy.registrationMode === "closed" || policy.version === null) throw new ApiError("forbidden");
    const groupId = await readDefaultGroupId(dependencies.database);
    if (!groupId) throw new ApiError("service_unavailable");
    validateInput(input);
    let email: string;
    try { email = normalizeEmail(input.email); } catch { throw new ApiError("invalid_request"); }
    const preflightNow = time(dependencies);

    let invitation: { id: string; hash: string } | undefined;
    if (policy.registrationMode === "invite") {
      let digest: string;
      try { digest = await hashToken("invitation", input.registrationCode as string); }
      catch (error) { if (error instanceof TypeError) throw new ApiError("invalid_request"); throw error; }
      const row = await prepare<{ id: string }>(dependencies.database,
        `SELECT id FROM registration_codes WHERE code_hash=? AND used_by IS NULL AND used_at IS NULL AND revoked_at IS NULL
           AND created_at<=? AND (expires_at IS NULL OR expires_at>?)`, [digest, preflightNow, preflightNow]).first();
      if (!row) throw new ApiError("invalid_request");
      invitation = { id: row.id, hash: digest };
    }
    // Open mode intentionally does not validate, hash or persist an optional invitation.
    let challenge: StoredEmailChallenge | undefined;
    if (policy.emailVerificationEnabled) {
      if (!(dependencies.hmacKey instanceof Uint8Array) || dependencies.hmacKey.byteLength < 32) throw new ApiError("service_unavailable");
      const found = await findEmailChallenge(dependencies.database, email, "registration");
      if (!found) throw new ApiError("invalid_request");
      const context = { id: found.id, generation: found.generation, maxAttempts: MAX_CHALLENGE_ATTEMPTS };
      const state = await getChallengeVerificationState(dependencies.database, context, preflightNow);
      if (state.outcome !== "ready") throw new ApiError("invalid_request");
      challenge = state.challenge;
      const matches = await verifyEmailCode(dependencies.hmacKey, {
        email, purpose: "registration", generation: challenge.generation, code: input.emailCode as string,
      }, challenge.code_mac);
      if (!matches) {
        await recordWrongChallengeAttempt(dependencies.database, context, time(dependencies));
        throw new ApiError("invalid_request");
      }
    }

    const passwordHash = await hashPassword(input.password);
    const now = time(dependencies); // Expiry and trigger timestamps must not use pre-KDF time.
    if (now < preflightNow) throw new ApiError("service_unavailable");
    const userId = crypto.randomUUID();
    const values: DbValue[] = [userId, email, passwordHash, challenge ? now : null, groupId,
      DEFAULT_CONFIG.defaultUserConcurrency, DEFAULT_CONFIG.defaultUserRpm, invitation?.id ?? null, now, now,
      policy.version, policy.registrationMode, policy.emailVerificationEnabled ? 1 : 0, groupId, email];
    let guards = `
      EXISTS (SELECT 1 FROM settings WHERE key='registration' AND version=?
        AND json_extract(value_json,'$.registrationMode')=? AND json_extract(value_json,'$.emailVerificationEnabled')=?)
      AND EXISTS (SELECT 1 FROM settings s JOIN groups g ON g.id=json_extract(s.value_json,'$')
        WHERE s.key='default_group_id' AND g.id=? AND g.status='active')
      AND NOT EXISTS (SELECT 1 FROM users WHERE email_normalized=?)`;
    if (invitation) {
      guards += ` AND EXISTS (SELECT 1 FROM registration_codes WHERE id=? AND code_hash=? AND used_by IS NULL
        AND used_at IS NULL AND revoked_at IS NULL AND created_at<=? AND (expires_at IS NULL OR expires_at>?))`;
      values.push(invitation.id, invitation.hash, now, now);
    }
    if (challenge) {
      guards += ` AND EXISTS (SELECT 1 FROM email_challenges WHERE id=? AND email_normalized=? AND purpose='registration'
        AND generation=? AND code_mac=? AND attempts=? AND attempts<? AND send_status='accepted' AND consumed_at IS NULL
        AND expires_at>? AND created_at<=? AND updated_at<=? AND send_requested_at<=?)`;
      values.push(challenge.id, email, challenge.generation, challenge.code_mac, challenge.attempts, MAX_CHALLENGE_ATTEMPTS, now, now, now, now);
    }
    let user: RegisteredUser;
    try {
      const result = await prepare<RegisteredUser>(dependencies.database,
        `INSERT INTO users (id,email_normalized,password_hash,role,status,email_verified_at,group_id,balance_units,
          concurrency_limit,rpm_limit,created_via,registration_code_id,created_at,updated_at)
         SELECT ?,?,?,'user','active',?,?,0,?,?,'registration',?,?,? WHERE ${guards}
         RETURNING id,email_normalized`, values).run();
      // D12 adds trigger writes to meta.changes. RETURNING cardinality establishes
      // this insert's result; zero rows is a lost race, never a successful signup.
      if (result.rows.length === 0) throw new ApiError("conflict");
      if (result.rows.length !== 1) throw new ApiError("service_unavailable");
      user = result.rows[0]!;
    } catch (error) {
      if (isRegistrationConflict(error)) throw new ApiError("conflict");
      throw error;
    }

    try {
      const session = await createCookieSession(dependencies.database, user.id, time(dependencies));
      return { status: "created", user, session: "created", setCookie: session.setCookie };
    } catch {
      // User + proof consumption already committed. Let the caller offer login.
      return { status: "created", user, session: "login_required" };
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("service_unavailable");
  }
}
