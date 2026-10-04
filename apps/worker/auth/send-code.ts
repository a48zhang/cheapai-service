import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DEFAULT_CONFIG } from "../config";
import { ApiError, apiError, apiSuccess, createRequestId } from "../http";
import { checkEmailSendRate } from "../limits/auth-rate-limit";
import type { AuthGateNamespace, AuthRateConfig } from "../limits/auth-rate-limit";
import { requireCsrf } from "./csrf";
import { createOrResendChallenge, EMAIL_CHALLENGE_RESEND_COOLDOWN_MS, findEmailChallenge, updateSendingResult } from "./challenge-repository";
import { generateEmailCode, hashEmailCode, normalizeEmail } from "./email-proof";
import { sendEmail } from "./email-sender";
import type { EmailSenderBinding } from "./email-sender";
import { readRegistrationSettings } from "./registration-settings";

export const SEND_VERIFY_CODE_PATH = "/api/v1/auth/send-verify-code";

export interface SendCodeDependencies {
  database: D1Database;
  gates: AuthGateNamespace;
  email: EmailSenderBinding;
  emailFrom: string;
  hmacKey: Uint8Array;
  now(): number;
  rateConfig?: AuthRateConfig;
  codeTtlMs?: number;
  emailTimeoutMs?: number;
}

export interface SendCodeResult {
  /** Provider acceptance only; never mailbox delivery confirmation. */
  status: "accepted" | "failed" | "unknown";
  retryAfterMs: number;
}

export class SendCodeRateError extends ApiError {
  constructor(readonly retryAfterMs: number) { super("rate_limited"); }
}

function clock(dependencies: SendCodeDependencies): number {
  const now = dependencies.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError("service_unavailable");
  return now;
}

async function requirePolicy(database: D1Database): Promise<void> {
  const policy = await readRegistrationSettings(database, { emailAvailable: true });
  if (!policy.valid || policy.registrationMode === "closed" || !policy.emailVerificationEnabled) throw new ApiError("forbidden");
}

/**
 * Anonymous registration code service. No user-existence lookup, no credential
 * inputs except the email, and no email attempt until a generation CAS commits.
 * Dependencies and trustedIp come from server context, never body/forwarded data.
 * Every invocation consumes its own rate admission; CAS retries do not send mail.
 */
