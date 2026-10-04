import { Button } from '../ui/Button';

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
      className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
    >
      <p>{message}</p>
      {requestId && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span>请求编号</span>
          <code>{requestId}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(requestId).catch(() => undefined)}
          >
            复制
          </button>
        </div>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}
