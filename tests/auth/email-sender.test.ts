import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '../../apps/worker/auth/email-sender';
import type { EmailSenderBinding } from '../../apps/worker/auth/email-sender';

const message: Parameters<EmailSenderBinding['send']>[0] = {
  from: 'noreply@example.com',
  to: 'recipient@example.com',
  subject: '邮箱验证码',
  text: '验证码：654321',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Email binding sender (injected mocks only)', () => {
  it('passes a structured builder and preserves binding receiver', async () => {
    const binding: EmailSenderBinding = {
      async send(builder) {
        expect(this).toBe(binding);
        expect(builder).toBe(message);
        return { messageId: 'email-accepted' };
      },
    };
    expect(await sendEmail(binding, message)).toEqual({ status: 'accepted', messageId: 'email-accepted' });
  });

  it.each(['E_SENDER_NOT_VERIFIED', 'E_RATE_LIMIT_EXCEEDED', 'E_DELIVERY_FAILED'])(
    'classifies explicit service rejection %s without leaking its message', async (code) => {
      const send = vi.fn().mockRejectedValue(Object.assign(new Error(message.text), { code }));
      expect(await sendEmail({ send }, message)).toEqual({ status: 'failed', reason: 'service_rejected', code });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([new Error('network interrupted'), { code: 'E_INTERNAL_SERVER_ERROR' }, { code: '654321' }, null])(
    'keeps unconfirmed failures unknown (%j)', async (error) => {
      expect(await sendEmail({ send: vi.fn().mockRejectedValue(error) }, message))
        .toEqual({ status: 'unknown', reason: 'unconfirmed_error' });
    },
  );

  it('handles a synchronous binding exception', async () => {
    expect(await sendEmail({ send() { throw new Error('transport failure'); } }, message))
      .toEqual({ status: 'unknown', reason: 'unconfirmed_error' });
  });

  it.each([undefined, {}, { messageId: '' }, { messageId: '   ' }])(
    'does not accept an invalid confirmation (%j)', async (result) => {
      expect(await sendEmail({ send: vi.fn().mockResolvedValue(result) }, message))
        .toEqual({ status: 'unknown', reason: 'invalid_response' });
    },
  );

  it.each(['resolve', 'reject'] as const)('keeps timeout unknown after late %s without retrying', async (completion) => {
    vi.useFakeTimers();
    let resolve!: (value: { messageId: string }) => void;
    let reject!: (reason: unknown) => void;
    const send = vi.fn(() => new Promise<{ messageId: string }>((res, rej) => { resolve = res; reject = rej; }));
    const pending = sendEmail({ send }, message, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result).toEqual({ status: 'unknown', reason: 'timeout' });
    if (completion === 'resolve') resolve({ messageId: 'late-accepted' });
    else reject(new Error(message.text));
    await Promise.resolve();
    await Promise.resolve();
    expect(result.status).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline on immediate acceptance', async () => {
    vi.useFakeTimers();
    await sendEmail({ send: vi.fn().mockResolvedValue({ messageId: 'accepted' }) }, message);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])('rejects invalid timeout %s before sending', async (timeoutMs) => {
    const send = vi.fn();
    expect(await sendEmail({ send }, message, { timeoutMs })).toEqual({ status: 'failed', reason: 'invalid_timeout' });
    expect(send).not.toHaveBeenCalled();
  });

  it('logs the original exception for Workers Logs without exposing it in the outcome', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Resend connection failed');
    const outcome = await sendEmail({ send: vi.fn().mockRejectedValue(error) }, message);
    expect(log).toHaveBeenCalledExactlyOnceWith('Email send failed', error);
    expect(JSON.stringify(outcome)).not.toContain('654321');
    expect(JSON.stringify(outcome)).not.toContain(error.message);
    expect(JSON.stringify(log.mock.calls)).not.toContain(message.text);
  });
});
