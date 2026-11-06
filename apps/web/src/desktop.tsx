/** Public embedding entry. Native code owns credentials and supplies transport only. */
import { useEffect, useMemo, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProviders } from './app/providers';
import { createRuntime } from './app/runtime';
import { personalPageRoutes } from './app/personal-routes';
import { PersonalLayout } from './app/layouts/PersonalLayout';
import { SessionBoundary } from './app/guards/SessionBoundary';
import { ProductEnvironmentProvider } from './shared/platform';
import { AsyncState } from './shared/patterns/AsyncState';
import { Button } from './shared/ui/Button';
import ModelCatalogPage from './pages/catalog/ModelCatalogPage';
import SessionUnavailablePage from './pages/auth/SessionUnavailablePage';
import NotFoundPage from './pages/NotFoundPage';
import './shared/styles/tokens.css';
import './shared/styles/base.css';

export interface DesktopConsoleProps {
  fetch: typeof fetch;
  apiOrigin: string;
  onReturn: () => void;
  onLogin: () => void;
  downloadAsset: (path: string, filename: string) => Promise<void>;
}
function ReturnToWorkspace({ onReturn }: { onReturn: () => void }) {
  useEffect(onReturn, [onReturn]);
  return <Navigate replace to="/models" />;
}
export function DesktopConsole({
  fetch,
  apiOrigin,
  onReturn,
  onLogin,
  downloadAsset,
}: DesktopConsoleProps) {
  const runtime = useMemo(() => createRuntime({ fetch }), [fetch]);
  useEffect(() => () => runtime.dispose(), [runtime]);
  return (
    <ProductEnvironmentProvider
      value={{
        kind: 'desktop',
        apiOrigin,
        fetchAsset: fetch,
        downloadAsset,
        openWorkspace: onReturn,
      }}
    >
      <AppProviders runtime={runtime}>
        <HashRouter>
          <Suspense
            fallback={<AsyncState status="loading" loadingLabel="正在加载…" className="p-8" />}
          >
            <Routes>
              <Route
                path="/dashboard"
                element={
                  <SessionBoundary>
                    <Navigate replace to="/billing" />
                  </SessionBoundary>
                }
              />
              <Route element={<PersonalLayout />}>
                <Route path="/models" element={<ModelCatalogPage />} />
                <Route element={<SessionBoundary />}>
                  {personalPageRoutes.map(({ path, Page }) => (
                    <Route key={path} path={path} element={<Page />} />
                  ))}
                </Route>
                <Route path="/chat" element={<ReturnToWorkspace onReturn={onReturn} />} />
                <Route
                  path="/login"
                  element={
                    <section className="space-y-4 p-6">
                      <h1 className="text-xl font-semibold">请重新登录桌面账号</h1>
                      <Button onClick={onLogin}>前往登录</Button>
                    </section>
                  }
                />
                <Route path="/session-unavailable" element={<SessionUnavailablePage />} />
                <Route path="/" element={<Navigate replace to="/models" />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </Suspense>
        </HashRouter>
      </AppProviders>
    </ProductEnvironmentProvider>
  );
}
