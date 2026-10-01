<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { adminUsersApi } from '../../api/admin-users.js';
import type { UserGroup } from '../../api/admin-users.js';
import { ApiClientError } from '../../api/client.js';
const emit = defineEmits<{ close: []; created: [] }>(); const dialog = ref<HTMLDialogElement | null>(null);
const email = ref(''); const password = ref(''); const groupId = ref(''); const groups = ref<UserGroup[]>([]); const cursor = ref<string | null>(null);
const loading = ref(false); const groupError = ref(''); const busy = ref(false); const message = ref(''); const finished = ref(false); let alive = true;
async function loadGroups(more = false) {
  loading.value = true; groupError.value = '';
  try { const page = await adminUsersApi.groups(more ? cursor.value : null); if (alive) { groups.value = more ? [...groups.value, ...page.items] : page.items; cursor.value = page.nextCursor; } }
  catch (error) { if (alive) groupError.value = error instanceof Error ? error.message : '分组读取失败。'; }
  finally { if (alive) loading.value = false; }
}
function close() { if (!busy.value) { password.value = ''; emit('close'); } }
async function submit() {
  if (busy.value || finished.value || loading.value || groupError.value) return; busy.value = true; message.value = '';
  try { const user = await adminUsersApi.create({ email: email.value.trim(), password: password.value, ...(groupId.value ? { groupId: groupId.value } : {}) });
    if (alive) { finished.value = true; message.value = `用户 ${user.email_normalized} 已创建。初始角色由服务器确定，余额为 ${user.balance_units} 最小单位。`; emit('created'); }
  } catch (error) {
    if (!alive) return;
    if (error instanceof ApiClientError && error.status !== null && error.status >= 400 && error.status < 500) message.value = error.message;
    else { finished.value = true; message.value = '创建结果未确认，账户可能已创建。请返回列表核对，不能在此直接重复提交。'; emit('created'); }
  } finally { password.value = ''; if (alive) busy.value = false; }
}
onMounted(() => { dialog.value?.showModal(); void loadGroups(); }); onBeforeUnmount(() => { alive = false; password.value = ''; });
</script>
<template>
  <dialog ref="dialog" aria-labelledby="create-user-title" @cancel.prevent="close"><h2 id="create-user-title">创建普通用户</h2>
    <p v-if="message" role="status">{{ message }}</p><p v-if="groupError" role="alert">{{ groupError }}<button type="button" @click="loadGroups()">重试分组</button></p>
    <form id="new-user-form" v-if="!finished" @submit.prevent="submit"><fieldset :disabled="busy"><label>邮箱<input v-model="email" type="email" name="new-user-email" autocomplete="off" required maxlength="254" /></label><label>初始密码<input v-model="password" type="password" name="new-user-password" autocomplete="new-password" required minlength="6" maxlength="128" /></label><label>分组<select v-model="groupId" :disabled="loading"><option value="">服务器默认分组</option><option v-for="group in groups" :key="group.id" :value="group.id" :disabled="group.status !== 'active'">{{ group.name }}</option></select></label><button v-if="cursor" type="button" :disabled="loading" @click="loadGroups(true)">更多分组</button></fieldset></form>
    <div class="dialog-actions"><button type="button" :disabled="busy" @click="close">返回用户列表</button><button v-if="!finished" type="submit" form="new-user-form" :disabled="busy || loading || !!groupError">{{ busy ? '正在创建…' : '创建用户' }}</button></div>
  </dialog>
</template>
<style scoped>
dialog { width: min(94vw, 520px); padding: 28px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 8px; margin: 16px 0; }input,select { padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }button { margin: 8px 8px 0 0; }
</style>
