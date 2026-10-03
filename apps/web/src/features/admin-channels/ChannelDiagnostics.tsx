import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChannelModel, ChannelView } from '@cheapai/api-client/channels';
import { ApiClientError } from '@cheapai/api-client/errors';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Select } from '../../shared/ui/Select';
import { Sheet } from '../../shared/ui/Sheet';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import type { AdminChannelsApi } from './api';
import { channelModelKey, createDiagnosticOperation } from './diagnostic-operation';
import type { ChannelProbeResult } from '@cheapai/api-client/channels';

export interface ChannelDiagnosticsProps {
  open: boolean;
  channel: ChannelView;
  api: AdminChannelsApi;
  onOpenChange: (open: boolean) => void;
}

const outcomeDetails: Record<ChannelProbeResult['outcome'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  responded: { label: '响应有效', tone: 'success' },
  http_error: { label: '上游返回 HTTP 错误', tone: 'danger' },
  invalid_response: { label: '响应内容无效', tone: 'warning' },
  timeout: { label: '请求超时', tone: 'warning' },
  cancelled: { label: '请求已取消', tone: 'neutral' },
  transport_error: { label: '传输失败', tone: 'danger' },
};

function mappingLabel(model: ChannelModel): ReactNode {
  return (
    <span className="flex min-w-0 items-center justify-between gap-4">
      <span className="truncate">{model.publicModelId}</span>
      <span className="shrink-0 text-xs text-slate-500">{model.protocol}</span>
    </span>
  );
}

export function ChannelDiagnostics({ open, channel, api, onOpenChange }: ChannelDiagnosticsProps) {
  const operation = useMemo(() => createDiagnosticOperation(api), [api]);
  const options = useMemo(() => channel.models.map(model => ({
    value: channelModelKey(model),
    label: mappingLabel(model),
  })), [channel.models]);
  const initialSelection = options[0]?.value ?? '';
  const [selection, setSelection] = useState(initialSelection);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChannelProbeResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const selectedModel = channel.models.find(model => channelModelKey(model) === selection) ?? null;

  useEffect(() => {
    setSelection(options[0]?.value ?? '');
    setConfirmOpen(false);
    setResult(null);
    setError(null);
  }, [channel.id, options]);

  const handleProbe = async () => {
    if (!selectedModel || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const completed = await operation.run(channel, selectedModel);
      setResult(completed);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const closeSheet = (nextOpen: boolean) => {
    if (!nextOpen && (busy || confirmOpen)) return;
    onOpenChange(nextOpen);
  };
  const closeConfirmation = (nextOpen: boolean) => {
    if (!nextOpen && busy) return;
    setConfirmOpen(nextOpen);
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={closeSheet}
        title="渠道连接诊断"
        description="只在你确认后发送一次上游请求。测试可能产生上游费用，但不会扣减用户余额或创建业务账单。"
        closeButton={!busy && !confirmOpen}
        footer={(
          <>
            <Button variant="outline" disabled={busy || confirmOpen} onClick={() => onOpenChange(false)}>关闭</Button>
            <Button
              disabled={channel.status !== 'active' || !selectedModel || busy || confirmOpen}
              onClick={() => setConfirmOpen(true)}
            >
              执行诊断
            </Button>
          </>
        )}
      >
        <div className="space-y-5">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">费用提示</p>
            <p className="mt-1 leading-6">系统会发送一条最小测试提示并读取有限响应。上游服务可能计费；此操作不会扣减 cheapai 用户余额，也不会进入用户账单。</p>
          </div>

          {channel.status !== 'active' && (
            <div role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              当前渠道已停用，不能执行连接诊断。
            </div>
          )}

          {channel.models.length > 0 ? (
            <Field label="选择模型映射" description="诊断会携带当前渠道、映射和价格版本；版本变化时服务端会拒绝过期请求。" required>
              <Select
                items={options}
                value={selection}
                onValueChange={value => {
                  setSelection(value);
                  setResult(null);
                  setError(null);
                }}
                disabled={busy}
                required
              />
            </Field>
          ) : (
            <div role="status" className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-600">
              此渠道没有模型映射。先配置映射后再运行诊断。
            </div>
          )}

          {selectedModel && (
            <dl className="grid gap-3 rounded-lg border border-slate-200 p-4 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">公开模型</dt><dd className="mt-1 break-all font-medium">{selectedModel.publicModelId}</dd></div>
              <div><dt className="text-xs text-slate-500">上游模型</dt><dd className="mt-1 break-all font-mono">{selectedModel.upstreamModel}</dd></div>
              <div><dt className="text-xs text-slate-500">协议</dt><dd className="mt-1">{selectedModel.protocol}</dd></div>
              <div><dt className="text-xs text-slate-500">版本</dt><dd className="mt-1">渠道 {channel.configVersion} · 映射 {selectedModel.mappingVersion} · 价格 {selectedModel.priceVersion}</dd></div>
            </dl>
          )}

          {result && (
            <section aria-live="polite" className="space-y-3 rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">诊断结果</h3>
                <StatusBadge tone={outcomeDetails[result.outcome].tone}>{outcomeDetails[result.outcome].label}</StatusBadge>
              </div>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-slate-500">诊断编号</dt><dd className="mt-1 break-all font-mono">{result.diagnosticId}</dd></div>
                <div><dt className="text-xs text-slate-500">上游 HTTP 状态</dt><dd className="mt-1">{result.upstreamStatus ?? '无响应状态'}</dd></div>
                <div><dt className="text-xs text-slate-500">本次输出上限</dt><dd className="mt-1">{result.maxOutputTokens} tokens</dd></div>
                <div><dt className="text-xs text-slate-500">账务</dt><dd className="mt-1">{result.userBalanceCharged ? '用户余额已扣费' : '用户余额未扣费'}</dd></div>
              </dl>
              {result.mayIncurUpstreamCost && <p className="text-xs text-amber-800">此请求仍可能由上游服务计费。</p>}
            </section>
          )}

          {error !== null && (
            <div className="space-y-2">
              <ApiErrorNotice error={error} />
              {error instanceof ApiClientError && (error.kind === 'network' || error.kind === 'aborted') && (
                <p className="text-xs text-slate-600">未收到可确认的诊断结果。系统不会自动重试；再次操作需要重新确认费用提示。</p>
              )}
            </div>
          )}
        </div>
      </Sheet>

      <Dialog
        open={confirmOpen}
        onOpenChange={closeConfirmation}
        title="确认发送一次上游测试请求"
        description={(
          <span>
            将以 <strong>{selectedModel?.publicModelId}</strong>（{selectedModel?.protocol}）发送测试请求。上游可能产生费用；cheapai 不扣用户余额。每次确认只执行一次，不会自动重试。
          </span>
        )}
        closeButton={!busy}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmOpen(false)}>返回</Button>
            <Button variant="primary" busy={busy} disabled={!selectedModel} onClick={() => { void handleProbe(); }}>
              确认并诊断
            </Button>
          </>
        )}
      />
    </>
  );
}
