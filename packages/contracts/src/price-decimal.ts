const decimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parseDecimal(value: string): DecimalParts | null {
  if (!decimalPattern.test(value)) return null;
  const point = value.indexOf('.');
  const whole = point === -1 ? value : value.slice(0, point);
  const fraction = point === -1 ? '' : value.slice(point + 1);
  try {
    return { coefficient: BigInt(whole + fraction), scale: fraction.length };
  } catch {
    return null;
  }
}

function decimalText(coefficient: bigint, scale: number): string {
  if (scale === 0) return coefficient.toString();
  const padded = coefficient.toString().padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Multiplies nonnegative decimal strings exactly. Returns null for unavailable or malformed input. */
export function multiplyPriceDecimal(
  basePrice: string | undefined,
  billingMultiplier: string | undefined,
): string | null {
  if (basePrice === undefined || billingMultiplier === undefined) return null;
  const price = parseDecimal(basePrice);
  const multiplier = parseDecimal(billingMultiplier);
  if (price === null || multiplier === null) return null;
  return decimalText(price.coefficient * multiplier.coefficient, price.scale + multiplier.scale);
}
