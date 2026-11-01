import { TextLink } from '../../shared/ui/TextLink';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CopyButton } from '../../shared/ui/CopyButton';
import { formatDateTime } from '../../shared/lib/datetime';
import { Download, LoaderCircle, RotateCcw } from 'lucide-react';
import type { ImageJob } from '@cheapai/contracts/images';
import { imageContentUrl } from '@cheapai/api-client/images';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { formatConsumptionUsd } from '../../shared/lib/money';
import { GeneratedImage } from './GeneratedImage';
import { useImageAsset } from './useImageAsset';
import { useProductEnvironment } from '../../shared/platform';

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
  onReuse,
  onRefresh,
}: {
  job: ImageJob;
  onReuse: (job: ImageJob) => void;
  onRefresh: () => void;
}) {
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dimensions = job.size.split('x').map(Number);
  const asset = useImageAsset(job.id, job.status === 'completed', attempt);
  const src = asset.url ?? undefined;
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
        <time dateTime={new Date(job.createdAt).toISOString()}>
          {formatDateTime(job.createdAt)}
        </time>
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
          {loadError || asset.error ? (
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
          ) : !src ? (
            <p role="status" className="p-6 text-sm">
              正在读取图片…
            </p>
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
              footer={<ImageDownload id={job.id} label="下载原图" />}
            >
              <GeneratedImage
                src={src}
                alt={job.prompt}
                className="mx-auto max-h-[65dvh] object-contain"
              />
            </Dialog>
          )}
          <div className="flex flex-wrap gap-2">
            <ImageDownload id={job.id} label="下载图片" />
          </div>
        </>
      ) : (
        <div className="rounded-lg bg-[var(--color-muted)]/40 p-4" role="status">
          <p className="text-sm leading-6">{errors[job.error ?? 'result_unknown']}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {job.status === 'unknown' && (
              <Button variant="outline" size="sm" onClick={onRefresh}>
                刷新记录
              </Button>
            )}
          </div>
        </div>
      )}
      {job.status !== 'generating' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onReuse(job)}>
            <RotateCcw size={16} aria-hidden="true" />
            {job.status === 'completed' ? '复用参数' : '修改后重试'}
          </Button>
          <CopyButton value={job.prompt} label="复制描述" />
          {job.billingStatus !== 'unbilled' && (
            <Button asChild variant="ghost" size="sm">
              <Link
                to={`/billing?period=all&kind=image_generation&requestId=${encodeURIComponent(job.id)}`}
              >
                查看费用
              </Link>
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function ImageDownload({ id, label }: { id: string; label: string }) {
  const { downloadAsset } = useProductEnvironment();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!downloadAsset)
    return (
      <Button asChild variant="outline" size="sm">
        <TextLink href={imageContentUrl(id, true)}>
          <Download size={16} aria-hidden="true" />
          {label}
        </TextLink>
      </Button>
    );
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        busy={busy}
        onClick={() => {
          setBusy(true);
          setError(false);
          void downloadAsset(imageContentUrl(id, true), `cheapai-${id}.png`)
            .catch(() => setError(true))
            .finally(() => setBusy(false));
        }}
      >
        <Download size={16} aria-hidden="true" />
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-destructive)]">
          图片未能保存，请重试。
        </p>
      )}
    </>
  );
}
