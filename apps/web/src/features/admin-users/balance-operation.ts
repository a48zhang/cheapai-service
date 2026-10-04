import { ApiClientError } from '@cheapai/api-client/errors';
import type { BalanceAdjustmentInput, BalanceAdjustmentResult } from '@cheapai/api-client/users';
import type { AdminUsersApi } from './api';
import { formatUnitsToUsd, parseUsdToUnits } from '../../shared/lib/money';

export interface BalanceAdjustmentIntent {
  readonly operationId: string;
  readonly input: BalanceAdjustmentInput;
}

export type BalanceAdjustmentOperation =
  | { readonly status: 'idle' }
  | { readonly status: 'submitting'; readonly intent: BalanceAdjustmentIntent }
  | {
      readonly status: 'unknown';
      readonly intent: BalanceAdjustmentIntent;
      readonly error: unknown;
    }
  | {
      readonly status: 'correctable';
      readonly intent: BalanceAdjustmentIntent;
      readonly error: unknown;
    }
  | { readonly status: 'settled'; readonly result: BalanceAdjustmentResult };

export type BalanceAdjustmentEvent =
  | { readonly type: 'submit'; readonly intent: BalanceAdjustmentIntent }
  | { readonly type: 'unknown'; readonly error: unknown }
  | { readonly type: 'correctable'; readonly error: unknown }
  | { readonly type: 'settled'; readonly result: BalanceAdjustmentResult }
  | { readonly type: 'reset' };

export const idleBalanceAdjustment: BalanceAdjustmentOperation = { status: 'idle' };

export function reduceBalanceAdjustment(
  state: BalanceAdjustmentOperation,
  event: BalanceAdjustmentEvent,
): BalanceAdjustmentOperation {
  if (event.type === 'reset') return idleBalanceAdjustment;
  if (event.type === 'submit') return { status: 'submitting', intent: event.intent };
  if (event.type === 'settled') return { status: 'settled', result: event.result };
  if (state.status !== 'submitting' && state.status !== 'unknown' && state.status !== 'correctable')
    return state;
  return { status: event.type, intent: state.intent, error: event.error };
}

/** Parse USD text into canonical integer units using the same safe range as D1 billing writes. */
export function createBalanceAdjustmentInput(input: {
  readonly kind: 'grant' | 'adjustment';
  readonly amountUsd: string;
  readonly reason: string;
  readonly requestId: string;
}): BalanceAdjustmentInput {
  const amountUsd = input.amountUsd.trim();
  const units = parseUsdToUnits(amountUsd);
  if (input.kind === 'grant' && units <= 0n) throw new Error('授额金额必须大于零。');
  const reason = input.reason.trim();
  if (!reason || reason.length > 4096) throw new Error('请填写 1–4096 个字符的调整原因。');
  const requestId = input.requestId.trim();
  if (
    requestId &&
    (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(requestId) ||
      /(?:s2a_(?:key|session|invite)_|sk-|bearer|-----BEGIN)/iu.test(requestId))
  ) {
    throw new Error('关联请求 ID 格式无效。');
  }
  return {
    kind: input.kind,
    deltaUnits: units.toString(),
    reason,
    ...(requestId ? { requestId } : {}),
  };
}

/** An uncertain attempt always keeps its operation ID and an immutable copy of every input field. */
export function createBalanceAdjustmentIntent(
  input: BalanceAdjustmentInput,
  previous?: BalanceAdjustmentIntent | null,
): BalanceAdjustmentIntent {
  return previous ?? { operationId: crypto.randomUUID(), input: Object.freeze({ ...input }) };
}

/** Client validation and authorization errors are explicit rejections; transport/5xx outcomes may have committed. */
export function canEditBalanceAdjustmentAfterFailure(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500
  );
}

export function executeBalanceAdjustment(
  api: AdminUsersApi,
  userId: string,
  intent: BalanceAdjustmentIntent,
) {
  return api.adjust(userId, intent.input, intent.operationId);
}

export function formatBalanceAmount(units: string): string {
  try {
    return `${formatUnitsToUsd(units)} USD`;
  } catch {
    return '余额暂不可显示';
  }
}

export function formatAdjustmentInput(units: string): string {
  try {
    return formatUnitsToUsd(units);
  } catch {
    return '金额无效';
  }
}
