<script setup lang="ts">
import { computed, ref } from 'vue';
import MarkdownIt from 'markdown-it';
import type { ChatMessage } from '../../api/chat.js';

const props = withDefaults(defineProps<{
  readonly message: ChatMessage;
  readonly variants?: readonly ChatMessage[];
  readonly canRegenerate?: boolean;
  readonly busy?: boolean;
}>(), { variants: () => [], canRegenerate: false, busy: false });

const emit = defineEmits<{
  (event: 'copy', value: string): void;
  (event: 'regenerate'): void;
  (event: 'select', value: ChatMessage): void;
}>();

const copied = ref(false);
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false });
const rendered = computed(() => {
  if (props.message.role !== 'assistant' || props.message.content.length === 0) return '';
  // markdown-it escapes source HTML when html=false. The button is added only
  // around its generated code blocks, so user text cannot become markup.
  return markdown.render(props.message.content).replace(/<pre><code/gu, '<pre class="chat-code"><button type="button" class="code-copy" data-copy-code>复制代码</button><code');
});
const variantIndex = computed(() => {
  const position = props.variants.findIndex(item => item.id === props.message.id);
  return position < 0 ? 1 : position + 1;
});

async function copy(value: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const element = document.createElement('textarea');
      element.value = value; element.setAttribute('readonly', ''); element.style.position = 'fixed'; element.style.opacity = '0';
      document.body.appendChild(element); element.select(); document.execCommand('copy'); element.remove();
    }
    copied.value = true; emit('copy', value); window.setTimeout(() => { copied.value = false; }, 1400);
  } catch { copied.value = false; }
}

function clickContent(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target.closest('[data-copy-code]') : null;
  if (!target) return;
  const code = target.parentElement?.querySelector('code')?.textContent ?? '';
  void copy(code);
}

function copyMessage() { void copy(props.message.content); }
</script>

<template>
  <article class="chat-message" :class="[message.role, message.status]">
    <div v-if="message.role === 'user'" class="message-user">
      <div class="message-bubble">{{ message.content }}</div>
    </div>
    <div v-else class="message-assistant">
      <div v-if="message.content" class="message-markdown" @click="clickContent" v-html="rendered" />
      <span v-else-if="message.status === 'generating'" class="message-loading" aria-label="正在生成"><i /><i /><i /></span>
      <p v-if="message.status === 'failed'" class="message-failed">这条回答没有完成。</p>
      <p v-else-if="message.status === 'stopped'" class="message-stopped">已停止</p>
      <div class="message-actions">
        <button v-if="message.content" type="button" class="message-action" :aria-label="copied ? '已复制回答' : '复制回答'" @click="copyMessage">{{ copied ? '已复制' : '复制' }}</button>
        <template v-if="variants.length > 1">
          <button type="button" class="message-action version-arrow" :disabled="variantIndex <= 1 || busy" aria-label="上一版本" @click="emit('select', variants[variantIndex - 2]!)">‹</button>
          <span class="version-count">{{ variantIndex }} / {{ variants.length }}</span>
          <button type="button" class="message-action version-arrow" :disabled="variantIndex >= variants.length || busy" aria-label="下一版本" @click="emit('select', variants[variantIndex]!)">›</button>
        </template>
        <button v-if="canRegenerate" type="button" class="message-action" :disabled="busy" @click="emit('regenerate')">重新生成</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.chat-message{display:flex;width:100%;padding:10px 0}.message-user{display:flex;justify-content:flex-end;width:100%}.message-bubble{max-width:min(75%,720px);padding:11px 15px;background:#e8e9e0;border-radius:13px 13px 3px 13px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;font-size:15px}.message-assistant{width:min(100%,860px);margin:0 auto;min-width:0;line-height:1.72;font-size:15px}.message-markdown{overflow-wrap:anywhere}.message-markdown :deep(p){margin:0 0 13px}.message-markdown :deep(p:last-child){margin-bottom:0}.message-markdown :deep(ul),.message-markdown :deep(ol){padding-left:24px}.message-markdown :deep(blockquote){margin:14px 0;padding-left:14px;border-left:2px solid var(--line);color:var(--muted)}.message-markdown :deep(a){color:var(--accent)}.message-markdown :deep(code){padding:2px 5px;background:#ecece6;border-radius:2px;font:0.88em var(--mono);overflow-wrap:anywhere}.message-markdown :deep(pre.chat-code){position:relative;margin:14px 0;padding:36px 14px 14px;overflow:auto;background:#252620;color:#f6f6ef;border-radius:3px}.message-markdown :deep(pre.chat-code code){display:block;padding:0;background:transparent;color:inherit;white-space:pre;font:12px/1.65 var(--mono);overflow-wrap:normal}.message-markdown :deep(.code-copy){position:absolute;right:8px;top:7px;min-height:25px;padding:3px 7px;border:1px solid #ffffff33;border-radius:2px;background:transparent;color:#d8d9cf;font-size:11px}.message-markdown :deep(.code-copy:hover){background:#ffffff1a;border-color:#ffffff66;color:#fff}.message-actions{display:flex;align-items:center;gap:3px;min-height:28px;margin-top:7px;color:var(--muted);opacity:0}.message-assistant:hover .message-actions,.message-assistant:focus-within .message-actions{opacity:1}.message-action{min-height:25px;padding:2px 6px;border:0;background:transparent;color:var(--muted);font-size:11px}.message-action:hover{border-color:transparent;background:var(--soft);color:var(--ink)}.version-arrow{font-size:18px;line-height:1;padding:0 4px}.version-count{font:10px var(--mono);color:var(--muted)}.message-loading{display:inline-flex;gap:4px;height:25px;align-items:center}.message-loading i{display:block;width:5px;height:5px;border-radius:50%;background:var(--muted);animation:chat-pulse 1s infinite ease-in-out}.message-loading i:nth-child(2){animation-delay:.13s}.message-loading i:nth-child(3){animation-delay:.26s}.message-failed,.message-stopped{margin:7px 0 0;color:var(--danger);font-size:12px}.message-stopped{color:var(--muted)}.assistant.generating .message-actions{opacity:0}.assistant.failed .message-actions,.assistant.stopped .message-actions{opacity:1}
@keyframes chat-pulse{0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
@media(max-width:760px){.message-bubble{max-width:88%;font-size:15px}.message-assistant{font-size:15px}.message-actions{opacity:1}}
</style>
