import { Disclosure } from '../../shared/ui/Disclosure';
import { Select } from '../../shared/ui/Select';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createImagesApi } from '@cheapai/api-client/images';
import { imageModelInputSchema, imageSizes } from '@cheapai/contracts/images';
import type { ImageModel, ImageModelInput } from '@cheapai/contracts/images';
import { useSession } from '../../features/session/useSession';
import { ChannelPicker } from '../../shared/catalog/ChannelPicker';
import { channelOptionsQueryOptions } from '../../shared/catalog/channel-options';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

const empty: ImageModelInput = {
  name: '',
  channelId: '',
  upstreamModel: '',
  pricePerImage: '',
  sizes: ['1024x1024'],
  quality: 'default',
  responseFormat: 'default',
  status: 'active',
};
const selectClass =
  'min-h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm';
export default function ImageModelsPage() {
  const { client, user, epoch } = useSession();
  const queryClient = useQueryClient();
  const api = useMemo(() => createImagesApi(client), [client]);
  const queryKey = ['admin', 'image-models', user?.id, epoch];
  const models = useQuery({ queryKey, queryFn: () => api.adminModels(), retry: false });
  const channels = useQuery(channelOptionsQueryOptions(client, user?.id ?? '', epoch));
  const [editing, setEditing] = useState<ImageModel | 'new' | null>(null);
  const [draft, setDraft] = useState<ImageModelInput>(empty);
  const [error, setError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const update = <K extends keyof ImageModelInput>(key: K, value: ImageModelInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const open = (model: ImageModel | 'new') => {
    setEditing(model);
    setError(null);
    setFieldError('');
    if (model === 'new') setDraft(empty);
    else {
      setDraft({
        name: model.name,
        channelId: model.channelId,
        upstreamModel: model.upstreamModel,
        pricePerImage: model.pricePerImage,
        sizes: model.sizes,
        quality: model.quality,
        responseFormat: model.responseFormat,
        status: model.status,
      });
    }
  };
  const save = async () => {
    if (lock.current) return;
    const parsed = imageModelInputSchema.safeParse(draft);
    if (!parsed.success) {
      setFieldError('请填写名称、渠道、上游模型和非负单张价格，并选择至少一种尺寸。');
      return;
    }
    lock.current = true;
    setSaving(true);
    setError(null);
    setFieldError('');
    try {
      await api.saveModel(parsed.data, editing && editing !== 'new' ? editing : undefined);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ['images'] });
      setEditing(null);
    } catch (cause) {
      setError(cause);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader
        heading="生图模型"
        description="通过已配置渠道调用 OpenAI 兼容的图片生成接口；用户沿用该渠道所在访问组的授权。"
        actions={<Button onClick={() => open('new')}>添加生图模型</Button>}
      />
      {models.error && (
        <ApiErrorNotice error={models.error} onRetry={() => void models.refetch()} />
      )}
      {models.isPending && <p role="status">正在读取生图配置…</p>}
      {models.data && !models.data.storageReady && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-[var(--color-border)] p-4 text-sm"
        >
          图片存储未配置。请先为 Worker 绑定私有 R2 存储 IMAGE_ASSETS，再启用生图服务。
        </p>
      )}
      <div className="grid gap-3">
        {models.data?.items.map((model) => (
          <article
            key={model.id}
            className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--color-border)] p-4"
          >
            <div>
              <h2 className="font-medium">
                {model.name}{' '}
                <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                  {model.status === 'active' ? '已启用' : '已停用'}
                </span>
              </h2>
              <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                ${model.pricePerImage} / 张 · {model.sizes.join('、')}
              </p>
              <p className="mt-1 break-all text-xs text-[var(--color-muted-foreground)]">
                上游模型：{model.upstreamModel}
              </p>
            </div>
            <Button variant="outline" onClick={() => open(model)}>
              编辑
            </Button>
          </article>
        ))}
      </div>
      {models.data?.items.length === 0 && (
        <div className="rounded-lg border border-[var(--color-border)] border-dashed p-8 text-center text-sm leading-7">
          还没有生图模型。先在
          <Link to="/admin/channels" className="mx-1 underline">
            渠道
          </Link>
          配置供应商地址和密钥，再添加生图模型。
        </div>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
        title={editing === 'new' ? '添加生图模型' : '编辑生图模型'}
        className="!max-w-2xl"
      >
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
            <legend className="sr-only">生图模型配置</legend>
            <Field label="显示名称" required>
              <Input
                value={draft.name}
                onChange={(event) => update('name', event.target.value)}
                maxLength={128}
                placeholder="例如：GPT Image"
              />
            </Field>
            <Field label="上游模型" required>
              <Input
                value={draft.upstreamModel}
                onChange={(event) => update('upstreamModel', event.target.value)}
                maxLength={256}
                placeholder="例如：gpt-image-1"
              />
            </Field>
            <div className="sm:col-span-2">
              <ChannelPicker
                value={draft.channelId ? [draft.channelId] : []}
                onValueChange={(ids) => update('channelId', ids[0] ?? '')}
                candidates={channels.data}
                loading={channels.isPending}
                error={channels.error}
                onRetry={() => void channels.refetch()}
                maxSelected={1}
              />
            </div>
            <Field
              label="单张售价（USD）"
              required
              description="所有选中尺寸采用此售价，再乘访问组倍率。"
            >
              <Input
                value={draft.pricePerImage}
                onChange={(event) => update('pricePerImage', event.target.value)}
                inputMode="decimal"
                placeholder="例如：0.05"
              />
            </Field>
            <Field label="状态">
              <Select
                className={selectClass}
                value={draft.status}
                onValueChange={(nextValue) =>
                  update('status', nextValue as ImageModelInput['status'])
                }
                items={[
                  { value: 'active', label: <>已启用</> },
                  { value: 'disabled', label: <>已停用</> },
                ]}
              />
            </Field>
            <Disclosure
              className="sm:col-span-2"
              title={<>供应商兼容参数</>}
              triggerClassName="cursor-pointer text-sm font-medium"
            >
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="画质参数" description="按供应商支持的参数选择；默认表示省略该参数。">
                  <Select
                    className={selectClass}
                    value={draft.quality}
                    onValueChange={(nextValue) =>
                      update('quality', nextValue as ImageModelInput['quality'])
                    }
                    items={[
                      { value: 'default', label: <>使用上游默认值</> },
                      ...['auto', 'low', 'medium', 'high', 'standard', 'hd'].map((value) => ({
                        value: value,
                        label: <>{value}</>,
                      })),
                    ]}
                  />
                </Field>
                <Field
                  label="图片返回格式"
                  description="GPT Image 使用默认；DALL·E 可选择 b64_json。仅接收 PNG、JPEG、WebP 的 base64 数据。"
                >
                  <Select
                    className={selectClass}
                    value={draft.responseFormat}
                    onValueChange={(nextValue) =>
                      update('responseFormat', nextValue as ImageModelInput['responseFormat'])
                    }
                    items={[
                      { value: 'default', label: <>使用上游默认值</> },
                      { value: 'b64_json', label: <>b64_json</> },
                    ]}
                  />
                </Field>
              </div>
            </Disclosure>
            <fieldset className="space-y-3 sm:col-span-2">
              <legend className="text-sm font-medium">允许的尺寸</legend>
              <div className="flex flex-wrap gap-3">
                {imageSizes.map((value) => (
                  <label
                    key={value}
                    className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={draft.sizes.includes(value)}
                      onChange={(event) =>
                        update(
                          'sizes',
                          event.target.checked
                            ? [...draft.sizes, value]
                            : draft.sizes.filter((size) => size !== value),
                        )
                      }
                    />
                    {value}
                  </label>
                ))}
              </div>
            </fieldset>
          </fieldset>
          {fieldError && (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {fieldError}
            </p>
          )}
          {error != null && <ApiErrorNotice error={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={saving} onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button type="submit" busy={saving}>
              保存生图模型
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
