import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const desktopRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const uiRequire = createRequire(desktopRequire.resolve('@deepseek-ai/dsh-client-ui-primitives'));
const storeRequire = createRequire(uiRequire.resolve('@deepseek-ai/dsh-client-store'));

describe('shared React runtime across Web, Desktop and DSH UI', () => {
  it('resolves the same React and React DOM instances without a nested React 18', () => {
    const react = webRequire('react');
    expect(react.version).toBe('19.3.0');
    expect(desktopRequire('react')).toBe(react);
    expect(uiRequire('react')).toBe(react);
    expect(uiRequire('react-dom')).toBe(webRequire('react-dom'));
    const zustandRequire = createRequire(storeRequire.resolve('zustand'));
    expect(zustandRequire('react')).toBe(react);
    const selectorRequire = createRequire(
      zustandRequire.resolve('use-sync-external-store/with-selector'),
    );
    expect(selectorRequire('react')).toBe(react);
  });

  it('renders selected DSH store state using React 19 hooks', () => {
    const { createElement } = desktopRequire('react');
    const { renderToStaticMarkup } = desktopRequire('react-dom/server');
    const { create } = storeRequire('zustand');
    const useStore = create(() => ({ message: 'CheapAI', unrelated: 0 }));
    function SelectedMessage() {
      const message = useStore((state: { message: string }) => state.message);
      return createElement('p', null, message);
    }
    expect(renderToStaticMarkup(createElement(SelectedMessage))).toBe('<p>CheapAI</p>');
  });
});
