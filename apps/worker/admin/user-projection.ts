/** Safe administrator-facing user columns shared by the list and detail queries. */
export interface AdminUserProjection {
  id: string;
  email_normalized: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  group_id: string;
  group_name: string;
  group_status: 'active' | 'disabled';
  balance_units: string;
  concurrency_limit: number;
  rpm_limit: number;
  email_verified_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
}

/** Row shape returned from the database before decoding the allowed-group aggregate. */
export interface AdminUserProjectionRow extends AdminUserProjection {
  allowed_group_ids_json: string;
}

/** Public list and detail shape. */
export type AdminUserListItem = AdminUserProjection & { allowed_group_ids: string[] };

/** Explicit public projection. Keep secrets such as password_hash and credentials out. */
export const ADMIN_USER_PROJECTION_SQL = `SELECT u.id,u.email_normalized,u.role,u.status,u.group_id,
  g.name AS group_name,g.status AS group_status,
  CAST(u.balance_units AS TEXT) AS balance_units,u.concurrency_limit,u.rpm_limit,u.email_verified_at,
  u.created_at,u.updated_at,u.version,
  (SELECT json_group_array(group_id) FROM
    (SELECT group_id FROM user_group_access WHERE user_id=u.id ORDER BY group_id)) AS allowed_group_ids_json`;

/** Shared current-group join for the safe administrator projection. */
export const ADMIN_USER_PROJECTION_FROM_SQL = 'FROM users u JOIN groups g ON g.id=u.group_id';

export function decodeAdminUserProjection(row: AdminUserProjectionRow): AdminUserListItem {
  const { allowed_group_ids_json, ...user } = row;
  return { ...user, allowed_group_ids: JSON.parse(allowed_group_ids_json) as string[] };
}
