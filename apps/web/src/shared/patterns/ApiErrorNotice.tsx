import { ApiClientError, apiErrorMessages } from '@cheapai/api-client/errors';
import { errorDetails } from '../lib/api-error';
import { Disclosure } from '../ui/Disclosure';
import { CircleAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';

export function ApiErrorNotice({
  error,
  message: contextMessage,
  onRetry,
}: {
  error: unknown;
  message?: string;
  onRetry?: (() => void) | undefined;
}) {
  if (!error) return null;
  const message =
    contextMessage ??
    (error instanceof ApiClientError &&
    error.cause === undefined &&
    Object.hasOwn(apiErrorMessages, error.code)
      ? apiErrorMessages[error.code as keyof typeof apiErrorMessages]
      : error instanceof Error
        ? error.message
        : '操作暂时无法完成，请重试。');
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
        <ErrorDetails error={error} />
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试
          </Button>
        )}
      </div>
    </div>
  );
}

export function ErrorDetails({
  error,
  context = {},
}: {
  error: unknown;
  context?: Readonly<Record<string, string | null | undefined>>;
}) {
  const details = [
    errorDetails(error),
    ...Object.entries(context)
      .filter(([, value]) => value != null)
      .map(([label, value]) => `${label}：${value}`),
  ]
    .filter(Boolean)
    .join('\n');
  if (!details) return null;
  return (
    <Disclosure
      className="text-sm text-[var(--color-muted-foreground)]"
      title={<>查看错误详情</>}
      triggerClassName="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]"
    >
      <pre className="my-3 whitespace-pre-wrap break-words text-xs">{details}</pre>
      <CopyButton value={details} label="复制错误详情" />
    </Disclosure>
  );
}
