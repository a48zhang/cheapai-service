import type { HTMLAttributes } from 'react';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import type {
  BillingStatus,
  PriceSnapshot as PriceSnapshotData,
} from '@cheapai/contracts/requests';

export interface PriceSnapshotProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  readonly snapshot: PriceSnapshotData | null;
  readonly snapshotValid: boolean;
  readonly costUnits: string | null;
  readonly billingStatus: BillingStatus;
}

const priceLabels = {
  input: '输入',
  output: '输出',
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  cacheWrite5m: '缓存写入（5 分钟）',
  cacheWrite1h: '缓存写入（1 小时）',
  reasoning: '推理',
} as const;

function pendingCostLabel(status: BillingStatus): {
  label: string;
  tone: 'neutral' | 'info' | 'warning' | 'danger';
} {
  switch (status) {
    case 'awaiting_usage':
      return { label: '等待用量', tone: 'info' };
    case 'settlement_pending':
      return { label: '待结算', tone: 'warning' };
    case 'usage_unknown':
      return { label: '费用未知', tone: 'danger' };
    case 'not_chargeable':
      return { label: '不计费', tone: 'neutral' };
    case 'settled':
      return { label: '费用未知', tone: 'danger' };
  }
}

function formattedCost(value: string): string | null {
  try {
    return `${formatUnitsToUsd(value)} USD`;
  } catch {
    return null;
  }
}

/** Exact cost and immutable price facts; decimal rates are displayed as strings with no float conversion. */
export function PriceSnapshot({
  snapshot,
  snapshotValid,
  costUnits,
  billingStatus,
  className,
  ...sectionProps
}: PriceSnapshotProps) {
  const cost = costUnits === null ? null : formattedCost(costUnits);
  const pending = cost === null ? pendingCostLabel(billingStatus) : null;
  const prices =
    snapshot === null
      ? []
      : (
          Object.entries(snapshot.sell_prices) as Array<
            [keyof typeof priceLabels, string | undefined]
          >
        ).filter((entry): entry is [keyof typeof priceLabels, string] => entry[1] !== undefined);

  return (
    <section {...sectionProps} className={['space-y-4', className].filter(Boolean).join(' ')}>
      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-subtle)] p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-muted)]">
          请求费用
        </p>
        {cost !== null ? (
          <p className="m-0 font-mono text-lg font-semibold tabular-nums text-[var(--color-ink)]">
            {cost}
          </p>
        ) : (
          <StatusBadge tone={pending?.tone ?? 'danger'}>{pending?.label ?? '费用未知'}</StatusBadge>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="m-0 text-sm font-semibold text-[var(--color-ink)]">价格快照</h3>
          {!snapshotValid && <StatusBadge tone="danger">快照无效或不可用</StatusBadge>}
          {snapshotValid && !snapshot && <StatusBadge tone="neutral">没有快照</StatusBadge>}
        </div>
        {!snapshotValid || !snapshot ? (
          <p className="m-0 text-sm leading-6 text-[var(--color-ink-secondary)]">
            当前记录没有可展示的价格依据。
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-[var(--color-ink-muted)]">公开模型</dt>
                <dd className="m-0 break-all font-mono text-[var(--color-ink)]">
                  {snapshot.public_model_id}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-ink-muted)]">上游模型 / 协议</dt>
                <dd className="m-0 break-all font-mono text-[var(--color-ink)]">
                  {snapshot.upstream_model} · {snapshot.upstream_protocol}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-ink-muted)]">价格版本</dt>
                <dd className="m-0 tabular-nums text-[var(--color-ink)]">
                  v{snapshot.price_version}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-ink-muted)]">访问组</dt>
                <dd className="m-0 break-all text-[var(--color-ink)]">
                  {snapshot.group_id ?? '历史快照未记录'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-ink-muted)]">组版本</dt>
                <dd className="m-0 tabular-nums text-[var(--color-ink)]">
                  {snapshot.group_version ?? '历史快照未记录'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-ink-muted)]">计费倍率</dt>
                <dd className="m-0 font-mono tabular-nums text-[var(--color-ink)]">
                  {snapshot.billing_multiplier ?? '历史快照未记录'}
                </dd>
              </div>
            </dl>
            <div className="overflow-hidden rounded-lg border border-[var(--color-line)]">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 bg-[var(--color-surface-subtle)] px-3 py-2 text-xs font-medium text-[var(--color-ink-muted)]">
                <span>计费项</span>
                <span className="text-right">USD / 百万 Token</span>
              </div>
              <dl className="m-0 divide-y divide-[var(--color-line)]">
                {prices.map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-3 py-2 text-sm"
                  >
                    <dt className="text-[var(--color-ink-secondary)]">{priceLabels[key]}</dt>
                    <dd className="m-0 font-mono tabular-nums text-[var(--color-ink)]">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
