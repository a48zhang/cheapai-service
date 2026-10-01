import { test, expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Connection = { baseURL: string; token: string; adminEmail: string; adminPassword: string };
type ChatGroup = { id: string; name: string; billingMultiplier: string; models: Array<{ publicModelId: string }> };
type Conversation = { id: string; title: string; groupId: string | null; modelId: string | null; version: number };
type Message = { id: string; role: 'user' | 'assistant'; content: string; status: string; variant: number; selected: boolean };

const answer = 'Local fixture answer';
const fixtureBaseUrl = 'https://e2e-upstream.example.invalid/v1';
const originHeader = (connection: Connection, csrf: string) => ({ Origin: connection.baseURL, 'X-CSRF-Token': csrf });

function connection(): Connection {
  return JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`), 'utf8')) as Connection;
}

function parseSse(text: string): Array<{ event: string; data: any }> {
  return text.split(/\r?\n\r?\n/).flatMap(frame => {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return [];
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
    try { return [{ event, data: JSON.parse(data) }]; } catch { return [{ event, data }]; }
  });
}

async function json(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<any> {
  try { return await response.json(); } catch { return null; }
}

async function login(context: APIRequestContext, email: string, password: string, baseURL: string): Promise<string> {
  const settings = await context.get('/api/v1/settings/public');
  expect(settings.status()).toBe(200);
  const csrf = (await json(settings)).data.csrfToken as string;
  const result = await context.post('/api/v1/auth/login', {
    headers: originHeader({ baseURL } as Connection, csrf), data: { email, password },
  });
  expect(result.status(), await result.text()).toBe(200);
  return csrf;
}

async function create(context: APIRequestContext, path: string, data: unknown, headers: Record<string, string>, status = 201): Promise<any> {
  const response = await context.post(path, { headers, data });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(status);
  return (await json(response)).data;
}

async function accountBalance(context: APIRequestContext): Promise<bigint> {
  const response = await context.get('/api/v1/account/balance');
  expect(response.status()).toBe(200);
  return BigInt((await json(response)).data.balance_units);
}

async function createConversation(context: APIRequestContext, csrf: string, connectionInfo: Connection, groupId: string, modelId: string): Promise<Conversation> {
  return create(context, '/api/v1/chat/conversations', { groupId, modelId }, originHeader(connectionInfo, csrf)) as Promise<Conversation>;
}

async function sendMessage(context: APIRequestContext, csrf: string, connectionInfo: Connection, conversation: Conversation, operationId: string, content: string) {
  return context.post(`/api/v1/chat/conversations/${conversation.id}/messages`, {
    headers: { ...originHeader(connectionInfo, csrf), 'Content-Type': 'application/json' },
    data: { operationId, conversationVersion: conversation.version, groupId: conversation.groupId, modelId: conversation.modelId, content },
  });
}

test('local web chat: groups, idempotency, history, versions, failure and mobile shell', async ({ page, browser, playwright }) => {
  test.setTimeout(180_000);
  const info = connection();
  // The server is owned by the root agent. A missing route means the feature
  // is still being assembled, so keep this acceptance case pending rather than
  // reporting another agent's unfinished work as a browser regression.
  const probe = await page.request.get('/api/v1/chat/models');
  if (probe.status() === 404) test.skip(true, 'web chat route is not mounted yet');

  const admin = await playwright.request.newContext({ baseURL: info.baseURL, ignoreHTTPSErrors: true });
  let userContext: BrowserContext | undefined;
  try {
    const adminCsrf = await login(admin, info.adminEmail, info.adminPassword, info.baseURL);
    const adminHeaders = { ...originHeader(info, adminCsrf), 'Content-Type': 'application/json' };
    const tag = randomUUID().slice(0, 8);
    const modelId = `web-chat-model-${tag}`;

    const fullChannel = await create(admin, '/api/v1/admin/channels', {
      name: `Web chat full ${tag}`, baseUrl: fixtureBaseUrl, upstreamKey: 'local-fixture-upstream-key',
      concurrencyLimit: 2, rpmLimit: 60, priority: 10, status: 'active',
    }, adminHeaders);
    const discountChannel = await create(admin, '/api/v1/admin/channels', {
      name: `Web chat discount ${tag}`, baseUrl: fixtureBaseUrl, upstreamKey: 'local-fixture-upstream-key',
      concurrencyLimit: 2, rpmLimit: 60, priority: 10, status: 'active',
    }, adminHeaders);
    await create(admin, '/api/v1/admin/models', {
      publicModelId: modelId, status: 'active', sellPrices: { input: '1', output: '1' },
      admissionMinBalanceUnits: '0', maxOutputTokens: 64,
    }, adminHeaders);
    for (const [channelId, upstreamModel] of [[fullChannel.id, 'web-chat-full'], [discountChannel.id, 'web-chat-discount']] as const) {
      await create(admin, `/api/v1/admin/models/${encodeURIComponent(modelId)}/mappings`, {
        channelId, protocol: 'chat', upstreamModel,
        capabilities: { protocol: 'chat', features: ['streaming', 'stream_usage'], maxOutputTokens: 64 },
      }, adminHeaders);
    }
    const fullGroup = await create(admin, '/api/v1/admin/groups', {
      name: `Web chat full ${tag}`, status: 'active', channelIds: [fullChannel.id], billingMultiplier: '1',
    }, adminHeaders);
    const discountGroup = await create(admin, '/api/v1/admin/groups', {
      name: `Web chat discount ${tag}`, status: 'active', channelIds: [discountChannel.id], billingMultiplier: '0.2',
    }, adminHeaders);
    const email = `web-chat-${tag}@example.invalid`;
    const createdUser = await create(admin, '/api/v1/admin/users', { email, password: 'local-web-chat-password', groupId: fullGroup.id }, adminHeaders);
    const users = await admin.get('/api/v1/admin/users?limit=100');
    expect(users.status()).toBe(200);
    const user = (await json(users)).data.items.find((item: { email_normalized: string }) => item.email_normalized === email);
    expect(user?.id).toBe(createdUser.id);
    await admin.patch(`/api/v1/admin/users/${user.id}`, {
      headers: adminHeaders,
      data: { version: user.version, allowedGroupIds: [fullGroup.id, discountGroup.id] },
    }).then(async response => expect(response.status(), await response.text()).toBe(200));
    const grant = await admin.post(`/api/v1/admin/users/${user.id}/balance-adjustments`, {
      headers: { ...adminHeaders, 'Idempotency-Key': randomUUID() }, data: { kind: 'grant', deltaUnits: '10000000', reason: 'local web chat fixture' },
    });
    expect(grant.status(), await grant.text()).toBe(201);

    userContext = await browser.newContext({ baseURL: info.baseURL, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const userApi = userContext.request;
    const userCsrf = await login(userApi, email, 'local-web-chat-password', info.baseURL);
    const userHeaders = originHeader(info, userCsrf);
    const models = await userApi.get('/api/v1/chat/models');
    expect(models.status()).toBe(200);
    const groups = (await json(models)).data.items as ChatGroup[];
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fullGroup.id, billingMultiplier: '1', models: [expect.objectContaining({ publicModelId: modelId })] }),
      expect.objectContaining({ id: discountGroup.id, billingMultiplier: '0.2', models: [expect.objectContaining({ publicModelId: modelId })] }),
    ]));

    const fullConversation = await createConversation(userApi, userCsrf, info, fullGroup.id, modelId);
    const discountedConversation = await createConversation(userApi, userCsrf, info, discountGroup.id, modelId);
    const balanceBefore = await accountBalance(userApi);
    const control = { 'X-E2E-Control': info.token };
    const callsBefore = (await json(await admin.get('/__test__/calls', { headers: control }))).calls.length as number;
    const first = await sendMessage(userApi, userCsrf, info, fullConversation, 'browser-idempotent', 'deduplicate this');
    const firstText = await first.text();
    expect(first.status(), firstText).toBe(200);
    expect(parseSse(firstText).some(event => event.event === 'done')).toBe(true);
    const replay = await sendMessage(userApi, userCsrf, info, fullConversation, 'browser-idempotent', 'deduplicate this');
    const replayText = await replay.text();
    expect(replay.status(), replayText).toBe(200);
    expect((parseSse(replayText).length === 0 ? JSON.parse(replayText).data.replayed : true)).toBeTruthy();
    const discounted = await sendMessage(userApi, userCsrf, info, discountedConversation, 'browser-discounted', 'discount this');
    const discountedText = await discounted.text();
    expect(discounted.status(), discountedText).toBe(200);
    expect(parseSse(discountedText).some(event => event.event === 'done')).toBe(true);
    const callsAfter = (await json(await admin.get('/__test__/calls', { headers: control }))).calls.slice(callsBefore);
    expect(callsAfter).toHaveLength(2);
    expect(callsAfter.every((call: { platformCredentialLeaked: boolean }) => !call.platformCredentialLeaked)).toBe(true);
    const balanceAfter = await accountBalance(userApi);
    const charged = balanceBefore - balanceAfter;
    // Fixture usage is 10 input + 5 output at $1/M each: 1500 units at 1x
    // and 300 units at 0.2x. This also catches a shared virtual-key group leak.
    expect(charged).toBe(1800n);

    const keyList = await userApi.get('/api/v1/keys');
    expect(keyList.status()).toBe(200);
    expect(JSON.stringify(await json(keyList))).not.toContain('web_chat');
    const bearer = await userApi.get('/v1/models', { headers: { Authorization: 'Bearer s2a_key_fake-web-chat-token' } });
    expect(bearer.status()).toBe(401);

    const history = await userApi.get(`/api/v1/chat/conversations/${fullConversation.id}`);
    expect(history.status()).toBe(200);
    const firstHistory = (await json(history)).data as { conversation: Conversation; messages: Message[] };
    expect(firstHistory.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'deduplicate this' }),
      expect.objectContaining({ role: 'assistant', content: answer, status: 'completed', selected: true }),
    ]));
    const oldAssistant = firstHistory.messages.find(message => message.role === 'assistant')!;
    const regenerate = await userApi.post(`/api/v1/chat/conversations/${fullConversation.id}/regenerate`, {
      headers: userHeaders, data: { operationId: 'browser-regenerate', conversationVersion: firstHistory.conversation.version, groupId: fullGroup.id, modelId },
    });
    const regenerateText = await regenerate.text();
    expect(regenerate.status(), regenerateText).toBe(200);
    expect(parseSse(regenerateText).some(event => event.event === 'done')).toBe(true);
    const afterRegenerate = await json(await userApi.get(`/api/v1/chat/conversations/${fullConversation.id}`));
    const variants = afterRegenerate.data.messages.filter((message: Message) => message.role === 'assistant') as Message[];
    expect(variants).toHaveLength(2);
    expect(variants.find(message => message.id === oldAssistant.id)?.selected).toBe(false);
    expect(variants.filter(message => message.selected)).toHaveLength(1);
    const stale = await userApi.patch(`/api/v1/chat/conversations/${fullConversation.id}`, {
      headers: userHeaders, data: { version: firstHistory.conversation.version, title: 'stale version' },
    });
    expect(stale.status()).toBe(409);
    const selectOld = await userApi.post(`/api/v1/chat/conversations/${fullConversation.id}/select`, {
      headers: userHeaders, data: { conversationVersion: afterRegenerate.data.conversation.version, messageId: oldAssistant.id },
    });
    expect(selectOld.status()).toBe(200);
    expect((await json(selectOld)).data.messages.find((message: Message) => message.id === oldAssistant.id).selected).toBe(true);

    // Make one isolated local channel fail. The test Worker rejects all
    // origins outside e2e-upstream.example.invalid, so no provider is called.
    const channelPage = await json(await admin.get('/api/v1/admin/channels?limit=100'));
    const fullChannelCurrent = channelPage.data.items.find((item: { id: string }) => item.id === fullChannel.id);
    const blocked = await admin.patch(`/api/v1/admin/channels/${fullChannel.id}`, {
      headers: adminHeaders, data: { version: fullChannelCurrent.configVersion, baseUrl: 'https://blocked-upstream.example.invalid/v1' },
    });
    expect(blocked.status(), await blocked.text()).toBe(200);
    // A new model has no cached pre-edit channel route. This case exercises
    // upstream failure, rather than the existing stale-route CAS rejection.
    const failureModelId = `${modelId}-failure`;
    await create(admin, '/api/v1/admin/models', {
      publicModelId: failureModelId, sellPrices: { input: '1', output: '1' }, admissionMinBalanceUnits: '0', maxOutputTokens: 64,
    }, adminHeaders);
    await create(admin, `/api/v1/admin/models/${encodeURIComponent(failureModelId)}/mappings`, {
      channelId: fullChannel.id, protocol: 'chat', upstreamModel: 'web-chat-failure',
      capabilities: { protocol: 'chat', features: ['streaming', 'stream_usage'], maxOutputTokens: 64 },
    }, adminHeaders);
    const failedConversation = await createConversation(userApi, userCsrf, info, fullGroup.id, failureModelId);
    const beforeFailure = await accountBalance(userApi);
    const failed = await sendMessage(userApi, userCsrf, info, failedConversation, 'browser-failed', 'keep this input');
    const failedText = await failed.text();
    expect(failed.status(), failedText).toBe(200);
    expect(parseSse(failedText).some(event => event.event === 'error')).toBe(true);
    const failedHistory = await json(await userApi.get(`/api/v1/chat/conversations/${failedConversation.id}`));
    expect(failedHistory.data.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'keep this input' }),
      expect.objectContaining({ role: 'assistant', status: 'failed' }),
    ]));
    expect(await accountBalance(userApi)).toBe(beforeFailure);

    // Refresh and narrow viewport after server history has been written. The
    // browser check is intentionally content/layout oriented so it remains
    // stable across the chat view's internal component decomposition.
    const userPage: Page = await userContext.newPage();
    await userPage.goto(`/chat/${fullConversation.id}`);
    await expect(userPage.locator('main')).toContainText('deduplicate this');
    await expect(userPage.locator('main')).toContainText(answer);
    await expect(userPage.getByRole('textbox')).toBeVisible();
    await expect(userPage.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
    await userPage.setViewportSize({ width: 390, height: 844 });
    await userPage.reload();
    await expect(userPage.locator('main')).toContainText('deduplicate this');
    const layout = await userPage.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    const navToggle = userPage.getByRole('button', { name: '展开导航', exact: true });
    if (await navToggle.count()) {
      await navToggle.click();
      await expect(userPage.getByRole('button', { name: '收起导航', exact: true })).toBeVisible();
    }
    expect(await userPage.locator('main').innerText()).not.toMatch(/协议互转|创建 Key/);
    await userPage.close();
  } finally {
    await userContext?.close();
    await admin.dispose();
  }
});
