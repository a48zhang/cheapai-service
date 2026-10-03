import { prepare } from '../db';
import type { AdminUserListItem } from './user-routes';

export type AdminUserDetail = AdminUserListItem & { allowed_group_ids: string[] };

/** Same public projection as the administrator list; no password or credential columns. */
export async function getAdminUserDetail(database: D1Database, id: string): Promise<AdminUserDetail | null> {
  const row = await prepare<AdminUserListItem & { allowed_group_ids_json: string }>(database,
    `SELECT u.id,u.email_normalized,u.role,u.status,u.group_id,g.name AS group_name,g.status AS group_status,
      CAST(u.balance_units AS TEXT) AS balance_units,u.concurrency_limit,u.rpm_limit,u.email_verified_at,
      u.created_at,u.updated_at,u.version,
      (SELECT json_group_array(group_id) FROM
        (SELECT group_id FROM user_group_access WHERE user_id=u.id ORDER BY group_id)) AS allowed_group_ids_json
      FROM users u JOIN groups g ON g.id=u.group_id WHERE u.id=?`, [id]).first();
  if (!row) return null;
  const { allowed_group_ids_json, ...user } = row;
  return { ...user, allowed_group_ids: JSON.parse(allowed_group_ids_json) as string[] };
}
