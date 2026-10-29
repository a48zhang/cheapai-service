import { useState } from 'react';
import { Download, LoaderCircle, RotateCcw } from 'lucide-react';
import type { ImageJob } from '@cheapai/contracts/images';
import { imageContentUrl } from '@cheapai/api-client/images';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { formatConsumptionUsd } from '../../shared/lib/money';
import { GeneratedImage } from './GeneratedImage';

const errors: Record<NonNullable<ImageJob['error']>, string> = {
  provider_rejected: '生成请求未被接受，请调整描述或选择其他模型。',
  provider_unavailable: '生成服务暂时不可用，请稍后重试。',
  invalid_image: '生成服务没有返回可保存的图片，本次未扣费。',
  storage_unavailable: '图片保存失败，本次未扣费。请稍后重试。',
  result_unknown: '生成结果尚未确认。刷新记录不会重复生成；再次生成会发起新的请求。',
};
export function ImageWaiting({ uncertain = false }: { uncertain?: boolean }) {
  return (
    <div
      className="flex min-h-44 items-center justify-center gap-3 rounded-xl border border-[var(--color-border)] border-dashed bg-[var(--color-muted)]/35 p-6"
      role="status"
    >
      {!uncertain && (
        <LoaderCircle
          aria-hidden="true"
          className="size-5 animate-spin motion-reduce:animate-none"
        />
      )}
      <div>
        <p className="font-medium">{uncertain ? '生成结果待确认' : '正在生成图片…'}</p>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          {uncertain
            ? '可以确认原请求的结果，描述已保留。'
            : '图片完成后会显示在这里，可以先编辑下一条描述。'}
        </p>
      </div>
    </div>
  );
}
export function ImageResultCard({
  job,
  onUsePrompt,
  onRefresh,
}: {
  job: ImageJob;
  onUsePrompt: (value: string) => void;
  onRefresh: () => void;
}) {
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dimensions = job.size.split('x').map(Number);
  const src = `${imageContentUrl(job.id)}?v=${attempt}`;
  return (
    <article
      id={`image-${job.id}`}
      aria-label="生图记录"
      className="scroll-mt-20 space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5"
    >
      <p className="whitespace-pre-wrap break-words text-sm leading-7">{job.prompt}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
        <span>{job.modelName}</span>
        <span>{job.size}</span>
        <span>
          {job.status === 'completed'
            ? job.billingStatus === 'settled'
              ? `已扣费 ${formatConsumptionUsd(job.priceUnits)} USD`
              : `费用确认中 · ${formatConsumptionUsd(job.priceUnits)} USD`
            : `单张 ${formatConsumptionUsd(job.priceUnits)} USD`}
        </span>
      </div>
      {job.status === 'generating' ? (
        <ImageWaiting />
      ) : job.status === 'completed' ? (
        <>
          {loadError ? (
            <div role="alert" className="rounded-lg border border-[var(--color-border)] p-6">
              <p>图片暂时无法读取，生成记录已保存。</p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => {
                  setLoadError(false);
                  setAttempt((value) => value + 1);
                }}
              >
                重新加载图片
              </Button>
            </div>
          ) : (
            <Dialog
              title="图片预览"
              className="!max-w-5xl"
              trigger={
                <button
                  type="button"
                  aria-label="放大预览图片"
                  title="点击图片放大预览"
                  className="block w-full rounded-lg bg-[var(--color-muted)]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]"
                >
                  <GeneratedImage
                    src={src}
                    alt={job.prompt}
                    width={dimensions[0]}
                    height={dimensions[1]}
                    onError={() => setLoadError(true)}
                    className="mx-auto max-h-[32rem] object-contain"
                    loading="lazy"
                  />
                </button>
              }
              footer={
                <Button asChild variant="outline">
                  <a href={imageContentUrl(job.id, true)}>下载原图</a>
                </Button>
              }
            >
              <GeneratedImage
                src={src}
                alt={job.prompt}
                className="mx-auto max-h-[65dvh] object-contain"
              />
            </Dialog>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={imageContentUrl(job.id, true)}>
                <Download size={16} aria-hidden="true" />
                下载图片
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onUsePrompt(job.prompt)}>
              <RotateCcw size={16} aria-hidden="true" />
              复用描述
            </Button>
          </div>
        </>
      ) : (
        <div className="rounded-lg bg-[var(--color-muted)]/40 p-4" role="status">
          <p className="text-sm leading-6">{errors[job.error ?? 'result_unknown']}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => onUsePrompt(job.prompt)}>
              编辑描述
            </Button>
            {job.status === 'unknown' && (
              <Button variant="outline" size="sm" onClick={onRefresh}>
                刷新记录
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
