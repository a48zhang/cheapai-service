import { prepare } from '../db';
import { ApiError } from '../http';
import { decryptChannelSecret } from './channel-secrets';
import type { ChannelKeyring } from './channel-secrets';

export interface ChannelEncryptionKey { keyVersion: string; key: Uint8Array }

export interface ChannelView {
  id: string; name: string; baseUrl: string; status: 'active' | 'disabled';
  priority: number; concurrencyLimit: number; rpmLimit: number; configVersion: number;
  createdAt: number; updatedAt: number; hasCredential: boolean;
  models: { publicModelId: string; upstreamModel: string; protocol: string; mappingVersion: number; priceVersion: number }[];
}
interface ChannelRow {
  id: string; name: string; base_url: string; status: 'active' | 'disabled'; priority: number;
  concurrency_limit: number; rpm_limit: number; config_version: number; created_at: number; updated_at: number; has_credential: number; models_json: string;
}
const projection = `id,name,base_url,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at,1 AS has_credential,
  (SELECT json_group_array(json_object('publicModelId',cm.public_model_id,'upstreamModel',cm.upstream_model,'protocol',cm.protocol,'mappingVersion',cm.config_version,'priceVersion',m.price_version))
    FROM channel_models cm JOIN models m ON m.public_model_id=cm.public_model_id WHERE cm.channel_id=channels.id) AS models_json`;
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError('invalid_request');
  return value;
}
function idValue(value: unknown): string {
  const id = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(id)) throw new ApiError('invalid_request');
  return id;
}
function view(row: ChannelRow): ChannelView {
  return { id: row.id, name: row.name, baseUrl: row.base_url, status: row.status, priority: row.priority,
    concurrencyLimit: row.concurrency_limit, rpmLimit: row.rpm_limit, configVersion: row.config_version,
    createdAt: row.created_at, updatedAt: row.updated_at, hasCredential: row.has_credential === 1, models: JSON.parse(row.models_json) as ChannelView['models'] };
}
/** Safe internal/admin metadata read. It never selects encrypted credentials. */
export async function getChannelById(database: D1Database, id: string): Promise<ChannelView | null> {
  const row = await prepare<ChannelRow>(database, `SELECT ${projection} FROM channels WHERE id=?`, [idValue(id)]).first();
  return row ? view(row) : null;
}

/** Forwarding-only secret access. Never expose this result through admin routes.
 * Current authorization/admission and active-state checks remain gateway duties.
 */
export async function readChannelForForwarding(database: D1Database, id: string, keyring: ChannelKeyring): Promise<{ id: string; baseUrl: string; upstreamKey: string; configVersion: number; status: 'active' | 'disabled' } | null> {
  const row = await prepare<{ id: string; base_url: string; secret_ciphertext: string; config_version: number; status: 'active' | 'disabled' }>(database,
    'SELECT id,base_url,secret_ciphertext,config_version,status FROM channels WHERE id=?', [idValue(id)]).first();
  if (!row) return null;
  try { return { id: row.id, baseUrl: row.base_url, upstreamKey: await decryptChannelSecret(row.secret_ciphertext, row.id, keyring), configVersion: row.config_version, status: row.status }; }
  catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
}

export type { ChannelRow };
export { projection as channelProjection, view as decodeChannelRow, text as channelText, idValue as channelId };
