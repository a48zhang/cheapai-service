export type DateTimeInput = Date | number | string | null | undefined;

export interface FormatDateTimeOptions extends Intl.DateTimeFormatOptions {
  readonly locale?: string;
}

const INVALID_DATE_LABEL = '—';

/** Format epoch milliseconds, ISO date strings, or Date objects consistently for the current locale/time zone. */
export function formatDateTime(value: DateTimeInput, options: FormatDateTimeOptions = {}): string {
  if (value === null || value === undefined) return INVALID_DATE_LABEL;

  const date = value instanceof Date
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
