import { describe, expect, it } from 'vitest';
import {
  MAX_SAFE_UNITS, MIN_SAFE_UNITS, MONEY_CURRENCY, MONEY_DECIMALS,
  MoneyError, UNITS_PER_USD, formatUnitsToUsd, parseUnits, parseUsdToUnits, unitsToSafeNumber,
} from '../../apps/worker/billing/money';

describe('exact USD and integer units', () => {
  it('fixes USD at eight decimal places', () => {
    expect(MONEY_CURRENCY).toBe('USD');
    expect(MONEY_DECIMALS).toBe(8);
    expect(UNITS_PER_USD).toBe(100_000_000n);
  });

  it.each([
    ['0', 0n, '0.00000000'],
    ['0.00000000', 0n, '0.00000000'],
    ['1', 100_000_000n, '1.00000000'],
    ['1.2300', 123_000_000n, '1.23000000'],
    ['0.00000001', 1n, '0.00000001'],
    ['-0.00000001', -1n, '-0.00000001'],
    ['-12.34567890', -1_234_567_890n, '-12.34567890'],
    ['0.002', 200_000n, '0.00200000'],
    ['90071992.54740991', MAX_SAFE_UNITS, '90071992.54740991'],
    ['-90071992.54740991', MIN_SAFE_UNITS, '-90071992.54740991'],
  ] as const)('parses %s and formats all eight digits', (input, units, formatted) => {
    expect(parseUsdToUnits(input)).toBe(units);
    expect(formatUnitsToUsd(units)).toBe(formatted);
    expect(parseUsdToUnits(formatted)).toBe(units);
    expect(parseUnits(units.toString())).toBe(units);
  });

  it('subtracts into a negative balance and accumulates exactly without floats', () => {
    const balance = parseUsdToUnits('0.50') - parseUsdToUnits('0.75');
    expect(formatUnitsToUsd(balance)).toBe('-0.25000000');
    expect(unitsToSafeNumber(balance)).toBe(-25_000_000);
    expect(parseUsdToUnits('0.1') + parseUsdToUnits('0.2')).toBe(parseUsdToUnits('0.3'));
    expect(parseUsdToUnits('0.00000001') * 1_000_000n).toBe(parseUsdToUnits('0.01'));
  });

  it('rejects nondecimal/coerced/ambiguous USD and never rounds excess precision', () => {
    for (const input of [
      1, 0.1, 1n, null, undefined, NaN, Infinity, {}, ['1'],
      '', ' ', ' 1', '1 ', '1\n', '+1', '-0', '-0.0', '-0.00000000',
      '00', '01', '-01', '00.01', '.1', '-.1', '1.', '1e2', '1E-8',
      'NaN', 'Infinity', '0x10', '1,000', '1_000', '１',
      '0.000000001', '0.000000005', '1.000000000', '-0.000000001',
      '90071992.54740992', '-90071992.54740992', '90071993', '9'.repeat(1000),
    ]) {
      expect(() => parseUsdToUnits(input), String(input)).toThrow(MoneyError);
    }
  });

  it('parses canonical signed integer units including both boundaries', () => {
    for (const units of [0n, 1n, -1n, MAX_SAFE_UNITS, MIN_SAFE_UNITS]) {
      expect(parseUnits(units.toString())).toBe(units);
      const bound = unitsToSafeNumber(units);
      expect(Number.isSafeInteger(bound)).toBe(true);
      expect(BigInt(bound)).toBe(units);
    }
  });

  it('rejects invalid integer strings and values outside the safe range', () => {
    for (const input of [
      0, 1n, null, undefined, [], {}, '', ' ', '+1', '-0', '00', '01', '-01',
      '1.0', '1e8', '1\n', 'NaN', 'Infinity', '0x10', '--1',
      (MAX_SAFE_UNITS + 1n).toString(), (MIN_SAFE_UNITS - 1n).toString(), '1'.repeat(1000),
    ]) {
      expect(() => parseUnits(input), String(input)).toThrow(MoneyError);
    }
  });

  it('checks calculated results before formatting or D1 number binding', () => {
    for (const units of [MAX_SAFE_UNITS + 1n, MIN_SAFE_UNITS - 1n, MAX_SAFE_UNITS * UNITS_PER_USD]) {
      expect(() => formatUnitsToUsd(units)).toThrow(MoneyError);
      expect(() => unitsToSafeNumber(units)).toThrow(MoneyError);
    }
    // Runtime checks remain strict even for callers outside TypeScript.
    for (const input of [1, '1', undefined, null]) {
      expect(() => formatUnitsToUsd(input as unknown as bigint)).toThrow(MoneyError);
      expect(() => unitsToSafeNumber(input as unknown as bigint)).toThrow(MoneyError);
    }
  });

  it('round trips generated positive/negative units without decimal drift', () => {
    let value = 17n;
    for (let index = 0; index < 200; index++) {
      value = (value * 48_271n) % MAX_SAFE_UNITS;
      for (const signed of [value, -value]) {
        expect(parseUsdToUnits(formatUnitsToUsd(signed))).toBe(signed);
        expect(parseUnits(signed.toString())).toBe(signed);
        expect(BigInt(unitsToSafeNumber(signed))).toBe(signed);
      }
    }
  });
});
