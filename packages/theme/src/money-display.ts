/** USD display only; ledger amounts use integer units with eight decimal places. */
export function formatUsdUnits(units: bigint, decimals = 8): string {
  const negative = units < 0n;
  const divisor = 10n ** BigInt(8 - decimals);
  const magnitude = ((negative ? -units : units) + divisor / 2n) / divisor;
  const digits = magnitude.toString().padStart(decimals + 1, '0');
  const amount =
    decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return `${negative && magnitude !== 0n ? '-' : ''}${amount}`;
}

/** Consumption retains every ledger decimal, omitting insignificant trailing zeroes. */
export function formatConsumptionUsd(value: string | bigint): string {
  return formatUsdUnits(BigInt(value)).replace(/\.?0+$/u, '');
}

/** Wallet displays are rounded to cents, including a stable two-digit fraction. */
export function formatWalletUsd(value: string | bigint): string {
  return formatUsdUnits(BigInt(value), 2);
}
