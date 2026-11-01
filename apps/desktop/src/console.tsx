import { createRoot } from 'react-dom/client';
import { DesktopConsole } from '@cheapai/web/desktop';
import { consoleBridge, consoleFetch, leaveConsole } from './features/console/bridge';

createRoot(document.getElementById('root')!).render(
  <DesktopConsole
    fetch={consoleFetch}
    apiOrigin="https://cheapai.dev"
    onReturn={() => leaveConsole('workspace')}
    onLogin={() => leaveConsole('login')}
    downloadAsset={async (path, filename) => {
      await consoleBridge('download', { path, filename });
    }}
  />,
);
