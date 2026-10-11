import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { SessionIdentity } from '@cheapai/api-client/types';
import type { ChannelProbeResult, ChannelView } from '@cheapai/api-client/channels';
import type { AdminChannelsApi } from './api';
import { ChannelDiagnostics } from './ChannelDiagnostics';
import {
  deferred,
  diagnosticModelA,
  diagnosticModelB,
  makeChannel,
  makeProbeEvidence,
  makeProbeResult,
} from './diagnostic-test-fixtures';

function makeApi() {
  const probe = vi.fn<AdminChannelsApi['probe']>();
  const api = { probe } as unknown as AdminChannelsApi;
  return { api, probe };
}

function panel(
  channel: ChannelView,
  api: AdminChannelsApi,
  onOpenChange: (open: boolean) => void,
  sessionIdentity: SessionIdentity | null = { userId: 'admin-1', epoch: 1 },
) {
  return (
    <ChannelDiagnostics
      open
      channel={channel}
      api={api}
      onOpenChange={onOpenChange}
      sessionIdentity={sessionIdentity}
      onRepair={vi.fn()}
    />
  );
}

function responseResult(body: string, status: number, format: 'json' | 'text' = 'text') {
  const url = 'https://upstream.example/v1/chat/completions';
  const evidence = makeProbeEvidence({
    execution: 'response_received',
    response: {
      status,
      url,
      headers: { 'Content-Type': format === 'json' ? 'application/json' : 'text/html' },
      body,
      format,
      capturedBytes: new TextEncoder().encode(body).byteLength,
      complete: true,
      truncated: false,
      redacted: true,
    },
    failure: null,
  });
  return makeProbeResult({
    outcome: status >= 400 ? 'http_error' : 'invalid_response',
    upstreamStatus: status,
    evidence,
  });
}

function blobDownloadMocks() {
  const recordedBlobs: Array<{ parts: BlobPart[]; type: string }> = [];
  const NativeBlob = globalThis.Blob;
  class RecordedBlob extends NativeBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      recordedBlobs.push({ parts: parts ?? [], type: this.type });
    }
  }

  const NativeURL = globalThis.URL;
  const createObjectURL = vi.fn(() => 'blob:diagnostic-fixture');
  const revokeObjectURL = vi.fn();
  class RecordedURL extends NativeURL {}
  Object.defineProperties(RecordedURL, {
    createObjectURL: { configurable: true, value: createObjectURL },
    revokeObjectURL: { configurable: true, value: revokeObjectURL },
  });

  vi.stubGlobal('Blob', RecordedBlob);
  vi.stubGlobal('URL', RecordedURL);
  const anchorClick = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);

  return { recordedBlobs, createObjectURL, revokeObjectURL, anchorClick, RecordedBlob };
}

