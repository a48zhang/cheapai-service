import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';
import { extractChannelDiagnosticErrorDetails } from '@cheapai/api-client/channels';
import type { ChannelProbeResult } from '@cheapai/api-client/channels';
import { ApiClientError } from '@cheapai/api-client/errors';

export type DiagnosticResultState =
  'idle' | 'success' | 'failure' | 'partial' | 'unconfirmed' | 'unknown';
export type DiagnosticResultTone = 'success' | 'warning' | 'danger' | 'neutral';
export type DiagnosticEvidenceState = 'available' | 'partial' | 'legacy' | 'unavailable';

export interface DiagnosticRepairAction {
  readonly kind: 'credentials' | 'mapping' | 'execution';
  readonly label: string;
}

export interface DiagnosticApiErrorView {
  readonly kind: ApiClientError['kind'] | 'unknown';
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string | null;
}

export interface DiagnosticProviderError {
  readonly code: string | null;
  readonly message: string | null;
}

export interface DiagnosticResultView {
  readonly state: DiagnosticResultState;
  readonly tone: DiagnosticResultTone;
  readonly summary: string;
  readonly detail: string | null;
  readonly diagnosticId: string | null;
  readonly outcome: ChannelProbeResult['outcome'] | null;
  readonly upstreamStatus: number | null;
  readonly durationMs: number | null;
  readonly execution: ProbeEvidence['execution'] | null;
  readonly failure: ProbeEvidence['failure'] | null;
  readonly providerError: DiagnosticProviderError | null;
  readonly retryAfter: string | null;
  readonly evidence: ProbeEvidence | null;
  readonly evidenceState: DiagnosticEvidenceState;
  readonly legacyEvidenceMessage: string | null;
  readonly apiError: DiagnosticApiErrorView | null;
  readonly action: DiagnosticRepairAction | null;
}

export interface DiagnosticResultInput {
  readonly result?: ChannelProbeResult | null | undefined;
  readonly error?: unknown;
}

/** Combines decoded success and controlled API error evidence into one presentation model. */
export function createDiagnosticResultView(input: DiagnosticResultInput): DiagnosticResultView {
  const result = input.result ?? null;
  const error = input.error ?? null;
  const apiDetails = error === null ? null : extractChannelDiagnosticErrorDetails(error);
  const evidence = result?.evidence ?? apiDetails?.diagnostic ?? null;
  const apiError = error === null ? null : apiErrorView(error);
  const upstreamStatus = evidence?.response?.status ?? result?.upstreamStatus ?? null;
  const providerError = extractProviderError(evidence, upstreamStatus);
  const outcome = result?.outcome ?? null;
  const failure = evidence?.failure ?? null;
  const state = resultState(result, error, evidence, apiError);
  const action = repairAction(upstreamStatus, providerError, failure, evidence);

  return {
    state,
    tone: toneFor(state),
    summary: summaryFor(state, result, evidence, failure, providerError, apiError, upstreamStatus),
    detail: providerError?.message ?? failure?.message ?? apiError?.message ?? null,
    diagnosticId: result?.diagnosticId ?? apiDetails?.diagnosticId ?? null,
    outcome,
    upstreamStatus,
    durationMs: evidence?.durationMs ?? null,
    execution: evidence?.execution ?? null,
    failure,
    providerError,
    retryAfter: responseHeader(evidence?.response?.headers ?? null, 'retry-after'),
    evidence,
    evidenceState:
      result?.evidence !== undefined
        ? 'available'
        : apiDetails !== null
          ? 'partial'
          : result !== null
            ? 'legacy'
            : 'unavailable',
    legacyEvidenceMessage:
      result !== null && result.evidence === undefined && apiDetails === null
        ? '当前后端未提供请求与响应详情。'
        : null,
    apiError,
    action,
  };
}

function resultState(
  result: ChannelProbeResult | null,
  error: unknown,
  evidence: ProbeEvidence | null,
  apiError: DiagnosticApiErrorView | null,
): DiagnosticResultState {
  if (result === null && error === null) return 'idle';
  if (
    result?.outcome === 'cancelled' ||
    apiError?.kind === 'network' ||
    apiError?.kind === 'aborted'
  ) {
    return 'unconfirmed';
  }
  if (apiError !== null) return evidence === null ? 'unknown' : 'partial';
  if (result?.outcome === 'responded') return 'success';
  if (result !== null) return 'failure';
  return 'unknown';
}

function toneFor(state: DiagnosticResultState): DiagnosticResultTone {
  if (state === 'success') return 'success';
  if (state === 'failure' || state === 'partial') return 'danger';
  if (state === 'idle') return 'neutral';
  return 'warning';
}

