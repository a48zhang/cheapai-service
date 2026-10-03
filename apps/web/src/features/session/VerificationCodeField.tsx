import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiClientError } from '@cheapai/api-client/errors';
import { useSession } from './useSession';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';

export function VerificationCodeField({ email, value, onChange, disabled, error, onBusyChange }: {
  email: string; value: string; onChange: (value: string) => void; disabled?: boolean; error?: string | undefined; onBusyChange?: (busy: boolean) => void;
}) {
  const { auth } = useSession();
  const [sending, setSending] = useState(false);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState('');
  const latestEmail = useRef(email);
  const clearCode = useRef(onChange);
  clearCode.current = onChange;
  latestEmail.current = email;
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => { setMessage(''); clearCode.current(''); }, [email]);
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  async function send() {
    if (sending || disabled || seconds || !z.string().email().safeParse(email.trim()).success) return;
    const target = email;
    setSending(true); onBusyChange?.(true); setMessage('');
    try {
      const result = await auth.sendVerificationCode(email.trim());
      if (latestEmail.current !== target) return;
      setUntil(Date.now() + result.retry_after_ms); setNow(Date.now());
      setMessage('验证码发送请求已受理，请查收邮件。');
    } catch (cause) {
      if (latestEmail.current !== target) return;
      const definitive = cause instanceof ApiClientError && cause.status !== null && cause.status >= 400 && cause.status < 500;
      setMessage(definitive ? (cause as Error).message : '暂时无法确认发送结果，邮件仍可能到达，请先查收。');
      if (!definitive || (cause instanceof ApiClientError && cause.status === 429)) { setUntil(Date.now() + 60_000); setNow(Date.now()); }
    } finally { setSending(false); onBusyChange?.(false); }
  }
  return <div className="space-y-2">
    <Field id="email-code" label="邮箱验证码" error={error}><Input value={value} onChange={event => onChange(event.target.value)} inputMode="numeric" autoComplete="one-time-code" disabled={disabled} /></Field>
    <Button size="sm" variant="secondary" busy={sending} disabled={disabled || seconds > 0 || !z.string().email().safeParse(email.trim()).success} onClick={() => void send()}>{seconds ? `${seconds} 秒后重发` : '发送验证码'}</Button>
    {message && <p role="status" className="text-xs text-[var(--muted)]">{message}</p>}
  </div>;
}
