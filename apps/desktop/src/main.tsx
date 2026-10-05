import { syncNativeTheme } from './adapters/native/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/global.css';

const stopThemeSync = syncNativeTheme();
import.meta.hot?.dispose(stopThemeSync);

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Desktop app root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
