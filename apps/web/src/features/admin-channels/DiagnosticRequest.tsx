import { useState } from 'react';
import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';
import { DiagnosticCode } from './DiagnosticCode';
import {
  formatDiagnosticCurl,
  formatDiagnosticHeaders,
  formatDiagnosticRequestBody,
  type DiagnosticPreview,
} from './diagnostic-format';
import { StatusBadge, type StatusBadgeTone } from '../../shared/ui/StatusBadge';
import { Tabs } from '../../shared/ui/Tabs';

export interface DiagnosticRequestProps {
  readonly preview: DiagnosticPreview | null;
  readonly evidence: ProbeEvidence | null;
  readonly state: 'idle' | 'running' | 'complete' | 'unconfirmed';
  readonly errorMessage?: string | null;
}

const executionPresentation: Record<
  ProbeEvidence['execution'],
  { label: string; tone: StatusBadgeTone }
> = {
  not_started: { label: '请求未发起', tone: 'neutral' },
  attempted: { label: '已尝试发送', tone: 'warning' },
  response_received: { label: '已收到响应', tone: 'info' },
};

const protocolLabel: Record<DiagnosticPreview['protocol'], string> = {
  chat: 'Chat Completions',
  responses: 'Responses',
  messages: 'Messages',
};

function statePresentation(state: DiagnosticRequestProps['state']) {
  if (state === 'running') return { label: '等待结果', tone: 'info' as const };
  if (state === 'unconfirmed') return { label: '结果未确认', tone: 'warning' as const };
  if (state === 'complete') return { label: '没有实际请求快照', tone: 'neutral' as const };
  return { label: '请求预览', tone: 'neutral' as const };
}

export function DiagnosticRequest({
  preview,
  evidence,
  state,
  errorMessage = null,
}: DiagnosticRequestProps) {
  const [contentTab, setContentTab] = useState('body');
  const request = evidence?.request ?? null;
  const actualSnapshot = request !== null;
  const body = actualSnapshot
    ? formatDiagnosticRequestBody(request.body)
    : preview === null
      ? null
      : formatDiagnosticRequestBody(preview.body);
  const headers = actualSnapshot
    ? formatDiagnosticHeaders(request.headers)
    : formatDiagnosticHeaders(preview?.headers ?? null);
  const curl = formatDiagnosticCurl(actualSnapshot ? request : null);
  const status =
    evidence === null ? statePresentation(state) : executionPresentation[evidence.execution];

  const contentItems = [
    {
      value: 'body',
      label: 'Body',
      content: (
        <div className="pt-3">
          <DiagnosticCode
            label="请求正文"
            value={body}
            emptyMessage={
              actualSnapshot
                ? '本次请求无正文。'
                : preview === null
                  ? '选择模型映射。'
                  : '暂无预览正文。'
            }
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
            label="请求头"
            value={headers}
            emptyMessage={
              actualSnapshot
                ? '本次请求无请求头。'
                : preview === null
                  ? '选择模型映射。'
                  : '暂无预览请求头。'
            }
          />
        </div>
      ),
    },
    {
      value: 'curl',
      label: 'cURL',
      content: (
        <div className="pt-3">
          <DiagnosticCode
            label="cURL 命令预览"
            value={curl}
            emptyMessage="运行诊断后可复制 cURL。"
          />
        </div>
      ),
    },
  ] as const;

  const requestMethod = request?.method ?? preview?.method ?? null;
  const requestUrl = request?.url ?? preview?.url ?? null;
  const reason =
    (evidence !== null && request === null ? evidence.failure?.message : null) ??
    (evidence === null && (state === 'complete' || state === 'unconfirmed')
      ? errorMessage?.trim() || null
      : null);

  return (
    <section aria-label="上游请求" className="min-w-0 space-y-3">
      <div className="min-w-0 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          {actualSnapshot ? (
            <StatusBadge tone="info">真实请求快照</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">请求预览</StatusBadge>
          )}

        </div>

        {requestMethod !== null && (
          <div className="mt-3 flex min-w-0 items-start gap-2">
            <code className="shrink-0 rounded bg-[var(--color-surface-subtle)] px-2 py-1 font-mono text-xs text-[var(--color-ink)]">
              {requestMethod}
            </code>
            <p className="min-w-0 break-all font-mono text-xs leading-5 text-[var(--color-ink-secondary)]">
              {requestUrl ?? (preview === null ? '请求目标未提供' : '预览目标无法确定')}
            </p>
          </div>
        )}

        {actualSnapshot ? (
          <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-[var(--color-ink-muted)]">公开模型</dt>
              <dd className="mt-0.5 break-words text-[var(--color-ink-secondary)]">
                {request.publicModelId}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--color-ink-muted)]">上游模型</dt>
              <dd className="mt-0.5 break-all font-mono text-[var(--color-ink-secondary)]">
                {request.upstreamModel}
              </dd>
            </div>
          </dl>
        ) : preview !== null ? (
          <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-[var(--color-ink-muted)]">公开模型</dt>
              <dd className="mt-0.5 break-words text-[var(--color-ink-secondary)]">
                {preview.publicModelId}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--color-ink-muted)]">上游模型</dt>
              <dd className="mt-0.5 break-all font-mono text-[var(--color-ink-secondary)]">
                {preview.upstreamModel}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--color-ink-muted)]">协议模板</dt>
              <dd className="mt-0.5 text-[var(--color-ink-secondary)]">
                {protocolLabel[preview.protocol]}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-[var(--color-ink-secondary)]">
            当前没有可用的模型映射请求预览。
          </p>
        )}

        {!actualSnapshot && (state === 'complete' || state === 'unconfirmed') && (
          <p className="mt-3 text-xs text-[var(--color-ink-secondary)]">
            {state === 'unconfirmed'
              ? '实际请求快照未取得；下方仅为请求预览。'
              : evidence === null
                ? '当前后端未返回实际请求快照；下方内容仅供预览。'
                : evidence.execution === 'not_started'
                  ? '请求没有发起；下方内容仅供预览。'
                  : '本次没有返回请求快照；下方内容仅供预览。'}
          </p>
        )}
        {reason !== null && (
          <p
            className="mt-3 break-words rounded-md bg-[var(--color-surface-subtle)] px-3 py-2 text-xs text-[var(--color-ink-secondary)]"
            role="status"
          >
            {reason}
          </p>
        )}
      </div>

      <Tabs
        ariaLabel="请求内容"
        items={contentItems}
        value={contentTab}
        onValueChange={setContentTab}
        listClassName="gap-3"
        contentClassName="min-w-0"
      />
    </section>
  );
}
