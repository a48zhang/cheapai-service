<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { ApiClientError } from '../api/client.js';
import { sessionStore, RegistrationIdentityError, SessionSupersededError } from '../stores/session.js';
import { registrationApi } from '../api/registration.js';
import type { PublicSettings } from '../api/registration.js';

const settings = ref<PublicSettings | null>(null);
const router = useRouter();
const submitting = ref(false); const accountCreated = ref(false); const submitMessage = ref(''); const submitRequestId = ref<string | null>(null);
const loading = ref(true); const error = ref('');
const email = ref(''); const password = ref(''); const registrationCode = ref(''); const emailCode = ref('');
const isOpen = computed(() => settings.value !== null && settings.value.registrationMode !== 'closed');
const emailElement = ref<HTMLInputElement | null>(null);
const sending = ref(false); const cooldownSeconds = ref(0); const codeStatus = ref<'idle' | 'accepted' | 'failed' | 'unknown'>('idle');
const codeMessage = ref(''); const codeRequestId = ref<string | null>(null);
let cooldownTimer: ReturnType<typeof setInterval> | undefined;
function cooldown(milliseconds: number) {
  if (cooldownTimer !== undefined) clearInterval(cooldownTimer);
  const until = Date.now() + Math.min(milliseconds, 2_147_483_647);
  const tick = () => { cooldownSeconds.value = Math.max(0, Math.ceil((until - Date.now()) / 1000)); if (cooldownSeconds.value === 0 && cooldownTimer !== undefined) { clearInterval(cooldownTimer); cooldownTimer = undefined; } };
  tick(); if (cooldownSeconds.value > 0) cooldownTimer = setInterval(tick, 1000);
}
async function sendCode() {
  if (submitting.value || accountCreated.value || sending.value || cooldownSeconds.value > 0 || !isOpen.value || !settings.value?.emailVerificationEnabled || !emailElement.value?.reportValidity()) return;
  sending.value = true; codeMessage.value = ''; codeRequestId.value = null;
  const outcome = await registrationApi.sendCode(email.value.trim());
  if (!active) return;
  sending.value = false; codeStatus.value = outcome.status; cooldown(outcome.retryAfterMs);
  if (outcome.status === 'accepted') codeMessage.value = '验证码发送请求已受理，请查收邮件。受理不代表已经送达。';
  else {
    codeRequestId.value = outcome.requestId;
    codeMessage.value = outcome.status === 'unknown'
      ? `暂时无法确认发送结果，邮件仍可能到达。请先查收，避免立即重复发送。${outcome.message}`
      : `验证码请求未被接受。${outcome.message}`;
  }
}
watch(email, () => { emailCode.value = ''; codeStatus.value = 'idle'; codeMessage.value = ''; codeRequestId.value = null; });
async function submit() {
  if (accountCreated.value || submitting.value || sending.value || loading.value || !isOpen.value || !settings.value) return;
  submitting.value = true; submitMessage.value = ''; submitRequestId.value = null;
  try {
    const result = await sessionStore.register({ email: email.value.trim(), password: password.value,
      ...(settings.value.registrationMode === 'invite' ? { registrationCode: registrationCode.value.trim() } : {}),
      ...(settings.value.emailVerificationEnabled ? { emailCode: emailCode.value } : {}),
    });
    if (!active) return;
    accountCreated.value = true; password.value = ''; emailCode.value = ''; registrationCode.value = '';
    if (result.session === 'created') await router.replace('/');
    else submitMessage.value = '账户已创建。请登录以继续，不要重复注册。';
  } catch (cause) {
    if (!active || cause instanceof SessionSupersededError) return;
    if (cause instanceof RegistrationIdentityError) { accountCreated.value = true; password.value = ''; submitMessage.value = cause.message; }
    else {
      submitRequestId.value = cause instanceof ApiClientError ? cause.request_id : null;
      submitMessage.value = cause instanceof ApiClientError && cause.status === 429 ? '注册请求过于频繁，请稍后重试。' : cause instanceof Error ? cause.message : '注册未能完成，请稍后重试。';
      if (cause instanceof ApiClientError && cause.status === 403) await loadSettings();
    }
  } finally { if (active) submitting.value = false; }
}
async function recoverSession() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const user = await sessionStore.restore(); if (!active) return;
    if (user) await router.replace('/'); else submitMessage.value = '账户已创建，请登录以继续。';
  } catch (cause) { if (active) submitMessage.value = cause instanceof Error ? cause.message : '暂时无法恢复会话，请稍后登录。'; }
  finally { if (active) submitting.value = false; }
}
let active = true;
async function loadSettings() {
  loading.value = true; error.value = '';
  try { const value = await registrationApi.loadSettings(); if (active) settings.value = value; }
  catch (cause) { if (active) { settings.value = null; error.value = cause instanceof Error ? cause.message : '无法读取注册设置。'; } }
  finally { if (active) loading.value = false; }
}
onMounted(() => { void loadSettings(); });
onBeforeUnmount(() => { active = false; if (cooldownTimer !== undefined) clearInterval(cooldownTimer); password.value = ''; registrationCode.value = ''; emailCode.value = ''; });
</script>

