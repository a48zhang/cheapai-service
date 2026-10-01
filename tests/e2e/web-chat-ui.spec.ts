import { expect, test } from '@playwright/test';

const requestId = 'ui-request';
const user = {
  id: 'ui-user', email_normalized: 'ui@example.invalid', role: 'user', status: 'active', group_id: 'ui-group',
  group_status: 'active', balance_units: '1000000', email_verified_at: null,
};
const conversation = {
  id: 'conv-ui', title: '新对话', groupId: 'ui-group', modelId: 'ui-model', version: 1,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
};
const answer = {
  id: 'assistant-ui', conversationId: conversation.id, turnIndex: 0, role: 'assistant', content: 'UI answer',
  status: 'completed', variant: 1, selected: true, requestId: 'request-ui', groupId: 'ui-group', modelId: 'ui-model',
  createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
};
const prompt = {
  id: 'user-ui', conversationId: conversation.id, turnIndex: 0, role: 'user', content: 'double click prompt',
  status: 'completed', variant: 1, selected: true, requestId: null, groupId: 'ui-group', modelId: 'ui-model',
  createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
};

test('chat UI locks a new send before conversation creation and renders the stream', async ({ page }) => {
  const calls = { conversationCreates: 0, messagePosts: 0, operationIds: [] as string[], maxOutputTokens: [] as number[] };
  await page.context().addCookies([{ name: '__Host-sub2api_csrf', value: 'ui-csrf-token', url: 'https://127.0.0.1/' }]);
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: user, request_id: requestId }) }));
  await page.route('**/api/v1/chat/models', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { items: [{ id: 'ui-group', name: 'UI group', billingMultiplier: '1', models: [{ publicModelId: 'ui-model', maxOutputTokens: 64 }] }] }, request_id: requestId }),
  }));
  await page.route('**/api/v1/chat/conversations', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { items: [], nextCursor: null }, request_id: requestId }) });
      return;
    }
    calls.conversationCreates += 1;
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: conversation, request_id: requestId }) });
  });
  await page.route('**/api/v1/chat/conversations/conv-ui', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { conversation, messages: [prompt, answer] }, request_id: requestId }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: conversation, request_id: requestId }) });
  });
  await page.route('**/api/v1/chat/conversations/conv-ui/messages', async route => {
    calls.messagePosts += 1;
    const body = JSON.parse(route.request().postData() ?? '{}') as { operationId?: string; maxOutputTokens?: number };
    if (body.operationId) calls.operationIds.push(body.operationId);
    if (body.maxOutputTokens !== undefined) calls.maxOutputTokens.push(body.maxOutputTokens);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: [
        'event: meta\ndata: ' + JSON.stringify({ conversation, userMessage: prompt, assistantMessage: { ...answer, content: '', status: 'generating' } }) + '\n\n',
        'event: delta\ndata: {"text":"UI answer"}\n\n',
        'event: done\ndata: ' + JSON.stringify({ message: answer, billingStatus: 'settled' }) + '\n\n',
      ].join(''),
    });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: '消息内容' });
  await expect(composer).toBeVisible();
  await composer.fill('double click prompt');
  const send = page.getByRole('button', { name: '发送消息' });
  await Promise.all([send.click(), send.click()]);

  await expect(page.locator('main')).toContainText('UI answer');
  expect(calls.conversationCreates).toBe(1);
  expect(calls.messagePosts).toBe(1);
  expect(calls.operationIds).toHaveLength(1);
  expect(calls.maxOutputTokens).toEqual([64]);
});
