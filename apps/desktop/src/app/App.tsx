export type DesktopRoute = 'workspace' | 'login' | 'settings';
export type RuntimeStartupState = 'starting' | 'ready' | 'failed';

interface AppProps {
  readonly initialRoute?: DesktopRoute;
  readonly startupState?: RuntimeStartupState;
}

const startupLabels: Record<RuntimeStartupState, string> = {
  starting: '正在等待桌面服务连接',
  ready: '桌面服务已连接',
  failed: '桌面服务暂时不可用',
};

export function App({
  initialRoute = 'workspace',
  startupState = 'starting',
}: AppProps) {
  return (
    <div className="desktop-app" data-route={initialRoute}>
      <header className="desktop-header">
        <span className="desktop-brand">cheapai.dev</span>
        <span className="desktop-runtime-status" role="status" aria-live="polite">
          {startupLabels[startupState]}
        </span>
      </header>
      <RouteOutlet route={initialRoute} />
    </div>
  );
}

function RouteOutlet({ route }: { readonly route: DesktopRoute }) {
  switch (route) {
    case 'workspace':
      return <Workspace />;
    case 'login':
      return <main className="desktop-page" data-page="login" aria-label="登录" />;
    case 'settings':
      return <main className="desktop-page" data-page="settings" aria-label="设置" />;
  }
}

function Workspace() {
  return (
    <div className="desktop-layout">
      <aside className="desktop-sidebar" aria-label="会话导航" />
      <main className="desktop-workspace" aria-label="对话工作区">
        <section className="workspace-empty" aria-labelledby="workspace-title">
          <h1 id="workspace-title">开始新的对话</h1>
          <p>连接桌面服务并登录后，对话会显示在这里。</p>
        </section>
      </main>
    </div>
  );
}
