import { ref } from 'vue';
import type { ChatList, Conversation } from '../../api/chat.js';

export function useConversationHistory<Owner>(options: {
  readonly list: (cursor?: string | null) => Promise<ChatList>;
  readonly isOwnerCurrent: (owner: Owner) => boolean;
}) {
  const conversations = ref<Conversation[]>([]);
  const cursor = ref<string | null>(null);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref('');
  let epoch = 0;
  let request = 0;
  let revision = 0;
  let failedAppend = false;
  const changes = new Map<string, { revision: number; value: Conversation | null }>();
  const consumed = new Set<string>();
  const sort = (items: Conversation[]) => items.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  function reset(): void {
    epoch++; request++; revision = 0; changes.clear(); consumed.clear();
    conversations.value = []; cursor.value = null; loading.value = false; loadingMore.value = false; error.value = ''; failedAppend = false;
  }
  function upsert(value: Conversation): void {
    const previous = conversations.value.find(item => item.id === value.id);
    if (previous && previous.version > value.version) return;
    changes.set(value.id, { revision: ++revision, value });
    conversations.value = sort([...conversations.value.filter(item => item.id !== value.id), value]);
  }
  function remove(id: string): void {
    changes.set(id, { revision: ++revision, value: null });
    conversations.value = conversations.value.filter(item => item.id !== id);
  }
  async function read(owner: Owner, append: boolean): Promise<void> {
    if (!options.isOwnerCurrent(owner) || (append && (loading.value || loadingMore.value || cursor.value === null))) return;
    const pageCursor = append ? cursor.value : null;
    const generation = epoch;
    const ticket = ++request;
    const startRevision = revision;
    if (append) loadingMore.value = true;
    else { loading.value = true; loadingMore.value = false; }
    error.value = '';
    const current = () => generation === epoch && ticket === request && options.isOwnerCurrent(owner);
    try {
      const page = await options.list(pageCursor);
      if (!current()) return;
      if (page.nextCursor !== null && (page.nextCursor === pageCursor || (append && consumed.has(page.nextCursor)))) {
        throw new Error('历史分页位置重复，请刷新后重试。');
      }
      const merged = new Map<string, Conversation>(append ? conversations.value.map(item => [item.id, item]) : []);
      for (const item of page.items) {
        const change = changes.get(item.id);
        // Deleted items must not be resurrected by in-flight or overlapping pages.
        if (change?.value === null) continue;
        const previous = merged.get(item.id) ?? conversations.value.find(value => value.id === item.id);
        merged.set(item.id, previous && previous.version > item.version ? previous : item);
      }
      for (const [id, change] of changes) {
        if (change.value === null) merged.delete(id);
        else if (append || change.revision > startRevision || merged.has(id)) {
          const previous = merged.get(id);
          if (!previous || previous.version <= change.value.version) merged.set(id, change.value);
        }
      }
      conversations.value = sort([...merged.values()]);
      if (!append) consumed.clear();
      if (pageCursor !== null) consumed.add(pageCursor);
      cursor.value = page.nextCursor; failedAppend = false;
    } catch (cause) {
      if (current()) { error.value = cause instanceof Error ? cause.message : '历史对话读取失败。'; failedAppend = append; }
    } finally {
      if (current()) { loading.value = false; loadingMore.value = false; }
    }
  }
  return {
    conversations, cursor, loading, loadingMore, error, reset, upsert, remove,
    load: (owner: Owner) => read(owner, false),
    loadMore: (owner: Owner) => read(owner, true),
    retry: (owner: Owner) => read(owner, failedAppend),
  };
}
