import { multiplyPriceDecimal } from '@cheapai/contracts/price-decimal';
export { multiplyPriceDecimal } from '@cheapai/contracts/price-decimal';

function groupedInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** Formats an exact price amount without rounding small prices to zero. */
export function formatPriceAmount(
  basePrice: string | undefined,
  billingMultiplier: string | undefined = '1',
): string {
  const effectivePrice = multiplyPriceDecimal(basePrice, billingMultiplier);
  if (effectivePrice === null) return '价格暂不可用';
  const [whole = '0', fraction] = effectivePrice.split('.');
  const amount =
    fraction === undefined ? groupedInteger(whole) : `${groupedInteger(whole)}.${fraction}`;
  return amount;
}

/** Formats an exact effective credit rate per million tokens without using floating point. */
export function formatCreditsPerMillionTokens(
  basePrice: string | undefined,
  billingMultiplier: string | undefined,
): string {
  if (billingMultiplier === undefined) return '价格暂不可用';
  const amount = formatPriceAmount(basePrice, billingMultiplier);
  return amount === '价格暂不可用' ? amount : `${amount} 积分 / 百万 Token`;
}
