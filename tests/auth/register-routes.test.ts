import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegisterRoutes, REGISTER_BODY_MAX_BYTES, REGISTER_PATH } from "../../apps/worker/auth/register-routes";
import type { RegisterDependencies } from "../../apps/worker/auth/register";
import * as passwords from "../../apps/worker/auth/password";
import { issueCsrfToken } from "../../apps/worker/auth/csrf";
import { createOrResendChallenge, findEmailChallenge, updateSendingResult } from "../../apps/worker/auth/challenge-repository";
import { hashEmailCode } from "../../apps/worker/auth/email-proof";
import { generateToken, getTokenDisplayPrefix, hashToken } from "../../apps/worker/auth/tokens";
import { DEFAULT_CONFIG } from "../../apps/worker/config";
import { ApiError } from "../../apps/worker/http";
import { prepare } from "../../apps/worker/db";
import { testEnv } from "../helpers/database";

const origin = "https://register.example.com";
const email = "signup@example.com";
const password = "long enough registration password";
const code = "654321";
const key = new Uint8Array(32).fill(19);
let now: number;

async function setPolicy(mode = "open", verify = false): Promise<void> {
  await prepare(testEnv.DB, "UPDATE settings SET value_json=?,version=version+1,updated_at=? WHERE key='registration'",
    [JSON.stringify({ registrationMode: mode, emailVerificationEnabled: verify }), now]).run();
}

function route(overrides: Partial<RegisterDependencies> = {}) {
  const deps: RegisterDependencies = { database: testEnv.DB, gates: testEnv.GATE, trustedIp: "198.51.100.19",
    hmacKey: key, emailAvailable: true, now: () => now, ...overrides };
  const resolve = vi.fn(() => deps);
  const app = createRegisterRoutes({ trustedOrigin: origin, resolve });
  const csrf = issueCsrfToken();
  const headers = { "Content-Type": "application/json", Origin: origin,
    Cookie: csrf.setCookie.split(";")[0]!, "X-CSRF-Token": csrf.token };
  return { app, headers, resolve };
}

async function seedInvite(): Promise<string> {
  await prepare(testEnv.DB, `INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES ('a19-admin','a19-admin@example.com','test-hash','admin','active','default',2,60,'admin',?,?)`, [now, now]).run();
  const token = generateToken("invitation");
  await prepare(testEnv.DB, `INSERT INTO registration_codes (id,code_hash,display_prefix,expires_at,created_by,created_at,operation_id,ordinal)
    VALUES ('a19-code',?,?,?,'a19-admin',?,'a19-op',0)`,
    [await hashToken("invitation", token), getTokenDisplayPrefix("invitation", token), now + 600_000, now]).run();
  return token;
}

async function seedProof(): Promise<void> {
  await createOrResendChallenge(testEnv.DB, { id: "a19-proof", email, purpose: "registration", expectedGeneration: 0,
    codeMac: await hashEmailCode(key, { email, purpose: "registration", generation: 1, code }), expiresAt: now + 600_000 }, now);
  await updateSendingResult(testEnv.DB, "a19-proof", 1, "accepted", now);
}

beforeEach(async () => {
  now = Date.now();
  vi.spyOn(passwords, "hashPassword").mockResolvedValue("test-only-kdf-hash");
  await setPolicy();
});
afterEach(() => vi.restoreAllMocks());

