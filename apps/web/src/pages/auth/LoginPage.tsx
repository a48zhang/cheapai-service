import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LoginForm } from '../../features/session/LoginForm';
import { safeReturnPath } from '../../shared/lib/return-path';
import { useSession } from '../../features/session/useSession';

export default function LoginPage() {
  const { session, publicSettings } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnPath(params.get('returnTo'));
  useEffect(() => {
    if (!publicSettings) void session.bootstrap().catch(() => undefined);
  }, [publicSettings, session]);
  return (
    <>
      <header className="mb-7">
        <h1 className="text-2xl font-semibold">欢迎回来</h1>
      </header>
      <LoginForm onSuccess={() => navigate(returnTo, { replace: true })} />
      {publicSettings && publicSettings.registrationMode !== 'closed' && (
        <p className="mt-6 text-center text-sm text-[var(--color-muted-foreground)]">
          还没有账户？{' '}
          <Link
            className="font-medium text-[var(--color-primary)]"
            to={`/register?returnTo=${encodeURIComponent(returnTo)}`}
          >
            创建账户
          </Link>
        </p>
      )}
    </>
  );
}
