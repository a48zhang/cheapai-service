<script setup lang="ts">
import { RouterLink } from 'vue-router';
const links = [{title:'API Keys',path:'/keys',number:'01'},{title:'请求记录',path:'/requests',number:'02'},{title:'账单明细',path:'/billing',number:'03'}];
</script>
<template>
  <section class="home"><div class="hero"><div><h1>模型服务<br />管理控制台<span>。</span></h1><div class="hero-actions"><RouterLink to="/login" class="button primary">登录控制台 <span aria-hidden="true">↗</span></RouterLink><RouterLink to="/register">创建账户 <span aria-hidden="true">→</span></RouterLink></div></div><nav class="workspace-links" aria-label="工作区入口"><RouterLink v-for="link in links" :key="link.path" :to="link.path"><span class="index">{{ link.number }}</span><span>{{ link.title }}</span><span class="arrow" aria-hidden="true">↗</span></RouterLink></nav></div></section>
</template>
<style scoped>
.hero{display:grid;grid-template-columns:1.2fr 1fr;align-items:center;gap:100px;min-height:580px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:72px 0}h1{font-size:clamp(42px,4.6vw,68px);line-height:1.25;font-weight:500;letter-spacing:-.05em;margin-bottom:44px}h1>span{color:var(--accent)}.hero-actions{display:flex;align-items:center;gap:28px}.hero-actions .button{min-height:48px;padding:12px 22px;gap:28px}.hero-actions>a:not(.button){font-size:14px;text-decoration:none}.workspace-links{display:grid}.workspace-links>a{display:flex;align-items:center;gap:24px;padding:32px 0;border-bottom:1px solid var(--line);text-decoration:none;font-size:24px}.workspace-links>a:first-child{border-top:1px solid var(--line)}.index{font:12px var(--mono);color:var(--muted)}.arrow{margin-left:auto;color:var(--accent);font-size:20px}@media(max-width:760px){.hero{grid-template-columns:1fr;gap:54px;min-height:auto;padding:48px 0}h1{font-size:44px;margin-bottom:30px}.workspace-links>a{font-size:20px;padding:25px 0}.hero-actions{gap:20px}}
</style>
