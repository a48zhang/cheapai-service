import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const requestId = 'channel-diagnostics-browser-fixture';
const channelId = 'diagnostics-channel-fixture';
const channelName = 'Diagnostic fixture channel';

const models = [
  {
    publicModelId: 'fixture-chat-model',
    upstreamModel: 'fixture-chat-upstream',
    protocol: 'chat' as const,
    mappingVersion: 2,
    priceVersion: 3,
  },
  {
    publicModelId: 'fixture-messages-model',
    upstreamModel: 'fixture-messages-upstream',
    protocol: 'messages' as const,
    mappingVersion: 4,
    priceVersion: 5,
  },
];

const channel = {
  id: channelId,
  name: channelName,
  baseUrl: 'https://upstream.example.invalid/v1',
  status: 'active' as const,
  priority: 1,
  concurrencyLimit: Number.MAX_SAFE_INTEGER,
  rpmLimit: Number.MAX_SAFE_INTEGER,
  configVersion: 6,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  hasCredential: true,
  models,
};

const longResponseBody =
  '<script>window.__fixtureDiagnosticExecuted=true</script>\n' +
  'provider diagnostic text remains plain text; fixture credential is [REDACTED].\n'.repeat(330);

interface ProbeInput {
  readonly publicModelId: string;
  readonly protocol: 'chat' | 'messages';
  readonly channelVersion: number;
  readonly mappingVersion: number;
  readonly priceVersion: number;
}

interface BrowserFixtureState {
  readonly probes: ProbeInput[];
  readonly unexpected: string[];
  mode: 'respond' | 'drop' | 'hold';
  onProbeStarted: (() => void) | null;
  onProbeFinished: (() => void) | null;
  releaseProbe: (() => void) | null;
}

function jsonReply(data: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ data, request_id: requestId }),
  };
}

function diagnosticResult(input: ProbeInput) {
  const model = models.find((item) => item.publicModelId === input.publicModelId)!;
  const body =
    model.protocol === 'messages'
      ? {
          model: model.upstreamModel,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          stream: false,
        }
      : {
          model: model.upstreamModel,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          max_tokens: 16,
          stream: false,
        };
  const url =
    model.protocol === 'messages'
      ? 'https://upstream.example.invalid/v1/messages'
      : 'https://upstream.example.invalid/v1/chat/completions';
  return {diagnosticId: 'diagnostic-browser-fixture', channelId, publicModelId: input.publicModelId, protocol: input.protocol, outcome: 'http_error', upstreamStatus: 500, channelVersion: input.channelVersion, mappingVersion: input.mappingVersion, priceVersion: input.priceVersion, mayIncurUpstreamCost: true, userBalanceCharged: false, evidence: {
      requestId,
      startedAt: 1_700_000_000_000,
      durationMs: 842,
      execution: 'response_received',
      request: {
        method: 'POST',
        url,
        headers:
          model.protocol === 'messages'
            ? {
                'content-type': 'application/json',
                'x-api-key': '[REDACTED]',
                'anthropic-version': '2023-06-01',
              }
            : { 'content-type': 'application/json', authorization: 'Bearer [REDACTED]' },
        body: JSON.stringify(body),
        publicModelId: model.publicModelId,
        upstreamModel: model.upstreamModel,
      },
      redirects: [],
      response: {
        status: 500,
        url,
        headers: { 'content-type': 'text/html', 'x-request-id': 'upstream-fixture-request' },
        body: longResponseBody,
        format: 'text',
        capturedBytes: longResponseBody.length,
        complete: true,
        truncated: false,
        redacted: true,
      },
      failure: {
        source: 'upstream',
        phase: 'headers',
        code: 'upstream_http_error',
        message: 'Fixture upstream returned HTTP 500.',
        issues: [],
      },
      phases: [
        { name: 'configuration', durationMs: 1, state: 'completed' },
        { name: 'upstream', durationMs: 842, state: 'completed' },
      ],
    }};
}

