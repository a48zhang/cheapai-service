<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiClientError } from '../../api/client.js';
import { adminChannelsApi } from '../../api/admin-channels.js';
import type { ChannelView } from '../../api/admin-channels.js';
import { adminGroupsApi } from '../../api/admin-groups.js';
import { isBillingMultiplier } from '../../api/admin-groups.js';
import type { GroupInput, GroupStatus, GroupView } from '../../api/admin-groups.js';

const items = ref<GroupView[]>([]); const cursor = ref<string | null>(null); const statusFilter = ref<'' | GroupStatus>(''); const busy = ref(false); const error = ref(''); const requestId = ref<string | null>(null); let epoch = 0; let alive = true;
const open = ref(false); const editing = ref<GroupView | null>(null); const name = ref(''); const status = ref<GroupStatus>('active'); const channelIds = ref<string[]>([]); const billingMultiplier = ref('1'); const channels = ref<ChannelView[]>([]); const channelsBusy = ref(false); const channelsError = ref(''); const channelsLoaded = ref(false); let channelsEpoch = 0; const message = ref(''); const locked = ref(false);
async function load(more = false) { const ticket = ++epoch; busy.value = true; error.value = ''; requestId.value = null; try { const result = await adminGroupsApi.list({ cursor: more ? cursor.value : null, ...(statusFilter.value ? { status: statusFilter.value } : {}) }); if (ticket === epoch) { items.value = more ? [...items.value, ...result.items] : [...result.items]; cursor.value = result.nextCursor; } } catch (cause) { if (ticket === epoch) { error.value = cause instanceof Error ? cause.message : '分组列表读取失败。'; requestId.value = cause instanceof ApiClientError ? cause.request_id : null; } } finally { if (ticket === epoch) busy.value = false; } }
async function loadChannels() {
  if (!alive || !open.value) return;
  const ticket = ++channelsEpoch;
  channelsBusy.value = true; channelsLoaded.value = false; channelsError.value = '';
  try {
    const result = await adminChannelsApi.listAll();
    if (alive && open.value && ticket === channelsEpoch) {
      channels.value = [...result]; channelsLoaded.value = true;
    }
  } catch (cause) {
    if (alive && open.value && ticket === channelsEpoch) channelsError.value = cause instanceof Error ? cause.message : '渠道读取失败。';
  } finally {
    if (alive && open.value && ticket === channelsEpoch) channelsBusy.value = false;
  }
}
function begin(item: GroupView | null) { editing.value = item; name.value = item?.name ?? ''; status.value = item?.status ?? 'active'; channelIds.value = item ? [...item.channelIds] : []; billingMultiplier.value = item?.billingMultiplier ?? '1'; message.value = ''; channels.value = []; channelsLoaded.value = false; channelsError.value = ''; locked.value = false; open.value = true; void loadChannels(); }
function close() { if (!busy.value) { channelsEpoch++; open.value = false; editing.value = null; channelsBusy.value = false; channelsLoaded.value = false; } }
async function save() { if (!alive || !open.value || busy.value || channelsBusy.value || !channelsLoaded.value || channelsError.value || locked.value) return; if (!name.value.trim() || channelIds.value.some(value => !value)) { message.value = '请输入分组名称，并确认渠道选择有效。'; return; } if (!isBillingMultiplier(billingMultiplier.value)) { message.value = '倍率必须是非负十进制数字，例如 1 或 0.2。'; return; } busy.value = true; message.value = ''; const selected = [...new Set(channelIds.value)]; const input: GroupInput = { name: name.value.trim(), status: status.value, channelIds: selected, billingMultiplier: billingMultiplier.value }; try { if (editing.value) await adminGroupsApi.update(editing.value.id, editing.value.version, input); else await adminGroupsApi.create(input); if (alive) { locked.value = true; await load(); message.value = editing.value ? '分组已保存。' : '分组已创建。'; } } catch (cause) { if (alive) { locked.value = true; message.value = cause instanceof ApiClientError && cause.status === 409 ? '分组版本已变化，或停用会破坏最后管理员保护。请重新读取后核对。' : '保存结果未确认，请返回列表核对；本页不会自动重试。'; } } finally { if (alive) busy.value = false; } }
const modal = ref<HTMLDialogElement | null>(null);
watch(open, async value => { await nextTick(); if (alive && value && open.value && modal.value && !modal.value.open) modal.value.showModal(); });
onMounted(() => { void load(); }); onBeforeUnmount(() => { alive = false; epoch++; channelsEpoch++; });
</script>

