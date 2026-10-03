import { createApp } from 'vue';
import App from './App.vue';
import { createAppRouter, sessionLoginLocation } from './router.js';
import { sessionStore } from './stores/session.js';
import { bindSessionExpiry } from './api/session-expiry.js';

const router = createAppRouter();
// Bind before router installation starts its first session or page requests.
bindSessionExpiry(sessionStore.requestIdentity, notice => {
  if (!sessionStore.expire(notice)) return;
  const returnTo = router.currentRoute.value.fullPath;
  void router.replace(sessionLoginLocation(returnTo)).catch(() => { /* Route guards keep protected pages inaccessible. */ });
});
createApp(App).use(router).mount('#app');
