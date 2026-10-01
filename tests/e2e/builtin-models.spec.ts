import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTIN_MODELS } from '../../packages/model-catalog/index';

test('built-in models are installed and channel selection fills native defaults', async ({ page }) => {
  const connection = JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`), 'utf8'));
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(connection.adminEmail);
  await page.getByLabel('密码', { exact: true }).fill(connection.adminPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(connection.baseURL + '/');
  const api = page.context().request;
  const response = await api.get('/api/v1/admin/models?limit=100');
  expect(response.status()).toBe(200);
  const installed = (await response.json()).data.items;
  for (const model of BUILTIN_MODELS) expect(installed).toContainEqual(expect.objectContaining({ publicModelId: model.id, sellPrices: model.prices }));
  await page.goto('/admin/models');
  const row = page.locator('tbody tr').filter({ hasText: 'gpt-6-astra' });
  await row.getByRole('button', { name: '编辑价格', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.locator('summary').click();
  await expect(dialog).toContainText('1,050,000');
  await expect(dialog).toContainText('长上下文');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  const csrf = (await (await api.get('/api/v1/settings/public')).json()).data.csrfToken;
  const name = `Catalog ${randomUUID().slice(0, 8)}`;
  const channel = await api.post('/api/v1/admin/channels', { headers: { Origin: connection.baseURL, 'X-CSRF-Token': csrf }, data: {
    name, baseUrl: 'https://e2e-upstream.example.invalid/v1', upstreamKey: 'local-catalog-only', concurrencyLimit: 0, rpmLimit: 0,
  } });
  expect(channel.status()).toBe(201);
  await page.goto('/admin/channels');
  await page.locator('tbody tr').filter({ hasText: name }).getByRole('button', { name: '配置模型', exact: true }).click();
  dialog = page.getByRole('dialog');
  const select = dialog.getByRole('combobox', { name: '公开模型', exact: true });
  await expect(select).toBeEnabled();
  for (const model of BUILTIN_MODELS) await expect(select.locator(`option[value="${model.id}"]`)).toHaveCount(1);
  for (const [id, protocol] of [['claude-opus-5', 'messages'], ['gpt-6-astra', 'responses']]) {
    await select.selectOption(id!);
    await expect(dialog.getByRole('combobox', { name: '上游接口', exact: true })).toHaveValue(protocol!);
    await expect(dialog.getByLabel('上游模型名称', { exact: true })).toHaveValue(id!);
    await expect(dialog.getByRole('checkbox', { name: '工具调用', exact: true })).toBeChecked();
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
});
