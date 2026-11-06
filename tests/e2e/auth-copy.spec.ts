import { expect, test, type Page } from '@playwright/test';

const account = {
  id: 'auth-copy-user',
  email_normalized: 'user@example.invalid',
  role: 'user',
  status: 'active',
  group_id: 'internal-group',
  group_status: 'active',
  balance_units: '0',
  email_verified_at: null,
};
const envelope = (data: unknown) => JSON.stringify({ data, request_id: 'auth-copy' });

async function fixture(page: Page) {
  const state = { settingsFail: false, loginFail: true, signedIn: false, registrations: 0 };
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: envelope(data) });
    if (path === '/api/v1/auth/me')
      return state.signedIn ? reply(account) : route.fulfill({ status: 401, body: '{}' });
    if (path === '/api/v1/settings/public')
      return state.settingsFail
        ? route.fulfill({ status: 503, body: 'internal upstream router failure' })
        : reply({
            registrationMode: 'open',
            emailVerificationEnabled: false,
            csrfToken: 'a'.repeat(42) + 'A',
          });
    if (path === '/api/v1/auth/login') {
      if (state.loginFail)
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'unauthorized', message: 'internal credential lookup failure' },
            request_id: 'login-rejected',
          }),
        });
      state.signedIn = true;
      return reply(account);
    }
    if (path === '/api/v1/auth/register') {
      state.registrations++;
      return reply(
        { status: 'created', session: 'login_required', user: account, next_action: 'login' },
        201,
      );
    }
    return reply({ items: [], nextCursor: null });
  });
  return state;
}

for (const path of ['/login', '/register']) {
  test(`${path} recovers registration settings without stale loading or internal errors`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.settingsFail = true;
    await page.goto(path);
    await expect(page.getByRole('alert')).toContainText('暂时无法读取注册信息，请重试。');
    await expect(page.getByText('正在读取注册信息…')).toHaveCount(0);
    await expect(page.getByText(/HTTP|upstream|管理 API|响应格式/)).toBeHidden();
    await page.getByRole('button', { name: '查看错误详情' }).click();
    await expect(page.getByText('HTTP 状态码：503', { exact: false })).toBeVisible();
    state.settingsFail = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '创建账户', exact: true })).toBeVisible();
  });
}

test('failed login is actionable and does not follow the user into registration', async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const destination = '/models?q=test%20model#prices';
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  await page.getByLabel('邮箱', { exact: true }).fill(account.email_normalized);
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确，请检查后重试。');
  await expect(page.getByRole('alert')).not.toContainText('请登录后重试。');
  await expect(page.getByText(/internal credential/)).toHaveCount(0);
  await page.getByText('查看错误详情').click();
  await expect(page.getByText('请求编号：login-rejected', { exact: false })).toBeVisible();
  await expect(page.getByText('HTTP 状态码：401', { exact: false })).toBeVisible();
  await expect(page.getByText('错误代码：unauthorized', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('login-error-mobile.png') });
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/register' && url.searchParams.get('returnTo') === destination,
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('registration requiring login offers one usable next step and preserves the original URL', async ({
  page,
}) => {
  const state = await fixture(page);
  state.loginFail = false;
  const destination = '/models?q=test%20model#prices';
  await page.goto(`/register?returnTo=${encodeURIComponent(destination)}`);
  await page.getByLabel('邮箱', { exact: true }).fill(account.email_normalized);
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await expect(page.getByText('账户已创建，请登录后继续。')).toBeVisible();
  await expect(page.getByText(/恢复会话/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建账户', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('returnTo') === destination,
  );
  await page.getByLabel('邮箱', { exact: true }).fill(account.email_normalized);
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(destination);
  expect(state.registrations).toBe(1);
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'API 接入', exact: true }),
  ).toBeVisible();
});
