<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ChatComposer from '../components/chat/ChatComposer.vue';
import ChatMessage from '../components/chat/ChatMessage.vue';
import ChatSidebar from '../components/chat/ChatSidebar.vue';
import { ApiClientError } from '../api/client.js';
import { chatApi } from '../api/chat.js';
import type {
  ChatErrorEvent, ChatMessage as ChatMessageRecord, ChatRegenerateInput, ChatSendInput,
  ChatSendResult, ChatStreamHandlers, Conversation, ConversationDetail,
} from '../api/chat.js';
import { useConversationHistory } from '../composables/chat/useConversationHistory.js';
import { useChatModelSelection } from '../composables/chat/useChatModelSelection.js';
import { useChatDraft } from '../composables/chat/useChatDraft.js';
import { sessionStore } from '../stores/session.js';

const route = useRoute();
const router = useRouter();

interface OwnerScope { readonly userId: string; readonly epoch: number }
type PendingOperation =
  | { metaReceived?: boolean; kind: 'message'; owner: OwnerScope; conversationId: string; routeId: string; input: ChatSendInput; content: string; userId: string; assistantId: string }
  | { metaReceived?: boolean; kind: 'regenerate'; owner: OwnerScope; conversationId: string; routeId: string; input: ChatRegenerateInput; content: string; assistantId: string; previousId: string };
type GenerationOutcome = 'completed' | 'stopped' | 'rejected' | 'failed' | 'uncertain' | 'superseded';
interface GenerationScope {
  readonly token: number;
  readonly operation: PendingOperation;
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
  stopRequested: boolean;
}

const history = useConversationHistory<OwnerScope>({ list: cursor => chatApi.listConversations(cursor), isOwnerCurrent });
const { conversations, loading: historyLoading, loadingMore: historyLoadingMore, cursor: historyCursor, error: historyError } = history;
const activeDetail = ref<ConversationDetail | null>(null);
const messages = ref<ChatMessageRecord[]>([]);
const { draft, setDraft, preservePending } = useChatDraft(() => ({
  status: sessionStore.state.status, userId: sessionStore.state.user?.id ?? null,
  expiredUserId: sessionStore.state.expiry?.userId ?? null,
}));
const error = ref('');
const loading = ref(false);
const modelChangePending = ref(false);
const streaming = ref(false);
const sendLocked = ref(false);
const pendingOperation = ref<PendingOperation | null>(null);
const mobileHistoryOpen = ref(false);
const messagesViewport = ref<HTMLElement | null>(null);

let ownerEpoch = 0;
let observedOwnerKey = '';
let detailEpoch = 0;
let generationSequence = 0;
let activeGeneration: GenerationScope | null = null;
let sendLockToken = 0;
let disposed = false;
let skipDetailLoadId: string | null = null;

const routeConversationId = computed(() => typeof route.params.id === 'string' ? route.params.id : null);
const isAuthenticated = computed(() => sessionStore.state.status === 'authenticated');
const currentConversation = computed(() => activeDetail.value?.conversation ?? null);
const modelSelection = useChatModelSelection<OwnerScope>({
  models: () => chatApi.models(), isOwnerCurrent, conversation: () => currentConversation.value,
  onError: message => { error.value = message; },
});
const { groups, loading: modelsLoading, selectedGroupId, selectedModelId, selectedModel, selectedOption,
  modelOptions, findSelection, applySelection, persistSelection } = modelSelection;
const visibleMessages = computed(() => [...messages.value]
  .sort((left, right) => left.turnIndex - right.turnIndex || (left.role === 'user' ? -1 : 1) || left.variant - right.variant)
  .filter(item => item.role === 'user' || item.selected));
