<script setup lang="ts">
import { inject, onMounted } from 'vue';
import { RouterView, routerKey } from 'vue-router';
import AppLayout from './components/AppLayout.vue';
import { sessionStore } from './stores/session.js';
import './styles/console.css';
const router = inject(routerKey, null);
onMounted(() => { if (!router) void sessionStore.restore().catch(() => undefined); });
</script>
<template>
  <AppLayout>
    <RouterView v-if="router" />
    <section v-else aria-labelledby="home-title"><h1 id="home-title">Sub2API</h1><a href="/login">进入控制台</a></section>
  </AppLayout>
</template>
