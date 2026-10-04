import { useEffect, useRef, useState } from 'react';
import type { UserListItem } from '@cheapai/api-client/users';
import type { AdminUsersApi } from './api';
import {
  canEditBalanceAdjustmentAfterFailure,
  createBalanceAdjustmentInput,
  createBalanceAdjustmentIntent,
  executeBalanceAdjustment,
  formatAdjustmentInput,
  formatBalanceAmount,
  idleBalanceAdjustment,
  reduceBalanceAdjustment,
} from './balance-operation';
import type {
  BalanceAdjustmentEvent,
  BalanceAdjustmentOperation,
  BalanceAdjustmentIntent,
} from './balance-operation';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export interface BalanceAdjustmentDialogProps {
  readonly open: boolean;
  readonly user: UserListItem;
  readonly api: AdminUsersApi;
  readonly actorId: string;
  readonly epoch: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdjusted: () => void;
}

/** Exact USD amount entry and a locked idempotent intent for uncertain write outcomes. */
export function BalanceAdjustmentDialog({
  open,
  user,
  api,
  actorId,
  epoch,
  onOpenChange,
  onAdjusted,
}: BalanceAdjustmentDialogProps) {
  const [kind, setKind] = useState<'grant' | 'adjustment'>('grant');
  const [amountUsd, setAmountUsd] = useState('');
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState('');
  const [operation, setOperation] = useState<BalanceAdjustmentOperation>(idleBalanceAdjustment);
  const operationRef = useRef<BalanceAdjustmentOperation>(idleBalanceAdjustment);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const identity = useRef({ userId: user.id, actorId, epoch });

  useEffect(() => {
    const changed =
      identity.current.userId !== user.id ||
      identity.current.actorId !== actorId ||
      identity.current.epoch !== epoch;
    identity.current = { userId: user.id, actorId, epoch };
    if (changed) {
      generation.current++;
      operationRef.current = idleBalanceAdjustment;
      setOperation(idleBalanceAdjustment);
      setKind('grant');
      setAmountUsd('');
      setReason('');
      setRequestId('');
      setBusy(false);
      busyRef.current = false;
      if (open) onOpenChange(false);
    }
    const counter = generation;
    return () => {
      counter.current++;
    };
    // A user or session identity change invalidates the local recovery intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, actorId, epoch]);

  useEffect(() => {
    if (!open) {
      const current = operationRef.current;
      if (current.status !== 'unknown' && current.status !== 'submitting') {
        operationRef.current = idleBalanceAdjustment;
        setOperation(idleBalanceAdjustment);
      }
      return;
    }
    if (operationRef.current.status === 'settled') {
      operationRef.current = idleBalanceAdjustment;
      setOperation(idleBalanceAdjustment);
    }
  }, [open]);

  const transition = (event: BalanceAdjustmentEvent) => {
    const next = reduceBalanceAdjustment(operationRef.current, event);
    operationRef.current = next;
    setOperation(next);
  };

  const close = (nextOpen: boolean) => {
    const current = operationRef.current;
    if (busyRef.current || current.status === 'unknown' || current.status === 'submitting') return;
    onOpenChange(nextOpen);
  };

  async function submit() {
    if (busyRef.current) return;
    let intent: BalanceAdjustmentIntent;
    const current = operationRef.current;
    if (current.status === 'unknown') {
      intent = createBalanceAdjustmentIntent(current.intent.input, current.intent);
    } else if (current.status === 'idle' || current.status === 'correctable') {
      try {
        const input = createBalanceAdjustmentInput({ kind, amountUsd, reason, requestId });
        intent = createBalanceAdjustmentIntent(input);
      } catch (error) {
        transition({ type: 'reset' });
        setLocalError(error instanceof Error ? error : new Error('请输入有效的调整金额。'));
        return;
      }
    } else return;

    setLocalError(null);
    transition({ type: 'submit', intent });
    busyRef.current = true;
    setBusy(true);
    const ticket = generation.current;
    try {
      const result = await executeBalanceAdjustment(api, user.id, intent);
      if (ticket !== generation.current) return;
      transition({ type: 'settled', result });
      onAdjusted();
    } catch (error) {
      if (ticket !== generation.current) return;
      if (canEditBalanceAdjustmentAfterFailure(error)) transition({ type: 'correctable', error });
      else transition({ type: 'unknown', error });
    } finally {
      if (ticket === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const [localError, setLocalError] = useState<Error | null>(null);
  const activeIntent =
    operation.status === 'submitting' || operation.status === 'unknown' ? operation.intent : null;
  const locked = operation.status === 'unknown' || operation.status === 'submitting';
  const settled = operation.status === 'settled' ? operation.result : null;
  const operationError =
    operation.status === 'unknown' || operation.status === 'correctable' ? operation.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="调整账户余额"
      description={`${user.email_normalized} · 当前余额 ${formatBalanceAmount(user.balance_units)}`}
      closeLabel="关闭余额调整"
      closeButton={!busy && !locked}
      footer={
        <>
          <Button variant="secondary" disabled={busy || locked} onClick={() => close(false)}>
            关闭
          </Button>
          {!settled && (
            <Button type="submit" form="admin-balance-adjustment" busy={busy}>
              {operation.status === 'unknown'
                ? '重试同一调整'
                : operation.status === 'correctable'
                  ? '使用新操作 ID 提交'
                  : '提交调整'}
            </Button>
          )}
        </>
      }
    >
      <form
        id="admin-balance-adjustment"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {settled ? (
          <div
            role="status"
            className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
          >
            <p className="font-medium">
              {settled.outcome === 'existing' ? '已确认此前相同操作的结果。' : '余额调整已写入。'}
            </p>
            <p>
              金额：{formatBalanceAmount(settled.entry.deltaUnits)} · 操作编号：
              <code className="break-all">{settled.entry.operationId}</code>
            </p>
            <p>当前余额会在重新读取用户资料后更新。</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="操作类型" required>
                <select
                  value={activeIntent?.input.kind ?? kind}
                  onChange={(event) => setKind(event.currentTarget.value as typeof kind)}
                  disabled={busy || locked || activeIntent !== null}
                  className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
                >
                  <option value="grant">授额（正数）</option>
                  <option value="adjustment">余额调整（可正可负）</option>
                </select>
              </Field>
              <Field label="金额（USD）" required description="最多 8 位小数。">
                <Input
                  value={
                    activeIntent ? formatAdjustmentInput(activeIntent.input.deltaUnits) : amountUsd
                  }
                  onChange={(event) => setAmountUsd(event.currentTarget.value)}
                  required
                  inputMode="decimal"
                  maxLength={18}
                  placeholder="例如 10.50"
                  disabled={busy || locked || activeIntent !== null}
                />
              </Field>
            </div>
            <Field label="调整原因" required description="会作为账本说明保存。">
              <textarea
                value={activeIntent?.input.reason ?? reason}
                onChange={(event) => setReason(event.currentTarget.value)}
                required
                rows={3}
                maxLength={4096}
                disabled={busy || locked || activeIntent !== null}
                className="block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
              />
            </Field>
            <Field label="关联请求 ID（可选）" description="仅支持该用户的请求。">
              <Input
                value={activeIntent?.input.requestId ?? requestId}
                onChange={(event) => setRequestId(event.currentTarget.value)}
                maxLength={128}
                autoComplete="off"
                disabled={busy || locked || activeIntent !== null}
              />
            </Field>
            {localError && <ApiErrorNotice error={localError} />}
            {operationError && <ApiErrorNotice error={operationError} />}
            {operation.status === 'unknown' && (
              <div
                role="status"
                className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
              >
                <p>
                  提交结果尚未确认。请保持当前窗口，重试会复用操作编号及完全相同的金额、原因和关联请求
                  ID。
                </p>
                <p className="mt-2">
                  操作编号：<code className="break-all">{operation.intent.operationId}</code>
                </p>
              </div>
            )}
            {operation.status === 'correctable' && (
              <p role="status" className="text-sm text-amber-900">
                服务器明确拒绝了此前请求。修改参数后提交会创建新的操作编号。
              </p>
            )}
            {operation.status === 'idle' && amountUsd && (
              <p className="text-xs text-[var(--color-muted-foreground)]">
                金额预览：{formatAdjustmentInputFromUsd(amountUsd)}
              </p>
            )}
          </>
        )}
      </form>
    </Dialog>
  );
}

function formatAdjustmentInputFromUsd(value: string): string {
  try {
    const parsed = createBalanceAdjustmentInput({
      kind: 'adjustment',
      amountUsd: value,
      reason: 'preview',
      requestId: '',
    });
    return `${formatAdjustmentInput(parsed.deltaUnits)} USD`;
  } catch {
    return '输入完整且金额有效后显示';
  }
}
