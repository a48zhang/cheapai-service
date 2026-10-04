/** Structural subset implemented by Env.EMAIL and local test doubles. */
export interface EmailSenderBinding {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}

export type EmailSendOutcome =
  | { status: 'accepted'; messageId: string }
  | { status: 'failed'; reason: 'invalid_timeout' | 'service_rejected'; code?: string }
  | { status: 'unknown'; reason: 'timeout' | 'unconfirmed_error' | 'invalid_response' };

// Documented explicit rejection codes. Internal/transport errors remain unknown:
// the service might have accepted the message before the response was lost.
const REJECTION_CODES = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS', 'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE',
  'E_DELIVERY_FAILED', 'E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED',
  'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
]);

function classifyError(error: unknown): EmailSendOutcome {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string' && REJECTION_CODES.has(code)) {
      return { status: 'failed', reason: 'service_rejected', code };
    }
  }
  return { status: 'unknown', reason: 'unconfirmed_error' };
}

/**
 * Await service acceptance, never claim mailbox delivery. No retry.
 * Native console output is collected by Cloudflare Workers Logs.
 * The binding has no cancellation API: timeout cannot undo a submitted email.
 * Persist this outcome against the caller's challenge generation, not just email.
 */
export async function sendEmail(
  binding: EmailSenderBinding,
  message: EmailMessageBuilder,
  options: { timeoutMs?: number } = {},
): Promise<EmailSendOutcome> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { status: 'failed', reason: 'invalid_timeout' };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<EmailSendOutcome>((resolve) => {
    timer = setTimeout(() => {
      console.error('Email send timed out', { timeoutMs });
      resolve({ status: 'unknown', reason: 'timeout' });
    }, timeoutMs);
  });
  // Attach both handlers before racing, so late rejections are consumed as well.
  const sending = Promise.resolve().then(() => binding.send(message)).then(
    (result): EmailSendOutcome => {
      if (result && typeof result.messageId === 'string' && result.messageId.trim()) {
        return { status: 'accepted', messageId: result.messageId };
      }
      console.error('Email provider returned no valid message ID');
      return { status: 'unknown', reason: 'invalid_response' };
    },
  ).catch((error: unknown): EmailSendOutcome => {
    console.error('Email send failed', error);
    return classifyError(error);
  });
  try {
    return await Promise.race([sending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
