<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { keysApi } from '../api/keys.js';
import type { KeyMetadata, KeyInput, KeyGroup } from '../api/keys.js';
import { ApiClientError } from '../api/client.js';
const props = defineProps<{ item: KeyMetadata }>(); const emit = defineEmits<{ close: []; changed: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const current = ref(props.item);
const name = ref(''); const expires = ref(''); const groupId = ref(''); const groups = ref<readonly KeyGroup[]>([]); const groupsBusy = ref(false);
async function loadGroups() { groupsBusy.value = true; try { const list = await keysApi.groups(); if (alive) groups.value = list; } catch { if (alive) message.value = '无法读取可用分组，请重新读取。'; } finally { if (alive) groupsBusy.value = false; } }
const busy = ref(false); const message = ref(''); const reloadNeeded = ref(false); const confirmRevoke = ref(false);
let initialExpiryText = ''; let alive = true;
function populate(item: KeyMetadata) {
  current.value = item; name.value = item.name; groupId.value = item.groupId;
  if (item.expiresAt === null) expires.value = '';
  else { const date = new Date(item.expiresAt); expires.value = new Date(item.expiresAt - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
  initialExpiryText = expires.value;
}
onMounted(() => { populate(props.item); dialog.value?.showModal(); void loadGroups(); }); onBeforeUnmount(() => { alive = false; });
function close() { if (!busy.value) emit('close'); }
function failed(error: unknown) {
  reloadNeeded.value = true;
  message.value = error instanceof ApiClientError && error.status === 409
    ? 'Key 已发生变化或不可编辑。请重新读取并核对后再操作，不会自动覆盖其他修改。'
    : '操作结果未确认。请重新读取状态，或重试撤销；不会显示为保存成功。';
}
async function reload() {
  if (busy.value) return; busy.value = true;
  try { await loadGroups(); const item = await keysApi.get(current.value.id); if (!alive) return; populate(item); reloadNeeded.value = false; confirmRevoke.value = false; message.value = '已读取最新状态，请核对表单后操作。'; emit('changed'); }
  catch (error) { if (alive) message.value = error instanceof Error ? error.message : '读取失败。'; }
  finally { if (alive) busy.value = false; }
}
async function save() {
  if (busy.value || reloadNeeded.value || current.value.status === 'revoked') return;
  const expiresAt = expires.value === initialExpiryText ? current.value.expiresAt : expires.value ? new Date(expires.value).getTime() : null;
  if (!name.value.trim() || (expiresAt !== null && !Number.isSafeInteger(expiresAt)) || !groups.value.some(group => group.id === groupId.value)) { message.value = '请填写名称并选择可用分组。'; return; }
  const input: KeyInput = { name: name.value.trim(), expiresAt, groupId: groupId.value };
  busy.value = true; message.value = '';
  try { const item = await keysApi.update(current.value.id, current.value.version, input); if (!alive) return; populate(item); message.value = 'Key 已保存。'; emit('changed'); }
  catch (error) { if (alive) failed(error); }
  finally { if (alive) busy.value = false; }
}
async function revoke() {
  if (busy.value || !confirmRevoke.value) return; busy.value = true; message.value = '';
  try { const result = await keysApi.revoke(current.value.id, current.value.version); if (!alive) return; populate(result.key); reloadNeeded.value = false; confirmRevoke.value = false; message.value = result.kind === 'already_revoked' ? '该 Key 已撤销，无需重复操作。' : 'Key 已撤销。'; emit('changed'); }
  catch (error) { if (alive) failed(error); }
  finally { if (alive) busy.value = false; }
}
</script>
<template>
  <dialog ref="dialog" aria-labelledby="edit-key-title" @cancel.prevent="close"><h2 id="edit-key-title">编辑 Key</h2><p><code>{{ current.displayPrefix }}…</code></p>
    <p v-if="message" role="status">{{ message }}</p><button v-if="reloadNeeded" type="button" :disabled="busy" @click="reload">重新读取</button>
    <p v-if="current.status === 'revoked'">此 Key 已撤销。</p>
    <form v-else id="edit-key-form" @submit.prevent="save"><fieldset :disabled="busy || reloadNeeded"><label>名称<input v-model="name" required maxlength="128" /></label><label>分组<select v-model="groupId" required :disabled="groupsBusy"><option v-if="!groups.some(group => group.id === current.groupId)" :value="current.groupId" disabled>{{ current.groupName }}（授权已撤回）</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label><label>到期时间（留空不过期）<input v-model="expires" type="datetime-local" /></label></fieldset></form>
    <div v-if="confirmRevoke"><p>撤销后不能再使用此 Key，且无法恢复。</p><div class="dialog-actions"><button type="button" :disabled="busy" @click="confirmRevoke = false">暂不撤销</button><button type="button" :disabled="busy" @click="revoke">确认撤销</button></div></div>
    <div v-else class="dialog-actions"><button v-if="current.status !== 'revoked'" class="danger-action" type="button" :disabled="busy" @click="confirmRevoke = true">撤销 Key</button><button type="button" :disabled="busy" @click="close">关闭</button><button v-if="current.status !== 'revoked'" type="submit" form="edit-key-form" :disabled="busy || reloadNeeded || groupsBusy">保存 Key</button></div>
  </dialog>
</template>
<style scoped>
dialog { width: min(94vw, 520px); border: 1px solid var(--line); border-radius: 10px; padding: 28px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 8px; margin: 16px 0; }input,select,textarea { width: 100%; padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }button { margin: 8px 8px 0 0; }
</style>
