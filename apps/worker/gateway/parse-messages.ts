import { parseMessagesRequest } from '@sub2api/apicompat/types/messages';
import type { MessagesRequest } from '@sub2api/apicompat/types/messages';
import { identifyRequestFeatures } from '@sub2api/apicompat/capabilities/check';
import type { RequestFeatures } from '@sub2api/apicompat/capabilities/check';
import type { ProtocolError } from '@sub2api/apicompat/types/shared';
import { ApiError } from '../http';
import { readGatewayJson } from './read-json';

export const MESSAGES_INPUT_VERSION = '2023-06-01';
export interface ParsedMessagesInput {
  readonly protocol: 'messages';
  readonly request: MessagesRequest;
  readonly model: string;
  readonly stream: boolean;
  readonly features: RequestFeatures;
  readonly version: typeof MESSAGES_INPUT_VERSION;
  /** Requested header extensions, not permission to forward them. G01 still
   * requires a trusted upstream allowlist and strips them across protocols. */
  readonly betas: readonly string[];
}
export class MessagesInputError extends ApiError {
  readonly status = 400;
  readonly protocolError: ProtocolError;
  constructor(error: ProtocolError) { super('invalid_request'); this.name = 'MessagesInputError'; this.protocolError = error; }
}
function invalid(code: string, param: string): never {
  throw new MessagesInputError({ kind: 'invalid_request', code, param, message: 'Invalid Messages request.' });
}

/** This compatibility endpoint supplies the supported version when omitted;
 * an explicit version is never silently rewritten. No upstream call here. */
export async function parseMessagesInput(input: Request, options: { maxBodyBytes?: number; maxOutputTokens?: number } = {}): Promise<ParsedMessagesInput> {
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) {
    throw new ApiError('service_unavailable');
  }
  const version = input.headers.get('anthropic-version') ?? MESSAGES_INPUT_VERSION;
  if (version !== MESSAGES_INPUT_VERSION) invalid('unsupported_messages_version', 'anthropic-version');
  const rawBetas = input.headers.get('anthropic-beta');
  const betas = rawBetas === null ? [] : rawBetas.split(',').map(value => value.trim());
  if (rawBetas !== null && (rawBetas.length > 2048 || /[\u0000-\u001f\u007f]/.test(rawBetas)
    || betas.length > 16 || betas.some(value => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)))) invalid('invalid_messages_beta', 'anthropic-beta');
  const raw = await readGatewayJson(input, options.maxBodyBytes);
  const parsed = parseMessagesRequest(raw, { unknownFields: 'preserve' });
  if (!parsed.ok) throw new MessagesInputError(parsed.error);
  const request = parsed.value;
  if (request.model.length > 128 || request.model.trim() !== request.model || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(request.model)) {
    invalid('invalid_public_model', '$.model');
  }
  const features = identifyRequestFeatures({ protocol: 'messages', request });
  if (!features.ok) throw new MessagesInputError(features.error);
  if (options.maxOutputTokens !== undefined && request.max_tokens > options.maxOutputTokens) invalid('output_limit_exceeded', '$.max_tokens');
  return { protocol: 'messages', request, model: request.model, stream: request.stream === true,
    features: features.value, version: MESSAGES_INPUT_VERSION, betas: [...new Set(betas)] };
}
