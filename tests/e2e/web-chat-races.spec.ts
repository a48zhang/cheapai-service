import { test, expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Connection = { baseURL: string; token: string; adminEmail: string; adminPassword: string };
type Fixture = { info: Connection; admin: APIRequestContext; userContext: BrowserContext; page: Page; userApi: APIRequestContext; userCsrf: string; modelId: string };
type PlaywrightHarness = { request: { newContext(options: any): Promise<APIRequestContext> } };
type BrowserHarness = { newContext(options: any): Promise<BrowserContext> };

const answer = 'Local fixture answer';
const fixtureBaseUrl = 'https://e2e-upstream.example.invalid/v1';

function readConnection(): Connection {
  return JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`), 'utf8')) as Connection;
}

async function json(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<any> {
  try { return await response.json(); } catch { return null; }
}

function originHeaders(info: Connection, csrf: string): Record<string, string> {
  return { Origin: info.baseURL, 'X-CSRF-Token': csrf };
}

async function login(context: APIRequestContext, info: Connection, email: string, password: string): Promise<string> {
  const bootstrap = await context.get('/api/v1/settings/public');
  expect(bootstrap.status(), await bootstrap.text()).toBe(200);
  const csrf = (await json(bootstrap)).data.csrfToken as string;
  const result = await context.post('/api/v1/auth/login', { headers: originHeaders(info, csrf), data: { email, password } });
  expect(result.status(), await result.text()).toBe(200);
  return csrf;
}

async function create(context: APIRequestContext, path: string, data: unknown, headers: Record<string, string>, status = 201): Promise<any> {
  const response = await context.post(path, { headers, data });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(status);
  return (await json(response)).data;
}

async function controlCalls(admin: APIRequestContext, info: Connection): Promise<any[]> {
  const response = await admin.get('/__test__/calls', { headers: { 'X-E2E-Control': info.token } });
  expect(response.status()).toBe(200);
  return (await json(response)).calls as any[];
}

async function balance(context: APIRequestContext): Promise<bigint> {
  const response = await context.get('/api/v1/account/balance');
  expect(response.status()).toBe(200);
  return BigInt((await json(response)).data.balance_units);
}

async function prepareUser(playwright: PlaywrightHarness, browser: BrowserHarness): Promise<Fixture> {
  // This wrapper is replaced below by the test's browser fixture. Keeping all
  // account/channel setup in this file prevents the race cases from depending
  // on the larger acceptance test's state.
  const info = readConnection();
  const admin = await playwright.request.newContext({ baseURL: info.baseURL, ignoreHTTPSErrors: true });
  const adminCsrf = await login(admin, info, info.adminEmail, info.adminPassword);
  const headers = { ...originHeaders(info, adminCsrf), 'Content-Type': 'application/json' };
  const tag = randomUUID().slice(0, 8);
  const modelId = `web-chat-race-${tag}`;
  const channel = await create(admin, '/api/v1/admin/channels', {
    name: `Web chat race ${tag}`, baseUrl: fixtureBaseUrl, upstreamKey: 'local-fixture-upstream-key',
    concurrencyLimit: 2, rpmLimit: 60, priority: 10, status: 'active',
  }, headers);
  await create(admin, '/api/v1/admin/models', {
    publicModelId: modelId, status: 'active', sellPrices: { input: '1', output: '1' },
    admissionMinBalanceUnits: '0', maxOutputTokens: 64,
  }, headers);
  await create(admin, `/api/v1/admin/models/${encodeURIComponent(modelId)}/mappings`, {
    channelId: channel.id, protocol: 'chat', upstreamModel: `race-upstream-${tag}`,
    capabilities: { protocol: 'chat', features: ['streaming', 'stream_usage'], maxOutputTokens: 64 },
  }, headers);
  const group = await create(admin, '/api/v1/admin/groups', {
    name: `Web chat race ${tag}`, status: 'active', channelIds: [channel.id], billingMultiplier: '1',
  }, headers);
  const email = `web-chat-race-${tag}@example.invalid`;
  const user = await create(admin, '/api/v1/admin/users', { email, password: 'local-web-chat-race-password', groupId: group.id }, headers);
  const adjustment = await admin.post(`/api/v1/admin/users/${user.id}/balance-adjustments`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { kind: 'grant', deltaUnits: '10000000', reason: 'local web chat race fixture' },
  });
  expect(adjustment.status(), await adjustment.text()).toBe(201);
  const userContext = await browser.newContext({ baseURL: info.baseURL, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const userApi = userContext.request;
  const userCsrf = await login(userApi, info, email, 'local-web-chat-race-password');
  const page = await userContext.newPage();
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '消息内容', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息内容', exact: true })).toBeEnabled();
  return { info, admin, userContext, page, userApi, userCsrf, modelId };
}

test('coalesces rapid sends while the initial conversation create is delayed', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const fixture = await prepareUser(playwright, browser);
  try {
    const before = (await controlCalls(fixture.admin, fixture.info)).length;
    let createRequests = 0;
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
    await fixture.page.route('**/api/v1/chat/conversations', async route => {
      const request = route.request();
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/v1/chat/conversations') return route.continue();
      createRequests += 1;
      await createGate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    const textbox = fixture.page.getByRole('textbox', { name: '消息内容', exact: true });
    await textbox.fill('rapid create race');
    await textbox.press('Enter');
    await textbox.press('Enter');
    await expect.poll(() => createRequests).toBe(1);
    releaseCreate();
    await expect(fixture.page).toHaveURL(/\/chat\/[^/]+$/);
    await expect(fixture.page.locator('main')).toContainText(answer);
    expect(createRequests).toBe(1);
    const after = await controlCalls(fixture.admin, fixture.info);
    expect(after.slice(before)).toHaveLength(1);
  } finally {
    await fixture.page.close();
    await fixture.userContext.close();
    await fixture.admin.dispose();
  }
});

test('retries a response-loss operation with the same operation ID and one charge', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const fixture = await prepareUser(playwright, browser);
  try {
    const beforeCalls = (await controlCalls(fixture.admin, fixture.info)).length;
    const beforeBalance = await balance(fixture.userApi);
    let sendRequests = 0;
    const operationIds: string[] = [];
    await fixture.page.route('**/api/v1/chat/conversations/*/messages', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      sendRequests += 1;
      const payload = route.request().postDataJSON() as { operationId?: string };
      if (typeof payload.operationId === 'string') operationIds.push(payload.operationId);
      if (sendRequests === 1) {
        const response = await route.fetch();
        await response.body();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    const textbox = fixture.page.getByRole('textbox', { name: '消息内容', exact: true });
    await textbox.fill('response loss should replay');
    await textbox.press('Enter');
    await expect.poll(() => sendRequests).toBe(1);
    await expect(fixture.page.getByRole('button', { name: '重试确认', exact: true })).toBeVisible();
    await fixture.page.getByRole('button', { name: '重试确认', exact: true }).click();
    await expect.poll(() => sendRequests).toBe(2);
    await expect(fixture.page.locator('main')).toContainText(answer);
    expect(new Set(operationIds).size).toBe(1);
    const calls = await controlCalls(fixture.admin, fixture.info);
    expect(calls.slice(beforeCalls)).toHaveLength(1);
    expect(beforeBalance - await balance(fixture.userApi)).toBe(1500n);
    const ledger = await fixture.userApi.get('/api/v1/billing/entries?kind=consumption&limit=100');
    expect(ledger.status()).toBe(200);
    expect((await json(ledger)).data.items).toHaveLength(1);
  } finally {
    await fixture.page.close();
    await fixture.userContext.close();
    await fixture.admin.dispose();
  }
});
