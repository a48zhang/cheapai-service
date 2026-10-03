import { StatusBadge } from '../../shared/ui/StatusBadge';
import type { BillingStatus, ExecutionStatus } from '@cheapai/contracts/requests';

export interface RequestStatusProps {
  readonly executionStatus: ExecutionStatus;
  readonly billingStatus: BillingStatus;
  readonly className?: string;
}

const executionLabels: Record<ExecutionStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  admitted: { label: '已接收', tone: 'info' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  abandoned: { label: '已放弃', tone: 'warning' },
};

const billingLabels: Record<BillingStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  awaiting_usage: { label: '等待用量', tone: 'info' },
  settled: { label: '已结算', tone: 'success' },
  not_chargeable: { label: '不计费', tone: 'neutral' },
  settlement_pending: { label: '待结算', tone: 'warning' },
  usage_unknown: { label: '用量未知', tone: 'danger' },
};

/** Execution and billing are independent states and stay visible as separate labels. */
export function RequestStatus({ executionStatus, billingStatus, className }: RequestStatusProps) {
  const execution = executionLabels[executionStatus];
  const billing = billingLabels[billingStatus];
  return (
    <div className={['flex flex-wrap items-center gap-2', className].filter(Boolean).join(' ')}>
      <StatusBadge tone={execution.tone}>{execution.label}</StatusBadge>
      <StatusBadge tone={billing.tone}>{billing.label}</StatusBadge>
    </div>
  );
}