async function installAdminFixtures(page: Page): Promise<BrowserFixtureState> {
  const state: BrowserFixtureState = {
    probes: [],
    unexpected: [],
    mode: 'respond',
    onProbeStarted: null,
    onProbeFinished: null,
    releaseProbe: null,
  };
  await page.context().addCookies([
    {
      name: '__Host-sub2api_csrf',
      value: 'channel-diagnostics-csrf-fixture',
      url: 'https://127.0.0.1/',
    },
  ]);
  await page.addInitScript(() => {
    const target = window as Window & {
      __diagnosticClipboard: string[];
      __fixtureDiagnosticExecuted: boolean;
    };
    target.__diagnosticClipboard = [];
    target.__fixtureDiagnosticExecuted = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          target.__diagnosticClipboard.push(value);
        },
      },
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (data: unknown, status = 200) => route.fulfill(jsonReply(data, status));

    if (path === '/api/v1/auth/me' && request.method() === 'GET') {
      return reply({
        id: 'diagnostics-admin-fixture',
        email_normalized: 'diagnostics@example.invalid',
        role: 'admin',
        status: 'active',
        group_id: 'diagnostics-group-fixture',
        group_status: 'active',
        balance_units: '0',
        email_verified_at: null,
      });
    }
    if (path === '/api/v1/settings/public' && request.method() === 'GET') {
      return reply({
        registrationMode: 'closed',
        emailVerificationEnabled: false,
        csrfToken: 'channel-diagnostics-csrf-fixture',
      });
    }
    if (path === '/api/v1/admin/channels' && request.method() === 'GET') {
      return reply({ items: [channel], nextCursor: null });
    }
    if (path === `/api/v1/admin/channels/${channelId}` && request.method() === 'GET') {
      return reply(channel);
    }
    if (/^\/api\/v1\/admin\/models\/[^/]+\/mappings$/u.test(path) && request.method() === 'GET') {
      return reply({ items: [] });
    }
    if (path === `/api/v1/admin/channels/${channelId}/test` && request.method() === 'POST') {
      // This is a browser-only route fixture; the Worker and any paid provider are never called.
      const input = request.postDataJSON() as ProbeInput;
      state.probes.push(input);
      const onProbeStarted = state.onProbeStarted;
      state.onProbeStarted = null;
      if (state.mode === 'hold') {
        await new Promise<void>((resolve) => {
          state.releaseProbe = resolve;
          onProbeStarted?.();
        });
        try {
          await route.abort('failed');
        } catch {
          // A confirmed close may abort the browser request before the fixture is released.
        }
        state.releaseProbe = null;
        const onProbeFinished = state.onProbeFinished;
        state.onProbeFinished = null;
        onProbeFinished?.();
        return;
      }
      onProbeStarted?.();
      if (state.mode === 'drop') return route.abort('failed');
      return reply(diagnosticResult(input));
    }

    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'not_found', message: 'Unexpected browser fixture request.' },
        request_id: requestId,
      }),
    });
  });
  return state;
}

