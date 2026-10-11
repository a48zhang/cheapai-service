import type {
  BillingStatus,
  ExecutionStatus,
  RequestRecord,
  RequestSource,
} from '@cheapai/contracts/requests';
import { executionLabels } from './RequestStatus';
import { formatConsumptionUsd } from '../../shared/lib/money';

export type RequestResultTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export interface RequestResultPresentation {
  readonly label: string;
  readonly tone: RequestResultTone;
}

const missingCostLabels: Record<BillingStatus, string> = {
  awaiting_usage: '等待用量',
  settled: '费用未知',
  not_chargeable: '不计费',
  settlement_pending: '待结算',
  usage_unknown: '费用未知',
};

export function requestResultPresentation(status: ExecutionStatus): RequestResultPresentation {
  return executionLabels[status];
}

export function requestSourceLabel(source: RequestSource): string {
  return source === 'web_chat' ? '网页聊天' : 'API';
}

/** Format only the real amount received from the service; a missing amount stays unknown. */
export function requestCostLabel(
  item: Pick<RequestRecord, 'cost_units' | 'billing_status'>,
): string {
  if (item.cost_units === null) return missingCostLabels[item.billing_status];
  try {
    return `${formatConsumptionUsd(item.cost_units)} USD`;
  } catch {
    return '费用未知';
  }
}
