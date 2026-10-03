import type { ChannelCapabilities, CapabilityFeature, Protocol } from '@cheapai/api-client/mappings';
import { CAPABILITY_FEATURES, EXTENSION_SCOPES } from '@cheapai/api-client/mappings';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';

export interface CapabilityFieldValues {
  readonly features: CapabilityFeature[];
  readonly maxOutputTokens: string;
  readonly reasoningEfforts: string;
  readonly cacheTtls: Array<'5m' | '1h'>;
  readonly nativeExtensions: string;
}

export interface CapabilityFieldErrors {
  readonly features?: string | undefined;
  readonly maxOutputTokens?: string | undefined;
  readonly reasoningEfforts?: string | undefined;
  readonly cacheTtls?: string | undefined;
  readonly nativeExtensions?: string | undefined;
}

const featureGroups: ReadonlyArray<{ readonly label: string; readonly values: readonly CapabilityFeature[] }> = [
  { label: '流式输出', values: ['streaming', 'stream_usage'] },
  { label: '工具调用', values: ['tools', 'tool_choice', 'parallel_tools', 'parallel_tool_control', 'strict_tools', 'tool_result_images', 'tool_result_error'] },
  { label: '图像', values: ['image_url', 'image_base64', 'image_file_id', 'image_detail'] },
  { label: '推理与思考', values: ['reasoning_effort', 'reasoning_summary', 'reasoning_history', 'thinking_budget', 'thinking_adaptive', 'thinking_control', 'signed_thinking', 'redacted_thinking', 'encrypted_reasoning'] },
  { label: '内容与历史', values: ['refusal_history', 'response_history', 'item_references', 'file_inputs', 'file_references', 'message_names', 'citations'] },
  { label: '请求参数', values: ['json_object', 'json_schema', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'seed', 'penalties', 'multiple_choices', 'service_tier', 'metadata', 'store', 'verbosity', 'logprobs', 'system_developer_priority'] },
  { label: '缓存', values: ['cache_control'] },
];
const groupedFeatures = new Set(featureGroups.flatMap(group => group.values));
const otherFeatures = CAPABILITY_FEATURES.filter(feature => !groupedFeatures.has(feature));
export function capabilityFieldValues(value: ChannelCapabilities): CapabilityFieldValues {
  return {
    features: [...value.features],
    maxOutputTokens: value.maxOutputTokens === undefined ? '' : String(value.maxOutputTokens),
    reasoningEfforts: value.reasoningEfforts?.join(', ') ?? '',
    cacheTtls: [...(value.cacheTtls ?? [])],
    nativeExtensions: value.nativeExtensions?.map(extension => `${extension.scope}:${extension.name}`).join('\n') ?? '',
  };
}

export function CapabilityFields({
  protocol,
  value,
  errors = {},
  disabled = false,
  onChange,
}: {
  readonly protocol: Protocol;
  readonly value: CapabilityFieldValues;
  readonly errors?: CapabilityFieldErrors;
  readonly disabled?: boolean;
  readonly onChange: (value: CapabilityFieldValues) => void;
}) {
  const toggleFeature = (feature: CapabilityFeature, checked: boolean) => {
    const features = checked
      ? [...value.features, feature]
      : value.features.filter(item => item !== feature);
    onChange({ ...value, features });
  };
  const toggleTtl = (ttl: '5m' | '1h', checked: boolean) => {
    const cacheTtls = checked
      ? [...value.cacheTtls, ttl]
      : value.cacheTtls.filter(item => item !== ttl);
    onChange({ ...value, cacheTtls });
  };
  const featureInput = (feature: CapabilityFeature) => <label key={feature} className="flex min-h-8 items-center gap-2 text-sm text-[var(--color-foreground)]">
    <input
      type="checkbox"
      checked={value.features.includes(feature)}
      disabled={disabled}
      onChange={event => toggleFeature(feature, event.currentTarget.checked)}
      className="size-4 accent-[var(--color-primary)]"
    />
    <code>{feature}</code>
  </label>;

  return <fieldset disabled={disabled} className="grid gap-4 rounded-lg border border-[var(--color-border)] p-4">
    <legend className="px-1 text-sm font-semibold">模型能力</legend>
    <p className="text-xs text-[var(--color-muted-foreground)]">协议：{protocol}。仅勾选渠道明确支持的能力；这些字段会参与路由筛选。</p>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {featureGroups.map(group => <fieldset key={group.label} className="grid content-start gap-1 rounded-md bg-[var(--color-muted)]/40 p-3">
        <legend className="px-1 text-xs font-semibold">{group.label}</legend>
        {group.values.map(featureInput)}
      </fieldset>)}
      {otherFeatures.length > 0 && <fieldset className="grid content-start gap-1 rounded-md bg-[var(--color-muted)]/40 p-3">
        <legend className="px-1 text-xs font-semibold">其他能力</legend>
        {otherFeatures.map(featureInput)}
      </fieldset>}
    </div>
    {errors.features && <p role="alert" className="text-xs text-[var(--color-destructive)]">{errors.features}</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="最大输出 Token（可选）" error={errors.maxOutputTokens} description="使用正整数；留空表示不覆盖模型目录默认值。">
        <Input
          value={value.maxOutputTokens}
          inputMode="numeric"
          maxLength={16}
          placeholder="例如 8192"
          onChange={event => onChange({ ...value, maxOutputTokens: event.currentTarget.value })}
        />
      </Field>
      <Field label="推理档位（可选）" error={errors.reasoningEfforts} description="用逗号分隔，例如 low, medium, high。">
        <Input
          value={value.reasoningEfforts}
          maxLength={512}
          placeholder="low, medium"
          onChange={event => onChange({ ...value, reasoningEfforts: event.currentTarget.value })}
        />
      </Field>
    </div>
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">缓存 TTL（可选）</legend>
      <div className="flex flex-wrap gap-4">
        {(['5m', '1h'] as const).map(ttl => <label key={ttl} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.cacheTtls.includes(ttl)} onChange={event => toggleTtl(ttl, event.currentTarget.checked)} />
          {ttl}
        </label>)}
      </div>
      {errors.cacheTtls && <p role="alert" className="text-xs text-[var(--color-destructive)]">{errors.cacheTtls}</p>}
    </fieldset>
    <Field
      label="原生扩展（可选）"
      error={errors.nativeExtensions}
      description={`每行一个 scope:name；可用 scope：${EXTENSION_SCOPES.join('、')}。output_config 仅适用于 Messages。`}
    >
      <textarea
        value={value.nativeExtensions}
        rows={3}
        maxLength={2200}
        placeholder="request:vendor_flag"
        onChange={event => onChange({ ...value, nativeExtensions: event.currentTarget.value })}
        className="block min-h-20 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-60"
      />
    </Field>
    <p className="text-xs text-[var(--color-muted-foreground)]">所有 {CAPABILITY_FEATURES.length} 项已知能力均可显式设置。协议及能力依赖、重复项和扩展范围会在保存前校验。</p>
  </fieldset>;
}
