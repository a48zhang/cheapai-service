<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiClientError } from '../../api/client.js';
import { adminChannelsApi } from '../../api/admin-channels.js';
import type { ChannelInput, ChannelPatch, ChannelView } from '../../api/admin-channels.js';

const props = defineProps<{ item: ChannelView | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const busy = ref(false); const locked = ref(false); const message = ref(''); let alive = true;
const name = ref(''); const baseUrl = ref(''); const upstreamKey = ref(''); const status = ref<'active' | 'disabled'>('active');
const concurrency = ref<number | string>(''); const rpm = ref<number | string>(''); const priority = ref(0);
const editing = computed(() => props.item !== null);
function populate() { const item = props.item; name.value = item?.name ?? ''; baseUrl.value = item?.baseUrl ?? ''; upstreamKey.value = ''; status.value = item?.status ?? 'active'; concurrency.value = !item || item.concurrencyLimit === Number.MAX_SAFE_INTEGER ? '' : item.concurrencyLimit; rpm.value = !item || item.rpmLimit === Number.MAX_SAFE_INTEGER ? '' : item.rpmLimit; priority.value = item?.priority ?? 0; message.value = ''; locked.value = false; }
function close() { if (!busy.value) { upstreamKey.value = ''; emit('close'); } }
async function show() { await nextTick(); if (dialog.value && !dialog.value.open) dialog.value.showModal(); }
async function save() {
  if (busy.value || locked.value) return;
  const concurrencyLimit = concurrency.value === '' ? 0 : Number(concurrency.value);
  const rpmLimit = rpm.value === '' ? 0 : Number(rpm.value);
  if (!name.value.trim() || !baseUrl.value.trim() || ![concurrencyLimit, rpmLimit, priority.value].every(Number.isSafeInteger) || concurrencyLimit < 0 || rpmLimit < 0 || priority.value < 0 || (!editing.value && !upstreamKey.value.trim())) { message.value = '请填写名称、有效 URL、正整数限额、非负优先级和必需密钥。'; return; }
  busy.value = true; message.value = '';
  const input: ChannelInput = { name: name.value.trim(), baseUrl: baseUrl.value.trim(), upstreamKey: upstreamKey.value, concurrencyLimit, rpmLimit, priority: priority.value, status: status.value };
  try {
    if (props.item) { const patch: ChannelPatch = { name: input.name, baseUrl: input.baseUrl, concurrencyLimit: input.concurrencyLimit, rpmLimit: input.rpmLimit, priority: priority.value, status: status.value, ...(upstreamKey.value.trim() ? { upstreamKey: upstreamKey.value } : {}) }; await adminChannelsApi.update(props.item.id, props.item.configVersion, patch); }
    else await adminChannelsApi.create(input);
    if (alive) { upstreamKey.value = ''; message.value = editing.value ? '渠道设置已保存。' : '渠道已创建。'; emit('saved'); locked.value = true; }
  } catch (error) {
    if (alive) { locked.value = true; message.value = error instanceof ApiClientError && error.status === 409 ? '渠道版本已变化，请返回列表重新读取后核对，不能覆盖其他修改。' : '保存结果未确认，请返回列表核对；本页不会自动重试。'; }
  } finally { if (alive) busy.value = false; upstreamKey.value = ''; }
}
onMounted(() => { populate(); void show(); }); onBeforeUnmount(() => { alive = false; upstreamKey.value = ''; });
</script>

<template>
  <dialog ref="dialog" aria-labelledby="channel-editor-title" @cancel.prevent="close"><h2 id="channel-editor-title">{{ editing ? '编辑渠道' : '创建渠道' }}</h2><p v-if="message" role="status">{{ message }}</p>
    <form id="channel-editor-form" @submit.prevent="save"><fieldset :disabled="busy || locked"><label>名称<input v-model="name" maxlength="200" required autocomplete="off" /></label><label>上游基础 URL<input v-model="baseUrl" maxlength="2048" required autocomplete="off" /></label><label>上游 API Key<input v-model="upstreamKey" type="password" maxlength="16384" :placeholder="editing ? '留空保持当前密钥' : ''" autocomplete="new-password" /></label><label>状态<select v-model="status"><option value="active">启用</option><option value="disabled">停用</option></select></label><label>并发（留空不限）<input v-model="concurrency" type="number" min="0" step="1" placeholder="不限" /></label><label>每分钟请求数（留空不限）<input v-model="rpm" type="number" min="0" step="1" placeholder="不限" /></label><label>优先级<input v-model.number="priority" type="number" min="0" step="1" required /></label></fieldset></form>
    <div class="dialog-actions"><button type="button" :disabled="busy" @click="close">关闭</button><button type="submit" form="channel-editor-form" :disabled="busy || locked">{{ busy ? '正在保存…' : '保存渠道' }}</button></div>
  </dialog>
</template>

<style scoped>
dialog { width: min(94vw, 560px); padding: 28px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 7px; margin: 14px 0; }input,select { width: 100%; padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }small { color: var(--muted); overflow-wrap: anywhere; }button { margin: 8px 8px 0 0; }
</style>
