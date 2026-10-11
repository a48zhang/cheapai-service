import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';
import { StatusBadge, type StatusBadgeTone } from '../../shared/ui/StatusBadge';

export interface DiagnosticDetailsProps {
  readonly evidence: ProbeEvidence | null;
  readonly diagnosticId?: string | null;
  readonly channelVersion?: number | null;
  readonly mappingVersion?: number | null;
  readonly priceVersion?: number | null;
}

const executionPresentation: Record<
  ProbeEvidence['execution'],
  { label: string; tone: StatusBadgeTone }
> = {
  not_started: { label: '请求未发起', tone: 'neutral' },
  attempted: { label: '已尝试发送', tone: 'warning' },
  response_received: { label: '已收到响应', tone: 'success' },
};

const phasePresentation: Record<
  ProbeEvidence['phases'][number]['state'],
  { label: string; tone: StatusBadgeTone }
> = {
  completed: { label: '完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '未执行', tone: 'neutral' },
};

const phaseNames: Readonly<Record<string, string>> = {
  configuration: '配置检查',
  probe_configuration: '准备请求',
  dispatch: '发起请求',
  headers: '等待响应头',
  body: '读取正文',
  validation: '协议校验',
  audit_intent: '记录诊断意图',
  audit_result: '记录诊断结果',
};

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '时间不可用';

  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '耗时不可用';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(durationMs)} ms`;
}

export function DiagnosticDetails({
  evidence,
  diagnosticId = null,
  channelVersion = null,
  mappingVersion = null,
  priceVersion = null,
}: DiagnosticDetailsProps) {
  const versions = [
    channelVersion === null ? null : `渠道 ${channelVersion}`,
    mappingVersion === null ? null : `映射 ${mappingVersion}`,
    priceVersion === null ? null : `价格 ${priceVersion}`,
  ].filter((version): version is string => version !== null);

  return (
    <section aria-label="诊断详细信息" className="space-y-2">
      <details className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
          执行过程
        </summary>
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          {evidence === null ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              当前后端未提供诊断执行详情。
            </p>
          ) : evidence.phases.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">没有可显示的阶段记录。</p>
          ) : (
            <ol className="space-y-3">
              {evidence.phases.map((phase, index) => {
                const presentation = phasePresentation[phase.state];
                return (
                  <li
                    key={`${phaseNames[phase.name] ?? phase.name}-${index}`}
                    className="flex min-w-0 items-start justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-[var(--color-foreground)]">
                        {phaseNames[phase.name] ?? phase.name}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                        {formatDuration(phase.durationMs)}
                      </p>
                    </div>
                    <StatusBadge className="shrink-0" tone={presentation.tone}>
                      {presentation.label}
                    </StatusBadge>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </details>

      <details className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
          运行详情
        </summary>
        <div className="space-y-4 border-t border-[var(--color-border)] px-4 py-3">
          {evidence === null && (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              当前后端未提供请求与响应执行证据。
            </p>
          )}
          <dl className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-[var(--color-muted-foreground)]">诊断编号</dt>
              <dd className="mt-1 break-all font-mono text-xs text-[var(--color-foreground)]">
                {diagnosticId ?? '未提供'}
              </dd>
            </div>
            {evidence !== null && (
              <>
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--color-muted-foreground)]">请求编号</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-[var(--color-foreground)]">
                    {evidence.requestId}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--color-muted-foreground)]">开始时间</dt>
                  <dd className="mt-1 break-words text-xs text-[var(--color-foreground)]">
                    {formatTimestamp(evidence.startedAt)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--color-muted-foreground)]">总耗时</dt>
                  <dd className="mt-1 text-xs text-[var(--color-foreground)]">
                    {formatDuration(evidence.durationMs)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--color-muted-foreground)]">执行状态</dt>
                  <dd className="mt-1">
                    <StatusBadge tone={executionPresentation[evidence.execution].tone}>
                      {executionPresentation[evidence.execution].label}
                    </StatusBadge>
                  </dd>
                </div>
              </>
            )}
            <div className="min-w-0">
              <dt className="text-xs text-[var(--color-muted-foreground)]">配置版本</dt>
              <dd className="mt-1 break-words text-xs text-[var(--color-foreground)]">
                {versions.length === 0 ? '未提供' : versions.join(' · ')}
              </dd>
            </div>
          </dl>

          {evidence !== null && (
            <>
              <div className="border-t border-[var(--color-border)] pt-3">
                <h3 className="text-xs font-medium text-[var(--color-foreground)]">
                  跳转记录（{evidence.redirects.length}）
                </h3>
                {evidence.redirects.length === 0 ? (
                  <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                    没有记录到 HTTP 跳转。
                  </p>
                ) : (
                  <ol className="mt-2 space-y-3">
                    {evidence.redirects.map((redirect, index) => (
                      <li
                        key={`${redirect.url}-${redirect.status}-${index}`}
                        className="min-w-0 rounded-md bg-[var(--color-surface-subtle)] p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge tone="info">HTTP {redirect.status}</StatusBadge>
                          <code className="font-mono text-xs text-[var(--color-foreground)]">
                            {redirect.method}
                          </code>
                        </div>
                        <p className="mt-2 break-all font-mono text-xs text-[var(--color-muted-foreground)]">
                          {redirect.url}
                          {redirect.nextUrl ? ` → ${redirect.nextUrl}` : ''}
                        </p>
                        {redirect.strippedHeaders.length > 0 && (
                          <p className="mt-2 break-words text-xs text-[var(--color-muted-foreground)]">
                            已移除的请求头：
                            {redirect.strippedHeaders.map((header, headerIndex) => (
                              <code
                                key={`${header}-${headerIndex}`}
                                className="ml-1 font-mono text-[var(--color-foreground)]"
                              >
                                {header}
                              </code>
                            ))}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
