import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../../features/session/useSession';
import { safeReturnPath } from '../../shared/lib/return-path';
import { Button } from '../../shared/ui/Button';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export default function SessionUnavailablePage() {
  const { session, pending, error } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <section className="mx-auto max-w-lg space-y-5 p-8">
      <h1 className="text-2xl font-semibold">暂时无法连接</h1>
      <p className="text-[var(--color-muted-foreground)]">请重试，连接恢复后将返回之前的页面。</p>
      <ApiErrorNotice error={error} />
      <Button
        busy={pending !== null}
        onClick={() =>
          void session
            .restore()
            .then(() => navigate(safeReturnPath(params.get('returnTo')), { replace: true }))
            .catch(() => undefined)
        }
      >
        重新连接
      </Button>
      <Button asChild variant="outline" className="ml-3">
        <Link to="/">返回首页</Link>
      </Button>
    </section>
  );
}
