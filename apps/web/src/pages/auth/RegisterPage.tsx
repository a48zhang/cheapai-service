import { RouteButton } from '../../shared/ui/RouteButton';
import { useSession } from '../../features/session/useSession';
import { Navigate, useSearchParams } from 'react-router-dom';
import { RegisterForm } from '../../features/session/RegisterForm';
import { safeReturnPath } from '../../shared/lib/return-path';

export default function RegisterPage() {
  const { isAuthenticated } = useSession();
  const [params] = useSearchParams();
  const returnTo = safeReturnPath(params.get('returnTo'));
  if (isAuthenticated) return <Navigate replace to={returnTo} />;
  return (
    <>
      <header className="mb-7">
        <h1 className="text-2xl font-semibold">开始使用 CheapAI</h1>
      </header>
      <RegisterForm returnTo={returnTo} />
      <p className="mt-6 text-center text-sm text-[var(--color-muted-foreground)]">
        已有账户？{' '}
        <RouteButton
          className="text-[var(--color-primary)]"
          to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        >
          登录
        </RouteButton>
      </p>
    </>
  );
}
