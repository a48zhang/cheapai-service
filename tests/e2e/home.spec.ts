import { expect, test } from '@playwright/test';

test('public home stays available when session restoration fails', async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
});

test('home links into anonymous chat and preserves the login destination', async ({ page }) => {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'unauthorized', message: 'Sign in' },
        request_id: 'home-test',
      }),
    }),
  );
  await page.route('**/api/v1/settings/public', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          registrationMode: 'closed',
          emailVerificationEnabled: false,
          csrfToken: 'a'.repeat(42) + 'A',
        },
        request_id: 'home-test',
      }),
    }),
  );
  await page.goto('/');
  await page.getByRole('main').getByRole('link', { name: '开始对话', exact: true }).first().click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeEnabled();
  await page.getByRole('textbox', { name: '消息内容' }).fill('一个新想法');
  await page.getByRole('button', { name: '登录后发送' }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('returnTo') === '/chat',
  );
});

for (const width of [320, 375, 1440]) {
  test(`agent guides show usable configuration without audience tags at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 401, body: '{}' }));
    await page.goto('/');
    await expect(page.getByRole('banner').getByText('用户', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('banner').getByText('开发者', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: '接入 Agent', exact: true }).click();
    await expect(page).toHaveURL(/#agent-tools$/);
    const guide = page.getByRole('region', { name: '把常用 Agent 接入 CheapAI' });
    const panel = guide.getByRole('tabpanel');
    const origin = new URL(page.url()).origin;
    await expect(panel.locator('pre').first()).toContainText(`base_url = "${origin}/v1"`);
    await expect(panel.locator('pre').first()).toContainText('wire_api = "responses"');
    await guide.getByRole('combobox', { name: '终端环境' }).selectOption('powershell');
    await expect(panel.locator('pre').last()).toContainText(
      "$env:CHEAPAI_API_KEY = 'YOUR_API_KEY'",
    );
    await guide.screenshot({ path: testInfo.outputPath('agent-guides.png') });
    for (const tool of ['Claude Code', 'OpenCode', 'Cline']) {
      await guide.getByRole('tab', { name: tool, exact: true }).click();
      await expect(panel.getByRole('link', { name: `${tool} 官方文档` })).toBeVisible();
      if (tool === 'Claude Code') {
        await expect(panel.locator('pre')).toContainText(`$env:ANTHROPIC_BASE_URL = '${origin}'`);
        await expect(panel.locator('pre')).not.toContainText(`${origin}/v1`);
      } else if (tool === 'OpenCode') {
        const config = JSON.parse(await panel.locator('pre').first().innerText());
        expect(config.provider.cheapai.options.baseURL).toBe(`${origin}/v1`);
        expect(config.provider.cheapai.options.apiKey).toBe('{env:CHEAPAI_API_KEY}');
        expect(config.model).toBe('cheapai/YOUR_MODEL_ID');
      } else {
        await expect(panel.locator('pre')).toContainText('API Provider: OpenAI Compatible');
        await expect(panel.locator('pre')).toContainText(`Base URL: ${origin}/v1`);
        await expect(panel.getByRole('combobox')).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await guide.getByRole('link', { name: '创建 API Key' }).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === '/login' && url.searchParams.get('returnTo') === '/keys',
    );
  });
}

test('guide tabs work with the keyboard and copying follows the selected shell', async ({
  page,
}) => {
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
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 401, body: '{}' }));
  await page.goto('/#agent-tools');
  const guide = page.getByRole('region', { name: '把常用 Agent 接入 CheapAI' });
  await guide.getByRole('tab', { name: 'Codex', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(guide.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const panel = guide.getByRole('tabpanel');
  await panel.getByRole('button', { name: '复制', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
    await panel.locator('pre').innerText(),
  );
  await panel.getByRole('combobox').selectOption('powershell');
  await expect(panel.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '复制', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toContain(
    '$env:ANTHROPIC_BASE_URL',
  );
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('denied');
    };
  });
  await panel.getByRole('combobox').selectOption('posix');
  await panel.getByRole('button', { name: '复制', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('复制失败');
});
