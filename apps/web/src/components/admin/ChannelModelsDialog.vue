<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { builtinModel } from '../../../../../packages/model-catalog/index';
import { adminModelsApi } from '../../api/admin-models.js';
import type { CapabilityFeature, ModelMappingView, ModelView, Protocol } from '../../api/admin-models.js';
import type { ChannelView } from '../../api/admin-channels.js';
const props = defineProps<{ channel: ChannelView }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const models = ref<ModelView[]>([]);
const modelId = ref(''); const protocol = ref<Protocol>('chat'); const upstreamModel = ref(''); const streaming = ref(true); const tools = ref(false);
const current = ref<ModelMappingView | null>(null); const loading = ref(false); const reading = ref(false); const busy = ref(false); const locked = ref(false); const message = ref(''); let alive = true; let epoch = 0;
const controlled: readonly CapabilityFeature[] = ['streaming','stream_usage','tools','tool_choice','parallel_tools','parallel_tool_control'];
async function loadModels() {
  loading.value = true;
  try { const available: ModelView[] = []; let cursor: string | null = null; do { const page = await adminModelsApi.list({ status: 'active', cursor }); if (!alive) return; available.push(...page.items); cursor = page.nextCursor; } while (cursor); models.value = available; if (!modelId.value) { const first = props.channel.models[0]; protocol.value = first?.protocol ?? 'chat'; modelId.value = first?.publicModelId ?? models.value[0]?.publicModelId ?? ''; } }
  catch (error) { if (alive) message.value = error instanceof Error ? error.message : '无法读取模型。'; }
  finally { if (alive) loading.value = false; }
}
async function loadMapping() {
  const ticket = ++epoch; current.value = null; locked.value = false; message.value = ''; if (!modelId.value) return;
  reading.value = true;
  try { const rows = await adminModelsApi.mappings(modelId.value); if (!alive || ticket !== epoch) return; current.value = rows.items.find(row => row.channelId === props.channel.id && row.protocol === protocol.value) ?? null; upstreamModel.value = current.value?.upstreamModel ?? modelId.value; streaming.value = current.value ? current.value.capabilities.features.includes('streaming') : true; tools.value = current.value?.capabilities.features.includes('tools') ?? Boolean(builtinModel(modelId.value)); }
  catch (error) { if (alive && ticket === epoch) { locked.value = true; message.value = error instanceof Error ? error.message : '无法读取映射。'; } }
  finally { if (alive && ticket === epoch) reading.value = false; }
}
watch(modelId, id => { protocol.value = props.channel.models.find(model => model.publicModelId === id)?.protocol ?? builtinModel(id)?.protocol ?? 'chat'; });
watch([modelId,protocol], () => { void loadMapping(); });
function close() { if (!busy.value) emit('close'); }
async function save() {
  if (busy.value || reading.value || locked.value || !modelId.value || !upstreamModel.value.trim()) return;
  const features: CapabilityFeature[] = [...(current.value?.capabilities.features.filter(feature => !controlled.includes(feature)) ?? [])];
  if (streaming.value) { features.push('streaming'); if (protocol.value === 'chat') features.push('stream_usage'); }
  if (tools.value) features.push('tools','tool_choice','parallel_tools','parallel_tool_control');
  const model = models.value.find(item => item.publicModelId === modelId.value);
  const capabilities = { ...(current.value?.capabilities ?? (model ? { maxOutputTokens: model.maxOutputTokens } : {})), protocol: protocol.value, features };
  busy.value = true; message.value = '';
  try { if (current.value) await adminModelsApi.updateMapping(modelId.value, props.channel.id, protocol.value, current.value.configVersion, { upstreamModel: upstreamModel.value.trim(), capabilities }); else await adminModelsApi.createMapping(modelId.value,{ channelId:props.channel.id,protocol:protocol.value,upstreamModel:upstreamModel.value.trim(),capabilities }); if (!alive) return; emit('saved'); await loadMapping(); if (alive) message.value = '渠道模型已保存。'; }
  catch (error) { if (alive) { locked.value = true; message.value = error instanceof Error ? error.message : '保存结果未确认，请重新读取。'; } }
  finally { if (alive) busy.value = false; }
}
onMounted(() => { void nextTick(() => dialog.value?.showModal()); void loadModels(); });
onBeforeUnmount(() => { alive = false; epoch++; });
</script>
<template>
  <dialog ref="dialog" aria-labelledby="channel-models-title" @cancel.prevent="close"><h2 id="channel-models-title">渠道模型 · {{ channel.name }}</h2>
    <p v-if="message" role="status">{{ message }}</p>
    <form id="channel-model-form" @submit.prevent="save"><fieldset :disabled="busy || loading">
      <label>公开模型<select v-model="modelId" required><option value="" disabled>选择模型</option><option v-for="model in models" :key="model.publicModelId" :value="model.publicModelId">{{ model.publicModelId }}</option></select></label>
      <p v-if="!loading && !models.length"><RouterLink to="/admin/models" @click="close">先创建公开模型和价格 →</RouterLink></p>
      <label>上游接口<select v-model="protocol"><option value="chat">Chat Completions</option><option value="responses">Responses</option><option value="messages">Messages</option></select></label>
      <label>上游模型名称<input v-model="upstreamModel" required maxlength="128" :disabled="reading || locked" /></label>
      <div class="choice-grid"><label class="choice"><input v-model="streaming" type="checkbox" :disabled="reading || locked" />流式输出</label><label class="choice"><input v-model="tools" type="checkbox" :disabled="reading || locked" />工具调用</label></div>
    </fieldset></form>
    <div class="dialog-actions"><button v-if="locked" type="button" :disabled="busy" @click="loadMapping">重新读取</button><button type="button" :disabled="busy" @click="close">关闭</button><button type="submit" form="channel-model-form" :disabled="busy || loading || reading || locked || !modelId">{{ busy ? '正在保存…' : '保存模型' }}</button></div>
  </dialog>
</template>
<style scoped>
dialog{width:min(94vw,560px)}fieldset{border:0;padding:0;min-width:0}label{display:grid;gap:8px;margin:18px 0}input,select{width:100%}.choice input{width:16px}p{font-size:14px}
</style>
