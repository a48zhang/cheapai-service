// Test-only entry. Exercises the real local frame and request boundary without native binaries.
import { createRoot } from 'react-dom/client';
import { ConsoleFrame } from '../src/features/console/ConsoleFrame';
import { DesktopAuthStore } from '../src/features/auth/auth-store';
import type { DesktopPublicAccountState } from '@sub2api/desktop-contracts';
const state: DesktopPublicAccountState = {
  status: 'signedIn',
  expiresAt: 9_000_000_000_000,
  account: {
    user: {
      id: 'desktop-user',
      email_normalized: 'desktop@example.invalid',
      role: 'user',
      status: 'active',
      group_id: 'standard',
      group_status: 'active',
      balance_units: '100000000',
      email_verified_at: null,
    },
    balance: { currency: 'USD', decimals: 8, balance_units: '100000000', balance_usd: '1' },
  },
};
const store = new DesktopAuthStore({
  available: true,
  subscribe: () => () => {},
  login: async () => state,
  restore: async () => state,
  refresh: async () => state,
  logout: async () => {
    document.body.dataset.loggedOut = 'true';
    return { status: 'signedOut' };
  },
});
void store.restore().then(() => {
  createRoot(document.getElementById('root')!).render(
    <div style={{ height: '100dvh' }}>
      <ConsoleFrame
        accountId="desktop-user"
        authStore={store}
        onReturn={() => {
          document.body.dataset.returned = 'true';
        }}
        onLogin={() => {
          document.body.dataset.login = 'true';
        }}
      />
    </div>,
  );
});
