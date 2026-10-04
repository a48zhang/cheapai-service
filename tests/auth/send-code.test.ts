import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSendCodeRoutes, SEND_VERIFY_CODE_PATH, sendRegistrationCode } from "../../apps/worker/auth/send-code";
import type { SendCodeDependencies } from "../../apps/worker/auth/send-code";
import { createOrResendChallenge, findEmailChallenge } from "../../apps/worker/auth/challenge-repository";
import { verifyEmailCode } from "../../apps/worker/auth/email-proof";
import { issueCsrfToken } from "../../apps/worker/auth/csrf";
import { DEFAULT_CONFIG } from "../../apps/worker/config";
import { prepare } from "../../apps/worker/db";
import { testEnv } from "../helpers/database";
import { resolveEmailSender } from "../../apps/worker/auth/email-provider";

let now: number;
const address = "user+tag@example.com";
const subject = { email: address, trustedIp: "198.51.100.1" };
const key = new Uint8Array(32).fill(7);
const origin = "https://api.example.com";

async function policy(mode = "open", verification = true): Promise<void> {
  await prepare(testEnv.DB, "UPDATE settings SET value_json=? WHERE key='registration'",
    [JSON.stringify({ registrationMode: mode, emailVerificationEnabled: verification })]).run();
}

function dependencies(overrides: Partial<SendCodeDependencies> = {}) {
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: "mock-email-accepted" }));
  const deps: SendCodeDependencies = {
    database: testEnv.DB, gates: testEnv.GATE, email: { send }, emailFrom: "noreply@example.com", hmacKey: key,
    now: () => now, rateConfig: { ...DEFAULT_CONFIG, emailSendPerAddressLimit: 30, emailSendPerIpLimit: 30 },
    ...overrides,
  };
  return { deps, send };
}

beforeEach(async () => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await policy();
});
afterEach(() => vi.restoreAllMocks());