function installRadixSelectDomStubs() {
  const methodNames = [
    'setPointerCapture',
    'hasPointerCapture',
    'releasePointerCapture',
    'scrollIntoView',
  ] as const;
  const originalDescriptors = new Map(
    methodNames.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
  );
  const capturedPointers = new WeakMap<HTMLElement, Set<number>>();

  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        const pointers = capturedPointers.get(this) ?? new Set<number>();
        pointers.add(pointerId);
        capturedPointers.set(this, pointers);
      },
    },
    hasPointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        return capturedPointers.get(this)?.has(pointerId) ?? false;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        const pointers = capturedPointers.get(this);
        pointers?.delete(pointerId);
        if (pointers?.size === 0) capturedPointers.delete(this);
      },
    },
    scrollIntoView: { configurable: true, value: vi.fn() },
  });

  return () => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
      else Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  };
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChannelDiagnostics', () => {
  it('does not call the diagnostic API when the panel opens or its tabs change', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    const onOpenChange = vi.fn();

    render(panel(makeChannel(), api, onOpenChange));

    expect(probe).not.toHaveBeenCalled();
    await user.click(screen.getByRole('tab', { name: '请求' }));
    await user.click(screen.getByRole('tab', { name: '响应' }));
    await user.click(screen.getByRole('tab', { name: '结果' }));

    expect(probe).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('sends one probe for rapid repeated clicks and accepts the busy close confirmation', async () => {
    const pending = deferred<ChannelProbeResult>();
    const { api, probe } = makeApi();
    probe.mockReturnValue(pending.promise);
    const onOpenChange = vi.fn();
    render(panel(makeChannel(), api, onOpenChange));

    const run = screen.getByRole('button', { name: '运行诊断' });
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(run).toBeDisabled();

    await userEvent.setup().click(screen.getByRole('button', { name: '关闭' }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      pending.resolve(makeProbeResult());
      await pending.promise;
    });
  });

  it('clears a completed result when a different mapping is selected', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    probe.mockResolvedValue(makeProbeResult());
    render(panel(makeChannel({ models: [diagnosticModelA, diagnosticModelB] }), api, vi.fn()));

    await user.click(screen.getByRole('button', { name: '运行诊断' }));
    await within(screen.getByRole('region', { name: '诊断结果' })).findByText('校验通过');
    await user.click(screen.getByText('运行详情'));
    expect(screen.getByText('diag-fixture-001')).toBeInTheDocument();

    const restoreSelectDom = installRadixSelectDomStubs();
    try {
      await user.click(screen.getByRole('combobox', { name: '选择模型映射' }));
      await user.click(await screen.findByRole('option', { name: 'gpt-demo-b · responses' }));
    } finally {
      restoreSelectDom();
    }

    expect(screen.queryByText('diag-fixture-001')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '诊断结果' })).getByText('尚无结果'),
    ).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps only the current channel or identity when a prior probe resolves late', async () => {
    const user = userEvent.setup();
    const contextChanges: readonly ('channel' | 'identity')[] = ['channel', 'identity'];

    for (const contextChange of contextChanges) {
      const pending = deferred<ChannelProbeResult>();
      const { api, probe } = makeApi();
      probe.mockReturnValue(pending.promise);
      const onOpenChange = vi.fn();
      const originalChannel = makeChannel();
      const originalIdentity = { userId: 'admin-1', epoch: 1 };
      const view = render(panel(originalChannel, api, onOpenChange, originalIdentity));

      await user.click(screen.getByRole('button', { name: '运行诊断' }));
      await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      const signal = probe.mock.calls[0]?.[2]?.signal;

      view.rerender(
        panel(
          contextChange === 'channel'
            ? makeChannel({ id: 'channel-next', name: 'Next channel' })
            : originalChannel,
          api,
          onOpenChange,
          contextChange === 'identity' ? { userId: 'admin-2', epoch: 2 } : originalIdentity,
        ),
      );
      expect(signal?.aborted).toBe(true);

      const privateLateBody = `late-result-${contextChange}-marker`;
      await act(async () => {
        pending.resolve(responseResult(privateLateBody, 502));
        await pending.promise;
      });
      await user.click(screen.getByRole('tab', { name: '响应' }));
      expect(screen.queryByText(privateLateBody)).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('region', { name: '上游响应' })).getByText('尚无结果'),
      ).toBeInTheDocument();

      view.unmount();
    }
  });

  it('shows reviewed partial evidence from an API error in the expandable run details', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    const partialEvidence = makeProbeEvidence({
      execution: 'not_started',
      request: null,
      response: null,
      failure: {
        source: 'cheapai',
        phase: 'configuration',
        code: 'version_conflict',
        message: 'The channel configuration changed before the request started.',
        issues: [],
      },
      phases: [{ name: 'configuration', durationMs: 4, state: 'failed' }],
    });
    probe.mockRejectedValueOnce(
      new ApiClientError('http', 'Configuration changed.', {
        status: 409,
        code: 'conflict',
        details: { diagnostic: partialEvidence, diagnosticId: 'diag-partial-fixture' },
      }),
    );
    render(panel(makeChannel(), api, vi.fn()));

    await user.click(screen.getByRole('button', { name: '运行诊断' }));
    const summary = screen.getByRole('region', { name: '诊断结果' });
    expect(await within(summary).findByText('部分证据')).toBeInTheDocument();
    await user.click(screen.getByText('执行过程'));
    expect(screen.getByText('配置检查')).toBeInTheDocument();
    await user.click(screen.getByText('运行详情'));

    expect(screen.getByText('diag-partial-fixture')).toBeInTheDocument();
    expect(screen.getByText('worker-request-fixture')).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('shows the decoded protocol validation path and issue message in the result summary', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    const validationPath = 'choices[0].message.content';
    const validationMessage = 'Expected a string response body.';
    const invalidBody = '{"choices":[]}';
    const evidence = makeProbeEvidence({
      response: {
        status: 200,
        url: 'https://upstream.example/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' },
        body: invalidBody,
        format: 'json',
        capturedBytes: new TextEncoder().encode(invalidBody).byteLength,
        complete: true,
        truncated: false,
        redacted: true,
      },
      failure: {
        source: 'protocol',
        phase: 'validation',
        code: 'invalid_response',
        message: 'The upstream response did not match the selected protocol.',
        issues: [{ path: validationPath, message: validationMessage }],
      },
    });
    probe.mockResolvedValue(
      makeProbeResult({
        outcome: 'invalid_response',
        upstreamStatus: 200,
        evidence,
      }),
    );
    render(panel(makeChannel(), api, vi.fn()));

    await user.click(screen.getByRole('button', { name: '运行诊断' }));

    const summary = screen.getByRole('region', { name: '诊断结果' });
    expect(await within(summary).findByText('诊断失败')).toBeInTheDocument();
    expect(summary).toHaveTextContent(validationPath);
    expect(summary).toHaveTextContent(validationMessage);
    expect(within(summary).getByText('上游 HTTP 200')).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps a management API failure separate from an unknown upstream status', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    probe.mockRejectedValueOnce(
      new ApiClientError('http', 'Administrative service unavailable.', {
        status: 503,
        code: 'service_unavailable',
      }),
    );
    render(panel(makeChannel(), api, vi.fn()));

    await user.click(screen.getByRole('button', { name: '运行诊断' }));

    const summary = screen.getByRole('region', { name: '诊断结果' });
    expect(await within(summary).findByText('状态未知')).toBeInTheDocument();
    expect(summary).toHaveTextContent('503');
    expect(summary).toHaveTextContent('Administrative service unavailable.');
    await user.click(screen.getByRole('tab', { name: '响应' }));
    const response = screen.getByRole('region', { name: '上游响应' });
    expect(response).toHaveTextContent('未提供响应状态');
    expect(response).not.toHaveTextContent(/HTTP 503/u);
  });

  it('does not infer an upstream status from an unclassified API error', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    probe.mockRejectedValueOnce(new Error('Connection reset before a result was received.'));
    render(panel(makeChannel(), api, vi.fn()));

    await user.click(screen.getByRole('button', { name: '运行诊断' }));

    const summary = screen.getByRole('region', { name: '诊断结果' });
    expect(await within(summary).findByText('状态未知')).toBeInTheDocument();
    expect(summary).not.toHaveTextContent(/上游 HTTP \d{3}/u);
    await user.click(screen.getByRole('tab', { name: '响应' }));
    const response = screen.getByRole('region', { name: '上游响应' });
    expect(response).toHaveTextContent('未提供响应状态');
    expect(response).not.toHaveTextContent(/HTTP \d{3}/u);
    expect(response).toHaveTextContent('Connection reset before a result was received.');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('renders an upstream HTML body as inert text', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    const html =
      '<img data-probe-payload src="x" onerror="window.probeExecuted = true">upstream error';
    probe.mockResolvedValue(responseResult(html, 502));
    render(panel(makeChannel(), api, vi.fn()));

    await user.click(screen.getByRole('button', { name: '运行诊断' }));
    await within(screen.getByRole('region', { name: '诊断结果' })).findByText('上游 HTTP 502');
    await user.click(screen.getByRole('tab', { name: '响应' }));

    expect(screen.getByText(html)).toBeInTheDocument();
    expect(document.querySelector('[data-probe-payload]')).toBeNull();
    expect((window as Window & { probeExecuted?: boolean }).probeExecuted).toBeUndefined();
  });

  it('downloads the controlled JSON Blob without sending another diagnostic request', async () => {
    const user = userEvent.setup();
    const { api, probe } = makeApi();
    const privateInternalCause = 'PRIVATE_INTERNAL_STACK_SENTINEL';
    const result = {
      ...makeProbeResult(),
      internalCause: privateInternalCause,
    } as ChannelProbeResult;
    probe.mockResolvedValue(result);
    const download = blobDownloadMocks();
    render(panel(makeChannel(), api, vi.fn()));

    await user.click(screen.getByRole('button', { name: '运行诊断' }));
    await within(screen.getByRole('region', { name: '诊断结果' })).findByText('校验通过');
    await user.click(screen.getByRole('button', { name: '下载诊断 JSON' }));

    expect(download.recordedBlobs).toHaveLength(1);
    expect(download.recordedBlobs[0]?.type).toBe('application/json');
    const exportedText = String(download.recordedBlobs[0]?.parts[0]);
    const exported = JSON.parse(exportedText) as Record<string, unknown>;
    expect(exported.channelId).toBe('channel-diagnostic-fixture');
    expect(exported.evidence).toBeTruthy();
    expect(exported).not.toHaveProperty('internalCause');
    expect(exportedText).not.toContain(privateInternalCause);
    expect(download.createObjectURL).toHaveBeenCalledTimes(1);
    expect(download.createObjectURL).toHaveBeenCalledWith(expect.any(download.RecordedBlob));
    expect(download.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostic-fixture');
    expect(download.anchorClick).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
