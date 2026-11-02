import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateInput } from './DateInput';
import { Field } from './Field';

describe('DateInput', () => {
  it('keeps exact local timestamps in form data and permits incomplete keyboard edits', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <form>
        <Field label="开始时间">
          <DateInput name="from" defaultValue="2026-11-01T08:09:10.123" />
        </Field>
      </form>,
    );
    const input = screen.getByRole('textbox', { name: '开始时间' });
    expect(input).toHaveAttribute('type', 'text');
    expect(new FormData(container.querySelector('form')!).get('from')).toBe(
      '2026-11-01T08:09:10.123',
    );
    await user.clear(input);
    await user.type(input, '2026-02-30T');
    expect(input).toHaveValue('2026-02-30T');
  });

  it('selects calendar days without losing time precision and returns focus on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Field label="到期时间">
        <DateInput defaultValue="2026-11-01T08:09:10.123" />
      </Field>,
    );
    const trigger = screen.getByRole('button', { name: '打开日历' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: '选择日期' })).toBeVisible();
    const day = document.querySelector<HTMLButtonElement>('[data-day="2026-11-02"] button')!;
    await user.click(day);
    expect(screen.getByRole('textbox', { name: '到期时间' })).toHaveValue(
      '2026-11-02T08:09:10.123',
    );
    await user.click(screen.getByRole('combobox', { name: '小时' }));
    await user.click(screen.getByRole('option', { name: '12' }));
    expect(screen.getByRole('textbox', { name: '到期时间' })).toHaveValue(
      '2026-11-02T12:09:10.123',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('clears optional dates, and disabled controls cannot open the calendar', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Field label="日期">
        <DateInput mode="date" defaultValue="2026-11-01" />
      </Field>,
    );
    await user.click(screen.getByRole('button', { name: '打开日历' }));
    await user.click(screen.getByRole('button', { name: '清除' }));
    expect(screen.getByRole('textbox', { name: '日期' })).toHaveValue('');
    rerender(
      <Field label="日期">
        <DateInput disabled />
      </Field>,
    );
    expect(screen.getByRole('button', { name: '打开日历' })).toBeDisabled();
  });
});
