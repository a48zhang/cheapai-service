import { defineComponent, h } from 'vue';
import type { Component } from 'vue';
import { createRouter, createWebHistory, RouterLink } from 'vue-router';
import type { RouterHistory } from 'vue-router';
import { sessionStore, SessionSupersededError } from './stores/session.js';

/** Accept only local app paths; never a URL, scheme-relative URL or API path. */
export function safeReturnPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/u.test(value)) return fallback;
  let decoded: string; try { decoded = decodeURIComponent(value); } catch { return fallback; }
  if (decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/u.test(decoded)) return fallback;
  // Normalize dot segments before checking application-only destinations.
  let path: string;
  try { path = new URL(decoded, 'https://app.invalid').pathname; } catch { return fallback; }
  if (path === '/api' || path.startsWith('/api/') || path === '/v1' || path.startsWith('/v1/') || path === '/login' || path === '/session-unavailable') return fallback;
  return value;
}
export function sessionLoginLocation(returnTo: unknown) {
  return { path: '/login', query: { returnTo: safeReturnPath(returnTo) } };
}
const page = (title: string, description: string) => defineComponent({ setup: () => () => h('section', [h('h1', title), h('p', description)]) });
const loginModules = import.meta.glob<{ default: Component }>('./views/LoginView.vue');
const loadLogin = loginModules['./views/LoginView.vue'];
const login = loadLogin ? async () => (await loadLogin()).default : page('登录页面正在接入', '登录表单尚未安装，请稍后再试。');

export function createAppRouter(history: RouterHistory = createWebHistory(), session = sessionStore) {
  const router = createRouter({ history, routes: [
    { path: '/', component: () => import('./views/ChatView.vue') },
    { path: '/chat/:id', meta: { requiresAuth: true }, component: () => import('./views/ChatView.vue') },
    { path: '/dashboard', meta: { requiresAuth: true }, component: () => import('./views/DashboardView.vue') },
    { path: '/login', component: login },
    { path: '/register', component: () => import('./views/RegisterView.vue') },
    { path: '/keys', meta: { requiresAuth: true }, component: () => import('./views/KeysView.vue') },
    { path: '/requests', meta: { requiresAuth: true }, component: () => import('./views/RequestsView.vue') },
    { path: '/requests/:id', meta: { requiresAuth: true }, component: () => import('./views/RequestDetailView.vue') },
    { path: '/billing', meta: { requiresAuth: true }, component: () => import('./views/BillingView.vue') },
    { path: '/admin', meta: { requiresAuth: true, requiresAdmin: true }, redirect: '/admin/channels' },
    { path: '/admin/registration/settings', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/RegistrationSettingsView.vue') },
    { path: '/admin/users', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/UsersView.vue') },
    { path: '/admin/registration/codes', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/RegistrationCodesView.vue') },
    { path: '/admin/channels', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/ChannelsView.vue') },
    { path: '/admin/models', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/ModelsView.vue') },
    { path: '/admin/groups', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/GroupsView.vue') },
    { path: '/admin/requests', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/RequestsView.vue') },
    { path: '/admin/requests/:id', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/RequestDetailView.vue') },
    { path: '/admin/billing', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/BillingView.vue') },
    { path: '/admin/audit', meta: { requiresAuth: true, requiresAdmin: true }, component: () => import('./views/admin/AuditView.vue') },
    { path: '/admin/:pathMatch(.*)*', meta: { requiresAuth: true, requiresAdmin: true }, component: page('页面不存在', '请从导航选择可用入口。') },
    { path: '/forbidden', component: page('没有访问权限', '当前账户没有访问此管理页面的权限。') },
    { path: '/session-unavailable', component: defineComponent({ setup: () => () => h('section', [
      h('h1', '暂时无法确认会话'), h('p', '服务故障不会被视为退出登录。请重试身份确认后继续。'),
      h('button', { type: 'button', disabled: session.state.pending !== null, onClick: async () => {
        try { await session.restore(); await router.replace(safeReturnPath(router.currentRoute.value.query.returnTo)); } catch { /* store displays error */ }
      } }, '重试'), h('p', [h(RouterLink, { to: '/' }, { default: () => '返回公共首页' })]),
    ]) }) },
    { path: '/:pathMatch(.*)*', component: page('页面不存在', '请从导航选择可用入口。') },
  ] });
  let recovery: Promise<unknown> | undefined;
  router.beforeEach(async to => {
    if (session.state.status === 'unknown') {
      recovery ??= session.restore().finally(() => { recovery = undefined; });
      try { await recovery; } catch (error) { if (error instanceof SessionSupersededError) return false; }
    }
    if (to.meta.requiresAuth) {
      if (session.state.status === 'unavailable') return { path: '/session-unavailable', query: { returnTo: to.fullPath } };
      if (session.state.status !== 'authenticated') return sessionLoginLocation(to.fullPath);
    }
    if (to.meta.requiresAdmin && session.state.user?.role !== 'admin') return '/forbidden';
    if (to.path === '/login' && session.state.status === 'authenticated') return safeReturnPath(to.query.returnTo);
    return true;
  });
  return router;
}
