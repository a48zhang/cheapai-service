<script setup lang="ts">
import { ref } from 'vue';
import type { BillingStatus, ExecutionStatus, RequestQuery } from '../api/requests.js';

export interface RequestFilterValue extends RequestQuery { readonly userId?: string }
const props = withDefaults(defineProps<{ admin?: boolean }>(), { admin: false });
const emit = defineEmits<{ submit: [value: RequestFilterValue] }>();
const status = ref<'' | ExecutionStatus>('');
const billingStatus = ref<'' | BillingStatus>('');
const model = ref(''); const userId = ref(''); const from = ref(''); const to = ref('');
const message = ref('');

function timestamp(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function submit() {
  message.value = '';
  const fromValue = timestamp(from.value); const toValue = timestamp(to.value);
  if ((from.value && fromValue === undefined) || (to.value && toValue === undefined)) { message.value = '请输入有效的时间范围。'; return; }
  if (fromValue !== undefined && toValue !== undefined && fromValue > toValue) { message.value = '开始时间不能晚于结束时间。'; return; }
  emit('submit', { ...(status.value ? { status: status.value } : {}), ...(billingStatus.value ? { billingStatus: billingStatus.value } : {}),
    ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(props.admin && userId.value.trim() ? { userId: userId.value.trim() } : {}),
    ...(fromValue === undefined ? {} : { from: fromValue }), ...(toValue === undefined ? {} : { to: toValue }) });
}
function reset() { status.value = ''; billingStatus.value = ''; model.value = ''; userId.value = ''; from.value = ''; to.value = ''; message.value = ''; submit(); }
</script>

<template>
  <form class="filters" aria-label="请求筛选" @submit.prevent="submit">
    <label>执行状态<select v-model="status"><option value="">全部状态</option><option value="admitted">已接收</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="cancelled">已取消</option><option value="abandoned">已放弃</option></select></label>
    <label>计费状态<select v-model="billingStatus"><option value="">全部计费状态</option><option value="awaiting_usage">等待用量</option><option value="settled">已结算</option><option value="not_chargeable">不计费</option><option value="settlement_pending">待结算</option><option value="usage_unknown">用量未知</option></select></label>
    <label>公开模型<input v-model="model" maxlength="128" autocomplete="off" /></label>
    <label v-if="admin">用户 ID<input v-model="userId" maxlength="128" autocomplete="off" /></label>
    <label>开始时间<input v-model="from" type="datetime-local" /></label>
    <label>结束时间<input v-model="to" type="datetime-local" /></label>
    <button type="submit">查询</button><button type="button" class="secondary" @click="reset">清空筛选</button>
    <p v-if="message" class="form-message" role="alert">{{ message }}</p>
  </form>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin: 20px 0; }
label { display: grid; gap: 7px; min-width: 140px; font-size: 13px; }input,select { min-width: 0; padding: 9px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }button { margin: 0; }.secondary { background: #fff; color: var(--ink); }.form-message { flex-basis: 100%; color: var(--danger); margin: 0; }
</style>