test('channel diagnostics from list and detail show only the explicit, intercepted probe', async ({
  page,
}) => {
  const fixture = await installAdminFixtures(page);
  await page.goto('/admin/channels');
  const row = page.getByRole('row').filter({ hasText: channelName });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '诊断', exact: true }).click();

  const panel = page.getByRole('dialog', { name: '渠道诊断' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(channelName);
  const mainTabs = panel.getByRole('tablist', { name: '渠道诊断内容' });
  await expect(mainTabs.getByRole('tab')).toHaveCount(3);
  expect(fixture.probes).toHaveLength(0);

  const resultTab = panel.getByRole('tab', { name: '结果', exact: true });
  const requestTab = panel.getByRole('tab', { name: '请求', exact: true });
  await resultTab.focus();
  await resultTab.press('ArrowRight');
  await expect(requestTab).toHaveAttribute('aria-selected', 'true');
  const requestTabs = panel.getByRole('tablist', { name: '请求内容' });
  await expect(requestTabs.getByRole('tab')).toHaveCount(3);
  await panel.getByRole('button', { name: '复制请求正文', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as Window & { __diagnosticClipboard: string[] }).__diagnosticClipboard,
    ),
  ).toHaveLength(1);
  await requestTabs.getByRole('tab', { name: 'Headers', exact: true }).click();
  const requestHeaders = panel.getByLabel('请求头文本');
  await expect(requestHeaders).toContainText('[REDACTED]');
  await expect(requestHeaders).not.toContainText('fixture-secret');
  expect(fixture.probes).toHaveLength(0);

  await panel.getByRole('combobox', { name: '选择模型映射' }).click();
  await page
    .getByRole('option', { name: 'fixture-messages-model · messages', exact: true })
    .click();
  expect(fixture.probes).toHaveLength(0);
  await panel.getByRole('button', { name: '运行诊断', exact: true }).click();
  await expect.poll(() => fixture.probes.length).toBe(1);
  await expect(panel.getByRole('tab', { name: '结果', exact: true })).toBeEnabled();
  expect(fixture.probes[0]).toMatchObject({
    publicModelId: 'fixture-messages-model',
    protocol: 'messages',
    channelVersion: 6,
    mappingVersion: 4,
    priceVersion: 5,
  });

  await panel.getByRole('tab', { name: '结果', exact: true }).click();
  await expect(panel.getByText('上游返回 HTTP 500。', { exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: '响应', exact: true }).click();
  const responseArea = panel.getByRole('region', { name: '上游响应' });
  await expect(responseArea.getByLabel('响应正文文本')).toContainText(
    '<script>window.__fixtureDiagnosticExecuted=true</script>',
  );
  await expect(responseArea.locator('script')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __fixtureDiagnosticExecuted: boolean }).__fixtureDiagnosticExecuted,
    ),
  ).toBe(false);
  const responseText = responseArea.getByLabel('响应正文文本');
  await expect
    .poll(() => responseText.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await responseArea.getByRole('button', { name: '复制响应正文', exact: true }).click();
  const copied = await page.evaluate(
    () => (window as Window & { __diagnosticClipboard: string[] }).__diagnosticClipboard,
  );
  expect(copied.at(-1)).toBe(longResponseBody);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: '请求', exact: true }).click();
  await panel.getByRole('tab', { name: 'cURL', exact: true }).click();
  const curlText = await panel.getByLabel('cURL 命令预览文本').textContent();
  expect(curlText).toContain('${CHEAPAI_UPSTREAM_KEY}');
  expect(curlText).not.toContain('fixture-secret');
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('tab', { name: '结果', exact: true }).click();
  await panel.getByRole('button', { name: '下载诊断 JSON', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^cheapai-diagnostic-.*\.json$/u);
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(exported.evidence.request.headers['x-api-key']).toBe('[REDACTED]');
  expect(exported.evidence.response.body).toContain('[REDACTED]');
  expect(JSON.stringify(exported)).not.toContain('fixture-secret');
  expect(fixture.probes).toHaveLength(1);

  await panel.getByRole('combobox', { name: '选择模型映射' }).click();
  await page.getByRole('option', { name: 'fixture-chat-model · chat', exact: true }).click();
  await expect(panel.getByText('运行诊断后查看结果。', { exact: true })).toBeVisible();
  expect(fixture.probes).toHaveLength(1);

  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/admin/channels/${channelId}`);
  await expect(page.getByRole('button', { name: '连接诊断', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  await expect(panel).toBeVisible();
  expect(fixture.probes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test('a dropped diagnostic request is unconfirmed and never fabricates an upstream response', async ({
  page,
}) => {
  const fixture = await installAdminFixtures(page);
  fixture.mode = 'drop';
  await page.goto(`/admin/channels/${channelId}`);
  await page.getByRole('button', { name: '连接诊断', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '渠道诊断' });
  await panel.getByRole('button', { name: '运行诊断', exact: true }).click();
  await expect.poll(() => fixture.probes.length).toBe(1);
  await expect(
    panel.getByRole('heading', { name: '诊断结果未确认；无法判断上游是否已经处理请求。' }),
  ).toBeVisible();
  await panel.getByRole('tab', { name: '响应', exact: true }).click();
  await expect(panel.getByText('结果未确认', { exact: true })).toBeVisible();
  await expect(panel.getByText('HTTP 500', { exact: true })).toHaveCount(0);
  expect(fixture.probes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test('closing during a diagnostic requires an explicit browser confirmation', async ({ page }) => {
  const fixture = await installAdminFixtures(page);
  fixture.mode = 'hold';
  const started = new Promise<void>((resolve) => {
    fixture.onProbeStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    fixture.onProbeFinished = resolve;
  });
  await page.goto('/admin/channels');
  const row = page.getByRole('row').filter({ hasText: channelName });
  await row.getByRole('button', { name: '诊断', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '渠道诊断' });
  await panel.getByRole('button', { name: '运行诊断', exact: true }).click();
  await started;

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('诊断仍在进行');
    await dialog.accept();
  });
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(panel).toBeHidden();
  fixture.releaseProbe?.();
  await finished;
  expect(fixture.probes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test('凭证修复从渠道列表和详情直接打开配置页签并保存', async ({ page }) => {
  const fixture = await installAdminFixtures(page);
  let repaired = false;
  const updates: Record<string, unknown>[] = [];
  await page.route('**/api/v1/admin/channels**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const current = { ...channel, hasCredential: repaired, configVersion: repaired ? 7 : 6 };
    if (path === '/api/v1/admin/channels' && request.method() === 'GET') {
      return route.fulfill(jsonReply({ items: [current], nextCursor: null }));
    }
    if (path === `/api/v1/admin/channels/${channelId}`) {
      if (request.method() === 'PATCH') {
        updates.push(request.postDataJSON());
        repaired = true;
        return route.fulfill(jsonReply({ ...channel, configVersion: 7 }));
      }
      if (request.method() === 'GET') return route.fulfill(jsonReply(current));
    }
    return route.fallback();
  });
  for (const fromDetail of [false, true]) {
    repaired = false;
    await page.goto(fromDetail ? `/admin/channels/${channelId}` : '/admin/channels');
    if (fromDetail) await page.getByRole('button', { name: '连接诊断', exact: true }).click();
    else await page.getByRole('row').filter({ hasText: channelName }).getByRole('button', { name: '诊断', exact: true }).click();
    const diagnostics = page.getByRole('dialog', { name: '渠道诊断' });
    await expect(diagnostics.getByText('渠道缺少上游凭据。', { exact: true })).toBeVisible();
    await diagnostics.getByRole('button', { name: '编辑渠道', exact: true }).click();
    await expect(diagnostics).toHaveCount(0);
    const management = page.getByRole('dialog', { name: /管理渠道/ });
    await expect(management.getByRole('tab', { name: '渠道配置', exact: true })).toHaveAttribute('aria-selected', 'true');
    await management.getByLabel('替换上游凭证', { exact: true }).fill('repair-fixture-key');
    await management.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect.poll(() => updates.length).toBe(fromDetail ? 2 : 1);
    expect(updates.at(-1)).toMatchObject({ upstreamKey: 'repair-fixture-key' });
    await expect(management.getByLabel('替换上游凭证', { exact: true })).toHaveValue('');
    await management.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    await expect(management).toHaveCount(0);
  }
  expect(fixture.probes).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});
