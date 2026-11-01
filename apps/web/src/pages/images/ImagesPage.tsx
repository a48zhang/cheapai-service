import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createImagesApi } from '@cheapai/api-client/images';
import type { ImageChoice, ImageSize, ImageGenerateInput } from '@cheapai/contracts/images';
import { ImagePlus, LoaderCircle } from 'lucide-react';
import { useSession } from '../../features/session/useSession';
import { useDraft } from '../../features/chat/hooks/useDraft';
import { ImageResultCard, ImageWaiting } from '../../features/images/ImageResultCard';
import { useImageWorkspace } from '../../features/images/useImageWorkspace';
import { Button } from '../../shared/ui/Button';
import { Select } from '../../shared/ui/Select';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { formatConsumptionUsd } from '../../shared/lib/money';
import { safeReturnPath } from '../../shared/lib/return-path';

const choiceKey = (item: ImageChoice) => `${item.groupId}:${item.modelId}`;
export default function ImagesPage() {
  const session = useSession();
  if (!session.user) return null;
  return <ImageWorkspace key={`${session.user.id}:${session.epoch}`} />;
}
function ImageWorkspace() {
  const { client, user, epoch, isAdmin } = useSession();
  const userId = user!.id;
  const work = useImageWorkspace(client, userId, epoch);
  const draft = useDraft({
    identity: { status: 'authenticated', userId },
    conversationId: 'image-workspace',
  });
  const [selected, setSelected] = useState('');
  const [reuseNotice, setReuseNotice] = useState('');
  const [previousDraft, setPreviousDraft] = useState<{
    prompt: string;
    selected: string;
    size: ImageSize;
  } | null>(null);
  const [size, setSize] = useState<ImageSize>('1024x1024');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const [params] = useSearchParams();
  const requestedId = params.get('job');
  const requestedReturn = safeReturnPath(params.get('returnTo'), '/chat');
  const returnTo =
    requestedReturn === '/billing' || requestedReturn.startsWith('/billing?')
      ? requestedReturn
      : '/chat';
  const api = useMemo(() => createImagesApi(client), [client]);
  const requested = useQuery({
    queryKey: ['images', userId, epoch, 'detail', requestedId],
    queryFn: () => api.get(requestedId!),
    enabled: Boolean(requestedId),
    retry: false,
  });
  const options = work.models.data?.items ?? [];
  const requestedReady = Boolean(requested.data || work.jobs.some((job) => job.id === requestedId));
  useEffect(() => {
    if (requestedId && requestedReady)
      document.getElementById(`image-${requestedId}`)?.scrollIntoView({ block: 'start' });
  }, [requestedId, requestedReady]);
  const model = selected ? options.find((item) => choiceKey(item) === selected) : options[0];
  const imageSize = model?.sizes.includes(size) ? size : model?.sizes[0];
  const canSend = Boolean(
    model &&
    imageSize &&
    work.models.data?.available &&
    draft.draft.trim() &&
    !work.pending &&
    !work.sending,
  );
  const restore = (input: Pick<ImageGenerateInput, 'prompt' | 'modelId' | 'groupId' | 'size'>) => {
    setPreviousDraft(
      draft.draft && draft.draft !== input.prompt ? { prompt: draft.draft, selected, size } : null,
    );
    draft.setDraft(input.prompt);
    setSelected(`${input.groupId}:${input.modelId}`);
    setSize(input.size);
    const original = options.find(
      (item) => item.modelId === input.modelId && item.groupId === input.groupId,
    );
    setReuseNotice(
      !original
        ? '原模型或访问组已不可用，描述已恢复，请重新选择模型。'
        : !original.sizes.includes(input.size)
          ? '原尺寸已不可用，已选择当前支持的尺寸。请核对参数和价格后生成。'
          : '已恢复描述、模型、访问组和尺寸，请核对当前价格后生成。',
    );
    textarea.current?.focus();
    textarea.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const send = () => {
    if (!canSend || !model || !imageSize) return;
    if (
      work.start({
        modelId: model.modelId,
        groupId: model.groupId,
        size: imageSize,
        prompt: draft.draft,
      })
    ) {
      draft.setDraft('');
      setPreviousDraft(null);
      setReuseNotice('');
      textarea.current?.focus();
      requestAnimationFrame(() =>
        pendingRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      );
    }
  };
  const pendingKnown = work.pending
    ? work.jobs.some((job) => job.operationId === work.pending?.operationId)
    : false;
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        heading="生成图片"
        description="写下画面、风格和细节，把想法变成图片。"
        actions={
          <Button asChild variant="ghost">
            <Link to={returnTo}>{returnTo === '/chat' ? '返回对话' : '返回费用明细'}</Link>
          </Button>
        }
      />
      <form
        aria-label="生成图片"
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label htmlFor="image-prompt" className="mb-2 block text-sm font-medium">
          画面描述
        </label>
        <textarea
          id="image-prompt"
          ref={textarea}
          rows={4}
          value={draft.draft}
          onChange={(event) => draft.setDraft(event.target.value)}
          placeholder="例如：一只橘猫坐在咖啡馆窗边，午后阳光，水彩插画，暖色调。"
          className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-transparent p-3 text-base leading-7 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-3 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
          <label className="grid min-w-0 gap-1.5 text-sm">
            生图模型
            <Select
              aria-label="生图模型"
              value={model ? choiceKey(model) : ''}
              disabled={options.length === 0}
              placeholder="选择生图模型"
              items={options.map((item) => ({
                value: choiceKey(item),
                label: `${item.name} · ${item.groupName}`,
              }))}
              onValueChange={(value) => {
                setSelected(value);
                setReuseNotice('');
              }}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            图片尺寸
            <Select
              key={model ? choiceKey(model) : 'no-model'}
              aria-label="图片尺寸"
              value={imageSize ?? ''}
              disabled={!model}
              items={(model?.sizes ?? []).map((value) => ({
                value,
                label: value.replace('x', ' × '),
              }))}
              onValueChange={(value) => setSize(value as ImageSize)}
            />
          </label>
          <Button type="submit" size="lg" disabled={!canSend} busy={work.sending}>
            {work.sending ? '正在生成图片' : work.pending ? '生成结果待确认' : '生成图片'}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-6 text-[var(--color-muted-foreground)]">
          {model ? `每张 ${formatConsumptionUsd(model.priceUnits)} USD · 生成成功后扣费。` : ''}{' '}
          {work.pending ? '可以继续编辑下一条描述。' : 'Ctrl / ⌘ + Enter 生成；Enter 换行。'}
        </p>
        {work.models.isPending && (
          <p role="status" className="mt-3 flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取生图模型…
          </p>
        )}
        {work.models.error && (
          <ApiErrorNotice error={work.models.error} onRetry={() => void work.models.refetch()} />
        )}
        {work.models.isSuccess && (!work.models.data.available || options.length === 0) && (
          <div
            role="status"
            className="mt-3 rounded-lg bg-[var(--color-muted)] p-3 text-sm leading-6"
          >
            {work.models.data.available ? '暂无可用生图模型。' : '生图服务尚未就绪。'}
            {isAdmin ? (
              <Link className="ml-1 underline" to="/admin/image-models">
                配置生图模型
              </Link>
            ) : (
              '请联系管理员开通。'
            )}
            <Button variant="ghost" size="sm" onClick={() => void work.models.refetch()}>
              刷新
            </Button>
          </div>
        )}
        {reuseNotice && (
          <p role="status" className="mt-3 text-sm leading-6">
            {reuseNotice}
          </p>
        )}
        {previousDraft && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => {
              draft.setDraft(previousDraft.prompt);
              setSelected(previousDraft.selected);
              setSize(previousDraft.size);
              setPreviousDraft(null);
              setReuseNotice('已恢复先前未发送的草稿。');
              textarea.current?.focus();
            }}
          >
            撤销复用
          </Button>
        )}
      </form>
      <section aria-label="图片生成结果" className="mt-6 space-y-5">
        {work.pending && !pendingKnown && (
          <div ref={pendingRef} className="space-y-3" data-testid="pending-image">
            <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-muted)] px-4 py-3 text-sm">
              {work.pending.prompt}
            </p>
            <ImageWaiting uncertain={!work.sending} />
          </div>
        )}
        {work.pending && !work.sending && (
          <Button variant="outline" onClick={work.confirm}>
            确认生成结果
          </Button>
        )}
        {work.rejected && (
          <div
            className="space-y-3 rounded-lg border border-[var(--color-border)] p-4"
            role="status"
          >
            <p>这次请求未提交，描述已保留。</p>
            <p className="whitespace-pre-wrap break-words text-sm">{work.rejected.prompt}</p>
            <Button variant="outline" size="sm" onClick={() => restore(work.rejected!)}>
              恢复描述
            </Button>
          </div>
        )}
        {work.error != null && <ApiErrorNotice error={work.error} />}
        {requested.error && <ApiErrorNotice error={requested.error} />}
        {requested.data && !work.jobs.some((job) => job.id === requested.data.id) && (
          <ImageResultCard
            job={requested.data}
            onReuse={restore}
            onRefresh={() => void requested.refetch()}
          />
        )}
        {work.jobs.map((job) => (
          <ImageResultCard key={job.id} job={job} onReuse={restore} onRefresh={work.refresh} />
        ))}
        {work.history.isPending && (
          <p role="status" className="text-center text-sm text-[var(--color-muted-foreground)]">
            正在读取生图记录…
          </p>
        )}
        {work.history.error && <ApiErrorNotice error={work.history.error} onRetry={work.refresh} />}
        {work.history.hasNextPage && (
          <Button
            variant="outline"
            disabled={work.history.isFetchingNextPage}
            onClick={() => void work.history.fetchNextPage()}
          >
            加载更早的图片
          </Button>
        )}
        {work.history.isSuccess && work.jobs.length === 0 && !work.pending && (
          <div className="py-10 text-center text-[var(--color-muted-foreground)]">
            <ImagePlus aria-hidden="true" className="mx-auto mb-3 size-8" />
            <p>生成的图片会保存在这里。</p>
          </div>
        )}
      </section>
    </div>
  );
}