function summaryFor(
  state: DiagnosticResultState,
  result: ChannelProbeResult | null,
  evidence: ProbeEvidence | null,
  failure: ProbeEvidence['failure'] | null,
  providerError: DiagnosticProviderError | null,
  apiError: DiagnosticApiErrorView | null,
  upstreamStatus: number | null,
): string {
  if (state === 'idle') return '运行诊断后查看结果。';
  if (state === 'unconfirmed') {
    return '诊断结果未确认；无法判断上游是否已经处理请求。';
  }
  if (failure?.phase === 'audit' && evidence?.execution === 'response_received') {
    return '已收到上游响应，但 CheapAI 未能完成诊断审计。';
  }
  if (evidence?.execution === 'not_started' || failure?.phase === 'configuration') {
    return '诊断请求未发起。';
  }

  if (upstreamStatus !== null && upstreamStatus >= 400) {
    const code = providerError?.code?.toLowerCase() ?? '';
    const providerText =
      `${providerError?.code ?? ''} ${providerError?.message ?? ''}`.toLowerCase();
    if (upstreamStatus === 401) {
      return code === 'invalid_api_key' ? '上游拒绝了渠道凭据。' : '上游返回 401。';
    }
    if (upstreamStatus === 403) {
      return /permission|scope|project|access/u.test(providerText)
        ? '上游拒绝了本次访问；请检查凭据权限或上游项目。'
        : '上游返回 403。';
    }
    if (upstreamStatus === 404) {
      return code === 'model_not_found' ? '上游找不到指定模型。' : '上游返回 404。';
    }
    if (upstreamStatus === 429) {
      if (
        /insufficient[_ -]?quota|quota[_ -]?exceeded|credit[_ -]?balance|billing[_ -]?hard[_ -]?limit/u.test(
          providerText,
        )
      ) {
        return '上游报告额度不足。';
      }
      return '上游限制了本次请求。';
    }
    return `上游返回 HTTP ${upstreamStatus}。`;
  }

  if (failure?.source === 'protocol' || failure?.phase === 'validation') {
    return '上游响应不符合所选协议。';
  }
  if (result?.outcome === 'responded') return '上游响应通过协议校验。';
  if (result?.outcome === 'http_error') {
    return upstreamStatus === null ? '上游返回 HTTP 错误。' : `上游返回 HTTP ${upstreamStatus}。`;
  }
  if (result?.outcome === 'invalid_response') return '上游响应内容无效。';
  if (result?.outcome === 'timeout') return '等待上游响应超时。';
  if (result?.outcome === 'transport_error') return '上游连接未能完成。';
  if (result?.outcome === 'cancelled') return '诊断结果未确认；无法判断上游是否已经处理请求。';
  if (failure !== null) return failure.message;
  if (apiError !== null) {
    if (apiError.status !== null) return `CheapAI 管理 API 返回 HTTP ${apiError.status}。`;
    return apiError.message ?? '诊断请求发生错误。';
  }
  return '诊断请求发生未知错误。';
}

function repairAction(
  upstreamStatus: number | null,
  providerError: DiagnosticProviderError | null,
  failure: ProbeEvidence['failure'] | null,
  evidence: ProbeEvidence | null,
): DiagnosticRepairAction | null {
  const code = providerError?.code?.toLowerCase() ?? '';
  const providerText = `${providerError?.code ?? ''} ${providerError?.message ?? ''}`.toLowerCase();

  if (failure?.code === 'missing_credential') {
    return { kind: 'credentials', label: '编辑渠道凭据' };
  }
  if (upstreamStatus === 401) {
    return {
      kind: 'credentials',
      label: code === 'invalid_api_key' ? '编辑渠道凭据' : '核对渠道凭据',
    };
  }
  if (upstreamStatus === 403 && /permission|scope|project|access/u.test(providerText)) {
    return { kind: 'credentials', label: '检查凭据权限' };
  }
  if (upstreamStatus === 404) {
    return {
      kind: 'mapping',
      label: code === 'model_not_found' ? '编辑模型映射' : '核对 Base URL 与模型映射',
    };
  }
  if (
    (failure?.source === 'protocol' || failure?.phase === 'validation') &&
    evidence?.execution === 'response_received'
  ) {
    return { kind: 'mapping', label: '检查模型映射与协议' };
  }
  if (failure?.phase === 'headers' || failure?.phase === 'body') {
    return { kind: 'execution', label: '查看执行过程' };
  }
  return null;
}

function extractProviderError(
  evidence: ProbeEvidence | null,
  upstreamStatus: number | null,
): DiagnosticProviderError | null {
  const response = evidence?.response;
  if (
    response === null ||
    response === undefined ||
    upstreamStatus === null ||
    upstreamStatus < 400 ||
    response.format !== 'json' ||
    !response.complete ||
    response.truncated
  ) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const error = isRecord(value.error) ? value.error : value;
  const code = stringValue(error.code) ?? stringValue(error.type);
  const message = stringValue(error.message);
  if (code === null && message === null) return null;
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function responseHeader(
  headers: Readonly<Record<string, string>> | null,
  name: string,
): string | null {
  if (headers === null) return null;
  const target = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === target) return value;
  }
  return null;
}

function apiErrorView(error: unknown): DiagnosticApiErrorView {
  if (error instanceof ApiClientError) {
    return {
      kind: error.kind,
      status: error.status,
      code: error.code,
      message: nonEmpty(error.message),
    };
  }
  return {
    kind: 'unknown',
    status: null,
    code: null,
    message:
      error instanceof Error
        ? nonEmpty(error.message)
        : typeof error === 'string'
          ? nonEmpty(error)
          : null,
  };
}

function nonEmpty(value: string): string | null {
  return value.trim().length > 0 ? value : null;
}
