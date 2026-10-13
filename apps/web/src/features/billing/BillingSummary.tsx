import type { AccountBalance } from '@cheapai/api-client/account';
import type { BillingSummary as BillingPeriodSummary } from '@cheapai/contracts/billing';
import { formatConsumptionUsd, formatWalletUsd } from '../../shared/lib/money';
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
  readonly wallet?: boolean;
  readonly units?: string | undefined;
  readonly currency: string;
  readonly loading: boolean;
  readonly error?: unknown;
  readonly onRetry: () => void;
}

function Amount({ label, units, currency, loading, error, onRetry, wallet }: AmountProps) {
  let amount: string | null = null;
  if (units !== undefined) {
    try {
      amount = `${wallet ? formatWalletUsd(units) : formatConsumptionUsd(units)} ${currency}`;
    } catch {
      amount = null;
    }
  }

  return (
    <section className="console-panel min-w-0 p-5 sm:p-6">
      <h2 className="m-0 text-sm font-medium text-[var(--color-ink-secondary)]">{label}</h2>
      {amount !== null ? (
        <>
          <p className="mb-0 mt-2 console-number overflow-x-auto whitespace-nowrap text-3xl font-semibold text-[var(--color-ink)]">
            {amount}
          </p>
          {error && (
            <p
              className="mb-0 mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-danger)]"
              role="status"
            >
              更新失败，当前显示上次读取的金额
              <Button variant="outline" size="sm" onClick={onRetry}>
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
          className="mb-0 mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-danger)]"
          role="alert"
        >
          {error ? '读取失败' : '暂不可用'}
          <Button variant="outline" size="sm" onClick={onRetry}>
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
    <div className="grid gap-4 sm:grid-cols-2">
      <Amount
        label="当前余额"
        wallet
        units={balance?.balance_units}
        currency={balance?.currency ?? 'USD'}
        loading={balanceLoading}
        error={balanceError}
        onRetry={onRetryBalance}
      />
      <Amount
        label="期间消费（已结算）"
        units={summary?.consumptionUnits}
        currency={summary?.currency ?? 'USD'}
        loading={summaryLoading}
        error={summaryError}
        onRetry={onRetrySummary}
      />
    </div>
  );
}
