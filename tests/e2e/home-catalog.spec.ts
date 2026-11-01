import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const catalog = {
  items: [
    { kind: 'text', id: 'gpt-5', prices: { input: '1.25', output: '10', cacheRead: '0.125' } },
    { kind: 'text', id: 'claude-sonnet-4-6', prices: { input: '3', output: '15' } },
    { kind: 'text', id: 'deepseek-chat', prices: { input: '0.28', output: '0.42' } },
    {
      kind: 'text',
      id: 'custom/provider-with-a-long-model-name-for-testing',
      prices: { input: '0', output: '0.00000001' },
    },
    { kind: 'image', id: 'image-demo', name: 'GPT Image', price: '0.04000000' },
  ],
};
const envelope = (data: unknown) => JSON.stringify({ data, request_id: 'catalog-test' });

test('login returns to the public catalog query instead of forcing chat', async ({ page }) => {
  let signedIn = false;
  const account = { id: 'catalog-user', email_normalized: 'catalog@example.invalid', role: 'user', status: 'active', group_id: 'standard', group_status: 'active', balance_units: '0', email_verified_at: null };
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (data: unknown) => route.fulfill({ contentType: 'application/json', body: envelope(data) });
    if (path === '/api/v1/auth/me') return signedIn ? reply(account) : route.fulfill({ status: 401, body: '{}' });
    if (path === '/api/v1/auth/login') { signedIn = true; return reply(account); }
    if (path === '/api/v1/settings/public') return reply({ registrationMode: 'closed', emailVerificationEnabled: false, csrfToken: 'a'.repeat(42) + 'A' });
    if (path === '/api/v1/catalog/groups') return reply({ items: [{ id: 'standard', name: '标准组' }] });
    if (path === '/api/v1/catalog/models') return reply(catalog);
    return reply({ items: [], nextCursor: null });
  });
  await page.goto('/models?group=standard&q=custom%20model#prices');
  await page.getByRole('banner').getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('returnTo') === '/models?group=standard&q=custom%20model#prices');
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('invalid');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('catalog@example.invalid');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL('/models?group=standard&q=custom%20model#prices');
  await page.goto('/login?returnTo=%2Fmodels');
  await expect(page).toHaveURL(/\/models$/);
});

async function publicHome(page: Page) {
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.route('**/api/v1/catalog/groups', (route) => route.fulfill({ contentType: 'application/json', body: envelope({ items: [{ id: 'standard', name: '标准组' }, { id: 'discount', name: '折扣组' }] }) }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        },
      },
    });
  });
}

