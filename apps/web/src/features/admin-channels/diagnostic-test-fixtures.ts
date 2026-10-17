import type { ChannelModel, ChannelProbeResult, ChannelView } from '@cheapai/api-client/channels';
import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';

export const diagnosticModelA: ChannelModel = {
  publicModelId: 'gpt-demo-a',
  upstreamModel: 'vendor-model-a',
  protocol: 'chat',
  mappingVersion: 2,
  priceVersion: 3,
};

export const diagnosticModelB: ChannelModel = {
  publicModelId: 'gpt-demo-b',
  upstreamModel: 'vendor-model-b',
  protocol: 'responses',
  mappingVersion: 4,
  priceVersion: 5,
};

export function makeChannel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: 'channel-diagnostic-fixture',
    name: 'Diagnostic fixture channel',
    baseUrl: 'https://upstream.example/v1',
    status: 'active',
    priority: 0,
    concurrencyLimit: 10,
    rpmLimit: 60,
    configVersion: 7,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    hasCredential: true,
    models: [diagnosticModelA],
    ...overrides,
  };
}

const responseBody = JSON.stringify({
  id: 'chatcmpl-fixture',
  object: 'chat.completion',
  model: 'vendor-model-a',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
});

export function makeProbeEvidence(overrides: Partial<ProbeEvidence> = {}): ProbeEvidence {
  return {
    requestId: 'worker-request-fixture',
    startedAt: 1_760_000_000_000,
    durationMs: 238,
    execution: 'response_received',
    request: {
      method: 'POST',
      url: 'https://upstream.example/v1/chat/completions',
      headers: {
        Authorization: 'Bearer [REDACTED]',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'vendor-model-a', stream: false }),
      publicModelId: diagnosticModelA.publicModelId,
      upstreamModel: diagnosticModelA.upstreamModel,
    },
    redirects: [],
    response: {
      status: 200,
      url: 'https://upstream.example/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: responseBody,
      format: 'json',
      capturedBytes: responseBody.length,
      complete: true,
      truncated: false,
      redacted: true,
    },
    failure: null,
    phases: [
      { name: 'configuration', durationMs: 5, state: 'completed' },
      { name: 'headers', durationMs: 190, state: 'completed' },
      { name: 'validation', durationMs: 2, state: 'completed' },
    ],
    ...overrides,
  };
}

export function makeProbeResult(overrides: Partial<ChannelProbeResult> = {}): ChannelProbeResult {
  return {
    diagnosticId: 'diag-fixture-001',
    channelId: 'channel-diagnostic-fixture',
    publicModelId: diagnosticModelA.publicModelId,
    protocol: diagnosticModelA.protocol,
    outcome: 'responded',
    upstreamStatus: 200,
    channelVersion: 7,
    mappingVersion: diagnosticModelA.mappingVersion,
    priceVersion: diagnosticModelA.priceVersion,
    mayIncurUpstreamCost: true,
    userBalanceCharged: false,
    evidence: makeProbeEvidence(),
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  return { promise, resolve, reject };
}
