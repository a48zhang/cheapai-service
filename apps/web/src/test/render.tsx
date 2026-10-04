import {
  createElement,
  type ComponentType,
  type PropsWithChildren,
  type ReactElement,
} from 'react';
import { render as testingLibraryRender, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type TestWrapper = ComponentType<PropsWithChildren>;
type AppRenderOptions = Omit<RenderOptions, 'wrapper'> & { wrapper?: TestWrapper };

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function render(ui: ReactElement, options: AppRenderOptions = {}) {
  const { wrapper, ...renderOptions } = options;
  const queryClient = createTestQueryClient();
  const providers: TestWrapper = ({ children }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      wrapper ? createElement(wrapper, null, children) : children,
    );

  return {
    ...testingLibraryRender(ui, { wrapper: providers, ...renderOptions }),
    queryClient,
  };
}

export * from '@testing-library/react';
