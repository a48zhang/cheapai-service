// Test-only entry; not included in the production build.
import { createRoot } from 'react-dom/client';
import { MessageBody } from '../src/features/conversations/MessageBody';
import { GeneralPanel } from '../src/features/settings/GeneralPanel';
import { syncNativeTheme } from '../src/adapters/native/theme';
import '../src/styles/global.css';
import '../src/features/conversations/conversation.css';

syncNativeTheme();
createRoot(document.getElementById('root')!).render(
  <main>
    <GeneralPanel
      userId={null}
      modelSource={{ status: 'ready', options: [] }}
      directorySource={{ status: 'ready', options: [] }}
    />
    <MessageBody role="assistant" text={'```typescript\nconst message = "CheapAI";\n```'} />
  </main>,
);
