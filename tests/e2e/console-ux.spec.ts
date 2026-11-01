import { test, expect, type Page } from '@playwright/test';
const now = Date.now();
const userId = 'console-user';
const model = 'claude-sonnet-console-long-model-name';
const key = {
  id: 'console-key',
  userId,
  groupId: 'standard',
  groupName: '标准模型组',
  name: '我的应用密钥',
  displayPrefix: 's2a_key_12345678',
  status: 'active',
  allowedModels: null,
  expiresAt: null,
  createdAt: now,
  updatedAt: now,
  version: 1,
};
const request = {
  id: 'console-request',
  user_id: userId,
  api_key_id: key.id,
  channel_id: 'channel',
  public_model_id: model,
  upstream_model: model,
  downstream_protocol: 'chat',
  upstream_protocol: 'chat',
  source: 'web_chat',
  group_id: 'standard',
  execution_status: 'succeeded',
  billing_status: 'settled',
  created_at: now,
  started_at: now,
  finished_at: now + 2100,
  updated_at: now + 2100,
  usage: {
    protocol: 'chat',
    quality: 'complete',
    counts: { inputTokens: 1200, outputTokens: 240 },
    semantics: {
      cacheRead: 'included_in_input',
      cacheWrite: 'included_in_input',
      reasoning: 'included_in_output',
      cacheWriteTtl: 'unknown',
    },
  },
  usage_valid: true,
  price_snapshot: null,
  price_snapshot_valid: false,
  cost_units: '130000',
  error: null,
  retry_count: 0,
  next_retry_at: null,
};
const entries = [
  {
    id: 'charge',
    operationId: 'charge-op',
    kind: 'consumption',
    userId,
    requestId: request.id,
    modelId: model,
    source: 'web_chat',
    currency: 'USD',
    deltaUnits: '-130000',
    createdBy: null,
    reason: null,
    createdAt: new Date(now).toISOString(),
  },
  {
    id: 'grant',
    operationId: 'grant-op',
    kind: 'grant',
    userId,
    requestId: null,
    modelId: null,
    source: null,
    currency: 'USD',
    deltaUnits: '1000000000',
    createdBy: 'admin',
    reason: '账户额度',
    createdAt: new Date(now - 100000).toISOString(),
  },
];
async function fixture(page: Page, { empty = false, billingError = false } = {}) {
  const state = { reads: [] as string[], billingError };
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const reply = (data: unknown) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data, request_id: 'console-review' }),
      });
    state.reads.push(path + url.search);
    if (path === '/api/v1/auth/me')
      return reply({
        id: userId,
        email_normalized: 'console.user@example.invalid',
        role: 'user',
        status: 'active',
        group_id: 'standard',
        group_status: 'active',
        balance_units: '999870000',
        email_verified_at: null,
      });
    if (path === '/api/v1/settings/public')
      return reply({
        registrationMode: 'closed',
        emailVerificationEnabled: false,
        csrfToken: 'a'.repeat(42) + 'A',
      });
    if (path === '/api/v1/account/balance')
      return reply({
        currency: 'USD',
        decimals: 8,
        balance_units: '999870000',
        balance_usd: '9.99870000',
      });
    if (path === '/api/v1/account/key-groups')
      return reply({
        items: [
          {
            id: 'standard',
            name: '标准模型组',
            models: [model],
            billingMultiplier: '1',
            modelPrices: { [model]: { input: '1', output: '3' } },
          },
        ],
      });
    if (path === '/api/v1/keys/console-key') return reply(key);
    if (path === '/api/v1/keys') return reply({ items: empty ? [] : [key], nextCursor: null });
    if (path === '/api/v1/usage/requests')
      return reply({ items: empty ? [] : [request], snapshotAt: now, nextCursor: null });
    if (path === `/api/v1/usage/requests/${request.id}`) return reply(request);
    if (path === '/api/v1/billing/entries') {
      if (state.billingError)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'service_unavailable', message: 'unavailable' },
            request_id: 'console-error',
          }),
        });
      return reply({
        items: empty
          ? []
          : entries.filter(
              (item) => !url.searchParams.has('kind') || item.kind === url.searchParams.get('kind'),
            ),
        nextCursor: null,
        summary: {
          currency: 'USD',
          consumptionUnits: empty ? '0' : '130000',
          createdFrom: url.searchParams.has('createdFrom')
            ? Number(url.searchParams.get('createdFrom'))
            : null,
          createdBefore: url.searchParams.has('createdBefore')
            ? Number(url.searchParams.get('createdBefore'))
            : null,
        },
      });
    }
    if (path === '/api/v1/images/models') return reply({ items: [], available: true });
    if (path === '/api/v1/images/generations') return reply({ items: [], nextCursor: null });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'not_found', message: 'fixture missing' },
        request_id: 'console-review',
      }),
    });
  });
  return state;
}
for (const width of [320, 375, 1440])
  test(`console pages fit the viewport at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const route of ['/keys', '/billing', '/requests', '/images']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (route === '/keys')
        await expect(
          page
            .getByRole(width < 1024 ? 'list' : 'table', { name: '个人 API 密钥列表' })
            .getByText('我的应用密钥', { exact: true }),
        ).toBeVisible();
      if (route === '/billing')
        await expect(
          page
            .getByRole(width < 1024 ? 'list' : 'table', { name: '个人账单明细' })
            .getByText('管理员授额', { exact: true }),
        ).toBeVisible();
      if (route === '/requests')
        await expect(page.getByRole('link', { name: `查看 ${model} 使用详情` })).toBeVisible();
      if (route === '/images') await expect(page.getByText(/暂无可用生图模型/)).toBeVisible();
      await page.screenshot({ path: info.outputPath(route.slice(1) + '.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(errors).toEqual([]);
  });

test('mobile key actions and account identity stay accessible', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await fixture(page);
  await page.goto('/keys');
  const cards = page.getByRole('list', { name: '个人 API 密钥列表' });
  await expect(cards.getByText('有效', { exact: true })).toBeVisible();
  await cards.getByRole('button', { name: '密钥操作：我的应用密钥' }).click();
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '编辑密钥' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
    '我的应用密钥',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '账户菜单' }).click();
  await expect(page.getByText('console.user@example.invalid', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '使用记录' })).toBeVisible();
});

for (const width of [375, 1440])
  test(`billing keeps signed amounts, dates and return context at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await fixture(page);
    await page.goto('/billing?period=all');
    const rows = page.getByRole(width < 1024 ? 'list' : 'table', { name: '个人账单明细' });
    await expect(
      rows.getByText(width < 1024 ? '-0.0013 USD' : '-0.0013', { exact: true }),
    ).toBeVisible();
    await expect(rows.getByText(width < 1024 ? '+10 USD' : '+10', { exact: true })).toBeVisible();
    await expect(page.getByLabel('开始日期', { exact: true })).toHaveValue('');
    await page.getByLabel('费用类型').click();
    await page.getByRole('option', { name: '模型消费', exact: true }).click();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expect(page).toHaveURL(/period=all&kind=consumption/);
    const original = page.url();
    await rows.getByRole('link', { name: '查看记录' }).click();
    await expect(page.getByRole('heading', { name: '使用记录详情' })).toBeVisible();
    await page.getByRole('link', { name: '返回费用明细' }).click();
    await expect(page).toHaveURL(original);
    await page.reload();
    await expect(page.getByLabel('开始日期', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '本月', exact: true }).click();
    await expect(page.getByLabel('开始日期', { exact: true })).not.toHaveValue('');
    await page.getByLabel('开始日期', { exact: true }).fill('');
    await page.getByLabel('结束日期', { exact: true }).fill('');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expect(page).toHaveURL(/period=all&kind=consumption/);
    await page.getByRole('button', { name: '刷新费用', exact: true }).click();
    await expect
      .poll(() => state.reads.filter((path) => path.startsWith('/api/v1/billing/entries')).at(-1))
      .not.toContain('createdFrom');
  });

