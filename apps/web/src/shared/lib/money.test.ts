import { describe, expect, it } from 'vitest';
import { MoneyError, formatUnitsToUsd, parseUnits, parseUsdToUnits } from './money';

describe('exact USD amounts', () => {
  it('keeps fractional and negative values exact at the supported boundary', () => {
    expect(parseUsdToUnits('0.00000001')).toBe(1n);
    expect(parseUsdToUnits('1.2300')).toBe(123_000_000n);
    expect(parseUsdToUnits('-12.34567890')).toBe(-1_234_567_890n);
    expect(parseUsdToUnits('90071992.54740991')).toBe(9_007_199_254_740_991n);
    expect(parseUsdToUnits('-90071992.54740991')).toBe(-9_007_199_254_740_991n);
    expect(formatUnitsToUsd(-1_234_567_890n)).toBe('-12.34567890');
  });

  it('rejects coercion, noncanonical input, excess precision and values outside safe units', () => {
    for (const value of [1, 0.1, null, '', ' 1', '+1', '-0', '1e2', '1.000000001', '90071992.54740992']) {
      expect(() => parseUsdToUnits(value)).toThrow(MoneyError);
    }
    for (const value of [1, '', '01', '-0', '1.0', '9007199254740992', '-9007199254740992']) {
      expect(() => parseUnits(value)).toThrow(MoneyError);
    }
  });

  it('formats ledger units without passing through floating point', () => {
    expect(formatUnitsToUsd('1234567890123456')).toBe('12345678.90123456');
    expect(formatUnitsToUsd('-1')).toBe('-0.00000001');
  });
});
