import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '../../../test/render';
import { initialChatState } from '../model/state';
import { ChatNotice } from './ChatNotice';

describe('chat recovery notice', () => {
  it('offers reload instead of an ineffective retry for an interrupted selection', () => {
    const onReload = vi.fn();
    render(
      <ChatNotice
        state={{
          ...initialChatState,
          phase: 'interrupted',
          operationKind: 'select',
          failure: { kind: 'interrupted', message: 'network failure' },
        }}
        onReload={onReload}
        onRetry={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '确认结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('keeps raw rejection details out of the notice and omits unavailable reload', () => {
    render(
      <ChatNotice
        state={{
          ...initialChatState,
          phase: 'failed',
          failure: {
            kind: 'rejected',
            code: 'unknown_provider_error',
            message: 'upstream internal host / secret diagnostic',
          },
          unsent: [{ operationId: 'unsent', content: 'question', userMessageId: null }],
        }}
        onRetry={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.queryByText(/upstream internal/)).toBeNull();
    expect(screen.getByText(/消息尚未发送/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull();
  });
});