describe("registration HTTP route with native local D1/DO", () => {
  it.each([["open", false], ["open", true], ["invite", false], ["invite", true]] as const)(
    "%s registration with verification=%s returns 201 and sets the cookie outside JSON", async (mode, verify) => {
      await setPolicy(mode, verify);
      const registrationCode = mode === "invite" ? await seedInvite() : "ignored-optional-invite";
      if (verify) await seedProof();
      const { app, headers } = route();
      const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers,
        body: JSON.stringify({ email, password, registrationCode, ...(verify ? { emailCode: code } : {}) }) });
      expect(response.status).toBe(201);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-sub2api_session=.*Secure; HttpOnly;/);
      const body = await response.json() as { data: { user: { id: string }; session: string }; request_id: string };
      expect(body.data.session).toBe("created");
      expect(body.request_id).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain("s2a_session_");
      expect(JSON.stringify(body)).not.toContain(password);
      expect(await prepare(testEnv.DB, "SELECT role,balance_units,email_verified_at,registration_code_id FROM users WHERE id=?", [body.data.user.id]).first())
        .toEqual({ role: "user", balance_units: 0, email_verified_at: verify ? now : null, registration_code_id: mode === "invite" ? "a19-code" : null });
    },
  );

  it("does not require an authenticated session but rejects missing/wrong CSRF and closed policy with 403", async () => {
    const { app, headers, resolve } = route();
    const body = JSON.stringify({ email, password });
    for (const badHeaders of [{ "Content-Type": "application/json" }, { ...headers, Origin: "https://evil.example.com" }, { ...headers, "X-CSRF-Token": "wrong" }]) {
      const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers: badHeaders, body });
      expect(response.status).toBe(403);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(resolve).not.toHaveBeenCalled();
    await setPolicy("closed", false);
    expect((await app.request(origin + REGISTER_PATH, { method: "POST", headers, body })).status).toBe(403);
  });

  it("preserves a trusted resolver's explicit 401 in the stable error envelope", async () => {
    const { headers } = route();
    const app = createRegisterRoutes({ trustedOrigin: origin, resolve() { throw new ApiError("unauthorized"); } });
    const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers, body: JSON.stringify({ email, password }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Authentication required." }, request_id: expect.any(String) });
  });

  it("ignores unknown fields without granting client-selected privileges", async () => {
    const { app, headers } = route();
    const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers,
      body: JSON.stringify({ email, password, role: "admin", group_id: "injected", balance_units: 999,
        trustedIp: "203.0.113.5", hmacKey: "injected", extension: true }) });
    expect(response.status).toBe(201);
    expect(await testEnv.DB.prepare("SELECT role,group_id,balance_units FROM users WHERE email_normalized=?").bind(email).first())
      .toEqual({ role: "user", group_id: "default", balance_units: 0 });
  });

  it("rejects malformed registration inputs", async () => {
    const { app, headers } = route();
    for (const body of ["{", "null", "[]", '{}', JSON.stringify({ email, password, emailCode: 654321 })]) {
      expect((await app.request(origin + REGISTER_PATH, { method: "POST", headers, body })).status).toBe(400);
    }
  });

  it("accepts exactly 8KiB of valid JSON whitespace and rejects one extra actual byte", async () => {
    const { app, headers, resolve } = route();
    const json = JSON.stringify({ email, password });
    const boundary = json + " ".repeat(REGISTER_BODY_MAX_BYTES - new TextEncoder().encode(json).byteLength);
    const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers, body: boundary });
    expect(response.status).toBe(201);
    const over = await app.request(origin + REGISTER_PATH, { method: "POST", headers, body: boundary + " " });
    expect(over.status).toBe(413);
    expect(over.headers.get("Cache-Control")).toBe("no-store");
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("counts streaming UTF-8 bytes and cancels oversized input despite a dishonest Content-Length", async () => {
    const { app, headers, resolve } = route();
    const cancel = vi.fn();
    const payload = new TextEncoder().encode(JSON.stringify({ email, password: "中".repeat(2800) }));
    expect(payload.byteLength).toBeGreaterThan(REGISTER_BODY_MAX_BYTES);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < payload.length) { controller.enqueue(payload.subarray(offset, offset + 500)); offset += 500; }
        else controller.enqueue(Uint8Array.of(32));
      }, cancel,
    }, { highWaterMark: 0 });
    const request = new Request(origin + REGISTER_PATH, { method: "POST", headers: { ...headers, "Content-Length": "1" }, body: stream });
    const response = await app.request(request);
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 and wrong content type", async () => {
    const { app, headers, resolve } = route();
    expect((await app.request(origin + REGISTER_PATH, { method: "POST", headers, body: Uint8Array.of(0xff) })).status).toBe(400);
    expect((await app.request(origin + REGISTER_PATH, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" })).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns 201 login_required after session failure and does not refund consumed credentials", async () => {
    await setPolicy("invite", true);
    const registrationCode = await seedInvite();
    await seedProof();
    await prepare(testEnv.DB, "CREATE TRIGGER a19_session_fail BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'session unavailable'); END").run();
    const { app, headers } = route();
    const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers, body: JSON.stringify({ email, password, registrationCode, emailCode: code }) });
    expect(response.status).toBe(201);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as { data: { user: { id: string }; session: string; next_action: string } };
    expect(body.data).toMatchObject({ session: "login_required", next_action: "login" });
    expect(await prepare(testEnv.DB, "SELECT used_by FROM registration_codes WHERE id='a19-code'").first()).toEqual({ used_by: body.data.user.id });
    expect(await findEmailChallenge(testEnv.DB, email, "registration")).toMatchObject({ consumed_at: now });
  });

  it("429 uses the trusted IP and includes Retry-After despite forged IP headers", async () => {
    const { app, headers } = route({ rateConfig: { ...DEFAULT_CONFIG, registrationIpMaxAttempts: 1 } });
    expect((await app.request(origin + REGISTER_PATH, { method: "POST", headers, body: JSON.stringify({ email, password }) })).status).toBe(201);
    const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers: { ...headers, "CF-Connecting-IP": "203.0.113.1", "X-Forwarded-For": "203.0.113.2" },
      body: JSON.stringify({ email: "other@example.com", password }) });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("does not leak SQL/HMAC details in dependency or service failures", async () => {
    const { headers } = route();
    const app = createRegisterRoutes({ trustedOrigin: origin, resolve() { throw new Error("SELECT secret_hmac FROM private_table"); } });
    const response = await app.request(origin + REGISTER_PATH, { method: "POST", headers, body: JSON.stringify({ email, password }) });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toMatch(/SELECT|secret_hmac|private_table/);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "service_unavailable" }, request_id: expect.any(String) });
  });
});
