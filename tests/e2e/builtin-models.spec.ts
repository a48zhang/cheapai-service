import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTIN_MODELS } from '../../packages/model-catalog/index';

test('built-in models are installed and channel mapping defaults use catalog capabilities @resources', async ({ page }) => {
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
  const astra = BUILTIN_MODELS.find(model => model.id === 'gpt-6-astra');
  expect(astra).toBeDefined();
  const row = page.locator('tbody tr').filter({ hasText: astra!.id });
  await row.getByRole('link', { name: astra!.id, exact: true }).click();
  await expect(page).toHaveURL(`${connection.baseURL}/admin/models/${encodeURIComponent(astra!.id)}`);
  const reference = page.locator('details').filter({ hasText: astra!.id });
  await reference.locator('summary').click();
  await expect(reference.locator('dl div').filter({ hasText: '上下文窗口' })).toContainText(astra!.contextWindow.toLocaleString());
  await expect(reference.locator('dl div').filter({ hasText: '参考最大输出' })).toContainText(astra!.maxOutputTokens.toLocaleString());
  const pricingNote = reference.locator('dl div').filter({ hasText: '参考价格说明' }).locator('dd');
  expect((await pricingNote.innerText()).trim().length).toBeGreaterThan(0);

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
    await expect(mappingForm.getByRole('checkbox', { name: 'tools', exact: true })).toBeChecked();
  }
});
