import { apiErrorMessages } from '@cheapai/api-client/errors';
import { RouteButton } from '../../../shared/ui/RouteButton';
import { ArrowUpRight, CircleAlert } from 'lucide-react';
import type { ChatState } from '../model/state';
import { Button } from '../../../shared/ui/Button';
import { Disclosure } from '../../../shared/ui/Disclosure';
import { CopyButton } from '../../../shared/ui/CopyButton';

export function ChatNotice({
  state,
  onRetry,
  onReload,
  onRestart,
}: {
  state: ChatState;
  onRetry: () => void;
  onReload?: (() => void) | undefined;
  onRestart: () => void;
}) {
  if (!state.failure) return null;
  const { failure } = state;
  const requestId =
    failure.diagnostics?.requestId ??
    failure.requestId ??
    state.detail?.messages.find((message) => message.id === state.streamMessageId)?.requestId;
  const errorDetails = [
    `具体原因：${failure.message}`,
    (failure.diagnostics?.code ?? failure.code) &&
      `错误码：${failure.diagnostics?.code ?? failure.code}`,
    failure.diagnostics?.status != null && `HTTP 状态：${failure.diagnostics.status}`,
    requestId && `请求编号：${requestId}`,
    state.operationId && `操作编号：${state.operationId}`,
    state.detail?.conversation.id && `对话编号：${state.detail.conversation.id}`,
    failure.diagnostics?.details != null &&
      `错误详情：${JSON.stringify(failure.diagnostics.details, null, 2)}`,
  ]
    .filter(Boolean)
    .join('\n');
  const creationUnknown = state.failure.code === 'conversation_creation_unknown';
  const uncertain = state.phase === 'interrupted';
  const selectionUnknown = uncertain && state.operationKind === 'select';
  const rejectedMessage = Object.hasOwn(apiErrorMessages, state.failure.code ?? '')
    ? apiErrorMessages[state.failure.code as keyof typeof apiErrorMessages]
    : '操作暂时无法完成，请稍后重试。';
  const insufficientBalance = state.failure.code === 'insufficient_balance';
  const message = creationUnknown
    ? '会话创建结果待确认'
    : selectionUnknown
      ? '回答版本尚未确认'
      : uncertain
        ? '回答尚未确认'
        : insufficientBalance
          ? '账户余额不足'
          : state.failure.kind === 'rejected'
            ? rejectedMessage
            : '本次生成未完成';
  const description = creationUnknown
    ? '问题尚未发送。可查看聊天记录，或重新开始对话。'
    : selectionUnknown
      ? '请重新加载对话，查看当前回答版本后继续。'
      : uncertain
        ? '连接已中断。请点击“确认结果”获取这次回答，再继续对话。'
        : insufficientBalance
          ? '请查看账户余额后继续对话。'
          : state.failure.kind === 'rejected'
            ? state.unsent.length > 0
              ? '消息尚未发送，可在消息下方重试发送。'
              : ''
            : state.unsent.length > 0
              ? '消息尚未发送，可在消息下方重试发送。'
              : '可在回答下方选择“重新回答”，或重新加载对话。';
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
          <Disclosure
            title="查看错误详情"
            className="mt-2 text-sm text-[var(--color-muted-foreground)]"
            triggerClassName="w-fit gap-2"
          >
            <pre className="my-2 whitespace-pre-wrap break-words font-sans text-xs leading-5">
              {errorDetails}
            </pre>
            <CopyButton value={errorDetails} label="复制错误详情" />
          </Disclosure>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {creationUnknown ? (
            <Button size="sm" onClick={onRestart}>
              重新开始
            </Button>
          ) : insufficientBalance ? (
            <RouteButton size="sm" variant="primary" to="/billing">
              查看余额
              <ArrowUpRight size={16} aria-hidden="true" />
            </RouteButton>
          ) : (
            <>
              {uncertain && !selectionUnknown && (
                <Button size="sm" onClick={onRetry}>
                  确认结果
                </Button>
              )}
              {onReload && (
                <Button variant="outline" size="sm" onClick={onReload}>
                  重新加载
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
