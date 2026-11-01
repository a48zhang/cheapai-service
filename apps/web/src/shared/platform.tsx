import { createContext, useContext } from 'react';

export interface ProductEnvironment {
  kind: 'web' | 'desktop';
  apiOrigin: string;
  fetchAsset?: typeof fetch;
  downloadAsset?: (path: string, filename: string) => Promise<void>;
}
const Environment = createContext<ProductEnvironment>({
  kind: 'web',
  apiOrigin: window.location.origin,
});
export const ProductEnvironmentProvider = Environment.Provider;
export const useProductEnvironment = () => useContext(Environment);
