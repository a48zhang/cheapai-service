<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  readonly modelValue: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}>(), { busy: false, disabled: false, placeholder: '输入消息…' });

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'submit'): void;
  (event: 'stop'): void;
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);

function resize() {
  const element = textarea.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(Math.max(element.scrollHeight, 42), 220)}px`;
}

function update(value: string) {
  emit('update:modelValue', value);
  void nextTick(resize);
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    emit('submit');
  }
}

watch(() => props.modelValue, () => void nextTick(resize));
</script>

<template>
  <form class="chat-composer" @submit.prevent="emit('submit')">
    <textarea ref="textarea" :value="modelValue" :placeholder="placeholder" :disabled="disabled && !busy" rows="1" maxlength="1000000" aria-label="消息内容" @input="update(($event.target as HTMLTextAreaElement).value)" @keydown="keydown" />
    <button v-if="busy" type="button" class="stop-button" aria-label="停止生成" @click="emit('stop')"><span aria-hidden="true">■</span> 停止</button>
    <button v-else type="submit" class="send-button" :disabled="disabled || !modelValue.trim()" aria-label="发送消息"><span aria-hidden="true">↑</span></button>
  </form>
</template>

<style scoped>
.chat-composer{display:flex;align-items:flex-end;gap:10px;width:min(100%,860px);margin:0 auto;padding:12px;background:var(--surface);border:1px solid #cfd0c6;border-radius:5px;box-shadow:0 7px 25px #2526200d}.chat-composer textarea{display:block;flex:1;min-width:0;min-height:42px;max-height:220px;resize:none;overflow-y:auto;border:0!important;padding:10px 4px!important;background:transparent!important;line-height:1.5}.chat-composer textarea:focus{outline:0!important;border:0!important}.send-button,.stop-button{flex:none;min-height:38px}.send-button{width:38px;padding:0;border-color:var(--ink);background:var(--ink);color:#fff;font-size:21px}.send-button:hover{background:#414239;color:#fff}.stop-button{padding:8px 12px;font-size:12px;border-color:var(--ink);background:var(--ink);color:#fff}.stop-button span{font-size:10px}@media(max-width:500px){.chat-composer{padding:9px;gap:7px}.stop-button{padding:8px 9px}.chat-composer textarea{font-size:16px}}
</style>
