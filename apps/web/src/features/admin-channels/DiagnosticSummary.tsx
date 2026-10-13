import { CircleCheck, CircleAlert, CircleDashed, LoaderCircle } from 'lucide-react';
import { Button } from '../../shared/ui/Button';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import type { DiagnosticRepairAction, DiagnosticResultView } from './diagnostic-result';

export interface DiagnosticSummaryProps {
  readonly view: DiagnosticResultView;
  readonly busy?: boolean;
  readonly onAction?: ((action: DiagnosticRepairAction) => void) | undefined;
}

const stateLabel: Record<DiagnosticResultView['state'], string> = {
  idle: '尚无结果',
  success: '校验通过',
  failure: '诊断失败',
  partial: '部分证据',
  unconfirmed: '结果未确认',
  unknown: '状态未知',
};

function statusTone(status: number): 'info' | 'warning' | 'danger' {
  if (status >= 400) return 'danger';
  if (status >= 300) return 'warning';
  return 'info';
}

function durationLabel(durationMs: number): string {
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(durationMs)} ms`;
}

export function DiagnosticSummary({ view, busy = false, onAction }: DiagnosticSummaryProps) {
  const action = view.action;
  const providerMessage = view.providerError?.message ?? null;
  const detail = view.detail === providerMessage ? null : view.detail;

  return (
    <section
      aria-label="诊断结果"
      aria-live="polite"
      className={`min-w-0 rounded-lg border p-4 ${view.tone === 'danger' ? 'border-[var(--color-danger-line)] bg-[var(--color-danger-soft)]' : view.tone === 'success' ? 'border-[var(--color-success-line)] bg-[var(--color-success-soft)]' : 'border-[var(--color-line)] bg-[var(--color-surface)]'}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] text-sm font-semibold text-[var(--color-ink-secondary)]"
        >
          {busy ? (
            <LoaderCircle size={18} className="animate-spin" />
          ) : view.state === 'success' ? (
            <CircleCheck size={18} />
          ) : view.state === 'idle' ? (
            <CircleDashed size={18} />
          ) : (
            <CircleAlert size={18} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <h2 className="min-w-0 break-words text-[15px] font-semibold text-[var(--color-ink)]">
              {busy ? '正在等待诊断结果…' : view.summary}
            </h2>
            <StatusBadge tone={busy ? 'info' : view.tone}>
              {busy ? '运行中' : stateLabel[view.state]}
            </StatusBadge>
          </div>

          {view.providerError?.code !== null && view.providerError?.code !== undefined && (
            <p className="mt-2 break-all font-mono text-sm text-[var(--color-ink-secondary)]">
              供应商错误码：{view.providerError.code}
            </p>
          )}
          {providerMessage !== null && (
            <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-5 text-[var(--color-ink-secondary)]">
              {providerMessage}
            </p>
          )}
          {detail !== null && (
            <p className="mt-1 break-words whitespace-pre-wrap text-sm leading-5 text-[var(--color-ink-secondary)]">
              {detail}
            </p>
          )}
          {view.failure !== null && view.failure.issues.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-[var(--color-ink-secondary)]">
              {view.failure.issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`} className="break-words">
                  <code>{issue.path}</code>: {issue.message}
                </li>
              ))}
            </ul>
          )}
          {view.legacyEvidenceMessage !== null && (
            <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
              {view.legacyEvidenceMessage}
            </p>
          )}

          {(view.upstreamStatus !== null ||
            view.durationMs !== null ||
            view.retryAfter !== null) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              {view.upstreamStatus !== null && (
                <StatusBadge tone={statusTone(view.upstreamStatus)}>
                  上游 HTTP {view.upstreamStatus}
                </StatusBadge>
              )}
              {view.durationMs !== null && (
                <span className="text-[var(--color-ink-muted)]">
                  耗时 {durationLabel(view.durationMs)}
                </span>
              )}
              {view.retryAfter !== null && (
                <span className="break-words text-[var(--color-ink-muted)]">
                  Retry-After：{view.retryAfter}
                </span>
              )}
            </div>
          )}
          {action !== null && (
            <Button
              className="mt-3"
              disabled={busy || onAction === undefined}
              onClick={() => onAction?.(action)}
              size="sm"
              variant="outline"
            >
              {action.label}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
