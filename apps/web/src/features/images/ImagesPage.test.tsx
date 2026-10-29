import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor } from '../../test/render';
import { createApiClient } from '@cheapai/api-client/client';
import type { ImageJob } from '@cheapai/contracts/images';
import { useSession } from '../session/public';
import ImagesPage from '../../pages/images/ImagesPage';

vi.mock('../session/useSession', () => ({ useSession: vi.fn() }));
const prompt = '水彩画，一只坐在窗边的猫';
const choice = {
  modelId: 'image-model',
  name: 'Image model',
  groupId: 'group',
  groupName: '标准组',
  sizes: ['1024x1024'],
  priceUnits: '5000000',
};
const job = (operationId: string): ImageJob => ({
  id: 'job',
  operationId,
  modelId: choice.modelId,
  modelName: choice.name,
  groupId: 'group',
  prompt,
  size: '1024x1024',
  status: 'completed',
  error: null,
  priceUnits: '5000000',
  billingStatus: 'settled',
  createdAt: 1,
  updatedAt: 2,
});
function envelope(data: unknown) {
  return Response.json({ data, request_id: 'images-test' });
}
function setup(generate: (body: Record<string, unknown>) => Promise<Response>) {
  const send = vi.fn(generate);
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    if (path === '/api/v1/images/models') return envelope({ items: [choice], available: true });
    if (path === '/api/v1/images/generations' && init?.method === 'POST')
      return send(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (path === '/api/v1/images/generations') return envelope({ items: [], nextCursor: null });
    throw new Error('Unexpected request');
  });
  const client = createApiClient({ fetch: fetcher, getCsrfToken: () => 'csrf-token' });
  vi.mocked(useSession).mockReturnValue({
    client,
    user: { id: 'owner', role: 'user' },
    epoch: 1,
    isAdmin: false,
  } as unknown as ReturnType<typeof useSession>);
  render(
    <MemoryRouter>
      <ImagesPage />
    </MemoryRouter>,
  );
  return send;
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
describe('image generation interaction', () => {
  it('shows the response immediately, prevents duplicate generation, and preserves the next draft', async () => {
    let finish!: (response: Response) => void;
    const send = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    const textbox = screen.getByRole('textbox', { name: '画面描述' });
    await user.type(textbox, prompt);
    await waitFor(() => expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '生成图片' }));
    expect(screen.getByText('正在生成图片…')).toBeVisible();
    expect(screen.getByRole('button', { name: '正在生成图片' })).toBeDisabled();
    expect(textbox).toHaveFocus();
    await user.type(textbox, '下一张图片的描述');
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => finish(envelope(job(String(send.mock.calls[0]![0].operationId)))));
    expect(await screen.findByRole('button', { name: '放大预览图片' })).toBeVisible();
    expect(screen.getByRole('link', { name: '下载图片' })).toHaveAttribute(
      'href',
      '/api/v1/images/generations/job/content?download=1',
    );
    expect(textbox).toHaveValue('下一张图片的描述');
    expect(screen.queryByText('正在生成图片…')).toBeNull();
  });
  it('confirms a network failure with the original operation instead of creating another one', async () => {
    let first = true;
    const send = setup(async (body) => {
      if (first) {
        first = false;
        throw new Error('network');
      }
      return envelope(job(String(body.operationId)));
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), prompt);
    await user.click(await screen.findByRole('button', { name: '生成图片' }));
    await user.click(await screen.findByRole('button', { name: '确认生成结果' }));
    expect(await screen.findByRole('button', { name: '放大预览图片' })).toBeVisible();
    expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
  });
  it('retains a rejected prompt and permits editing another request', async () => {
    setup(async () =>
      Response.json(
        {
          error: { code: 'insufficient_balance', message: 'Insufficient balance.' },
          request_id: 'images-test',
        },
        { status: 402 },
      ),
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), prompt);
    await user.click(screen.getByRole('button', { name: '生成图片' }));
    await user.click(await screen.findByRole('button', { name: '恢复描述' }));
    expect(screen.getByRole('textbox')).toHaveValue(prompt);
    expect(screen.getByRole('button', { name: '生成图片' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '确认生成结果' })).toBeNull();
  });
  it('does not submit IME confirmation and keeps another account’s pending prompt private', async () => {
    localStorage.setItem(
      'cheapai:image-pending:another-user',
      JSON.stringify({
        operationId: 'secret',
        modelId: 'image-model',
        groupId: 'group',
        prompt: 'private prompt',
        size: '1024x1024',
      }),
    );
    const send = setup(async (body) => envelope(job(String(body.operationId))));
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), prompt);
    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
      keyCode: 229,
    });
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText('private prompt')).toBeNull();
  });
});
