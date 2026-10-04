import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useSession } from './useSession';
import { RegistrationIdentityError } from './controller';
import { VerificationCodeField } from './VerificationCodeField';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

const schema = z.object({ email: z.string().trim().email('请输入有效邮箱'), password: z.string().min(6, '密码至少六个字符'), registrationCode: z.string(), emailCode: z.string() });
export function RegisterForm() {
  const { session, publicSettings, settingsError, error, pending } = useSession();
  const [created, setCreated] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const navigate = useNavigate();
  const { register, handleSubmit, watch, setValue, setError, formState: { errors, isSubmitting } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '', registrationCode: '', emailCode: '' } });
  useEffect(() => { void session.bootstrap().catch(() => undefined); }, [session]);
  if (!publicSettings) return <><p role="status">正在读取注册策略…</p><ApiErrorNotice error={settingsError} onRetry={() => void session.bootstrap().catch(() => undefined)} /></>;
  if (publicSettings.registrationMode === 'closed') return <p role="status">当前已关闭注册。</p>;
  if (created) return <div role="status" className="space-y-4"><p>账户已创建，请登录或恢复会话继续。</p><ApiErrorNotice error={error} /><Link to="/login">前往登录</Link></div>;
  return <form className="space-y-5" onSubmit={handleSubmit(async input => {
    if (created || codeBusy) return;
    if (publicSettings.registrationMode === 'invite' && !input.registrationCode.trim()) { setError('registrationCode', { message: '请输入邀请码' }); return; }
    if (publicSettings.emailVerificationEnabled && !input.emailCode.trim()) { setError('emailCode', { message: '请输入邮箱验证码' }); return; }
    try {
      const result = await session.register({ email: input.email, password: input.password,
        ...(publicSettings.registrationMode === 'invite' ? { registrationCode: input.registrationCode.trim() } : {}),
        ...(publicSettings.emailVerificationEnabled ? { emailCode: input.emailCode.trim() } : {}),
      });
      setCreated(true); setValue('password', ''); setValue('emailCode', ''); setValue('registrationCode', '');
      if (result.session === 'created') navigate('/', { replace: true });
    } catch (cause) {
      if (cause instanceof RegistrationIdentityError) { setCreated(true); setValue('password', ''); setValue('emailCode', ''); setValue('registrationCode', ''); }
    }
  })}>
    <Field label="邮箱" error={errors.email?.message}><Input type="email" autoComplete="email" {...register('email')} /></Field>
    <Field label="密码" description="至少六个字符" error={errors.password?.message}><Input type="password" autoComplete="new-password" {...register('password')} /></Field>
    {publicSettings.registrationMode === 'invite' && <Field label="邀请码" error={errors.registrationCode?.message}><Input {...register('registrationCode')} /></Field>}
    {publicSettings.emailVerificationEnabled && <VerificationCodeField email={watch('email')} value={watch('emailCode')} onChange={value => setValue('emailCode', value)} onBusyChange={setCodeBusy} disabled={isSubmitting} error={errors.emailCode?.message} />}
    <ApiErrorNotice error={error || settingsError} />
    <Button type="submit" className="w-full" busy={isSubmitting || pending !== null} disabled={codeBusy}>创建账户</Button>
  </form>;
}
