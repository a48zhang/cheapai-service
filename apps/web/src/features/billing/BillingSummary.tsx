import type { AccountBalance } from '@cheapai/api-client/account';
import type { BillingSummary as BillingPeriodSummary } from '@cheapai/contracts/billing';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { Button } from '../../shared/ui/Button';

export interface BillingSummaryProps {
  readonly balance?: AccountBalance | undefined;
  readonly balanceLoading: boolean;
  readonly balanceError?: unknown;
  readonly onRetryBalance: () => void;
  readonly summary?: BillingPeriodSummary | undefined;
  readonly summaryLoading: boolean;
  readonly summaryError?: unknown;
  readonly onRetrySummary: () => void;
}

interface AmountProps {
  readonly label: string;
  readonly units?: string | undefined;
  readonly currency: string;
  readonly loading: boolean;
  readonly error?: unknown;
  readonly onRetry: () => void;
}

function Amount({ label, units, currency, loading, error, onRetry }: AmountProps) {
  let amount: string | null = null;
  if (units !== undefined) {
    try {
      amount = `${formatUnitsToUsd(units, 2)} ${currency}`;
    } catch {
      amount = null;
    }
  }

  return (
    <section className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      <h2 className="m-0 text-sm font-medium text-[var(--color-ink-secondary)]">{label}</h2>
      {amount !== null ? (
        <>
          <p className="mb-0 mt-2 whitespace-nowrap font-mono text-2xl font-semibold tabular-nums text-[var(--color-ink)] sm:text-3xl">
            {amount}
          </p>
          {error && (
            <p
              className="mb-0 mt-2 flex items-center gap-2 text-xs text-[var(--color-danger)]"
              role="status"
            >
              更新失败
              <Button variant="ghost" size="sm" className="px-2" onClick={onRetry}>
                重试
              </Button>
            </p>
          )}
        </>
      ) : loading ? (
        <p role="status" className="mb-0 mt-2 text-sm text-[var(--color-ink-muted)]">
          正在读取…
        </p>
      ) : (
        <p
          className="mb-0 mt-2 flex items-center gap-2 text-sm text-[var(--color-danger)]"
          role="alert"
        >
          {error ? '读取失败' : '暂不可用'}
          <Button variant="ghost" size="sm" className="px-2" onClick={onRetry}>
            重试
          </Button>
        </p>
      )}
    </section>
  );
}

/** Compact live balance and exact full-period settled consumption totals. */
export function BillingSummary({
  balance,
  balanceLoading,
  balanceError,
  onRetryBalance,
  summary,
  summaryLoading,
  summaryError,
  onRetrySummary,
}: BillingSummaryProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Amount
        label="当前余额"
        units={balance?.balance_units}
        currency={balance?.currency ?? 'USD'}
        loading={balanceLoading}
        error={balanceError}
        onRetry={onRetryBalance}
      />
      <Amount
        label="所选期间已结算消费"
        units={summary?.consumptionUnits}
        currency={summary?.currency ?? 'USD'}
        loading={summaryLoading}
        error={summaryError}
        onRetry={onRetrySummary}
      />
    </div>
  );
}
