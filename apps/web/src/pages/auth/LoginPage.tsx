import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LoginForm } from '../../features/session/LoginForm';
import { safeReturnPath } from '../../shared/lib/return-path';

export default function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <>
      <header className="mb-7">
        <h1 className="text-2xl font-semibold">欢迎回来</h1>
        <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
          登录 cheapai，继续你的工作。
        </p>
      </header>
      <LoginForm
        onSuccess={() => navigate(safeReturnPath(params.get('returnTo')), { replace: true })}
      />
      <p className="mt-6 text-center text-sm text-[var(--color-muted-foreground)]">
        还没有账户？{' '}
        <Link className="font-medium text-[var(--color-primary)]" to="/register">
          创建账户
        </Link>
      </p>
    </>
  );
}
