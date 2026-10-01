<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ApiClientError } from '../api/client.js';
import { formatUnitsToUsd } from '../api/billing.js';
import { requestsApi } from '../api/requests.js';
import type { RequestRecord } from '../api/requests.js';

const route = useRoute(); const request = ref<RequestRecord | null>(null); const busy = ref(false); const error = ref(''); const requestId = ref<string | null>(null); let alive = true;
const labels: Record<string, string> = { admitted: '已接收', succeeded: '成功', failed: '失败', cancelled: '已取消', abandoned: '已放弃', awaiting_usage: '等待用量', settled: '已结算', not_chargeable: '不计费', settlement_pending: '待结算', usage_unknown: '用量未知' };
const showTime = (value: number | null) => value === null ? '—' : new Date(value).toLocaleString();
const sourceLabel = (value: RequestRecord['source']) => value === 'web_chat' ? '网页聊天' : 'API 请求';
const json = (value: unknown) => JSON.stringify(value, null, 2);
function cost(value: string | null) { if (value === null) return '费用未知'; try { return `${formatUnitsToUsd(value)} USD`; } catch { return '费用未知'; } }
async function load() { busy.value = true; error.value = ''; requestId.value = null; const id = String(route.params.id ?? '');
  try { const item = await requestsApi.get(id); if (alive) request.value = item; }
  catch (cause) { if (alive) { error.value = cause instanceof Error ? cause.message : '请求详情读取失败。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; } }
  finally { if (alive) busy.value = false; }
}
onMounted(() => { void load(); }); onBeforeUnmount(() => { alive = false; });
</script>

<template>
  <section><h1>请求记录</h1><p><RouterLink to="/requests">返回请求列表</RouterLink></p>
    <p v-if="busy" role="status">正在读取详情…</p><p v-if="error" role="alert">{{ error }} <small v-if="requestId">请求编号：{{ requestId }}</small><button type="button" @click="load">重试</button></p>
    <template v-if="request"><div class="panel"><h2>请求身份</h2><dl><dt>内部 request_id</dt><dd><code>{{ request.id }}</code></dd><dt>来源</dt><dd>{{ sourceLabel(request.source) }}</dd><dt>分组</dt><dd>{{ request.group_id ?? '未知' }}</dd><dt>公开模型</dt><dd>{{ request.public_model_id }}</dd><dt>上游模型</dt><dd>{{ request.upstream_model }}</dd><dt>协议</dt><dd>{{ request.downstream_protocol }} → {{ request.upstream_protocol }}</dd><dt>执行状态</dt><dd>{{ labels[request.execution_status] }}</dd><dt>计费状态</dt><dd>{{ labels[request.billing_status] }}</dd><dt>创建 / 开始 / 完成</dt><dd>{{ showTime(request.created_at) }} / {{ showTime(request.started_at) }} / {{ showTime(request.finished_at) }}</dd><dt>更新</dt><dd>{{ showTime(request.updated_at) }}</dd></dl></div>
      <div class="panel"><h2>用量与计费</h2><p v-if="request.usage_valid !== true || request.usage === null">用量证据未知或无效，不能据此推断零费用。</p><template v-else><p>质量：{{ request.usage.quality }}</p><pre>{{ json(request.usage) }}</pre></template><p>费用：{{ cost(request.cost_units) }}</p><p>价格快照：{{ request.price_snapshot_valid ? '有效' : '无效或不可用' }}</p><pre v-if="request.price_snapshot_valid && request.price_snapshot">{{ json(request.price_snapshot) }}</pre></div>
      <div v-if="request.error" class="panel"><h2>安全错误摘要</h2><p>{{ request.error.code }}：{{ request.error.message }}</p></div>
      <div v-if="request.error === null && request.billing_status === 'settlement_pending'" class="panel"><p>此请求等待后台结算。管理员可在管理请求详情中核对完整证据。</p></div>
    </template>
  </section>
</template>

<style scoped>
.panel { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 22px; margin: 18px 0; }dl { display: grid; grid-template-columns: minmax(130px, 220px) 1fr; gap: 10px 18px; }dt { color: var(--muted); }dd { margin: 0; overflow-wrap: anywhere; }pre { padding: 14px; background: var(--paper); border-radius: 5px; overflow: auto; max-height: 360px; white-space: pre-wrap; overflow-wrap: anywhere; }small { color: var(--muted); }button { margin: 8px; }
</style>
