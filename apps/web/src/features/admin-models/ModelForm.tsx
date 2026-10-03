import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { ApiClientError } from '@cheapai/api-client/errors';
import { createAdminModelsApi } from '@cheapai/api-client/models';
import type { ModelInput, ModelPatch, ModelStatus, ModelView, SellPrices } from '@cheapai/api-client/models';
import type { ApiClient } from '@cheapai/api-client/types';
import { modelInputSchema, modelStatusSchema } from '@cheapai/contracts/models';
import { BILLABLE_BUCKETS } from '@cheapai/contracts/models';
import { builtinModel } from '@cheapai/model-catalog';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Button } from '../../shared/ui/Button';
import { PriceFields } from './PriceFields';
import type { PriceFieldErrors, PriceFieldValues } from './PriceFields';

const rate = z.string().max(18).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u);
const optionalRate = z.union([z.literal(''), rate]);
const priceFormSchema = z.object({
  input: rate,
  output: rate,
  cacheRead: optionalRate,
  cacheWrite: optionalRate,
  cacheWrite5m: optionalRate,
  cacheWrite1h: optionalRate,
  reasoning: optionalRate,
}).transform(values => ({
  input: values.input,
  output: values.output,
  ...(values.cacheRead === '' ? {} : { cacheRead: values.cacheRead }),
  ...(values.cacheWrite === '' ? {} : { cacheWrite: values.cacheWrite }),
  ...(values.cacheWrite5m === '' ? {} : { cacheWrite5m: values.cacheWrite5m }),
  ...(values.cacheWrite1h === '' ? {} : { cacheWrite1h: values.cacheWrite1h }),
  ...(values.reasoning === '' ? {} : { reasoning: values.reasoning }),
}));

const maxOutputTokensText = z.string().regex(/^[1-9][0-9]*$/u)
  .refine(value => Number.isSafeInteger(Number(value)))
  .transform(Number);

const requiredModelInputSchema = modelInputSchema.extend({ status: modelStatusSchema });
const formSchema = z.object({
  publicModelId: modelInputSchema.shape.publicModelId,
  status: modelStatusSchema,
  sellPrices: priceFormSchema,
  admissionMinBalanceUnits: modelInputSchema.shape.admissionMinBalanceUnits,
  maxOutputTokens: maxOutputTokensText,
}).strict().transform(value => requiredModelInputSchema.parse(value));

type ModelFormValues = z.input<typeof formSchema>;
type ModelFormOutput = z.output<typeof formSchema>;

export interface ModelFormProps {
  readonly client: ApiClient;
  readonly model?: ModelView | undefined;
  readonly onSaved: (model: ModelView) => void;
  readonly onCancel?: (() => void) | undefined;
}

function priceValues(prices?: SellPrices): PriceFieldValues {
  return {
    input: prices?.input ?? '',
    output: prices?.output ?? '',
    cacheRead: prices?.cacheRead ?? '',
    cacheWrite: prices?.cacheWrite ?? '',
    cacheWrite5m: prices?.cacheWrite5m ?? '',
    cacheWrite1h: prices?.cacheWrite1h ?? '',
    reasoning: prices?.reasoning ?? '',
  };
}

function initialValues(model?: ModelView): ModelFormValues {
  return {
    publicModelId: model?.publicModelId ?? '',
    status: model?.status ?? 'active',
    sellPrices: priceValues(model?.sellPrices),
    admissionMinBalanceUnits: model?.admissionMinBalanceUnits ?? '',
    maxOutputTokens: model === undefined ? '' : String(model.maxOutputTokens),
  };
}

function priceErrors(value: unknown): PriceFieldErrors {
  if (typeof value !== 'object' || value === null) return {};
  const errors: PriceFieldErrors = {};
  for (const bucket of BILLABLE_BUCKETS) {
    const error = (value as Record<string, unknown>)[bucket];
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
      errors[bucket] = error.message;
    }
  }
  return errors;
}

function samePrices(left: SellPrices, right: SellPrices): boolean {
  return BILLABLE_BUCKETS.every(bucket => (left[bucket] ?? undefined) === (right[bucket] ?? undefined));
}

function changedFields(previous: ModelView, next: ModelInput): ModelPatch {
  const patch: { status?: ModelStatus; sellPrices?: SellPrices; admissionMinBalanceUnits?: string; maxOutputTokens?: number } = {};
  if (next.status !== undefined && previous.status !== next.status) patch.status = next.status;
  if (!samePrices(previous.sellPrices, next.sellPrices)) patch.sellPrices = next.sellPrices;
  if (previous.admissionMinBalanceUnits !== next.admissionMinBalanceUnits) patch.admissionMinBalanceUnits = next.admissionMinBalanceUnits;
  if (previous.maxOutputTokens !== next.maxOutputTokens) patch.maxOutputTokens = next.maxOutputTokens;
  return patch;
}

