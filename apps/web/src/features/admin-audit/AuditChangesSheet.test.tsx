import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditEntry } from '@cheapai/contracts/audit';
import { AuditChangesSheet } from './AuditChangesSheet';
import { useState } from 'react';

const entry: AuditEntry = {
  id: 'audit-1',
  actor_id: 'actor-1',
  actor_email: 'admin@example.com',
  action: 'user.update',
  target_type: 'user',
  target_id: 'user-1',
  target_name: 'user@example.com',
  operation_id: 'operation-1',
  created_at: 1700000000000,
  changes: {
    before: { status: 'active' },
    after: { status: 'disabled' },
    credential_changed: true,
  },
  redaction_valid: true,
};
function Example() {
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  return (
    <>
      <button onClick={() => setSelected(entry)}>查看变更</button>
      <AuditChangesSheet entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}
describe('审计变更侧栏', () => {
  it('在侧栏显示名称和前后值，原始记录可以展开，关闭回到入口', async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看变更' }));
    const dialog = screen.getByRole('dialog', { name: '变更详情' });
    expect(within(dialog).getByText('修改用户')).toBeVisible();
    expect(within(dialog).getByText('user@example.com')).toBeVisible();
    expect(within(dialog).getByText('启用')).toBeVisible();
    expect(within(dialog).getByText('停用')).toBeVisible();
    expect(within(dialog).getByText('更新上游凭证')).toBeVisible();
    await user.click(within(dialog).getByText('原始记录'));
    expect(within(dialog).getByText('operation-1')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: '关闭侧栏' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看变更' })).toBeVisible();
  });
  it('只展示业务差异，限额显示不限，版本与未变更字段保留在原始记录', async () => {
    const user = userEvent.setup();
    render(
      <AuditChangesSheet
        entry={{
          ...entry,
          changes: {
            before: {
              status: 'active',
              group_id: 'group-1',
              concurrency_limit: 3,
              rpm_limit: Number.MAX_SAFE_INTEGER,
              version: 1,
            },
            after: {
              status: 'active',
              group_id: 'group-1',
              concurrency_limit: Number.MAX_SAFE_INTEGER,
              rpm_limit: Number.MAX_SAFE_INTEGER,
              version: 2,
            },
            name_changed: false,
          },
        }}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('并发限制')).toBeVisible();
    expect(within(dialog).getByText('不限')).toBeVisible();
    expect(within(dialog).queryByText('状态')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('默认访问组')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('每分钟请求限制')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('版本')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('更新名称')).not.toBeInTheDocument();
    await user.click(within(dialog).getByText('原始记录'));
    expect(within(dialog).getByText(/"group_id": "group-1"/u)).toBeVisible();
  });
});