const latestTurnIndex = computed(() => messages.value.reduce((latest, item) => Math.max(latest, item.turnIndex), -1));
const lastAssistant = computed(() => messages.value.filter(item => item.role === 'assistant' && item.selected && item.turnIndex === latestTurnIndex.value).sort((a, b) => b.variant - a.variant)[0] ?? null);
const canSend = computed(() => isAuthenticated.value && !sendLocked.value && !modelsLoading.value && !modelChangePending.value && selectedGroupId.value !== null && selectedModelId.value !== null);
const retryAvailable = computed(() => {
  const operation = pendingOperation.value;
  return operation !== null && isOwnerCurrent(operation.owner) && routeConversationId.value === operation.routeId;
});

function currentOwnerScope(): OwnerScope | null {
  const userId = sessionStore.state.user?.id;
  return sessionStore.state.status === 'authenticated' && userId ? { userId, epoch: ownerEpoch } : null;
}
function isOwnerCurrent(scope: OwnerScope): boolean {
  return !disposed && ownerEpoch === scope.epoch && sessionStore.state.status === 'authenticated' && sessionStore.state.user?.id === scope.userId;
}
function ownsPending(operation: PendingOperation): boolean {
  const pending = pendingOperation.value;
  return pending !== null && pending.input.operationId === operation.input.operationId
    && pending.owner.userId === operation.owner.userId && pending.owner.epoch === operation.owner.epoch
    && pending.routeId === operation.routeId;
}
function clearPending(operation: PendingOperation): void {
  if (ownsPending(operation)) pendingOperation.value = null;
}
function restorePrevious(operation: PendingOperation): void {
  if (operation.kind !== 'regenerate' || operation.metaReceived || !isOwnerCurrent(operation.owner)
    || routeConversationId.value !== operation.routeId) return;
  messages.value = messages.value.map(item => item.id === operation.previousId ? { ...item, selected: true } : item)
    .filter(item => item.id !== operation.assistantId);
}
function isGenerationCurrent(scope: GenerationScope): boolean {
  return isGenerationOwner(scope) && !scope.stopRequested;
}
function isGenerationOwner(scope: GenerationScope): boolean {
  return activeGeneration === scope && isOwnerCurrent(scope.operation.owner) && routeConversationId.value === scope.operation.routeId;
}
function invalidateGeneration(): void {
  const active = activeGeneration;
  activeGeneration = null;
  if (active) { active.stopRequested = true; active.controller.abort(); }
  streaming.value = false;
  sendLockToken += 1;
  sendLocked.value = false;
}

function operationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function now() { return Date.now(); }
function localMessage(conversationId: string, role: 'user' | 'assistant', content: string, turnIndex: number, variant: number, status: ChatMessageRecord['status']): ChatMessageRecord {
  const timestamp = now();
  return { id: `local-${operationId()}`, conversationId, turnIndex, role, content, status, variant, selected: true,
    requestId: null, groupId: selectedGroupId.value, modelId: selectedModelId.value, createdAt: timestamp, updatedAt: timestamp };
}
function replaceMessage(id: string, value: ChatMessageRecord): void {
  messages.value = messages.value.map(item => item.id === id ? value : item);
}
function updateMessage(id: string, change: Partial<ChatMessageRecord>): void {
  messages.value = messages.value.map(item => item.id === id ? { ...item, ...change, updatedAt: now() } : item);
}
function variantMessages(message: ChatMessageRecord): readonly ChatMessageRecord[] {
  return messages.value.filter(item => item.role === 'assistant' && item.turnIndex === message.turnIndex).sort((a, b) => a.variant - b.variant);
}
function saveConversation(conversation: Conversation): void { history.upsert(conversation); }
function clearActive(): void {
  activeDetail.value = null; messages.value = []; error.value = '';
}
async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (messagesViewport.value) messagesViewport.value.scrollTop = messagesViewport.value.scrollHeight;
}

async function loadModels(scope: OwnerScope): Promise<void> { await modelSelection.load(scope); }

