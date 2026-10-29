import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { ChatMessage, ConversationDetail } from '@cheapai/contracts/chat';
import { render, screen } from '../../../test/render';
import { MessageList } from './MessageList';

function message(
  id: string,
  role: ChatMessage['role'],
  patch: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    conversationId: 'conversation',
    turnIndex: 0,
    role,
    content: role === 'user' ? '用户问题' : '原来的回答',
    status: 'completed',
    variant: 1,
    selected: true,
    requestId: role === 'assistant' ? 'request' : null,
    groupId: 'group',
    modelId: 'model',
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

const submission = { operationId: 'send-operation', content: '用户问题', userMessageId: null };
const prompt = message('question', 'user');
const answer = message('answer', 'assistant', { content: '', status: 'generating' });

afterEach(() => vi.restoreAllMocks());

describe('visible response lifecycle', () => {
  it.each(['creating', 'submitting'] as const)(
    'shows an assistant response immediately while %s, before any server event',
    (phase) => {
      render(<MessageList messages={[]} submission={submission} phase={phase} busy />);
      expect(screen.getByRole('article', { name: '待确认的消息' })).toHaveTextContent('用户问题');
      const response = screen.getByRole('article', { name: 'CheapAI 的回答' });
      expect(response).toHaveTextContent('正在等待回复…');
      expect(response).not.toHaveAttribute('data-message-id');
      expect(response.querySelector('[role="status"]')).not.toHaveClass('sr-only');
    },
  );

  it('reuses the response slot when server metadata and the first text arrive', () => {
    const view = render(
      <MessageList messages={[]} submission={submission} phase="submitting" busy />,
    );
    const response = screen.getByRole('article', { name: 'CheapAI 的回答' });
    view.rerender(
      <MessageList
        messages={[prompt, answer]}
        submission={{ ...submission, userMessageId: prompt.id }}
        phase="streaming"
        streamMessageId={answer.id}
        streamText="第一段回答"
        busy
      />,
    );
    expect(screen.getByRole('article', { name: 'CheapAI 的回答' })).toBe(response);
    expect(response).toHaveTextContent('第一段回答');
    expect(screen.queryByText('正在等待回复…')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it.each([
    ['stopping', '正在停止…'],
    ['finalizing', '正在确认结果…'],
    ['interrupted', '结果待确认'],
  ] as const)('keeps partial text and describes %s accurately', (phase, label) => {
    render(
      <MessageList
        messages={[prompt, answer]}
        phase={phase}
        operationId={submission.operationId}
        operationKind="send"
        streamMessageId={answer.id}
        streamText="已经生成的内容"
      />,
    );
    expect(screen.getByText('已经生成的内容')).toBeVisible();
    expect(screen.getAllByRole('article', { name: 'CheapAI 的回答' })).toHaveLength(1);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText('生成中', { exact: true })).toBeNull();
    if (phase === 'interrupted')
      expect(screen.getByText(label).querySelector('.animate-spin')).toBeNull();
  });

  it('shows waiting feedback in the answer position when regenerating and restores a rejected answer', () => {
    const completed = message('answer', 'assistant');
    const messages = [prompt, completed];
    const view = render(
      <MessageList
        messages={messages}
        phase="submitting"
        operationId="regenerate-operation"
        operationKind="regenerate"
        busy
      />,
    );
    expect(screen.getAllByRole('article', { name: 'CheapAI 的回答' })).toHaveLength(1);
    expect(screen.getByText('正在等待回复…')).toBeVisible();
    view.rerender(<MessageList messages={messages} phase="failed" />);
    expect(screen.getByText('原来的回答')).toBeVisible();
    expect(screen.queryByText('正在等待回复…')).toBeNull();
  });

  it('does not manufacture a response while selecting an existing version', () => {
    render(
      <MessageList
        messages={[prompt, message('answer', 'assistant')]}
        phase="submitting"
        operationId="select-operation"
        operationKind="select"
        busy
      />,
    );
    expect(screen.getAllByRole('article', { name: 'CheapAI 的回答' })).toHaveLength(1);
    expect(screen.getByText('原来的回答')).toBeVisible();
    expect(screen.queryByText('正在等待回复…')).toBeNull();
  });

  it('copies visible streamed text and clears the success label when new text arrives', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const props = { messages: [answer], streamMessageId: answer.id, phase: 'streaming' as const };
    const view = render(<MessageList {...props} streamText="可见的部分回答" />);
    await user.click(screen.getByRole('button', { name: '复制消息' }));
    expect(copy).toHaveBeenCalledWith('可见的部分回答');
    expect(screen.getByRole('button', { name: '已复制消息' })).toBeEnabled();
    view.rerender(<MessageList {...props} streamText="可见的部分回答，继续输出。" />);
    expect(screen.getByRole('button', { name: '复制消息' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '已复制消息' })).toBeNull();
  });

  it('prefers confirmed final content to an earlier partial stream snapshot', () => {
    const final = message('answer', 'assistant', { content: '完整回答' });
    const detail: ConversationDetail = {
      conversation: {
        id: 'conversation',
        title: '对话',
        groupId: 'group',
        modelId: 'model',
        version: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [prompt, final],
    };
    render(
      <MessageList
        detail={detail}
        messages={detail.messages}
        streamMessageId={final.id}
        streamText="部分回答"
        phase="interrupted"
      />,
    );
    expect(screen.getByText('完整回答')).toBeVisible();
    expect(screen.queryByText('部分回答')).toBeNull();
  });
});
