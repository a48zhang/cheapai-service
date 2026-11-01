import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field } from './Field';
import { Select } from './Select';

describe('Select form integration', () => {
  it('submits the selected value and an empty all-filter without exposing its internal placeholder', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <form>
        <Field label="状态">
          <Select
            name="status"
            defaultValue=""
            items={[
              { value: '', label: '全部' },
              { value: 'active', label: '启用' },
              { value: 'disabled', label: '停用', disabled: true },
            ]}
          />
        </Field>
      </form>,
    );
    const form = container.querySelector('form')!;
    expect(new FormData(form).getAll('status')).toEqual(['']);
    fireEvent.keyDown(screen.getByRole('combobox', { name: '状态' }), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: '停用' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('option', { name: '启用' }));
    expect(new FormData(form).getAll('status')).toEqual(['active']);
    fireEvent.keyDown(screen.getByRole('combobox', { name: '状态' }), { key: 'ArrowDown' });
    await user.click(screen.getByRole('option', { name: '全部' }));
    expect(new FormData(form).getAll('status')).toEqual(['']);
  });

  it('supports labelled, required named controls and returns focus after Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <form>
        <Field label="模型" required>
          <Select
            name="model"
            defaultValue="model-a"
            items={[
              { value: 'model-a', label: '模型 A' },
              { value: 'model-b', label: '模型 B' },
            ]}
          />
        </Field>
      </form>,
    );
    const trigger = screen.getByRole('combobox', { name: '模型' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await user.click(screen.getByRole('option', { name: '模型 B' }));
    expect(new FormData(container.querySelector('form')!).get('model')).toBe('model-b');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
