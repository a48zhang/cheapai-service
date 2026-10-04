import { describe, expect, it } from 'vitest';
import { formatLocalDateTime, parseLocalDateTime, parseLocalDateRange } from './datetime';

describe('local datetime inputs', () => {
  it('round trips URL boundaries without losing seconds or milliseconds', () => {
    const timestamp = new Date(2026, 9, 4, 12, 34, 56, 789).getTime();
    const text = formatLocalDateTime(timestamp, true);
    expect(parseLocalDateTime(text)).toBe(timestamp);
    expect(parseLocalDateRange(text, text)).toEqual({ from: timestamp, to: timestamp });
    expect(parseLocalDateRange('', text)).toEqual({ to: timestamp });
  });

  it('rejects impossible calendar dates, reversed ranges and nonlocal input', () => {
    expect(parseLocalDateTime('2026-02-30T12:00')).toBeUndefined();
    expect(parseLocalDateTime('2026-10-04T12:00Z')).toBeUndefined();
    expect(parseLocalDateTime('')).toBeUndefined();
    expect(parseLocalDateRange('', '')).toEqual({});
    expect(() => parseLocalDateRange('2026-10-05T12:00', '2026-10-04T12:00')).toThrow(RangeError);
    expect(() => parseLocalDateRange('invalid', '')).toThrow(RangeError);
    expect(formatLocalDateTime(Number.NaN)).toBe('');
  });
});
