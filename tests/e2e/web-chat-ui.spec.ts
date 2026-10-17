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
  const calls = {conversationCreates: 0, messagePosts: 0, operationIds: [] as string[]};
  // Restored login sessions can outlive the CSRF cookie. The first write must bootstrap it.
  await page.route('**/api/v1/settings/public', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { registrationMode: 'open', emailVerificationEnabled: false,
      csrfToken: 'a'.repeat(42) + 'A' }, request_id: requestId }),
  }));
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: user, request_id: requestId }) }));
  await page.route('**/api/v1/chat/models', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { items: [{ id: 'ui-group', name: 'UI group', billingMultiplier: '1', models: [{publicModelId: 'ui-model'}] }] }, request_id: requestId }),
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
    expect(route.request().headers()['x-csrf-token']).toBe('a'.repeat(42) + 'A');
    const body = JSON.parse(route.request().postData() ?? '{}') as { operationId?: string };
    if (body.operationId) calls.operationIds.push(body.operationId);
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

  await page.goto('/chat');
  const composer = page.getByRole('textbox', { name: '消息内容' });
  await expect(composer).toBeVisible();
  await expect(page.getByRole('group', { name: '当前模型', exact: true })).toContainText('ui-model');
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveCount(0);
  await composer.fill('double click prompt');
  const send = page.getByRole('button', { name: '发送', exact: true });
  await send.evaluate(button => {
    const sendButton = button as HTMLButtonElement;
    sendButton.click();
    sendButton.click();
  });

  await expect(page.getByRole('log', { name: '对话消息' })).toContainText('UI answer');
  expect(calls.conversationCreates).toBe(1);
  expect(calls.messagePosts).toBe(1);
  expect(calls.operationIds).toHaveLength(1);
});

// FE-V01/02 use only browser mocks; no real provider or billing traffic.
async function mockedChat(page: import('@playwright/test').Page) {
  let identity = { ...user };
  let detail = { conversation: { ...conversation }, messages: [{ ...prompt }, { ...answer }] };
  await page.context().addCookies([{ name: '__Host-sub2api_csrf', value: 'ui-csrf-token', url: 'https://127.0.0.1/' }]);
  const fulfill = (route: import('@playwright/test').Route, data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data, request_id: requestId }) });
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/auth/me' || url.pathname === '/api/v1/auth/login') return fulfill(route, identity);
    if (url.pathname === '/api/v1/auth/logout') return fulfill(route, { loggedOut: true });
    if (url.pathname === '/api/v1/settings/public') return fulfill(route, { registrationMode: 'open', emailVerificationEnabled: false, csrfToken: 'a'.repeat(42) + 'A' });
    if (url.pathname === '/api/v1/chat/models') return fulfill(route, { items: [{ id: 'empty', name: 'Empty', billingMultiplier: '1', models: [] }, { id: 'ui-group', name: 'UI group', billingMultiplier: '1', models: [{publicModelId: 'ui-model'}] }] });
    if (url.pathname === '/api/v1/chat/conversations') return fulfill(route, route.request().method() === 'POST' ? detail.conversation : { items: [detail.conversation], nextCursor: null });
    if (url.pathname === `/api/v1/chat/conversations/${conversation.id}`) return fulfill(route, route.request().method() === 'DELETE' ? { deleted: true } : detail);
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'fixture route missing' }, request_id: requestId }) });
  });
  return { fulfill, setIdentity: (id: string) => { identity = { ...identity, id }; }, setDetail: (value: typeof detail) => { detail = value; } };
}
function sse(event: string, data: unknown): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

for (const sameAccount of [true, false]) test(`FE-V01 expired streaming session ${sameAccount ? 'restores same-owner draft' : 'isolates another account draft'}`, async ({ page }) => {
  const fixture = await mockedChat(page);
  await page.route('**/api/v1/chat/conversations/conv-ui/messages', route => route.fulfill({ status: 401, contentType: 'text/html', body: 'expired' }));
  await page.goto('/chat/conv-ui');
  const composer = page.getByRole('textbox', { name: '消息内容' });
  await expect(composer).toBeEnabled();
  await composer.fill('  restore this\nexact draft  ');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/login'
    && url.searchParams.get('returnTo') === '/chat/conv-ui');
  if (!sameAccount) fixture.setIdentity('different-user');
  await page.getByLabel('邮箱', { exact: true }).fill('ui@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/chat/conv-ui');
  await expect(composer).toHaveValue(sameAccount ? '  restore this\nexact draft  ' : '');
});

test('FE-V01 stores edits immediately and storage failure does not block composing', async ({ page }) => {
  await mockedChat(page);
  await page.goto('/chat');
  const composer = page.getByRole('textbox', { name: '消息内容' });
  await expect(composer).toBeEnabled();
  await composer.fill('unsent before reload');
  await page.reload();
  await expect(composer).toHaveValue('unsent before reload');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage denied'); }; });
  await composer.fill('still editable');
  await expect(composer).toHaveValue('still editable');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
});

