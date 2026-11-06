import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '../../../test/render';
import userEvent from '@testing-library/user-event';
import { ApiClientError } from '@cheapai/api-client/errors';
import { asChatFailure } from '../model/operation-executor';
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

  it('keeps diagnostics collapsed and lets the user inspect and copy the full failure', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText');
    render(
      <ChatNotice
        state={{
          ...initialChatState,
          phase: 'failed',
          failure: asChatFailure(
            new ApiClientError('api', '模型暂不支持当前请求，请选择其他模型。', {
              code: 'model_unsupported',
              status: 422,
              request_id: 'chat-request-422',
              details: { model: 'test-model', reason: 'unsupported_parameter' },
            }),
            'rejected',
          ),
          unsent: [{ operationId: 'unsent', content: 'question', userMessageId: null }],
        }}
        onRetry={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByText(/具体原因：模型暂不支持/)).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: '查看错误详情' }));
    const details = screen.getByText(/具体原因：模型暂不支持/);
    expect(details).toBeVisible();
    expect(details).toHaveTextContent('HTTP 状态：422');
    expect(details).toHaveTextContent('错误码：model_unsupported');
    expect(details).toHaveTextContent('请求编号：chat-request-422');
    expect(details).toHaveTextContent('unsupported_parameter');
    await user.click(screen.getByRole('button', { name: '复制错误详情' }));
    expect(copy).toHaveBeenCalledWith(details.textContent);
    expect(screen.getByText(/消息尚未发送/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull();
  });
});