async function loadMoreHistory(): Promise<void> {
  const owner = currentOwnerScope();
  if (owner) await history.loadMore(owner);
}
async function retryHistory(): Promise<void> {
  const owner = currentOwnerScope();
  if (owner) await history.retry(owner);
}
async function loadConversations(scope: OwnerScope): Promise<void> { await history.load(scope); }
async function loadConversation(id: string, scope: OwnerScope): Promise<void> {
  if (!isOwnerCurrent(scope)) return;
  const ticket = ++detailEpoch;
  loading.value = true; error.value = '';
  try {
    const detail = await chatApi.getConversation(id);
    if (!isOwnerCurrent(scope) || ticket !== detailEpoch || routeConversationId.value !== id) return;
    activeDetail.value = detail; messages.value = [...detail.messages];
    saveConversation(detail.conversation);
    applySelection(detail.conversation.groupId, detail.conversation.modelId);
    await scrollToBottom();
  } catch (cause) {
    if (!isOwnerCurrent(scope) || ticket !== detailEpoch) return;
    clearActive();
    error.value = cause instanceof Error ? cause.message : '对话读取失败。';
    if (isOwnerCurrent(scope) && routeConversationId.value === id && cause instanceof ApiClientError && cause.status === 404) await router.replace('/');
  } finally { if (isOwnerCurrent(scope) && ticket === detailEpoch) loading.value = false; }
}

async function refreshCurrent(scope: OwnerScope): Promise<void> {
  const id = currentConversation.value?.id;
  if (!id || !isOwnerCurrent(scope)) return;
  try {
    const detail = await chatApi.getConversation(id);
    if (isOwnerCurrent(scope) && routeConversationId.value === id) { activeDetail.value = detail; messages.value = [...detail.messages]; saveConversation(detail.conversation); }
  } catch { /* the already rendered stream remains usable */ }
}

function selectModelOption(value: string): void {
  if (!value) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return;
    void changeSelection(parsed[0], parsed[1]);
  } catch { /* the select value is controlled by this component */ }
}
async function changeSelection(groupId: string, modelId: string): Promise<void> {
  if (!findSelection(groupId, modelId)) return;
  if (groupId === selectedGroupId.value && modelId === selectedModelId.value) return;
  const previous = { groupId: selectedGroupId.value, modelId: selectedModelId.value };
  selectedGroupId.value = groupId; selectedModelId.value = modelId; persistSelection();
  const conversation = currentConversation.value;
  if (!conversation || streaming.value) return;
  const scope = currentOwnerScope();
  if (!scope) return;
  modelChangePending.value = true; error.value = '';
  try {
    const updated = await chatApi.updateConversation(conversation.id, { version: conversation.version, groupId, modelId });
    if (!isOwnerCurrent(scope) || routeConversationId.value !== conversation.id) return;
    if (activeDetail.value?.conversation.id === conversation.id) activeDetail.value = { ...activeDetail.value, conversation: updated };
    saveConversation(updated);
  } catch (cause) {
    if (!isOwnerCurrent(scope) || routeConversationId.value !== conversation.id) return;
    selectedGroupId.value = previous.groupId; selectedModelId.value = previous.modelId; persistSelection();
    error.value = cause instanceof Error ? cause.message : '模型选择保存失败。';
    await loadConversation(conversation.id, scope);
  } finally { if (isOwnerCurrent(scope) && routeConversationId.value === conversation.id) modelChangePending.value = false; }
}

function messageError(cause: unknown): string {
  if (cause instanceof ApiClientError && cause.code === 'insufficient_balance') return '余额不足，回答没有开始。';
  return cause instanceof Error ? cause.message : '发送失败，请稍后重试。';
}

function operationIsUncertain(cause: unknown): boolean {
  if (!(cause instanceof ApiClientError)) return true;
  if (cause.status === 401 || cause.kind === 'request') return false;
  if (cause.kind === 'network' || cause.kind === 'invalid_response' || cause.kind === 'aborted') return true;
  return cause.kind === 'http' && (cause.status === null || cause.status === 408 || cause.status === 429 || cause.status >= 500);
}

