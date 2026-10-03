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
    maxOutputTokens: '32',
    maxOutputTokensCeiling: 64,
    onMaxOutputTokensChange: vi.fn(),
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
    expect(props.onSend).toHaveBeenCalledWith('输入中的中文', 32);
  });

  it('keeps Stop available during generation and never sends a second message', async () => {
    const user = userEvent.setup();
    const props = composerProps({ busy: true });
    render(<Composer {...props} />);
    const stop = screen.getByRole('button', { name: '停止生成' });

    expect(stop).toBeEnabled();
    await user.click(stop);

    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '发送消息' })).not.toBeInTheDocument();
  });
});