export async function sendRegistrationCode(
  dependencies: SendCodeDependencies,
  input: { email: unknown; trustedIp: string },
): Promise<SendCodeResult> {
  try {
    if (!dependencies?.database || !dependencies.gates || typeof dependencies.email?.send !== "function" ||
      !(dependencies.hmacKey instanceof Uint8Array) || dependencies.hmacKey.byteLength < 32 || typeof dependencies.now !== "function") {
      throw new ApiError("service_unavailable");
    }
    const from = normalizeEmail(dependencies.emailFrom);
    const key = new Uint8Array(dependencies.hmacKey);
    const ttl = dependencies.codeTtlMs ?? DEFAULT_CONFIG.emailCodeTtlMs;
    const timeoutMs = dependencies.emailTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(ttl) || ttl <= EMAIL_CHALLENGE_RESEND_COOLDOWN_MS ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new ApiError("service_unavailable");
    await requirePolicy(dependencies.database);
    let email: string;
    try { email = normalizeEmail(input.email as string); }
    catch { throw new ApiError("invalid_request"); }
    const rate = await checkEmailSendRate(dependencies.gates, { email, trustedIp: input.trustedIp }, dependencies.rateConfig);
    if (!rate.allowed) throw new SendCodeRateError(rate.retryAfterMs);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await requirePolicy(dependencies.database);
      const previous = await findEmailChallenge(dependencies.database, email, "registration");
      const now = clock(dependencies);
      if (previous) {
        const remainingCooldown = previous.send_requested_at + EMAIL_CHALLENGE_RESEND_COOLDOWN_MS - now;
        if (remainingCooldown > 0) throw new SendCodeRateError(remainingCooldown);
        if (now < previous.updated_at || previous.generation >= Number.MAX_SAFE_INTEGER) throw new ApiError("conflict");
      }
      if (!Number.isSafeInteger(now + ttl)) throw new ApiError("service_unavailable");
      const expectedGeneration = previous?.generation ?? 0;
      const code = generateEmailCode();
      const codeMac = await hashEmailCode(key, { email, purpose: "registration", generation: expectedGeneration + 1, code });
      const written = await createOrResendChallenge(dependencies.database, {
        id: previous?.id ?? crypto.randomUUID(), email, purpose: "registration", expectedGeneration,
        codeMac, expiresAt: now + ttl,
      }, now);
      if (!written.ok) continue;

      // Policy may have closed during CAS. Fail closed before the irreversible send.
      // A DB read failure leaves 'sending', never a forged successful delivery.
      try { await requirePolicy(dependencies.database); }
      catch (error) {
        if (error instanceof ApiError && error.code === "forbidden") {
          await updateSendingResult(dependencies.database, written.challenge.id, written.challenge.generation, "failed", clock(dependencies));
        }
        throw error;
      }
      const outcome = await sendEmail(dependencies.email, {
        from, to: email, subject: "注册邮箱验证码", text: `您的注册验证码是：${code}。请勿向他人透露此验证码。`,
      }, { timeoutMs });
      const changes = await updateSendingResult(dependencies.database, written.challenge.id, written.challenge.generation, outcome.status, clock(dependencies));
      if (changes !== 1) throw new ApiError("conflict");
      return { status: outcome.status, retryAfterMs: EMAIL_CHALLENGE_RESEND_COOLDOWN_MS };
    }
    throw new ApiError("conflict");
  } catch (error) {
    // Preserve public typed decisions only. DB/Gate/crypto errors fail closed.
    if (error instanceof ApiError) throw error;
    console.error('Registration email code failed', error);
    throw new ApiError("service_unavailable");
  }
}

export interface SendCodeRouteDependencies extends SendCodeDependencies {
  trustedOrigin: string;
  /** Trusted deployment adapter; do not derive this from arbitrary forwarded headers. */
  trustedIp(request: Request): string | Promise<string>;
}

/** Mount in A31; this factory does not modify the application's route table. */
export function createSendCodeRoutes(dependencies: SendCodeRouteDependencies): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    await next();
    context.res.headers.set("Cache-Control", "no-store");
  });
  app.post(SEND_VERIFY_CODE_PATH, requireCsrf(dependencies.trustedOrigin), bodyLimit({
    maxSize: 2048,
    onError: () => apiError(new ApiError("payload_too_large"), createRequestId()),
  }), async (context) => {
    const requestId = createRequestId();
    console.debug('Registration email request started', { request_id: requestId });
    try {
      if (context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new ApiError("invalid_request");
      let body: unknown;
      try { body = await context.req.json(); } catch { throw new ApiError("invalid_request"); }
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "email")) {
        throw new ApiError("invalid_request");
      }
      if (typeof dependencies.trustedIp !== "function") throw new ApiError("service_unavailable");
      const result = await sendRegistrationCode(dependencies, {
        email: (body as { email: unknown }).email, trustedIp: await dependencies.trustedIp(context.req.raw),
      });
      console.debug('Registration email request completed', { request_id: requestId, status: result.status });
      const response = result.status === "accepted"
        ? apiSuccess({ status: "accepted", retry_after_ms: result.retryAfterMs }, requestId, 202)
        : apiError(new ApiError("service_unavailable"), requestId);
      response.headers.set("Retry-After", Math.ceil(result.retryAfterMs / 1000).toString());
      return response;
    } catch (error) {
      console.error('Registration email request failed', { request_id: requestId }, error);
      const response = apiError(error instanceof ApiError ? error : new ApiError("service_unavailable"), requestId);
      if (error instanceof SendCodeRateError) response.headers.set("Retry-After", Math.ceil(error.retryAfterMs / 1000).toString());
      return response;
    }
  });
  return app;
}
