import { ref, watch } from 'vue';

const DRAFT_KEY = 'sub2api.chat.draft';
const OWNER_KEY = 'sub2api.chat.draft.owner';
interface DraftIdentity {
  readonly status: string;
  readonly userId: string | null;
  readonly expiredUserId: string | null;
}
function read(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}
function clearStorage(): void {
  try { window.sessionStorage.removeItem(DRAFT_KEY); window.sessionStorage.removeItem(OWNER_KEY); } catch { /* Storage is optional. */ }
}
export function useChatDraft(identity: () => DraftIdentity) {
  const draft = ref('');
  let changingOwner = false;
  let previousUser: string | null = null;
  function persist(value: string): void {
    if (changingOwner) return;
    const current = identity();
    const userId = current.status === 'authenticated' ? current.userId : current.expiredUserId;
    if (!value) { clearStorage(); return; }
    try {
      // Write the owner first; a partial write must never expose another owner's text.
      const owner = userId ? `user:${userId}` : 'anonymous';
      if (read(OWNER_KEY) !== owner) window.sessionStorage.removeItem(DRAFT_KEY);
      window.sessionStorage.setItem(OWNER_KEY, owner);
      window.sessionStorage.setItem(DRAFT_KEY, value);
    } catch { /* Private browsing or quota errors must not block composing. */ }
  }
  watch(draft, persist, { flush: 'sync' });
  watch(identity, current => {
    changingOwner = true;
    const userId = current.status === 'authenticated' ? current.userId : null;
    const expired = current.expiredUserId !== null;
    const storedOwner = read(OWNER_KEY);
    const storedDraft = read(DRAFT_KEY) ?? '';
    const signedOut = previousUser !== null && userId === null && current.status === 'anonymous' && !expired;
    const switched = userId !== null && storedOwner !== null && storedOwner !== 'anonymous' && storedOwner !== `user:${userId}`;
    if (signedOut || switched) { clearStorage(); draft.value = ''; }
    else if (userId && (storedOwner === `user:${userId}` || storedOwner === 'anonymous')) draft.value = storedDraft;
    else if (!userId && storedOwner === 'anonymous' && !expired) draft.value = storedDraft;
    else draft.value = '';
    previousUser = userId;
    changingOwner = false;
    // Claim an anonymous draft only once authenticated. Expired drafts remain quarantined.
    if (userId && draft.value) persist(draft.value);
  }, { immediate: true, deep: true });
  function setDraft(value: string): void { draft.value = value; }
  function preservePending(value: string): void {
    if (value && !read(DRAFT_KEY)) persist(value);
  }
  return { draft, setDraft, preservePending };
}
