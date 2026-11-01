import type { ChatOperationKind, ChatPhase } from './state';

export interface ChatPresentation {
  readonly response: { readonly label: string; readonly animated: boolean } | null;
  readonly submit: {
    readonly action: 'send' | 'stop' | 'wait';
    readonly label: string;
    readonly animated: boolean;
  };
  readonly inputHint: string;
}

/** Derive visible feedback from the operation; components do not keep a second lifecycle. */
export function getChatPresentation(
  phase: ChatPhase,
  operationKind: ChatOperationKind | null = null,
  hasContent = false,
): ChatPresentation {
  const ready: ChatPresentation = {
    response: null,
    submit: { action: 'send', label: '发送', animated: false },
    inputHint: 'Enter 发送 · Shift+Enter 换行',
  };
  if (phase === 'idle' || phase === 'failed') return ready;

  if (operationKind === 'select') {
    if (phase === 'interrupted') {
      return {
        response: null,
        submit: { action: 'wait', label: '版本切换待确认', animated: false },
        inputHint: '版本切换结果待确认，请重新读取对话；草稿可以继续编辑。',
      };
    }
    return {
      response: null,
      submit: { action: 'wait', label: '正在切换版本', animated: true },
      inputHint: '正在切换回答版本，草稿会保留。',
    };
  }

  switch (phase) {
    case 'creating':
    case 'submitting':
    case 'streaming':
      return {
        response: {
          label: phase === 'streaming' && hasContent ? '生成中' : '正在等待回复…',
          animated: true,
        },
        submit: { action: 'stop', label: '停止生成', animated: phase !== 'streaming' },
        inputHint: '可先写下一条消息，回答结束后发送 · Shift+Enter 换行',
      };
    case 'stopping':
      return {
        response: { label: '正在停止…', animated: true },
        submit: { action: 'wait', label: '正在停止', animated: true },
        inputHint: '正在停止，已生成的内容和草稿会保留。',
      };
    case 'finalizing':
      return {
        response: { label: '正在确认结果…', animated: true },
        submit: { action: 'wait', label: '正在确认结果', animated: true },
        inputHint: '正在确认本次结果，草稿会保留。',
      };
    case 'interrupted':
      return {
        response: { label: '结果待确认', animated: false },
        submit: { action: 'wait', label: '结果待确认', animated: false },
        inputHint: '请先确认本次结果，再继续发送；可以继续编辑草稿。',
      };
  }
}
