<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiClientError } from '../../api/client.js';
import { adminBillingApi } from '../../api/admin-billing.js';
import type { AdjustmentKind, BalanceAdjustmentInput } from '../../api/admin-billing.js';
import { formatUnitsToUsd, isCanonicalUnits } from '../../api/billing.js';

const props = defineProps<{ userId: string; email: string; balanceUnits: string }>();
const emit = defineEmits<{ close: []; adjusted: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const kind = ref<AdjustmentKind>('grant'); const deltaUnits = ref(''); const reason = ref(''); const requestId = ref('');
const busy = ref(false); const message = ref(''); const settled = ref(false); const canEdit = ref(false); let alive = true;
const intent = ref<{ operationId: string; input: BalanceAdjustmentInput } | null>(null);
function reset() { intent.value = null; settled.value = false; message.value = ''; canEdit.value = false; }
function close() { if (!busy.value) { intent.value = null; deltaUnits.value = ''; reason.value = ''; requestId.value = ''; emit('close'); } }
async function show() { await nextTick(); if (dialog.value && !dialog.value.open) dialog.value.showModal(); }
function displayAmount(value: string) { try { return formatUnitsToUsd(value); } catch { return '金额无效'; } }
async function submit() {
  if (busy.value || settled.value) return;
  if (!intent.value) {
    const raw = deltaUnits.value.trim();
    if (!isCanonicalUnits(raw) || !reason.value.trim() || reason.value.trim().length > 4096) { message.value = '请输入规范整数金额和调整原因。金额使用 USD 最小单位，不要填写小数。'; return; }
    try { if (kind.value === 'grant' && BigInt(raw) <= 0n) { message.value = '授额金额必须为正数。'; return; } } catch { message.value = '金额不是有效整数。'; return; }
    intent.value = { operationId: crypto.randomUUID(), input: { kind: kind.value, deltaUnits: raw, reason: reason.value.trim(), ...(requestId.value.trim() ? { requestId: requestId.value.trim() } : {}) } };
  }
  busy.value = true; message.value = ''; canEdit.value = false;
  try { const result = await adminBillingApi.adjust(props.userId, intent.value.input, intent.value.operationId); if (!alive) return; settled.value = true; message.value = result.outcome === 'existing' ? '已确认此前同一幂等操作的结果。' : '余额调整已写入。'; emit('adjusted'); }
  catch (error) {
    if (!alive) return;
    const definitive = error instanceof ApiClientError && error.status !== null && error.status >= 400 && error.status < 500;
    canEdit.value = definitive;
    message.value = definitive ? (error as Error).message : '提交结果暂时无法确认。可使用同一参数和幂等键重试；不要新建另一笔调整。';
  } finally { if (alive) busy.value = false; }
}
onMounted(() => { void show(); }); onBeforeUnmount(() => { alive = false; intent.value = null; deltaUnits.value = ''; reason.value = ''; requestId.value = ''; });
</script>

<template>
  <dialog ref="dialog" aria-labelledby="balance-adjustment-title" @cancel.prevent="close"><h2 id="balance-adjustment-title">调整账户余额</h2><p>{{ email }} · 当前余额 {{ displayAmount(balanceUnits) }} USD</p><p v-if="message" role="status">{{ message }}</p>
    <template v-if="!settled"><form id="balance-edit-form" @submit.prevent="submit"><fieldset :disabled="busy || intent !== null"><label>操作类型<select v-model="kind"><option value="grant">授额（正数）</option><option value="adjustment">调整（可正可负）</option></select></label><label>金额（USD 最小单位）<input v-model="deltaUnits" inputmode="numeric" maxlength="128" required autocomplete="off" placeholder="例如 100000000" /><small>预览：{{ deltaUnits ? displayAmount(deltaUnits) + ' USD' : '—' }}</small></label><label>原因<textarea v-model="reason" rows="3" maxlength="4096" required autocomplete="off" /></label><label>关联请求 ID（可选）<input v-model="requestId" maxlength="128" autocomplete="off" /></label></fieldset></form></template>
    <div class="dialog-actions"><button v-if="canEdit" type="button" @click="reset">修改参数</button><button type="button" :disabled="busy" @click="close">关闭</button><button v-if="!settled" type="submit" form="balance-edit-form" :disabled="busy">{{ busy ? '正在提交…' : intent ? '重试同一调整' : '提交调整' }}</button></div>
  </dialog>
</template>

<style scoped>
dialog { width: min(94vw, 540px); padding: 28px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 7px; margin: 15px 0; }input,select,textarea { width: 100%; padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }small { color: var(--muted); }button { margin: 8px 8px 0 0; }
</style>
