import { prepare } from "../db";
import { normalizeEmail } from "./email-proof";
import type { EmailProofPurpose } from "./email-proof";

export const EMAIL_CHALLENGE_RESEND_COOLDOWN_MS = 60_000;
export type ChallengeSendResult = "accepted" | "failed" | "unknown";

/** Internal record, including its MAC; never serialize directly into an HTTP response. */
export interface StoredEmailChallenge {
  id: string;
  email_normalized: string;
  purpose: EmailProofPurpose;
  generation: number;
  code_mac: string;
  expires_at: number;
  attempts: number;
  send_status: "sending" | ChallengeSendResult;
  consumed_at: number | null;
  created_at: number;
  updated_at: number;
  send_requested_at: number;
}

export interface CreateOrResendChallengeInput {
  /** New slot ID for creation; existing slot ID for a resend. */
  readonly id: string;
  readonly email: string;
  readonly purpose: EmailProofPurpose;
  /** 0 means create only; otherwise compare this stored generation atomically. */
  readonly expectedGeneration: number;
  /** A13 MAC computed for expectedGeneration + 1 before the database operation. */
  readonly codeMac: string;
  readonly expiresAt: number;
}

export type ChallengeWriteResult =
  | { readonly ok: true; readonly challenge: StoredEmailChallenge }
  | { readonly ok: false; readonly reason: "conflict" };

const columns = "id, email_normalized, purpose, generation, code_mac, expires_at, attempts, send_status, consumed_at, created_at, updated_at, send_requested_at";

function requireTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid challenge timestamp");
}

function requireId(id: string): void {
  if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new TypeError("Invalid challenge ID");
  }
}

function requirePurpose(purpose: EmailProofPurpose): void {
  if (purpose !== "registration") throw new TypeError("Invalid challenge purpose");
}

/** Read-only snapshot for the next CAS; it grants no verification/registration rights. */
export async function findEmailChallenge(database: D1Database, email: string, purpose: EmailProofPurpose): Promise<StoredEmailChallenge | null> {
  const normalized = normalizeEmail(email);
  requirePurpose(purpose);
  return prepare<StoredEmailChallenge>(database,
    `SELECT ${columns} FROM email_challenges WHERE email_normalized = ? AND purpose = ?`, [normalized, purpose]).first();
}

/**
 * One atomic statement, never a read followed by an unconditional overwrite.
 * created_at is the original slot creation time; resends preserve it. now must not
 * precede that time or the latest update, and expiresAt must be after now.
 *
 * Conflict includes an existing/missing slot, stale generation, cooldown or clock
 * rollback. A17 should reread and re-evaluate before generating a new MAC/retrying;
 * do not send mail on conflict or reuse a MAC for a different generation. Crypto
 * and email network calls happen outside this repository and outside transactions.
 */
export async function createOrResendChallenge(
  database: D1Database,
  input: CreateOrResendChallengeInput,
  now: number,
): Promise<ChallengeWriteResult> {
  requireId(input.id);
  requirePurpose(input.purpose);
  const normalized = normalizeEmail(input.email);
  requireTime(now);
  requireTime(input.expiresAt);
  if (input.expiresAt <= now) throw new TypeError("Challenge expiry must follow the send request");
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || input.expectedGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Invalid expected challenge generation");
  }
  if (typeof input.codeMac !== "string" || input.codeMac.length !== 64 || !/^[0-9a-f]{64}$/.test(input.codeMac)) {
    throw new TypeError("Expected an email proof MAC");
  }

  const result = input.expectedGeneration === 0
    ? await prepare<StoredEmailChallenge>(database,
      `INSERT INTO email_challenges (${columns}) VALUES (?, ?, ?, 1, ?, ?, 0, 'sending', NULL, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING ${columns}`,
      [input.id, normalized, input.purpose, input.codeMac, input.expiresAt, now, now, now]).run()
    : await prepare<StoredEmailChallenge>(database,
      `UPDATE email_challenges SET generation = generation + 1, code_mac = ?, expires_at = ?,
         attempts = 0, send_status = 'sending', consumed_at = NULL, updated_at = ?, send_requested_at = ?
       WHERE id = ? AND email_normalized = ? AND purpose = ? AND generation = ?
         AND send_requested_at <= ? AND created_at <= ? AND updated_at <= ?
       RETURNING ${columns}`,
      [input.codeMac, input.expiresAt, now, now, input.id, normalized, input.purpose, input.expectedGeneration,
        now - EMAIL_CHALLENGE_RESEND_COOLDOWN_MS, now, now]).run();
  if (result.changes === 0) return { ok: false, reason: "conflict" };
  const challenge = result.rows[0];
  if (result.changes !== 1 || !challenge) throw new Error("Unexpected challenge write result");
  return { ok: true, challenge };
}

