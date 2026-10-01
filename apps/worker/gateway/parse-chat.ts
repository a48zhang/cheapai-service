import { parseChatRequest } from '@sub2api/apicompat/types/chat';
import type { ChatRequest } from '@sub2api/apicompat/types/chat';
import { identifyRequestFeatures } from '@sub2api/apicompat/capabilities/check';
import type { RequestFeatures } from '@sub2api/apicompat/capabilities/check';
import type { ProtocolError } from '@sub2api/apicompat/types/shared';
import { ApiError } from '../http';
import { readGatewayJson } from './read-json';

export interface ParsedChatInput {
  readonly protocol: 'chat';
  readonly request: ChatRequest;
  readonly model: string;
  readonly stream: boolean;
  readonly features: RequestFeatures;
}
export class ChatInputError extends ApiError {
  readonly status = 400;
  readonly protocolError: ProtocolError;
  constructor(error: ProtocolError) { super('invalid_request'); this.name = 'ChatInputError'; this.protocolError = error; }
}
function invalid(code: string, param: string): never {
  throw new ChatInputError({ kind: 'invalid_request', code, param, message: 'Invalid Chat Completions request.' });
}

/** Parse before selecting a channel. Preserved JSON extensions are requirements,
 * not forwarding permission: C16/P22 must still approve capability and adapter. */
export async function parseChatInput(input: Request, options: { maxBodyBytes?: number; maxOutputTokens?: number } = {}): Promise<ParsedChatInput> {
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) {
    throw new ApiError('service_unavailable');
  }
  const raw = await readGatewayJson(input, options.maxBodyBytes);
  const parsed = parseChatRequest(raw, { unknownFields: 'preserve' });
  if (!parsed.ok) throw new ChatInputError(parsed.error);
  const request = parsed.value;
  if (request.model.length > 128 || request.model.trim() !== request.model || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(request.model)) {
    invalid('invalid_public_model', '$.model');
  }
  const features = identifyRequestFeatures({ protocol: 'chat', request });
  if (!features.ok) throw new ChatInputError(features.error);
  if (options.maxOutputTokens !== undefined && features.value.outputTokenLimit !== undefined && features.value.outputTokenLimit > options.maxOutputTokens) {
    invalid('output_limit_exceeded', '$.max_completion_tokens');
  }
  return { protocol: 'chat', request, model: request.model, stream: request.stream === true, features: features.value };
}
