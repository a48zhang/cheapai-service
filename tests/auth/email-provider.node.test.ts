import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEmailSender } from '../../apps/worker/auth/email-provider';
import { sendEmail } from '../../apps/worker/auth/email-sender';

const key = 'fixture-key-not-a-secret';
const message = { from: 'sender@example.invalid', to: 'recipient@example.invalid', subject: 'Verification', text: 'Code: 654321' };
const sender = () => resolveEmailSender({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: key })!;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Resend transport diagnostics (mock HTTP only)', () => {
  it('sends the plain-text contract once and maps the confirmation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'accepted-id' }));
    expect(await sendEmail(sender(), message)).toEqual({ status: 'accepted', messageId: 'accepted-id' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, to: [message.to] }),
    }));
  });

  it.each([400, 401, 403, 422, 429])('logs HTTP %i and provider error details directly in Workers Logs', async httpStatus => {
    const detail = 'API key is invalid';
    const response = Response.json({ name: 'validation_error', message: detail }, { status: httpStatus });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const outcome = await sendEmail(sender(), message);
    expect(outcome).toEqual({ status: 'failed', reason: 'service_rejected', code: 'E_DELIVERY_FAILED' });
    expect(console.error).toHaveBeenCalledWith('Email send failed', expect.objectContaining({
      message: expect.stringContaining(`Resend HTTP ${httpStatus}:`),
    }));
    expect(vi.mocked(console.error).mock.calls[0]![1].message).toContain(detail);
    expect(fetcher).toHaveBeenCalledOnce();
    const output = JSON.stringify([outcome, vi.mocked(console.debug).mock.calls, vi.mocked(console.error).mock.calls]);
    for (const value of [key, message.to, message.text]) expect(output).not.toContain(value);
    expect(JSON.stringify(outcome)).not.toContain(detail);
  });

  it.each([408, 409, 500, 503])('keeps HTTP %i acceptance uncertain', async httpStatus => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: httpStatus }));
    expect(await sendEmail(sender(), message)).toEqual({ status: 'unknown', reason: 'unconfirmed_error' });
  });

  it('preserves HTTP rejection when reading its body fails', async () => {
    const response = new Response('private error', { status: 403 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('body read failure'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    expect(await sendEmail(sender(), message)).toMatchObject({ status: 'failed' });
    expect(console.error).toHaveBeenCalledWith('Failed to read Resend error response', expect.any(Error));
  });

  it('logs the original transport exception with its stack', async () => {
    const error = new TypeError('fetch failed');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
    expect(await sendEmail(sender(), message)).toEqual({ status: 'unknown', reason: 'unconfirmed_error' });
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Email send failed', error);
  });

  it.each(['not-json', '{}', '{"id":""}', '{"id":" "}'])('rejects malformed success %s', async body => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    expect(await sendEmail(sender(), message)).toEqual({ status: 'unknown', reason: body === 'not-json' ? 'unconfirmed_error' : 'invalid_response' });
    expect(console.error).toHaveBeenCalled();
  });

  it('aborts the HTTP request and retains timeout uncertainty without retrying', async () => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('private abort details')), { once: true });
    }));
    const pending = sendEmail(sender(), message, { timeoutMs: 20_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: 'unknown', reason: 'unconfirmed_error' });
    expect(console.error).toHaveBeenCalledWith('Resend request timed out', { timeoutMs: 10_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores additional builder fields and sends only the plain-text contract', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'accepted-id' }));
    expect(await sendEmail(sender(), { ...message, html: '<p>ignored</p>' }))
      .toEqual({ status: 'accepted', messageId: 'accepted-id' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.resend.com/emails', expect.objectContaining({
      body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text }),
    }));
  });
});
