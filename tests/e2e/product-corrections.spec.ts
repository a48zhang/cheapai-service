import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('six-character password, unlimited concurrency, channel models and granted Key groups @operations', async ({ page, browser }) => {
  test.setTimeout(180000);
  const connection=JSON.parse(readFileSync(join(__dirname,`../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`),'utf8'));
  const tag=randomUUID().slice(0,8);const gptModel=`gpt-${tag}`,claudeModel=`claude-${tag}`;
  const gptName=`GPT ${tag}`,claudeName=`Claude ${tag}`,email=`groups-${tag}@example.invalid`;
  await page.goto('/');await expect(page.locator('main')).not.toContainText('协议互转');await expect(page.getByRole('img')).toHaveCount(0);
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(connection.adminEmail);await page.getByLabel('密码',{exact:true}).fill(connection.adminPassword);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page).toHaveURL(connection.baseURL + '/');await page.goto('/dashboard');const adminBalance=page.getByRole('region',{name:'当前余额'});await expect(adminBalance.locator('p').filter({hasText:/\d/})).toBeVisible();await expect(page.locator('main')).not.toContainText('/v1/chat/completions');
  const admin=page.context().request;const csrf=(await(await admin.get('/api/v1/settings/public')).json()).data.csrfToken;
  const headers={Origin:connection.baseURL,'X-CSRF-Token':csrf};
  async function create(path:string,data:unknown) { const response=await admin.post(path,{headers,data});expect(response.status(),await response.text()).toBe(201);return (await response.json()).data; }
  for(const publicModelId of [gptModel,claudeModel])await create('/api/v1/admin/models',{publicModelId,sellPrices:{input:'1',output:'1'},admissionMinBalanceUnits:'0',maxOutputTokens:64});
  await page.goto('/admin/channels');await page.getByRole('button',{name:'创建渠道',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'创建渠道'});await dialog.getByLabel('渠道名称',{exact:true}).fill(gptName);await dialog.getByLabel('上游 Base URL',{exact:true}).fill('https://e2e-upstream.example.invalid/v1');await dialog.getByLabel('上游凭证',{exact:true}).fill('local-correction-key');
  await expect(dialog.getByRole('combobox',{name:'并发规则',exact:true})).toContainText('不限');await expect(dialog.getByRole('combobox',{name:'RPM 规则',exact:true})).toContainText('不限');
  const saveBox=await dialog.getByRole('button',{name:'创建渠道',exact:true}).boundingBox();const cancelBox=await dialog.getByRole('button',{name:'取消',exact:true}).boundingBox();expect(Math.abs(saveBox!.y-cancelBox!.y)).toBeLessThan(2);
  await dialog.getByRole('button',{name:'创建渠道',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  const gptRow=page.locator('tbody tr').filter({hasText:gptName});await expect(gptRow).toContainText('不限');
  await page.goto(`/admin/models/${encodeURIComponent(gptModel)}`);const channelPicker=page.getByRole('button',{name:/^关联渠道：/});await expect(channelPicker).toBeEnabled();await channelPicker.click();dialog=page.getByRole('dialog',{name:'选择渠道'});await dialog.getByRole('checkbox',{name:new RegExp(gptName)}).check();await dialog.getByRole('button',{name:'应用选择',exact:true}).click();
  const mappingForm=page.locator('form').filter({has:page.getByLabel('上游模型名称',{exact:true})});await mappingForm.getByLabel('上游模型名称',{exact:true}).fill('upstream-gpt');await mappingForm.getByRole('button',{name:'创建映射',exact:true}).click();await expect(mappingForm.getByRole('status')).toContainText('模型映射已保存');
  const channels=(await(await admin.get('/api/v1/admin/channels?limit=100')).json()).data.items;
  const gptChannel=channels.find((item:{name:string})=>item.name===gptName);expect(gptChannel.concurrencyLimit).toBe(Number.MAX_SAFE_INTEGER);expect(gptChannel.rpmLimit).toBe(Number.MAX_SAFE_INTEGER);expect(gptChannel.models[0]).toMatchObject({publicModelId:gptModel,upstreamModel:'upstream-gpt'});
  await page.goto(`/admin/channels/${encodeURIComponent(gptChannel.id)}`);await page.getByRole('button',{name:'连接诊断',exact:true}).click();dialog=page.getByRole('dialog',{name:'渠道连接诊断'});await expect(dialog.getByRole('combobox',{name:'选择模型映射',exact:true})).toBeVisible();await dialog.getByRole('button',{name:'执行诊断',exact:true}).click();const confirmation=page.getByRole('dialog',{name:/确认发送一次上游测试请求/});await expect(confirmation.getByRole('button',{name:'确认并诊断',exact:true})).toBeEnabled();await confirmation.getByRole('button',{name:'返回',exact:true}).click();await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  const claudeChannel=await create('/api/v1/admin/channels',{name:claudeName,baseUrl:'https://e2e-upstream.example.invalid/v1',upstreamKey:'local-correction-key',concurrencyLimit:0,rpmLimit:60});
  await create(`/api/v1/admin/models/${claudeModel}/mappings`,{channelId:claudeChannel.id,protocol:'messages',upstreamModel:'upstream-claude',capabilities:{protocol:'messages',features:['streaming'],maxOutputTokens:64}});
  const gptGroup=await create('/api/v1/admin/groups',{name:gptName,status:'active',channelIds:[gptChannel.id]});
  const claudeGroup=await create('/api/v1/admin/groups',{name:claudeName,status:'active',channelIds:[claudeChannel.id]});
  await page.goto('/admin/users');
  await page.getByRole('button',{name:'创建普通用户',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'创建普通用户'});
  await dialog.getByLabel('邮箱',{exact:true}).fill(email);
  await dialog.getByLabel('初始密码',{exact:true}).fill('abc123');
  const initialGroup=dialog.getByRole('combobox',{name:'初始分组',exact:true});
  await expect(initialGroup).toBeEnabled();
  await initialGroup.click();
  await page.getByRole('option',{name:gptName,exact:true}).click();
  await dialog.getByRole('button',{name:'创建用户',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row=page.getByRole('row').filter({hasText:email});
  await expect(row).toBeVisible();
  await row.getByRole('link',{name:'查看详情',exact:true}).click();
  await expect(page.getByRole('heading',{name:email,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'编辑访问设置',exact:true}).first().click();
  dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox',{name:claudeName,exact:true})).toBeEnabled();
  await dialog.getByRole('checkbox',{name:claudeName,exact:true}).check();
  await expect(dialog.getByLabel('并发请求上限',{exact:true})).toHaveValue('');
  await expect(dialog.getByLabel('每分钟请求上限',{exact:true})).toHaveValue('');
  await dialog.getByRole('button',{name:'保存用户设置',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const user=(await(await admin.get('/api/v1/admin/users?limit=100')).json()).data.items.find((item:{email_normalized:string})=>item.email_normalized===email);
  expect(user.allowed_group_ids.sort()).toEqual([gptGroup.id,claudeGroup.id].sort());
  const funding=await admin.post(`/api/v1/admin/users/${user.id}/balance-adjustments`,{headers:{...headers,'Idempotency-Key':randomUUID()},data:{kind:'grant',deltaUnits:'1000000',reason:'Local group integration'}});expect(funding.status()).toBe(201);
  const userContext=await browser.newContext({baseURL:connection.baseURL,ignoreHTTPSErrors:true});
  try {
    const userPage=await userContext.newPage();await userPage.goto('/login');await userPage.getByLabel('邮箱',{exact:true}).fill(email);await userPage.getByLabel('密码',{exact:true}).fill('abc123');await userPage.getByRole('button',{name:'登录',exact:true}).click();await expect(userPage).toHaveURL(connection.baseURL + '/');await userPage.goto('/dashboard');const userBalance=userPage.getByRole('region',{name:'当前余额'});await expect(userBalance.locator('p').filter({hasText:/\d/})).toBeVisible();
    await userPage.goto('/keys');await userPage.getByRole('button',{name:'创建 Key',exact:true}).click();const keyDialog=userPage.getByRole('dialog');await expect(keyDialog.getByRole('combobox',{name:'分组',exact:true})).toBeEnabled();await keyDialog.getByLabel('名称',{exact:true}).fill('Claude application');await keyDialog.getByRole('combobox',{name:'分组',exact:true}).selectOption(claudeGroup.id);await expect(keyDialog).toContainText(claudeModel);await expect(keyDialog).not.toContainText('禁止所有模型');await keyDialog.getByRole('button',{name:'创建 Key',exact:true}).click();const secret=keyDialog.getByLabel('完整密钥（仅显示一次）',{exact:true});await expect(secret).toBeVisible();const token=await secret.inputValue();await keyDialog.getByRole('button',{name:'已保存，关闭密钥',exact:true}).click();await expect(userPage.getByRole('table')).toContainText(claudeName);
    const bearer={Authorization:`Bearer ${token}`};const listed=await userContext.request.get('/v1/models',{headers:bearer});expect(listed.status()).toBe(200);expect((await listed.json()).data.map((m:{id:string})=>m.id)).toEqual([claudeModel]);
    const generated=await userContext.request.post('/v1/chat/completions',{headers:bearer,data:{model:claudeModel,max_tokens:16,messages:[{role:'user',content:'test'}]}});expect(generated.status(),await generated.text()).toBe(200);
    const forbidden=await userContext.request.post('/v1/chat/completions',{headers:bearer,data:{model:gptModel,messages:[{role:'user',content:'test'}]}});expect(forbidden.status()).toBe(400);
    await page.getByRole('button',{name:'编辑访问设置',exact:true}).first().click();
    dialog=page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox',{name:claudeName,exact:true})).toBeEnabled();
    await dialog.getByRole('checkbox',{name:claudeName,exact:true}).uncheck();
    await dialog.getByRole('button',{name:'保存用户设置',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await userContext.request.get('/v1/models',{headers:bearer})).status()).toBe(401);
    await userPage.getByRole('button',{name:'编辑 / 撤销',exact:true}).click();const edit=userPage.getByRole('dialog');await expect(edit.getByRole('combobox',{name:'分组',exact:true})).toBeEnabled();await edit.getByRole('combobox',{name:'分组',exact:true}).selectOption(gptGroup.id);await edit.getByRole('button',{name:'保存 Key',exact:true}).click();await expect(edit.getByRole('status')).toContainText('Key 已保存');await edit.getByRole('button',{name:'关闭',exact:true}).click();
    const rebound=await userContext.request.get('/v1/models',{headers:bearer});expect(rebound.status()).toBe(200);expect((await rebound.json()).data.map((m:{id:string})=>m.id)).toEqual([gptModel]);
  } finally { await userContext.close(); }
});

// FE-V03: all API traffic below is mocked; selector reads must never probe upstreams.
type PickerKind = 'group' | 'mapping';
const pickerChannel = (index: number) => ({
  id: `picker-channel-${index}`, name: `Picker channel ${index}`, baseUrl: 'https://upstream.example.invalid',
  status: index === 41 ? 'disabled' : 'active', priority: 1, concurrencyLimit: 2, rpmLimit: 60,
  configVersion: 1, createdAt: 10, updatedAt: 10, hasCredential: true, models: [],
});
const pickerGroup = {
  id: 'picker-group', name: 'Picker group', status: 'active', version: 1, createdAt: 10, updatedAt: 10,
  billingMultiplier: '1', channelIds: ['picker-channel-41', 'missing-channel'],
};
const pickerModel = {
  publicModelId: 'picker-model', status: 'active', sellPrices: { input: '1', output: '1' },
  priceVersion: 1, admissionMinBalanceUnits: '0', maxOutputTokens: 64, createdAt: 10, updatedAt: 10,
};
const pickerMapping = (channelId = 'picker-channel-41') => ({
  channelId, publicModelId: pickerModel.publicModelId, protocol: 'chat', upstreamModel: 'fixture-upstream',
  capabilities: { protocol: 'chat', features: [] }, configVersion: 2,
});
type PickerPage = { items: ReturnType<typeof pickerChannel>[]; nextCursor: string | null };
function pickerPage(cursor: string | null): PickerPage {
  return cursor === null
    ? { items: Array.from({ length: 20 }, (_, i) => pickerChannel(i + 1)), nextCursor: 'page-2' }
    : cursor === 'page-2'
      ? { items: [pickerChannel(20), ...Array.from({ length: 20 }, (_, i) => pickerChannel(i + 21))], nextCursor: 'page-3' }
      : { items: [pickerChannel(40), pickerChannel(41)], nextCursor: null };
}
async function setupPicker(page: import('@playwright/test').Page) {
  const state = {
    cursors: [] as (string | null)[], writes: [] as { path: string; body: Record<string, unknown> }[], unexpected: [] as string[],
    channels: async (cursor: string | null): Promise<PickerPage | number> => pickerPage(cursor),
    mappingFailures: 0, mappingReads: 0, mappings: [] as ReturnType<typeof pickerMapping>[], conflict: false,
  };
  await page.context().addCookies([{ name: '__Host-sub2api_csrf', value: 'a'.repeat(42) + 'A', url: 'https://127.0.0.1/' }]);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, request_id: 'picker-request' }) });
    const failure = (status: number) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code: status === 409 ? 'conflict' : 'internal_error', message: 'Fixture read failed' }, request_id: 'picker-error' }) });
    if (request.method() !== 'GET') {
      state.writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      if (state.conflict) return failure(409);
      if (path === '/api/v1/admin/groups/picker-group') return reply({ ...pickerGroup, ...request.postDataJSON(), version: 2 });
      if (path === '/api/v1/admin/models/picker-model/mappings') return reply({ ...pickerMapping(), ...request.postDataJSON(), configVersion: 1 }, 201);
      state.unexpected.push(`${request.method()} ${path}`); return failure(500);
    }
    if (path === '/api/v1/auth/me') return reply({ id: 'picker-admin', email_normalized: 'picker@example.invalid', role: 'admin', status: 'active', group_id: 'picker-group', group_status: 'active', balance_units: '0', email_verified_at: null });
    if (path === '/api/v1/settings/public') return reply({ registrationMode: 'closed', emailVerificationEnabled: false, csrfToken: 'a'.repeat(42) + 'A' });
    if (path === '/api/v1/admin/groups') return reply({ items: [pickerGroup], nextCursor: null });
    if (path === '/api/v1/admin/groups/picker-group') return reply(pickerGroup);
    if (path === '/api/v1/admin/models') return reply({ items: [pickerModel], nextCursor: null });
    if (path === '/api/v1/admin/models/picker-model') return reply(pickerModel);
    if (path === '/api/v1/admin/models/picker-model/mappings') {
      state.mappingReads++;
      if (state.mappingFailures > 0) { state.mappingFailures--; return failure(500); }
      return reply({ items: state.mappings });
    }
    if (path === '/api/v1/admin/channels') {
      const cursor = url.searchParams.get('cursor'); state.cursors.push(cursor);
      expect(url.searchParams.get('status')).toBeNull(); expect(url.searchParams.get('limit')).toBe('20');
      const result = await state.channels(cursor);
      try { return typeof result === 'number' ? failure(result) : reply(result); } catch { return; }
    }
    state.unexpected.push(`${request.method()} ${path}`); return failure(500);
  });
  return state;
}
async function openPicker(page: import('@playwright/test').Page, kind: PickerKind, navigate = true, open = true) {
  if (navigate) await page.goto(kind === 'group' ? '/admin/groups/picker-group' : '/admin/models/picker-model');
  const pickerButton = page.getByRole('button', { name: /^关联渠道：/ });
  await expect(pickerButton).toBeVisible();
  if (!open) return { pickerButton, dialog: page.getByRole('dialog', { name: '选择渠道' }) };
  await pickerButton.click();
  const dialog = page.getByRole('dialog', { name: '选择渠道' });
  await expect(dialog).toBeVisible();
  return { dialog, pickerButton };
}
for (const kind of ['group', 'mapping'] as const) {
  test(`channel selector ${kind} includes pages 21 and 41, deduplicates and preserves disabled/current IDs @resources`, async ({ page }) => {
    const state = await setupPicker(page);
    if (kind === 'mapping') state.mappings = [];
    const ui = await openPicker(page, kind);
    await expect(ui.dialog.getByRole('checkbox', { name: /picker-channel-20/ })).toHaveCount(1);
    await expect(ui.dialog.getByRole('checkbox', { name: /picker-channel-40/ })).toHaveCount(1);
    const disabledChannel = ui.dialog.getByRole('checkbox', { name: /picker-channel-41/ });
    if (kind === 'group') {
      await expect(disabledChannel).toBeChecked();
      await expect(disabledChannel).toHaveAccessibleName(/已停用/);
      await expect(ui.dialog.getByRole('checkbox', { name: /missing-channel/ })).toBeChecked();
      await ui.dialog.getByRole('checkbox', { name: /picker-channel-21/ }).check();
    } else {
      await expect(disabledChannel).toBeDisabled();
      await ui.dialog.getByRole('checkbox', { name: /picker-channel-21/ }).check();
    }
    expect(state.cursors).toEqual([null, 'page-2', 'page-3']);
    expect(state.writes).toHaveLength(0);
    await ui.dialog.getByRole('button', { name: '应用选择', exact: true }).click();
    if (kind === 'group') await page.getByRole('button', { name: '保存访问组', exact: true }).click();
    else {
      const mappingForm = page.locator('form').filter({ has: page.getByLabel('上游模型名称', { exact: true }) });
      await mappingForm.getByLabel('上游模型名称', { exact: true }).fill('fixture-upstream');
      await mappingForm.getByRole('button', { name: '创建映射', exact: true }).click();
    }
    expect(state.writes).toHaveLength(1);
    if (kind === 'group') expect(state.writes[0]?.body.channelIds).toEqual(['missing-channel', 'picker-channel-21', 'picker-channel-41']);
    else expect(state.writes[0]?.body.channelId).toBe('picker-channel-21');
    expect(state.unexpected).toEqual([]);
  });

  for (const failure of ['middle-page', 'repeated-cursor'] as const) {
    test(`channel selector ${kind} blocks partial ${failure} results and retries without writes @resources`, async ({ page }) => {
      const state = await setupPicker(page);
      state.channels = async cursor => cursor === null ? pickerPage(cursor)
        : failure === 'middle-page' ? 500 : { items: [pickerChannel(21)], nextCursor: 'page-2' };
      const ui = await openPicker(page, kind);
      await expect(ui.dialog.getByRole('alert')).toBeVisible();
      await expect(ui.dialog.getByRole('button', { name: '应用选择', exact: true })).toBeDisabled();
      await expect(ui.dialog.getByRole('checkbox', { name: /picker-channel-1/ })).toHaveCount(0);
      await expect(ui.dialog.getByRole('checkbox', { name: /picker-channel-21/ })).toHaveCount(0);
      if (kind === 'group') {
        await expect(ui.dialog.getByRole('checkbox', { name: /picker-channel-41/ })).toBeChecked();
        await expect(ui.dialog.getByRole('checkbox', { name: /missing-channel/ })).toBeChecked();
      }
      expect(state.cursors).toEqual([null, 'page-2']);
      state.channels = async cursor => pickerPage(cursor);
      await ui.dialog.getByRole('button', { name: '重试候选加载', exact: true }).click();
      await expect(ui.dialog.getByRole('checkbox', { name: /picker-channel-21/ })).toBeEnabled();
      await expect(ui.dialog.getByRole('alert')).toHaveCount(0);
      await ui.dialog.getByRole('checkbox', { name: /picker-channel-21/ }).check();
      await ui.dialog.getByRole('button', { name: '应用选择', exact: true }).click();
      expect(state.cursors).toEqual([null, 'page-2', null, 'page-2', 'page-3']);
      expect(state.writes).toHaveLength(0); expect(state.unexpected).toEqual([]);
    });
  }

  test(`channel selector ${kind} ignores a late read after close and reopen @resources`, async ({ page }) => {
    const state = await setupPicker(page);
    let release!: (value: PickerPage) => void;
    const pending = new Promise<PickerPage>(resolve => { release = resolve; });
    let first = true;
    state.channels = async cursor => { if (first) { first = false; return pending; } return pickerPage(cursor); };
    const old = await openPicker(page, kind);
    await expect.poll(() => state.cursors.length).toBe(1);
    await expect(old.dialog.getByRole('button', { name: '应用选择', exact: true })).toBeDisabled();
    await old.dialog.getByRole('button', { name: '关闭渠道选择', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const current = await openPicker(page, kind, false);
    await expect.poll(() => state.cursors.length).toBe(4);
    await expect(current.dialog.getByRole('checkbox', { name: /picker-channel-21/ })).toBeEnabled();
    await current.dialog.getByRole('checkbox', { name: /picker-channel-21/ }).check();
    await current.dialog.getByRole('button', { name: '应用选择', exact: true }).click();
    release({ items: [pickerChannel(99)], nextCursor: null });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(current.pickerButton).toHaveAttribute('aria-label', /Picker channel 21/);
    const reopened = await openPicker(page, kind, false);
    await expect(reopened.dialog.getByRole('checkbox', { name: /picker-channel-99/ })).toHaveCount(0);
    await expect(reopened.dialog.getByRole('checkbox', { name: /picker-channel-41/ })).toHaveCount(1);
    await expect(reopened.dialog.getByRole('checkbox', { name: /picker-channel-21/ })).toBeChecked();
    expect(state.writes).toHaveLength(0); expect(state.unexpected).toEqual([]);
  });
}

test('channel selector mapping retries mapping reads independently and preserves fixed missing IDs and conflicts @resources', async ({ page }) => {
  const state = await setupPicker(page); state.mappingFailures = 1; state.mappings = [pickerMapping('missing-channel')];
  const ui = await openPicker(page, 'mapping', true, false);
  const mappingError = page.getByRole('alert');
  await expect(mappingError).toBeVisible();
  await expect(mappingError.getByRole('button', { name: '重试读取映射', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建映射', exact: true })).toBeDisabled();
  await mappingError.getByRole('button', { name: '重试读取映射', exact: true }).click();
  await expect.poll(() => state.mappingReads).toBe(2);
  expect(state.cursors).toEqual([]); expect(state.mappingReads).toBe(2);
  await ui.pickerButton.click();
  await expect(ui.dialog).toBeVisible();
  await expect.poll(() => state.cursors.length).toBe(3);
  await ui.dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(state.cursors).toEqual([null, 'page-2', 'page-3']);
  const existingMapping = page.getByRole('button', { name: /missing-channel.*Chat Completions.*fixture-upstream/ });
  await existingMapping.click();
  const pickerButton = page.getByRole('button', { name: /^关联渠道：未知渠道（missing-channel）/ });
  await expect(pickerButton).toBeDisabled();
  const mappingForm = page.locator('form').filter({ has: page.getByLabel('上游模型名称', { exact: true }) });
  await expect(mappingForm.getByRole('combobox', { name: '协议', exact: true })).toBeDisabled();
  await mappingForm.getByLabel('上游模型名称', { exact: true }).fill('edited-upstream');
  state.conflict = true;
  const save = mappingForm.getByRole('button', { name: '保存映射', exact: true });
  await save.click();
  await expect(mappingForm.getByRole('alert')).toBeVisible();
  await expect(save).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: '/api/v1/admin/models/picker-model/mappings/missing-channel/chat', body: { version: 2 } });
  await page.getByRole('button', { name: '重新读取映射', exact: true }).click();
  await expect.poll(() => state.mappingReads).toBe(3);
  await existingMapping.click();
  await expect(save).toBeEnabled();
  expect(state.writes).toHaveLength(1); expect(state.unexpected).toEqual([]);
});
