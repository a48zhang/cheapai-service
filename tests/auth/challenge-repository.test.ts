import { describe, expect, it } from "vitest";
import { createOrResendChallenge, findEmailChallenge, getChallengeVerificationState, recordWrongChallengeAttempt, updateSendingResult } from "../../apps/worker/auth/challenge-repository";
import type { CreateOrResendChallengeInput } from "../../apps/worker/auth/challenge-repository";
import { hashEmailCode, verifyEmailCode } from "../../apps/worker/auth/email-proof";
import { prepare } from "../../apps/worker/db";
import { testEnv } from "../helpers/database";

const now = 1_788_619_000_000;
const input: CreateOrResendChallengeInput = {
  id: "a14-slot", email: " User+tag@Example.COM ", purpose: "registration", expectedGeneration: 0,
  codeMac: "a".repeat(64), expiresAt: now + 600_000,
};

describe("email challenge slots on native local D1", () => {
  it("creates one normalized slot and reads it without changing timestamps", async () => {
    const created = await createOrResendChallenge(testEnv.DB, input, now);
    expect(created).toEqual({ ok: true, challenge: {
      id: input.id, email_normalized: "user+tag@example.com", purpose: "registration", generation: 1,
      code_mac: input.codeMac, expires_at: input.expiresAt, attempts: 0, send_status: "sending", consumed_at: null,
      created_at: now, updated_at: now, send_requested_at: now,
    } });
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toEqual(created.ok ? created.challenge : null);
    expect(await findEmailChallenge(testEnv.DB, "user@example.com", "registration")).toBeNull();
  });

  it("concurrent creators have exactly one winner and never overwrite the winning MAC", async () => {
    const attempts = Array.from({ length: 8 }, (_, index) => ({ ...input, id: `a14-${index}`, codeMac: index.toString(16).repeat(64) }));
    const results = await Promise.all(attempts.map((candidate) => createOrResendChallenge(testEnv.DB, candidate, now)));
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    const stored = await findEmailChallenge(testEnv.DB, input.email, input.purpose);
    expect(stored).toEqual(winners[0]!.ok ? winners[0]!.challenge : null);
    expect((await prepare(testEnv.DB, "SELECT COUNT(*) AS count FROM email_challenges").first())?.count).toBe(1);
  });

  it("enforces the exact 60s resend boundary using send_requested_at, not updated_at", async () => {
    await createOrResendChallenge(testEnv.DB, input, now);
    await updateSendingResult(testEnv.DB, input.id, 1, "accepted", now + 59_000);
    const resend = { ...input, expectedGeneration: 1, codeMac: "b".repeat(64), expiresAt: now + 700_000 };
    expect(await createOrResendChallenge(testEnv.DB, resend, now + 59_999)).toEqual({ ok: false, reason: "conflict" });
    const result = await createOrResendChallenge(testEnv.DB, resend, now + 60_000);
    expect(result).toMatchObject({ ok: true, challenge: { generation: 2, created_at: now, updated_at: now + 60_000, send_requested_at: now + 60_000, send_status: "sending" } });
  });

  it("resets attempts and consumption, retains original creation time, and binds the new generation MAC", async () => {
    const key = new Uint8Array(32).fill(7);
    const firstMac = await hashEmailCode(key, { email: input.email, purpose: "registration", generation: 1, code: "123456" });
    await createOrResendChallenge(testEnv.DB, { ...input, codeMac: firstMac }, now);
    await prepare(testEnv.DB, "UPDATE email_challenges SET attempts = 4, consumed_at = ?, send_status = 'accepted' WHERE id = ?", [now + 1, input.id]).run();
    const secondMac = await hashEmailCode(key, { email: input.email, purpose: "registration", generation: 2, code: "654321" });
    const result = await createOrResendChallenge(testEnv.DB, { ...input, expectedGeneration: 1, codeMac: secondMac }, now + 60_000);
    expect(result).toMatchObject({ ok: true, challenge: { attempts: 0, consumed_at: null, generation: 2, code_mac: secondMac, created_at: now } });
    expect(await verifyEmailCode(key, { email: input.email, purpose: "registration", generation: 1, code: "123456" }, secondMac)).toBe(false);
    expect(await verifyEmailCode(key, { email: input.email, purpose: "registration", generation: 2, code: "654321" }, secondMac)).toBe(true);
  });

  it("concurrent resends compare generation atomically and keep exactly the winner", async () => {
    await createOrResendChallenge(testEnv.DB, input, now);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => createOrResendChallenge(testEnv.DB,
      { ...input, expectedGeneration: 1, codeMac: index.toString(16).repeat(64) }, now + 60_000)));
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toEqual(winners[0]!.ok ? winners[0]!.challenge : null);
    expect(winners[0]).toMatchObject({ ok: true, challenge: { generation: 2 } });
  });

  it("stale send callbacks, duplicate outcomes and reversed timestamps affect zero rows", async () => {
    await createOrResendChallenge(testEnv.DB, input, now);
    await createOrResendChallenge(testEnv.DB, { ...input, expectedGeneration: 1 }, now + 60_000);
    expect(await updateSendingResult(testEnv.DB, input.id, 1, "accepted", now + 61_000)).toBe(0);
    expect(await updateSendingResult(testEnv.DB, input.id, 2, "accepted", now + 59_999)).toBe(0);
    expect(await updateSendingResult(testEnv.DB, input.id, 2, "unknown", now + 61_000)).toBe(1);
    expect(await updateSendingResult(testEnv.DB, input.id, 2, "accepted", now + 62_000)).toBe(0);
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toMatchObject({ generation: 2, send_status: "unknown", updated_at: now + 61_000 });
  });

  it("competing current-generation outcomes have one winner", async () => {
    await createOrResendChallenge(testEnv.DB, input, now);
    const results = await Promise.all(["accepted", "failed", "unknown"].map((status) =>
      updateSendingResult(testEnv.DB, input.id, 1, status as "accepted" | "failed" | "unknown", now + 1)));
    expect(results.reduce((sum, changes) => sum + changes, 0)).toBe(1);
  });

  it("a resend racing its old send callback always leaves the new generation sending", async () => {
    await createOrResendChallenge(testEnv.DB, input, now);
    const [resent, oldCallbackChanges] = await Promise.all([
      createOrResendChallenge(testEnv.DB, { ...input, expectedGeneration: 1, codeMac: "b".repeat(64) }, now + 60_000),
      updateSendingResult(testEnv.DB, input.id, 1, "accepted", now + 60_000),
    ]);
    expect(resent.ok).toBe(true);
    expect([0, 1]).toContain(oldCallbackChanges);
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toMatchObject({
      generation: 2, send_status: "sending", code_mac: "b".repeat(64), send_requested_at: now + 60_000,
    });
  });

  it("does not create on a missing-generation CAS or update another slot", async () => {
    expect(await createOrResendChallenge(testEnv.DB, { ...input, expectedGeneration: 1 }, now)).toEqual({ ok: false, reason: "conflict" });
    await createOrResendChallenge(testEnv.DB, input, now);
    for (const change of [{ id: "missing" }, { email: "other@example.com" }, { expectedGeneration: 2 }]) {
      expect(await createOrResendChallenge(testEnv.DB, { ...input, expectedGeneration: 1, ...change }, now + 60_000)).toEqual({ ok: false, reason: "conflict" });
    }
    expect(await createOrResendChallenge(testEnv.DB, { ...input, email: "other@example.com" }, now)).toEqual({ ok: false, reason: "conflict" });
    expect(await updateSendingResult(testEnv.DB, "missing", 1, "failed", now)).toBe(0);
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toMatchObject({ generation: 1 });
  });

  it("rejects invalid generation/MAC/purpose/expiry without writing", async () => {
    for (const change of [{ expectedGeneration: -1 }, { expectedGeneration: 0.5 }, { expectedGeneration: Number.MAX_SAFE_INTEGER },
      { codeMac: "a".repeat(63) }, { codeMac: "A".repeat(64) }, { expiresAt: now }, { expiresAt: NaN },
      { purpose: "reset" }, { email: "bad" }, { id: "" }]) {
      await expect(createOrResendChallenge(testEnv.DB, { ...input, ...change } as CreateOrResendChallengeInput, now)).rejects.toThrow(TypeError);
    }
    await expect(updateSendingResult(testEnv.DB, input.id, 0, "accepted", now)).rejects.toThrow(TypeError);
    await expect(updateSendingResult(testEnv.DB, input.id, 1, "sending" as "accepted", now)).rejects.toThrow(TypeError);
    expect((await prepare(testEnv.DB, "SELECT COUNT(*) AS count FROM email_challenges").first())?.count).toBe(0);
  });
});

