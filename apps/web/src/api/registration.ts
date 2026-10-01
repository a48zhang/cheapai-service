import { authApi } from './auth.js';
import { ApiClientError } from './client.js';
export type { PublicSettings, RegisterInput, RegistrationResult } from './auth.js';
export type CodeSendOutcome =
  | { status: 'accepted'; retryAfterMs: number }
  | { status: 'failed' | 'unknown'; retryAfterMs: number; message: string; requestId: string | null };

/** Reuses the shared CSRF/API client. No duplicate nonce, cookie or token logic. */
export const registrationApi = Object.freeze({
  loadSettings: authApi.bootstrap,
  async sendCode(email: string): Promise<CodeSendOutcome> {
    try {
      const result = await authApi.sendVerificationCode(email);
      return { status: 'accepted', retryAfterMs: result.retry_after_ms };
    } catch (error) {
      const definitive = error instanceof ApiClientError && error.status !== null && error.status >= 400 && error.status < 500;
      // The route collapses send failed/unknown into 503. Do not infer delivery
      // or absence of delivery from a 5xx/network failure. A conservative local
      // minute limits resends; it is not a claim about server Retry-After.
      return { status: definitive ? 'failed' : 'unknown', retryAfterMs: !definitive || (error instanceof ApiClientError && error.status === 429) ? 60_000 : 0,
        message: error instanceof ApiClientError ? error.message : '暂时无法确认验证码请求结果。',
        requestId: error instanceof ApiClientError ? error.request_id : null };
    }
  },
});