async function runGeneration(operation: PendingOperation): Promise<GenerationOutcome> {
  if (!isOwnerCurrent(operation.owner) || routeConversationId.value !== operation.routeId || activeGeneration) return 'superseded';
  const controller = new AbortController();
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const scope: GenerationScope = { token: ++generationSequence, operation, controller, finished, resolveFinished, stopRequested: false };
  activeGeneration = scope; streaming.value = true; error.value = '';
  let assistantId = operation.assistantId;
  let completedMessage: ChatMessageRecord | null = null;
  updateMessage(assistantId, { content: '', status: 'generating', selected: true });
  const handlers: ChatStreamHandlers = {
    onMeta: async meta => {
      if (!isGenerationCurrent(scope)) return;
      operation.metaReceived = true;
      if (operation.kind === 'message' && meta.userMessage) { replaceMessage(operation.userId, meta.userMessage); operation.userId = meta.userMessage.id; }
      replaceMessage(assistantId, meta.assistantMessage); assistantId = meta.assistantMessage.id;
      operation.assistantId = assistantId;
      activeDetail.value = { conversation: meta.conversation, messages: messages.value }; saveConversation(meta.conversation);
      await scrollToBottom();
    },
    onDelta: async text => {
      if (!isGenerationCurrent(scope)) return;
      const current = messages.value.find(item => item.id === assistantId);
      if (current) updateMessage(assistantId, { content: current.content + text, status: 'generating' });
      await scrollToBottom();
    },
    onDone: message => { if (isGenerationOwner(scope)) { completedMessage = message; replaceMessage(assistantId, message); } },
    onError: (event: ChatErrorEvent) => { if (isGenerationCurrent(scope)) error.value = event.message; },
  };
  try {
    const result: ChatSendResult = operation.kind === 'message'
      ? await chatApi.sendMessage(operation.conversationId, operation.input, handlers, controller.signal)
      : await chatApi.regenerate(operation.conversationId, operation.input, handlers, controller.signal);
    if (!isGenerationOwner(scope)) return 'superseded';
    if (result.kind === 'replay') {
      activeDetail.value = { conversation: result.conversation, messages: result.messages }; messages.value = [...result.messages]; saveConversation(result.conversation);
    } else {
      replaceMessage(assistantId, result.message);
      await refreshCurrent(operation.owner);
    }
    clearPending(operation);
    await scrollToBottom();
    return result.kind === 'stream' && result.message.status === 'stopped' ? 'stopped' : 'completed';
  } catch (cause) {
    if (!isGenerationOwner(scope)) return 'superseded';
    // A decoded terminal message wins over a late abort or reader cleanup failure.
    if (completedMessage) { clearPending(operation); return 'completed'; }
    if (scope.stopRequested || controller.signal.aborted) {
      updateMessage(assistantId, { status: 'stopped' });
      clearPending(operation);
      return 'stopped';
    } else {
      updateMessage(assistantId, { status: 'failed' });
      if (operation.kind === 'message') setDraft(operation.content);
      const uncertain = operationIsUncertain(cause);
      if (uncertain) pendingOperation.value = operation;
      else clearPending(operation);
      error.value = messageError(cause);
      if (uncertain) return 'uncertain';
      if (!operation.metaReceived) { restorePrevious(operation); return 'rejected'; }
      await refreshCurrent(operation.owner);
      return 'failed';
    }
  } finally {
    scope.resolveFinished();
    if (activeGeneration === scope) { activeGeneration = null; streaming.value = false; }
  }
}

