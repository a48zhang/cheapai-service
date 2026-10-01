import type { ProtocolRequest } from '@sub2api/apicompat/capabilities/check';
import { validateResponsesRequest } from '@sub2api/apicompat/types/responses';
import type { InternalPlatformKeyAuth } from '../auth/key-repository';
import type { RouteCandidate } from '../cache/routes';
import { prepare } from '../db';
import { ApiError } from '../http';

export type ResponseHistoryFailure = 'invalid_reference' | 'unknown_reference' | 'ambiguous_reference'
  | 'incompatible_reference' | 'cross_protocol_reference' | 'item_reference_unavailable';
export class ResponseHistoryError extends ApiError {
  constructor(readonly reason: ResponseHistoryFailure) {
    super('invalid_request');
    this.name = 'ResponseHistoryError';
  }
}
export interface ResponseHistoryBinding {
  readonly userId: string;
  readonly keyId: string;
  readonly clientResponseId: string;
  readonly upstreamResponseId: string;
  readonly sourceRequestId: string;
  readonly publicModelId: string;
  readonly channelId: string;
  readonly upstreamModel: string;
  readonly upstreamProtocol: 'responses';
  /** Current matching mapping version; D09 does not persist its historical version. */
  readonly mappingVersion: number;
  readonly requiresAuthoritativeAdmission: true;
}
interface HistoryRow {
  id: string; user_id: string; api_key_id: string; channel_id: string; public_model_id: string;
  upstream_model: string; upstream_protocol: string; downstream_protocol: string; execution_status: string;
  mapping_version: number | null; current_upstream_model: string | null; response_id: string | null; group_id: string | null;
}
const referenceId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const requestUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** G14 MUST give P05 createResponseIds the B11 request UUID as its seed.
 * P05 emits exactly resp_${seed}; D09 continues storing only the upstream ID.
 */
export function responseIdForRequest(requestId: string): string {
  if (typeof requestId !== 'string' || !requestUuid.test(requestId)) throw new ResponseHistoryError('invalid_reference');
  return `resp_${requestId}`;
}

/** Native Responses ownership lookup, not provider-history reconstruction.
 * Only requests.response_id is authoritative here. D09 has no output-item-ID
 * ownership mapping, so item_reference must fail closed rather than be mistaken
 * for a response ID or matched to text in a saved prompt (no prompt is read).
 */
export async function bindResponseHistory(database: D1Database, subject: InternalPlatformKeyAuth,
  input: ProtocolRequest): Promise<ResponseHistoryBinding | null> {
  const raw = input.request as Record<string, unknown>;
  const items = Array.isArray(raw.input) ? raw.input : [];
  const hasItemReference = items.some(item => item !== null && typeof item === 'object' && item.type === 'item_reference');
  const previous = raw.previous_response_id;
  const hasPrevious = previous !== undefined && previous !== null;
  if (!hasPrevious && !hasItemReference) return null;
  if (input.protocol !== 'responses') throw new ResponseHistoryError('cross_protocol_reference');
  if (!validateResponsesRequest(input.request, { unknownFields: 'preserve' }).ok) throw new ResponseHistoryError('invalid_reference');
  if (hasItemReference) throw new ResponseHistoryError('item_reference_unavailable');
  if (!referenceId(previous) || !subject || subject.key.userId !== subject.user.id) throw new ResponseHistoryError('invalid_reference');
  const platformRequestId = previous.startsWith('resp_') && requestUuid.test(previous.slice(5)) ? previous.slice(5) : null;
  let rows: HistoryRow[];
  try {
    // Scope BEFORE matching an opaque provider ID: different accounts, Keys and
    // providers may legitimately return the same native response identifier.
    rows = (await prepare<HistoryRow>(database, `SELECT r.id,r.user_id,r.api_key_id,r.channel_id,r.public_model_id,
      r.upstream_model,r.upstream_protocol,r.downstream_protocol,r.execution_status,r.response_id,r.group_id,
      cm.config_version AS mapping_version,cm.upstream_model AS current_upstream_model
      FROM requests r LEFT JOIN channel_models cm ON cm.channel_id=r.channel_id
        AND cm.public_model_id=r.public_model_id AND cm.protocol=r.upstream_protocol
      WHERE r.user_id=? AND r.api_key_id=? AND ${platformRequestId === null ? 'r.response_id' : 'r.id'}=? ORDER BY r.id LIMIT 2`,
    [subject.user.id, subject.key.id, platformRequestId ?? previous]).all()).rows;
  } catch { throw new ApiError('service_unavailable'); }
  if (rows.length === 0) throw new ResponseHistoryError('unknown_reference');
  // A collision within one Key cannot safely choose a provider/channel by luck.
  if (rows.length !== 1) throw new ResponseHistoryError('ambiguous_reference');
  const row = rows[0]!;
  // Older in-memory fixtures may omit the post-0023 projection field; that is
  // equivalent to the persisted NULL/unknown group for legacy history.
  const historyGroupId = row.group_id === undefined ? null : row.group_id;
  if (!referenceId(row.response_id) || row.upstream_protocol !== 'responses' || row.downstream_protocol !== 'responses' || row.execution_status !== 'succeeded' ||
      row.public_model_id !== input.request.model || row.current_upstream_model !== row.upstream_model ||
      row.mapping_version === null || !Number.isSafeInteger(row.mapping_version) || row.mapping_version < 1 ||
      (historyGroupId !== null && historyGroupId !== subject.group.id) ||
      ((subject.key as unknown as { kind?: unknown }).kind === 'web_chat' && historyGroupId !== subject.group.id)) {
    throw new ResponseHistoryError('incompatible_reference');
  }
  return Object.freeze({ userId: subject.user.id, keyId: subject.key.id, clientResponseId: previous, upstreamResponseId: row.response_id, sourceRequestId: row.id,
    publicModelId: row.public_model_id, channelId: row.channel_id, upstreamModel: row.upstream_model,
    upstreamProtocol: 'responses', mappingVersion: row.mapping_version, requiresAuthoritativeAdmission: true });
}

/** Restore only the bound native reference on an isolated wire request. No
 * history/body lookup and no mutation of the client's original request object.
 */
export function rewriteResponseHistoryRequest(input: ProtocolRequest, binding: ResponseHistoryBinding): ProtocolRequest {
  if (input.protocol !== 'responses' || input.request.previous_response_id !== binding.clientResponseId ||
      input.request.model !== binding.publicModelId) throw new ResponseHistoryError('incompatible_reference');
  return { protocol: 'responses', request: { ...input.request, previous_response_id: binding.upstreamResponseId } };
}

/** Intersect this with C16 candidates BEFORE choosing/acquiring a channel. Never
 * replace the candidate's channel or mapping after selection. G03 must still
 * check all current permissions/statuses/versions in its final D1 transaction.
 */
export function matchesResponseHistoryBinding(binding: ResponseHistoryBinding, candidate: RouteCandidate): boolean {
  return candidate.channel.id === binding.channelId && candidate.mapping.channelId === binding.channelId
    && candidate.mapping.publicModelId === binding.publicModelId && candidate.mapping.upstreamModel === binding.upstreamModel
    && candidate.mapping.protocol === binding.upstreamProtocol && candidate.mapping.capabilities.protocol === binding.upstreamProtocol
    && candidate.mapping.configVersion === binding.mappingVersion;
}
