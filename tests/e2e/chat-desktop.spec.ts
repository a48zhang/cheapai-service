import { expect, test, type Page } from '@playwright/test';

const timestamp = 1_700_000_000_000;
const user = {
  id: 'desktop-user',
  email_normalized: 'desktop@example.invalid',
  role: 'user',
  status: 'active',
  group_id: 'standard',
  group_status: 'active',
  balance_units: '1000000',
  email_verified_at: null,
};
const longModel = 'flagship-reasoning-model-with-extended-context-2026-10-04';
const groups = [
  {
    id: 'standard',
    name: '标准组',
    billingMultiplier: '1',
    models: [{ publicModelId: 'flagship-pro', sellPrices: { input: '1', output: '4' } }],
  },
  {
    id: 'value',
    name: '优惠组',
    billingMultiplier: '0.5',
    models: [
      { publicModelId: 'flagship-pro', sellPrices: { input: '1', output: '4' } },
      { publicModelId: longModel, sellPrices: { input: '2', output: '8' } },
    ],
  },
];

async function fixture(page: Page, initiallyEmpty = false) {
  let empty = initiallyEmpty;
  let conversation = {
    id: 'desktop-conversation',
    title: '桌面对话',
    groupId: 'standard',
    modelId: 'flagship-pro',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let messages: unknown[] = [];
  const sent: { groupId: string; modelId: string; content: string }[] = [];
  await page
    .context()
    .addCookies([
      { name: '__Host-sub2api_csrf', value: 'desktop-csrf', url: 'https://127.0.0.1/' },
    ]);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (data: unknown) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data, request_id: 'desktop-request' }),
      });
    if (path === '/api/v1/auth/me') return reply(user);
    if (path === '/api/v1/chat/models') return reply({ items: empty ? [] : groups });
    if (path === '/api/v1/chat/conversations') {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        conversation = { ...conversation, groupId: body.groupId, modelId: body.modelId };
        return reply(conversation);
      }
      return reply({ items: [], nextCursor: null });
    }
    if (path === '/api/v1/chat/conversations/desktop-conversation')
      return reply({ conversation, messages });
    if (path === '/api/v1/chat/conversations/desktop-conversation/messages') {
      const body = route.request().postDataJSON();
      sent.push(body);
      const base = {
        conversationId: conversation.id,
        turnIndex: 0,
        status: 'completed',
        variant: 1,
        selected: true,
        groupId: body.groupId,
        modelId: body.modelId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const prompt = {
        ...base,
        id: 'desktop-prompt',
        role: 'user',
        content: body.content,
        requestId: null,
      };
      const answer = {
        ...base,
        id: 'desktop-answer',
        role: 'assistant',
        content: '这是桌面测试回答。',
        requestId: 'desktop-request',
      };
      messages = [prompt, answer];
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          `event: meta\ndata: ${JSON.stringify({ conversation, userMessage: prompt, assistantMessage: { ...answer, status: 'generating', content: '' } })}\n\n` +
          `event: delta\ndata: ${JSON.stringify({ text: answer.content })}\n\n` +
          `event: done\ndata: ${JSON.stringify({ message: answer, billingStatus: 'settled' })}\n\n`,
      });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  return {
    sent,
    enableModels: () => {
      empty = false;
    },
  };
}

test('desktop sidebar toggles preserve drafts and textarea height is bounded', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await fixture(page);
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await expect(page.getByRole('heading', { name: '有什么想聊的？' })).toBeVisible();
  await input.fill('保留这段草稿');
  await expect(input).toBeFocused();
  expect(api.sent).toHaveLength(0);
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await expect(page.getByRole('complementary', { name: '聊天记录' })).toBeHidden();
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await expect(input).toHaveValue('保留这段草稿');
  await input.fill('一行很长的草稿\n'.repeat(40));
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(200);
  await expect.poll(() => input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await input.fill('短消息');
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThan(100);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '聊天记录' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('desktop model search preserves group identity, shows effective prices, and sends with the selected pair', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const api = await fixture(page);
  await page.goto('/chat');
  const trigger = page.getByRole('button', { name: '切换模型', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '选择模型', exact: true });
  await expect(dialog.getByRole('textbox', { name: '搜索模型' })).toBeFocused();
  await dialog.getByRole('textbox', { name: '搜索模型' }).fill('不存在的模型');
  await expect(dialog.getByRole('status')).toHaveText('没有匹配的模型，试试其他关键词。');
  await dialog.getByRole('textbox', { name: '搜索模型' }).fill('优惠组');
  const choice = dialog.getByRole('button', { name: /flagship-pro 优惠组/ });
  await expect(choice).toContainText('读 $0.5/m');
  await expect(choice).toContainText('写 $2/m');
  await choice.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('优惠组');
  await page.getByRole('textbox', { name: '消息内容' }).fill('选择优惠组发送');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('log', { name: '对话消息' })).toContainText('这是桌面测试回答。');
  expect(api.sent).toHaveLength(1);
  expect(api.sent[0]).toMatchObject({
    groupId: 'value',
    modelId: 'flagship-pro',
    content: '选择优惠组发送',
  });
  await expect(page.getByRole('heading', { name: '有什么想聊的？' })).toHaveCount(0);
  const composer = await page.getByRole('form', { name: '发送消息' }).boundingBox();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(720);
  expect(composer!.height).toBeLessThan(220);
});

test('missing models have a single recovery prompt and refresh enables sending without losing the draft', async ({
  page,
}) => {
  const api = await fixture(page, true);
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('先保存我的问题');
  await expect(
    page.getByText('暂无可用模型，请联系管理员开通模型权限。', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  api.enableModels();
  await page.getByRole('button', { name: '刷新模型' }).click();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('先保存我的问题');
});

test('model popover stays anchored and supports keyboard and outside dismissal', async ({
  page,
}) => {
  await fixture(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/chat');
    const input = page.getByRole('textbox', { name: '消息内容' });
    await input.fill('保留浮层外的草稿');
    const trigger = page.getByRole('button', { name: '切换模型', exact: true });
    const popover = page.getByRole('dialog', { name: '选择模型', exact: true });
    await trigger.click();
    const search = popover.getByRole('textbox', { name: '搜索模型' });
    await expect(search).toBeFocused();
    const firstOption = popover.getByRole('button').first();
    expect((await firstOption.boundingBox())!.height).toBeLessThanOrEqual(44);
    await expect(firstOption.locator('.chat-model-icon-slot')).toBeVisible();
    expect(await popover.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const panel = (await popover.boundingBox())!;
    const anchor = (await trigger.boundingBox())!;
    expect(panel.width).toBeLessThanOrEqual(440);
    expect(panel.x).toBeGreaterThanOrEqual(11);
    expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width - 11);
    expect(panel.y).toBeGreaterThanOrEqual(11);
    expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height - 11);
    expect(Math.abs(panel.y + panel.height - (anchor.y - 8))).toBeLessThan(2);
    await search.press('ArrowDown');
    await expect(popover.getByRole('button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await search.fill('优惠组');
    await page.mouse.click(viewport.width - 16, viewport.height - 16);
    await expect(popover).toBeHidden();
    await expect(input).toHaveValue('保留浮层外的草稿');
    await trigger.click();
    await expect(search).toHaveValue('');
    await trigger.click();
    await expect(popover).toBeHidden();
  }
});