async function send(): Promise<void> {
  const content = draft.value;
  if (!content.trim() || sendLocked.value || activeGeneration) return;
  if (!isAuthenticated.value) {
    sendLocked.value = true;
    const lock = ++sendLockToken;
    setDraft(content);
    try { await router.push({ path: '/login', query: { returnTo: route.fullPath } }); }
    finally { if (sendLockToken === lock) sendLocked.value = false; }
    return;
  }
  const owner = currentOwnerScope();
  if (!owner) return;
  const retry = pendingOperation.value;
  if (retry?.kind === 'message' && retry.content === content && retry.owner.epoch === owner.epoch && retry.owner.userId === owner.userId && retry.routeId === routeConversationId.value) {
    sendLocked.value = true;
    const lock = ++sendLockToken;
    try { await runGeneration(retry); }
    finally { if (sendLockToken === lock) sendLocked.value = false; }
    return;
  }
  if (!selectedGroupId.value || !selectedModelId.value || modelsLoading.value || modelChangePending.value) { error.value = '请选择可用模型后再发送。'; return; }
  if (retry) discardPendingOperation();
  sendLocked.value = true;
  const lock = ++sendLockToken;
  error.value = '';
  let conversation = currentConversation.value;
  try {
    if (!conversation) {
      conversation = await chatApi.createConversation({ groupId: selectedGroupId.value, modelId: selectedModelId.value });
      if (sendLockToken !== lock) return;
      activeDetail.value = { conversation, messages: [] }; messages.value = [];
      saveConversation(conversation);
      skipDetailLoadId = conversation.id;
      await router.push(`/chat/${encodeURIComponent(conversation.id)}`);
    }
    if (sendLockToken !== lock) return;
    if (!isOwnerCurrent(owner) || routeConversationId.value !== conversation.id) return;
    const turnIndex = latestTurnIndex.value + 1;
    const user = localMessage(conversation.id, 'user', content, turnIndex, 1, 'completed');
    const assistant = localMessage(conversation.id, 'assistant', '', turnIndex, 1, 'generating');
    messages.value = [...messages.value, user, assistant];
    setDraft('');
    const maximum = selectedModel.value?.maxOutputTokens;
    const input: ChatSendInput = { operationId: operationId(), conversationVersion: conversation.version, groupId: selectedGroupId.value!, modelId: selectedModelId.value!, content,
      ...(maximum === undefined ? {} : { maxOutputTokens: maximum }) };
    const operation: PendingOperation = { kind: 'message', owner, conversationId: conversation.id, routeId: conversation.id, input, content, userId: user.id, assistantId: assistant.id };
    pendingOperation.value = operation;
    await runGeneration(operation);
  } catch (cause) {
    if (isOwnerCurrent(owner) && sendLockToken === lock) { setDraft(content); error.value = messageError(cause); }
  } finally { if (sendLockToken === lock) sendLocked.value = false; }
}

async function retryPending(): Promise<void> {
  const operation = pendingOperation.value;
  if (!operation || sendLocked.value || activeGeneration || !isOwnerCurrent(operation.owner) || routeConversationId.value !== operation.routeId) return;
  sendLocked.value = true;
  const lock = ++sendLockToken;
  try { await runGeneration(operation); }
  finally { if (sendLockToken === lock) sendLocked.value = false; }
}

function discardPendingOperation(): void {
  const operation = pendingOperation.value;
  if (operation) restorePrevious(operation);
  pendingOperation.value = null;
}

async function stop(): Promise<void> {
  const scope = activeGeneration;
  if (!scope || !streaming.value) return;
  scope.stopRequested = true;
  const assistant = messages.value.find(item => item.id === scope.operation.assistantId && item.status === 'generating');
  if (assistant && isGenerationOwner(scope)) updateMessage(assistant.id, { status: 'stopped' });
  clearPending(scope.operation);
  scope.controller.abort();
  await scope.finished;
}

