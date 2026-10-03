import { BILLABLE_BUCKETS } from '@cheapai/api-client/models';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';

export type PriceFieldValues = Readonly<Record<(typeof BILLABLE_BUCKETS)[number], string>>;
export type PriceFieldErrors = Partial<Record<(typeof BILLABLE_BUCKETS)[number], string | undefined>>;

export interface PriceFieldsProps {
  readonly value: PriceFieldValues;
  readonly errors?: PriceFieldErrors;
  readonly disabled?: boolean;
  readonly onChange: (value: PriceFieldValues) => void;
}

const labels: Record<(typeof BILLABLE_BUCKETS)[number], string> = {
  input: '输入 Token',
  output: '输出 Token',
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  cacheWrite5m: '缓存写入（5 分钟）',
  cacheWrite1h: '缓存写入（1 小时）',
  reasoning: '推理 Token',
};

/** Price fields remain decimal strings end to end; no browser number conversion occurs. */
export function PriceFields({ value, errors = {}, disabled = false, onChange }: PriceFieldsProps) {
  return <fieldset disabled={disabled} className="grid gap-4 rounded-xl border border-[var(--border)] p-4 sm:grid-cols-2">
    <legend className="px-1 text-sm font-semibold">模型价格</legend>
    <p className="text-xs leading-5 text-[var(--muted)] sm:col-span-2">按 USD / 百万 Token 填写。缓存和推理价格单独计价；留空表示未配置该计费项。</p>
    {BILLABLE_BUCKETS.map(bucket => <Field
      key={bucket}
      label={`${labels[bucket]}${bucket === 'input' || bucket === 'output' ? '（必填）' : '（可选）'}`}
      error={errors[bucket]}
      description={bucket === 'input' || bucket === 'output' ? undefined : '留空时不单独设置此项价格。'}
    >
      <Input
        type="text"
        inputMode="decimal"
        maxLength={18}
        pattern="(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?"
        placeholder="例如 0.25"
        required={bucket === 'input' || bucket === 'output'}
        value={value[bucket]}
        onChange={event => onChange({ ...value, [bucket]: event.currentTarget.value })}
      />
    </Field>)}
  </fieldset>;
}
