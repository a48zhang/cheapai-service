import { expect, test, type Page } from '@playwright/test';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK5kAAAAASUVORK5CYII=';
async function fixture(page: Page, failFirst = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [];
  const choice = {
    modelId: 'image-model',
    name: 'Image model',
    groupId: 'images',
    groupName: '标准组',
    sizes: ['1024x1024', '1536x1024'],
    priceUnits: '5000000',
  };
  await page
    .context()
    .addCookies([{ name: '__Host-sub2api_csrf', value: 'image-csrf', url: 'https://127.0.0.1/' }]);
  await page.context().route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const reply = (data: unknown) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data, request_id: 'image-browser' }),
      });
    if (url.pathname === '/api/v1/auth/me')
      return reply({
        id: 'image-user',
        email_normalized: 'image@example.invalid',
        role: 'user',
        status: 'active',
        group_id: 'images',
        group_status: 'active',
        balance_units: '100000000',
        email_verified_at: null,
      });
    if (url.pathname === '/api/v1/settings/public')
      return reply({
        registrationMode: 'closed',
        emailVerificationEnabled: false,
        csrfToken: 'a'.repeat(42) + 'A',
      });
    if (url.pathname === '/api/v1/images/models')
      return reply({ items: [choice], available: true });
    if (url.pathname === '/api/v1/images/generations') {
      if (route.request().method() === 'GET') return reply({ items: jobs, nextCursor: null });
      const input = route.request().postDataJSON();
      calls.push(input);
      if (failFirst && calls.length === 1) return route.abort('failed');
      await gate;
      const job = {
        id: 'image-job',
        operationId: input.operationId,
        modelId: choice.modelId,
        modelName: choice.name,
        groupId: choice.groupId,
        prompt: input.prompt,
        size: input.size,
        status: 'completed',
        error: null,
        priceUnits: choice.priceUnits,
        billingStatus: 'settled',
        createdAt: 1,
        updatedAt: 2,
      };
      jobs.splice(0, jobs.length, job);
      return reply(job);
    }
    if (url.pathname === '/api/v1/images/generations/image-job/content')
      return route.fulfill({
        contentType: 'image/png',
        headers: {
          'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="image-job.png"`,
        },
        body: Buffer.from(png, 'base64'),
      });
    if (url.pathname === '/api/v1/images/generations/image-job') return reply(jobs[0]);
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'not_found', message: 'missing fixture' },
        request_id: 'image-browser',
      }),
    });
  });
  return { calls, release, jobs };
}
for (const width of [1440, 375]) {
  test(`image generation has immediate feedback, preview and download at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await fixture(page);
    await page.goto('/images');
    const input = page.getByRole('textbox', { name: '画面描述' });
    await input.fill('一只橘猫坐在窗边，水彩画，午后阳光。');
    await expect(page.getByText(/每张.*0\.05/)).toBeVisible();
    await page.getByRole('combobox', { name: '图片尺寸' }).click();
    await page.getByRole('option', { name: '1536 × 1024' }).click();
    await page.getByRole('button', { name: '生成图片', exact: true }).click();
    await expect(page.getByText('正在生成图片…', { exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '正在生成图片', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('image-waiting.png'), fullPage: true });
    await input.fill('下一张图片的描述');
    await input.press('Control+Enter');
    expect(api.calls).toHaveLength(1);
    api.release();
    const preview = page.getByRole('button', { name: '放大预览图片' });
    await expect(preview).toBeVisible();
    await expect(input).toHaveValue('下一张图片的描述');
    await preview.click();
    await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(preview).toBeFocused();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载图片' }).click();
    expect((await downloaded).suggestedFilename()).toBe('image-job.png');
    await page.reload();
    await expect(page.getByRole('button', { name: '放大预览图片' })).toBeVisible();
    expect(api.calls).toHaveLength(1);
    await page.getByRole('button', { name: '复用参数' }).click();
    await expect(input).toHaveValue('一只橘猫坐在窗边，水彩画，午后阳光。');
    await expect(page.getByRole('combobox', { name: '图片尺寸' })).toContainText('1536 × 1024');
    await expect(page.getByRole('link', { name: '查看费用' })).toHaveAttribute(
      'href',
      '/billing?period=all&kind=image_generation&requestId=image-job',
    );
    expect(api.calls).toHaveLength(1);
    await page.getByRole('button', { name: '撤销复用' }).click();
    await expect(input).toHaveValue('下一张图片的描述');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
test('confirmation after a lost response reuses the same operation and draft', async ({ page }) => {
  const api = await fixture(page, true);
  api.release();
  await page.goto('/images');
  await page.getByRole('textbox', { name: '画面描述' }).fill('可恢复的原描述');
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认生成结果' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '确认生成结果' }).click();
  await expect(page.getByRole('button', { name: '放大预览图片' })).toBeVisible();
  expect(api.calls).toHaveLength(2);
  expect(api.calls[1]).toEqual(api.calls[0]);
});
