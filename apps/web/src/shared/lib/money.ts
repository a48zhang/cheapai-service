const MONEY_DECIMALS = 8;
const UNITS_PER_USD = 100_000_000n;
const MAX_SAFE_UNITS = 9_007_199_254_740_991n;
const MIN_SAFE_UNITS = -MAX_SAFE_UNITS;
const CANONICAL_UNITS = /^(?:0|-?[1-9][0-9]*)$/u;
const DECIMAL_USD = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u;

export class MoneyError extends Error {
  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
    this.name = 'MoneyError';
  }
}

function checkedSafeUnits(value: bigint): bigint {
  if (value < MIN_SAFE_UNITS || value > MAX_SAFE_UNITS) {
    throw new MoneyError('units exceed the safe integer range');
  }
  return value;
}

/** True for a canonical integer-unit string; amounts remain strings at API boundaries. */
export function isCanonicalUnits(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && CANONICAL_UNITS.test(value);
}

/** Parse bounded canonical integer units without converting through a number. */
export function parseUnits(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 17 || value.trim() !== value || !CANONICAL_UNITS.test(value)) {
    throw new MoneyError('expected a canonical integer units string');
  }
  return checkedSafeUnits(BigInt(value));
}

/** Parse a USD decimal into integer units; values beyond eight decimals are rejected. */
export function parseUsdToUnits(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 18 || value.trim() !== value || !DECIMAL_USD.test(value)) {
    throw new MoneyError('expected a decimal USD string with at most eight fractional digits');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const magnitude = BigInt(whole) * UNITS_PER_USD + BigInt(fraction.padEnd(MONEY_DECIMALS, '0'));
  if (negative && magnitude === 0n) throw new MoneyError('negative zero is not canonical');
  return checkedSafeUnits(negative ? -magnitude : magnitude);
}

/** Format integer USD units, rounding half away from zero when reducing display precision. */
export function formatUnitsToUsd(value: string | bigint, decimals = MONEY_DECIMALS): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MONEY_DECIMALS) {
    throw new MoneyError('display precision must be between zero and eight');
  }
  if (typeof value !== 'string' && typeof value !== 'bigint') {
    throw new MoneyError('units must be a bigint or canonical integer string');
  }
  if (typeof value === 'string' && !isCanonicalUnits(value)) {
    throw new MoneyError('expected a canonical integer units string');
  }
  const units = typeof value === 'bigint' ? value : BigInt(value);
  const negative = units < 0n;
  const divisor = 10n ** BigInt(MONEY_DECIMALS - decimals);
  const magnitude = ((negative ? -units : units) + divisor / 2n) / divisor;
  const digits = magnitude.toString().padStart(decimals + 1, '0');
  const amount = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return `${negative && magnitude !== 0n ? '-' : ''}${amount}`;
}
