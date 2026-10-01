<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiClientError } from '../../api/client.js';
import { adminModelsApi } from '../../api/admin-models.js';
import type { ModelView } from '../../api/admin-models.js';
import ModelEditor from '../../components/admin/ModelEditor.vue';
import ModelMappingEditor from '../../components/admin/ModelMappingEditor.vue';

const items = ref<ModelView[]>([]); const cursor = ref<string | null>(null); const status = ref<'' | 'active' | 'disabled'>(''); const busy = ref(false); const error = ref(''); const requestId = ref<string | null>(null); const creating = ref(false); const editing = ref<ModelView | null>(null); const mappingModel = ref<ModelView | null>(null); let epoch = 0;
async function load(more = false) { const ticket = ++epoch; busy.value = true; error.value = ''; requestId.value = null;
  try { const result = await adminModelsApi.list({ cursor: more ? cursor.value : null, ...(status.value ? { status: status.value } : {}) }); if (ticket === epoch) { items.value = more ? [...items.value, ...result.items] : [...result.items]; cursor.value = result.nextCursor; } }
  catch (cause) { if (ticket === epoch) { error.value = cause instanceof Error ? cause.message : '模型列表读取失败。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; } }
  finally { if (ticket === epoch) busy.value = false; }
}
onMounted(() => { void load(); }); onBeforeUnmount(() => { epoch++; });
</script>

<template>
  <section><div class="page-heading"><h1>模型与映射</h1><button type="button" @click="creating = true">创建模型</button></div><ModelEditor v-if="creating" :item="null" @close="creating = false" @saved="load()" /><ModelEditor v-if="editing" :item="editing" @close="editing = null" @saved="load()" /><ModelMappingEditor v-if="mappingModel" :model="mappingModel" @close="mappingModel = null" />
    <form class="toolbar" @submit.prevent="load()"><label>状态<select v-model="status"><option value="">全部</option><option value="active">启用</option><option value="disabled">停用</option></select></label><button type="submit" :disabled="busy">查询 / 刷新</button></form>
    <p v-if="busy" role="status">正在读取模型…</p><p v-if="error" role="alert">{{ error }} <small v-if="requestId">请求编号：{{ requestId }}</small><button type="button" @click="load()">重试</button></p><p class="empty-state" v-if="!busy && !error && items.length === 0">暂无模型。</p>
    <div v-if="items.length" class="table-scroll"><table><caption>公开模型</caption><thead><tr><th>模型 / 状态</th><th>价格（USD / 百万 Token）</th><th>准入与输出上限</th><th>操作</th></tr></thead><tbody><tr v-for="model in items" :key="model.publicModelId"><td><strong>{{ model.publicModelId }}</strong><br />{{ model.status === 'active' ? '启用' : '停用' }}</td><td><span v-for="(value, key) in model.sellPrices" :key="key" class="price-line">{{ key }}：{{ value }}</span></td><td>最低余额：{{ model.admissionMinBalanceUnits }}<br />最大输出：{{ model.maxOutputTokens }}</td><td><button type="button" @click="editing = model">编辑价格</button><button type="button" @click="mappingModel = model">管理映射</button></td></tr></tbody></table></div>
    <button v-if="cursor" type="button" :disabled="busy" @click="load(true)">加载更多</button>
  </section>
</template>

<style scoped>
.toolbar { display: flex; align-items: end; gap: 12px; margin: 20px 0; }label { display: grid; gap: 7px; }select { padding: 9px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }.table-scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: #fff; }th,td { text-align: left; vertical-align: top; padding: 14px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }caption { text-align: left; padding-bottom: 12px; }.price-line { display: block; white-space: nowrap; }small { color: var(--muted); }button { margin: 7px 7px 7px 0; }
</style>
