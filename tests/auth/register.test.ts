import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerUser } from "../../apps/worker/auth/register";
import type { RegisterDependencies } from "../../apps/worker/auth/register";
import * as passwords from "../../apps/worker/auth/password";
import { createOrResendChallenge, findEmailChallenge, recordWrongChallengeAttempt, updateSendingResult } from "../../apps/worker/auth/challenge-repository";
import { hashEmailCode } from "../../apps/worker/auth/email-proof";
import { generateToken, getTokenDisplayPrefix, hashToken } from "../../apps/worker/auth/tokens";
import { DEFAULT_CONFIG } from "../../apps/worker/config";
import { prepare } from "../../apps/worker/db";
import { testEnv } from "../helpers/database";

let now: number;
const email = "new.user+tag@example.com";
const password = "a long registration password";
const key = new Uint8Array(32).fill(11);
const code = "012345";

function dependencies(overrides: Partial<RegisterDependencies> = {}): RegisterDependencies {
  return { database: testEnv.DB, gates: testEnv.GATE, trustedIp: "198.51.100.8", hmacKey: key,
    emailAvailable: true, now: () => now, ...overrides };
}

async function policy(mode = "open", verify = false): Promise<void> {
  await prepare(testEnv.DB, "UPDATE settings SET value_json=?,version=version+1,updated_at=? WHERE key='registration'",
    [JSON.stringify({ registrationMode: mode, emailVerificationEnabled: verify }), now]).run();
}

async function seedInvitation() {
  await prepare(testEnv.DB, `INSERT OR IGNORE INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES ('a18-admin','a18-admin@example.com','test-only-admin-hash','admin','active','default',0,2,60,'admin',?,?)`, [now, now]).run();
  const token = generateToken("invitation");
  const id = crypto.randomUUID();
  await prepare(testEnv.DB, `INSERT INTO registration_codes
    (id,code_hash,display_prefix,expires_at,created_by,created_at,operation_id,ordinal) VALUES (?,?,?,?,?,?,?,?)`,
    [id, await hashToken("invitation", token), getTokenDisplayPrefix("invitation", token), now + 600_000,
      "a18-admin", now - 1, crypto.randomUUID(), 0]).run();
  return { id, token };
}

async function seedChallenge(address = email) {
  const id = crypto.randomUUID();
  const mac = await hashEmailCode(key, { email: address, purpose: "registration", generation: 1, code });
  await createOrResendChallenge(testEnv.DB, { id, email: address, purpose: "registration", expectedGeneration: 0,
    codeMac: mac, expiresAt: now + 600_000 }, now - 60_000);
  await updateSendingResult(testEnv.DB, id, 1, "accepted", now);
  return id;
}

async function noRegisteredUsers(): Promise<void> {
  expect((await prepare(testEnv.DB, "SELECT COUNT(*) AS count FROM users WHERE created_via='registration'").first())?.count).toBe(0);
}

beforeEach(async () => {
  now = Date.now(); // D12 also compares expiry against the native database clock.
  vi.spyOn(passwords, "hashPassword").mockResolvedValue("test-only-kdf-hash");
  await policy();
});
afterEach(() => vi.restoreAllMocks());

