import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Real local auth/routes/D1/R2/ledger; only the external provider is a fixed fixture.
test('funded user logs in, generates an image, reloads history and sees the preset charge', async ({ page, playwright }) => {
  const info = JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`), 'utf8'));
  const admin = await playwright.request.newContext({ baseURL: info.baseURL, ignoreHTTPSErrors: true });
  try {
    const csrf = (await (await admin.get('/api/v1/settings/public')).json()).data.csrfToken;
    const headers = { Origin: info.baseURL, 'X-CSRF-Token': csrf };
    expect((await admin.post('/api/v1/auth/login', { headers, data: { email: info.adminEmail, password: info.adminPassword } })).status()).toBe(200);
    const create = async (path: string, data: unknown) => {
      const response = await admin.post(path, { headers, data });
      expect(response.status(), await response.text()).toBe(201);
      return (await response.json()).data;
    };
    const tag = randomUUID().slice(0, 8);
    const channel = await create('/api/v1/admin/channels', {
      name: `Image ${tag}`, baseUrl: 'https://e2e-upstream.example.invalid/v1',
      upstreamKey: 'local-fixture-upstream-key', concurrencyLimit: 2, rpmLimit: 60, priority: 10, status: 'active',
    });
    const group = await create('/api/v1/admin/groups', {
      name: `Image group ${tag}`, status: 'active', channelIds: [channel.id], billingMultiplier: '0.5',
    });
    const model = await create('/api/v1/admin/image-models', {
      name: `Image model ${tag}`, channelId: channel.id, upstreamModel: 'fixture-image', pricePerImage: '0.05',
      sizes: ['1024x1024'], quality: 'default', responseFormat: 'b64_json', status: 'active',
    });
    const email = `image-flow-${tag}@example.invalid`;
    const password = 'local-image-flow-password';
    const owner = await create('/api/v1/admin/users', { email, password, groupId: group.id });
    expect((await admin.post(`/api/v1/admin/users/${owner.id}/balance-adjustments`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: { kind: 'grant', deltaUnits: '10000000', reason: 'local image workflow fixture' },
    })).status()).toBe(201);
    await page.goto('/login?returnTo=%2Fimages');
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/images');
    await expect(page.getByText(/每张.*0\.025/)).toBeVisible();
    await page.getByRole('textbox', { name: '画面描述' }).fill('Local image workflow');
    await page.getByRole('button', { name: '生成图片', exact: true }).click();
    await expect(page.getByRole('button', { name: '放大预览图片' })).toBeVisible();
    await expect(page.getByText('已扣费 0.025 积分', { exact: true })).toBeVisible();
    const api = page.context().request;
    const history = (await (await api.get('/api/v1/images/generations')).json()).data.items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ modelId: model.id, status: 'completed', billingStatus: 'settled', priceUnits: '2500000' });
    expect((await api.get(`/api/v1/images/generations/${history[0].id}/content`)).status()).toBe(200);
    expect((await (await api.get('/api/v1/account/balance')).json()).data.balance_units).toBe('7500000');
    await page.reload();
    await expect(page.getByRole('button', { name: '放大预览图片' })).toBeVisible();
    await page.getByRole('button', { name: '查看费用', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/billing');
    await expect(page.getByText('图片生成', { exact: true }).first()).toBeVisible();
    const entries = (await (await api.get('/api/v1/billing/entries?kind=image_generation')).json()).data.items;
    expect(entries).toHaveLength(1);
    expect((await (await api.get('/api/v1/account/balance')).json()).data.balance_units).toBe('7500000');
    const calls = (await (await admin.get('/__test__/calls', { headers: { 'X-E2E-Control': info.token } })).json()).calls;
    expect(calls.filter((call: { protocol: string; model: string }) => call.protocol === 'images' && call.model === 'fixture-image')).toHaveLength(1);
  } finally { await admin.dispose(); }
});
