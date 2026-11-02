import { expect, test } from '@playwright/test';

test('bundled desktop console uses native transport for groups, accounts, images and logout', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __TAURI_INTERNALS__: unknown;
      nativeCalls: { command: string; args: any }[];
    };
    target.nativeCalls = [];
    const jobs: any[] = [];
    const reply = (data: unknown) => ({
      status: 200,
      contentType: 'application/json',
      encoding: 'utf8',
      body: JSON.stringify({ data, request_id: 'native-fixture' }),
    });
    target.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        target.nativeCalls.push({ command, args });
        if (command === 'desktop_console_download') return true;
        if (command !== 'desktop_console_request') throw new Error('Unsupported native command');
        const request = args.request;
        if (request.accountId !== 'desktop-user') throw new Error('Account scope missing');
        const url = new URL(request.path, 'https://cheapai.dev');
        const path = url.pathname;
        if (path === '/api/v1/auth/me')
          return reply({
            id: 'desktop-user',
            email_normalized: 'desktop@example.invalid',
            role: 'user',
            status: 'active',
            group_id: 'standard',
            group_status: 'active',
            balance_units: '100000000',
            email_verified_at: null,
          });
        if (path === '/api/v1/settings/public')
          return reply({
            registrationMode: 'closed',
            emailVerificationEnabled: false,
            csrfToken: 'a'.repeat(42) + 'A',
          });
        if (path === '/api/v1/catalog/groups')
          return reply({
            items: [
              { id: 'standard', name: '标准组' },
              { id: 'discount', name: '优惠组' },
            ],
          });
        if (path === '/api/v1/catalog/models')
          return reply({
            items: [
              {
                kind: 'text',
                id: 'gpt-native',
                prices: {
                  input: url.searchParams.get('groupId') === 'discount' ? '0.5' : '2',
                  output: '8',
                },
              },
            ],
          });
        if (path === '/api/v1/account/key-groups')
          return reply({ items: [{ id: 'standard', name: '标准组', models: ['gpt-native'] }] });
        if (path === '/api/v1/account/balance')
          return reply({
            currency: 'USD',
            decimals: 8,
            balance_units: '100000000',
            balance_usd: '1.00000000',
          });
        if (['/api/v1/keys', '/api/v1/billing/entries', '/api/v1/usage/requests'].includes(path))
          return reply({ items: [], nextCursor: null });
        if (path === '/api/v1/images/models')
          return reply({
            available: true,
            items: [
              {
                modelId: 'image-model',
                name: 'Native image',
                groupId: 'standard',
                groupName: '标准组',
                sizes: ['1024x1024'],
                priceUnits: '5000000',
              },
            ],
          });
        if (path === '/api/v1/images/generations') {
          if (request.method === 'GET') return reply({ items: jobs, nextCursor: null });
          const input = JSON.parse(request.body);
          const job = {
            id: 'native-image',
            operationId: input.operationId,
            modelId: 'image-model',
            modelName: 'Native image',
            groupId: 'standard',
            prompt: input.prompt,
            size: input.size,
            status: 'completed',
            error: null,
            priceUnits: '5000000',
            billingStatus: 'settled',
            createdAt: 1,
            updatedAt: 2,
          };
          jobs.push(job);
          return reply(job);
        }
        if (path === '/api/v1/images/generations/native-image/content')
          return {
            status: 200,
            contentType: 'image/png',
            encoding: 'base64',
            body: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK5kAAAAASUVORK5CYII=',
          };
        throw new Error(`Missing native fixture: ${path}`);
      },
    };
  });
  await page.goto('/tests/console.html');
  const frame = page.frameLocator('iframe[title="用户控制台"]');
  await expect(frame.getByText('gpt-native', { exact: true })).toBeVisible();
  await frame.getByRole('combobox', { name: '公开分组' }).click();
  await frame.getByRole('option', { name: '优惠组', exact: true }).click();
  await expect(frame.getByText('0.5', { exact: true })).toBeVisible();
  await expect(frame.getByText('积分 / 百万 Token', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-catalog.png'), fullPage: true });
  await frame
    .getByRole('navigation', { name: '个人导航' })
    .getByRole('button', { name: 'API 接入' })
    .click();
  await expect(frame.getByRole('heading', { name: 'API 接入', exact: true })).toBeVisible();
  await expect(frame.getByText('https://cheapai.dev/v1', { exact: true }).first()).toBeVisible();
  await frame
    .getByRole('navigation', { name: '个人导航' })
    .getByRole('button', { name: '生图' })
    .click();
  await frame.getByRole('textbox', { name: '画面描述' }).fill('窗边的橘猫');
  await frame.getByRole('button', { name: '生成图片', exact: true }).click();
  const preview = frame.getByRole('button', { name: '放大预览图片' });
  await expect(preview).toBeVisible();
  await expect(frame.getByText('已扣费 0.05 积分', { exact: true })).toBeVisible();
  await expect(preview.locator('img')).toHaveJSProperty('naturalWidth', 1);
  await page.screenshot({ path: testInfo.outputPath('desktop-images.png'), fullPage: true });
  await preview.click();
  await expect(frame.getByRole('dialog', { name: '图片预览' })).toBeVisible();
  await page.keyboard.press('Escape');
  await frame.getByRole('button', { name: '下载图片', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).nativeCalls.filter(
            (call: any) => call.command === 'desktop_console_download',
          ).length,
      ),
    )
    .toBe(1);
  await frame
    .getByRole('navigation', { name: '个人导航' })
    .getByRole('button', { name: '费用' })
    .click();
  await expect(frame.getByRole('heading', { name: '费用', exact: true })).toBeVisible();
  await expect(frame.getByText('1.00 积分', { exact: true })).toBeVisible();
  await frame
    .getByRole('navigation', { name: '个人导航' })
    .getByRole('button', { name: '使用记录' })
    .click();
  await expect(frame.getByRole('heading', { name: '使用记录', exact: true })).toBeVisible();
  await frame
    .getByRole('navigation', { name: '个人导航' })
    .getByRole('button', { name: '对话', exact: true })
    .click();
  await expect(page.locator('body')).toHaveAttribute('data-returned', 'true');
  // Returning to the native chat must not replace the embedded console's route.
  await expect(frame.getByRole('heading', { name: '使用记录', exact: true })).toBeVisible();
  const skip = frame.getByRole('button', { name: '跳到主要内容' });
  await skip.focus();
  await skip.click();
  await expect(frame.locator('#main-content')).toBeFocused();
  await expect(frame.getByRole('heading', { name: '使用记录', exact: true })).toBeVisible();
  const embedded = page.frames().find(candidate => candidate.url().includes('console.html#'))!;
  await embedded.evaluate(() => { window.location.hash = '#/session-unavailable?returnTo=%2Frequests%3FmodelId%3Dgpt-native'; });
  await frame.getByRole('button', { name: '重新连接' }).click();
  await expect(frame.getByRole('heading', { name: '使用记录', exact: true })).toBeVisible();
  expect(await embedded.evaluate(() => window.location.hash)).toBe('#/requests?modelId=gpt-native');
  await frame.getByRole('button', { name: /账户菜单/ }).click();
  await frame.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-logged-out', 'true');
  expect(page.url()).toContain('/tests/console.html');
});