<template>
  <section><div class="page-heading"><h1>访问组</h1><button type="button" @click="begin(null)">创建分组</button></div>
    <form class="toolbar" @submit.prevent="load()"><label>状态<select v-model="statusFilter"><option value="">全部</option><option value="active">启用</option><option value="disabled">停用</option></select></label><button type="submit" :disabled="busy">查询 / 刷新</button></form>
    <p v-if="busy" role="status">正在读取分组…</p><p v-if="error" role="alert">{{ error }} <small v-if="requestId">请求编号：{{ requestId }}</small><button type="button" @click="load()">重试</button></p><p class="empty-state" v-if="!busy && !error && items.length === 0">暂无分组。</p>
    <div v-if="items.length" class="table-scroll"><table><caption>访问组列表</caption><thead><tr><th>名称 / 状态</th><th>倍率</th><th>渠道关系</th><th>操作</th></tr></thead><tbody><tr v-for="group in items" :key="group.id"><td><strong>{{ group.name }}</strong><br />{{ group.status === 'active' ? '启用' : '停用' }}<br /><small>{{ group.id }}</small></td><td><strong>{{ group.billingMultiplier }}×</strong></td><td>{{ group.channelIds.length ? group.channelIds.join('、') : '未配置渠道' }}</td><td><button type="button" @click="begin(group)">编辑</button></td></tr></tbody></table></div><button v-if="cursor" type="button" :disabled="busy" @click="load(true)">加载更多</button>
    <dialog v-if="open" ref="modal" @cancel.prevent="close" aria-labelledby="group-editor-title"><h2 id="group-editor-title">{{ editing ? '编辑访问组' : '创建访问组' }}</h2><p v-if="channelsBusy" role="status">正在读取全部渠道…</p><p v-if="channelsError" role="alert">渠道列表读取失败，保存已禁用。{{ channelsError }}<button type="button" :disabled="channelsBusy" @click="loadChannels">重试读取渠道</button></p><p v-if="message" role="status">{{ message }}</p><form @submit.prevent="save"><fieldset :disabled="busy || channelsBusy || !channelsLoaded || !!channelsError || locked"><label>名称<input v-model="name" maxlength="128" required autocomplete="off" /></label><label>计费倍率 <span aria-hidden="true">（例如 1 或 0.2）</span><input v-model="billingMultiplier" maxlength="64" inputmode="decimal" autocomplete="off" required /></label><label>状态<select v-model="status"><option value="active">启用</option><option value="disabled">停用</option></select></label><label>渠道关系<select v-model="channelIds" multiple size="7"><option v-for="channel in channels" :key="channel.id" :value="channel.id">{{ channel.name }} · {{ channel.id }}{{ channel.status === 'disabled' ? '（停用）' : '' }}</option><option v-for="id in channelIds.filter(value => !channels.some(channel => channel.id === value))" :key="id" :value="id">{{ id }}（当前）</option></select></label></fieldset><button type="submit" :disabled="busy || channelsBusy || !channelsLoaded || !!channelsError || locked">{{ busy ? '正在保存…' : '保存分组' }}</button><button type="button" :disabled="busy" @click="close">关闭</button></form></dialog>
  </section>
</template>

<style scoped>
.toolbar { display: flex; align-items: end; gap: 12px; margin: 20px 0; }label { display: grid; gap: 7px; }input,select { padding: 9px; border: 1px solid #cfd0c6; border-radius: 5px; font: inherit; }select[multiple] { width: 100%; }.table-scroll { overflow-x: auto; margin: 24px 0; }table { width: 100%; border-collapse: collapse; background: #fff; }th,td { text-align: left; vertical-align: top; padding: 14px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }caption { text-align: left; padding-bottom: 12px; }small { color: var(--muted); }button { margin: 7px 7px 7px 0; }dialog { width: min(94vw, 560px); padding: 26px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }dialog::backdrop { background: #25262066; }fieldset { border: 0; padding: 0; }dialog label { margin: 14px 0; }dialog input,dialog select { width: 100%; }
</style>
