import { useState } from 'react';
import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';
import { DiagnosticCode } from './DiagnosticCode';
import { formatDiagnosticHeaders, formatDiagnosticResponseBody } from './diagnostic-format';
import { StatusBadge, type StatusBadgeTone } from '../../shared/ui/StatusBadge';
import { Tabs } from '../../shared/ui/Tabs';

export interface DiagnosticResponseProps {
  readonly evidence: ProbeEvidence | null;
  readonly state: 'idle' | 'running' | 'complete' | 'unconfirmed';
  readonly errorMessage?: string | null;
  readonly upstreamStatus?: number | null;
}

const failureSourceLabel: Record<NonNullable<ProbeEvidence['failure']>['source'], string> = {
  cheapai: 'CheapAI',
  upstream: '上游',
  transport: '传输',
  protocol: '协议校验',
};

const failurePhaseLabel: Record<NonNullable<ProbeEvidence['failure']>['phase'], string> = {
  configuration: '配置检查',
  dispatch: '请求发起',
  headers: '等待响应头',
  body: '读取正文',
  validation: '响应校验',
  audit: '审计记录',
};

function responseStatusTone(status: number): StatusBadgeTone {
  if (status >= 400) return 'danger';
  if (status >= 300) return 'warning';
  return 'info';
}

function responseContentType(headers: Readonly<Record<string, string>>): string | null {
  return (
    Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null
  );
}

function responseEmptyMessage(
  response: NonNullable<ProbeEvidence['response']> | null,
  state: DiagnosticResponseProps['state'],
  errorMessage: string | null | undefined,
  failure: ProbeEvidence['failure'] | null | undefined,
  upstreamStatus: number | null | undefined,
): string {
  if (response !== null) {
    if (!response.complete && failure?.phase === 'body') return failure.message;
    if (response.truncated) return '正文已截断，无法取得完整内容。';
    if (response.body.length === 0 || response.format === 'empty') return '上游返回了空正文。';
    return '响应正文不可用。';
  }
  if (state === 'idle') return '运行诊断后，上游响应正文会显示在这里。';
  if (state === 'running') return '正在等待上游响应…';
  if (failure !== null && failure !== undefined) return failure.message;
  if (errorMessage?.trim()) return errorMessage;
  if (state === 'unconfirmed') return '诊断结果未确认。';
  if (upstreamStatus !== null && upstreamStatus !== undefined) {
    return '当前后端未提供响应正文详情。';
  }
  return '当前后端没有提供响应正文详情。';
}

export function DiagnosticResponse({
  evidence,
  state,
  errorMessage = null,
  upstreamStatus = null,
}: DiagnosticResponseProps) {
  const [contentTab, setContentTab] = useState('body');
  const response = evidence?.response ?? null;
  const failure = evidence?.failure ?? null;
  const contentType = response === null ? null : responseContentType(response.headers);
  const responseHeaders = response === null ? null : formatDiagnosticHeaders(response.headers);
  const emptyMessage = responseEmptyMessage(response, state, errorMessage, failure, upstreamStatus);
  const status = response?.status ?? (evidence === null ? upstreamStatus : null);
  const noResponseLabel =
    state === 'running'
      ? '等待响应'
      : state === 'idle'
        ? '尚无结果'
        : state === 'unconfirmed'
          ? '结果未确认'
          : evidence?.execution === 'not_started'
            ? '请求未发起'
            : evidence === null && upstreamStatus === null
              ? '未提供响应状态'
              : '未记录响应状态';
  const noResponseMessage =
    failure?.message ??
    (errorMessage?.trim() ||
      (state === 'unconfirmed'
        ? '诊断结果未确认；无法判断上游是否已经处理请求。'
        : evidence?.execution === 'not_started'
          ? '请求未发起，因此没有上游响应。'
          : evidence === null
            ? status === null
              ? '当前没有可用的上游响应状态。'
              : '当前后端未提供响应目标详情。'
            : '没有记录到 HTTP 响应状态。'));

  const contentItems = [
    {
      value: 'body',
      label: 'Body',
      content: (
        <div className="space-y-2 pt-3">
          {response?.truncated && (
            <p className="text-xs text-[var(--color-ink-secondary)]" role="status">
              响应超过采集上限，当前显示已采集的 {response.capturedBytes.toLocaleString('zh-CN')}{' '}
              B。
            </p>
          )}
          {response !== null && !response.complete && !response.truncated && (
            <p className="text-xs text-[var(--color-ink-secondary)]" role="status">
              正文读取未完整完成，以下仅为已读取内容。
            </p>
          )}
          {response !== null && failure?.phase === 'body' && (
            <div
              className="rounded-md border border-[var(--color-warning-line)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]"
              role="status"
            >
              <p className="font-medium">
                正文读取失败 · {failureSourceLabel[failure.source]} ·{' '}
                {failurePhaseLabel[failure.phase]}
                {failure.code === null ? '' : ` · ${failure.code}`}
              </p>
              <p className="mt-1 break-words">{failure.message}</p>
            </div>
          )}
          <DiagnosticCode
            label="响应正文"
            value={response === null ? null : formatDiagnosticResponseBody(response)}
            emptyMessage={emptyMessage}
          />
        </div>
      ),
    },
    {
      value: 'headers',
      label: 'Headers',
      content: (
        <div className="pt-3">
          <DiagnosticCode
            label="响应头"
            value={responseHeaders}
            emptyMessage={
              state === 'running'
                ? '正在等待响应头…'
                : state === 'idle'
                  ? '运行诊断后，响应头会显示在这里。'
                  : state === 'unconfirmed'
                    ? '诊断结果未确认。'
                    : '没有可用的响应头。'
            }
          />
        </div>
      ),
    },
  ] as const;

  return (
    <section aria-label="上游响应" className="min-w-0 space-y-3">
      <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          {status === null ? (
            <StatusBadge tone={state === 'running' ? 'info' : 'neutral'}>
              {noResponseLabel}
            </StatusBadge>
          ) : (
            <StatusBadge tone={responseStatusTone(status)}>HTTP {status}</StatusBadge>
          )}
          {contentType !== null && (
            <span className="break-all text-xs text-[var(--color-ink-secondary)]">
              {contentType}
            </span>
          )}
        </div>

        {response === null ? (
          <div className="mt-3 space-y-1" aria-live="polite" role="status">
            {state === 'idle' ? (
              <p className="text-sm text-[var(--color-ink-secondary)]">
                运行诊断后，最终响应状态与目标会显示在这里。
              </p>
            ) : state === 'running' ? (
              <p className="text-sm text-[var(--color-ink-secondary)]">正在等待上游响应。</p>
            ) : (
              <>
                {failure !== null && (
                  <p className="text-xs font-medium text-[var(--color-ink-secondary)]">
                    失败位置：{failureSourceLabel[failure.source]} ·{' '}
                    {failurePhaseLabel[failure.phase]}
                    {failure.code === null ? '' : ` · ${failure.code}`}
                  </p>
                )}
                <p className="break-words text-sm text-[var(--color-ink-secondary)]">
                  {noResponseMessage}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="mt-3 min-w-0 space-y-1">
            <p className="text-xs text-[var(--color-ink-muted)]">最终目标</p>
            <p className="break-all font-mono text-xs text-[var(--color-ink-secondary)]">
              {response.url}
            </p>
          </div>
        )}
      </div>

      <Tabs
        ariaLabel="响应内容"
        items={contentItems}
        value={contentTab}
        onValueChange={setContentTab}
        listClassName="gap-3"
        contentClassName="min-w-0"
      />
    </section>
  );
}
