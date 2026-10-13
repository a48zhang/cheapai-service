import { useLayoutEffect, useRef, useState } from 'react';
import { createAdminRegistrationApi } from '@cheapai/api-client/registration-admin';
import type { CodeBatch } from '@cheapai/contracts/registration-admin';
import { useSession } from '../session/public';
import {
  createCodeIntent,
  executeCodeIntent,
  canChangeCodeIntent,
  type CodeIntent,
} from './code-operation';
import { Dialog } from '../../shared/ui/Dialog';
import { CopyButton } from '../../shared/ui/CopyButton';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { Field } from '../../shared/ui/Field';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export function CodeBatchDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onCreated: () => void;
}) {
  const { client, user, epoch } = useSession();
  const [quantity, setQuantity] = useState('1');
  const [expires, setExpires] = useState(() => {
    const deadline = new Date(Date.now() + 7 * 86_400_000);
    return new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  });
  const [intent, setIntent] = useState<CodeIntent | null>(null);
  const [result, setResult] = useState<CodeBatch | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++;
    setResult(null);
    setError(null);
    setBusy(false);
    busyRef.current = false;
    const counter = generation;
    return () => {
      counter.current++;
    };
  }, [open, user?.id, epoch]);
  useLayoutEffect(() => {
    setIntent(null);
  }, [user?.id, epoch]);
  const submit = async () => {
    if (busyRef.current || !user) return;
    let current = intent;
    if (!current) {
      const amount = Number(quantity);
      const deadline = new Date(expires).getTime();
      if (
        !Number.isInteger(amount) ||
        amount < 1 ||
        amount > 100 ||
        !Number.isSafeInteger(deadline) ||
        deadline <= Date.now()
      ) {
        setError(new Error('数量须为 1–100，有效期须晚于当前时间。'));
        return;
      }
      current = createCodeIntent({ quantity: amount, expiresAt: deadline });
      setIntent(current);
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const ticket = generation.current;
    try {
      const response = await executeCodeIntent(createAdminRegistrationApi(client), current);
      if (ticket !== generation.current) return;
      setResult(response);
      setIntent(null);
      onCreated();
    } catch (failure) {
      if (ticket !== generation.current) return;
      setError(failure);
      if (canChangeCodeIntent(failure)) setIntent(null);
    } finally {
      if (ticket === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busyRef.current) onOpenChange(nextOpen);
      }}
      title="生成邀请码"
      description="生成后可复制并分享给受邀用户。"
      closeLabel="关闭"
      closeButton={!busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {result ? '完成' : '取消'}
          </Button>
          {!result && (
            <Button busy={busy} onClick={() => void submit()}>
              {intent ? '重试同一批次' : '生成邀请码'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {result ? (
          <>
            <p
              role="status"
              className="rounded-lg bg-[var(--color-surface-subtle)] p-4 text-sm leading-6"
            >
              {result.replayed
                ? '已恢复原批次。明文无法再次返回。'
                : '请立即保存，关闭后无法再次查看完整邀请码。'}
            </p>
            <ul className="m-0 max-h-64 space-y-3 overflow-auto rounded-lg bg-[var(--color-surface-subtle)] p-4">
              {result.codes.map((code) => (
                <li key={code.id} className="flex items-start gap-3">
                  <span className="w-5 shrink-0 text-sm tabular-nums text-[var(--color-ink-secondary)]">
                    {code.ordinal + 1}
                  </span>
                  <code className="select-all break-all text-sm leading-6">
                    {'token' in code ? code.token : `${code.displayPrefix}…`}
                  </code>
                </li>
              ))}
            </ul>
            {!result.replayed && (
              <CopyButton
                value={result.codes.map((code) => code.token).join('\n')}
                label="复制全部邀请码"
              />
            )}
          </>
        ) : (
          <>
            <Field label="生成数量" description="每批最多 100 个">
              <Input
                type="number"
                min={1}
                max={100}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                disabled={busy || !!intent}
              />
            </Field>
            <Field label="到期时间" description="最长有效期为 30 天">
              <Input
                type="datetime-local"
                value={expires}
                onChange={(event) => setExpires(event.target.value)}
                disabled={busy || !!intent}
              />
            </Field>
            {intent && (
              <p className="text-sm text-[var(--color-warning)]">
                此前结果尚未确认，重试将恢复相同批次。
              </p>
            )}
          </>
        )}
        {error != null && <ApiErrorNotice error={error} />}
      </div>
    </Dialog>
  );
}
