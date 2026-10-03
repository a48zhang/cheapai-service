<script setup lang="ts">
import type { Conversation } from '../../api/chat.js';

defineProps<{
  readonly conversations: readonly Conversation[];
  readonly activeId: string | null;
  readonly loading?: boolean;
  readonly mobileOpen?: boolean;
  readonly loadingMore?: boolean;
  readonly hasMore?: boolean;
  readonly error?: string;
}>();

const emit = defineEmits<{
  (event: 'new'): void;
  (event: 'select', value: Conversation): void;
  (event: 'rename', value: Conversation): void;
  (event: 'delete', value: Conversation): void;
  (event: 'close'): void;
  (event: 'loadMore'): void;
  (event: 'retry'): void;
}>();

function dateLabel(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function isoLabel(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
</script>

<template>
  <aside class="chat-history" :class="{ 'chat-history-open': mobileOpen }" aria-label="聊天记录">
    <div class="chat-history-head">
      <span class="chat-history-title">对话</span>
      <button type="button" class="history-close" aria-label="关闭聊天记录" @click="emit('close')">×</button>
    </div>
    <button type="button" class="new-chat-button" @click="emit('new')">
      <span aria-hidden="true">＋</span> 新对话
    </button>
    <p v-if="loading && !conversations.length" class="history-status" role="status">正在读取…</p>
    <div v-else-if="!conversations.length && !error" class="history-empty">还没有对话</div>
    <nav v-if="conversations.length" class="history-list" aria-label="历史对话">
      <div v-for="conversation in conversations" :key="conversation.id" class="history-item" :class="{ selected: conversation.id === activeId }">
        <button type="button" class="history-select" :aria-current="conversation.id === activeId ? 'page' : undefined" @click="emit('select', conversation)">
          <span class="history-item-title">{{ conversation.title || '新对话' }}</span>
          <time :datetime="isoLabel(conversation.updatedAt)">{{ dateLabel(conversation.updatedAt) }}</time>
        </button>
        <div class="history-actions">
          <button type="button" aria-label="重命名对话" title="重命名" @click="emit('rename', conversation)">···</button>
          <button type="button" aria-label="删除对话" title="删除" @click="emit('delete', conversation)">×</button>
        </div>
      </div>
    </nav>
    <div v-if="error" class="history-status" role="alert">
      <p>{{ error }}</p>
      <button type="button" :disabled="loading || loadingMore" @click="emit('retry')">重试</button>
    </div>
    <button v-else-if="hasMore" type="button" class="new-chat-button" :disabled="loading || loadingMore" @click="emit('loadMore')">
      {{ loadingMore ? '正在读取…' : '加载更多' }}
    </button>
  </aside>
</template>

<style scoped>
.chat-history{display:flex;flex-direction:column;min-height:0;background:#f0f1ea;border-right:1px solid var(--line);color:var(--ink)}
.chat-history-head{display:flex;align-items:center;justify-content:space-between;padding:22px 18px 13px}.chat-history-title{font-size:15px;font-weight:550}.history-close{display:none;border:0;background:transparent;min-height:28px;padding:3px 7px;font-size:21px;color:var(--muted)}
.new-chat-button{justify-content:flex-start;margin:0 14px 14px;min-height:38px;background:var(--surface);border-color:#cfd0c6;font-size:13px}.new-chat-button span{font-size:17px;line-height:1;color:var(--accent)}
.history-list{overflow:auto;min-height:0;padding:0 8px 20px}.history-item{position:relative;display:flex;align-items:stretch;margin:2px 0;border-radius:3px}.history-item.selected{background:var(--surface);box-shadow:inset 2px 0 var(--accent)}.history-select{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0;flex:1;text-align:left;border:0;background:transparent;padding:10px 8px 10px 12px;min-height:50px;color:var(--ink)}.history-select:hover{background:transparent;border-color:transparent}.history-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.history-select time{flex:none;color:var(--muted);font:10px var(--mono);padding-top:2px}.history-actions{display:flex;align-items:center;padding-right:5px;opacity:0}.history-item:hover .history-actions,.history-item:focus-within .history-actions{opacity:1}.history-actions button{border:0;background:transparent;min-height:24px;padding:1px 4px;font-size:13px;color:var(--muted)}.history-actions button:hover{border-color:transparent;background:transparent;color:var(--accent)}
.history-status,.history-empty{padding:18px;color:var(--muted);font-size:13px}.history-empty{border-top:1px solid var(--line);margin:0 14px;padding-left:0}
@media(max-width:760px){.chat-history{position:fixed;inset:66px auto 0 0;width:min(86vw,320px);z-index:45;transform:translateX(-100%);transition:transform .18s;box-shadow:14px 0 34px #25262016}.chat-history-open{transform:none}.history-close{display:inline-flex}.history-actions{opacity:1}}
</style>