async function regenerate(): Promise<void> {
  const conversation = currentConversation.value;
  const previous = lastAssistant.value;
  const owner = currentOwnerScope();
  if (!conversation || !previous || !owner || sendLocked.value || activeGeneration || !selectedGroupId.value || !selectedModelId.value || previous.status === 'generating') return;
  if (pendingOperation.value) discardPendingOperation();
  sendLocked.value = true;
  const lock = ++sendLockToken;
  const variants = variantMessages(previous);
  const assistant = localMessage(conversation.id, 'assistant', '', previous.turnIndex, variants.length + 1, 'generating');
  messages.value = [...messages.value.map(item => item.id === previous.id ? { ...item, selected: false } : item), assistant];
  const maximum = selectedModel.value?.maxOutputTokens;
  const input = { operationId: operationId(), conversationVersion: conversation.version, groupId: selectedGroupId.value!, modelId: selectedModelId.value!, ...(maximum === undefined ? {} : { maxOutputTokens: maximum }) };
  const operation: PendingOperation = { kind: 'regenerate', owner, conversationId: conversation.id, routeId: conversation.id, input, content: '', assistantId: assistant.id, previousId: previous.id };
  pendingOperation.value = operation;
  try { await runGeneration(operation); }
  finally {
    if (sendLockToken === lock) sendLocked.value = false;
  }
}

async function selectVersion(message: ChatMessageRecord): Promise<void> {
  const conversation = currentConversation.value;
  const owner = currentOwnerScope();
  if (!conversation || !owner || sendLocked.value || activeGeneration || message.turnIndex !== latestTurnIndex.value) return;
  try {
    const detail = await chatApi.selectVersion(conversation.id, { conversationVersion: conversation.version, messageId: message.id });
    if (!isOwnerCurrent(owner) || routeConversationId.value !== conversation.id || activeGeneration) return;
    activeDetail.value = detail; messages.value = [...detail.messages]; saveConversation(detail.conversation); await scrollToBottom();
  } catch (cause) { if (isOwnerCurrent(owner) && routeConversationId.value === conversation.id) { error.value = messageError(cause); await loadConversation(conversation.id, owner); } }
}

async function rename(conversation: Conversation): Promise<void> {
  const title = window.prompt('对话名称', conversation.title);
  if (title === null || !title.trim() || title.trim() === conversation.title) return;
  const owner = currentOwnerScope();
  if (!owner) return;
  try {
    const updated = await chatApi.updateConversation(conversation.id, { version: conversation.version, title: title.trim() });
    if (!isOwnerCurrent(owner) || (currentConversation.value?.id === conversation.id && routeConversationId.value !== conversation.id)) return;
    saveConversation(updated);
    if (currentConversation.value?.id === updated.id && activeDetail.value) activeDetail.value = { ...activeDetail.value, conversation: updated };
  } catch (cause) { if (isOwnerCurrent(owner) && routeConversationId.value === conversation.id) error.value = messageError(cause); }
}

async function removeConversation(conversation: Conversation): Promise<void> {
  if (!window.confirm('删除这段对话？')) return;
  const owner = currentOwnerScope();
  if (!owner) return;
  if (currentConversation.value?.id === conversation.id) await stop();
  try {
    await chatApi.deleteConversation(conversation.id, conversation.version);
    if (!isOwnerCurrent(owner)) return;
    history.remove(conversation.id);
    if (currentConversation.value?.id === conversation.id) { clearActive(); await router.replace('/'); }
  } catch (cause) { if (isOwnerCurrent(owner)) error.value = messageError(cause); }
}

async function newConversation(): Promise<void> {
  await stop(); invalidateGeneration(); pendingOperation.value = null; mobileHistoryOpen.value = false; clearActive(); await router.push('/');
  applySelection(selectedGroupId.value, selectedModelId.value);
}
async function openConversation(conversation: Conversation): Promise<void> {
  if (streaming.value) await stop(); invalidateGeneration(); pendingOperation.value = null; mobileHistoryOpen.value = false; await router.push(`/chat/${encodeURIComponent(conversation.id)}`);
}

async function initializeForUser(scope: OwnerScope): Promise<void> {
  if (!isOwnerCurrent(scope)) return;
  await Promise.all([loadModels(scope), loadConversations(scope)]);
  if (!isOwnerCurrent(scope)) return;
  if (routeConversationId.value) await loadConversation(routeConversationId.value, scope);
}
function clearOwnerState(): void {
  const pending = pendingOperation.value;
  if (pending?.kind === 'message' && sessionStore.state.expiry?.userId === pending.owner.userId) preservePending(pending.content);
  invalidateGeneration();
  pendingOperation.value = null;
  modelSelection.reset(); history.reset(); loading.value = false; modelChangePending.value = false;
  clearActive();
}