/** Model edits send only changed fields against the loaded priceVersion. */
export function ModelForm({ client, model, onSaved, onCancel }: ModelFormProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const api = createAdminModelsApi(client);
  const form = useForm<ModelFormValues, unknown, ModelFormOutput>({
    resolver: zodResolver<ModelFormValues, unknown, ModelFormOutput>(formSchema),
    defaultValues: initialValues(model),
  });
  const publicModelId = form.watch('publicModelId');
  const reference = builtinModel(publicModelId);

  async function submit(value: ModelFormOutput) {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (model) {
        const patch = changedFields(model, value);
        if (Object.keys(patch).length === 0) {
          setSaveError(new Error('没有需要保存的更改。'));
          return;
        }
        onSaved(await api.update(model.publicModelId, model.priceVersion, patch));
      } else {
        onSaved(await api.create(value));
      }
    } catch (error) {
      const conflict = error instanceof ApiClientError && error.status === 409;
      setSaveError(new Error(conflict
        ? '模型价格版本已变化。请重新读取并核对后再保存；当前输入已保留。'
        : error instanceof Error ? `${error.message} 当前输入已保留。` : '保存结果未确认。请重新读取模型；当前输入已保留。'));
    } finally {
      setSaving(false);
    }
  }

  const errors = form.formState.errors;
  return <form className="space-y-6" noValidate onSubmit={form.handleSubmit(submit)}>
    <fieldset disabled={saving} className="grid gap-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:grid-cols-2">
      <legend className="px-1 text-sm font-semibold">模型设置</legend>
      <Field label="公开模型 ID" required error={errors.publicModelId?.message} description="供 API 请求使用的公开名称。">
        <Input {...form.register('publicModelId')} required readOnly={model !== undefined} autoComplete="off" maxLength={128} />
      </Field>
      {reference && <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-4 sm:col-span-2">
        <summary className="cursor-pointer text-sm font-medium">{reference.provider} 官方参考：{reference.id}</summary>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-[var(--color-muted-foreground)]">上下文窗口</dt><dd className="font-mono tabular-nums">{reference.contextWindow.toLocaleString()} Token</dd></div>
          <div><dt className="text-xs text-[var(--color-muted-foreground)]">参考最大输出</dt><dd className="font-mono tabular-nums">{reference.maxOutputTokens.toLocaleString()} Token</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-[var(--color-muted-foreground)]">参考价格说明</dt><dd>{reference.pricingNote}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-[var(--color-muted-foreground)]">官方资料</dt><dd><a href={reference.source} target="_blank" rel="noreferrer" className="text-[var(--color-primary)] underline underline-offset-2">打开供应商价格与模型文档</a></dd></div>
        </dl>
        <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">以上为只读参考，不会自动覆盖本地售价或渠道配置。</p>
      </details>}
      <Field label="目录状态" required error={errors.status?.message} description="目录启用与渠道映射状态彼此独立。">
        <select {...form.register('status')} className="min-h-10 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm">
          <option value="active">已启用</option>
          <option value="disabled">已停用</option>
        </select>
      </Field>
      <Controller
        name="sellPrices"
        control={form.control}
        render={({ field, fieldState }) => <div className="sm:col-span-2">
          <PriceFields value={field.value} errors={priceErrors(fieldState.error)} disabled={saving} onChange={field.onChange} />
        </div>}
      />
      <Field label="最低余额门槛（USD 最小单位）" required error={errors.admissionMinBalanceUnits?.message} description="使用非负整数，不经过浮点换算。">
        <Input {...form.register('admissionMinBalanceUnits')} required inputMode="numeric" maxLength={17} placeholder="例如 0" />
      </Field>
      <Field label="最大输出 Token" required error={errors.maxOutputTokens?.message}>
        <Input {...form.register('maxOutputTokens')} required inputMode="numeric" maxLength={16} placeholder="请输入正整数" />
      </Field>
    </fieldset>
    {saveError && <ApiErrorNotice error={saveError} />}
    <div className="flex flex-wrap justify-end gap-3">
      {onCancel && <Button variant="secondary" disabled={saving} onClick={onCancel}>取消</Button>}
      <Button type="submit" busy={saving}>{model ? '保存模型' : '创建模型'}</Button>
    </div>
  </form>;
}
