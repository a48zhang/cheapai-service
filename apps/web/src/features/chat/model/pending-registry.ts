import type { ChatOperationOwner, ChatWriteOperation } from './operation';

// Unresolved writes survive controller replacement for the same user. The key omits epoch so
// a restored session can retry the original operation; settlement or known rejection removes it.
const operations = new Map<string, ChatWriteOperation>();

function pendingKey(userId: string, conversationId: string): string {
  return JSON.stringify([userId, conversationId]);
}

export function ownerKey(owner: ChatOperationOwner | null): string {
  return owner ? JSON.stringify([owner.userId, owner.epoch]) : 'null';
}

export function getPendingOperation(
  owner: Pick<ChatOperationOwner, 'userId'>,
  conversationId: string,
): ChatWriteOperation | null {
  return operations.get(pendingKey(owner.userId, conversationId)) ?? null;
}

export function rememberPendingOperation(operation: ChatWriteOperation): void {
  operations.set(pendingKey(operation.owner.userId, operation.conversationId), operation);
}

export function forgetPendingOperation(operation: ChatWriteOperation): void {
  const key = pendingKey(operation.owner.userId, operation.conversationId);
  if (operations.get(key)?.operationId === operation.operationId) operations.delete(key);
}
