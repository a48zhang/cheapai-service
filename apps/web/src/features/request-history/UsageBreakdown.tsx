import { StatusBadge } from '../../shared/ui/StatusBadge';
import type { PublicUsage } from '@cheapai/contracts/requests';

export interface UsageBreakdownProps {
  readonly usage: PublicUsage | null;
  readonly usageValid: boolean | null;
  readonly className?: string;
}

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

function semanticLabel(value: string, included: string, excluded: string): string {
  if (value === included) return '已计入主计数';
  if (value === excluded) return '未计入主计数';
  return '口径未知';
}

/** Shows only counters supplied by the server; cache and reasoning subsets are never added again. */
export function UsageBreakdown({ usage, usageValid, className }: UsageBreakdownProps) {
  if (usageValid !== true || usage === null) {
    const invalid = usageValid === false;
    return (
      <div className={['flex items-center gap-2', className].filter(Boolean).join(' ')}>
        <StatusBadge tone={invalid ? 'danger' : 'neutral'}>{invalid ? '用量数据无效' : '用量未知'}</StatusBadge>
      </div>
    );
  }

  if (usage.quality === 'missing') {
    return (
      <div className={['flex items-center gap-2', className].filter(Boolean).join(' ')}>
        <StatusBadge tone="warning">上游未提供用量</StatusBadge>
      </div>
    );
  }

  if (usage.quality === 'invalid') {
    return (
      <div className={['flex items-center gap-2', className].filter(Boolean).join(' ')}>
        <StatusBadge tone="danger">用量记录无效</StatusBadge>
      </div>
    );
  }

  const counts = usage.counts;
  const cacheWriteTtlLabel = usage.semantics.cacheWriteTtl === 'subsets_of_cache_write' ? '缓存写入子集' : '缓存关系未知';
  const rows: Array<readonly [string, number | undefined, string?]> = [
    ['输入 Token', counts.inputTokens],
    ['输出 Token', counts.outputTokens],
    ...(counts.totalTokens === undefined ? [] : [['总计 Token', counts.totalTokens] as const]),
    ...(counts.cacheReadTokens === undefined ? [] : [['缓存读取', counts.cacheReadTokens, semanticLabel(usage.semantics.cacheRead, 'included_in_input', 'excluded_from_input')] as const]),
    ...(counts.cacheWriteTokens === undefined ? [] : [['缓存写入', counts.cacheWriteTokens, semanticLabel(usage.semantics.cacheWrite, 'included_in_input', 'excluded_from_input')] as const]),
    ...(counts.cacheWrite5mTokens === undefined ? [] : [['缓存写入（5 分钟）', counts.cacheWrite5mTokens, cacheWriteTtlLabel] as const]),
    ...(counts.cacheWrite1hTokens === undefined ? [] : [['缓存写入（1 小时）', counts.cacheWrite1hTokens, cacheWriteTtlLabel] as const]),
    ...(counts.reasoningTokens === undefined ? [] : [['推理 Token', counts.reasoningTokens, semanticLabel(usage.semantics.reasoning, 'included_in_output', 'excluded_from_output')] as const]),
  ];

  return (
    <section className={['space-y-3', className].filter(Boolean).join(' ')} aria-label="用量明细">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={usage.quality === 'complete' ? 'success' : 'warning'}>{usage.quality === 'complete' ? '完整用量' : '部分用量'}</StatusBadge>
        <span className="text-xs text-slate-500">{usage.protocol}</span>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([label, value, note]) => (
          <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-slate-100 py-1.5">
            <dt className="min-w-0 text-slate-600">{label}{note && <span className="ml-1 text-xs text-slate-400">· {note}</span>}</dt>
            <dd className="m-0 shrink-0 font-mono tabular-nums text-slate-900">{value === undefined ? '—' : number.format(value)}</dd>
          </div>
        ))}
      </dl>
      {usage.semantics.cacheWriteTtl === 'subsets_of_cache_write' && (counts.cacheWrite5mTokens !== undefined || counts.cacheWrite1hTokens !== undefined) && (
        <p className="m-0 text-xs leading-5 text-slate-500">5 分钟与 1 小时缓存写入计数属于缓存写入子集，请勿重复加总。</p>
      )}
    </section>
  );
}
