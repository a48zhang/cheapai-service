export const MONEY_CURRENCY = 'USD' as const;
export const MONEY_DECIMALS = 8;
export const UNITS_PER_USD = 100_000_000n;
export const MAX_SAFE_UNITS = 9_007_199_254_740_991n;
export const MIN_SAFE_UNITS = -MAX_SAFE_UNITS;

export class MoneyError extends Error {
  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
    this.name = 'MoneyError';
  }
}

function checkedUnits(value: unknown): bigint {
  if (typeof value !== 'bigint') {
    throw new MoneyError('units must be a bigint');
  }
  if (value < MIN_SAFE_UNITS || value > MAX_SAFE_UNITS) {
    throw new MoneyError('units exceed the safe integer range');
  }
  return value;
}

/** Parse canonical integer units from JSON/storage text. No plus sign, leading
 * zeros, negative zero, whitespace, exponent, decimal point, or coercion.
 */
export function parseUnits(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 17 || value.trim() !== value
      || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    throw new MoneyError('expected a canonical integer units string');
  }
  return checkedUnits(BigInt(value));
}

/** Parse USD exactly: optional minus, canonical integer part, optional 1–8
 * fractional digits. Trailing fractional zeros are allowed; negative zero is
 * rejected. Inputs with more than eight decimal places are never rounded.
 */
export function parseUsdToUnits(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 18 || value.trim() !== value
      || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(value)) {
    throw new MoneyError('expected a decimal USD string with at most eight fractional digits');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const magnitude = BigInt(whole) * UNITS_PER_USD + BigInt(fraction.padEnd(MONEY_DECIMALS, '0'));
  if (negative && magnitude === 0n) throw new MoneyError('negative zero is not canonical');
  return checkedUnits(negative ? -magnitude : magnitude);
}

/** Format bounded units as USD with exactly eight fractional digits, no loss. */
export function formatUnitsToUsd(value: bigint): string {
  const units = checkedUnits(value);
  const magnitude = units < 0n ? -units : units;
  const whole = magnitude / UNITS_PER_USD;
  const fraction = (magnitude % UNITS_PER_USD).toString().padStart(MONEY_DECIMALS, '0');
  return `${units < 0n ? '-' : ''}${whole}.${fraction}`;
}

/** The only number conversion: validate immediately before a D1 INTEGER bind.
 * Keep calculations/intermediate products as bigint, then validate their result.
 */
export function unitsToSafeNumber(value: bigint): number {
  return Number(checkedUnits(value));
}
