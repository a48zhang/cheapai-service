<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { keysApi } from '../api/keys.js';
import type { KeyGroup, KeyInput } from '../api/keys.js';
import { ApiClientError } from '../api/client.js';
const props = defineProps<{ open: boolean }>(); const emit = defineEmits<{ close: []; created: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const name = ref(''); const expires = ref('');
const groupId = ref(''); const groups = ref<readonly KeyGroup[]>([]); const groupsBusy = ref(false); const groupsError = ref('');
const selectedGroup = computed(() => groups.value.find(group => group.id === groupId.value));
async function loadGroups() { groupsBusy.value = true; groupsError.value = ''; try { const list = await keysApi.groups(); if (alive) { groups.value = list; if (!list.some(group => group.id === groupId.value)) groupId.value = list[0]?.id ?? ''; } } catch { if (alive) groupsError.value = '无法读取可用分组。'; } finally { if (alive) groupsBusy.value = false; } } const busy = ref(false); const message = ref('');
const token = ref(''); const settled = ref(false); const canEdit = ref(false);
const intent = ref<{ operationId: string; input: KeyInput } | null>(null);
let alive = true;
function reset() { intent.value = null; settled.value = false; token.value = ''; message.value = ''; canEdit.value = false; }
async function show() { await nextTick(); if (props.open && !dialog.value?.open) dialog.value?.showModal(); }
watch(() => props.open, open => { if (open) { if (settled.value) { reset(); name.value = ''; expires.value = ''; groupId.value = ''; } void show(); void loadGroups(); } else { dialog.value?.close(); token.value = ''; } });
onMounted(() => { void show(); if (props.open) void loadGroups(); }); onBeforeUnmount(() => { alive = false; token.value = ''; });
function close() { if (!busy.value) { token.value = ''; emit('close'); } }
async function submit() {
  if (busy.value || settled.value) return;
  if (!intent.value) {
    const expiresAt = expires.value ? new Date(expires.value).getTime() : null;
    if (!name.value.trim() || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))) { message.value = '请填写名称和有效的未来期限。'; return; }
    if (!selectedGroup.value) { message.value = '请选择管理员开放的分组。'; return; }
    intent.value = { operationId: crypto.randomUUID(), input: { name: name.value.trim(), expiresAt, groupId: groupId.value } };
  }
  busy.value = true; message.value = ''; canEdit.value = false;
  try {
    const result = await keysApi.create(intent.value.input, intent.value.operationId); if (!alive) return;
    settled.value = true;
    if (result.kind === 'created') { token.value = result.token; message.value = 'Key 已创建，完整密钥仅本次显示，请保存。'; }
    else message.value = '此操作已创建 Key，但无法再次取回明文。请在列表确认；如未保存，可撤销该 Key 后新建。';
    emit('created');
  } catch (error) {
    if (!alive) return;
    canEdit.value = error instanceof ApiClientError && (error.status === 400 || error.status === 403);
    message.value = canEdit.value ? (error as Error).message : '结果尚未确认。重试会沿用同一操作和参数；请勿刷新页面。关闭后本页重新打开仍可继续确认。';
  } finally { if (alive) busy.value = false; }
}
</script>
<template>
  <dialog ref="dialog" aria-labelledby="create-key-title" @cancel.prevent="close">
    <h2 id="create-key-title">创建 API Key</h2>
    <p v-if="message" role="status">{{ message }}</p>
    <template v-if="token"><label for="new-key-secret">完整密钥（仅显示一次）</label><textarea id="new-key-secret" :value="token" readonly autocomplete="off" spellcheck="false" rows="3" /></template>
    <form v-if="!settled" id="create-key-form" @submit.prevent="submit"><fieldset :disabled="busy || intent !== null">
      <label>名称<input v-model="name" required maxlength="128" autocomplete="off" /></label>
      <label>分组<select v-model="groupId" required :disabled="groupsBusy"><option value="" disabled>选择分组</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
      <p v-if="groupsError" role="alert">{{ groupsError }} <button type="button" @click="loadGroups">重试</button></p>
      <p v-else-if="!groupsBusy && !groups.length">暂无可用分组，请联系管理员开放。</p>
      <div v-if="selectedGroup" class="model-preview"><span v-if="!selectedGroup.models.length">该分组尚未配置模型</span><code v-for="model in selectedGroup.models" :key="model">{{ model }}</code></div>
      <label>到期时间（留空不过期）<input v-model="expires" type="datetime-local" /></label>
    </fieldset></form>
    <div class="dialog-actions"><button v-if="canEdit" type="button" @click="reset">修改参数</button><button type="button" :disabled="busy" @click="close">{{ token ? '已保存，关闭密钥' : '关闭' }}</button><button v-if="!settled" type="submit" form="create-key-form" :disabled="busy || groupsBusy || !selectedGroup">{{ busy ? '正在确认…' : intent ? '重试确认' : '创建 Key' }}</button></div>
  </dialog>
</template>
<style scoped>
dialog { width: min(94vw, 520px); border: 1px solid var(--line); border-radius: 10px; padding: 28px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 8px; margin: 16px 0; }input,select,textarea { width: 100%; padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }textarea { overflow-wrap: anywhere; }button { margin: 8px 8px 0 0; }
</style>