describe("registration send-code service with native D1/Gate and mock Email", () => {
  it("persists the generation MAC before sending and exposes no code or mailbox identity", async () => {
    const { deps, send } = dependencies();
    send.mockImplementation(async () => {
      expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ generation: 1, send_status: "sending" });
      return { messageId: "mock-confirmation" };
    });
    const result = await sendRegistrationCode(deps, { ...subject, email: " USER+tag@EXAMPLE.COM " });
    expect(result).toEqual({ status: "accepted", retryAfterMs: 60_000 });
    expect(send).toHaveBeenCalledOnce();
    const message = send.mock.calls[0]![0];
    expect(message).toMatchObject({ from: "noreply@example.com", to: address });
    const code = /[0-9]{6}/.exec(message.text as string)![0];
    const row = (await findEmailChallenge(testEnv.DB, address, "registration"))!;
    expect(row).toMatchObject({ generation: 1, send_status: "accepted", attempts: 0, consumed_at: null });
    expect(await verifyEmailCode(key, { email: address, purpose: "registration", generation: 1, code }, row.code_mac)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(JSON.stringify(result)).not.toContain(address);
    expect(row).not.toHaveProperty("code");
  });

  it("reads authoritative closed/disabled policy before quota or mail and supports invite", async () => {
    const { deps, send } = dependencies();
    const gates = { idFromName() { throw new Error("Quota must not run"); } } as unknown as SendCodeDependencies["gates"];
    for (const [mode, enabled] of [["closed", true], ["open", false], ["invite", false]] as const) {
      await policy(mode, enabled);
      await expect(sendRegistrationCode({ ...deps, gates }, subject)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(send).not.toHaveBeenCalled();
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toBeNull();
    await policy("invite", true);
    expect((await sendRegistrationCode(deps, subject)).status).toBe("accepted");
  });

  it("does not query user existence or disclose whether the mailbox already belongs to a user", async () => {
    const queries: string[] = [];
    const database = { prepare(sql: string) { queries.push(sql); return testEnv.DB.prepare(sql); } } as D1Database;
    const { deps } = dependencies({ database });
    expect(await sendRegistrationCode(deps, subject)).toEqual({ status: "accepted", retryAfterMs: 60_000 });
    expect(queries.some((sql) => /\busers\b/i.test(sql))).toBe(false);
  });

  it("enforces both native DO quota dimensions before any second send", async () => {
    const { deps, send } = dependencies({ rateConfig: { ...DEFAULT_CONFIG, emailSendPerIpLimit: 1, emailSendPerAddressLimit: 1 } });
    await sendRegistrationCode(deps, subject);
    await expect(sendRegistrationCode(deps, { ...subject, email: "other@example.com" })).rejects.toMatchObject({ code: "rate_limited" });
    now += 60_000;
    await expect(sendRegistrationCode(deps, { ...subject, trustedIp: "198.51.100.2" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(send).toHaveBeenCalledOnce();
    expect(await findEmailChallenge(testEnv.DB, "other@example.com", "registration")).toBeNull();
  });

  it("concurrent calls send once; immediate retry observes cooldown without sending again", async () => {
    const { deps, send } = dependencies();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => sendRegistrationCode(deps, subject)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
    await expect(sendRegistrationCode(deps, subject)).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 60_000 });
    now += 60_000;
    await sendRegistrationCode(deps, subject);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ generation: 2 });
  });

  it("a CAS conflict rereads and recomputes a MAC for the winning next generation", async () => {
    const { deps, send } = dependencies();
    const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
    const sign = vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(async (...args) => {
      await createOrResendChallenge(testEnv.DB, {
        id: "racing-slot", email: address, purpose: "registration", expectedGeneration: 0,
        codeMac: "a".repeat(64), expiresAt: now + 600_000,
      }, now - 60_000);
      return nativeSign(...args);
    });
    expect((await sendRegistrationCode(deps, subject)).status).toBe("accepted");
    expect(sign).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    const row = (await findEmailChallenge(testEnv.DB, address, "registration"))!;
    const code = /[0-9]{6}/.exec(send.mock.calls[0]![0].text as string)![0];
    expect(row.generation).toBe(2);
    expect(await verifyEmailCode(key, { email: address, purpose: "registration", generation: 2, code }, row.code_mac)).toBe(true);
    expect(await verifyEmailCode(key, { email: address, purpose: "registration", generation: 1, code }, row.code_mac)).toBe(false);
  });

  it("bounds repeated CAS conflicts to three writes and never sends on zero-row writes", async () => {
    await prepare(testEnv.DB, "CREATE TRIGGER a17_ignore_create BEFORE INSERT ON email_challenges BEGIN SELECT RAISE(IGNORE); END").run();
    let writes = 0;
    const database = { prepare(sql: string) { if (sql.includes("INSERT INTO email_challenges")) writes += 1; return testEnv.DB.prepare(sql); } } as D1Database;
    const { deps, send } = dependencies({ database });
    await expect(sendRegistrationCode(deps, subject)).rejects.toMatchObject({ code: "conflict" });
    expect(writes).toBe(3);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["failed", "unknown"] as const)("persists %s mail outcomes without claiming delivery or retrying", async (status) => {
    const { deps, send } = dependencies();
    send.mockRejectedValue(status === "failed" ? { code: "E_SENDER_NOT_VERIFIED" } : new Error("network ambiguous"));
    expect(await sendRegistrationCode(deps, subject)).toEqual({ status, retryAfterMs: 60_000 });
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ send_status: status });
    expect(send).toHaveBeenCalledOnce();
  });

  it("times out to unknown and does not apply a late acceptance", async () => {
    const { deps, send } = dependencies({ emailTimeoutMs: 5 });
    let resolve!: (value: { messageId: string }) => void;
    send.mockImplementation(() => new Promise((done) => { resolve = done; }));
    expect((await sendRegistrationCode(deps, subject)).status).toBe("unknown");
    resolve({ messageId: "too-late" });
    await Promise.resolve();
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ send_status: "unknown" });
  });

  it("does not let an old mail result overwrite a resend created while sending", async () => {
    const { deps, send } = dependencies();
    send.mockImplementation(async () => {
      const row = (await findEmailChallenge(testEnv.DB, address, "registration"))!;
      now += 60_000;
      await createOrResendChallenge(testEnv.DB, { id: row.id, email: address, purpose: "registration", expectedGeneration: row.generation,
        codeMac: "b".repeat(64), expiresAt: now + 600_000 }, now);
      return { messageId: "old-accepted" };
    });
    await expect(sendRegistrationCode(deps, subject)).rejects.toMatchObject({ code: "conflict" });
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ generation: 2, send_status: "sending" });
  });

  it("a policy closure while preparing the CAS prevents sending", async () => {
    const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(async (...args) => {
      await policy("closed", true);
      return nativeSign(...args);
    });
    const { deps, send } = dependencies();
    await expect(sendRegistrationCode(deps, subject)).rejects.toMatchObject({ code: "forbidden" });
    expect(send).not.toHaveBeenCalled();
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ send_status: "failed" });
  });

  it("missing dependencies and Gate/DB failures fail closed, including failure after mail acceptance", async () => {
    const { deps, send } = dependencies();
    for (const change of [{ email: undefined }, { hmacKey: new Uint8Array(31) }, { emailFrom: "" }, { emailTimeoutMs: 0 },
      { database: { prepare() { throw new Error("secret database details"); } } },
      { gates: { idFromName() { throw new Error("gate unavailable"); } } }]) {
      await expect(sendRegistrationCode({ ...deps, ...change } as SendCodeDependencies, subject)).rejects.toMatchObject({ code: "service_unavailable" });
    }
    expect(send).not.toHaveBeenCalled();
    await prepare(testEnv.DB, "CREATE TRIGGER a17_fail_callback BEFORE UPDATE OF send_status ON email_challenges BEGIN SELECT RAISE(ABORT, 'callback failed'); END").run();
    await expect(sendRegistrationCode(deps, subject)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(send).toHaveBeenCalledOnce();
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ send_status: "sending" });
  });
});

