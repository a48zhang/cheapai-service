import { ApiError } from '../../http';
import { formatUnitsToUsd, MONEY_CURRENCY, MONEY_DECIMALS, parseUnits } from '../../billing/money';
import { DesktopSessionAuthError } from './authenticate';
import { findDesktopAuthUserById } from './session-repository';
import type { AuthenticatedDesktopSession } from './authenticate';
import type { DesktopAuthUserRow } from './session-repository';
import type { DesktopAccountData, DesktopPublicUser } from '@sub2api/desktop-contracts';

function activeAccount(row: DesktopAuthUserRow): void {
  if (row.status !== 'active') throw new DesktopSessionAuthError('user_inactive');
  if (row.group_status !== 'active' || row.authorized_group_id !== row.group_id) {
    throw new DesktopSessionAuthError('group_unavailable');
  }
}

/** Read the current public user and authoritative D1 balance. Identity comes
 * only from the authenticated session projection, never a request field.
 */
export async function getDesktopAccount(
  database: D1Database,
  authenticated: AuthenticatedDesktopSession,
): Promise<DesktopAccountData> {
  let row: DesktopAuthUserRow | null;
  try {
    row = await findDesktopAuthUserById(database, authenticated.session.user_id);
  } catch (error) {
    throw new ApiError('service_unavailable', { cause: error });
  }
  if (row === null) throw new DesktopSessionAuthError('user_inactive');
  activeAccount(row);

  let units: bigint;
  try {
    units = parseUnits(row.balance_units);
  } catch (error) {
    throw new ApiError('service_unavailable', { cause: error });
  }
  const balanceUnits = units.toString();
  const user: DesktopPublicUser = {
    id: row.id,
    email_normalized: row.email_normalized,
    role: row.role,
    status: row.status,
    group_id: row.group_id,
    group_status: row.group_status as 'active' | 'disabled',
    balance_units: balanceUnits,
    email_verified_at: row.email_verified_at,
  };
  return {
    user,
    balance: {
      currency: MONEY_CURRENCY,
      decimals: MONEY_DECIMALS,
      balance_units: balanceUnits,
      balance_usd: formatUnitsToUsd(units),
    },
  };
}
