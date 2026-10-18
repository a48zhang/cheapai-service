import { expect, test, type Page } from '@playwright/test';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(page: Page, reject = false) {
  const identity = gate();
  const create = gate();
  const send = gate();
  const timestamp = 1_700_000_000_000;
  const conversation = {
    id: 'start-conversation',
    title: '首次对话',
    groupId: 'standard',
    modelId: 'test-model',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let version = 1;
  let messages: unknown[] = [];
  await page
    .context()
    .addCookies([{ name: '__Host-sub2api_csrf', value: 'start-csrf', url: 'https://127.0.0.1/' }]);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (data: unknown) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data, request_id: 'start-request' }),
      });
    if (path === '/api/v1/auth/me') {
      await identity.promise;
      return reply({
        id: 'start-user',
        email_normalized: 'start@example.invalid',
        role: 'user',
        status: 'active',
        group_id: 'standard',
        group_status: 'active',
        balance_units: '1000000',
        email_verified_at: null,
      });
    }
    if (path === '/api/v1/settings/public')
      return reply({
        registrationMode: 'closed',
        emailVerificationEnabled: false,
        csrfToken: 'a'.repeat(42) + 'A',
      });
    if (path === '/api/v1/chat/models')
      return reply({
        items: [
          {
            id: 'standard',
            name: '标准组',
            billingMultiplier: '1',
            models: [{ publicModelId: 'test-model' }],
          },
        ],
      });
    if (path === '/api/v1/chat/conversations') {
      if (route.request().method() === 'POST') {
        await create.promise;
        return reply(conversation);
      }
      return reply({ items: [], nextCursor: null });
    }
    if (path === '/api/v1/chat/conversations/start-conversation')
      return reply({
        conversation: { ...conversation, version },
        messages,
      });
    if (path === '/api/v1/chat/conversations/start-conversation/messages') {
      await send.promise;
      if (reject)
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'insufficient_balance', message: '余额不足' },
            request_id: 'start-request',
          }),
        });
      const base = {
        conversationId: conversation.id,
        turnIndex: version - 1,
        status: 'completed',
        variant: 1,
        selected: true,
        groupId: conversation.groupId,
        modelId: conversation.modelId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const prompt = {
        ...base,
        id: `start-prompt-${version}`,
        role: 'user',
        content: route.request().postDataJSON().content,
        requestId: null,
      };
      const answer = {
        ...base,
        id: `start-answer-${version}`,
        role: 'assistant',
        content: '首次回答已完成',
        requestId: 'start-request',
      };
      messages = [...messages, prompt, answer];
      version += 1;
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          `event: meta\ndata: ${JSON.stringify({ conversation, userMessage: prompt, assistantMessage: { ...answer, status: 'generating', content: '' } })}\n\n` +
          `event: delta\ndata: ${JSON.stringify({ text: answer.content })}\n\n` +
          `event: done\ndata: ${JSON.stringify({ message: answer, billingStatus: 'settled' })}\n\n`,
      });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  return {
    identity,
    create,
    send,
    allowSend: () => {
      reject = false;
    },
  };
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test(`home to first answer retains content and composer position at width ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const api = await fixture(page);
    await page.goto('/');
    await page
      .getByRole('main')
      .getByRole('link', { name: '开始对话', exact: true })
      .first()
      .click();
    const input = page.getByRole('textbox', { name: '消息内容' });
    await expect(input).toBeVisible();
    await expect(page.getByText('还没有对话', { exact: true })).toHaveCount(0);
    api.identity.release();
    await input.fill('第一条问题');
    const send = page.getByRole('button', { name: '发送', exact: true });
    await expect(send).toBeEnabled();
    // Detect transient blank states between asynchronous stages, beyond polling assertions.
    await page.evaluate(() => {
      const violations: string[] = [];
      Object.assign(window, { chatStartViolations: violations });
      const observer = new MutationObserver(() => {
        const log = document.querySelector('[role="log"]');
        if (!log?.querySelector('article'))
          violations.push(`missing question at ${location.pathname}: ${document.body.innerText}`);
        for (const text of ['正在读取会话…', '原模型已不可用', '在下方输入消息，继续这段对话。']) {
          if (document.body.innerText.includes(text)) violations.push(text);
        }
      });
      document.querySelector('button[type="submit"]')?.addEventListener(
        'click',
        () => {
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        },
        { once: true },
      );
    });
    await send.click();
    const log = page.getByRole('log', { name: '对话消息' });
    await expect(log.getByRole('article', { name: '待确认的消息' })).toContainText('第一条问题');
    await expect(input).toHaveValue('');
    await input.fill('下一条草稿');
    const inputTop = await input.evaluate((element) => element.getBoundingClientRect().top);
    await page.screenshot({ path: testInfo.outputPath('creating.png') });
    api.create.release();
    await expect(page).toHaveURL(/\/chat\/start-conversation$/);
    await expect(log.getByRole('article', { name: '待确认的消息' })).toContainText('第一条问题');
    await expect(input).toHaveValue('下一条草稿');
    expect(await input.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
      inputTop,
      0,
    );
    api.send.release();
    await expect(log.getByRole('article', { name: '你的消息', exact: true })).toHaveCount(1);
    await expect(log).toContainText('首次回答已完成');
    await expect(log.getByRole('article', { name: '待确认的消息' })).toHaveCount(0);
    await expect(input).toHaveValue('下一条草稿');
    await expect(send).toBeEnabled();
    expect(await input.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
      inputTop,
      0,
    );
    await page.screenshot({ path: testInfo.outputPath('completed.png') });
    expect(
      await page.evaluate(
        () => (window as unknown as { chatStartViolations: string[] }).chatStartViolations,
      ),
    ).toEqual([]);
  });
}

test('a rejected first send preserves both the original question and a newer draft', async ({
  page,
}) => {
  const api = await fixture(page, true);
  api.identity.release();
  api.create.release();
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('被拒绝的原问题');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/start-conversation$/);
  await input.fill('不要覆盖的新草稿');
  await expect(input).toHaveValue('不要覆盖的新草稿');
  api.send.release();
  const submission = page.getByRole('article', { name: '待确认的消息' });
  await expect(submission).toContainText('未发送');
  await expect(submission).toContainText('被拒绝的原问题');
  await expect(input).toHaveValue('不要覆盖的新草稿');
  await expect(submission.getByRole('button', { name: '复制问题' })).toHaveCount(0);
  await expect(submission.getByRole('button', { name: '编辑问题' })).toHaveCount(0);
  api.allowSend();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('article', { name: '你的消息' })).toContainText('不要覆盖的新草稿');
  await expect(submission).toContainText('被拒绝的原问题');
  await input.fill('重试期间保留的草稿');
  await submission.getByRole('button', { name: '重试发送' }).click();
  await expect(submission).toHaveCount(0);
  await expect(page.getByRole('article', { name: '你的消息' }).last()).toContainText(
    '被拒绝的原问题',
  );
  await expect(input).toHaveValue('重试期间保留的草稿');
});

test('a failed conversation read keeps the draft and requires a successful retry before sending', async ({
  page,
}) => {
  const api = await fixture(page);
  api.identity.release();
  let failing = true;
  await page.route('**/api/v1/chat/conversations/start-conversation', (route) =>
    failing ? route.fulfill({ status: 503, body: 'temporarily unavailable' }) : route.fallback(),
  );
  await page.goto('/chat/start-conversation');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('保留读取失败时的草稿');
  await expect(page.getByText('会话读取失败，请重试。', { exact: true })).toBeVisible();
  await expect(page.getByText('在下方输入消息，继续这段对话。', { exact: true })).toHaveCount(0);
  const send = page.getByRole('button', { name: '发送', exact: true });
  await expect(send).toBeDisabled();
  failing = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue('保留读取失败时的草稿');
});

test('unknown conversation creation can restart while preserving the question and new draft', async ({
  page,
}) => {
  const api = await fixture(page);
  api.identity.release();
  api.create.release();
  api.send.release();
  let creates = 0;
  await page.route('**/api/v1/chat/conversations', async (route) => {
    if (route.request().method() === 'POST' && ++creates === 1)
      return route.fulfill({ status: 503, body: 'response unavailable' });
    return route.fallback();
  });
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('创建失败前的问题');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新开始', exact: true })).toBeVisible();
  await input.fill('保留新草稿');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  expect(creates).toBe(1);
  await page.getByRole('button', { name: '重新开始', exact: true }).click();
  await expect(input).toHaveValue('保留新草稿');
  await page.getByRole('button', { name: '重试发送', exact: true }).click();
  await expect(page.getByRole('article', { name: '你的消息' })).toContainText('创建失败前的问题');
  await expect(input).toHaveValue('保留新草稿');
  expect(creates).toBe(2);
});

for (const width of [320, 375, 1440]) {
  test(`navigation controls fit and remain clickable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/v1/auth/me', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'unauthorized', message: 'Sign in' },
          request_id: 'login-fixture',
        }),
      }),
    );
    await page.route('**/api/v1/settings/public', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          request_id: 'login-fixture',
          data: {
            registrationMode: 'closed',
            emailVerificationEnabled: false,
            csrfToken: 'a'.repeat(42) + 'A',
          },
        }),
      }),
    );
    await page.goto('/');
    const login = page.locator('.home-header').getByRole('link', { name: '登录' });
    await expect(login).toBeVisible();
    const bounds = await login.boundingBox();
    expect(bounds!.height).toBeLessThan(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width < 768) {
      const menu = page.getByRole('button', { name: '打开导航' });
      expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(38);
      await menu.click();
      await expect(page.getByRole('navigation', { name: '移动端首页导航' })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`) });
    await login.click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/chat');
    const input = page.getByRole('textbox', { name: '消息内容' });
    await input.fill('手机草稿');
    if (width < 768) {
      const fresh = page.getByRole('button', { name: '新对话', exact: true });
      const before = await fresh.boundingBox();
      await fresh.click();
      await expect(fresh).toBeVisible();
      expect(await fresh.boundingBox()).toEqual(before);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`chat-${width}.png`) });
    await page.getByRole('link', { name: '登录后发送', exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goBack();
    await expect(input).toHaveValue('手机草稿');
  });
}

test('signing in returns to chat with the anonymous draft intact', async ({ page }) => {
  const api = await fixture(page);
  api.identity.release();
  let signedIn = false;
  await page.route('**/api/v1/auth/me', (route) =>
    signedIn
      ? route.fallback()
      : route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'unauthorized', message: 'Sign in' },
            request_id: 'login-fixture',
          }),
        }),
  );
  await page.route('**/api/v1/auth/login', (route) => {
    signedIn = true;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        request_id: 'login-fixture',
        data: {
          id: 'start-user',
          email_normalized: 'start@example.invalid',
          role: 'user',
          status: 'active',
          group_id: 'standard',
          group_status: 'active',
          balance_units: '1000000',
          email_verified_at: null,
        },
      }),
    });
  });
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: '消息内容' });
  await input.fill('登录后继续的问题');
  await page.getByRole('link', { name: '登录后发送', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill('start@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill('local-fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(input).toHaveValue('登录后继续的问题');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
});
