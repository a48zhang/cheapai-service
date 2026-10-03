<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiClientError } from '../../api/client.js';
import { adminChannelsApi } from '../../api/admin-channels.js';
import type { ChannelView } from '../../api/admin-channels.js';
import { adminModelsApi, CAPABILITY_FEATURES, EXTENSION_SCOPES } from '../../api/admin-models.js';
import type { CapabilityFeature, ChannelCapabilities, ModelMappingView, ModelView, Protocol } from '../../api/admin-models.js';

const props = defineProps<{ model: ModelView }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const dialog = ref<HTMLDialogElement | null>(null); const mappings = ref<ModelMappingView[]>([]); const channels = ref<ChannelView[]>([]); const selected = ref<ModelMappingView | null>(null); const channelId = ref(''); const protocol = ref<Protocol>('chat'); const upstreamModel = ref(''); const features = ref(''); const maxOutput = ref(''); const reasoningEfforts = ref(''); const cacheTtls = ref(''); const nativeExtensions = ref(''); const mappingsLoading = ref(false); const mappingsLoaded = ref(false); const mappingsError = ref(''); const channelsLoading = ref(false); const channelsLoaded = ref(false); const channelsError = ref(''); let mappingsEpoch = 0; let channelsEpoch = 0; let editorEpoch = 0; const busy = ref(false); const locked = ref(false); const message = ref(''); let alive = true;
const loading = computed(() => mappingsLoading.value || channelsLoading.value);
const canSave = computed(() => alive && mappingsLoaded.value && channelsLoaded.value && !loading.value && !mappingsError.value && !channelsError.value && !busy.value && !locked.value);
const editing = computed(() => selected.value !== null);
const featureOptions = CAPABILITY_FEATURES;
const scopeOptions = EXTENSION_SCOPES;
function split(value: string) { return [...new Set(value.split(/[\n,，]/u).map(item => item.trim()).filter(Boolean))]; }
function populate(item: ModelMappingView | null) { selected.value = item; channelId.value = item?.channelId ?? ''; protocol.value = item?.protocol ?? 'chat'; upstreamModel.value = item?.upstreamModel ?? ''; features.value = item?.capabilities.features.join('\n') ?? ''; maxOutput.value = item?.capabilities.maxOutputTokens === undefined ? '' : String(item.capabilities.maxOutputTokens); reasoningEfforts.value = item?.capabilities.reasoningEfforts?.join(', ') ?? ''; cacheTtls.value = item?.capabilities.cacheTtls?.join(', ') ?? ''; nativeExtensions.value = item?.capabilities.nativeExtensions?.map(extension => `${extension.scope}:${extension.name}`).join('\n') ?? ''; locked.value = false; message.value = ''; }
async function loadMappings() {
  const ticket = ++mappingsEpoch;
  mappingsLoading.value = true; mappingsLoaded.value = false; mappingsError.value = '';
  try {
    const result = await adminModelsApi.listMappings(props.model.publicModelId);
    if (alive && ticket === mappingsEpoch) { mappings.value = [...result.items]; mappingsLoaded.value = true; }
  } catch (error) {
    if (alive && ticket === mappingsEpoch) mappingsError.value = error instanceof Error ? error.message : '映射读取失败。';
  } finally {
    if (alive && ticket === mappingsEpoch) mappingsLoading.value = false;
  }
}
async function loadChannels() {
  const ticket = ++channelsEpoch;
  channelsLoading.value = true; channelsLoaded.value = false; channelsError.value = '';
  try {
    const result = await adminChannelsApi.listAll();
    if (alive && ticket === channelsEpoch) { channels.value = [...result]; channelsLoaded.value = true; }
  } catch (error) {
    if (alive && ticket === channelsEpoch) channelsError.value = error instanceof Error ? error.message : '渠道读取失败。';
  } finally {
    if (alive && ticket === channelsEpoch) channelsLoading.value = false;
  }
}
async function load() { await Promise.all([loadMappings(), loadChannels()]); }
function startCreate() { if (!busy.value && !mappingsLoading.value) populate(null); }
function select(item: ModelMappingView) { if (!busy.value && !mappingsLoading.value && mappingsLoaded.value) populate(item); }
function close() { if (!busy.value) { alive = false; editorEpoch++; mappingsEpoch++; channelsEpoch++; emit('close'); } }

