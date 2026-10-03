const DRAFT_KEY_PREFIX = 'cheapai.chat.draft.v1';

export interface ChatDraftScope {
  readonly userId: string | null;
  readonly conversationId: string | null;
}

export interface ChatDraftStore {
  read(scope: ChatDraftScope): string | null;
  write(scope: ChatDraftScope, value: string): boolean;
  remove(scope: ChatDraftScope): void;
  claimAnonymous(userId: string, conversationId: string | null): string | null;
}

function browserSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** A stable, collision-safe key scoped to both account identity and conversation. */
export function chatDraftStorageKey(scope: ChatDraftScope): string {
  const owner = scope.userId === null ? 'anonymous' : `user:${encodeURIComponent(scope.userId)}`;
  const conversation = scope.conversationId === null
    ? 'new'
    : `conversation:${encodeURIComponent(scope.conversationId)}`;
  return `${DRAFT_KEY_PREFIX}:${owner}:${conversation}`;
}

/**
 * Uses sessionStorage when available and treats denied/private storage as an
 * optional persistence failure so composing can continue in memory.
 */
export function createChatDraftStore(storage: Storage | null = browserSessionStorage()): ChatDraftStore {
  function read(scope: ChatDraftScope): string | null {
    try {
      const value = storage?.getItem(chatDraftStorageKey(scope)) ?? null;
      return value === '' ? null : value;
    } catch {
      return null;
    }
  }

  function remove(scope: ChatDraftScope): void {
    try {
      storage?.removeItem(chatDraftStorageKey(scope));
    } catch {
      // Storage is optional; removing a saved draft must not block the UI.
    }
  }

  function write(scope: ChatDraftScope, value: string): boolean {
    if (value.length === 0) {
      remove(scope);
      return true;
    }
    try {
      if (!storage) return false;
      storage.setItem(chatDraftStorageKey(scope), value);
      return true;
    } catch {
      return false;
    }
  }

  function claimAnonymous(userId: string, conversationId: string | null): string | null {
    const userScope = { userId, conversationId };
    const anonymousScope = { userId: null, conversationId };
    const existingUserDraft = read(userScope);
    const anonymousDraft = read(anonymousScope);

    if (existingUserDraft !== null) {
      remove(anonymousScope);
      return existingUserDraft;
    }
    if (anonymousDraft === null) return null;

    if (write(userScope, anonymousDraft)) remove(anonymousScope);
    return anonymousDraft;
  }

  return { read, write, remove, claimAnonymous };
}
