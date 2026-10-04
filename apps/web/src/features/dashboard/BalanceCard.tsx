import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { Button } from '../../shared/ui/Button';
import type { AccountBalance } from '@cheapai/api-client/account';

export interface BalanceCardProps {
  readonly balance?: AccountBalance | undefined;
  readonly loading?: boolean | undefined;
  readonly refreshing?: boolean | undefined;
  readonly error?: unknown;
  readonly onRetry?: (() => void) | undefined;
}

function displayedBalance(balance: AccountBalance): string | null {
  try { return formatUnitsToUsd(balance.balance_units, 2); } catch { return null; }
}

/** The balance view reads the server's exact unit string and never estimates spending power. */
export function BalanceCard({ balance, loading, refreshing, error, onRetry }: BalanceCardProps) {
  const amount = balance ? displayedBalance(balance) : null;
  return <section className="flex min-h-64 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-7" aria-labelledby="balance-heading">
    <div className="mb-6 flex items-center justify-between gap-3">
      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">账户</p>
        <h2 id="balance-heading" className="m-0 text-base font-semibold">当前余额</h2>
      </div>
      <Button variant="ghost" size="icon" aria-label="刷新余额" busy={Boolean(refreshing)} disabled={Boolean(loading)} onClick={onRetry}>↻</Button>
    </div>
    {balance && amount !== null ? <AsyncState status="ready" refreshing={refreshing} refreshLabel="正在更新余额…" refreshError={error ? '余额刷新失败，显示上次读取结果。' : undefined} onRetry={onRetry} retryLabel="重试">
      <p className="m-0 whitespace-nowrap font-mono text-4xl font-medium tracking-tight tabular-nums text-slate-950 sm:text-5xl">{amount}
        <span className="ml-2 text-xs font-normal tracking-normal text-slate-500">{balance.currency}</span>
      </p>
      {balance.balance_units.startsWith('-') && <p className="mb-0 mt-3 text-sm text-rose-700">余额不足，请联系管理员处理。</p>}
    </AsyncState> : loading ? <AsyncState status="loading" loadingLabel="正在读取当前余额…" /> : error ? <ApiErrorNotice error={error} onRetry={onRetry} /> : <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">余额暂时不可用。</div>}
    {balance && amount !== null && <a className="mt-auto self-start pt-6 text-sm font-medium text-indigo-700 hover:underline" href="/billing">查看账单 <span aria-hidden="true">→</span></a>}
  </section>;
}
