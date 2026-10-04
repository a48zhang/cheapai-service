import { prepare } from '../db';
import { ADMIN_USER_PROJECTION_FROM_SQL, ADMIN_USER_PROJECTION_SQL, decodeAdminUserProjection } from './user-projection';
import type { AdminUserListItem, AdminUserProjectionRow } from './user-projection';

export type AdminUserDetail = AdminUserListItem;

/** Same public projection as the administrator list; no password or credential columns. */
export async function getAdminUserDetail(database: D1Database, id: string): Promise<AdminUserDetail | null> {
  const row = await prepare<AdminUserProjectionRow>(database,
    `${ADMIN_USER_PROJECTION_SQL} ${ADMIN_USER_PROJECTION_FROM_SQL} WHERE u.id=?`, [id]).first();
  if (!row) return null;
  return decodeAdminUserProjection(row);
}
