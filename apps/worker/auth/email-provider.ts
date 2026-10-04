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
      const timer = setTimeout(() => {
        console.error('Resend request timed out', { timeoutMs: 10_000 });
        controller.abort();
      }, 10_000);
      const startedAt = Date.now();
      try {
        console.debug('Resend request started', { method: 'POST', url: 'https://api.resend.com/emails' });
        // Native Workers fetch, fixed HTTPS destination, no redirects or retries.
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          // Workers rejects redirect:'error' before dispatch; manual preserves the fixed destination.
          redirect: 'manual',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text }),
        });
        console.debug('Resend response received', { status: response.status, elapsedMs: Date.now() - startedAt });
        if (response.status >= 300 && response.status < 400) {
          try { await response.body?.cancel(); }
          catch (error) { console.error('Failed to discard Resend redirect response', error); }
          throw new Error(`Resend redirect rejected (HTTP ${response.status})`);
        }
        if (!response.ok) {
          // Keep provider error details in Workers Logs; never return them to the client.
          let detail = '';
          try { detail = await response.text(); }
          catch (error) { console.error('Failed to read Resend error response', error); }
          const error = new Error(`Resend HTTP ${response.status}: ${detail}`);
          if (response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) {
            throw Object.assign(error, { code: 'E_DELIVERY_FAILED' });
          }
          throw error;
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
