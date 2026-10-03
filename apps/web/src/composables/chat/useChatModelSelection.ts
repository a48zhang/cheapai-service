import { computed, ref } from 'vue';
import type { ChatGroup, ChatModel } from '../../api/chat.js';

const SELECTION_KEY = 'sub2api.chat.selection';
interface Selection { readonly groupId: string | null; readonly modelId: string | null }
export function useChatModelSelection<Owner>(options: {
  readonly models: () => Promise<{ readonly items: readonly ChatGroup[] }>;
  readonly isOwnerCurrent: (owner: Owner) => boolean;
  readonly conversation: () => Selection | null;
  readonly onError: (message: string) => void;
}) {
  const groups = ref<readonly ChatGroup[]>([]);
  const loading = ref(false);
  const selectedGroupId = ref<string | null>(null);
  const selectedModelId = ref<string | null>(null);
  let epoch = 0;
  const selectedModel = computed<ChatModel | null>(() => groups.value.find(item => item.id === selectedGroupId.value)
    ?.models.find(item => item.publicModelId === selectedModelId.value) ?? null);
  const selectedOption = computed(() => selectedGroupId.value && selectedModelId.value ? JSON.stringify([selectedGroupId.value, selectedModelId.value]) : '');
  const modelOptions = computed(() => groups.value.flatMap(group => group.models.map(model => ({ group, model }))));
  function persistSelection(): void {
    if (!selectedGroupId.value || !selectedModelId.value) return;
    try { window.sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ groupId: selectedGroupId.value, modelId: selectedModelId.value })); } catch { /* Storage is optional. */ }
  }
  function findSelection(groupId: string | null, modelId: string | null): { groupId: string; modelId: string } | null {
    if (!groupId || !modelId || !groups.value.find(item => item.id === groupId)?.models.some(item => item.publicModelId === modelId)) return null;
    return { groupId, modelId };
  }
  function storedSelection(): { groupId: string; modelId: string } | null {
    try {
      const value: unknown = JSON.parse(window.sessionStorage.getItem(SELECTION_KEY) ?? 'null');
      if (value && typeof value === 'object' && 'groupId' in value && 'modelId' in value
        && typeof value.groupId === 'string' && typeof value.modelId === 'string') return findSelection(value.groupId, value.modelId);
    } catch { /* Invalid or unavailable storage falls back to the first model. */ }
    return null;
  }
  function applySelection(groupId: string | null, modelId: string | null): void {
    const matched = findSelection(groupId, modelId) ?? storedSelection();
    const first = modelOptions.value[0];
    selectedGroupId.value = matched?.groupId ?? first?.group.id ?? null;
    selectedModelId.value = matched?.modelId ?? first?.model.publicModelId ?? null;
    persistSelection();
  }
  function reset(): void { epoch++; groups.value = []; loading.value = false; selectedGroupId.value = null; selectedModelId.value = null; }
  async function load(owner: Owner): Promise<void> {
    if (!options.isOwnerCurrent(owner)) return;
    const ticket = ++epoch;
    loading.value = true;
    const current = () => ticket === epoch && options.isOwnerCurrent(owner);
    try {
      const result = await options.models();
      if (!current()) return;
      groups.value = result.items;
      const selection = options.conversation();
      applySelection(selection?.groupId ?? null, selection?.modelId ?? null);
    } catch (cause) {
      if (current()) options.onError(cause instanceof Error ? cause.message : '模型读取失败。');
    } finally { if (current()) loading.value = false; }
  }
  return { groups, loading, selectedGroupId, selectedModelId, selectedModel, selectedOption, modelOptions, findSelection, applySelection, persistSelection, reset, load };
}