watch(() => [sessionStore.state.status, sessionStore.state.user?.id] as const, ([status, userId]) => {
  const key = `${status}:${userId ?? ''}`;
  if (key === observedOwnerKey) return;
  observedOwnerKey = key;
  ownerEpoch += 1; detailEpoch += 1;
  clearOwnerState();
  if (status === 'authenticated' && userId) void initializeForUser({ userId, epoch: ownerEpoch });
}, { immediate: true });
watch(routeConversationId, (id, previousId) => {
  const ownRouteChange = id !== null && id === skipDetailLoadId;
  if (previousId !== undefined && id !== previousId && !ownRouteChange) {
    invalidateGeneration(); pendingOperation.value = null; modelChangePending.value = false;
  }
  if (!isAuthenticated.value) { clearActive(); return; }
  if (ownRouteChange) { skipDetailLoadId = null; return; }
  const scope = currentOwnerScope();
  if (id && scope) void loadConversation(id, scope); else clearActive();
}, { immediate: true });
watch(visibleMessages, () => void scrollToBottom(), { deep: true });

onBeforeUnmount(() => { disposed = true; pendingOperation.value = null; invalidateGeneration(); });
</script>

<template>
  <section class="chat-page" :class="{ 'chat-authenticated': isAuthenticated }">
    <ChatSidebar :conversations="conversations" :active-id="routeConversationId" :loading="historyLoading" :loading-more="historyLoadingMore" :has-more="historyCursor !== null" :error="historyError" @load-more="loadMoreHistory" @retry="retryHistory" :mobile-open="mobileHistoryOpen" @new="newConversation" @select="openConversation" @rename="rename" @delete="removeConversation" @close="mobileHistoryOpen = false" />
    <button v-if="mobileHistoryOpen" type="button" class="chat-sidebar-scrim" aria-label="关闭聊天记录" @click="mobileHistoryOpen = false" />
    <div class="chat-main">
      <header class="chat-toolbar">
        <div class="chat-toolbar-left">
          <button type="button" class="history-toggle" aria-label="打开聊天记录" :aria-expanded="mobileHistoryOpen" @click="mobileHistoryOpen = !mobileHistoryOpen"><span aria-hidden="true">☰</span></button>
          <h1>{{ currentConversation?.title || '新对话' }}</h1>
        </div>
        <label class="model-picker" aria-label="选择模型">
          <select :value="selectedOption" :disabled="modelsLoading || streaming || modelChangePending" @change="selectModelOption(($event.target as HTMLSelectElement).value)">
            <option v-if="!modelOptions.length" value="">{{ isAuthenticated ? '暂无可用模型' : '登录后选择模型' }}</option>
            <optgroup v-for="group in groups" :key="group.id" :label="`${group.name} · ${group.billingMultiplier}×`">
              <option v-for="model in group.models" :key="`${group.id}:${model.publicModelId}`" :value="JSON.stringify([group.id, model.publicModelId])">{{ model.publicModelId }}</option>
            </optgroup>
          </select>
        </label>
      </header>
      <div ref="messagesViewport" class="chat-messages" :class="{ empty: !visibleMessages.length }">
        <div v-if="loading" class="chat-loading" role="status">正在读取对话…</div>
        <div v-else-if="!visibleMessages.length" class="chat-empty"><h2>今天想聊点什么？</h2></div>
        <template v-else>
          <ChatMessage v-for="message in visibleMessages" :key="message.id" :message="message" :variants="message.role === 'assistant' ? variantMessages(message) : []" :busy="streaming" :can-regenerate="message.role === 'assistant' && message.id === lastAssistant?.id && !streaming" @regenerate="regenerate" @select="selectVersion" />
        </template>
      </div>
      <div class="chat-compose-area">
        <div v-if="error" class="chat-error" role="alert"><span>{{ error }}</span><button v-if="retryAvailable" type="button" @click="retryPending">重试</button></div>
        <ChatComposer v-model="draft" :busy="streaming" :disabled="!canSend && isAuthenticated" :placeholder="isAuthenticated ? '输入消息…' : '登录后开始对话…'" @submit="send" @stop="stop" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-page{display:grid;grid-template-columns:280px minmax(0,1fr);height:calc(100svh - 66px);min-height:520px;margin:-44px -48px -72px;background:var(--paper);overflow:hidden}.chat-page:not(.chat-authenticated){grid-template-columns:minmax(0,1fr);height:calc(100svh - 110px);margin:-28px -48px -64px}.chat-page:not(.chat-authenticated) .chat-history{display:none}.chat-main{display:flex;flex-direction:column;min-width:0;min-height:0}.chat-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:66px;padding:0 26px;border-bottom:1px solid var(--line);background:#fbfbf7}.chat-toolbar-left{display:flex;align-items:center;gap:12px;min-width:0}.chat-toolbar h1{font-size:14px;font-weight:500;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-toggle{display:none;border:0;background:transparent;min-height:32px;padding:5px;color:var(--ink);font-size:17px}.model-picker{max-width:min(52%,360px)}.model-picker select{min-height:34px;max-width:100%;padding:6px 28px 6px 9px;font-size:12px;background:var(--surface)}.chat-messages{flex:1;min-height:0;overflow:auto;padding:28px 30px 22px;scroll-behavior:smooth}.chat-messages.empty{display:grid;place-items:center}.chat-empty{padding:40px 18px;text-align:center}.chat-empty h2{margin:0;font-size:22px;font-weight:450;letter-spacing:-.03em}.chat-loading{margin:auto;color:var(--muted);font-size:13px}.chat-compose-area{padding:12px 28px 22px;background:var(--paper);border-top:1px solid var(--line)}.chat-error{display:flex;align-items:center;justify-content:space-between;gap:12px;width:min(100%,860px);margin:0 auto 8px;padding:9px 12px;border-left:3px solid var(--accent);background:#f9ede7;color:var(--danger);font-size:13px}.chat-error button{min-height:28px;padding:4px 9px;border-color:#d8b4a9;background:transparent;color:var(--danger);font-size:12px}.chat-sidebar-scrim{display:none}
