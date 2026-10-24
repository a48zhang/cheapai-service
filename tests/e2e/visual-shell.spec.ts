import { expect, test, type Page } from '@playwright/test';

// Isolated browser fixtures only. No demo data is included in application code.
async function fixture(page: Page) {
  const now = 1_700_000_000_000;
  const conversations = ['A', 'B'].map((id) => ({
    id,
    title: `对话 ${id}`,
    groupId: 'standard',
    modelId: 'test-model',
    version: 1,
    createdAt: now,
    updatedAt: now,
  }));
  const writes: string[] = [];
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    const reply = (data: unknown) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data, request_id: 'visual-test' }),
      });
    if (path === '/api/v1/auth/me')
      return reply({
        id: 'visual-user',
        email_normalized: 'visual@example.invalid',
        role: 'user',
        status: 'active',
        group_id: 'standard',
        group_status: 'active',
        balance_units: '1000000',
        email_verified_at: null,
      });
    if (path === '/api/v1/chat/models')
      return reply({
        items: [
          {
            id: 'standard',
            name: '标准组',
            billingMultiplier: '1',
            models: [{ publicModelId: 'test-model' }, { publicModelId: 'second-model' }],
          },
        ],
      });
    if (path === '/api/v1/chat/conversations')
      return reply({ items: conversations, nextCursor: null });
    const conversation = conversations.find(
      (item) => path === `/api/v1/chat/conversations/${item.id}`,
    );
    if (conversation)
      return reply({
        conversation,
        messages: [
          { id: `${conversation.id}-user`, role: 'user', content: '请给出一个简短的代码示例。' },
          {
            id: `${conversation.id}-assistant`,
            role: 'assistant',
            content: `### 对话 ${conversation.id}\n\n使用标准 Markdown 展示回答。\n\n\`\`\`typescript\nconst message = "Hello";\nconsole.log(message);\n\`\`\`\n\n| 项目 | 状态 |\n| --- | --- |\n| 示例 | 完成 |`,
          },
        ].map((message) => ({
          ...message,
          conversationId: conversation.id,
          turnIndex: 0,
          status: 'completed',
          variant: 1,
          selected: true,
          requestId: null,
          groupId: conversation.groupId,
          modelId: conversation.modelId,
          createdAt: now,
          updatedAt: now,
        })),
      });
    return route.fulfill({ status: 404, body: '{}' });
  });
  return writes;
}

for (const width of [1440, 375])
  test(`shared chat shell navigation and dismissal at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    const writes = await fixture(page);
    await page.goto('/chat/A');
    const input = page.getByRole('textbox', { name: '消息内容' });
    await input.fill('留在对话 A 的草稿');
    const openSidebar = async () => {
      if (width === 375) await page.getByRole('button', { name: '打开聊天记录' }).click();
    };
    await openSidebar();
    const history = page.getByRole('navigation', { name: '历史对话' });
    await history.getByRole('button', { name: '对话 B', exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/B$/);
    await expect(page.getByRole('log')).toContainText('对话 B');
    if (width === 375) await expect(page.getByRole('dialog', { name: '聊天记录' })).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(/\/chat\/A$/);
    await expect(input).toHaveValue('留在对话 A 的草稿');
    await page.goForward();
    await expect(page).toHaveURL(/\/chat\/B$/);
    await expect(input).toHaveValue('');
    await openSidebar();
    await history.getByRole('button', { name: '对话操作：对话 B' }).click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '删除对话' })).toBeHidden();
    await history.getByRole('button', { name: '对话操作：对话 B' }).click();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await page.getByRole('textbox', { name: '重命名对话：对话 B' }).fill('取消此修改');
    await page.getByRole('button', { name: '取消重命名' }).click();
    if (width === 375) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: '聊天记录' })).toBeHidden();
    }
    await page.getByRole('button', { name: '切换模型', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索模型' }).fill('second');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '选择模型' })).toBeHidden();
    await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('chat-light.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: testInfo.outputPath('chat-dark.png'), animations: 'disabled' });
  });

for (const width of [1440, 375]) {
  for (const { route, label, target } of [
    { route: '/chat/A', label: '跳到对话内容', target: '#chat-content' },
    { route: '/keys', label: '跳到主要内容', target: '#main-content' },
  ]) {
    test(`skip link is first and focuses content on ${route} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await fixture(page);
      await page.goto(route);
      const main = page.locator(target);
      await expect(main).toBeVisible();
      const bounds = await main.boundingBox();
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: label, exact: true });
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      // Revealing the shortcut must not displace the grid or its content.
      expect(await main.boundingBox()).toEqual(bounds);
      await page.keyboard.press('Enter');
      await expect(main).toBeFocused();
    });
  }
}