describe("atomic registration service with native local D1 and Gate", () => {
  it("creates an ordinary zero-balance user, ignores an optional invite in open mode and issues a cookie", async () => {
    const deps = dependencies({ emailAvailable: false });
    delete deps.hmacKey;
    const result = await registerUser(deps, {
      email: " NEW.User+tag@EXAMPLE.COM ", password, registrationCode: "optional-invalid-ignored", emailCode: "ignored",
    });
    expect(result).toMatchObject({ status: "created", session: "created", user: { email_normalized: email }, setCookie: expect.stringContaining("__Host-sub2api_session=") });
    expect(await prepare(testEnv.DB, "SELECT role,status,balance_units,email_verified_at,registration_code_id,created_via FROM users WHERE id=?", [result.user.id]).first())
      .toEqual({ role: "user", status: "active", balance_units: 0, email_verified_at: null, registration_code_id: null, created_via: "registration" });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(result.user).not.toHaveProperty("password_hash");
  });

  it("atomically consumes both invitation and verified email with matching server timestamps", async () => {
    await policy("invite", true);
    const invitation = await seedInvitation();
    const challengeId = await seedChallenge();
    const result = await registerUser(dependencies(), { email, password, registrationCode: invitation.token, emailCode: code });
    expect(result.session).toBe("created");
    expect(await prepare(testEnv.DB, "SELECT used_by,used_at FROM registration_codes WHERE id=?", [invitation.id]).first())
      .toEqual({ used_by: result.user.id, used_at: now });
    expect(await prepare(testEnv.DB, "SELECT consumed_at FROM email_challenges WHERE id=?", [challengeId]).first()).toEqual({ consumed_at: now });
    expect(await prepare(testEnv.DB, "SELECT email_verified_at,created_at,balance_units FROM users WHERE id=?", [result.user.id]).first())
      .toEqual({ email_verified_at: now, created_at: now, balance_units: 0 });
  });

  it("runs one real Argon2id hash and verifies the stored password", async () => {
    vi.mocked(passwords.hashPassword).mockRestore();
    const result = await registerUser(dependencies(), { email, password });
    const row = await prepare<{ password_hash: string }>(testEnv.DB, "SELECT password_hash FROM users WHERE id=?", [result.user.id]).first();
    expect(row?.password_hash).toMatch(/^\$argon2id\$/);
    expect(await passwords.verifyPassword(password, row?.password_hash)).toBe(true);
  }, 30_000);

  it("closed policy, unavailable verified-email configuration and inactive default groups fail before KDF", async () => {
    await policy("closed", false);
    await expect(registerUser(dependencies(), { email, password })).rejects.toMatchObject({ code: "forbidden" });
    await policy("open", true);
    await expect(registerUser(dependencies({ emailAvailable: false }), { email, password })).rejects.toMatchObject({ code: "forbidden" });
    await policy("open", false);
    await prepare(testEnv.DB, "UPDATE groups SET status='disabled' WHERE id='default'").run();
    await expect(registerUser(dependencies(), { email, password })).rejects.toMatchObject({ code: "service_unavailable" });
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    await noRegisteredUsers();
  });

  it("applies independent register-IP quota before input validation or KDF", async () => {
    const deps = dependencies({ rateConfig: { ...DEFAULT_CONFIG, registrationIpMaxAttempts: 1 } });
    await expect(registerUser(deps, { email: "bad", password })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(registerUser(deps, { email, password })).rejects.toMatchObject({ code: "rate_limited" });
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    await noRegisteredUsers();
  });

  it("wrong email codes increment independently to five, leaving invitation and challenge unconsumed", async () => {
    await policy("invite", true);
    const invitation = await seedInvitation();
    await seedChallenge();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(registerUser(dependencies(), { email, password, registrationCode: invitation.token, emailCode: "999999" }))
        .rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(registerUser(dependencies(), { email, password, registrationCode: invitation.token, emailCode: code }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(await findEmailChallenge(testEnv.DB, email, "registration")).toMatchObject({ attempts: 5, consumed_at: null });
    expect(await prepare(testEnv.DB, "SELECT used_by FROM registration_codes WHERE id=?", [invitation.id]).first()).toEqual({ used_by: null });
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    await noRegisteredUsers();
  });

  it("a resend during KDF invalidates the previously correct proof without consuming the new generation", async () => {
    await policy("open", true);
    const id = await seedChallenge();
    vi.mocked(passwords.hashPassword).mockImplementationOnce(async () => {
      now += 60_000;
      await createOrResendChallenge(testEnv.DB, { id, email, purpose: "registration", expectedGeneration: 1, codeMac: "b".repeat(64), expiresAt: now + 600_000 }, now);
      await updateSendingResult(testEnv.DB, id, 2, "accepted", now);
      return "test-only-kdf-hash";
    });
    await expect(registerUser(dependencies(), { email, password, emailCode: code })).rejects.toMatchObject({ code: "conflict" });
    expect(await findEmailChallenge(testEnv.DB, email, "registration")).toMatchObject({ generation: 2, consumed_at: null, attempts: 0 });
    await noRegisteredUsers();
  });

  it.each(["version", "policy", "group"])("rechecks changed %s after KDF in the conditional insert", async (change) => {
    vi.mocked(passwords.hashPassword).mockImplementationOnce(async () => {
      if (change === "version") await prepare(testEnv.DB, "UPDATE settings SET version=version+1 WHERE key='registration'").run();
      if (change === "policy") await policy("closed", false);
      if (change === "group") await prepare(testEnv.DB, "UPDATE groups SET status='disabled' WHERE id='default'").run();
      return "test-only-kdf-hash";
    });
    await expect(registerUser(dependencies(), { email, password })).rejects.toMatchObject({ code: "conflict" });
    await noRegisteredUsers();
  });

  it.each(["invitation", "email"])("refreshes time after KDF and rejects %s expiry", async (which) => {
    await policy(which === "invitation" ? "invite" : "open", which === "email");
    const invitation = which === "invitation" ? await seedInvitation() : undefined;
    if (which === "email") await seedChallenge();
    vi.mocked(passwords.hashPassword).mockImplementationOnce(async () => { now += 600_000; return "test-only-kdf-hash"; });
    await expect(registerUser(dependencies(), { email, password, ...(invitation ? { registrationCode: invitation.token } : { emailCode: code }) }))
      .rejects.toMatchObject({ code: "conflict" });
    await noRegisteredUsers();
  });

  it("concurrent users competing for one invitation yield one committed user", async () => {
    await policy("invite", false);
    const invitation = await seedInvitation();
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => registerUser(dependencies(), {
      email: `person-${index}@example.com`, password, registrationCode: invitation.token,
    })));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await prepare(testEnv.DB, "SELECT COUNT(*) AS count FROM users WHERE created_via='registration'").first())?.count).toBe(1);
    expect((await prepare(testEnv.DB, "SELECT used_by FROM registration_codes WHERE id=?", [invitation.id]).first())?.used_by).toBeTruthy();
  });

  it("concurrent identical email proofs create exactly one user and consume once", async () => {
    await policy("open", true);
    await seedChallenge();
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => registerUser(dependencies(), { email, password, emailCode: code })));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await prepare(testEnv.DB, "SELECT COUNT(*) AS count FROM users WHERE created_via='registration'").first())?.count).toBe(1);
    expect((await findEmailChallenge(testEnv.DB, email, "registration"))?.consumed_at).toBe(now);
  });

  it("an email-consumption trigger failure rolls back the user and earlier invitation consumption", async () => {
    await policy("invite", true);
    const invitation = await seedInvitation();
    await seedChallenge();
    await prepare(testEnv.DB, "CREATE TRIGGER a18_ignore_consume BEFORE UPDATE OF consumed_at ON email_challenges BEGIN SELECT RAISE(IGNORE); END").run();
    await expect(registerUser(dependencies(), { email, password, registrationCode: invitation.token, emailCode: code }))
      .rejects.toMatchObject({ code: "conflict" });
    await noRegisteredUsers();
    expect(await prepare(testEnv.DB, "SELECT used_by,used_at FROM registration_codes WHERE id=?", [invitation.id]).first()).toEqual({ used_by: null, used_at: null });
    expect(await findEmailChallenge(testEnv.DB, email, "registration")).toMatchObject({ consumed_at: null });
  });

  it("session failure keeps committed user and consumed credentials and asks the caller to offer login", async () => {
    await policy("invite", true);
    const invitation = await seedInvitation();
    await seedChallenge();
    await prepare(testEnv.DB, "CREATE TRIGGER a18_fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'session failed'); END").run();
    const result = await registerUser(dependencies(), { email, password, registrationCode: invitation.token, emailCode: code });
    expect(result).toMatchObject({ status: "created", session: "login_required" });
    expect(result).not.toHaveProperty("setCookie");
    expect(await prepare(testEnv.DB, "SELECT used_by FROM registration_codes WHERE id=?", [invitation.id]).first()).toEqual({ used_by: result.user.id });
    expect(await findEmailChallenge(testEnv.DB, email, "registration")).toMatchObject({ consumed_at: now });
    expect(await prepare(testEnv.DB, "SELECT id FROM users WHERE id=?", [result.user.id]).first()).not.toBeNull();
  });

  it("does not accept a snapshot when wrong attempts reach the cap during KDF", async () => {
    await policy("open", true);
    const id = await seedChallenge();
    vi.mocked(passwords.hashPassword).mockImplementationOnce(async () => {
      for (let index = 0; index < 5; index += 1) await recordWrongChallengeAttempt(testEnv.DB, { id, generation: 1, maxAttempts: 5 }, now);
      return "test-only-kdf-hash";
    });
    await expect(registerUser(dependencies(), { email, password, emailCode: code })).rejects.toMatchObject({ code: "conflict" });
    expect(await findEmailChallenge(testEnv.DB, email, "registration")).toMatchObject({ attempts: 5, consumed_at: null });
    await noRegisteredUsers();
  });

  it("KDF failures and malformed elevated inputs fail closed without creating users", async () => {
    vi.mocked(passwords.hashPassword).mockRejectedValueOnce(new passwords.PasswordBusyError());
    await expect(registerUser(dependencies(), { email, password })).rejects.toMatchObject({ code: "service_unavailable" });
    await expect(registerUser(dependencies(), { email, password, role: "admin" } as never)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(registerUser(dependencies(), { email, password: "short" })).rejects.toMatchObject({ code: "invalid_request" });
    await noRegisteredUsers();
  });
});
