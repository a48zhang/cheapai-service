import { Link } from 'react-router-dom';
import { ArrowUpRight, CircleAlert } from 'lucide-react';
import type { ChatState } from '../model/state';
import { Button } from '../../../shared/ui/Button';
import { CopyButton } from '../../../shared/ui/CopyButton';

export function ChatNotice({
  state,
  onRetry,
  onReload,
}: {
  state: ChatState;
  onRetry: () => void;
  onReload: () => void;
}) {
  if (!state.failure) return null;
  const uncertain = state.phase === 'interrupted';
  const insufficientBalance = state.failure.code === 'insufficient_balance';
  const message = uncertain
    ? '请求结果待确认'
    : insufficientBalance
      ? '账户余额不足'
      : state.failure.kind === 'rejected'
        ? '消息未能发送'
        : '本次生成未完成';
  const description = insufficientBalance ? '请查看账户余额后继续对话。' : state.failure.message;
  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-[52rem] items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4 sm:items-center"
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
        aria-hidden="true"
      >
        <CircleAlert size={19} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="m-0 text-[15px] font-medium leading-6 text-[var(--color-foreground)]">
            {message}
          </p>
          <p className="m-0 mt-0.5 break-words text-sm leading-6 text-[var(--color-muted-foreground)]">
            {description}
          </p>
          {(state.failure.code || state.failure.requestId) && (
            <details className="mt-2 text-sm text-[var(--color-muted-foreground)]">
              <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]">
                查看请求信息
              </summary>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {state.failure.code && <code className="break-all">{state.failure.code}</code>}
                {state.failure.requestId && (
                  <>
                    <span>请求编号</span>
                    <code className="break-all">{state.failure.requestId}</code>
                    <CopyButton value={state.failure.requestId} label="复制编号" />
                  </>
                )}
              </div>
            </details>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {insufficientBalance ? (
            <Button asChild size="sm">
              <Link to="/billing">
                查看余额
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <>
              {uncertain && (
                <Button size="sm" onClick={onRetry}>
                  确认结果
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onReload}>
                重新加载
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
