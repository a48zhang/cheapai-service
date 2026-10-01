import { prepare } from '../db';
import { ApiError } from '../http';

export interface AvailableKeyGroup { id: string; name: string; models: string[] }
export async function listAvailableKeyGroups(database: D1Database, userId: string): Promise<AvailableKeyGroup[]> {
  const result = await prepare<{ id: string; name: string; models_json: string }>(database, `
    SELECT g.id,g.name,COALESCE((SELECT json_group_array(public_model_id) FROM (
      SELECT DISTINCT m.public_model_id FROM channel_groups cg
      JOIN channels c ON c.id=cg.channel_id JOIN channel_models cm ON cm.channel_id=c.id
      JOIN models m ON m.public_model_id=cm.public_model_id
      WHERE cg.group_id=g.id AND c.status='active' AND m.status='active' ORDER BY m.public_model_id
    )),'[]') AS models_json
    FROM user_group_access a JOIN groups g ON g.id=a.group_id JOIN users u ON u.id=a.user_id
    WHERE a.user_id=? AND u.status='active' AND g.status='active' ORDER BY CASE WHEN g.id=u.group_id THEN 0 ELSE 1 END,g.name,g.id`, [userId]).all();
  return result.rows.map(row => ({ id: row.id, name: row.name, models: JSON.parse(row.models_json) as string[] }));
}

export function validateGroupSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
    || !value.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(id))
    || new Set(value).size !== value.length) throw new ApiError('invalid_request');
  return [...value] as string[];
}