for (const mode of ['success', 'rejected', 'failed-after-meta', 'stopped'] as const) test(`FE-V02 regenerate ${mode} keeps the correct selected variant`, async ({ page }) => {
  const fixture = await mockedChat(page);
  const replacement = { ...answer, id: 'regenerated', variant: 2, content: 'replacement result', status: mode === 'failed-after-meta' ? 'failed' : mode === 'stopped' ? 'stopped' : 'completed' };
  await page.route('**/api/v1/chat/conversations/conv-ui/regenerate', route => {
    if (mode === 'rejected') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'insufficient_balance', message: 'not enough' }, request_id: requestId }) });
    fixture.setDetail({ conversation: { ...conversation, version: 2 }, messages: [{ ...prompt }, { ...answer, selected: false }, replacement] });
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body:
      sse('meta', { conversation: { ...conversation, version: 2 }, userMessage: null, assistantMessage: { ...replacement, content: '', status: 'generating' } })
      + sse('delta', { text: replacement.content })
      + (mode === 'failed-after-meta' ? sse('error', { code: 'upstream_error', message: 'provider failed', messageId: replacement.id }) : sse('done', { message: replacement })) });
  });
  await page.goto('/chat/conv-ui');
  const messages = page.getByRole('log', { name: '对话消息' });
  await expect(messages.getByText('UI answer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新回答', exact: true }).click();
  await expect(messages.getByText(mode === 'rejected' ? 'UI answer' : 'replacement result', { exact: true })).toBeVisible();
  if (mode !== 'rejected') await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeEnabled();
});

test('FE-V02 unknown regenerate retries reuse identity, successful new generation uses another identity', async ({ page }) => {
  const fixture = await mockedChat(page);
  const ids: string[] = [];
  let version = conversation.version;
  let variants = [{ ...answer }];
  await page.route('**/api/v1/chat/conversations/conv-ui/regenerate', async route => {
    ids.push(route.request().postDataJSON().operationId);
    if (ids.length === 1) return route.abort('failed');
    version += 1;
    const replacement = { ...answer, id: `answer-${ids.length}`, variant: variants.length + 1, selected: true, content: `result ${ids.length}` };
    variants = [...variants.map(variant => ({ ...variant, selected: false })), replacement];
    const detail = { conversation: { ...conversation, version }, messages: [{ ...prompt }, ...variants] };
    fixture.setDetail(detail);
    return fixture.fulfill(route, { ...detail, replayed: true });
  });
  await page.goto('/chat/conv-ui');
  await page.getByRole('button', { name: '重新回答', exact: true }).click();
  await page.getByRole('button', { name: '确认结果', exact: true }).click();
  const messages = page.getByRole('log', { name: '对话消息' });
  await expect(messages.getByText('result 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新回答', exact: true }).click();
  await expect(messages.getByText('result 3', { exact: true })).toBeVisible();
  expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[1]);
});

test('FE-V02 history automatically appends deduplicated pages and retries the same failed cursor', async ({ page }) => {
  const fixture = await mockedChat(page);
  const cursors: (string | null)[] = [];
  let fail = true;
  const second = { ...conversation, id: 'second', title: 'Second conversation', updatedAt: conversation.updatedAt - 1, createdAt: conversation.createdAt - 1 };
  await page.route('**/api/v1/chat/conversations?*', route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor'); cursors.push(cursor);
    if (fail) { fail = false; return route.fulfill({ status: 503, body: 'temporary' }); }
    return fixture.fulfill(route, { items: [conversation, second], nextCursor: null });
  });
  await page.route('**/api/v1/chat/conversations', route => fixture.fulfill(route, {
    items: [conversation], nextCursor: route.request().method() === 'GET' ? 'page-two' : null,
  }));
  await page.goto('/chat');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  const history = page.getByRole('navigation', { name: '历史对话' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
  expect(cursors).toEqual(['page-two', 'page-two']);
});

test('FE-V02 history first-page failure is distinct from empty and supports retry', async ({ page }) => {
  const fixture = await mockedChat(page);
  let calls = 0;
  await page.route('**/api/v1/chat/conversations', route => ++calls === 1 ? route.fulfill({ status: 503, body: 'temporary' }) : fixture.fulfill(route, { items: [], nextCursor: null }));
  await page.goto('/chat');
  await expect(page.getByText('还没有对话', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('还没有对话', { exact: true })).toBeVisible();
});

test('chat displays rejection details and sends again with the refreshed conversation version', async ({ page }) => {
  const fixture = await mockedChat(page);
  const versions: number[] = [];
  const failed = { ...answer, id: 'failed-answer', turnIndex: 1, content: '', status: 'failed' };
  const nextPrompt = { ...prompt, id: 'next-prompt', turnIndex: 1, content: 'first attempt' };
  await page.route('**/api/v1/chat/conversations/conv-ui/messages', async route => {
    versions.push(route.request().postDataJSON().conversationVersion);
    if (versions.length === 1) {
      fixture.setDetail({ conversation: { ...conversation, version: 2 }, messages: [prompt, answer, nextPrompt, failed] });
      return route.fulfill({ status: 400, contentType: 'application/json',
        headers: { 'X-Request-Id': 'rejected-chat-request' },
        body: JSON.stringify({ error: { code: 'invalid_request', message: 'No eligible channel' } }) });
    }
    const completed = { ...answer, id: 'recovered-answer', turnIndex: 2, content: 'Recovered after rejection' };
    const latest = { conversation: { ...conversation, version: 3 }, messages: [prompt, answer, nextPrompt, failed, completed] };
    fixture.setDetail(latest);
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body:
      sse('meta', { conversation: latest.conversation, userMessage: null, assistantMessage: { ...completed, status: 'generating', content: '' } })
      + sse('done', { message: completed }) });
  });
  await page.goto('/chat/conv-ui');
  const composer = page.getByRole('textbox', { name: '消息内容' });
  await composer.fill('first attempt');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const notice = page.getByRole('alert').filter({ hasText: '消息未能发送' });
  await expect(notice).toContainText('No eligible channel');
  await notice.getByText('查看请求信息', { exact: true }).click();
  await expect(notice.getByText('rejected-chat-request', { exact: true })).toBeVisible();
  await composer.fill('next attempt');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('log', { name: '对话消息' })).toContainText('Recovered after rejection');
  expect(versions).toEqual([1, 2]);
});
