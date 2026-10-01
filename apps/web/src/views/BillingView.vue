<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiClientError } from '../api/client.js';
import { billingApi, formatUnitsToUsd } from '../api/billing.js';
import type { BillingKind, BillingPage, BillingQuery } from '../api/billing.js';

const page = ref<BillingPage | null>(null); const filter = ref<'' | BillingKind>(''); const requestFilter = ref(''); const busy = ref(false); const error = ref(''); const requestId = ref<string | null>(null); let epoch = 0;
const labels: Record<BillingKind, string> = { consumption: '模型消费', grant: '管理员授额', adjustment: '余额调整' };
const money = (value: string) => { try { return `${formatUnitsToUsd(value)} USD`; } catch { return '金额未知'; } };
function query(more = false): BillingQuery {
  const base: BillingQuery = { ...(filter.value ? { kind: filter.value } : {}), ...(requestFilter.value.trim() ? { requestId: requestFilter.value.trim() } : {}) };
  return more ? { ...base, cursor: page.value?.nextCursor ?? null } : { ...base, cursor: null };
}
async function load(more = false) { const ticket = ++epoch; busy.value = true; error.value = ''; requestId.value = null;
  try { const result = await billingApi.list(query(more)); if (ticket === epoch) page.value = more && page.value ? { ...result, items: [...page.value.items, ...result.items] } : result; }
  catch (cause) { if (ticket === epoch) { error.value = cause instanceof Error ? cause.message : '账单读取失败。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; } }
  finally { if (ticket === epoch) busy.value = false; }
}
onMounted(() => { void load(); }); onBeforeUnmount(() => { epoch++; });
</script>

<template>
  <section><h1>账单明细</h1>
    <form class="filters" @submit.prevent="load()"><label>类型<select v-model="filter"><option value="">全部</option><option value="consumption">模型消费</option><option value="grant">管理员授额</option><option value="adjustment">余额调整</option></select></label><label>请求 ID（可选）<input v-model="requestFilter" maxlength="128" /></label><button type="submit" :disabled="busy">查询 / 刷新</button></form>
    <p v-if="busy" role="status">正在读取账单…</p><p v-if="error" role="alert">{{ error }} <small v-if="requestId">请求编号：{{ requestId }}</small><button type="button" @click="load()">重试</button></p><p class="empty-state" v-if="!busy && !error && page?.items.length === 0">暂无账单记录。</p>
    <div v-if="page?.items.length" class="table-scroll"><table><caption>个人账单</caption><thead><tr><th>类型</th><th>金额变化</th><th>请求</th><th>原因</th><th>时间</th></tr></thead><tbody><tr v-for="entry in page.items" :key="entry.id"><td>{{ labels[entry.kind] }}</td><td><strong>{{ money(entry.deltaUnits) }}</strong></td><td>{{ entry.requestId ?? '—' }}</td><td>{{ entry.reason ?? (entry.kind === 'consumption' ? '模型消费' : '—') }}</td><td>{{ new Date(entry.createdAt).toLocaleString() }}</td></tr></tbody></table></div>
    <button v-if="page?.nextCursor" type="button" :disabled="busy" @click="load(true)">加载更多</button>
  </section>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin: 20px 0; }label { display: grid; gap: 7px; }input,select { padding: 9px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }.table-scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: white; }th,td { padding: 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }caption { text-align: left; padding-bottom: 12px; }small { color: var(--muted); }button { margin: 8px 8px 8px 0; }
</style>
