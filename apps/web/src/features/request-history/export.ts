import type { RequestRecord } from '@cheapai/contracts/requests';
import { createAdminRequestsApi, createRequestsApi } from '@cheapai/api-client/requests';
import type { RequestHistoryContext } from './api';
import type { RequestFilters } from './filters';
import { parseRequestListUrl, serializeRequestFilters } from './filters';
import { nextPageCursor } from '../../shared/lib/pagination';
import type { CursorPage } from '../../shared/lib/pagination';
import { formatUnitsToUsd } from '../../shared/lib/money';
import { billingLabels, executionLabels } from './RequestStatus';
import { requestSourceLabel } from './presentation';

/** Always start a fresh cursor chain; visible pages are not the export's dataset. */
export async function collectRequestExport(
  context: RequestHistoryContext,
  filters: RequestFilters,
  signal: AbortSignal,
  onProgress: (count: number) => void,
): Promise<RequestRecord[]> {
  const api =
    context.scope === 'admin'
      ? createAdminRequestsApi(context.client)
      : createRequestsApi(context.client);
  const normalized = parseRequestListUrl(
    serializeRequestFilters(filters, context.scope),
    context.scope,
  ).filters;
  const pages: CursorPage[] = [];
  const records = new Map<string, RequestRecord>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await api.list({ ...normalized, cursor: cursor ?? null }, { signal });
    signal.throwIfAborted();
    pages.push({ nextCursor: page.nextCursor });
    for (const row of page.items) records.set(row.id, row);
    onProgress(records.size);
    cursor = nextPageCursor(page, pages, '导出', (error) => {
      throw error;
    });
  } while (cursor !== undefined);
  return [...records.values()];
}

function cell(value: string | number | null | undefined): string {
  const text = String(value ?? '');
  // Spreadsheet applications must treat identifiers and labels as text, not formulas.
  const safe = /^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function requestExportCsv(rows: readonly RequestRecord[]): string {
  const header = [
    '请求 ID',
    '创建时间（UTC）',
    '模型 ID',
    '来源',
    '执行状态',
    '计费状态',
    '费用（积分）',
    '输入 Tokens',
    '输出 Tokens',
    '总 Tokens',
    '访问组 ID',
    '用户 ID',
  ];
  const records = rows.map((row) => {
    const counts = row.usage && 'counts' in row.usage ? row.usage.counts : undefined;
    return [
      row.id,
      new Date(row.created_at).toISOString(),
      row.public_model_id,
      requestSourceLabel(row.source),
      executionLabels[row.execution_status].label,
      billingLabels[row.billing_status].label,
      row.cost_units === null ? '' : formatUnitsToUsd(row.cost_units),
      counts?.inputTokens,
      counts?.outputTokens,
      counts?.totalTokens,
      row.group_id,
      row.user_id,
    ];
  });
  return (
    '\uFEFF' + [header, ...records].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
  );
}

export function downloadRequestExport(rows: readonly RequestRecord[]): void {
  const url = URL.createObjectURL(
    new Blob([requestExportCsv(rows)], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `usage-requests-${new Date().toISOString().replaceAll(':', '-')}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
