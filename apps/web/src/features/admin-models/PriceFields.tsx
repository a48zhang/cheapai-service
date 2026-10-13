import { BILLABLE_BUCKETS } from '@cheapai/api-client/models';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';

export type PriceFieldValues = Readonly<Record<(typeof BILLABLE_BUCKETS)[number], string>>;
export type PriceFieldErrors = Partial<
  Record<(typeof BILLABLE_BUCKETS)[number], string | undefined>
>;

export interface PriceFieldsProps {
  readonly value: PriceFieldValues;
  readonly errors?: PriceFieldErrors;
  readonly disabled?: boolean;
  readonly onChange: (value: PriceFieldValues) => void;
}

const labels: Record<(typeof BILLABLE_BUCKETS)[number], string> = {
  input: '输入价格',
  output: '输出价格',
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  cacheWrite5m: '缓存写入（5 分钟）',
  cacheWrite1h: '缓存写入（1 小时）',
  reasoning: '推理价格',
};

/** Price fields remain decimal strings end to end; no browser number conversion occurs. */
export function PriceFields({ value, errors = {}, disabled = false, onChange }: PriceFieldsProps) {
  return (
    <fieldset
      disabled={disabled}
      className="grid gap-4 border-t border-[var(--color-border)] pt-5 sm:grid-cols-2"
    >
      <legend className="console-section-title pr-3">模型价格</legend>
      <p className="text-sm leading-5 text-[var(--color-muted-foreground)] sm:col-span-2">
        USD / 百万 Token；其他计费项留空表示未配置。
      </p>
      {(['input', 'output'] as const).map((bucket) => (
        <Field
          key={bucket}
          label={labels[bucket]}
          required={bucket === 'input' || bucket === 'output'}
          error={errors[bucket]}
        >
          <Input
            type="text"
            inputMode="decimal"
            maxLength={18}
            pattern="(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?"
            placeholder="例如 0.25"
            required={bucket === 'input' || bucket === 'output'}
            value={value[bucket]}
            onChange={(event) => onChange({ ...value, [bucket]: event.currentTarget.value })}
          />
        </Field>
      ))}
      <details className="sm:col-span-2" open={Object.values(errors).some(Boolean) || undefined}>
        <summary className="cursor-pointer font-medium">缓存与推理价格</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {BILLABLE_BUCKETS.filter((bucket) => bucket !== 'input' && bucket !== 'output').map(
            (bucket) => (
              <Field key={bucket} label={labels[bucket]} required={false} error={errors[bucket]}>
                <Input
                  type="text"
                  inputMode="decimal"
                  maxLength={18}
                  pattern="(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8})?"
                  placeholder="例如 0.25"
                  required={false}
                  value={value[bucket]}
                  onChange={(event) => onChange({ ...value, [bucket]: event.currentTarget.value })}
                />
              </Field>
            ),
          )}
        </div>
      </details>
    </fieldset>
  );
}
