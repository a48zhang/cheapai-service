import { Link } from 'react-router-dom';
import { ArrowUpRight, CircleAlert } from 'lucide-react';
import type { ChatState } from '../model/state';
import { Button } from '../../../shared/ui/Button';

export function ChatNotice({
  state,
  onRetry,
  onReload,
  onRestart,
}: {
  state: ChatState;
  onRetry: () => void;
  onReload: () => void;
  onRestart: () => void;
}) {
  if (!state.failure) return null;
  const creationUnknown = state.failure.code === 'conversation_creation_unknown';
  const uncertain = state.phase === 'interrupted';
  const insufficientBalance = state.failure.code === 'insufficient_balance';
  const message = creationUnknown
    ? '会话创建结果待确认'
    : uncertain
      ? '请求结果待确认'
      : insufficientBalance
        ? '账户余额不足'
        : state.failure.kind === 'rejected'
          ? state.failure.message
          : '本次生成未完成';
  const description = creationUnknown
    ? '问题尚未发送。可查看聊天记录，或重新开始对话。'
    : uncertain
      ? '请先确认本次请求的结果，再继续对话。'
      : insufficientBalance
        ? '请查看账户余额后继续对话。'
        : state.failure.kind === 'rejected'
          ? ''
          : '请稍后再试，或重新加载当前对话。';
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
          {description && (
            <p className="m-0 mt-0.5 text-sm leading-6 text-[var(--color-muted-foreground)]">
              {description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {creationUnknown ? (
            <Button size="sm" onClick={onRestart}>
              重新开始
            </Button>
          ) : insufficientBalance ? (
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
