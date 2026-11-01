import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isDesktopConsolePayload } from '@cheapai/contracts/desktop-console';
import type { DesktopAuthStore } from '../auth/auth-store';

export function ConsoleFrame({
  accountId,
  authStore,
  onReturn,
  onLogin,
}: {
  accountId: string;
  authStore: DesktopAuthStore;
  onReturn: () => void;
  onLogin: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let live = true;
    async function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin)
        return;
      const message = event.data;
      if (message?.channel !== 'cheapai-console') return;
      if (message.type === 'workspace') return onReturn();
      if (message.type === 'login') return onLogin();
      if (typeof message.id !== 'string') return;
      const target = frame.current.contentWindow;
      const reply = (value: unknown) => {
        if (live && target === frame.current?.contentWindow)
          target?.postMessage(
            { channel: 'cheapai-console', type: 'response', id: message.id, ...(value as object) },
            window.location.origin === 'null' ? '*' : window.location.origin,
          );
      };
      try {
        const state = authStore.getSnapshot().accountState;
        const current =
          state.status === 'signedIn' || state.status === 'unavailable'
            ? state.account?.user.id
            : null;
        if (current !== accountId) throw new Error('Account changed');
        const payload = message.payload;
        if (
          message.type === 'request' &&
          payload?.path === '/api/v1/auth/logout' &&
          payload?.method === 'POST'
        ) {
          const result = await authStore.logout();
          if (result.status !== 'signedOut') throw new Error('Logout unconfirmed');
          reply({
            response: {
              status: 200,
              contentType: 'application/json',
              encoding: 'utf8',
              body: JSON.stringify({ data: { loggedOut: true }, request_id: 'desktop-logout' }),
            },
          });
        } else if (message.type === 'request') {
          const request = { ...payload, accountId };
          if (!isDesktopConsolePayload(request)) throw new Error('Unsupported request');
          reply({ response: await invoke('desktop_console_request', { request }) });
        } else if (
          message.type === 'download' &&
          typeof payload?.path === 'string' &&
          typeof payload?.filename === 'string'
        ) {
          const request = { accountId, method: 'GET', path: payload.path };
          if (
            !isDesktopConsolePayload(request) ||
            !/^\/api\/v1\/images\/generations\/[^/]+\/content(?:\?|$)/u.test(payload.path)
          )
            throw new Error('Unsupported download');
          await invoke('desktop_console_download', { request, filename: payload.filename });
          reply({
            response: {
              status: 200,
              contentType: 'application/json',
              encoding: 'utf8',
              body: '{}',
            },
          });
        }
      } catch {
        reply({ error: true });
      }
    }
    window.addEventListener('message', receive);
    return () => {
      live = false;
      window.removeEventListener('message', receive);
    };
  }, [accountId, authStore, onReturn, onLogin]);
  return (
    <iframe
      ref={frame}
      title="用户控制台"
      src="./console.html#/models"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
      style={{ display: 'block', width: '100%', height: '100%', minHeight: 0, border: 0 }}
    />
  );
}
