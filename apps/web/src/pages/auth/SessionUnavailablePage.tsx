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
      <h1 className="text-2xl font-semibold">暂时无法确认会话</h1>
      <p className="text-[var(--color-muted-foreground)]">
        身份服务暂时不可用。重试后可以继续之前的操作。
      </p>
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
        重试身份确认
      </Button>
      <Link className="block text-sm" to="/">
        返回首页
      </Link>
    </section>
  );
}