describe("independently committed wrong challenge attempts on native local D1", () => {
  const context = { id: input.id, generation: 1, maxAttempts: 5 };

  async function accepted(): Promise<void> {
    await createOrResendChallenge(testEnv.DB, input, now);
    await updateSendingResult(testEnv.DB, input.id, 1, "accepted", now);
  }

  it("ready is read-only and leaves correct proof consumption to registration", async () => {
    await accepted();
    const before = await findEmailChallenge(testEnv.DB, input.email, input.purpose);
    expect(await getChallengeVerificationState(testEnv.DB, context, now + 10)).toMatchObject({ outcome: "ready", remainingAttempts: 5 });
    expect(await getChallengeVerificationState(testEnv.DB, context, now + 20)).toMatchObject({ outcome: "ready", remainingAttempts: 5 });
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toEqual(before);
    expect(before).toMatchObject({ attempts: 0, consumed_at: null, updated_at: now });
  });

  it("concurrent wrong attempts stop at the configured maximum without lost updates", async () => {
    await accepted();
    const results = await Promise.all(Array.from({ length: 16 }, () => recordWrongChallengeAttempt(testEnv.DB, context, now + 1)));
    const recorded = results.filter((result) => result.outcome === "recorded");
    expect(recorded).toHaveLength(5);
    expect(recorded.map((result) => result.attempts).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(recorded.filter((result) => result.exhausted)).toHaveLength(1);
    expect(await getChallengeVerificationState(testEnv.DB, context, now + 1)).toEqual({ outcome: "exhausted" });
    expect(await recordWrongChallengeAttempt(testEnv.DB, context, now + 2)).toEqual({ outcome: "not_recorded" });
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toMatchObject({ attempts: 5, consumed_at: null });
  });

  it("one allowed attempt becomes exhausted exactly on its first failure", async () => {
    await accepted();
    expect(await recordWrongChallengeAttempt(testEnv.DB, { ...context, maxAttempts: 1 }, now))
      .toEqual({ outcome: "recorded", attempts: 1, remainingAttempts: 0, exhausted: true });
    expect(await getChallengeVerificationState(testEnv.DB, { ...context, maxAttempts: 1 }, now)).toEqual({ outcome: "exhausted" });
  });

  it("wrong attempts survive failure and rollback of a later registration-like batch", async () => {
    await accepted();
    expect(await recordWrongChallengeAttempt(testEnv.DB, context, now + 1)).toMatchObject({ outcome: "recorded", attempts: 1 });
    await expect(testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE email_challenges SET consumed_at = ? WHERE id = ?").bind(now + 2, input.id),
      testEnv.DB.prepare("UPDATE email_challenges SET attempts = -1 WHERE id = ?").bind(input.id),
    ])).rejects.toThrow();
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toMatchObject({ attempts: 1, consumed_at: null });
  });

  it("rejects exact expiry, consumed and stale-generation challenges without increment", async () => {
    await accepted();
    expect(await getChallengeVerificationState(testEnv.DB, context, input.expiresAt)).toEqual({ outcome: "expired" });
    expect(await recordWrongChallengeAttempt(testEnv.DB, context, input.expiresAt)).toEqual({ outcome: "not_recorded" });
    expect(await getChallengeVerificationState(testEnv.DB, { ...context, generation: 2 }, now)).toEqual({ outcome: "stale_generation" });
    expect(await recordWrongChallengeAttempt(testEnv.DB, { ...context, generation: 2 }, now)).toEqual({ outcome: "not_recorded" });
    await prepare(testEnv.DB, "UPDATE email_challenges SET consumed_at = ? WHERE id = ?", [now, input.id]).run();
    expect(await getChallengeVerificationState(testEnv.DB, context, now)).toEqual({ outcome: "consumed" });
    expect(await recordWrongChallengeAttempt(testEnv.DB, context, now)).toEqual({ outcome: "not_recorded" });
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toMatchObject({ attempts: 0 });
  });

  it("requires accepted delivery and rejects missing or future state", async () => {
    expect(await getChallengeVerificationState(testEnv.DB, context, now)).toEqual({ outcome: "missing" });
    expect(await recordWrongChallengeAttempt(testEnv.DB, context, now)).toEqual({ outcome: "not_recorded" });
    await createOrResendChallenge(testEnv.DB, input, now);
    for (const status of ["sending", "failed", "unknown"]) {
      await prepare(testEnv.DB, "UPDATE email_challenges SET send_status = ? WHERE id = ?", [status, input.id]).run();
      expect(await getChallengeVerificationState(testEnv.DB, context, now)).toEqual({ outcome: "not_accepted" });
      expect(await recordWrongChallengeAttempt(testEnv.DB, context, now)).toEqual({ outcome: "not_recorded" });
    }
    await prepare(testEnv.DB, "UPDATE email_challenges SET send_status = 'accepted' WHERE id = ?", [input.id]).run();
    expect(await getChallengeVerificationState(testEnv.DB, context, now - 1)).toEqual({ outcome: "not_yet_valid" });
    expect(await recordWrongChallengeAttempt(testEnv.DB, context, now - 1)).toEqual({ outcome: "not_recorded" });
  });

  it("a resend racing a wrong attempt cannot charge the new generation", async () => {
    await accepted();
    const [resent, attempt] = await Promise.all([
      createOrResendChallenge(testEnv.DB, { ...input, expectedGeneration: 1, codeMac: "b".repeat(64) }, now + 60_000),
      recordWrongChallengeAttempt(testEnv.DB, context, now + 60_000),
    ]);
    expect(resent.ok).toBe(true);
    expect(["recorded", "not_recorded"]).toContain(attempt.outcome);
    expect(await findEmailChallenge(testEnv.DB, input.email, input.purpose)).toMatchObject({ generation: 2, attempts: 0 });
    await updateSendingResult(testEnv.DB, input.id, 2, "accepted", now + 60_001);
    expect(await recordWrongChallengeAttempt(testEnv.DB, context, now + 60_002)).toEqual({ outcome: "not_recorded" });
    expect(await getChallengeVerificationState(testEnv.DB, { ...context, generation: 2 }, now + 60_002))
      .toMatchObject({ outcome: "ready", remainingAttempts: 5 });
  });

  it.each([{ maxAttempts: 0 }, { maxAttempts: -1 }, { maxAttempts: 1.5 }, { maxAttempts: Infinity },
    { generation: 0 }, { generation: NaN }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { id: "" }])(
    "rejects invalid attempt configuration %j", async (change) => {
      await expect(recordWrongChallengeAttempt(testEnv.DB, { ...context, ...change }, now)).rejects.toThrow(TypeError);
      await expect(getChallengeVerificationState(testEnv.DB, { ...context, ...change }, now)).rejects.toThrow(TypeError);
    },
  );
});