for (const width of [320, 375, 1440]) {
  test(`public catalog emphasizes exact prices and supports search at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await publicHome(page);
    let requests = 0;
    await page.route('**/api/v1/catalog/models?*', (route) => {
      requests++;
      return route.fulfill({ contentType: 'application/json', body: envelope(catalog) });
    });
    await page.goto('/');
    const banner = page.getByRole('banner');
    await expect(page.getByRole('tablist', { name: '首页内容' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '对话与 API 接入' })).toBeVisible();
    expect(requests).toBe(0);
    if (width < 900) {
      await banner.getByRole('button', { name: '打开导航' }).click();
      await expect(page.getByRole('menuitem')).toHaveText([
        '产品',
        '模型目录',
        'Agent 接入',
        '常见问题',
      ]);
      await page.getByRole('menuitem', { name: '模型目录', exact: true }).click();
      await expect(page.getByRole('menu')).toHaveCount(0);
    } else {
      const navigation = banner.getByRole('navigation', { name: '首页导航' });
      await expect(navigation.getByRole('button')).toHaveText([
        '产品',
        '模型目录',
        'Agent 接入',
        '常见问题',
      ]);
      await navigation.getByRole('button', { name: '模型目录' }).click();
    }
    await expect(page).toHaveURL(/\/models$/);
    const directory = page.getByRole('region', { name: '模型目录' });
    await expect(directory.getByRole('article')).toHaveCount(5);
    await expect(directory).not.toContainText(/选模型，先看价格|本站基础价|查看我的可用模型/);
    await expect(directory.getByRole('combobox', { name: '公开分组' })).toContainText('标准组');
    const gpt = directory.getByRole('article', { name: 'gpt-5', exact: true });
    await expect(gpt.locator('dt')).toHaveText(['输入', '输出']);
    await expect(gpt.locator('dd')).toHaveText(['1.25', '10']);
    await expect(gpt).toContainText('积分 / 百万 Token');
    await expect(gpt).toContainText('缓存读取 0.125 积分');
    const tiny = directory.getByRole('article', { name: /custom\/provider/ });
    await expect(tiny.locator('dd')).toHaveText(['0', '0.00000001']);
    expect(
      await tiny
        .locator('dd')
        .last()
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        }),
    ).toBe(1);
    const image = directory.getByRole('article', { name: 'GPT Image', exact: true });
    await expect(image).toContainText('积分 / 张');
    await expect(image.locator('dd')).toHaveText('0.04');
    await expect(image.getByRole('button', { name: '去生图' })).toBeEnabled();
    await expect(directory).not.toContainText(
      /最大输出|上下文窗口|contextWindow|max_output_tokens/,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('catalog.png'), fullPage: true });
    await gpt.getByRole('button', { name: '复制模型 ID' }).click();
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
      'gpt-5',
    );
    await directory.getByRole('searchbox', { name: '搜索模型' }).fill('  CLAUDE ');
    await expect(directory.getByRole('article')).toHaveCount(1);
    await expect(directory.getByRole('article')).toHaveAccessibleName('claude-sonnet-4-6');
    await directory.getByRole('searchbox').fill('not-a-model');
    await expect(directory.getByText('没有找到匹配的模型。')).toBeVisible();
    await directory.getByRole('button', { name: '清除搜索' }).click();
    await expect(directory.getByRole('article')).toHaveCount(5);
  });
}

test('header navigation, catalog deep links and overview anchors survive reload and history', async ({
  page,
}) => {
  await publicHome(page);
  await page.route('**/api/v1/catalog/models?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: envelope(catalog) }),
  );
  await page.goto('/#models');
  const navigation = page.getByRole('banner').getByRole('navigation', { name: '首页导航' });
  await expect(navigation.getByRole('button', { name: '模型目录' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('article', { name: 'gpt-5', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '跳到主要内容' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByRole('main')).toBeFocused();
  await page.reload();
  await expect(navigation.getByRole('button', { name: '模型目录' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await navigation.getByRole('button', { name: '产品', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '对话与 API 接入' })).toBeVisible();
  await page.goBack();
  await expect(navigation.getByRole('button', { name: '模型目录' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: 'Agent 接入指南', exact: true }).click();
  await expect(page).toHaveURL(/#agent-tools$/);
  const guide = page.getByRole('region', { name: '把常用 Agent 接入 CheapAI' });
  await expect(guide.getByRole('heading', { name: '把常用 Agent 接入 CheapAI' })).toBeInViewport();
  await expect(guide.getByRole('tab', { name: 'Codex' })).toBeVisible();
});

test('catalog distinguishes loading, failure, retry and empty inventory', async ({ page }) => {
  await publicHome(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/v1/catalog/models?*', async (route) => {
    requests++;
    if (requests === 1) {
      await pending;
      await route.fulfill({ status: 503, body: 'Unavailable' });
    } else {
      await route.fulfill({ contentType: 'application/json', body: envelope({ items: [] }) });
    }
  });
  await page.goto('/#models');
  await expect(page.getByRole('status').filter({ hasText: '正在加载模型与价格' })).toBeVisible();
  release();
  await expect(page.getByRole('alert')).toContainText('模型与价格暂时加载失败');
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('status').filter({ hasText: '此分组暂无上架模型' })).toBeVisible();
  expect(requests).toBe(2);
});

test('invalid prices are unavailable rather than displayed as free', async ({ page }) => {
  await publicHome(page);
  await page.route('**/api/v1/catalog/models?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: envelope({ items: [{ kind: 'text', id: 'missing-price', prices: { input: '0' } }] }),
    }),
  );
  await page.goto('/#models');
  await expect(page.getByRole('alert')).toContainText('模型与价格暂时加载失败');
  await expect(page.getByRole('article')).toHaveCount(0);
});


test('group selection changes inventory and effective prices and survives URL history', async ({ page }) => {
  await publicHome(page);
  await page.route('**/api/v1/catalog/models?*', (route) => route.fulfill({ contentType: 'application/json', body: envelope(
    new URL(route.request().url()).searchParams.get('groupId') === 'discount'
      ? { items: [{ kind: 'text', id: 'gpt-5', prices: { input: '0.125', output: '1' } }] }
      : catalog,
  ) }));
  await page.goto('/models');
  await expect(page.getByRole('article')).toHaveCount(5);
  await page.getByRole('combobox', { name: '公开分组' }).click();
  await page.getByRole('option', { name: '折扣组', exact: true }).click();
  await expect(page).toHaveURL(/models\?group=discount$/);
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article').locator('dd')).toHaveText(['0.125', '1']);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '公开分组' })).toContainText('折扣组');
  await expect(page.getByRole('article').locator('dd')).toHaveText(['0.125', '1']);
  await page.goBack();
  await expect(page.getByRole('combobox', { name: '公开分组' })).toContainText('标准组');
  await expect(page.getByRole('article')).toHaveCount(5);
});

test('no public groups and withdrawn group links have clear empty states', async ({ page }) => {
  await publicHome(page);
  await page.goto('/models?group=private');
  await expect(page.getByText('该公开分组暂不可用，请重新选择。')).toBeVisible();
  await page.route('**/api/v1/catalog/groups', (route) => route.fulfill({ contentType: 'application/json', body: envelope({ items: [] }) }));
  await page.reload();
  await expect(page.getByText('暂无公开分组。')).toBeVisible();
});
