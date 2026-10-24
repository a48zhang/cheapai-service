import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTIN_MODELS } from '../../packages/model-catalog/index';

test('channel mapping defaults use catalog protocol and name @resources', async ({ page }) => {
  const connection = JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`), 'utf8'));
  await page.goto('/login');
  await page.getByLabel('邮箱', { exact: true }).fill(connection.adminEmail);
  await page.getByLabel('密码', { exact: true }).fill(connection.adminPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(connection.baseURL + '/');
  const api = page.context().request;
  const astra = BUILTIN_MODELS.find(model => model.id === 'gpt-6-astra')!;
  const csrf = (await (await api.get('/api/v1/settings/public')).json()).data.csrfToken;
  const name = `Catalog ${randomUUID().slice(0, 8)}`;
  const channel = await api.post('/api/v1/admin/channels', { headers: { Origin: connection.baseURL, 'X-CSRF-Token': csrf }, data: {
    name, baseUrl: 'https://e2e-upstream.example.invalid/v1', upstreamKey: 'local-catalog-only', concurrencyLimit: 0, rpmLimit: 0,
  } });
  expect(channel.status()).toBe(201);
  for (const [id, protocol] of [['claude-opus-5', 'Messages'], [astra!.id, 'Responses']]) {
    await page.goto(`/admin/models/${encodeURIComponent(id)}`);
    const picker = page.getByRole('button', { name: /^关联渠道：/ });
    await expect(picker).toBeEnabled();
    await picker.click();
    const pickerDialog = page.getByRole('dialog', { name: '选择渠道' });
    await expect(pickerDialog).toBeVisible();
    await pickerDialog.getByRole('checkbox', { name: new RegExp(name) }).check();
    await pickerDialog.getByRole('button', { name: '应用选择', exact: true }).click();
    const mappingForm = page.locator('form').filter({ has: page.getByLabel('上游模型名称', { exact: true }) });
    await expect(mappingForm.getByRole('combobox', { name: '协议', exact: true })).toContainText(protocol);
    await expect(mappingForm.getByLabel('上游模型名称', { exact: true })).toHaveValue(id);
  }
});