.chat-page.chat-authenticated{height:calc(100svh - 62px);margin:0}
@media(max-width:1000px){.chat-page{margin:-32px -28px -72px}.chat-page:not(.chat-authenticated){margin:-24px -28px -48px}.chat-toolbar{padding:0 20px}.chat-messages{padding-left:22px;padding-right:22px}.chat-compose-area{padding-left:20px;padding-right:20px}}
@media(max-width:760px){.chat-page,.chat-page:not(.chat-authenticated){display:flex;height:calc(100svh - 66px);min-height:480px;margin:-28px -20px -72px}.chat-page:not(.chat-authenticated){height:calc(100svh - 84px);margin:-20px -20px -40px}.chat-toolbar{min-height:58px;padding:0 14px}.history-toggle{display:inline-flex}.model-picker{max-width:58%}.model-picker select{font-size:11px;max-width:100%}.chat-messages{padding:20px 16px 15px}.chat-compose-area{padding:9px 12px 14px}.chat-sidebar-scrim{display:block;position:fixed;inset:66px 0 0;width:100%;height:calc(100% - 66px);z-index:40;border:0;background:#25262052}.chat-page.chat-authenticated{height:calc(100svh - 58px);margin:0}.chat-page.chat-authenticated :deep(.chat-history){inset:58px auto 0 0}.chat-page.chat-authenticated .chat-sidebar-scrim{inset:58px 0 0;height:calc(100% - 58px)}}
</style>