<template>
  <div class="auth-layout">
  <aside class="auth-aside"><span class="auth-index">创建账户 / JOIN</span><h2>从一个入口，<br />开始调用<span style="color:var(--accent)">。</span></h2><span>Sub2API</span></aside>
  <section class="register-card" aria-labelledby="register-title">
    <h1 id="register-title">创建账户</h1>
    <div v-if="accountCreated" role="status"><p>{{ submitMessage || '账户已创建。' }}</p><button type="button" :disabled="submitting" @click="recoverSession">重试恢复会话</button><p><RouterLink to="/login">前往登录</RouterLink></p></div>
    <p v-else-if="loading" role="status">正在读取注册设置…</p>
    <div v-else-if="error" class="error" role="alert"><p>{{ error }}</p><button type="button" @click="loadSettings">重试</button></div>
    <div v-else-if="!isOpen"><p>当前未开放自助注册。已有账户可以直接登录。</p></div>
    <form v-else :aria-busy="submitting" @submit.prevent="submit">
      <div v-if="submitMessage" role="alert" class="error">{{ submitMessage }}<small v-if="submitRequestId"> 请求编号：{{ submitRequestId }}</small></div>
      <label for="register-email">邮箱</label><input id="register-email" ref="emailElement" v-model="email" :disabled="sending || submitting" type="email" name="email" autocomplete="username" autocapitalize="none" required maxlength="254" />
      <label for="register-password">密码</label><input id="register-password" v-model="password" :disabled="submitting" type="password" name="password" autocomplete="new-password" required minlength="6" maxlength="128" aria-describedby="password-help" />
      <small id="password-help">至少 6 个字符</small>
      <template v-if="settings?.registrationMode === 'invite'"><label for="registration-code">邀请码</label><input id="registration-code" v-model="registrationCode" :disabled="submitting" name="registrationCode" autocomplete="off" required /></template>
      <template v-if="settings?.emailVerificationEnabled">
        <label for="email-code">邮箱验证码</label><input id="email-code" v-model="emailCode" :disabled="submitting" name="emailCode" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required />
        <button type="button" :disabled="submitting || sending || cooldownSeconds > 0" @click="sendCode">{{ sending ? '正在请求…' : cooldownSeconds > 0 ? `${cooldownSeconds} 秒后可重发` : codeStatus === 'idle' ? '发送验证码' : '重新发送验证码' }}</button>
        <p v-if="codeMessage" :role="codeStatus === 'failed' || codeStatus === 'unknown' ? 'alert' : 'status'">{{ codeMessage }}<small v-if="codeRequestId"> 请求编号：{{ codeRequestId }}</small></p>
      </template>
      <button type="submit" :disabled="submitting || sending || sessionStore.state.pending !== null">{{ submitting ? '正在注册…' : '创建账户' }}</button>
    </form>
    <p class="help">已有账户？<RouterLink to="/login">登录</RouterLink></p>
  </section>
  </div>
</template>
<style scoped>
.register-card { width: min(100%, 490px); margin: 16px auto; padding: clamp(24px, 5vw, 40px); background: white; border: 1px solid var(--line); border-top: 4px solid var(--ink); border-radius: 10px; }h1 { font-size: 30px; margin: 10px 0 24px; }form { display: grid; gap: 10px; }label { font-weight: 600; margin-top: 10px; font-size: 14px; }input { width: 100%; padding: 11px; min-height: 46px; border: 1px solid #cfd0c6; border-radius: 6px; }small,.help { color: var(--muted); font-size: 13px; }.help { margin-top: 25px; }.error { padding: 12px; background: #f9ede7; color: var(--danger); border-radius: 6px; }button[type=submit] { margin-top: 18px; min-height: 46px; }
</style>
