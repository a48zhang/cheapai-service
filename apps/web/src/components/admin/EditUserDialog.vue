<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { adminUsersApi } from '../../api/admin-users.js';
import type { UserGroup, UserListItem } from '../../api/admin-users.js';
import { ApiClientError } from '../../api/client.js';
const props = defineProps<{ user: UserListItem }>(); const emit = defineEmits<{ close: []; changed: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const status = ref(props.user.status); const groupId = ref(props.user.group_id);
const concurrency = ref<number | string>(props.user.concurrency_limit === Number.MAX_SAFE_INTEGER ? '' : props.user.concurrency_limit);
const allowedGroupIds = ref<string[]>([...props.user.allowed_group_ids]);
function ensureDefaultGrant() { if (!allowedGroupIds.value.includes(groupId.value)) allowedGroupIds.value.push(groupId.value); } const rpm = ref<number | string>(props.user.rpm_limit === Number.MAX_SAFE_INTEGER ? '' : props.user.rpm_limit); const groups = ref<UserGroup[]>([]);
const cursor = ref<string | null>(null); const loading = ref(false); const groupError = ref(''); const busy = ref(false); const locked = ref(false); const message = ref(''); let alive = true;
async function loadGroups(more = false) {
  loading.value = true; groupError.value = '';
  try { const page = await adminUsersApi.groups(more ? cursor.value : null); if (alive) { groups.value = more ? [...groups.value, ...page.items] : page.items; cursor.value = page.nextCursor; } }
  catch (error) { if (alive) groupError.value = error instanceof Error ? error.message : '无法读取分组。'; }
  finally { if (alive) loading.value = false; }
}
function close() { if (!busy.value) { emit('changed'); emit('close'); } }
async function save() {
  if (busy.value || loading.value || groupError.value || locked.value) return;
  const concurrencyLimit = concurrency.value === '' ? 0 : Number(concurrency.value);
  const rpmLimit = rpm.value === '' ? 0 : Number(rpm.value);
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 0 || !Number.isSafeInteger(rpmLimit) || rpmLimit < 0 || !groupId.value) { message.value = '限额必须为正整数，并选择有效分组。'; return; }
  busy.value = true; message.value = '';
  try { await adminUsersApi.update(props.user.id, props.user.version, { status: status.value, groupId: groupId.value, concurrencyLimit, rpmLimit, allowedGroupIds: [...new Set([...allowedGroupIds.value, groupId.value])] });
    if (alive) { locked.value = true; message.value = '用户设置已保存。请返回列表查看最新状态与版本。'; emit('changed'); }
  } catch (error) {
    if (alive) { locked.value = true; message.value = error instanceof ApiClientError && error.status === 409
      ? '用户版本已变化，或触发最后管理员保护。请返回列表重新读取并核对，不能强制覆盖。'
      : '保存未确认或被服务器拒绝，请返回列表核对。不会在本页自动重试。'; }
  } finally { if (alive) busy.value = false; }
}
onMounted(() => { dialog.value?.showModal(); void loadGroups(); }); onBeforeUnmount(() => { alive = false; });
</script>
<template>
  <dialog ref="dialog" aria-labelledby="edit-user-title" @cancel.prevent="close"><h2 id="edit-user-title">编辑用户</h2><p>{{ user.email_normalized }}</p>
    <p v-if="message" role="status">{{ message }}</p><p v-if="groupError" role="alert">{{ groupError }}<button type="button" @click="loadGroups()">重试分组</button></p>
    <form id="edit-user-form" @submit.prevent="save"><fieldset :disabled="busy || locked"><label>账户状态<select v-model="status"><option value="active">启用</option><option value="disabled">停用</option></select></label><label>默认分组<select v-model="groupId" :disabled="loading" @change="ensureDefaultGrant"><option v-if="!groups.some(group => group.id === user.group_id)" :value="user.group_id">{{ user.group_name }}（当前）</option><option v-for="group in groups" :key="group.id" :value="group.id" :disabled="group.status !== 'active'">{{ group.name }}</option></select></label><button v-if="cursor" type="button" :disabled="loading" @click="loadGroups(true)">更多分组</button><div class="field-group"><span>开放分组</span><div class="choice-grid"><label v-for="group in groups" :key="group.id" class="choice"><input v-model="allowedGroupIds" type="checkbox" :value="group.id" :disabled="loading || group.id === groupId" />{{ group.name }}</label></div></div><label>并发（留空不限）<input v-model="concurrency" type="number" min="0" step="1" placeholder="不限" /></label><label>每分钟请求数（留空不限）<input v-model="rpm" type="number" min="0" step="1" placeholder="不限" /></label></fieldset></form>
    <div class="dialog-actions"><button type="button" :disabled="busy" @click="close">关闭</button><button type="submit" form="edit-user-form" :disabled="busy || locked || loading || !!groupError">保存用户设置</button></div>
  </dialog>
</template>
<style scoped>
dialog { width: min(94vw, 520px); padding: 28px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 8px; margin: 16px 0; }input,select { padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }button { margin: 8px 8px 0 0; }
</style>
