import { RouteButton } from '../../shared/ui/RouteButton';
import { useEffect } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthErrorNotice } from '../../features/session/AuthErrorNotice';
import { LoginForm } from '../../features/session/LoginForm';
import { safeReturnPath } from '../../shared/lib/return-path';
import { useSession } from '../../features/session/useSession';

export default function LoginPage() {
  const { session, publicSettings, settingsError, isAuthenticated } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnPath(params.get('returnTo'));
  useEffect(() => {
    if (!publicSettings) void session.bootstrap().catch(() => undefined);
  }, [publicSettings, session]);
  if (isAuthenticated) return <Navigate replace to={returnTo} />;
  return (
    <>
      <header className="mb-7">
        <h1 className="text-2xl font-semibold">欢迎回来</h1>
      </header>
      <LoginForm onSuccess={() => navigate(returnTo, { replace: true })} />
      {!publicSettings && settingsError && (
        <div className="mt-6">
          <AuthErrorNotice
            error={settingsError}
            operation="settings"
            onRetry={() => void session.bootstrap().catch(() => undefined)}
          />
        </div>
      )}
      {publicSettings && publicSettings.registrationMode !== 'closed' && (
        <p className="mt-6 text-center text-sm text-[var(--color-muted-foreground)]">
          还没有账户？{' '}
          <RouteButton
            className="font-medium text-[var(--color-primary)]"
            to={`/register?returnTo=${encodeURIComponent(returnTo)}`}
          >
            创建账户
          </RouteButton>
        </p>
      )}
    </>
  );
}
