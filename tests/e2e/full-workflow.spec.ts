import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Protocol = 'chat' | 'responses' | 'messages';
const protocols: Protocol[] = ['chat', 'responses', 'messages'];
const paths = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };
const answer = 'Local fixture answer';
function wireInput(protocol: Protocol, model: string, streaming: boolean, outputLimit = 16) {
  if (protocol === 'responses') return { model, input: 'Hello from the local integration fixture', max_output_tokens: outputLimit, stream: streaming };
  if (protocol === 'messages') return { model, messages: [{ role: 'user', content: 'Hello from the local integration fixture' }], max_tokens: outputLimit, stream: streaming };
  return { model, messages: [{ role: 'user', content: 'Hello from the local integration fixture' }], max_completion_tokens: outputLimit,
    stream: streaming, ...(streaming ? { stream_options: { include_usage: false } } : {}) };
}
function frames(text: string): Record<string, any>[] {
  return text.split(/\r?\n\r?\n/).flatMap(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return !data || data === '[DONE]' ? [] : [JSON.parse(data) as Record<string, any>];
  });
}

test('real browser signup → key → funding → nine JSON/SSE pairs → overdraft and recovery', async ({ page, playwright }) => {
  test.setTimeout(180_000);
  const connection = JSON.parse(readFileSync(join(__dirname, `../../.wrangler/e2e/connection-${process.env.SUB2API_E2E_PORT ?? '9789'}.json`), 'utf8'));
  const admin = await playwright.request.newContext({ baseURL: connection.baseURL, ignoreHTTPSErrors: true });
  const gateway = await playwright.request.newContext({ baseURL: connection.baseURL, ignoreHTTPSErrors: true });
  try {
    const settings = await admin.get('/api/v1/settings/public');
    const csrf = (await settings.json()).data.csrfToken as string;
    const headers = { Origin: connection.baseURL as string, 'X-CSRF-Token': csrf };
    expect((await admin.post('/api/v1/auth/login', { headers, data: { email: connection.adminEmail, password: connection.adminPassword } })).status()).toBe(200);
    const control = { 'X-E2E-Control': connection.token as string };
    expect((await admin.post('/__test__/policy', { headers: control, data: { registrationMode: 'open', emailVerificationEnabled: true } })).status()).toBe(200);
    const email = `q12-${randomUUID()}@example.invalid`;
    await page.goto('/register');
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill('local-full-workflow-password');
    await page.getByRole('button', { name: '发送验证码', exact: true }).click();
    await expect(page.getByText(/验证码发送请求已受理/)).toBeVisible();
    const mail = await admin.get(`/__test__/mail?email=${encodeURIComponent(email)}`, { headers: control });
    expect(mail.status()).toBe(200);
    await page.getByLabel('邮箱验证码', { exact: true }).fill((await mail.json()).code);
    await page.getByRole('button', { name: '创建账户', exact: true }).click();
    await expect(page).toHaveURL(connection.baseURL + "/");
    const identity = (await (await page.context().request.get('/api/v1/auth/me')).json()).data;
    expect(identity.email_verified_at).not.toBeNull(); expect(identity.balance_units).toBe('0');
    await page.goto('/keys');
    await page.getByRole('button', { name: '创建 Key', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称', { exact: true }).fill('Full workflow key');
    await dialog.getByRole('combobox', { name: '分组', exact: true }).selectOption('default');
    await dialog.getByRole('button', { name: '创建 Key', exact: true }).click();
    const secret = dialog.getByLabel('完整密钥（仅显示一次）', { exact: true });
    await expect(secret).toBeVisible(); const token = await secret.inputValue();
    await dialog.getByRole('button', { name: '已保存，关闭密钥' }).click();
    const bearer = { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' };
    const tag = randomUUID().slice(0, 8);
    const models = {} as Record<Protocol, string>;
    const channelIds: string[] = [];
    for (const upstream of protocols) {
      const createdChannel = await admin.post('/api/v1/admin/channels', { headers, data: {
        name: `Q12 ${upstream} ${tag}`, baseUrl: 'https://e2e-upstream.example.invalid/v1', upstreamKey: 'local-fixture-upstream-key',
        concurrencyLimit: 2, rpmLimit: 60, priority: 10, status: 'active',
      } });
      expect(createdChannel.status(), await createdChannel.text()).toBe(201);
      const channel = (await createdChannel.json()).data; channelIds.push(channel.id);
      const model = `q12/${upstream}/${tag}`; models[upstream] = model;
      const createdModel = await admin.post('/api/v1/admin/models', { headers, data: {
        publicModelId: model, status: 'active', sellPrices: { input: '1', output: '1' },
        admissionMinBalanceUnits: '0', maxOutputTokens: 64,
      } });
      expect(createdModel.status(), await createdModel.text()).toBe(201);
      const mapping = await admin.post(`/api/v1/admin/models/${encodeURIComponent(model)}/mappings`, { headers, data: {
        channelId: channel.id, protocol: upstream, upstreamModel: `fixture-${upstream}`,
        capabilities: { protocol: upstream, features: ['streaming', 'stream_usage', ...(upstream === 'responses' ? ['response_history'] : [])],
          maxOutputTokens: 64 },
      } });
      expect(mapping.status(), await mapping.text()).toBe(201);
    }
    const groupPage = (await (await admin.get('/api/v1/admin/groups?limit=100')).json()).data;
    const group = groupPage.items.find((item: { id: string }) => item.id === 'default');
    expect(group).toBeTruthy();
    const attached = await admin.patch('/api/v1/admin/groups/default', { headers, data: {
      version: group.version, channelIds: [...new Set([...group.channelIds, ...channelIds])],
    } });
    expect(attached.status(), await attached.text()).toBe(200);

    async function adjust(kind: 'grant' | 'adjustment', deltaUnits: string) {
      const response = await admin.post(`/api/v1/admin/users/${identity.id}/balance-adjustments`, {
        headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { kind, deltaUnits, reason: 'Local full-workflow fixture' },
      });
      expect(response.status(), await response.text()).toBe(201);
    }
    async function balance(): Promise<string> {
      const response = await page.context().request.get('/api/v1/account/balance');
      expect(response.status()).toBe(200); return (await response.json()).data.balance_units;
    }
    await adjust('grant', '1000000');
    const visibleModels = await gateway.get('/v1/models', { headers: bearer });
    expect(visibleModels.status()).toBe(200);
    expect((await visibleModels.json()).data.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(Object.values(models)));
    const beforeCalls = (await (await admin.get('/__test__/calls', { headers: control })).json()).calls.length;
    let expectedBalance = 1_000_000n;
    const requestIds: string[] = [];
    for (const downstream of protocols) for (const upstream of protocols) for (const streaming of [false, true]) {
      // A request may validly ask for less than the configured default of 16.
      const outputLimit = upstream === 'messages' && !streaming ? 8 : 16;
      const response = await gateway.post(paths[downstream], { headers: bearer, data: wireInput(downstream, models[upstream], streaming, outputLimit) });
      const text = await response.text();
      expect(response.status(), `${downstream}/${upstream}/${streaming}: ${text}`).toBe(200);
      requestIds.push(response.headers()['x-request-id']!);
      if (!streaming) {
        const value = JSON.parse(text); expect(value.model).toBe(models[upstream]);
        if (downstream === 'chat') expect(value.choices[0].message.content).toBe(answer);
        else if (downstream === 'responses') expect(value.output.find((item: { type: string }) => item.type === 'message').content[0].text).toBe(answer);
        else { expect(value.content[0].text).toBe(answer); expect(value.usage.input_tokens).toBe(10); expect(value.usage.output_tokens).toBe(5); }
      } else {
        expect(text).toContain(answer);
        const events = frames(text);
        expect(events.some(event => event.type === 'error' || (event.error !== undefined && event.error !== null))).toBe(false);
        if (downstream === 'chat') { expect(text).toContain('[DONE]'); expect(events.some(event => Object.hasOwn(event, 'usage'))).toBe(false); }
        else if (downstream === 'responses') expect(events.some(event => event.type === 'response.completed')).toBe(true);
        else {
          const start = events.find(event => event.type === 'message_start');
          const end = events.find(event => event.type === 'message_delta');
          expect(start?.message.usage).toBeTruthy(); expect(end?.usage).toBeTruthy();
          expect(end?.delta.usage).toBeUndefined();
          const cumulative = { ...start!.message.usage, ...end!.usage };
          expect(cumulative.input_tokens).toBe(10); expect(cumulative.output_tokens).toBe(5);
          expect(events.at(-1)?.type).toBe('message_stop');
        }
      }
      expectedBalance -= 1500n;
      await expect.poll(balance).toBe(expectedBalance.toString());
    }
    expect(new Set(requestIds).size).toBe(18);
    const observed = (await (await admin.get('/__test__/calls', { headers: control })).json()).calls.slice(beforeCalls);
    expect(observed).toHaveLength(18); expect(observed.some((item: { platformCredentialLeaked: boolean }) => item.platformCredentialLeaked)).toBe(false);
    const consumed = await page.context().request.get('/api/v1/billing/entries?kind=consumption&limit=100');
    expect((await consumed.json()).data.items).toHaveLength(18);

    await adjust('adjustment', (1n - expectedBalance).toString());
    const overdrawn = await gateway.post(paths.chat, { headers: bearer, data: wireInput('chat', models.chat, false) });
    expect(overdrawn.status()).toBe(200); await expect.poll(balance).toBe('-1499');
    const denied = await gateway.post(paths.chat, { headers: bearer, data: wireInput('chat', models.chat, false) });
    expect(denied.status()).toBe(402);
    await adjust('grant', '100000');
    const restored = await gateway.post(paths.messages, { headers: bearer, data: wireInput('messages', models.messages, false) });
    expect(restored.status()).toBe(200); await expect.poll(balance).toBe('97001');
    const ledger = (await (await page.context().request.get('/api/v1/billing/entries?limit=100')).json()).data.items;
    expect(ledger.reduce((sum: bigint, entry: { deltaUnits: string }) => sum + BigInt(entry.deltaUnits), 0n).toString()).toBe('97001');
    await page.goto('/billing'); await expect(page.getByRole('table')).toBeVisible();
    const requests = (await (await page.context().request.get('/api/v1/usage/requests?limit=100')).json()).data.items;
    expect(requests).toHaveLength(20);
    expect(requests.every((item: { billing_status: string }) => item.billing_status === 'settled')).toBe(true);
  } finally { await gateway.dispose(); await admin.dispose(); }
});
