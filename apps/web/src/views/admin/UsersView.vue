<script setup lang="ts">
import { formatUnitsToUsd } from '../../api/billing.js';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { adminUsersApi } from '../../api/admin-users.js';
import type { UserListItem } from '../../api/admin-users.js';
import CreateUserDialog from '../../components/admin/CreateUserDialog.vue';
import EditUserDialog from '../../components/admin/EditUserDialog.vue';
import BalanceAdjustmentDialog from '../../components/admin/BalanceAdjustmentDialog.vue';
const creating = ref(false);
const editing = ref<UserListItem | null>(null);
const adjusting = ref<UserListItem | null>(null);
const users = ref<UserListItem[]>([]); const cursor = ref<string | null>(null); const status = ref<'' | 'active' | 'disabled'>(''); const groupId = ref('');
const busy = ref(false); const error = ref(''); let epoch = 0;
async function load(more = false) {
  const ticket = ++epoch; busy.value = true; error.value = '';
  try { const page = await adminUsersApi.list({ cursor: more ? cursor.value : null, ...(status.value ? { status: status.value } : {}), ...(groupId.value.trim() ? { groupId: groupId.value.trim() } : {}) });
    if (ticket === epoch) { users.value = more ? [...users.value, ...page.items] : page.items; cursor.value = page.nextCursor; }
  } catch (cause) { if (ticket === epoch) error.value = cause instanceof Error ? cause.message : '用户列表读取失败。'; }
  finally { if (ticket === epoch) busy.value = false; }
}
onMounted(() => { void load(); }); onBeforeUnmount(() => { epoch++; });
</script>
<template>
  <section><div class="page-heading"><h1>用户管理</h1><button type="button" @click="creating = true">创建普通用户</button></div><CreateUserDialog v-if="creating" @close="creating = false; load()" @created="load()" />
    <EditUserDialog v-if="editing" :user="editing" @close="editing = null" @changed="load()" />
    <BalanceAdjustmentDialog v-if="adjusting" :user-id="adjusting.id" :email="adjusting.email_normalized" :balance-units="adjusting.balance_units" @close="adjusting = null" @adjusted="load()" />
    <form class="toolbar" @submit.prevent="load()"><label>状态<select v-model="status"><option value="">全部</option><option value="active">启用</option><option value="disabled">停用</option></select></label><label>分组 ID<input v-model="groupId" maxlength="128" /></label><button type="submit" :disabled="busy">查询 / 刷新</button></form>
    <p v-if="busy" role="status">正在读取…</p><p v-if="error" role="alert">{{ error }}</p><p v-if="!busy && !error && users.length === 0">没有符合条件的用户。</p>
    <div class="table-scroll"><table v-if="users.length"><thead><tr><th>邮箱 / 角色</th><th>状态 / 分组</th><th>余额 / USD</th><th>并发请求数</th><th>每分钟请求数</th><th>操作</th></tr></thead><tbody><tr v-for="user in users" :key="user.id"><td>{{ user.email_normalized }}<br />{{ user.role === 'admin' ? '管理员' : '普通用户' }}</td><td>{{ user.status === 'active' ? '启用' : '停用' }} / {{ user.group_name }}</td><td>{{ formatUnitsToUsd(user.balance_units) }}</td><td>{{ user.concurrency_limit === Number.MAX_SAFE_INTEGER ? '不限' : user.concurrency_limit }}</td><td>{{ user.rpm_limit === Number.MAX_SAFE_INTEGER ? '不限' : user.rpm_limit }}</td><td><button type="button" @click="editing = user">编辑用户</button><button type="button" @click="adjusting = user">余额调整</button></td></tr></tbody></table></div>
    <button v-if="cursor" type="button" :disabled="busy" @click="load(true)">加载更多</button>
  </section>
</template>
<style scoped>
td:nth-child(3),td:nth-child(4),td:nth-child(5) { white-space: nowrap; font-variant-numeric: tabular-nums; }
form { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }input,select { display: block; padding: 10px; margin-top: 8px; }.scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: white; }td,th { padding: 14px; text-align: left; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }button { margin: 8px 0; }
</style>
