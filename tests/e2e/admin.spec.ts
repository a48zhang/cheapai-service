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

let connection: Connection;
let administrator: APIRequestContext;
let csrf: string;

const suffix = randomUUID().slice(0, 8);
const channelName = `Q11 browser channel ${suffix}`;
const modelId = `q11-browser-model-${suffix}`;
const groupName = `Q11 browser group ${suffix}`;
const userEmail = `q11-browser-user-${suffix}@example.invalid`;
const userPassword = 'q11-browser-user-password-2026';
const upstreamKey = 'q11-browser-upstream-fixture-secret';
const grantReason = 'Q11 browser admin grant';

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
  await page.getByLabel('邮箱', { exact: true }).fill(connection.adminEmail);
  await page.getByLabel('密码', { exact: true }).fill(connection.adminPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(connection.baseURL + "/");
  await page.goto("/dashboard");
  await expect(page.getByRole('navigation', { name: '主导航' }).getByText(connection.adminEmail, { exact: true })).toBeVisible();
}

async function waitForEnabled(locator: Locator): Promise<void> {
  await expect.poll(async () => locator.isEnabled()).toBe(true);
}

test('administrator configures the console and investigates an abnormal request', async ({ page }) => {
  test.setTimeout(180_000);
  await loginThroughPage(page);

  await page.goto('/admin/registration/settings');
  await expect(page.getByRole('heading', { name: '注册设置', exact: true })).toBeVisible();
  const registrationMode = page.getByRole('combobox', { name: '注册模式', exact: true });
  await expect(registrationMode).toHaveValue('closed');
  await registrationMode.selectOption('open');
  await page.getByRole('button', { name: '保存注册设置', exact: true }).click();
  await expect(page.getByText('注册设置已保存。', { exact: true })).toBeVisible();
  await expect(registrationMode).toHaveValue('open');

  await page.goto('/admin/channels');
  await page.getByRole('button', { name: '创建渠道', exact: true }).click();
  const channelDialog = page.getByRole('dialog');
  await channelDialog.getByRole('textbox', { name: '名称', exact: true }).fill(channelName);
  await channelDialog.getByRole('textbox', { name: /^上游基础 URL/ }).fill('https://e2e-upstream.example.invalid');
  await channelDialog.getByRole('textbox', { name: '上游 API Key', exact: true }).fill(upstreamKey);
  await channelDialog.getByRole('spinbutton', { name: '并发（留空不限）', exact: true }).fill('4');
  await channelDialog.getByRole('spinbutton', { name: '每分钟请求数（留空不限）', exact: true }).fill('120');
  await channelDialog.getByRole('spinbutton', { name: '优先级', exact: true }).fill('1');
  const channelCreateResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/admin/channels') && response.request().method() === 'POST');
  await channelDialog.getByRole('button', { name: '保存渠道', exact: true }).click();
  const channelResponse = await channelCreateResponse;
  const channelResponseText = await channelResponse.text();
  expect(channelResponse.status(), channelResponseText).toBe(201);
  await expect(channelDialog.getByText('渠道已创建。', { exact: true })).toBeVisible();
  await channelDialog.getByRole('button', { name: '关闭', exact: true }).click();
  const channelRow = page.locator('tbody tr').filter({ hasText: channelName });
  await expect(channelRow).toBeVisible();
  const channelPage = await administrator.get('/api/v1/admin/channels?limit=100');
  expect(channelPage.status()).toBe(200);
  const channelId = (await channelPage.json()).data.items.find((item: { name: string }) => item.name === channelName).id as string;
  expect(channelId).toMatch(/^[A-Za-z0-9-]{36}$/);
  await expect(channelRow).toContainText('已配置（掩码）');
  await expect(channelRow).not.toContainText(upstreamKey);

  await page.goto('/admin/models');
  await page.getByRole('button', { name: '创建模型', exact: true }).click();
  const modelDialog = page.getByRole('dialog');
  await modelDialog.getByRole('textbox', { name: '公开模型 ID', exact: true }).fill(modelId);
  await modelDialog.getByRole('textbox', { name: '准入最低余额（USD 最小单位）', exact: true }).fill('0');
  await modelDialog.getByRole('spinbutton', { name: '最大输出 Token', exact: true }).fill('128');
  await expect(modelDialog.getByRole('spinbutton', { name: '默认输出 Token', exact: true })).toHaveCount(0);
  await modelDialog.getByRole('textbox', { name: 'input', exact: true }).fill('1');
  await modelDialog.getByRole('textbox', { name: 'output', exact: true }).fill('2');
  await modelDialog.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(modelDialog.getByText('模型已创建。', { exact: true })).toBeVisible();
  await modelDialog.getByRole('button', { name: '关闭', exact: true }).click();
  const modelRow = page.locator('tbody tr').filter({ hasText: modelId });
  await expect(modelRow).toBeVisible();
  await expect(modelRow).toContainText('input：1');
  await expect(modelRow).toContainText('output：2');

  await modelRow.getByRole('button', { name: '管理映射', exact: true }).click();
  const mappingDialog = page.getByRole('dialog');
  await expect(mappingDialog.getByRole('heading', { name: '渠道模型映射', exact: true })).toBeVisible();
  await expect(mappingDialog.getByText('暂无映射。', { exact: true })).toBeVisible();
  const mappingChannel = mappingDialog.getByRole('combobox', { name: '渠道', exact: true });
  await waitForEnabled(mappingChannel);
  await mappingChannel.selectOption(channelId);
  await mappingDialog.getByRole('combobox', { name: '协议', exact: true }).selectOption('chat');
  await mappingDialog.getByRole('textbox', { name: '上游模型', exact: true }).fill('fixture-chat-model');
  await mappingDialog.getByRole('textbox', { name: /^能力（每行或逗号分隔）/ }).fill('streaming');
  await mappingDialog.getByRole('button', { name: '创建映射', exact: true }).click();
  await expect(mappingDialog.getByText('模型映射已保存。', { exact: true })).toBeVisible();
  await expect(mappingDialog.getByText(new RegExp(`${channelId} · chat`))).toBeVisible();
  await mappingDialog.getByRole('button', { name: '关闭', exact: true }).click();

  await page.goto('/admin/groups');
  await page.getByRole('button', { name: '创建分组', exact: true }).click();
  const groupDialog = page.getByRole('dialog');
  await groupDialog.getByRole('textbox', { name: '名称', exact: true }).fill(groupName);
  const groupChannels = groupDialog.getByRole('listbox', { name: '渠道关系', exact: true });
  await waitForEnabled(groupChannels);
  await groupChannels.selectOption(channelId);
  await groupDialog.getByRole('button', { name: '保存分组', exact: true }).click();
  await expect(groupDialog.getByText('分组已创建。', { exact: true })).toBeVisible();
  await groupDialog.getByRole('button', { name: '关闭', exact: true }).click();
  const groupRow = page.locator('tbody tr').filter({ hasText: groupName });
  await expect(groupRow).toBeVisible();
  await expect(groupRow).toContainText(channelId);

  // Point the configured channel at a synthetic host that the local Worker
  // rejects. The gateway can then persist a transport failure without any
  // network call; this is the abnormal request shown by the admin UI below.
  await page.goto('/admin/channels');
  const editableChannelRow = page.locator('tbody tr').filter({ hasText: channelName });
  await editableChannelRow.getByRole('button', { name: '编辑', exact: true }).click();
  const channelEditDialog = page.getByRole('dialog');
  await channelEditDialog.getByRole('textbox', { name: /^上游基础 URL/ }).fill('https://e2e-failing-upstream.example.invalid');
  await channelEditDialog.getByRole('button', { name: '保存渠道', exact: true }).click();
  await expect(channelEditDialog.getByText('渠道设置已保存。', { exact: true })).toBeVisible();
  await channelEditDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: channelName })).toContainText('e2e-failing-upstream.example.invalid');

  await page.goto('/admin/users');
  await page.getByRole('button', { name: '创建普通用户', exact: true }).click();
  const createUserDialog = page.getByRole('dialog');
  await createUserDialog.getByRole('textbox', { name: '邮箱', exact: true }).fill(userEmail);
  await createUserDialog.getByRole('textbox', { name: '初始密码', exact: true }).fill(userPassword);
  const userGroup = createUserDialog.getByRole('combobox', { name: '分组', exact: true });
  await waitForEnabled(userGroup);
  await userGroup.selectOption({ label: groupName });
  await createUserDialog.getByRole('button', { name: '创建用户', exact: true }).click();
  await expect(createUserDialog.getByText(new RegExp(`用户 ${userEmail} 已创建。`))).toBeVisible();
  await createUserDialog.getByRole('button', { name: '返回用户列表', exact: true }).click();
  const createdUserRow = page.locator('tbody tr').filter({ hasText: userEmail });
  await expect(createdUserRow).toBeVisible();
  await expect(createdUserRow).toContainText('普通用户');
  await expect(createdUserRow).toContainText(groupName);

  const adminRow = page.locator('tbody tr').filter({ hasText: connection.adminEmail });
  await adminRow.getByRole('button', { name: '编辑用户', exact: true }).click();
  const editAdminDialog = page.getByRole('dialog');
  const adminGroup = editAdminDialog.getByRole('combobox', { name: '默认分组', exact: true });
  await waitForEnabled(adminGroup);
  await adminGroup.selectOption({ label: groupName });
  await editAdminDialog.getByRole('spinbutton', { name: '并发（留空不限）', exact: true }).fill('4');
  await editAdminDialog.getByRole('spinbutton', { name: '每分钟请求数（留空不限）', exact: true }).fill('120');
  await editAdminDialog.getByRole('button', { name: '保存用户设置', exact: true }).click();
  await expect(editAdminDialog.getByText('用户设置已保存。请返回列表查看最新状态与版本。', { exact: true })).toBeVisible();
  await editAdminDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: connection.adminEmail })).toContainText(groupName);

  const refreshedUserRow = page.locator('tbody tr').filter({ hasText: userEmail });
  await refreshedUserRow.getByRole('button', { name: '编辑用户', exact: true }).click();
  const editUserDialog = page.getByRole('dialog');
  await waitForEnabled(editUserDialog.getByRole('combobox', { name: '默认分组', exact: true }));
  await editUserDialog.getByRole('spinbutton', { name: '并发（留空不限）', exact: true }).fill('3');
  await editUserDialog.getByRole('spinbutton', { name: '每分钟请求数（留空不限）', exact: true }).fill('90');
  await editUserDialog.getByRole('button', { name: '保存用户设置', exact: true }).click();
  await expect(editUserDialog.getByText('用户设置已保存。请返回列表查看最新状态与版本。', { exact: true })).toBeVisible();
  await editUserDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: userEmail }).locator('td').nth(3)).toHaveText('3');
  await expect(page.locator('tbody tr').filter({ hasText: userEmail }).locator('td').nth(4)).toHaveText('90');

  const grantAdminRow = page.locator('tbody tr').filter({ hasText: connection.adminEmail });
  await grantAdminRow.getByRole('button', { name: '余额调整', exact: true }).click();
  const grantDialog = page.getByRole('dialog');
  await grantDialog.getByRole('textbox', { name: /^金额（USD 最小单位）/ }).fill('100000000');
  await grantDialog.getByRole('textbox', { name: '原因', exact: true }).fill(grantReason);
  await grantDialog.getByRole('button', { name: '提交调整', exact: true }).click();
  await expect(grantDialog.getByText('余额调整已写入。', { exact: true })).toBeVisible();
  await grantDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: connection.adminEmail })).toContainText('1.00000000');

  await page.goto('/keys');
  await page.getByRole('button', { name: '创建 Key', exact: true }).click();
  const keyDialog = page.getByRole('dialog');
  await keyDialog.getByRole('textbox', { name: '名称', exact: true }).fill(`Q11 gateway key ${suffix}`);
  await keyDialog.getByRole('combobox', { name: '分组', exact: true }).selectOption({ label: groupName });
  await keyDialog.getByRole('button', { name: '创建 Key', exact: true }).click();
  const keySecret = keyDialog.locator('#new-key-secret');
  await expect(keySecret).toBeVisible();
  const platformKey = await keySecret.inputValue();
  expect(platformKey).toMatch(/^s2a_key_[A-Za-z0-9_-]{43}$/);
  await keyDialog.getByRole('button', { name: '已保存，关闭密钥', exact: true }).click();
  await expect(keyDialog).toHaveCount(0);

  // This is a valid Chat request. The synthetic channel host is rejected by the
  // local Worker fetch guard after admission, producing a persisted transport
  // failure without reaching the e2e upstream fixture.
  const gateway = await administrator.post('/v1/chat/completions', {
    headers: { Authorization: `Bearer ${platformKey}` },
    data: {
      model: modelId,
      messages: [{ role: 'user', content: 'Q11 abnormal request fixture' }],
    },
  });
  expect(gateway.status()).toBe(502);
  expect(gateway.headers()['x-request-id']).toMatch(/^[A-Za-z0-9-]{20,}$/);
  const gatewayBody = await gateway.json();
  expect(gatewayBody.error).toBeDefined();

  await page.goto('/admin/requests');
  const requestRow = page.locator('tbody tr').filter({ hasText: modelId });
  await expect(requestRow).toBeVisible();
  await expect(requestRow).toContainText('失败');
  await expect(requestRow).toContainText('用量未知');
  const requestLink = requestRow.getByRole('link').first();
  await expect(requestLink).toBeVisible();
  await requestLink.click();
  await expect(page).toHaveURL(/\/admin\/requests\//);
  await expect(page.getByRole('heading', { name: '请求证据', exact: true })).toBeVisible();
  await expect(page.getByText('upstream_error', { exact: false })).toBeVisible();
  await expect(page.getByText('用量未知', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试结算', exact: true })).toBeDisabled();

  await page.goto('/admin/billing');
  await expect(page.getByRole('heading', { name: '管理账单', exact: true })).toBeVisible();
  const grantBillingRow = page.getByRole('row').filter({ hasText: grantReason });
  await expect(grantBillingRow).toBeVisible();
  await expect(grantBillingRow).toContainText('管理员授额');
  await expect(grantBillingRow).toContainText('1.00000000 USD');
  await expect(page.getByRole('cell', { name: '一致', exact: true }).first()).toBeVisible();

  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: '管理审计', exact: true })).toBeVisible();
  for (const action of ['registration.settings.update', 'channel.create', 'model.create', 'channel_model.create',
    'group.create', 'user.create', 'user.update', 'balance.grant']) {
    await expect(page.getByRole('cell', { name: action, exact: true }).first()).toBeVisible();
  }
  await expect(page.locator('body')).not.toContainText(upstreamKey);
  await expect(page.locator('body')).not.toContainText(platformKey);
});
