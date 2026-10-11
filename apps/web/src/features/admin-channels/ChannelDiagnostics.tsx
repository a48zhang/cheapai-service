import { useRef, useState } from 'react';
import type { ChannelModel, ChannelView } from '@cheapai/api-client/channels';
import type { SessionIdentity } from '@cheapai/api-client/types';
import { ApiClientError } from '@cheapai/api-client/errors';
import { Button } from '../../shared/ui/Button';
import { Field } from '../../shared/ui/Field';
import { Select } from '../../shared/ui/Select';
import { Sheet } from '../../shared/ui/Sheet';
import { Tabs } from '../../shared/ui/Tabs';
import type { AdminChannelsApi } from './api';
import { DiagnosticDetails } from './DiagnosticDetails';
import { DiagnosticRequest } from './DiagnosticRequest';
import { DiagnosticResponse } from './DiagnosticResponse';
import { DiagnosticSummary } from './DiagnosticSummary';
import { channelModelKey } from './diagnostic-operation';
import { createDiagnosticPreview, formatDiagnosticExport } from './diagnostic-format';
import type { DiagnosticRepairAction } from './diagnostic-result';
import { useChannelDiagnostic } from './useChannelDiagnostic';

export interface ChannelDiagnosticsProps {
  open: boolean;
  channel: ChannelView;
  api: AdminChannelsApi;
  onOpenChange: (open: boolean) => void;
  sessionIdentity?: SessionIdentity | null;
  onRepair?: (kind: 'credentials' | 'mapping', model: ChannelModel | null) => void;
}

export function ChannelDiagnostics({
  open,
  channel,
  api,
  onOpenChange,
  sessionIdentity = null,
  onRepair,
}: ChannelDiagnosticsProps) {
  const diagnostic = useChannelDiagnostic({ open, channel, api, sessionIdentity });
  const { selectedModel, busy, result, error, view } = diagnostic;
  const detailsRef = useRef<HTMLDivElement>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const preview = selectedModel === null ? null : createDiagnosticPreview(channel, selectedModel);
  const state = busy
    ? 'running'
    : view.state === 'idle'
      ? 'idle'
      : view.state === 'unconfirmed'
        ? 'unconfirmed'
        : 'complete';
  const runnable = channel.status === 'active' && channel.hasCredential && selectedModel !== null;
  const changeOpen = (next: boolean) => {
    if (!next && busy && !window.confirm('诊断仍在进行，关闭后无法确认本次结果。仍要关闭？'))
      return;
    onOpenChange(next);
  };
  const repair = (action: DiagnosticRepairAction) => {
    if (action.kind === 'execution') {
      const details = detailsRef.current?.querySelector('details');
      if (details) {
        details.open = true;
        details.querySelector('summary')?.focus();
      }
      return;
    }
    onRepair?.(action.kind, selectedModel);
  };
  const download = () => {
    let url: string | null = null;
    try {
      const content = formatDiagnosticExport({
        result,
        partialEvidence: view.evidence,
        partialDiagnosticId: view.diagnosticId,
        apiError:
          view.apiError === null
            ? null
            : { status: view.apiError.status, code: view.apiError.code ?? 'unknown' },
      });
      url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `cheapai-diagnostic-${view.diagnosticId ?? channel.id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setDownloadError(null);
    } catch {
      setDownloadError('下载失败，请重试。');
    } finally {
      if (url !== null) URL.revokeObjectURL(url);
    }
  };
  const contextKey = `${channel.id}:${channel.configVersion}:${sessionIdentity?.userId ?? ''}:${sessionIdentity?.epoch ?? ''}:${diagnostic.selection}`;

  return (
    <Sheet
      open={open}
      onOpenChange={changeOpen}
      title="渠道诊断"
      description={channel.name}
      footer={
        <>
          <p className="w-full text-xs text-[var(--color-ink-muted)]">
            可能产生上游费用，不扣用户余额
          </p>
          <Button variant="outline" onClick={() => changeOpen(false)}>
            关闭
          </Button>
          <Button
            busy={busy}
            disabled={!runnable}
            onClick={() => {
              setDownloadError(null);
              void diagnostic.run();
            }}
          >
            运行诊断
          </Button>
        </>
      }
    >
      <div className="min-w-0 space-y-4">
        <Field label="选择模型映射">
          <Select
            value={diagnostic.selection}
            disabled={busy || channel.models.length === 0}
            onValueChange={(selection) => {
              setDownloadError(null);
              diagnostic.selectMapping(selection);
            }}
            placeholder="暂无模型映射"
            items={channel.models.map((model) => ({
              value: channelModelKey(model),
              label: `${model.publicModelId} · ${model.protocol}`,
            }))}
          />
        </Field>
        {!runnable && !busy && (
          <div className="flex items-center justify-between gap-3 text-sm">
            <p>
              {channel.status !== 'active'
                ? '渠道已停用。'
                : !channel.hasCredential
                  ? '渠道缺少上游凭据。'
                  : '此渠道尚无模型映射。'}
            </p>
            {onRepair && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onRepair(
                    channel.status !== 'active' || !channel.hasCredential
                      ? 'credentials'
                      : 'mapping',
                    selectedModel,
                  )
                }
              >
                {channel.status !== 'active' || !channel.hasCredential
                  ? '编辑渠道'
                  : '配置模型映射'}
              </Button>
            )}
          </div>
        )}
        <Tabs
          key={contextKey}
          defaultValue="result"
          ariaLabel="渠道诊断内容"
          contentClassName="pt-4 min-w-0"
          items={[
            {
              value: 'result',
              label: '结果',
              content: (
                <div className="space-y-3">
                  <DiagnosticSummary view={view} busy={busy} onAction={repair} />
                  {view.apiError && view.apiError.message !== view.detail && (
                    <p role="alert" className="break-words text-sm text-[var(--color-danger)]">
                      {view.apiError.message}
                    </p>
                  )}
                  {error instanceof ApiClientError &&
                    view.evidence === null &&
                    error.request_id && (
                      <p className="break-all text-xs text-[var(--color-ink-muted)]">
                        请求编号：<code>{error.request_id}</code>
                      </p>
                    )}
                  {(result !== null || view.evidence !== null) && (
                    <>
                      <div ref={detailsRef}>
                        <DiagnosticDetails
                          evidence={view.evidence}
                          diagnosticId={view.diagnosticId}
                          channelVersion={result?.channelVersion ?? null}
                          mappingVersion={result?.mappingVersion ?? null}
                          priceVersion={result?.priceVersion ?? null}
                        />
                      </div>
                      <Button variant="ghost" size="sm" onClick={download}>
                        下载诊断 JSON
                      </Button>
                    </>
                  )}
                  {downloadError && (
                    <p role="status" className="text-sm text-[var(--color-danger)]">
                      {downloadError}
                    </p>
                  )}
                </div>
              ),
            },
            {
              value: 'request',
              label: '请求',
              content: (
                <DiagnosticRequest
                  preview={preview}
                  evidence={view.evidence}
                  state={state}
                  errorMessage={error instanceof Error ? error.message : null}
                />
              ),
            },
            {
              value: 'response',
              label: '响应',
              content: (
                <DiagnosticResponse
                  evidence={view.evidence}
                  state={state}
                  upstreamStatus={view.upstreamStatus}
                  errorMessage={error instanceof Error ? error.message : null}
                />
              ),
            },
          ]}
        />
      </div>
    </Sheet>
  );
}
