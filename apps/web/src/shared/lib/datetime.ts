export type DateTimeInput = Date | number | string | null | undefined;

export interface FormatDateTimeOptions extends Intl.DateTimeFormatOptions {
  readonly locale?: string;
}

const INVALID_DATE_LABEL = '—';

/** Local browser input text; exact precision preserves existing URL filter boundaries. */
export function formatLocalDateTime(value: number | null | undefined, exact = false): string {
  if (value === null || value === undefined) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const shifted = new Date(value - date.getTimezoneOffset() * 60_000);
  if (!Number.isFinite(shifted.getTime())) return '';
  const local = shifted.toISOString();
  return exact ? local.slice(0, -1) : local.slice(0, 16);
}

/** Empty/invalid input has no timestamp; callers distinguish it using the original text. */
export function parseLocalDateTime(value: string): number | undefined {
  if (!/^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/u.test(value)) return undefined;
  const timestamp = new Date(value).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return undefined;
  const normalized = formatLocalDateTime(timestamp, true);
  // Date can normalize invalid days or nonexistent local times instead of rejecting them.
  const canonical =
    value.length === 16
      ? `${value}:00.000`
      : value.length === 19
        ? `${value}.000`
        : value.padEnd(23, '0');
  return normalized === canonical ? timestamp : undefined;
}

export function parseLocalDateRange(
  fromText: string,
  toText: string,
): { from?: number; to?: number } {
  const from = parseLocalDateTime(fromText);
  const to = parseLocalDateTime(toText);
  if ((fromText && from === undefined) || (toText && to === undefined))
    throw new RangeError('请输入有效的时间范围。');
  if (from !== undefined && to !== undefined && from > to)
    throw new RangeError('开始时间不能晚于结束时间。');
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/** Format epoch milliseconds, ISO date strings, or Date objects consistently for the current locale/time zone. */
export function formatDateTime(value: DateTimeInput, options: FormatDateTimeOptions = {}): string {
  if (value === null || value === undefined) return INVALID_DATE_LABEL;

  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === 'number' || typeof value === 'string'
        ? new Date(value)
        : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) return INVALID_DATE_LABEL;

  const { locale = 'zh-CN', ...dateOptions } = options;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...dateOptions,
  }).format(date);
}
