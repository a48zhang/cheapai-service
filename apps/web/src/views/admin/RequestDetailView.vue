<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ApiClientError } from '../../api/client.js';
import { formatUnitsToUsd } from '../../api/billing.js';
import { adminRequestsApi } from '../../api/admin-requests.js';
import type { RequestRecord } from '../../api/requests.js';

const route = useRoute(); const request = ref<RequestRecord | null>(null); const busy = ref(false); const retrying = ref(false); const error = ref(''); const message = ref(''); const requestId = ref<string | null>(null); let alive = true;
const labels: Record<string, string> = { admitted: '已接收', succeeded: '成功', failed: '失败', cancelled: '已取消', abandoned: '已放弃', awaiting_usage: '等待用量', settled: '已结算', not_chargeable: '不计费', settlement_pending: '待结算', usage_unknown: '用量未知' };
const showTime = (value: number | null) => value === null ? '—' : new Date(value).toLocaleString();
const sourceLabel = (value: RequestRecord['source']) => value === 'web_chat' ? '网页聊天' : 'API 请求';
const json = (value: unknown) => JSON.stringify(value, null, 2);
const cost = (value: string | null) => { if (value === null) return '费用未知'; try { return `${formatUnitsToUsd(value)} USD`; } catch { return '费用未知'; } };
const retryEligible = computed(() => { const item = request.value; return item !== null && item.billing_status === 'settlement_pending' && item.usage_valid === true && item.usage?.quality === 'complete' && item.price_snapshot_valid && item.cost_units !== null; });
async function load() { busy.value = true; error.value = ''; message.value = ''; requestId.value = null; try { const item = await adminRequestsApi.get(String(route.params.id ?? '')); if (alive) request.value = item; } catch (cause) { if (alive) { error.value = cause instanceof Error ? cause.message : '管理请求详情读取失败。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; } } finally { if (alive) busy.value = false; } }
async function retrySettlement() { const item = request.value; if (!item || !retryEligible.value || retrying.value) return; retrying.value = true; message.value = ''; try { const result = await adminRequestsApi.retrySettlement(item.id); const outcome = result.status === 'already_settled' ? '该请求此前已结算。' : '结算重试已完成。'; if (alive) { await load(); if (alive) message.value = outcome; } } catch (cause) { if (alive) message.value = cause instanceof ApiClientError && cause.status === 409 ? '结算证据已变化，未执行覆盖。请重新读取详情。' : '结算结果未确认，请重新读取详情；不会自动再次提交。'; } finally { if (alive) retrying.value = false; } }
onMounted(() => { void load(); }); onBeforeUnmount(() => { alive = false; });
</script>

<template>
  <section><h1>请求证据</h1><p><RouterLink to="/admin/requests">返回全局请求</RouterLink></p><p v-if="busy" role="status">正在读取详情…</p><p v-if="error" role="alert">{{ error }} <small v-if="requestId">请求编号：{{ requestId }}</small><button type="button" @click="load()">重试读取</button></p><p v-if="message" role="status">{{ message }}</p>
    <template v-if="request"><div class="panel"><h2>请求身份</h2><dl><dt>request_id</dt><dd><code>{{ request.id }}</code></dd><dt>用户</dt><dd>{{ request.user_id }}</dd><dt>来源</dt><dd>{{ sourceLabel(request.source) }}</dd><dt>分组</dt><dd>{{ request.group_id ?? '未知' }}</dd><dt>API Key</dt><dd>{{ request.api_key_id }}</dd><dt>渠道</dt><dd>{{ request.channel_id }}</dd><dt>模型 / 协议</dt><dd>{{ request.public_model_id }} · {{ request.upstream_model }} · {{ request.downstream_protocol }} → {{ request.upstream_protocol }}</dd><dt>执行状态</dt><dd>{{ labels[request.execution_status] }}</dd><dt>计费状态</dt><dd>{{ labels[request.billing_status] }}</dd><dt>创建 / 开始 / 完成</dt><dd>{{ showTime(request.created_at) }} / {{ showTime(request.started_at) }} / {{ showTime(request.finished_at) }}</dd><dt>重试计数 / 下次重试</dt><dd>{{ request.retry_count }} / {{ showTime(request.next_retry_at) }}</dd></dl></div>
      <div class="panel"><h2>用量与价格证据</h2><p v-if="request.usage_valid !== true || request.usage === null" class="warning">用量未知或无效，不足以进行安全结算重试。</p><template v-else><p>质量：{{ request.usage.quality }}</p><pre>{{ json(request.usage) }}</pre></template><p>成本：{{ cost(request.cost_units) }}</p><p>价格快照：{{ request.price_snapshot_valid ? '有效' : '无效或不可用' }}</p><pre v-if="request.price_snapshot_valid && request.price_snapshot">{{ json(request.price_snapshot) }}</pre></div>
      <div v-if="request.error" class="panel"><h2>错误摘要</h2><p>{{ request.error.code }}：{{ request.error.message }}</p></div>
      <div class="panel"><h2>安全结算操作</h2><p v-if="retryEligible">当前具备待结算、完整用量、有效价格和成本证据，才允许执行一次安全重试。服务端会再次校验证据。</p><p v-else>只有待结算且具备完整用量、有效价格和成本证据时才允许重试。</p><button type="button" :disabled="retrying || !retryEligible" @click="retrySettlement">{{ retrying ? '正在结算…' : '重试结算' }}</button><RouterLink class="link-button" :to="`/admin/billing?requestId=${encodeURIComponent(request.id)}`">查看相关账单</RouterLink></div>
    </template>
  </section>
</template>

<style scoped>
.panel { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 22px; margin: 18px 0; }dl { display: grid; grid-template-columns: minmax(140px, 240px) 1fr; gap: 10px 18px; }dt { color: var(--muted); }dd { margin: 0; overflow-wrap: anywhere; }pre { padding: 14px; background: var(--paper); border-radius: 5px; overflow: auto; max-height: 360px; white-space: pre-wrap; overflow-wrap: anywhere; }.warning { color: var(--danger); }small { color: var(--muted); }button,.link-button { margin: 8px 8px 0 0; }.link-button { display: inline-block; padding: 9px 15px; border: 1px solid var(--ink); border-radius: 6px; color: var(--ink); text-decoration: none; }
</style>
