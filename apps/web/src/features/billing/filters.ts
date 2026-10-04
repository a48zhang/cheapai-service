import type { BillingQuery } from '@cheapai/contracts/billing';
import { parseLocalDateTime } from '../../shared/lib/datetime';

const MAX_DATE_MS = 8_640_000_000_000_000;

export interface BillingDateRange {
  readonly startDate: string;
  readonly endDate: string;
  readonly createdFrom?: number;
  readonly createdBefore?: number;
}

function localDateInput(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timestampParam(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp <= MAX_DATE_MS ? timestamp : undefined;
}

export function currentBillingMonthRange(now = new Date()): BillingDateRange {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const end = new Date(nextMonth.getTime() - 1);
  return {
    startDate: localDateInput(start.getTime()),
    endDate: localDateInput(end.getTime()),
    createdFrom: start.getTime(),
    createdBefore: nextMonth.getTime(),
  };
}

/** Read UTC millisecond boundaries from the URL and show their browser-local calendar dates. */
export function billingDateRangeFromSearch(
  params: URLSearchParams,
  now = new Date(),
): BillingDateRange {
  const hasFrom = params.has('createdFrom');
  const hasBefore = params.has('createdBefore');
  if (!hasFrom && !hasBefore) return currentBillingMonthRange(now);

  const from = timestampParam(params.get('createdFrom'));
  const before = timestampParam(params.get('createdBefore'));
  if ((hasFrom && from === undefined) || (hasBefore && before === undefined)) {
    return currentBillingMonthRange(now);
  }
  if (from !== undefined && before !== undefined && from >= before) {
    return currentBillingMonthRange(now);
  }

  return {
    startDate: from === undefined ? '' : localDateInput(from),
    endDate: before === undefined || before < 1 ? '' : localDateInput(before - 1),
    ...(from === undefined ? {} : { createdFrom: from }),
    ...(before === undefined ? {} : { createdBefore: before }),
  };
}

function localStartOfDay(dateInput: string): number | undefined {
  if (!/^\d{4,}-\d{2}-\d{2}$/u.test(dateInput)) return undefined;
  return parseLocalDateTime(`${dateInput}T00:00`);
}

function localExclusiveEnd(dateInput: string): number | undefined {
  const start = localStartOfDay(dateInput);
  if (start === undefined) return undefined;
  const nextDay = new Date(start);
  nextDay.setDate(nextDay.getDate() + 1);
  const end = nextDay.getTime();
  return Number.isSafeInteger(end) && end >= 0 && end <= MAX_DATE_MS ? end : undefined;
}

/** Convert inclusive local date controls to the API's inclusive/exclusive UTC millisecond bounds. */
export function billingDateBoundsFromInputs(
  startDate: string,
  endDate: string,
): Pick<BillingQuery, 'createdFrom' | 'createdBefore'> | undefined {
  const createdFrom = startDate ? localStartOfDay(startDate) : undefined;
  const createdBefore = endDate ? localExclusiveEnd(endDate) : undefined;
  if ((startDate && createdFrom === undefined) || (endDate && createdBefore === undefined)) {
    return undefined;
  }
  if (createdFrom !== undefined && createdBefore !== undefined && createdFrom >= createdBefore) {
    return undefined;
  }
  return {
    ...(createdFrom === undefined ? {} : { createdFrom }),
    ...(createdBefore === undefined ? {} : { createdBefore }),
  };
}
