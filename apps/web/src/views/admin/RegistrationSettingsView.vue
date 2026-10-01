<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { adminRegistrationApi } from '../../api/admin-registration.js';
import type { AdminRegistrationSettings } from '../../api/admin-registration.js';
import { ApiClientError } from '../../api/client.js';
const snapshot = ref<AdminRegistrationSettings | null>(null); const mode = ref<'closed' | 'open' | 'invite'>('closed'); const verify = ref(true);
const busy = ref(false); const message = ref(''); const reloadNeeded = ref(false); let alive = true;
const blocked = computed(() => busy.value || reloadNeeded.value || snapshot.value?.version == null || (mode.value !== 'closed' && verify.value && !snapshot.value?.emailAvailable));
function populate(value: AdminRegistrationSettings) { snapshot.value = value; mode.value = value.registrationMode ?? 'closed'; verify.value = value.emailVerificationEnabled ?? true; }
async function load() { busy.value = true; message.value = ''; try { const value = await adminRegistrationApi.settings(); if (alive) { populate(value); reloadNeeded.value = false; } } catch (error) { if (alive) { message.value = error instanceof Error ? error.message : '读取失败。'; reloadNeeded.value = true; } } finally { if (alive) busy.value = false; } }
async function save() {
  if (blocked.value || snapshot.value?.version == null) return; busy.value = true; message.value = '';
  try { const value = await adminRegistrationApi.updateSettings(snapshot.value.version, mode.value, verify.value); if (alive) { populate(value); message.value = '注册设置已保存。'; } }
  catch (error) { if (alive) { reloadNeeded.value = true; message.value = error instanceof ApiClientError && error.status === 409 ? '设置版本已变化。请重新读取后核对，不会自动覆盖其他管理员修改。' : '保存结果未确认，请重新读取设置。'; } }
  finally { if (alive) busy.value = false; }
}
onMounted(() => { void load(); }); onBeforeUnmount(() => { alive = false; });
</script>
<template>
  <section><h1>注册设置</h1>
    <p v-if="busy" role="status">正在处理…</p><p v-if="message" role="status">{{ message }}</p><button type="button" :disabled="busy" @click="load">重新读取设置</button>
    <template v-if="snapshot"><p>邮件服务：{{ snapshot.emailAvailable ? '已就绪' : '未就绪' }}</p>
      <p v-if="!snapshot.valid" role="alert">注册设置读取异常，请重新读取后再保存。</p>
      <form @submit.prevent="save"><label>注册模式<select v-model="mode" :disabled="busy"><option value="closed">关闭注册</option><option value="open">开放注册</option><option value="invite">仅邀请码注册</option></select></label>
        <label><input v-model="verify" type="checkbox" :disabled="busy" /> 注册需要验证邮箱</label>
        <p v-if="mode !== 'closed' && verify && !snapshot.emailAvailable" role="alert">邮件服务未就绪，不能保存需要邮箱验证的开放注册。请先修复邮件配置，或明确关闭邮箱验证。</p>
        <button type="submit" :disabled="blocked">保存注册设置</button>
      </form>
    </template>
  </section>
</template>
<style scoped>
form { max-width: 600px; background: #fff; border: 1px solid var(--line); padding: 24px; border-radius: 8px; margin-top: 24px; }label { display: block; margin: 18px 0; }select { display: block; padding: 10px; margin-top: 8px; width: 100%; }input { margin-right: 8px; }[role=alert] { color: var(--danger); }
</style>
