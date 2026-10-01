<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { keysApi } from '../api/keys.js';
import type { KeyMetadata, KeyState } from '../api/keys.js';
import CreateKeyDialog from '../components/CreateKeyDialog.vue';
import EditKeyDialog from '../components/EditKeyDialog.vue';
const createOpen = ref(false);
const editing = ref<KeyMetadata | null>(null);
const items = ref<readonly KeyMetadata[]>([]); const nextCursor = ref<string | null>(null);
const state = ref<KeyState>('all'); const loading = ref(false); const error = ref('');
let epoch = 0;
async function load(more = false) {
  const ticket = ++epoch; loading.value = true; error.value = '';
  try { const page = await keysApi.list({ state: state.value, cursor: more ? nextCursor.value : null });
    if (ticket === epoch) { items.value = more ? [...items.value, ...page.items] : page.items; nextCursor.value = page.nextCursor; }
  } catch (cause) { if (ticket === epoch) error.value = cause instanceof Error ? cause.message : '无法读取 Key 列表。'; }
  finally { if (ticket === epoch) loading.value = false; }
}
const expiry = (key: KeyMetadata) => key.status === 'revoked' ? '已撤销' : key.expiresAt !== null && key.expiresAt <= Date.now() ? '已过期' : '有效';
onMounted(() => { void load(); }); onBeforeUnmount(() => { epoch++; });
</script>
<template>
  <section><div class="page-heading"><h1>API Keys</h1>
    <button type="button" class="primary" @click="createOpen = true"><span aria-hidden="true">+</span> 创建 Key</button></div>
    <CreateKeyDialog :open="createOpen" @close="createOpen = false" @created="load()" />
    <EditKeyDialog v-if="editing" :item="editing" @close="editing = null; load()" @changed="load()" />
    <div class="toolbar"><label>状态 <select v-model="state" :disabled="loading" @change="load()"><option value="all">全部</option><option value="active">有效</option><option value="expired">已过期</option><option value="revoked">已撤销</option></select></label>
    <button type="button" :disabled="loading" @click="load()">刷新</button></div>
    <p v-if="loading" role="status">正在读取…</p><div v-if="error" role="alert">{{ error }} <button type="button" @click="load()">重试</button></div>
    <div v-if="!loading && !error && items.length === 0" class="empty-state"><strong>暂无 Key</strong><p>创建独立密钥，用于你的应用或客户端。</p><button type="button" @click="createOpen = true">创建第一个 Key <span aria-hidden="true">→</span></button></div>
    <div class="table-scroll" v-if="items.length"><table><caption>个人 Key 列表</caption><thead><tr><th>名称 / 掩码</th><th>状态</th><th>到期时间</th><th>分组</th><th>操作</th></tr></thead>
      <tbody><tr v-for="key in items" :key="key.id"><td>{{ key.name }}<br /><code>{{ key.displayPrefix }}…</code></td><td>{{ expiry(key) }}</td><td>{{ key.expiresAt === null ? '不过期' : new Date(key.expiresAt).toLocaleString() }}</td><td>{{ key.groupName }}</td><td><button type="button" @click="editing = key">{{ key.status === 'revoked' ? '查看' : '编辑 / 撤销' }}</button></td></tr></tbody>
    </table></div>
    <button v-if="nextCursor" type="button" :disabled="loading" @click="load(true)">加载更多</button>
  </section>
</template>
<style scoped>
select { padding: 9px; margin-right: 12px; }button { margin: 8px 8px 8px 0; }.table-scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: #fff; }th,td { text-align: left; padding: 16px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }caption { text-align: left; padding-bottom: 12px; }code { color: var(--muted); }
</style>
