import { z } from 'zod';

const accountBalanceShapeSchema = z.object({
  currency: z.literal('USD'),
  decimals: z.literal(8),
  balance_units: z
    .string()
    .max(128)
    .regex(/^(?:0|-?[1-9][0-9]*)$/u),
  balance_usd: z.string(),
});

/** Format an integer unit string without converting money through Number/float. */
function formatUnits(balanceUnits: string): string {
  const negative = balanceUnits.startsWith('-');
  const digits = (negative ? balanceUnits.slice(1) : balanceUnits).padStart(9, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

export const accountBalanceSchema = accountBalanceShapeSchema.refine(
  (value) => value.balance_usd === formatUnits(value.balance_units),
  { message: 'Inconsistent account balance.' },
);

export type AccountBalance = Readonly<z.infer<typeof accountBalanceSchema>>;

export function decodeAccountBalance(value: unknown): AccountBalance {
  return accountBalanceSchema.parse(value);
}
