import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

interface Connection { baseURL: string; token: string; adminEmail: string; adminPassword: string }
let connection: Connection;
let administrator: APIRequestContext;
let csrf: string;
const password = 'local-user-browser-fixture-password';
test.beforeAll(async ({ playwright }) => {
  connection = JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`), 'utf8')) as Connection;
  administrator = await playwright.request.newContext({ baseURL: connection.baseURL, ignoreHTTPSErrors: true });
  const settings = await administrator.get('/api/v1/settings/public');
  expect(settings.status()).toBe(200); csrf = (await settings.json()).data.csrfToken;
  const login = await administrator.post('/api/v1/auth/login', { data: { email: connection.adminEmail, password: connection.adminPassword },
    headers: { Origin: connection.baseURL, 'X-CSRF-Token': csrf } });
  expect(login.status()).toBe(200);
});
test.afterAll(async () => { await administrator?.dispose(); });

async function policy(registrationMode: 'closed' | 'open' | 'invite', emailVerificationEnabled: boolean) {
  const response = await administrator.post('/__test__/policy', { headers: { 'X-E2E-Control': connection.token }, data: { registrationMode, emailVerificationEnabled } });
  expect(response.status()).toBe(200);
}
async function invitation(): Promise<string> {
  const result = await administrator.post('/api/v1/admin/registration/codes', { data: { quantity: 1, expiresAt: Date.now() + 3_600_000 },
    headers: { Origin: connection.baseURL, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() } });
  expect(result.status()).toBe(201);
  return (await result.json()).data.codes[0].token as string;
}
async function mail(email: string): Promise<{ code: string; count: number }> {
  const response = await administrator.get(`/__test__/mail?email=${encodeURIComponent(email)}`, { headers: { 'X-E2E-Control': connection.token } });
  expect(response.status()).toBe(200); return response.json();
}
async function fillRegistration(page: Page, email: string, code?: string) {
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  if (code) await page.getByLabel('邀请码', { exact: true }).fill(code);
}

for (const mode of ['closed', 'open', 'invite'] as const) {
  for (const verify of [false, true]) {
    test(`${mode} registration, email verification ${verify}`, async ({ page }) => {
      await policy(mode, verify);
      await page.goto('/register');
      const email = `q03-${randomUUID()}@example.invalid`;
      if (mode === 'closed') {
        await expect(page.getByText('当前未开放自助注册。已有账户可以直接登录。')).toBeVisible();
        await expect(page.locator('form')).toHaveCount(0);
        const settings = await page.context().request.get('/api/v1/settings/public');
        const token = (await settings.json()).data.csrfToken;
        const rejected = await page.context().request.post('/api/v1/auth/register', { data: { email, password },
          headers: { Origin: connection.baseURL, 'X-CSRF-Token': token } });
        expect(rejected.status()).toBe(403); return;
      }
      await fillRegistration(page, email, mode === 'invite' ? await invitation() : undefined);
      if (verify) {
        await page.getByRole('button', { name: '发送验证码', exact: true }).click();
        await expect(page.getByText(/验证码发送请求已受理/)).toBeVisible();
        await page.getByLabel('邮箱验证码', { exact: true }).fill((await mail(email)).code);
      } else await expect(page.locator('#email-code')).toHaveCount(0);
      await page.getByRole('button', { name: '创建账户', exact: true }).click();
      await expect(page).toHaveURL(connection.baseURL + "/");
      const me = await page.context().request.get('/api/v1/auth/me');
      expect(me.status()).toBe(200);
      const user = (await me.json()).data;
      expect(user.role).toBe('user'); expect(user.balance_units).toBe('0');
      expect(user.email_verified_at === null).toBe(!verify);

      await page.goto('/keys');
      await page.getByRole('button', { name: '创建 Key', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('名称', { exact: true }).fill('Browser fixture key');
      await dialog.getByRole('combobox', { name: '分组', exact: true }).selectOption('default');
      await dialog.getByRole('button', { name: '创建 Key', exact: true }).click();
      const secret = dialog.getByLabel('完整密钥（仅显示一次）', { exact: true });
      await expect(secret).toBeVisible();
      expect((await secret.inputValue()).startsWith('s2a_key_')).toBe(true);
      await dialog.getByRole('button', { name: '已保存，关闭密钥' }).click();
      await expect(page.locator('#new-key-secret')).toHaveCount(0);
      expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('s2a_key_')))).toBe(false);
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await expect(page).toHaveURL(/\/login$/);
      expect((await page.context().request.get('/api/v1/auth/me')).status()).toBe(401);
      await page.getByLabel('邮箱', { exact: true }).fill(email);
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page).toHaveURL(connection.baseURL + "/");
    });
  }
}

test('resend advances generation and the first verification code cannot register', async ({ page }) => {
  await policy('open', true);
  await page.clock.install();
  await page.goto('/register');
  const email = `q03-resend-${randomUUID()}@example.invalid`;
  await fillRegistration(page, email);
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  await expect(page.getByText(/验证码发送请求已受理/)).toBeVisible();
  const old = await mail(email);
  await expect(page.getByRole('button', { name: /秒后可重发/ })).toBeDisabled();
  const aged = await administrator.post('/__test__/age-challenge', { headers: { 'X-E2E-Control': connection.token }, data: { email } });
  expect(aged.status()).toBe(200);
  await page.clock.fastForward(61_000);
  await page.getByRole('button', { name: '重新发送验证码', exact: true }).click();
  await expect.poll(async () => (await mail(email)).count).toBe(2);
  const latest = await mail(email);
  // Random codes could collide; verify the server generation directly through
  // the fresh proof when that occurs, without manufacturing a failing old code.
  if (old.code !== latest.code) {
    await page.getByLabel('邮箱验证码', { exact: true }).fill(old.code);
    await page.getByRole('button', { name: '创建账户', exact: true }).click();
    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  }
  await page.getByLabel('邮箱验证码', { exact: true }).fill(latest.code);
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page).toHaveURL(connection.baseURL + "/");
});
