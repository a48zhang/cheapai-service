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
  readonly version: string;
  /** Native provider extensions, forwarded when the selected upstream is Messages. */
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
export async function parseMessagesInput(input: Request, options: { maxBodyBytes?: number } = {}): Promise<ParsedMessagesInput> {
  const version = input.headers.get('anthropic-version') ?? MESSAGES_INPUT_VERSION;
  const rawBetas = input.headers.get('anthropic-beta');
  const betas = rawBetas === null ? [] : rawBetas.split(',').map(value => value.trim());
  const raw = await readGatewayJson(input, options.maxBodyBytes);
  const parsed = parseMessagesRequest(raw, { unknownFields: 'preserve', native: true });
  if (!parsed.ok) throw new MessagesInputError(parsed.error);
  const request = parsed.value;
  if (request.model.length > 128 || request.model.trim() !== request.model || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(request.model)) {
    invalid('invalid_public_model', '$.model');
  }
  const features = identifyRequestFeatures({ protocol: 'messages', request });
  if (!features.ok) throw new MessagesInputError(features.error);
  return { protocol: 'messages', request, model: request.model, stream: request.stream === true,
    features: features.value, version, betas: [...new Set(betas)] };
}
