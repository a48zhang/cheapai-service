import { Link } from 'react-router-dom';
import { RegisterForm } from '../../features/session/RegisterForm';

export default function RegisterPage() {
  return (
    <>
      <header className="mb-7">
        <h1 className="text-2xl font-semibold">开始使用 cheapai</h1>
      </header>
      <RegisterForm />
      <p className="mt-6 text-center text-sm text-[var(--color-muted-foreground)]">
        已有账户？{' '}
        <Link className="text-[var(--color-primary)]" to="/login">
          登录
        </Link>
      </p>
    </>
  );
}