/** First recorded outcome per sending generation wins; stale/duplicate callbacks change 0 rows. */
export async function updateSendingResult(
  database: D1Database,
  id: string,
  generation: number,
  status: ChallengeSendResult,
  now: number,
): Promise<number> {
  requireId(id);
  requireTime(now);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("Invalid challenge generation");
  if (status !== "accepted" && status !== "failed" && status !== "unknown") throw new TypeError("Invalid challenge send result");
  return (await prepare(database,
    `UPDATE email_challenges SET send_status = ?, updated_at = ?
     WHERE id = ? AND generation = ? AND send_status = 'sending' AND consumed_at IS NULL
       AND created_at <= ? AND updated_at <= ? AND send_requested_at <= ?`,
    [status, now, id, generation, now, now, now]).run()).changes;
}

export interface ChallengeAttemptContext {
  readonly id: string;
  readonly generation: number;
  readonly maxAttempts: number;
}

export type ChallengeVerificationState =
  | { readonly outcome: "ready"; readonly challenge: StoredEmailChallenge; readonly remainingAttempts: number }
  | { readonly outcome: "missing" | "stale_generation" | "not_yet_valid" | "expired" | "consumed" | "not_accepted" | "exhausted" };

export type WrongChallengeAttemptResult =
  | { readonly outcome: "recorded"; readonly attempts: number; readonly remainingAttempts: number; readonly exhausted: boolean }
  | { readonly outcome: "not_recorded" };

function requireAttemptContext(context: ChallengeAttemptContext, now: number): void {
  requireId(context.id);
  requireTime(now);
  if (!Number.isSafeInteger(context.generation) || context.generation < 1 ||
    !Number.isSafeInteger(context.maxAttempts) || context.maxAttempts < 1) throw new TypeError("Invalid challenge attempt context");
}

/**
 * Internal snapshot only. A ready result does not authenticate a code or reserve
 * an attempt, and never consumes it. A17 checks the MAC separately; D12/A18 must
 * recheck generation, attempts, expiry and consumption inside registration's
 * atomic write because this snapshot can race a resend or another wrong attempt.
 */
export async function getChallengeVerificationState(
  database: D1Database,
  context: ChallengeAttemptContext,
  now: number,
): Promise<ChallengeVerificationState> {
  requireAttemptContext(context, now);
  const challenge = await prepare<StoredEmailChallenge>(database,
    `SELECT ${columns} FROM email_challenges WHERE id = ?`, [context.id]).first();
  if (!challenge) return { outcome: "missing" };
  if (challenge.generation !== context.generation) return { outcome: "stale_generation" };
  if (challenge.created_at > now || challenge.updated_at > now || challenge.send_requested_at > now) return { outcome: "not_yet_valid" };
  if (challenge.expires_at <= now) return { outcome: "expired" };
  if (challenge.consumed_at !== null) return { outcome: "consumed" };
  if (challenge.send_status !== "accepted") return { outcome: "not_accepted" };
  if (challenge.attempts >= context.maxAttempts) return { outcome: "exhausted" };
  return { outcome: "ready", challenge, remainingAttempts: context.maxAttempts - challenge.attempts };
}

/**
 * Call only after A13 rejects the submitted code for this exact generation.
 * This statement commits independently, before any registration transaction.
 * It is not returned as a prepared statement and must not be folded into A18's
 * batch: a later registration failure must not undo this wrong attempt.
 *
 * The predicate is authoritative even if a prior snapshot said ready. Zero rows
 * means not_recorded; the caller must stop, not infer permission from that result.
 * Each invocation represents one attempt, so do not auto-replay ambiguous DB
 * failures. This operation deliberately does not consume a correct proof.
 */
export async function recordWrongChallengeAttempt(
  database: D1Database,
  context: ChallengeAttemptContext,
  now: number,
): Promise<WrongChallengeAttemptResult> {
  requireAttemptContext(context, now);
  const result = await prepare<{ attempts: number }>(database,
    `UPDATE email_challenges SET attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND generation = ? AND send_status = 'accepted' AND consumed_at IS NULL
       AND expires_at > ? AND created_at <= ? AND updated_at <= ? AND send_requested_at <= ?
       AND attempts < ? RETURNING attempts`,
    [now, context.id, context.generation, now, now, now, now, context.maxAttempts]).run();
  if (result.changes === 0) return { outcome: "not_recorded" };
  const updated = result.rows[0];
  if (result.changes !== 1 || !updated) throw new Error("Unexpected challenge attempt result");
  const remainingAttempts = context.maxAttempts - updated.attempts;
  return { outcome: "recorded", attempts: updated.attempts, remainingAttempts, exhausted: remainingAttempts === 0 };
}
