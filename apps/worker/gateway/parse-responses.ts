import { validateResponsesRequest } from '@sub2api/apicompat/types/responses';
import type { ResponsesRequest } from '@sub2api/apicompat/types/responses';
import { identifyRequestFeatures } from '@sub2api/apicompat/capabilities/check';
import type { RequestFeatures } from '@sub2api/apicompat/capabilities/check';
import type { ProtocolError } from '@sub2api/apicompat/types/shared';
import { ApiError } from '../http';
import { readGatewayJson } from './read-json';

export interface ParsedResponsesInput {
  readonly protocol: 'responses';
  readonly request: ResponsesRequest;
  readonly model: string;
  readonly stream: boolean;
  readonly features: RequestFeatures;
}
export class ResponsesInputError extends ApiError {
  readonly status = 400;
  readonly protocolError: ProtocolError;
  constructor(error: ProtocolError) { super('invalid_request'); this.name = 'ResponsesInputError'; this.protocolError = error; }
}
function invalid(code: string, param: string): never {
  throw new ResponsesInputError({ kind: 'invalid_request', code, param, message: 'Invalid Responses request.' });
}

/** Full client history stays in native form. Reference ownership is a separate
 * G13/D1 step; a syntactically valid reference never grants a history binding. */
export async function parseResponsesInput(input: Request, options: { maxBodyBytes?: number; maxOutputTokens?: number } = {}): Promise<ParsedResponsesInput> {
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) {
    throw new ApiError('service_unavailable');
  }
  const raw = await readGatewayJson(input, options.maxBodyBytes);
  const parsed = validateResponsesRequest(raw, { unknownFields: 'preserve', native: true });
  if (!parsed.ok) throw new ResponsesInputError(parsed.error);
  const request = parsed.value;
  if (request.model.length > 128 || request.model.trim() !== request.model || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(request.model)) {
    invalid('invalid_public_model', '$.model');
  }
  const features = identifyRequestFeatures({ protocol: 'responses', request });
  if (!features.ok) throw new ResponsesInputError(features.error);
  if (options.maxOutputTokens !== undefined && features.value.outputTokenLimit !== undefined && features.value.outputTokenLimit > options.maxOutputTokens) {
    invalid('output_limit_exceeded', '$.max_output_tokens');
  }
  return { protocol: 'responses', request, model: request.model, stream: request.stream === true, features: features.value };
}
