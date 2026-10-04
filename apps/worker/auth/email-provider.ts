import type { Env } from '../env';
import type { EmailSenderBinding } from './email-sender';

/** Resolve locally; readiness diagnostics must never probe a provider. */
export function resolveEmailSender(
  env: Pick<Env, 'EMAIL_PROVIDER' | 'EMAIL' | 'RESEND_API_KEY'>,
): EmailSenderBinding | undefined {
  const provider = env.EMAIL_PROVIDER ?? 'cloudflare';
  if (provider === 'cloudflare') {
    return typeof env.EMAIL?.send === 'function' ? env.EMAIL : undefined;
  }
  if (provider !== 'resend') return undefined;
  const key = env.RESEND_API_KEY;
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key)) return undefined;
  return {
    async send(message) {
      // This adapter supports the existing plain-text transactional contract.
      // Fail explicitly on other builder fields rather than silently dropping them.
      if (typeof message.from !== 'string' || typeof message.to !== 'string'
        || typeof message.subject !== 'string' || typeof message.text !== 'string'
        || Object.keys(message).some(field => !['from', 'to', 'subject', 'text'].includes(field))) {
        throw Object.assign(new Error('Unsupported email message'), { code: 'E_VALIDATION_ERROR' });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        // Native Workers fetch, fixed HTTPS destination, no redirects or retries.
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text }),
        });
        if (!response.ok) {
          // Do not read provider error bodies: they may echo credentials/content.
          await response.body?.cancel();
          // Request timeout/conflict and server errors cannot prove non-acceptance.
          if (response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) {
            throw Object.assign(new Error('Email service rejected request'), { code: 'E_DELIVERY_FAILED' });
          }
          throw new Error('Email acceptance unconfirmed');
        }
        const result: unknown = await response.json();
        return { messageId: typeof result === 'object' && result !== null && 'id' in result
          && typeof result.id === 'string' ? result.id : '' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
