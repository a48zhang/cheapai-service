<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ApiClientError } from '../api/client.js';
import { requestsApi } from '../api/requests.js';
import type { BillingStatus, ExecutionStatus, RequestPage, RequestQuery, RequestRecord } from '../api/requests.js';
import RequestFilters from '../components/RequestFilters.vue';
import type { RequestFilterValue } from '../components/RequestFilters.vue';
import { formatUnitsToUsd } from '../api/billing.js';

const page = ref<RequestPage | null>(null); const filters = ref<RequestQuery>({}); const busy = ref(false); const error = ref(''); const requestId = ref<string | null>(null); let epoch = 0;
const executionLabels: Record<ExecutionStatus, string> = { admitted: '已接收', succeeded: '成功', failed: '失败', cancelled: '已取消', abandoned: '已放弃' };
const billingLabels: Record<BillingStatus, string> = { awaiting_usage: '等待用量', settled: '已结算', not_chargeable: '不计费', settlement_pending: '待结算', usage_unknown: '用量未知' };
const time = (value: number | null) => value === null ? '—' : new Date(value).toLocaleString();
const sourceLabel = (item: RequestRecord) => item.source === 'web_chat' ? '网页聊天' : 'API 请求';
function usageText(item: RequestRecord) {
  if (item.usage_valid !== true || item.usage === null) return '用量未知';
  if (item.usage.quality === 'missing') return '用量缺失';
  const counts = item.usage.counts ?? {};
  const input = counts.inputTokens === undefined ? '?' : String(counts.inputTokens);
  const output = counts.outputTokens === undefined ? '?' : String(counts.outputTokens);
  return `${item.usage.quality} · 输入 ${input} / 输出 ${output}`;
}
function costText(item: RequestRecord) {
  if (item.cost_units === null) return '费用未知';
  try { return `${formatUnitsToUsd(item.cost_units)} USD`; } catch { return '费用未知'; }
}
async function load(more = false) {
  const ticket = ++epoch; busy.value = true; error.value = ''; requestId.value = null;
  try {
    const options: RequestQuery = more ? { ...filters.value, cursor: page.value?.nextCursor ?? null } : { ...filters.value, cursor: null };
    const result = await requestsApi.list(options);
    if (ticket === epoch) page.value = more && page.value ? { ...result, items: [...page.value.items, ...result.items] } : result;
  } catch (cause) {
    if (ticket === epoch) { error.value = cause instanceof Error ? cause.message : '请求列表读取失败。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; }
  } finally { if (ticket === epoch) busy.value = false; }
}
function apply(value: RequestFilterValue) { filters.value = value; void load(); }
onMounted(() => { void load(); }); onBeforeUnmount(() => { epoch++; });
</script>

<template>
  <section><h1>我的请求</h1>
    <RequestFilters @submit="apply" />
    <p v-if="busy" role="status">正在读取请求…</p><p v-if="error" role="alert">{{ error }} <small v-if="requestId">请求编号：{{ requestId }}</small><button type="button" @click="load()">重试</button></p>
    <p class="empty-state" v-if="!busy && !error && page?.items.length === 0">暂无请求记录。</p>
    <div v-if="page?.items.length" class="table-scroll"><table><caption>请求列表</caption><thead><tr><th>请求 / 模型</th><th>来源 / 分组</th><th>执行</th><th>计费</th><th>用量</th><th>费用</th><th>创建时间</th></tr></thead>
      <tbody><tr v-for="item in page.items" :key="item.id"><td><RouterLink :to="`/requests/${encodeURIComponent(item.id)}`"><code>{{ item.id }}</code></RouterLink><br />{{ item.public_model_id }}<br /><small>{{ item.downstream_protocol }} → {{ item.upstream_protocol }} · {{ item.upstream_model }}</small></td><td><strong>{{ sourceLabel(item) }}</strong><br /><small>分组：{{ item.group_id ?? '未知' }}</small></td><td>{{ executionLabels[item.execution_status] }}</td><td>{{ billingLabels[item.billing_status] }}</td><td>{{ usageText(item) }}</td><td>{{ costText(item) }}</td><td>{{ time(item.created_at) }}</td></tr></tbody>
    </table></div>
    <button v-if="page?.nextCursor" type="button" :disabled="busy" @click="load(true)">加载更多</button>
  </section>
</template>

<style scoped>
.table-scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: #fff; }th,td { text-align: left; vertical-align: top; padding: 14px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }caption { text-align: left; padding-bottom: 12px; }small { color: var(--muted); }button { margin: 8px 8px 8px 0; }
</style>
