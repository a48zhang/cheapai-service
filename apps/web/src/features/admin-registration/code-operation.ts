import { ApiClientError } from '@cheapai/api-client/errors';
import type { CodeBatchInput, CodeBatch } from '@cheapai/contracts/registration-admin';
import type { AdminRegistrationApi } from '@cheapai/api-client/registration-admin';
export interface CodeIntent {
  operationId: string;
  input: CodeBatchInput;
}
export function createCodeIntent(input: CodeBatchInput, previous?: CodeIntent | null): CodeIntent {
  return previous ?? { operationId: crypto.randomUUID(), input: { ...input } };
}
export function canChangeCodeIntent(error: unknown) {
  return error instanceof ApiClientError && [400, 403].includes(error.status ?? 0);
}
export function executeCodeIntent(
  api: AdminRegistrationApi,
  intent: CodeIntent,
): Promise<CodeBatch> {
  return api.createCodes(intent.input, intent.operationId);
}
