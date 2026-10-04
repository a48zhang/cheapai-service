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
  return (
    <div
      role="alert"
      className="mx-auto w-full max-w-[52rem] rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <p>{state.failure.message}</p>
      {uncertain && <p className="mt-1 text-xs">结果尚未确认，请重试核对。</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {uncertain && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            重试确认
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onReload}>
          刷新会话
        </Button>
        {state.failure.code === 'insufficient_balance' && (
          <Link className="px-2 py-1 text-indigo-700" to="/dashboard">
            查看余额
          </Link>
        )}
      </div>
    </div>
  );
}
