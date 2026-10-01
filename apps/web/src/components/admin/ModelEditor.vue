<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiClientError } from '../../api/client.js';
import { builtinModel } from '../../../../../packages/model-catalog/index';
import { adminModelsApi, BILLABLE_BUCKETS } from '../../api/admin-models.js';
import type { ModelInput, ModelPatch, ModelView } from '../../api/admin-models.js';

const props = defineProps<{ item: ModelView | null }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const busy = ref(false); const locked = ref(false); const message = ref(''); let alive = true;
const publicModelId = ref(''); const status = ref<'active' | 'disabled'>('active'); const admission = ref('0'); const maxOutput = ref(4096);
const prices = ref<Record<string, string>>({ input: '', output: '' });
const editing = computed(() => props.item !== null);
const reference = computed(() => builtinModel(publicModelId.value));
function populate() { const item = props.item; publicModelId.value = item?.publicModelId ?? ''; status.value = item?.status ?? 'active'; admission.value = item?.admissionMinBalanceUnits ?? '0'; maxOutput.value = item?.maxOutputTokens ?? 4096; prices.value = Object.fromEntries(BILLABLE_BUCKETS.map(bucket => [bucket, item?.sellPrices[bucket] ?? ''])); message.value = ''; locked.value = false; }
function close() { if (!busy.value) { emit('close'); } }
async function show() { await nextTick(); if (dialog.value && !dialog.value.open) dialog.value.showModal(); }
function setPrice(bucket: string, value: string) { prices.value = { ...prices.value, [bucket]: value }; }
function buildPrices(): Readonly<Record<string, string>> | null {
  const value: Record<string, string> = {};
  for (const bucket of BILLABLE_BUCKETS) { const raw = prices.value[bucket]?.trim() ?? ''; if (!raw) { if (bucket === 'input' || bucket === 'output') return null; continue; } if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u.test(raw) || raw.length > 18) return null; value[bucket] = raw; }
  return value;
}
async function save() {
  if (busy.value || locked.value) return;
  const sellPrices = buildPrices();
  if (!publicModelId.value.trim() || !sellPrices || !/^(?:0|[1-9][0-9]*)$/u.test(admission.value.trim()) || !Number.isSafeInteger(maxOutput.value) || maxOutput.value < 1) { message.value = '请填写公开模型 ID、非负整数准入余额、完整输入/输出单价和有效输出上限。'; return; }
  busy.value = true; message.value = '';
  const input: ModelInput = { publicModelId: publicModelId.value.trim(), status: status.value, sellPrices, admissionMinBalanceUnits: admission.value.trim(), maxOutputTokens: maxOutput.value };
  try { if (props.item) { const patch: ModelPatch = { status: status.value, sellPrices: input.sellPrices, admissionMinBalanceUnits: input.admissionMinBalanceUnits, maxOutputTokens: input.maxOutputTokens }; await adminModelsApi.update(props.item.publicModelId, props.item.priceVersion, patch); } else await adminModelsApi.create({ ...input }); if (alive) { locked.value = true; message.value = editing.value ? '模型价格设置已保存。' : '模型已创建。'; emit('saved'); } }
  catch (error) { if (alive) { locked.value = true; message.value = error instanceof ApiClientError && error.status === 409 ? '模型价格版本已变化，请返回列表重新读取后核对，不能覆盖其他修改。' : '保存结果未确认，请返回列表核对；本页不会自动重试。'; } }
  finally { if (alive) busy.value = false; }
}
onMounted(() => { populate(); void show(); }); onBeforeUnmount(() => { alive = false; });
</script>

<template>
  <dialog ref="dialog" aria-labelledby="model-editor-title" @cancel.prevent="close"><h2 id="model-editor-title">{{ editing ? '编辑公开模型' : '创建公开模型' }}</h2><p v-if="message" role="status">{{ message }}</p>
    <details v-if="reference"><summary>官方元信息 · {{ reference.provider }}</summary><p>上下文 {{ reference.contextWindow.toLocaleString() }} Token · 最大输出 {{ reference.maxOutputTokens.toLocaleString() }} Token</p><p>{{ reference.pricingNote }}</p><a :href="reference.source" target="_blank" rel="noopener noreferrer">官方资料 · 2026-09-10 核对</a></details>
    <form id="model-edit-form" @submit.prevent="save"><fieldset :disabled="busy || locked"><label v-if="!editing">公开模型 ID<input v-model="publicModelId" maxlength="128" required autocomplete="off" /></label><p v-else><strong>{{ publicModelId }}</strong></p><label>状态<select v-model="status"><option value="active">启用</option><option value="disabled">停用</option></select></label><label>准入最低余额（USD 最小单位）<input v-model="admission" maxlength="17" inputmode="numeric" required autocomplete="off" /></label><label>最大输出 Token<input v-model.number="maxOutput" type="number" min="1" step="1" required /></label><h3>销售单价（USD / 百万 Token）</h3><label v-for="bucket in BILLABLE_BUCKETS" :key="bucket">{{ bucket }}<input :value="prices[bucket]" :required="bucket === 'input' || bucket === 'output'" maxlength="18" inputmode="decimal" autocomplete="off" @input="setPrice(bucket, ($event.target as HTMLInputElement).value)" /></label></fieldset></form><div class="dialog-actions"><button type="button" :disabled="busy" @click="close">关闭</button><button type="submit" form="model-edit-form" :disabled="busy || locked">{{ busy ? '正在保存…' : '保存模型' }}</button></div>
  </dialog>
</template>

<style scoped>
dialog { width: min(94vw, 560px); max-height: 92svh; overflow: auto; padding: 28px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 7px; margin: 14px 0; }input,select { width: 100%; padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }h3 { margin-top: 24px; }button { margin: 8px 8px 0 0; }
</style>
