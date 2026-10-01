<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { adminRegistrationApi } from '../../api/admin-registration.js';
import { ApiClientError } from '../../api/client.js';
const props = defineProps<{ open: boolean }>(); const emit = defineEmits<{ close: []; created: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const quantity = ref(1); const expires = ref('');
const busy = ref(false); const settled = ref(false); const message = ref(''); const secrets = ref(''); const canEdit = ref(false);
const intent = ref<{ operationId: string; quantity: number; expiresAt: number } | null>(null); let alive = true;
function reset() { intent.value = null; settled.value = false; secrets.value = ''; message.value = ''; canEdit.value = false; }
function defaultExpiry() { const date = new Date(Date.now() + 7 * 86_400_000); expires.value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
async function show() { await nextTick(); if (props.open && !dialog.value?.open) dialog.value?.showModal(); }
watch(() => props.open, open => { if (open) { if (settled.value) reset(); if (!intent.value) defaultExpiry(); void show(); } else { dialog.value?.close(); secrets.value = ''; } });
onMounted(() => { defaultExpiry(); void show(); }); onBeforeUnmount(() => { alive = false; secrets.value = ''; });
function close() { if (!busy.value) { secrets.value = ''; emit('close'); } }
async function copy() {
  try { await navigator.clipboard.writeText(secrets.value); message.value = '已复制本次注册码，请安全分发。关闭后无法再次显示。'; }
  catch { message.value = '复制失败，请手动选择并复制。关闭后无法再次显示。'; }
}
async function submit() {
  if (busy.value || settled.value) return;
  if (!intent.value) {
    const expiresAt = new Date(expires.value).getTime();
    if (!Number.isSafeInteger(quantity.value) || quantity.value < 1 || quantity.value > 100 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 86_400_000) { message.value = '数量须为 1–100，到期时间须在未来 30 天内。'; return; }
    intent.value = { operationId: crypto.randomUUID(), quantity: quantity.value, expiresAt };
  }
  busy.value = true; message.value = ''; canEdit.value = false;
  try {
    const result = await adminRegistrationApi.createCodes({ quantity: intent.value.quantity, expiresAt: intent.value.expiresAt }, intent.value.operationId);
    if (!alive) return; settled.value = true;
    if (result.replayed) message.value = `已确认原批次 ${result.batchId}，共 ${result.codes.length} 个注册码。重放不返回明文，原期限不变；过期码仍无效。如未保存，请撤销可用码后另建批次。`;
    else { secrets.value = result.codes.map(code => code.token).join('\n'); message.value = `已生成 ${result.codes.length} 个注册码，仅本次显示明文。请立即保存。`; }
    emit('created');
  } catch (error) {
    if (!alive) return;
    canEdit.value = error instanceof ApiClientError && (error.status === 400 || error.status === 403);
    message.value = canEdit.value ? (error as Error).message : '生成结果未确认。重试将沿用同一批次意图、数量和绝对到期时间。请勿刷新；关闭后可在本页重新打开继续确认。';
  } finally { if (alive) busy.value = false; }
}
</script>
<template>
  <dialog ref="dialog" aria-labelledby="create-codes-title" @cancel.prevent="close"><h2 id="create-codes-title">生成注册邀请码</h2><p v-if="message" role="status">{{ message }}</p>
    <template v-if="secrets"><label for="generated-codes">注册码明文（仅本次显示）</label><textarea id="generated-codes" :value="secrets" readonly autocomplete="off" spellcheck="false" rows="7" /></template>
    <form id="invite-create-form" v-if="!settled" @submit.prevent="submit"><fieldset :disabled="busy || intent !== null"><label>数量<input v-model.number="quantity" type="number" required min="1" max="100" step="1" /></label><label>到期时间<input v-model="expires" type="datetime-local" required /></label><p>有效期最多 30 天，不能设置永久有效。</p></fieldset></form>
    <div class="dialog-actions"><button v-if="canEdit" type="button" @click="reset">修改参数</button><button v-if="secrets" type="button" @click="copy">复制注册码</button><button type="button" :disabled="busy" @click="close">{{ secrets ? '已保存，关闭明文' : '关闭' }}</button><button v-if="!settled" type="submit" form="invite-create-form" :disabled="busy">{{ busy ? '正在确认…' : intent ? '重试确认同一批次' : '生成注册码' }}</button></div>
  </dialog>
</template>
<style scoped>
dialog { width: min(94vw, 560px); padding: 28px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }label { display: grid; gap: 8px; margin: 16px 0; }input,textarea { width: 100%; padding: 10px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }textarea { white-space: pre; overflow-x: auto; font-family: monospace; }button { margin: 8px 8px 0 0; }
</style>
