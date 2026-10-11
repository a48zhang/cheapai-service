import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KeyMetadata } from '@cheapai/api-client/keys';
import { IntegrationGuide } from './IntegrationGuide';

const groups = [{ id: 'group-1', name: '默认分组', models: ['gpt-5', 'other-model'] }];
const selectedKey: KeyMetadata = {
  id: 'key-1',
  userId: 'user-1',
  groupId: 'group-1',
  groupName: '默认分组',
  name: '开发',
  displayPrefix: 's2a_key_ABCDEFGH',
  status: 'active',
  allowedModels: ['gpt-5'],
  expiresAt: null,
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('快速接入', () => {
  it('默认提供 Codex 配置，复制实际地址和授权模型，不把密钥摘要写进配置', async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(
      <IntegrationGuide
        baseUrl="https://cheapai.dev/v1"
        groups={groups}
        selectedKey={selectedKey}
      />,
    );
    expect(screen.getByRole('tab', { name: '接入 Codex' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('combobox', { name: 'API 示例模型' }).querySelectorAll('option'),
    ).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '复制配置' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    const config = clipboard.mock.calls[0]?.[0];
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('base_url = "https://cheapai.dev/v1"');
    expect(config).toContain('env_key = "CHEAPAI_API_KEY"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).not.toContain(selectedKey.displayPrefix);
    await user.click(screen.getByRole('tab', { name: 'API 调用' }));
    expect(screen.getByRole('button', { name: '复制示例' })).toBeVisible();
  });

  it('分组加载失败时展示重试，不提供不可用的配置复制', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <IntegrationGuide
        baseUrl="https://cheapai.dev/v1"
        groups={[]}
        selectedKey={null}
        groupsError="无法读取可用分组。"
        onRetryGroups={retry}
      />,
    );
    expect(screen.queryByRole('button', { name: '复制配置' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
