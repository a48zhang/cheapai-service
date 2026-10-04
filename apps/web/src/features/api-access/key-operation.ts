import { ApiClientError } from '@cheapai/api-client/errors';
import type { KeyCreation, KeyInput, KeyMetadata } from '@cheapai/api-client/keys';
import type { KeysApi } from '@cheapai/api-client/keys';

export interface KeyCreateIntent {
  readonly operationId: string;
  readonly input: KeyInput;
}

export type KeyCreateOperation =
  | { readonly status: 'idle' }
  | { readonly status: 'submitting'; readonly intent: KeyCreateIntent }
  | { readonly status: 'unknown'; readonly intent: KeyCreateIntent }
  | { readonly status: 'correctable'; readonly intent: KeyCreateIntent }
  | { readonly status: 'created'; readonly key: KeyMetadata }
  | { readonly status: 'replayed'; readonly key: KeyMetadata };

export type KeyCreateOperationEvent =
  | { readonly type: 'submit'; readonly intent: KeyCreateIntent }
  | { readonly type: 'unknown' }
  | { readonly type: 'correctable' }
  | { readonly type: 'created'; readonly key: KeyMetadata }
  | { readonly type: 'replayed'; readonly key: KeyMetadata }
  | { readonly type: 'reset' };

export const idleKeyCreateOperation: KeyCreateOperation = { status: 'idle' };

export function reduceKeyCreateOperation(
  state: KeyCreateOperation,
  event: KeyCreateOperationEvent,
): KeyCreateOperation {
  if (event.type === 'reset') return idleKeyCreateOperation;
  if (event.type === 'submit') return { status: 'submitting', intent: event.intent };
  if (event.type === 'created' || event.type === 'replayed')
    return { status: event.type, key: event.key };
  if (state.status !== 'submitting' && state.status !== 'unknown' && state.status !== 'correctable')
    return state;
  return { status: event.type, intent: state.intent };
}

/** Keep the same operation ID and payload when an earlier response was uncertain. */
export function createKeyIntent(
  input: KeyInput,
  previous?: KeyCreateIntent | null,
): KeyCreateIntent {
  return previous ?? { operationId: crypto.randomUUID(), input };
}

/** Only explicit validation/authorization responses let the user change a pending intent. */
export function canEditAfterKeyCreateFailure(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 400 || error.status === 403);
}

/** One explicit user action sends one write; no mutation cache stores the returned secret. */
export function executeKeyCreate(api: KeysApi, intent: KeyCreateIntent): Promise<KeyCreation> {
  return api.create(intent.input, intent.operationId);
}
