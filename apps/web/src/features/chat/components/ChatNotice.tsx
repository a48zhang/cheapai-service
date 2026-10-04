import { Link } from 'react-router-dom';
import type { ChatState } from '../model/state';
import { Button } from '../../../shared/ui/Button';

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
    ? '结果尚未确认。'
    : insufficientBalance
      ? '余额不足，无法继续生成。'
      : state.failure.kind === 'rejected'
        ? '请求未能提交。'
        : '生成失败。';
  return (
    <div
      role="alert"
      className="mx-auto w-full max-w-[52rem] rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <p>{message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {uncertain && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            重试确认
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onReload}>
          刷新会话
        </Button>
        {insufficientBalance && (
          <Link className="px-2 py-1 text-indigo-700" to="/billing">
            查看费用
          </Link>
        )}
      </div>
    </div>
  );
}
