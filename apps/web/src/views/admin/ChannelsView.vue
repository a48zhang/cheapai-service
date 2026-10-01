<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiClientError } from '../../api/client.js';
import { adminChannelsApi } from '../../api/admin-channels.js';
import type { ChannelProbeResult, ChannelStatus, ChannelView } from '../../api/admin-channels.js';
import ChannelEditor from '../../components/admin/ChannelEditor.vue';
import ChannelModelsDialog from '../../components/admin/ChannelModelsDialog.vue';
const modelsChannel = ref<ChannelView | null>(null);
const probeSelection = ref('');

const items = ref<ChannelView[]>([]); const cursor = ref<string | null>(null); const status = ref<'' | ChannelStatus>(''); const busy = ref(false); const error = ref(''); const requestId = ref<string | null>(null); let epoch = 0;
const editing = ref<ChannelView | null>(null); const creating = ref(false); const probeChannel = ref<ChannelView | null>(null); const probeModel = ref(''); const probeProtocol = ref<'chat' | 'responses' | 'messages'>('chat'); const mappingVersion = ref(1); const priceVersion = ref(1); const probeBusy = ref(false); const probeMessage = ref(''); const lastProbe = ref<Record<string, ChannelProbeResult>>({});
const outcomeLabels: Record<ChannelProbeResult['outcome'], string> = { responded: '响应有效', http_error: 'HTTP 错误', invalid_response: '响应无效', timeout: '超时', cancelled: '已取消', transport_error: '传输错误' };
async function load(more = false) { const ticket = ++epoch; busy.value = true; error.value = ''; requestId.value = null;
  try { const result = await adminChannelsApi.list({ cursor: more ? cursor.value : null, ...(status.value ? { status: status.value } : {}) }); if (ticket === epoch) { items.value = more ? [...items.value, ...result.items] : [...result.items]; cursor.value = result.nextCursor; } }
  catch (cause) { if (ticket === epoch) { error.value = cause instanceof Error ? cause.message : '渠道列表读取失败。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; } }
  finally { if (ticket === epoch) busy.value = false; }
}
function openProbe(channel: ChannelView) { probeChannel.value = channel; const first=channel.models[0]; probeSelection.value=first ? first.publicModelId+'|'+first.protocol : ''; applyProbeSelection(); probeMessage.value = ''; }
function applyProbeSelection() { const item=probeChannel.value?.models.find(model => model.publicModelId+'|'+model.protocol===probeSelection.value); probeModel.value=item?.publicModelId ?? ''; probeProtocol.value=item?.protocol ?? 'chat'; mappingVersion.value=item?.mappingVersion ?? 0; priceVersion.value=item?.priceVersion ?? 0; }
function closeProbe() { if (!probeBusy.value) probeChannel.value = null; }
async function test() { const channel = probeChannel.value; if (!channel || probeBusy.value) return; if (!probeModel.value.trim() || ![mappingVersion.value, priceVersion.value].every(Number.isSafeInteger) || mappingVersion.value < 1 || priceVersion.value < 1) { probeMessage.value = '请填写公开模型和有效版本。'; return; }
  probeBusy.value = true; probeMessage.value = ''; try { const result = await adminChannelsApi.test(channel.id, { publicModelId: probeModel.value.trim(), protocol: probeProtocol.value, channelVersion: channel.configVersion, mappingVersion: mappingVersion.value, priceVersion: priceVersion.value }); lastProbe.value = { ...lastProbe.value, [channel.id]: result }; probeMessage.value = `${outcomeLabels[result.outcome]}。诊断编号：${result.diagnosticId}。此操作可能产生上游费用，用户余额不会扣费。`; } catch (error) { probeMessage.value = error instanceof Error ? error.message : '诊断结果未确认，请刷新渠道状态。'; } finally { probeBusy.value = false; }
}
const modal = ref<HTMLDialogElement | null>(null);
watch(probeChannel, async value => { await nextTick(); if (value && modal.value && !modal.value.open) modal.value.showModal(); });
onMounted(() => { void load(); }); onBeforeUnmount(() => { epoch++; });
</script>

<template>
  <section><ChannelModelsDialog v-if="modelsChannel" :channel="modelsChannel" @close="modelsChannel = null" @saved="load()" /><div class="page-heading"><h1>渠道管理</h1><button type="button" @click="creating = true">创建渠道</button></div><ChannelEditor v-if="creating" :item="null" @close="creating = false" @saved="load()" /><ChannelEditor v-if="editing" :item="editing" @close="editing = null" @saved="load()" />
    <form class="toolbar" @submit.prevent="load()"><label>状态<select v-model="status"><option value="">全部</option><option value="active">启用</option><option value="disabled">停用</option></select></label><button type="submit" :disabled="busy">查询 / 刷新</button></form>
    <p v-if="busy" role="status">正在读取渠道…</p><p v-if="error" role="alert">{{ error }} <small v-if="requestId">请求编号：{{ requestId }}</small><button type="button" @click="load()">重试</button></p><p class="empty-state" v-if="!busy && !error && items.length === 0">暂无渠道。</p>
    <div v-if="items.length" class="table-scroll"><table><caption>渠道列表</caption><thead><tr><th>名称 / 地址</th><th>上游模型</th><th>状态</th><th>限额</th><th>凭证</th><th>操作</th></tr></thead><tbody><tr v-for="channel in items" :key="channel.id"><td><strong>{{ channel.name }}</strong><br /><code>{{ channel.baseUrl }}</code></td><td><div class="channel-models"><span v-if="!channel.models.length">未配置模型</span><div v-for="model in channel.models" :key="model.publicModelId+model.protocol"><code>{{ model.upstreamModel }}</code><span v-if="model.publicModelId !== model.upstreamModel"> → {{ model.publicModelId }}</span></div></div></td><td>{{ channel.status === 'active' ? '启用' : '停用' }}</td><td>并发 {{ channel.concurrencyLimit === Number.MAX_SAFE_INTEGER ? '不限' : channel.concurrencyLimit }}<br />每分钟 {{ channel.rpmLimit === Number.MAX_SAFE_INTEGER ? '不限' : channel.rpmLimit }}<br />优先级 {{ channel.priority }}</td><td>{{ channel.hasCredential ? '已配置（掩码）' : '未配置' }}</td><td><button type="button" @click="editing = channel">编辑</button><button type="button" @click="modelsChannel = channel">配置模型</button><button type="button" :disabled="!channel.models.length" @click="openProbe(channel)">测试连接</button><p v-if="lastProbe[channel.id]" class="probe-result">{{ outcomeLabels[lastProbe[channel.id]!.outcome] }} · {{ lastProbe[channel.id]!.publicModelId }} / {{ lastProbe[channel.id]!.protocol }}</p></td></tr></tbody></table></div>
    <button v-if="cursor" type="button" :disabled="busy" @click="load(true)">加载更多</button>
    <dialog v-if="probeChannel" ref="modal" @cancel.prevent="closeProbe" aria-labelledby="probe-title"><h2 id="probe-title">测试渠道连接</h2><p>选择此渠道已有的模型映射进行测试。</p><p v-if="probeMessage" role="status">{{ probeMessage }}</p><form id="channel-probe-form" @submit.prevent="test"><label>模型<select v-model="probeSelection" required @change="applyProbeSelection"><option v-for="model in probeChannel.models" :key="model.publicModelId+model.protocol" :value="model.publicModelId+'|'+model.protocol">{{ model.publicModelId }} · {{ model.upstreamModel }}</option></select></label></form><p>测试会向上游发起一次请求，可能产生费用。</p><div class="dialog-actions"><button type="button" :disabled="probeBusy" @click="closeProbe">关闭</button><button type="submit" form="channel-probe-form" :disabled="probeBusy || !probeModel">{{ probeBusy ? '正在诊断…' : '执行诊断' }}</button></div></dialog>
  </section>
</template>

<style scoped>
.toolbar { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin: 20px 0; }label { display: grid; gap: 7px; }input,select { padding: 9px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }.table-scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: #fff; }th,td { text-align: left; vertical-align: top; padding: 14px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }caption { text-align: left; padding-bottom: 12px; }small { color: var(--muted); }.probe-result { color: var(--muted); font-size: 12px; }button { margin: 7px 7px 7px 0; }dialog { width: min(94vw, 520px); padding: 26px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }dialog label { margin: 14px 0; }dialog input,dialog select { width: 100%; }
</style>
