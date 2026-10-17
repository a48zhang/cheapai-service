import { expect, test } from '@playwright/test';

test('public home stays available when session restoration fails', async ({ page }) => {
  await page.route('**/api/v1/**', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
});

test('home links into anonymous chat and preserves the login destination', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' }, request_id: 'home-test' }),
  }));
  await page.route('**/api/v1/settings/public', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({
      data: { registrationMode: 'closed', emailVerificationEnabled: false, csrfToken: 'a'.repeat(42) + 'A' },
      request_id: 'home-test',
    }),
  }));
  await page.goto('/');
  await page.getByRole('main')
    .getByRole('link', { name: '开始对话', exact: true }).first().click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeEnabled();
  await page.getByRole('textbox', { name: '消息内容' }).fill('一个新想法');
  await page.getByRole('button', { name: '登录后发送' }).click();
  await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('returnTo') === '/chat');
});

test('mobile navigation and page content fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/v1/**', route => route.fulfill({ status: 401, body: '{}' }));
  await page.goto('/');
  await page.getByRole('button', { name: '打开导航' }).click();
  const navigation = page.getByRole('navigation', { name: '移动端首页导航' });
  await expect(navigation).toBeVisible();
  await navigation.getByRole('link', { name: '开发者' }).click();
  await expect(navigation).toHaveCount(0);
  await expect(page).toHaveURL(/#developers$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
