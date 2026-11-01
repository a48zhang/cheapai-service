import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '../../../test/render';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer';

function composerProps(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  return {
    value: '输入中的中文',
    onChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
}

describe('chat composer input safety', () => {
  it('does not submit Enter while an IME composition is active', () => {
    const props = composerProps();
    render(<Composer {...props} />);
    const textbox = screen.getByRole('textbox', { name: '消息内容' });

    fireEvent.compositionStart(textbox);
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textbox);
    fireEvent.keyDown(textbox, { key: 'Enter', code: 'Enter', isComposing: false });
    expect(props.onSend).toHaveBeenCalledWith('输入中的中文');
  });

  it('disables Stop once cancellation has been accepted', async () => {
    const props = composerProps({ phase: 'stopping' });
    render(<Composer {...props} />);
    const stop = screen.getByRole('button', { name: '正在停止' });
    expect(stop).toBeDisabled();
    await userEvent.click(stop);
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it('keeps Stop available during generation and never sends a second message', async () => {
    const user = userEvent.setup();
    const props = composerProps({ phase: 'streaming' });
    render(<Composer {...props} />);
    const stop = screen.getByRole('button', { name: '停止生成' });

    expect(stop).toBeEnabled();
    await user.click(stop);

    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
  });

  it.each(['creating', 'submitting'] as const)(
    'can cancel while %s and explains the next draft',
    async (phase) => {
      const user = userEvent.setup();
      const props = composerProps({ phase });
      render(<Composer {...props} />);
      expect(screen.getByText(/可先写下一条消息/)).not.toHaveClass('sr-only');
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect(props.onSend).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '停止生成' }));
      expect(props.onStop).toHaveBeenCalledOnce();
    },
  );

  it('shows version selection as a waiting operation with no ineffective Stop action', () => {
    const props = composerProps({ phase: 'submitting', operationKind: 'select' });
    render(<Composer {...props} />);
    expect(screen.getByRole('button', { name: '正在切换版本' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull();
  });

  it('returns focus to the draft after clicking Send', async () => {
    const user = userEvent.setup();
    const props = composerProps();
    render(<Composer {...props} />);
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(props.onSend).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('stops the version selection spinner when its result is unknown', () => {
    render(<Composer {...composerProps({ phase: 'interrupted', operationKind: 'select' })} />);
    const control = screen.getByRole('button', { name: '版本切换待确认' });
    expect(control).toBeDisabled();
    expect(control.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByText(/请重新读取对话/)).toBeVisible();
  });
});
