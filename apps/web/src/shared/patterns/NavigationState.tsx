import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

const NavigationContext = createContext<[boolean, Dispatch<SetStateAction<boolean>>]>([
  true,
  () => {},
]);

/** Keep the desktop sidebar preference when moving between chat and console routes. */
export function NavigationProvider({ children }: { children: ReactNode }) {
  const state = useState(true);
  return <NavigationContext.Provider value={state}>{children}</NavigationContext.Provider>;
}

export function useDesktopNavigation() {
  return useContext(NavigationContext);
}
