<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { adminRegistrationApi } from '../../api/admin-registration.js';
import type { CodeListItem } from '../../api/admin-registration.js';
import { ApiClientError } from '../../api/client.js';
import CreateCodesDialog from '../../components/admin/CreateCodesDialog.vue';
const creating = ref(false);
const items = ref<CodeListItem[]>([]); const cursor = ref<string | null>(null); const creator = ref(''); const busy = ref(false); const message = ref('');
const selected = ref<CodeListItem | null>(null); let epoch = 0;
const labels = { unused: '未使用', used: '已使用', expired: '已过期', revoked: '已撤销' };
async function load(more = false) {
  const ticket = ++epoch; busy.value = true; message.value = '';
  try { const page = await adminRegistrationApi.codes({ cursor: more ? cursor.value : null, ...(creator.value.trim() ? { creatorFilter: creator.value.trim() } : {}) });
    if (ticket === epoch) { items.value = more ? [...items.value, ...page.items] : page.items; cursor.value = page.nextCursor; }
  } catch (error) { if (ticket === epoch) message.value = error instanceof Error ? error.message : '读取失败。'; }
  finally { if (ticket === epoch) busy.value = false; }
}
async function revoke() {
  if (!selected.value || busy.value) return; const id = selected.value.id; busy.value = true;
  try { await adminRegistrationApi.revokeCode(id); selected.value = null; await load(); }
  catch (error) { message.value = error instanceof ApiClientError && error.status === 409 ? '注册码已经使用或状态发生变化，请刷新列表。' : '撤销结果未确认，请重试或刷新列表确认。'; }
  finally { busy.value = false; }
}
onMounted(() => { void load(); }); onBeforeUnmount(() => { epoch++; });
</script>
<template>
  <section><div class="page-heading"><h1>注册邀请码</h1><button type="button" @click="creating = true">生成注册码</button></div><CreateCodesDialog :open="creating" @close="creating = false" @created="load()" />
    <form @submit.prevent="load()"><label>创建者 ID<input v-model="creator" maxlength="128" /></label><button type="submit" :disabled="busy">查询 / 刷新</button></form>
    <p v-if="message" role="alert">{{ message }}</p><p v-if="busy" role="status">正在处理…</p>
    <div v-if="selected"><p>确认撤销 {{ selected.displayPrefix }}…？此操作不可恢复。</p><button type="button" :disabled="busy" @click="revoke">确认撤销</button><button type="button" :disabled="busy" @click="selected = null">取消</button></div>
    <p class="empty-state" v-if="!busy && !message && items.length === 0">暂无注册码。</p>
    <div class="scroll"><table v-if="items.length"><thead><tr><th>掩码</th><th>状态</th><th>创建者 / 使用者</th><th>期限</th><th>操作</th></tr></thead><tbody><tr v-for="code in items" :key="code.id"><td><code>{{ code.displayPrefix }}…</code></td><td>{{ labels[code.status] }}</td><td>{{ code.createdBy }} / {{ code.usedBy ?? '未使用' }}</td><td>{{ code.expiresAt === null ? '历史记录未设期限' : new Date(code.expiresAt).toLocaleString() }}</td><td><button type="button" :disabled="busy || code.status !== 'unused'" @click="selected = code">撤销</button></td></tr></tbody></table></div>
    <button v-if="cursor" type="button" :disabled="busy" @click="load(true)">加载更多</button>
  </section>
</template>
<style scoped>
form { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }input { display: block; padding: 10px; margin-top: 8px; }.scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: white; }th,td { padding: 14px; text-align: left; border-bottom: 1px solid var(--line); }button { margin: 6px; }
</style>
