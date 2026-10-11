import {
  CHANNEL_PROBE_MAX_OUTPUT_TOKENS,
  createChannelProbeBody,
} from '@cheapai/contracts/channel-probe';
import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';
import type {
  ChannelModel,
  ChannelProbeResult,
  ChannelProtocol,
  ChannelView,
} from '@cheapai/api-client/channels';

const endpointFor: Readonly<Record<ChannelProtocol, string>> = {
  chat: 'chat/completions',
  responses: 'responses',
  messages: 'messages',
};

export interface DiagnosticPreview {
  readonly kind: 'preview';
  readonly label: '请求预览';
  readonly method: 'POST';
  readonly baseUrl: string;
  readonly url: string | null;
  readonly publicModelId: string;
  readonly upstreamModel: string;
  readonly protocol: ChannelProtocol;
  readonly maxOutputTokens: typeof CHANNEL_PROBE_MAX_OUTPUT_TOKENS;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A clearly marked estimate built from the selected mapping and shared fixed probe template. */
export function createDiagnosticPreview(
  channel: Pick<ChannelView, 'baseUrl'>,
  model: Pick<ChannelModel, 'publicModelId' | 'upstreamModel' | 'protocol'>,
): DiagnosticPreview {
  const body = createChannelProbeBody(
    model.protocol,
    model.upstreamModel,
    CHANNEL_PROBE_MAX_OUTPUT_TOKENS,
  );
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (model.protocol === 'messages') {
    headers['x-api-key'] = '[REDACTED]';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = 'Bearer [REDACTED]';
  }

  return {
    kind: 'preview',
    label: '请求预览',
    method: 'POST',
    baseUrl: redactedPreviewBaseUrl(channel.baseUrl),
    url: previewUrl(channel.baseUrl, model.protocol),
    publicModelId: model.publicModelId,
    upstreamModel: model.upstreamModel,
    protocol: model.protocol,
    maxOutputTokens: CHANNEL_PROBE_MAX_OUTPUT_TOKENS,
    headers,
    body: JSON.stringify(body, null, 2),
  };
}

function redactedPreviewBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.hash = '';
    // Preview has no access to the channel credential. Mask all query values;
    // the actual request preserves allowed values in its server-redacted snapshot.
    for (const name of new Set(url.searchParams.keys())) url.searchParams.set(name, '[REDACTED]');
    return url.toString();
  } catch {
    return '';
  }
}

function previewUrl(baseUrl: string, protocol: ChannelProtocol): string | null {
  try {
    const url = new URL(baseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    url.hash = '';
    for (const name of new Set(url.searchParams.keys())) url.searchParams.set(name, '[REDACTED]');
    const prefix = url.pathname.replace(/\/+$/u, '');
    const lastSegment = prefix
      .slice(prefix.lastIndexOf('/') + 1)
      .replace(/%([\da-f]{2})/giu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    url.pathname = `${prefix}${lastSegment === 'v1' ? '' : '/v1'}/${endpointFor[protocol]}`;
    return url.toString();
  } catch {
    return null;
  }
}

/** Pretty-prints a complete JSON request body while preserving non-JSON source text. */
export function formatDiagnosticRequestBody(body: string | null): string {
  if (body === null || body.length === 0) return '';
  return prettyJson(body) ?? body;
}

/** Keeps text and incomplete fragments verbatim; only complete JSON is parsed for display. */
export function formatDiagnosticResponseBody(
  response: Pick<
    NonNullable<ProbeEvidence['response']>,
    'body' | 'format' | 'complete' | 'truncated'
  > | null,
): string {
  if (response === null || response.body.length === 0) return '';
  if (response.format !== 'json' || !response.complete || response.truncated) return response.body;
  return prettyJson(response.body) ?? response.body;
}

function prettyJson(value: string): string | null {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
}

const sensitiveHeaderName = /authorization|api[-_]?key|token|cookie|secret|password/iu;

/** Formats the server-redacted header snapshot and masks credential header values defensively. */
export function formatDiagnosticHeaders(headers: Readonly<Record<string, string>> | null): string {
  if (headers === null) return '';
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      sensitiveHeaderName.test(name) ? '[REDACTED]' : value,
    ]),
  );
  return JSON.stringify(safeHeaders, null, 2);
}

/** Builds a POSIX-shell cURL command from the actual first-hop snapshot, with auth supplied by env. */
export function formatDiagnosticCurl(request: ProbeEvidence['request']): string | null {
  if (request === null) return null;

  const options = [`--request ${shellQuote(request.method)}`, `--url ${shellQuote(request.url)}`];
  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === 'authorization' || lowerName === 'x-api-key') {
      // The worker's chat and responses transports always use Bearer authorization.
      const prefix = lowerName === 'authorization' ? 'Bearer ' : '';
      options.push(`--header ${shellQuote(`${name}: ${prefix}`)}"\${CHEAPAI_UPSTREAM_KEY}"`);
      continue;
    }
    const safeValue = sensitiveHeaderName.test(name) ? '[REDACTED]' : value;
    options.push(`--header ${shellQuote(`${name}: ${safeValue}`)}`);
  }
  if (request.body !== null) options.push(`--data-raw ${shellQuote(request.body)}`);
  return [`curl ${options[0]}`, ...options.slice(1).map((option) => `  ${option}`)].join(' \\\n');
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/gu, "'\\''") + "'";
}

export interface DiagnosticExportInput {
  readonly result: ChannelProbeResult | null;
  readonly partialEvidence?: ProbeEvidence | null | undefined;
  readonly partialDiagnosticId?: string | null | undefined;
  readonly apiError?: { readonly status: number | null; readonly code: string } | null | undefined;
}

/** Serializes only fields from decoded result/evidence and the reviewed status/code of an API error. */
export function formatDiagnosticExport(input: DiagnosticExportInput): string {
  const result = input.result;
  const evidence = result?.evidence ?? input.partialEvidence ?? null;
  return JSON.stringify(
    {
      diagnosticId: result?.diagnosticId ?? input.partialDiagnosticId ?? null,
      channelId: result?.channelId ?? null,
      publicModelId: result?.publicModelId ?? null,
      protocol: result?.protocol ?? null,
      outcome: result?.outcome ?? null,
      upstreamStatus: result?.upstreamStatus ?? evidence?.response?.status ?? null,
      channelVersion: result?.channelVersion ?? null,
      mappingVersion: result?.mappingVersion ?? null,
      priceVersion: result?.priceVersion ?? null,
      maxOutputTokens: result?.maxOutputTokens ?? null,
      mayIncurUpstreamCost: result?.mayIncurUpstreamCost ?? null,
      userBalanceCharged: result?.userBalanceCharged ?? null,
      apiError:
        input.apiError === undefined || input.apiError === null
          ? null
          : { status: input.apiError.status, code: input.apiError.code },
      evidence,
    },
    null,
    2,
  );
}
