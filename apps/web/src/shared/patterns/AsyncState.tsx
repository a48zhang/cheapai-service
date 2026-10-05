import type { HTMLAttributes, ReactNode } from 'react';

type AsyncStateStatus = 'loading' | 'empty' | 'error' | 'ready';

interface AsyncStateBaseProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly status: AsyncStateStatus;
  readonly heading?: ReactNode | undefined;
  readonly description?: ReactNode | undefined;
  readonly action?: ReactNode | undefined;
  readonly loadingLabel?: ReactNode | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly retryLabel?: ReactNode | undefined;
  readonly refreshing?: boolean | undefined;
  readonly refreshLabel?: ReactNode | undefined;
  readonly refreshError?: ReactNode | undefined;
}

export type AsyncStateProps = AsyncStateBaseProps &
  (
    | { readonly status: 'loading'; readonly children?: never }
    | { readonly status: 'empty'; readonly children?: never }
    | { readonly status: 'error'; readonly children?: never }
    | { readonly status: 'ready'; readonly children: ReactNode }
  );

/** Shared states for async panels; callers provide all product-specific copy. */
export function AsyncState(props: AsyncStateProps) {
  const {
    status,
    className,
    heading,
    description,
    action,
    loadingLabel,
    onRetry,
    retryLabel,
    refreshing,
    refreshLabel,
    refreshError,
    children,
    ...attributes
  } = props;
  const wrapperClassName = ['space-y-3', className].filter(Boolean).join(' ');

  if (status === 'loading') {
    return (
      <div {...attributes} className={wrapperClassName} role="status" aria-live="polite">
        <span className="inline-flex items-center gap-2 text-sm text-[var(--color-ink-secondary)]">
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          {loadingLabel && <span>{loadingLabel}</span>}
        </span>
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <div
        {...attributes}
        className={[
          'rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-6 py-10 text-center',
          wrapperClassName,
        ].join(' ')}
        role="status"
      >
        {heading && (
          <h2 className="mb-2 text-base font-semibold text-[var(--color-ink)]">{heading}</h2>
        )}
        {description && (
          <div className="mx-auto max-w-xl text-sm leading-6 text-[var(--color-ink-secondary)]">
            {description}
          </div>
        )}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        {...attributes}
        className={[
          'rounded-xl border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] px-5 py-4 text-[var(--color-danger)]',
          wrapperClassName,
        ].join(' ')}
        role="alert"
      >
        {heading && <h2 className="mb-1 text-sm font-semibold">{heading}</h2>}
        {description && <div className="text-sm leading-6">{description}</div>}
        {onRetry && retryLabel && (
          <button
            type="button"
            className="mt-3 inline-flex min-h-9 items-center rounded-md border border-[var(--color-danger-line)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
            onClick={onRetry}
          >
            {retryLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      {...attributes}
      className={wrapperClassName}
      data-refreshing={refreshing ? 'true' : undefined}
    >
      {(refreshing || refreshError) && (
        <div
          className="flex items-center justify-end gap-2 text-xs text-[var(--color-ink-muted)]"
          role={refreshError ? 'alert' : 'status'}
          aria-live={refreshError ? 'assertive' : 'polite'}
        >
          {refreshing && (
            <span
              aria-hidden="true"
              className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
          )}
          {refreshing && refreshLabel && <span>{refreshLabel}</span>}
          {refreshError && <span>{refreshError}</span>}
          {refreshError && onRetry && retryLabel && (
            <button
              type="button"
              className="rounded px-2 py-1 font-medium text-[var(--color-accent)] underline underline-offset-2 hover:text-[var(--color-accent)]"
              onClick={onRetry}
            >
              {retryLabel}
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