function positiveInteger(value: string): number | undefined { if (!/^\d+$/u.test(value)) return undefined; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function capabilityInput(): ChannelCapabilities | null {
  const enabled = split(features.value) as CapabilityFeature[];
  const maximum = maxOutput.value ? positiveInteger(maxOutput.value) : undefined;
  if (enabled.some(feature => !CAPABILITY_FEATURES.includes(feature)) || (maxOutput.value && maximum === undefined)) return null;
  const output: { protocol: Protocol; features: CapabilityFeature[]; maxOutputTokens?: number; reasoningEfforts?: string[]; cacheTtls?: ('5m' | '1h')[]; nativeExtensions?: { scope: (typeof EXTENSION_SCOPES)[number]; name: string }[] } = { protocol: protocol.value, features: enabled };
  if (maximum !== undefined) output.maxOutputTokens = maximum;
  if (reasoningEfforts.value.trim()) output.reasoningEfforts = split(reasoningEfforts.value); if (cacheTtls.value.trim()) { const ttls = split(cacheTtls.value); if (ttls.some(ttl => ttl !== '5m' && ttl !== '1h')) return null; output.cacheTtls = ttls as ('5m' | '1h')[]; }
  if (nativeExtensions.value.trim()) { const parsed = split(nativeExtensions.value).map(value => { const index = value.indexOf(':'); if (index < 1) return null; const scope = value.slice(0, index) as (typeof EXTENSION_SCOPES)[number]; const name = value.slice(index + 1); return EXTENSION_SCOPES.includes(scope) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? { scope, name } : null; }); if (parsed.some(value => value === null)) return null; output.nativeExtensions = parsed as { scope: (typeof EXTENSION_SCOPES)[number]; name: string }[]; }
  return output;
}
async function save() {
  if (!canSave.value) return; const capabilities = capabilityInput(); if (!channelId.value || !upstreamModel.value.trim() || !capabilities || (!editing.value && !channelId.value)) { message.value = '请选择渠道、填写上游模型，并提供有效能力字段。'; return; }
  const ticket = editorEpoch; const modelId = props.model.publicModelId;
  busy.value = true; message.value = ''; try { if (selected.value) await adminModelsApi.updateMapping(modelId, selected.value.channelId, selected.value.protocol, selected.value.configVersion, { upstreamModel: upstreamModel.value.trim(), capabilities }); else await adminModelsApi.createMapping(modelId, { channelId: channelId.value, protocol: protocol.value, upstreamModel: upstreamModel.value.trim(), capabilities }); if (alive && ticket === editorEpoch) { locked.value = true; emit('changed'); await load(); if (alive && ticket === editorEpoch) message.value = '模型映射已保存。'; } } catch (error) { if (alive && ticket === editorEpoch) { locked.value = true; message.value = error instanceof ApiClientError && error.status === 409 ? '映射版本已变化，请重新读取后核对，不能覆盖其他修改。' : '保存结果未确认，请重新读取映射；本页不会自动重试。'; } } finally { if (alive && ticket === editorEpoch) busy.value = false; }
}
async function show() { await nextTick(); if (alive && dialog.value && !dialog.value.open) dialog.value.showModal(); }
watch(() => props.model.publicModelId, () => {
  editorEpoch++; busy.value = false; populate(null); mappings.value = []; channels.value = [];
  void load();
}, { immediate: true });
onMounted(() => { void show(); }); onBeforeUnmount(() => { alive = false; editorEpoch++; mappingsEpoch++; channelsEpoch++; });
</script>

<template>
  <dialog ref="dialog" aria-labelledby="mapping-title" @cancel.prevent="close"><h2 id="mapping-title">渠道模型映射</h2><p>{{ model.publicModelId }}</p><p v-if="message" role="status">{{ message }}</p><p v-if="mappingsLoading" role="status">正在读取映射…</p><p v-if="channelsLoading" role="status">正在读取全部渠道…</p>
    <p v-if="mappingsError" role="alert">映射读取失败，保存已禁用。{{ mappingsError }}<button type="button" :disabled="busy || mappingsLoading" @click="loadMappings">重试读取映射</button></p>
    <p v-if="channelsError" role="alert">渠道列表读取失败，保存已禁用。{{ channelsError }}<button type="button" :disabled="busy || channelsLoading" @click="loadChannels">重试读取渠道</button></p>
    <div class="mapping-layout"><aside><h3>已有映射</h3><p v-if="mappingsLoaded && mappings.length === 0">暂无映射。</p><button v-for="item in mappings" :key="`${item.channelId}/${item.protocol}`" type="button" class="mapping-choice" :disabled="busy || mappingsLoading || !mappingsLoaded" @click="select(item)">{{ item.channelId }} · {{ item.protocol }} · v{{ item.configVersion }}</button><button type="button" class="secondary" :disabled="busy || mappingsLoading" @click="startCreate">新建映射</button><button type="button" :disabled="busy || mappingsLoading" @click="loadMappings">重新读取映射</button></aside><form @submit.prevent="save"><fieldset :disabled="!canSave"><label>渠道<select v-model="channelId" :disabled="editing"><option value="">请选择</option><option v-for="channel in channels" :key="channel.id" :value="channel.id">{{ channel.name }} · {{ channel.id }}{{ channel.status === 'disabled' ? '（停用）' : '' }}</option><option v-if="editing && !channels.some(channel => channel.id === channelId)" :value="channelId">{{ channelId }}（当前）</option></select></label><label>协议<select v-model="protocol" :disabled="editing"><option value="chat">Chat</option><option value="responses">Responses</option><option value="messages">Messages</option></select></label><label>上游模型<input v-model="upstreamModel" maxlength="128" required autocomplete="off" /></label><label>能力（每行或逗号分隔）<textarea v-model="features" rows="4" placeholder="streaming, tools" /><details><summary>可用能力</summary><p>{{ featureOptions.join('、') }}</p></details></label><label>最大输出 Token（可选）<input v-model="maxOutput" inputmode="numeric" /></label><label>推理档位（可选）<input v-model="reasoningEfforts" placeholder="low, medium" /></label><label>缓存 TTL（可选）<input v-model="cacheTtls" placeholder="5m, 1h" /></label><label>原生扩展 scope:name（可选）<textarea v-model="nativeExtensions" rows="2" placeholder="request:vendor_flag" /><small>scope 可选：{{ scopeOptions.join('、') }}</small></label></fieldset><button type="submit" :disabled="!canSave">{{ busy ? '正在保存…' : editing ? '保存映射' : '创建映射' }}</button><button type="button" :disabled="busy" @click="close">关闭</button></form></div>
  </dialog>
</template>

<style scoped>
dialog { width: min(96vw, 920px); max-height: 94svh; overflow: auto; padding: 26px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }.mapping-layout { display: grid; grid-template-columns: minmax(180px, 260px) 1fr; gap: 24px; }aside { border-right: 1px solid var(--line); padding-right: 16px; }aside button { display: block; width: 100%; text-align: left; }.mapping-choice { background: var(--soft); color: var(--ink); border-color: var(--line); }.secondary { background: #fff; color: var(--ink); }fieldset { border: 0; padding: 0; }label { display: grid; gap: 7px; margin: 13px 0; }input,select,textarea { width: 100%; padding: 9px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }small { color: var(--muted); overflow-wrap: anywhere; }button { margin: 7px 7px 0 0; }@media (max-width: 680px) { .mapping-layout { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); padding: 0 0 14px; } }
</style>
