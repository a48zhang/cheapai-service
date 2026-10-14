import { CircleAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';

export function ApiErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
}) {
  if (!error) return null;
  const requestId =
    typeof error === 'object' && 'request_id' in error ? String(error.request_id ?? '') : '';
  const message = error instanceof Error ? error.message : '操作暂时无法完成，请重试。';
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4"
    >
      <CircleAlert
        size={20}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-[var(--color-danger)]"
      />
      <div className="min-w-0 flex-1 space-y-3">
        <p className="break-words text-[15px] leading-6 text-[var(--color-foreground)]">
          {message}
        </p>
        {requestId && (
          <details className="text-sm text-[var(--color-muted-foreground)]">
            <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]">
              查看请求信息
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>请求编号</span>
              <code className="break-all">{requestId}</code>
              <CopyButton value={requestId} label="复制编号" />
            </div>
          </details>
        )}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        )}
      </div>
    </div>
  );
}
