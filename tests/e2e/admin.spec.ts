import { test, expect } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

interface Connection {
  baseURL: string;
  token: string;
  adminEmail: string;
  adminPassword: string;
}

interface PublicUser {
  id: string;
  email_normalized: string;
  role: 'user' | 'admin';
}

interface UserAdminView extends PublicUser {
  group_id: string;
  status: 'active' | 'disabled';
  concurrency_limit: number;
  rpm_limit: number;
  allowed_group_ids: string[];
}

interface GroupView {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  version: number;
  channelIds: string[];
}

let connection: Connection;
let administrator: APIRequestContext;
let csrf: string;

const suffix = randomUUID().slice(0, 8);
const channelName = `CheapAI browser channel ${suffix}`;
const modelId = `cheapai-browser-model-${suffix}`;
const userEmail = `cheapai-browser-user-${suffix}@example.invalid`;
const userPassword = 'cheapai-browser-user-password-2026';
const upstreamKey = 'cheapai-browser-upstream-fixture-secret';
const grantReason = `browser admin grant ${suffix}`;

test.beforeAll(async ({ playwright }) => {
  const port = process.env.SUB2API_E2E_PORT ?? '9789';
  connection = JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${port}.json`), 'utf8')) as Connection;
  administrator = await playwright.request.newContext({ baseURL: connection.baseURL, ignoreHTTPSErrors: true });
  const settings = await administrator.get('/api/v1/settings/public');
  expect(settings.status()).toBe(200);
  csrf = (await settings.json()).data.csrfToken as string;
  const login = await administrator.post('/api/v1/auth/login', {
    data: { email: connection.adminEmail, password: connection.adminPassword },
    headers: { Origin: connection.baseURL, 'X-CSRF-Token': csrf },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await administrator?.dispose();
});

async function loginThroughPage(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(connection.adminEmail);
  await page.getByLabel('密码').fill(connection.adminPassword);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(`${connection.baseURL}/`);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/billing(?:\?|$)/);
  await expect(page.getByRole('heading', { name: '费用', exact: true })).toBeVisible();
}

async function waitForEnabled(locator: Locator): Promise<void> {
  await expect.poll(async () => locator.isEnabled()).toBe(true);
}

async function chooseRadixOption(page: Page, control: Locator, optionName: string): Promise<void> {
  await control.click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
}

test('管理员配置资源、管理用户余额并调查异常请求', async ({ page }) => {
  test.setTimeout(180_000);
  await loginThroughPage(page);

  const adminIdentityResponse = await administrator.get('/api/v1/auth/me');
  expect(adminIdentityResponse.status()).toBe(200);
  const adminIdentity = (await adminIdentityResponse.json()).data as PublicUser;

  await page.goto('/admin/registration/settings');
  const registrationMode = page.getByRole('combobox', { name: '注册模式' });
  await chooseRadixOption(page, registrationMode, '开放注册');
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  const savedSettingsResponse = await administrator.get('/api/v1/admin/registration/settings');
  expect(savedSettingsResponse.status()).toBe(200);
  expect((await savedSettingsResponse.json()).data.registrationMode).toBe('open');

  await page.goto('/admin/channels');
  await page.getByRole('button', { name: '创建渠道' }).click();
  const channelDialog = page.getByRole('dialog');
  await channelDialog.getByRole('textbox', { name: '渠道名称' }).fill(channelName);
  await channelDialog.getByRole('textbox', { name: '上游 Base URL' }).fill('https://e2e-upstream.example.invalid');
  await channelDialog.getByRole('textbox', { name: '上游凭证' }).fill(upstreamKey);
  const concurrencyMode = channelDialog.getByRole('combobox', { name: '并发规则' });
  await chooseRadixOption(page, concurrencyMode, '设置上限');
  await channelDialog.getByRole('spinbutton', { name: '并发上限' }).fill('4');
  const rpmMode = channelDialog.getByRole('combobox', { name: 'RPM 规则' });
  await chooseRadixOption(page, rpmMode, '设置上限');
  await channelDialog.getByRole('spinbutton', { name: '每分钟请求上限' }).fill('120');
  await channelDialog.getByRole('spinbutton', { name: '调度优先级' }).fill('1');
  const channelCreateResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/admin/channels' && response.request().method() === 'POST');
  await channelDialog.getByRole('button', { name: '创建渠道' }).click();
  const channelCreateResponse = await channelCreateResponsePromise;
  expect(channelCreateResponse.status(), await channelCreateResponse.text()).toBe(201);
  const channel = (await channelCreateResponse.json()).data as { id: string };
  expect(channel.id).toMatch(/^[A-Za-z0-9-]{36}$/u);
  await expect(channelDialog).toHaveCount(0);
  const channelRow = page.getByRole('row').filter({ hasText: channelName });
  await expect(channelRow).toBeVisible();
  await expect(channelRow).toContainText('已配置');
  await expect(channelRow).not.toContainText(upstreamKey);

  await page.goto('/admin/models/actions/create');
  await expect(page.getByRole('heading', { name: '新增公开模型' })).toBeVisible();
  await page.getByRole('textbox', { name: '公开模型 ID' }).fill(modelId);
  await page.getByRole('textbox', { name: '最低余额门槛（USD 最小单位）' }).fill('0');
  await page.getByRole('textbox', { name: '最大输出 Token' }).fill('128');
  await page.getByRole('textbox', { name: /^输入 Token/ }).fill('1');
  await page.getByRole('textbox', { name: /^输出 Token/ }).fill('2');
  const modelCreateResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/admin/models' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '创建模型' }).click();
  const modelCreateResponse = await modelCreateResponsePromise;
  expect(modelCreateResponse.status(), await modelCreateResponse.text()).toBe(201);
  await expect(page.getByRole('heading', { name: modelId })).toBeVisible();

  const channelPicker = page.getByRole('button', { name: /关联渠道/ });
  await channelPicker.click();
  const pickerDialog = page.getByRole('dialog', { name: '选择渠道' });
  await waitForEnabled(pickerDialog.getByRole('checkbox', { name: new RegExp(channelName) }));
  await pickerDialog.getByRole('checkbox', { name: new RegExp(channelName) }).check();
  await pickerDialog.getByRole('button', { name: '应用选择' }).click();
  const protocol = page.getByRole('combobox', { name: '协议' });
  await chooseRadixOption(page, protocol, 'Chat Completions');
  await page.getByRole('textbox', { name: '上游模型名称' }).fill('fixture-chat-model');
  await page.getByRole('checkbox', { name: 'streaming' }).check();
  const mappingResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith(`/api/v1/admin/models/${encodeURIComponent(modelId)}/mappings`)
      && response.request().method() === 'POST');
  await page.getByRole('button', { name: '创建映射' }).click();
  const mappingResponse = await mappingResponsePromise;
  expect(mappingResponse.status(), await mappingResponse.text()).toBe(201);
  const createdMapping = page.getByRole('list', { name: '现有模型映射' })
    .getByRole('button').filter({ hasText: channel.id }).filter({ hasText: 'Chat Completions' }).filter({ hasText: 'fixture-chat-model' });
  await expect(createdMapping).toBeVisible();

  // The local fixture's default group is linked to the new channel so the
  // generated Key can reach this mapping. The Groups page is independently
  // migrated with its resource module; this setup uses the supported API CAS.
  const groupsResponse = await administrator.get('/api/v1/admin/groups?limit=100');
  expect(groupsResponse.status()).toBe(200);
  const groups = (await groupsResponse.json()).data.items as GroupView[];
  const defaultGroup = groups.find(group => group.id === 'default' && group.status === 'active');
  expect(defaultGroup).toBeTruthy();
  const groupUpdate = await administrator.patch(`/api/v1/admin/groups/${encodeURIComponent(defaultGroup!.id)}`, {
    headers: { Origin: connection.baseURL, 'X-CSRF-Token': csrf },
    data: { version: defaultGroup!.version, channelIds: [...new Set([...defaultGroup!.channelIds, channel.id])] },
  });
  expect(groupUpdate.status(), await groupUpdate.text()).toBe(200);

  // Point the configured channel at a synthetic host rejected by the local
  // Worker. The persisted request becomes a transport failure without a real
  // network call or upstream fixture traffic.
  await page.goto('/admin/channels');
  const editableChannelRow = page.getByRole('row').filter({ hasText: channelName });
  await editableChannelRow.getByRole('button', { name: '编辑' }).click();
  const channelEditDialog = page.getByRole('dialog');
  await channelEditDialog.getByRole('textbox', { name: '上游 Base URL' }).fill('https://e2e-failing-upstream.example.invalid');
  const channelUpdatePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/v1/admin/channels/${channel.id}` && response.request().method() === 'PATCH');
  await channelEditDialog.getByRole('button', { name: '保存更改' }).click();
  expect((await channelUpdatePromise).status()).toBe(200);
  await expect(channelEditDialog).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: channelName })).toContainText('e2e-failing-upstream.example.invalid');

  await page.goto('/admin/users');
  await page.getByRole('button', { name: '创建普通用户' }).click();
  const createUserDialog = page.getByRole('dialog');
  await createUserDialog.getByRole('textbox', { name: '邮箱' }).fill(userEmail);
  await createUserDialog.getByRole('textbox', { name: '初始密码' }).fill(userPassword);
  const userGroup = createUserDialog.getByRole('combobox', { name: '初始分组' });
  await waitForEnabled(userGroup);
  await chooseRadixOption(page, userGroup, defaultGroup!.name);
  const userCreateResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/admin/users' && response.request().method() === 'POST');
  await createUserDialog.getByRole('button', { name: '创建用户' }).click();
  const userCreateResponse = await userCreateResponsePromise;
  expect(userCreateResponse.status(), await userCreateResponse.text()).toBe(201);
  const createdUser = (await userCreateResponse.json()).data as PublicUser;
  expect(createdUser.email_normalized).toBe(userEmail);
  await expect(createUserDialog).toHaveCount(0);
  const createdUserRow = page.getByRole('row').filter({ hasText: userEmail });
  await expect(createdUserRow).toBeVisible();
  await expect(createdUserRow).toContainText('普通用户');

  await page.goto(`/admin/users/${encodeURIComponent(createdUser.id)}`);
  await expect(page.getByRole('heading', { name: userEmail })).toBeVisible();
  await page.getByRole('button', { name: '编辑访问设置' }).first().click();
  const editUserDialog = page.getByRole('dialog');
  await expect(editUserDialog.getByText('普通用户（只读）')).toBeVisible();
  await editUserDialog.getByRole('textbox', { name: '并发请求上限' }).fill('3');
  await editUserDialog.getByRole('textbox', { name: '每分钟请求上限' }).fill('90');
  const userUpdatePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/v1/admin/users/${createdUser.id}` && response.request().method() === 'PATCH');
  await editUserDialog.getByRole('button', { name: '保存用户设置' }).click();
  expect((await userUpdatePromise).status()).toBe(200);
  await expect(editUserDialog).toHaveCount(0);
  const updatedUserResponse = await administrator.get(`/api/v1/admin/users/${encodeURIComponent(createdUser.id)}`);
  expect(updatedUserResponse.status()).toBe(200);
  const updatedUser = (await updatedUserResponse.json()).data as UserAdminView;
  expect(updatedUser.concurrency_limit).toBe(3);
  expect(updatedUser.rpm_limit).toBe(90);
  expect(updatedUser.allowed_group_ids).toContain(defaultGroup!.id);

  await page.goto(`/admin/users/${encodeURIComponent(adminIdentity.id)}`);
  await page.getByRole('button', { name: '调整余额' }).click();
  const grantDialog = page.getByRole('dialog');
  await grantDialog.getByRole('textbox', { name: '金额（USD）' }).fill('1.00');
  await grantDialog.getByRole('textbox', { name: '调整原因' }).fill(grantReason);
  const grantResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/v1/admin/users/${adminIdentity.id}/balance-adjustments`
      && response.request().method() === 'POST');
  await grantDialog.getByRole('button', { name: '提交调整' }).click();
  const grantResponse = await grantResponsePromise;
  expect(grantResponse.status(), await grantResponse.text()).toBe(201);
  await expect(grantDialog.getByRole('status')).toBeVisible();
  await grantDialog.getByRole('button', { name: '关闭', exact: true }).click();
  const adminBalance = page.getByRole('term').filter({ hasText: /^余额$/u }).locator('xpath=following-sibling::dd');
  await expect(adminBalance).toHaveText('1.00000000 USD');

  await page.goto('/keys');
  await page.getByRole('button', { name: '创建 Key' }).click();
  const keyDialog = page.getByRole('dialog');
  await keyDialog.getByRole('textbox', { name: '名称' }).fill(`CheapAI gateway key ${suffix}`);
  await expect(keyDialog.locator('input[name="groupId"]')).toHaveValue(defaultGroup!.id);
  const keyCreateResponsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/v1/keys' && response.request().method() === 'POST');
  await keyDialog.getByRole('button', { name: '创建 Key' }).click();
  const keyCreateResponse = await keyCreateResponsePromise;
  expect(keyCreateResponse.status(), await keyCreateResponse.text()).toBe(201);
  const keySecret = page.getByLabel('完整 API Key');
  await expect(keySecret).toBeVisible();
  const platformKey = await keySecret.inputValue();
  expect(platformKey).toMatch(/^s2a_key_[A-Za-z0-9_-]{43}$/u);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(keySecret).toHaveCount(0);

  const gateway = await administrator.post('/v1/chat/completions', {
    headers: { Authorization: `Bearer ${platformKey}` },
    data: {
      model: modelId,
      messages: [{ role: 'user', content: 'CheapAI abnormal request fixture' }],
    },
  });
  expect(gateway.status()).toBe(502);
  const requestId = gateway.headers()['x-request-id'];
  expect(requestId).toMatch(/^[A-Za-z0-9-]{20,}$/u);
  expect((await gateway.json()).error).toBeDefined();

  await page.goto(`/admin/requests?model=${encodeURIComponent(modelId)}`);
  const requestRow = page.getByRole('row').filter({ hasText: modelId });
  await expect(requestRow).toBeVisible();
  await expect(requestRow).toContainText('失败');
  await expect(requestRow).toContainText('用量未知');
  const requestLink = requestRow.getByRole('link').first();
  await expect(requestLink).toHaveText(requestId!);
  await requestLink.click();
  await expect(page).toHaveURL(new RegExp(`/admin/requests/${requestId}`));
  await expect(page.getByRole('heading', { name: '请求详情' })).toBeVisible();
  await expect(page.getByText('upstream_error')).toBeVisible();
  await expect(page.getByText('用量未知')).toBeVisible();
  // Unknown usage is not eligible for a settlement retry.
  await expect(page.getByRole('button', { name: '重试结算' })).toHaveCount(0);

  await page.goto(`/admin/billing?userId=${encodeURIComponent(adminIdentity.id)}`);
  await expect(page.getByRole('heading', { name: '全局账单' })).toBeVisible();
  const grantBillingRow = page.getByRole('row').filter({ hasText: grantReason });
  await expect(grantBillingRow).toBeVisible();
  await expect(grantBillingRow).toContainText('管理员授额');
  await expect(grantBillingRow).toContainText('1.00000000 USD');

  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: '管理审计' })).toBeVisible();
  for (const action of ['registration.settings.update', 'channel.create', 'channel.update', 'model.create',
    'channel_model.create', 'group.update', 'user.create', 'user.update', 'balance.grant']) {
    await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: action, exact: true }) })).toBeVisible();
  }
  await expect(page.locator('body')).not.toContainText(upstreamKey);
  await expect(page.locator('body')).not.toContainText(platformKey);
});