test('request filters survive detail navigation and can find their associated bill', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/requests');
  await page.getByLabel('模型 ID', { exact: true }).fill(model);
  await page.getByLabel('开始时间', { exact: true }).fill('2026-10-01T00:00');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  const original = page.url();
  await page.getByRole('link', { name: `查看 ${model} 使用详情` }).click();
  await page.getByRole('link', { name: '返回使用记录' }).click();
  await expect(page).toHaveURL(original);
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue(model);
  await page.getByRole('link', { name: `查看 ${model} 使用详情` }).click();
  await page.getByRole('link', { name: '相关费用' }).click();
  await expect(page).toHaveURL(/period=all&requestId=console-request/);
});

test('billing read errors can retry and empty usage offers an action', async ({ page }) => {
  const state = await fixture(page, { billingError: true });
  await page.goto('/billing?period=all');
  await expect(page.getByRole('alert').last()).toBeVisible();
  state.billingError = false;
  await page.getByRole('alert').last().getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('table', { name: '个人账单明细' })).toContainText('管理员授额');
  await page.unroute('**/api/v1/**');
  await fixture(page, { empty: true });
  await page.goto('/requests');
  await expect(page.getByRole('link', { name: '开始对话', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '接入 API', exact: true })).toBeVisible();
});

test('console navigation stays visible while the next page loads', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/assets/BillingPage-*.js', async (route) => {
    await ready;
    await route.continue();
  });
  await page.goto('/keys');
  await expect(page.getByRole('heading', { name: 'API 接入', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '个人导航' })
    .getByRole('link', { name: '费用', exact: true })
    .click();
  await expect(page.getByRole('navigation', { name: '个人导航' })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: '费用', exact: true })).toBeVisible();
});

test('refreshing an older request page reloads the newest page', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/requests?cursor=older');
  await expect(page.getByRole('link', { name: `查看 ${model} 使用详情` })).toBeVisible();
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect
    .poll(() => state.reads.filter((path) => path.startsWith('/api/v1/usage/requests?')).at(-1))
    .not.toContain('cursor=');
});

test('quick request filters retain the model, clear pagination and survive reload', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/requests?model=${model}&cursor=older`);
  await page.getByRole('button', { name: '近 7 天', exact: true }).click();
  let query = new URL(page.url()).searchParams;
  expect(query.get('model')).toBe(model);
  expect(query.has('cursor')).toBe(false);
  expect(Number(query.get('to'))).toBeGreaterThan(Number(query.get('from')));
  await page.getByRole('button', { name: '只看失败', exact: true }).click();
  await expect(page).toHaveURL(/status=failed/);
  await page.reload();
  await expect(page.getByRole('button', { name: '只看失败' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '全部时间', exact: true }).click();
  query = new URL(page.url()).searchParams;
  expect(query.get('status')).toBe('failed');
  expect(query.get('model')).toBe(model);
  expect(query.has('from')).toBe(false);
  expect(query.has('to')).toBe(false);
  await expect
    .poll(() => state.reads.filter((path) => path.startsWith('/api/v1/usage/requests?')).at(-1))
    .toContain('status=failed');
  await page.getByRole('button', { name: '只看失败', exact: true }).click();
  await expect(page).not.toHaveURL(/status=failed/);
});