describe("mountable anonymous send-code route", () => {
  function route(overrides: Partial<SendCodeDependencies> = {}) {
    const created = dependencies(overrides);
    const app = createSendCodeRoutes({ ...created.deps, trustedOrigin: origin, trustedIp: () => "198.51.100.1" });
    const csrf = issueCsrfToken();
    const headers = { "Content-Type": "application/json", Origin: origin, Cookie: csrf.setCookie.split(";")[0]!, "X-CSRF-Token": csrf.token };
    return { ...created, app, headers };
  }

  it("accepts an anonymous CSRF nonce and returns only a generic acceptance envelope", async () => {
    const { app, headers, send } = route();
    const response = await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", headers, body: JSON.stringify({ email: address }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ data: { status: "accepted", retry_after_ms: 60_000 }, request_id: expect.any(String) });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects missing CSRF, extra trusted fields and oversized bodies before mail", async () => {
    const { app, headers, send } = route();
    expect((await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", body: JSON.stringify({ email: address }) })).status).toBe(403);
    for (const body of [{ email: address, trustedIp: "203.0.113.9" }, { email: address, hmacKey: "injected" }, { email: address, purpose: "reset" }]) {
      expect((await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", headers, body: "x".repeat(2049) })).status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores forged IP headers and reports rate limiting using trusted context", async () => {
    const { app, headers, send } = route({ rateConfig: { ...DEFAULT_CONFIG, emailSendPerIpLimit: 1 } });
    expect((await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", headers, body: JSON.stringify({ email: address }) })).status).toBe(202);
    const response = await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", headers: { ...headers, "X-Forwarded-For": "203.0.113.1", "CF-Connecting-IP": "203.0.113.2" }, body: JSON.stringify({ email: "other@example.com" }) });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(send).toHaveBeenCalledOnce();
  });

  it("returns 503 rather than claiming a failed message was sent", async () => {
    const { app, headers, send } = route();
    send.mockRejectedValue({ code: "E_SENDER_NOT_VERIFIED", message: "sensitive-provider-detail" });
    const response = await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", headers, body: JSON.stringify({ email: address }) });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive-provider-detail");
  });

  it("keeps provider details in CF console logs and correlates the response within the invocation", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: "API key is invalid" }, { status: 401 }));
    const { app, headers } = route({ email: resolveEmailSender({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "fixture-key" })! });
    const response = await app.request(origin + SEND_VERIFY_CODE_PATH, { method: "POST", headers, body: JSON.stringify({ email: address }) });
    const body = await response.json<{ request_id: string }>();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(debug).toHaveBeenCalledWith('Registration email request started', { request_id: body.request_id });
    expect(debug).toHaveBeenCalledWith('Registration email request completed', { request_id: body.request_id, status: 'failed' });
    expect(log).toHaveBeenCalledWith('Email send failed', expect.objectContaining({ message: expect.stringContaining('API key is invalid') }));
    expect(JSON.stringify(body)).not.toContain('API key is invalid');
    expect(await findEmailChallenge(testEnv.DB, address, "registration")).toMatchObject({ send_status: "failed" });
  });
});
