<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { RouterLink, routerKey } from 'vue-router';
import { sessionStore } from '../stores/session.js';
const router = inject(routerKey, null);
const { state, isAuthenticated, isAdmin } = sessionStore;
const mobileOpen = ref(false);
const sections = [
  { title: '工作区', admin: false, items: [
    { path: '/', label: '聊天', icon: 'M4 5h16v11H8l-4 4z' },
    { path: '/dashboard', label: '账户概览', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
    { path: '/keys', label: 'API Keys', icon: 'M15 3a6 6 0 0 0-5 9L3 19v2h4v-3h3v-3l2-2a6 6 0 1 0 3-10ZM17 7h.01' },
    { path: '/requests', label: '我的请求', icon: 'M4 6h16M4 12h10M4 18h13' },
    { path: '/billing', label: '我的账单', icon: 'M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 8h6M9 12h6' },
  ] },
  { title: '管理', admin: true, items: [
    { path: '/admin/users', label: '用户管理', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M18 8a4 4 0 0 1 0 8' },
    { path: '/admin/channels', label: '渠道', icon: 'M4 6h16M4 18h16M8 3v6M16 15v6M8 9v6h8V9' },
    { path: '/admin/models', label: '模型', icon: 'm12 2 10 6-10 6L2 8ZM2 16l10 6 10-6M2 12l10 6 10-6' },
    { path: '/admin/groups', label: '访问组', icon: 'M3 4h7v6H3zM14 14h7v6h-7zM6 10v7h8M14 4h7v6h-7z' },
    { path: '/admin/requests', label: '全局请求', icon: 'm3 12 4-7 5 14 5-14 4 7' },
    { path: '/admin/billing', label: '管理账单', icon: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h4' },
    { path: '/admin/audit', label: '审计', icon: 'M12 3 3 7v6c0 4 9 8 9 8s9-4 9-8V7ZM8 12l3 3 5-6' },
    { path: '/admin/registration/settings', label: '注册设置', icon: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6' },
    { path: '/admin/registration/codes', label: '邀请码', icon: 'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4ZM15 5v14' },
  ] },
];
const currentPath = computed(() => router?.currentRoute.value.path ?? '/');
const isChatRoute = computed(() => currentPath.value === '/' || currentPath.value.startsWith('/chat/'));
const active = (path: string) => path === '/' ? currentPath.value === '/' || currentPath.value.startsWith('/chat/') : currentPath.value === path || currentPath.value.startsWith(path + '/');
const currentLabel = computed(() => sections.flatMap(s => s.items).find(item => active(item.path))?.label ?? '管理控制台');
watch(currentPath, () => { mobileOpen.value = false; });
async function retry() { try { await sessionStore.restore(); } catch { /* store owns failure */ } }
async function logout() { try { await sessionStore.logout(); if (router) await router.replace('/login'); else window.location.assign('/login'); } catch { /* keep failed session state visible */ } }
</script>
<template>
  <div class="app-shell" :class="{ authenticated: isAuthenticated, 'chat-shell': isAuthenticated && isChatRoute, 'nav-open': mobileOpen }">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <header v-if="!isAuthenticated" class="public-header">
      <component :is="router ? RouterLink : 'a'" to="/" href="/" class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="m10 7-7 9 7 9m12-18 7 9-7 9"/><path class="brand-center" d="M16 11v10"/></svg>Sub2API<span class="brand-dot">.</span></component>
      <nav aria-label="主导航"><component :is="router ? RouterLink : 'a'" to="/login" href="/login">登录</component><component :is="router ? RouterLink : 'a'" to="/register" href="/register" class="button">创建账户 <span aria-hidden="true">↗</span></component></nav>
    </header>
    <template v-else>
      <button v-if="mobileOpen" class="nav-scrim" aria-label="收起导航" @click="mobileOpen = false" />
      <aside v-if="!isChatRoute" class="sidebar">
        <component :is="router ? RouterLink : 'a'" to="/" href="/" class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="m10 7-7 9 7 9m12-18 7 9-7 9"/><path class="brand-center" d="M16 11v10"/></svg>Sub2API<span class="brand-dot">.</span></component>
        <nav aria-label="主导航" class="sidebar-nav">
          <div class="nav-sections"><template v-for="section in sections" :key="section.title"><div v-if="!section.admin || isAdmin" class="nav-group"><p>{{ section.title }}</p><component v-for="item in section.items" :key="item.path" :is="router ? RouterLink : 'a'" :to="item.path" :href="item.path" :class="{ selected: active(item.path) }" :aria-current="active(item.path) ? 'page' : undefined"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.icon" /></svg>{{ item.label }}</component></div></template></div>
          <div class="account-menu"><div class="account-line"><span class="avatar">{{ state.user?.email_normalized.charAt(0).toUpperCase() }}</span><div><span class="account-role">{{ isAdmin ? '管理员' : '个人账户' }}</span><span class="identity" :title="state.user?.email_normalized">{{ state.user?.email_normalized }}</span></div></div><button type="button" :disabled="state.pending !== null" @click="logout">{{ state.pending === 'logout' ? '正在退出…' : '退出登录' }}<span aria-hidden="true">↗</span></button></div>
        </nav>
      </aside>
      <header v-if="!isChatRoute" class="workspace-bar"><div><button class="nav-toggle" type="button" :aria-expanded="mobileOpen" aria-label="展开导航" @click="mobileOpen = !mobileOpen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18M3 17h18"/></svg></button><span class="breadcrumb">{{ currentPath.startsWith('/admin') ? '管理' : '工作区' }}<span>/</span></span><span>{{ currentLabel }}</span></div><span class="workspace-wordmark">SUB2API / CONSOLE</span></header>
      <header v-else class="chat-shell-header">
        <component :is="router ? RouterLink : 'a'" to="/" href="/" class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="m10 7-7 9 7 9m12-18 7 9-7 9" /><path class="brand-center" d="M16 11v10" /></svg>Sub2API<span class="brand-dot">.</span></component>
        <nav class="chat-shell-links" aria-label="账户入口"><component :is="router ? RouterLink : 'a'" to="/dashboard" href="/dashboard">控制台</component><component :is="router ? RouterLink : 'a'" to="/billing" href="/billing">账单</component><component :is="router ? RouterLink : 'a'" to="/keys" href="/keys">API 控制台</component><span class="chat-shell-identity" :title="state.user?.email_normalized">{{ state.user?.email_normalized }}</span><button type="button" :disabled="state.pending !== null" @click="logout">{{ state.pending === 'logout' ? '正在退出…' : '退出' }}</button></nav>
      </header>
    </template>
    <div class="content-area">
      <div v-if="state.pending === 'restore'" class="notice" role="status">正在确认登录状态…</div>
      <div v-if="state.status === 'unavailable'" class="notice error" role="alert">{{ state.error?.message || '暂时无法确认登录状态。' }} <button type="button" :disabled="state.pending !== null" @click="retry">重试</button></div>
      <div v-else-if="state.error && state.pending === null" class="notice error" role="alert">{{ state.error.message }}</div>
      <main id="main-content" tabindex="-1"><slot /></main>
    </div>
  </div>
</template>
<style scoped>
.app-shell{min-height:100svh}.brand{display:flex;align-items:center;gap:9px;font-size:24px;font-weight:650;letter-spacing:-1px;text-decoration:none;white-space:nowrap}.brand svg{width:26px;height:30px;fill:none;stroke:var(--ink);stroke-width:2}.brand svg .brand-center{stroke:var(--accent);stroke-width:3}.brand-dot{color:var(--accent);margin-left:-8px}.public-header{height:110px;max-width:1280px;margin:auto;padding:0 48px;display:flex;align-items:center;justify-content:space-between}.public-header nav{display:flex;align-items:center;gap:30px;font-size:14px}.public-header nav>a:not(.button){text-decoration:none}.content-area{min-width:0}main{max-width:1280px;margin:0 auto;padding:28px 48px 64px}.authenticated .content-area{margin-left:232px}.authenticated main{padding:44px 48px 72px;max-width:1480px}.sidebar{position:fixed;inset:0 auto 0 0;width:232px;background:#f0f1ea;border-right:1px solid var(--line);display:flex;flex-direction:column;z-index:60}.sidebar>.brand{padding:25px 24px;height:84px;font-size:23px}.sidebar-nav{display:flex;flex-direction:column;min-height:0;flex:1}.nav-sections{padding:0 14px;overflow-y:auto;flex:1}.nav-group{margin-bottom:20px}.nav-group>p{font-size:11px;color:var(--muted);padding:0 12px;margin:8px 0;letter-spacing:.1em}.nav-group>a{height:36px;display:flex;align-items:center;gap:12px;padding:0 12px;text-decoration:none;font-size:13px;border-radius:3px;color:#62655b;margin:2px 0}.nav-group>a:hover{background:#e5e7dd;color:var(--ink)}.nav-group>a.selected{background:#fff;color:var(--ink);box-shadow:inset 2px 0 var(--accent)}.nav-group svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.account-menu{padding:16px 22px;border-top:1px solid var(--line)}.account-line{display:flex;gap:10px;align-items:center;min-width:0}.avatar{display:grid;place-items:center;width:30px;height:30px;background:#e0e2d6;flex-shrink:0;font-family:var(--mono);font-size:13px}.account-line>div{min-width:0}.account-role{display:block;font-size:12px}.identity{font-size:11px;display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.account-menu button{border:0;background:none;padding:8px 0 0;font-size:11px;color:var(--muted);width:100%;justify-content:space-between;min-height:28px}.workspace-bar{height:66px;margin-left:232px;border-bottom:1px solid var(--line);padding:0 48px;display:flex;align-items:center;justify-content:space-between;font-size:12px;background:#fbfbf7}.workspace-bar>div{display:flex;align-items:center;gap:12px}.breadcrumb{color:var(--muted);display:flex;gap:12px}.workspace-wordmark{font-family:var(--mono);font-size:10px;letter-spacing:.13em;color:#83867a}.notice{padding:16px 24px;font-size:14px;margin:16px 48px;background:var(--soft)}.skip-link{position:fixed;left:16px;top:-80px;padding:12px;background:white;z-index:100}.skip-link:focus{top:8px}.nav-toggle,.nav-scrim{display:none}.nav-toggle svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.5}
.chat-shell .content-area{margin-left:0}.chat-shell main{max-width:none;padding:0}.chat-shell-header{height:62px;padding:0 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:#fbfbf7}.chat-shell-header .brand{font-size:21px}.chat-shell-links{display:flex;align-items:center;gap:20px;font-size:12px}.chat-shell-links>a{text-decoration:none}.chat-shell-links button{min-height:30px;padding:5px 9px;border:0;background:transparent;color:var(--muted);font-size:12px}.chat-shell-links button:hover{border-color:transparent;background:var(--soft);color:var(--ink)}.chat-shell-identity{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11px}
@media(min-height:900px){.nav-group>a{height:40px}.nav-group{margin-bottom:24px}}
@media(max-width:1000px){.authenticated main{padding:32px 28px}.workspace-bar{padding:0 28px}.public-header{padding:0 28px}main{padding:24px 28px 48px}}
@media(max-width:760px){.sidebar{transform:translateX(-100%);transition:transform .2s}.nav-open .sidebar{transform:none}.authenticated .content-area,.workspace-bar{margin-left:0}.authenticated main{padding:28px 20px}.chat-shell main{padding:0}.workspace-bar{padding:0 20px}.workspace-wordmark{display:none}.nav-toggle{display:inline-flex;border:0;padding:6px;min-height:32px;background:transparent}.nav-scrim{display:block;position:fixed;inset:0;width:100%;height:100%;border:0;background:#25262066;z-index:55}.public-header{height:84px;padding:0 20px}.public-header nav{gap:16px}.public-header .brand{font-size:22px}.public-header .button{font-size:12px;padding:8px 10px}main{padding:20px 20px 40px}.notice{margin:16px 20px}.chat-shell-header{height:58px;padding:0 14px}.chat-shell-header .brand{font-size:19px}.chat-shell-links{gap:8px}.chat-shell-links>a:nth-child(2),.chat-shell-links>a:nth-child(3),.chat-shell-identity{display:none}.chat-shell-links button{padding:5px 6px}}
</style>
