<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { accountApi } from '../api/account.js';
import type { AccountBalance } from '../api/account.js';
import { ApiClientError } from '../api/client.js';
import { requestsApi } from '../api/requests.js';
import type { RequestRecord } from '../api/requests.js';
import { formatUnitsToUsd } from '../api/billing.js';
const balance = ref<AccountBalance | null>(null); const loading = ref(false); const error = ref('');
const requestId = ref<string | null>(null); let epoch = 0; let alive = true;
const recent = ref<readonly RequestRecord[]>([]); const recentLoading = ref(true); const recentError = ref('');
const statusLabels: Record<string,string> = {admitted:'处理中',succeeded:'成功',failed:'失败',cancelled:'已取消',abandoned:'已中断'};
async function refresh() {
  const ticket = ++epoch; loading.value = true; error.value = ''; requestId.value = null; balance.value = null;
  try { const result = await accountApi.balance(); if (ticket === epoch) balance.value = result; }
  catch (cause) { if (ticket === epoch) { error.value = cause instanceof Error ? cause.message : '无法读取余额。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; } }
  finally { if (ticket === epoch) loading.value = false; }
}
async function loadRecent() {
  recentLoading.value = true; recentError.value = '';
  try { const result = await requestsApi.list({}); if (alive) recent.value = result.items.slice(0,5); }
  catch (cause) { if (alive) recentError.value = cause instanceof Error ? cause.message : '请求记录读取失败。'; }
  finally { if (alive) recentLoading.value = false; }
}
onMounted(() => { void refresh(); void loadRecent(); }); onBeforeUnmount(() => { epoch++; alive = false; });
</script>
<template>
  <section class="dashboard">
    <div class="page-heading"><h1>账户概览</h1><RouterLink to="/keys" class="button primary">管理 API Keys <span aria-hidden="true">↗</span></RouterLink></div>
    <div class="overview-grid">
      <div class="balance-panel" aria-labelledby="balance-heading"><div class="balance-title"><h2 id="balance-heading">当前余额</h2><button type="button" :disabled="loading" @click="refresh" aria-label="刷新余额"><span aria-hidden="true">↻</span></button></div>
        <p v-if="loading" role="status">正在读取当前余额…</p>
        <div v-else-if="error" role="alert"><p>{{ error }}</p><small v-if="requestId">请求编号：{{ requestId }}</small></div>
        <template v-else-if="balance"><p class="amount" :class="{ 'long-amount': balance.balance_usd.split('.')[0]!.length > 5 }">{{ balance.balance_usd.split('.')[0] }}<span class="fraction">.{{ balance.balance_usd.split('.')[1] }}</span><span class="currency">USD</span></p><p v-if="balance.balance_units.startsWith('-')" class="balance-negative">余额不足，请联系管理员充值。</p><RouterLink to="/billing" class="ledger-link">查看账单 <span aria-hidden="true">→</span></RouterLink></template>
      </div>
      <nav class="dashboard-links" aria-label="账户操作"><RouterLink to="/keys"><span>API Keys</span><span aria-hidden="true">↗</span></RouterLink><RouterLink to="/requests"><span>请求记录</span><span aria-hidden="true">↗</span></RouterLink><RouterLink to="/billing"><span>账单明细</span><span aria-hidden="true">↗</span></RouterLink></nav>
    </div>
    <section class="recent-section"><div class="section-heading"><h2>最近请求</h2><RouterLink to="/requests">全部请求 <span aria-hidden="true">↗</span></RouterLink></div>
      <p v-if="recentLoading" role="status">正在读取请求…</p><p v-else-if="recentError" role="alert">{{ recentError }} <button type="button" @click="loadRecent">重试</button></p>
      <div v-else-if="!recent.length" class="request-empty"><div class="empty-glyph" aria-hidden="true"><span/><span/><span/></div><h3>还没有请求记录</h3><p>用 API Key 发起首次调用后，记录会出现在这里。</p><RouterLink to="/keys">前往 API Keys <span aria-hidden="true">→</span></RouterLink></div>
      <div v-else class="table-scroll"><table><caption>最近五条请求</caption><thead><tr><th>模型</th><th>状态</th><th>费用 / USD</th><th>时间</th></tr></thead><tbody><tr v-for="item in recent" :key="item.id"><td><RouterLink :to="`/requests/${item.id}`">{{ item.public_model_id }}</RouterLink></td><td>{{ statusLabels[item.execution_status] }}</td><td>{{ item.cost_units === null ? '待确认' : formatUnitsToUsd(item.cost_units) }}</td><td>{{ new Date(item.created_at).toLocaleString() }}</td></tr></tbody></table></div>
    </section>
  </section>
</template>
<style scoped>
.dashboard-links{display:flex;flex-direction:column;border-left:1px solid var(--line);padding:20px 30px;justify-content:center}.dashboard-links>a{display:flex;align-items:center;justify-content:space-between;padding:22px 0;text-decoration:none;font-size:17px;border-bottom:1px solid var(--line)}.dashboard-links>a:last-child{border-bottom:0}.dashboard-links>a>span:last-child{color:var(--accent)}
@media(max-width:1100px){.dashboard-links{border-left:0;border-top:1px solid var(--line)}}

.overview-grid{display:grid;grid-template-columns:1.05fr 1fr;border:1px solid var(--line);background:var(--surface)}.balance-panel{padding:28px 32px;display:flex;flex-direction:column;min-width:0}.balance-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.balance-title h2{font-size:14px;font-weight:500;margin:0;color:var(--muted)}.balance-title button{padding:0;border:0;min-height:30px;width:30px;font-size:23px;background:none;color:var(--muted)}.amount{font-family:var(--mono);font-size:62px;line-height:1.2;font-weight:400;letter-spacing:-3px;margin:10px 0 30px;font-variant-numeric:tabular-nums;white-space:nowrap}.amount .fraction{font-size:27px;letter-spacing:-1px;color:#999b90}.amount .currency{font-size:12px;letter-spacing:0;color:var(--muted);margin-left:14px}.ledger-link{font-size:13px;margin-top:auto;align-self:flex-start;text-decoration:none;display:flex;gap:32px}.balance-negative{font-size:13px;color:var(--danger)}.endpoint-panel{border-left:1px solid var(--line);padding:28px 30px}.endpoint-panel h2{font-size:14px;margin-bottom:14px}.endpoint-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:13px 0;border-bottom:1px solid var(--line)}.endpoint-row:last-of-type{border:0;padding-bottom:0}.endpoint-name{display:block;font-size:12px;margin-bottom:4px}.endpoint-row code{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.endpoint-row button{min-height:28px;font-size:11px;padding:4px 9px;flex-shrink:0}.recent-section{margin-top:40px}.section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.section-heading h2{margin:0;font-size:18px}.section-heading>a{font-size:12px;text-decoration:none}.request-empty{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:48px 20px;text-align:center}.empty-glyph{width:48px;margin:0 auto 22px;display:grid;gap:6px}.empty-glyph>span{height:1px;background:#c4c6ba}.empty-glyph>span:nth-child(2){width:65%;background:var(--accent)}.request-empty h3{font-size:16px;margin-bottom:10px}.request-empty p{color:var(--muted);font-size:13px}.request-empty>a{font-size:12px;text-decoration:none}.recent-section .table-scroll{margin:0}
.amount.long-amount{font-size:40px}.amount.long-amount .fraction{font-size:20px}
@media(max-width:1100px){.overview-grid{grid-template-columns:1fr}.endpoint-panel{border-left:0;border-top:1px solid var(--line)}.endpoint-row{padding:10px 0}.balance-panel{min-height:230px}.endpoint-panel{padding:24px 32px}.balance-title{margin-bottom:0}}
@media(max-width:600px){.page-heading .button{font-size:11px;padding:9px}.balance-panel,.endpoint-panel{padding:24px}.amount{font-size:48px}.amount.long-amount{font-size:30px}.amount.long-amount .fraction{font-size:16px}.amount .fraction{font-size:22px}.amount .currency{font-size:10px;margin-left:8px}.page-heading h1{font-size:27px}.request-empty{padding:35px 10px}}
</style>
