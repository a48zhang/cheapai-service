<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ApiClientError } from '../api/client.js';
import { safeReturnPath } from '../router.js';
import { sessionStore, SessionSupersededError } from '../stores/session.js';

const router = useRouter(); const route = useRoute();
const email = ref(''); const password = ref('');
const preparing = ref(true); const submitting = ref(false); const bootstrapFailed = ref(false);
const message = ref(''); const requestId = ref<string | null>(null);
let active = true;
const disabled = computed(() => preparing.value || submitting.value || bootstrapFailed.value || sessionStore.state.pending !== null);
function displayError(error: unknown) {
  if (!active || error instanceof SessionSupersededError) return;
  requestId.value = error instanceof ApiClientError ? error.request_id : null;
  message.value = error instanceof ApiClientError && error.status === 429
    ? '登录尝试过于频繁，请稍后再试。'
    : error instanceof Error ? error.message : '登录暂时无法完成，请稍后重试。';
}
async function prepare() {
  preparing.value = true; message.value = ''; requestId.value = null; bootstrapFailed.value = false;
  try { await sessionStore.bootstrap(); }
  catch (error) { if (active) bootstrapFailed.value = true; displayError(error); }
  finally { if (active) preparing.value = false; }
}
async function submit() {
  if (disabled.value) return;
  submitting.value = true; message.value = ''; requestId.value = null;
  const destination = safeReturnPath(route.query.returnTo);
  try {
    await sessionStore.login({ email: email.value.trim(), password: password.value });
    password.value = '';
    if (active) await router.replace(destination);
  } catch (error) { displayError(error); }
  finally { if (active) submitting.value = false; }
}
onMounted(() => { void prepare(); });
onBeforeUnmount(() => { active = false; password.value = ''; });
</script>

<template>
  <div class="auth-layout">
  <aside class="auth-aside"><span class="auth-index">账户登录 / ACCESS</span><h2>回到你的<br />模型工作台<span style="color:var(--accent)">。</span></h2><span>Sub2API</span></aside>
  <section class="login-card" aria-labelledby="login-title">
    <h1 id="login-title">登录控制台</h1>
    <p v-if="preparing" class="status" role="status">准备登录…</p>
    <div v-if="message" id="login-error" class="error" role="alert">
      <p>{{ message }}</p>
      <small v-if="requestId">请求编号：{{ requestId }}</small>
      <button v-if="bootstrapFailed" type="button" :disabled="preparing" @click="prepare">重试初始化</button>
    </div>
    <form action="/api/v1/auth/login" method="post" :aria-busy="submitting" :aria-describedby="message ? 'login-error' : undefined" @submit.prevent="submit">
      <label for="login-email">邮箱</label>
      <input id="login-email" v-model="email" name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" required maxlength="254" :disabled="submitting" />
      <label for="login-password">密码</label>
      <input id="login-password" v-model="password" name="password" type="password" autocomplete="current-password" required maxlength="256" :disabled="submitting" />
      <button class="submit" type="submit" :disabled="disabled">{{ submitting ? '正在登录…' : '登录' }}</button>
    </form>
    <p class="help">没有账户？<RouterLink to="/register">创建账户</RouterLink></p>
  </section>
  </div>
</template>

<style scoped>
.login-card { width: min(100%, 460px); margin: 16px auto; padding: clamp(24px, 5vw, 40px); background: #fff; border: 1px solid var(--line); border-top: 4px solid var(--ink); border-radius: 10px; box-shadow: 0 12px 36px #25262008; }
h1 { font-size: 30px; margin: 10px 0; }.intro { margin: 0 0 28px; color: var(--muted); }.status { color: var(--muted); font-size: 14px; }
form { display: grid; gap: 10px; }label { font-size: 14px; font-weight: 600; margin-top: 10px; }input { width: 100%; min-height: 46px; border: 1px solid #cfd0c6; border-radius: 6px; padding: 10px 12px; color: var(--ink); background: white; }.submit { margin-top: 18px; min-height: 46px; font-weight: 600; }
.error { padding: 12px 14px; margin-bottom: 18px; background: #f9ede7; color: var(--danger); border-radius: 6px; }.error p { margin: 0; }.error small { display: block; margin-top: 8px; overflow-wrap: anywhere; }.error button { margin-top: 12px; }.help { font-size: 13px; color: var(--muted); margin: 26px 0 0; }
</style>
