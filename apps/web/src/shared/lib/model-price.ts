import { multiplyPriceDecimal } from '@cheapai/contracts/price-decimal';
export { multiplyPriceDecimal } from '@cheapai/contracts/price-decimal';

function groupedInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** Formats an exact USD amount without rounding small prices to zero. */
export function formatUsdAmount(
  basePrice: string | undefined,
  billingMultiplier: string | undefined = '1',
): string {
  const effectivePrice = multiplyPriceDecimal(basePrice, billingMultiplier);
  if (effectivePrice === null) return '价格暂不可用';
  const [whole = '0', fraction] = effectivePrice.split('.');
  const amount =
    fraction === undefined ? groupedInteger(whole) : `${groupedInteger(whole)}.${fraction}`;
  return `$${amount}`;
}

/** Formats an exact effective USD rate per million tokens without using floating point. */
export function formatUsdPerMillionTokens(
  basePrice: string | undefined,
  billingMultiplier: string | undefined,
): string {
  if (billingMultiplier === undefined) return '价格暂不可用';
  const amount = formatUsdAmount(basePrice, billingMultiplier);
  return amount === '价格暂不可用' ? amount : `${amount} / 百万 Token`;
}
