import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useSession } from './useSession';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';
import { AuthErrorNotice } from './AuthErrorNotice';

const schema = z.object({
  email: z.string().trim().email('请输入有效邮箱'),
  password: z.string().min(1, '请输入密码'),
});
export function LoginForm({ onSuccess }: { onSuccess?: () => void }) {
  const { session, pending } = useSession();
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={handleSubmit(async (input) => {
        setError(null);
        try {
          await session.login(input);
          onSuccess?.();
        } catch (cause) {
          setError(cause);
        }
      })}
    >
      <Field label="邮箱" error={errors.email?.message}>
        <Input type="email" spellCheck={false} autoComplete="email" {...register('email')} />
      </Field>
      <Field label="密码" error={errors.password?.message}>
        <Input type="password" autoComplete="current-password" {...register('password')} />
      </Field>
      <AuthErrorNotice error={error} operation="login" />
      <Button type="submit" className="w-full" busy={isSubmitting || pending !== null}>
        登录
      </Button>
    </form>
  );
}
